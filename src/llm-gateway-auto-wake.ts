import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import type { GatewayStatusSnapshot, LlmGatewayJobStore } from "./llm-gateway-store.js";
import { gatewayWakeText } from "./llm-gateway-wake-name.js";

const AUTO_WAKE_POLL_MS = 750;
const AUTO_WAKE_GRACE_MS = 500;
const AUTO_WAKE_CONFIRM_MS = 30_000;
const AUTO_WAKE_SUSPENDED_POLL_MS = 5_000;
const AUTO_WAKE_MAX_FAILED_CYCLES = 1;

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
  if (!env.WAYLAND_DISPLAY?.trim() && !env.DISPLAY?.trim()) return false;
  if (env.PI_LLM_GATEWAY_ENABLED !== "true" || env.PILINK_GATEWAY_LAUNCH !== "true") return false;
  // Opt in only after the operator has installed the extension in their own
  // browser. No key injection or browser-profile modification is involved.
  return env.PI_LLM_GATEWAY_AUTO_WAKE?.trim().toLowerCase() === "true";
}

export function buildGatewayWakeUrl(nonce: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[0-9a-f]{32}$/u.test(nonce)) throw new Error("Wake nonce must be 16 random bytes encoded as lowercase hex");
  return `https://chatgpt.com/?q=${encodeURIComponent(gatewayWakeText(env))}&pilink_wake=${nonce}`;
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
    driverPromise ??= prepareBrowserWakeDriver(env);
    return driverPromise;
  };

  const schedule = (): void => {
    if (stopped) return;
    const delay = failedCycles >= maxFailedCycles ? AUTO_WAKE_SUSPENDED_POLL_MS : pollIntervalMs;
    timer = setTimeout(() => { void tick(); }, delay);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (running) { schedule(); return; }
    running = true;
    try {
      const status = await options.store.status();
      if (status.state === "active" || status.worker_polling || status.worker_contact === "recent") hasSeenWorker = true;
      if (!shouldAutoWakeGateway(status, hasSeenWorker)) {
        failedCycles = 0;
        return;
      }
      if (failedCycles >= maxFailedCycles) return;
      if (wakeGraceMs > 0) await sleep(wakeGraceMs);
      const rechecked = await options.store.status();
      if (rechecked.state === "active" || rechecked.worker_polling || rechecked.worker_contact === "recent") hasSeenWorker = true;
      if (!shouldAutoWakeGateway(rechecked, hasSeenWorker)) {
        failedCycles = 0;
        return;
      }

      const reconnectOnly = rechecked.queued === 0 && hasSeenWorker;
      log(reconnectOnly
        ? "the previous ChatGPT worker disconnected; opening a new wake tab in the default browser."
        : "queued work needs a ChatGPT worker; opening a new wake tab in the default browser.");
      const driver = await getDriver();
      await driver.wake();
      log("wake URL opened; waiting for the installed Chrome/Brave extension and gateway worker contact.");
      const outcome = await waitForWakeOutcome(options.store, confirmationMs, reconnectOnly);
      if (outcome === "confirmed") {
        failedCycles = 0;
        log("worker contact confirmed by the gateway.");
      } else if (outcome === "not_needed") {
        failedCycles = 0;
      } else {
        failedCycles += 1;
        log("no worker contact after one bounded attempt; check the browser extension and wake manually if needed.");
      }
    } catch (error) {
      failedCycles += 1;
      if (error instanceof GatewayAutoWakeUnavailableError) failedCycles = maxFailedCycles;
      log("unable to wake automatically: " + errorMessage(error));
      if (failedCycles >= maxFailedCycles) log("automatic wake paused until gateway state changes; manual ChatGPT wake remains available.");
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

async function prepareBrowserWakeDriver(env: NodeJS.ProcessEnv): Promise<GatewayWakeDriver> {
  const [xdgOpen, xdgSettings, brave] = await Promise.all([
    resolveExecutable("xdg-open", env),
    resolveExecutable("xdg-settings", env),
    resolveExecutable("brave", env),
  ]);
  if (!xdgOpen) throw new GatewayAutoWakeUnavailableError("xdg-open was not found; install xdg-utils or disable auto-wake.");

  let useBrave = false;
  if (xdgSettings && brave) {
    try {
      useBrave = (await runExecutable(xdgSettings, ["get", "default-web-browser"], env, 3_000)) === "brave-browser.desktop";
    } catch {
      // Other desktop/browser combinations continue through xdg-open.
    }
  }

  return {
    async wake(): Promise<void> {
      // A fresh nonce is used for each attempt, and the extension uses
      // sessionStorage to suppress duplicate sends from refresh/re-navigation.
      const url = buildGatewayWakeUrl(randomBytes(16).toString("hex"), env);
      if (useBrave && brave) await runExecutable(brave, ["--new-window", url], env, 5_000);
      else await runExecutable(xdgOpen, [url], env, 5_000);
    },
  };
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

function runExecutable(executable: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || stdout.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      });
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
