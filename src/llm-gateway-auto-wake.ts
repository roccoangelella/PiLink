import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import type { GatewayStatusSnapshot, LlmGatewayJobStore } from "./llm-gateway-store.js";

const AUTO_WAKE_POLL_MS = 750;
const AUTO_WAKE_GRACE_MS = 500;
const AUTO_WAKE_CONFIRM_MS = 7_000;
const AUTO_WAKE_SUSPENDED_POLL_MS = 5_000;
const AUTO_WAKE_MAX_FAILED_CYCLES = 1;
const CHATGPT_SETTLE_MS = 1_500;
const CHATGPT_WAKE_TEXT = "wake";
const ENTER_KEYCODE = "28";

type GatewayWakeQueryParam = "q" | "prompt";
type WakeOutcome = "confirmed" | "not_needed" | "pending";

export interface GatewayAutoWakeSupervisor {
  close(): void;
}

export interface GatewayWakeDriver {
  wake(): Promise<void>;
}

export interface GatewayAutoWakeSupervisorOptions {
  store: Pick<LlmGatewayJobStore, "status">;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  driver?: GatewayWakeDriver;
  pollIntervalMs?: number;
  wakeGraceMs?: number;
  confirmationMs?: number;
  maxFailedCycles?: number;
  log?: (message: string) => void;
}

class GatewayAutoWakeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayAutoWakeUnavailableError";
  }
}

export function gatewayAutoWakeEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "linux") return false;
  if (!hasGraphicalSession(env)) return false;
  if (env.PI_LLM_GATEWAY_ENABLED !== "true" || env.PILINK_GATEWAY_LAUNCH !== "true") return false;
  return !/^(?:0|false|no|off)$/iu.test(env.PI_LLM_GATEWAY_AUTO_WAKE?.trim() ?? "");
}

export function buildGatewayWakeUrl(param: GatewayWakeQueryParam = "q"): string {
  const url = new URL("https://chatgpt.com/");
  url.searchParams.set(param, CHATGPT_WAKE_TEXT);
  return url.toString();
}

export function gatewayYdotoolSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.YDOTOOL_SOCKET?.trim();
  if (configured) return configured;
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  return runtimeDir ? path.join(runtimeDir, ".ydotool_socket") : "/tmp/.ydotool_socket";
}

export function shouldAutoWakeGateway(status: GatewayStatusSnapshot, previouslyActive = false): boolean {
  return status.state !== "released" &&
    (status.queued > 0 || previouslyActive) &&
    status.next_action === "wake_worker" &&
    !status.worker_polling &&
    !status.processing_claim;
}

export function startGatewayAutoWakeSupervisor(
  options: GatewayAutoWakeSupervisorOptions,
): GatewayAutoWakeSupervisor | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (!gatewayAutoWakeEnabled(env, platform)) return undefined;

  const pollIntervalMs = positiveDelay(options.pollIntervalMs, AUTO_WAKE_POLL_MS);
  const wakeGraceMs = nonNegativeDelay(options.wakeGraceMs, AUTO_WAKE_GRACE_MS);
  const confirmationMs = positiveDelay(options.confirmationMs, AUTO_WAKE_CONFIRM_MS);
  const maxFailedCycles = positiveInteger(options.maxFailedCycles, AUTO_WAKE_MAX_FAILED_CYCLES);
  const log = options.log ?? ((message: string) => console.error("[Gateway] Auto-wake: " + message));

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;
  let failedCycles = 0;
  let hasSeenWorker = false;
  let driverPromise: Promise<GatewayWakeDriver> | undefined = options.driver
    ? Promise.resolve(options.driver)
    : undefined;

  const getDriver = (): Promise<GatewayWakeDriver> => {
    driverPromise ??= prepareLinuxGatewayWakeDriver(env);
    return driverPromise;
  };

  const schedule = (): void => {
    if (stopped) return;
    const delay = failedCycles >= maxFailedCycles ? AUTO_WAKE_SUSPENDED_POLL_MS : pollIntervalMs;
    timer = setTimeout(() => {
      void tick();
    }, delay);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      schedule();
      return;
    }
    running = true;
    try {
      const status = await options.store.status();
      if (status.state === "active" || status.worker_polling || status.worker_contact === "recent") {
        hasSeenWorker = true;
      }
      if (!shouldAutoWakeGateway(status, hasSeenWorker)) {
        failedCycles = 0;
        return;
      }
      if (failedCycles >= maxFailedCycles) return;

      if (wakeGraceMs > 0) await sleep(wakeGraceMs);
      const rechecked = await options.store.status();
      if (rechecked.state === "active" || rechecked.worker_polling || rechecked.worker_contact === "recent") {
        hasSeenWorker = true;
      }
      if (!shouldAutoWakeGateway(rechecked, hasSeenWorker)) {
        failedCycles = 0;
        return;
      }

      const reconnectOnly = rechecked.queued === 0 && hasSeenWorker;
      log(reconnectOnly
        ? "the previous ChatGPT worker disconnected; opening the default browser to re-establish it."
        : "queued work has no listening ChatGPT worker; opening the default browser.");

      const driver = await getDriver();
      const outcome = await runWakeCycle(options.store, driver, confirmationMs, reconnectOnly);
      if (outcome === "confirmed") {
        failedCycles = 0;
        log("worker contact confirmed by the gateway.");
      } else if (outcome === "not_needed") {
        failedCycles = 0;
      } else {
        failedCycles += 1;
        log("no worker contact after the bounded wake attempt; pausing until gateway state changes. Manual wake may be required.");
      }
    } catch (error) {
      failedCycles += 1;
      if (error instanceof GatewayAutoWakeUnavailableError) failedCycles = maxFailedCycles;
      log("unable to wake automatically: " + errorMessage(error));
      if (failedCycles >= maxFailedCycles) {
        log("automatic wake is paused until gateway state changes; manual '@PiLink wake' remains available.");
      }
    } finally {
      running = false;
      schedule();
    }
  };

  schedule();
  return {
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function runWakeCycle(
  store: Pick<LlmGatewayJobStore, "status">,
  driver: GatewayWakeDriver,
  confirmationMs: number,
  reconnectOnly: boolean,
): Promise<WakeOutcome> {
  await driver.wake();
  return waitForWakeOutcome(store, confirmationMs, reconnectOnly);
}

async function waitForWakeOutcome(
  store: Pick<LlmGatewayJobStore, "status">,
  timeoutMs: number,
  reconnectOnly: boolean,
): Promise<WakeOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await store.status();
    if (status.state === "released") return "not_needed";
    if (!reconnectOnly && status.queued === 0) return "not_needed";
    if (!shouldAutoWakeGateway(status, reconnectOnly)) return "confirmed";
    if (Date.now() >= deadline) return "pending";
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
}

async function prepareLinuxGatewayWakeDriver(env: NodeJS.ProcessEnv): Promise<GatewayWakeDriver> {
  if (!hasGraphicalSession(env)) {
    throw new GatewayAutoWakeUnavailableError(
      "Linux auto-wake requires a graphical X11 or Wayland session.",
    );
  }

  const [xdgOpen, ydotool] = await Promise.all([
    resolveExecutable("xdg-open", env),
    resolveExecutable("ydotool", env),
  ]);
  if (!xdgOpen) {
    throw new GatewayAutoWakeUnavailableError("xdg-open was not found on PATH; install xdg-utils or disable auto-wake.");
  }
  if (!ydotool) {
    throw new GatewayAutoWakeUnavailableError(
      "ydotool was not found on PATH; install ydotool and start ydotoold, or disable auto-wake.",
    );
  }

  const param = wakeQueryParam(env.PI_LLM_GATEWAY_AUTO_WAKE_PARAM);
  const wakeUrl = buildGatewayWakeUrl(param);

  return {
    async wake(): Promise<void> {
      await assertYdotoolReady(env);
      await runExecutable(xdgOpen, [wakeUrl], env, 5_000);
      await sleep(CHATGPT_SETTLE_MS);
      await runExecutable(ydotool, ["key", `${ENTER_KEYCODE}:1`, `${ENTER_KEYCODE}:0`], env, 5_000);
    },
  };
}

async function assertYdotoolReady(env: NodeJS.ProcessEnv): Promise<void> {
  const socketPath = gatewayYdotoolSocketPath(env);
  try {
    const stat = await fs.stat(socketPath);
    if (!stat.isSocket()) throw new Error("not a Unix socket");
    await fs.access(socketPath, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw new GatewayAutoWakeUnavailableError(
      `ydotoold socket is not ready at ${socketPath}; start ydotoold and ensure the current user can access its socket and /dev/uinput.`,
    );
  }
}

function hasGraphicalSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.WAYLAND_DISPLAY?.trim() || env.DISPLAY?.trim());
}

function wakeQueryParam(value: string | undefined): GatewayWakeQueryParam {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "q") return "q";
  if (normalized === "prompt") return "prompt";
  throw new GatewayAutoWakeUnavailableError("PI_LLM_GATEWAY_AUTO_WAKE_PARAM must be 'q' or 'prompt'.");
}

async function resolveExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const directories = new Set<string>();
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (directory) directories.add(directory);
  }
  directories.add("/usr/local/bin");
  directories.add("/usr/bin");
  directories.add("/bin");

  for (const directory of directories) {
    const candidate = path.join(directory, name);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return undefined;
}

function runExecutable(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        env,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 64 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || stdout.trim() || error.message;
          reject(new Error(detail));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function positiveDelay(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error("auto-wake delay must be positive");
  return value;
}

function nonNegativeDelay(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new Error("auto-wake delay cannot be negative");
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("auto-wake retry count must be a positive integer");
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
