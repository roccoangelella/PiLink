import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import type { GatewayStatusSnapshot, LlmGatewayJobStore } from "./llm-gateway-store.js";

const AUTO_WAKE_POLL_MS = 750;
const AUTO_WAKE_GRACE_MS = 500;
const AUTO_WAKE_CONFIRM_MS = 7_000;
const AUTO_WAKE_COOLDOWN_MS = 15_000;
const AUTO_WAKE_SUSPENDED_POLL_MS = 5_000;
const AUTO_WAKE_MAX_FAILED_CYCLES = 2;
const CHATGPT_WINDOW_TIMEOUT_MS = 8_000;
const CHATGPT_WINDOW_POLL_MS = 200;
const CHATGPT_SETTLE_MS = 350;
const CHATGPT_WAKE_TEXT = "wake";

type GatewayWakeQueryParam = "q" | "prompt";
type WakeOutcome = "confirmed" | "not_needed" | "pending";

export interface GatewayAutoWakeSupervisor {
  close(): void;
}

export interface GatewayWakePage {
  windowId: string;
}

export interface GatewayWakeDriver {
  open(): Promise<GatewayWakePage>;
  submitBackground(page: GatewayWakePage): Promise<void>;
  submitForeground(page: GatewayWakePage): Promise<void>;
}

export interface GatewayAutoWakeSupervisorOptions {
  store: Pick<LlmGatewayJobStore, "status">;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  driver?: GatewayWakeDriver;
  pollIntervalMs?: number;
  wakeGraceMs?: number;
  confirmationMs?: number;
  cooldownMs?: number;
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
  if (!env.DISPLAY?.trim()) return false;
  if (env.PI_LLM_GATEWAY_ENABLED !== "true" || env.PILINK_GATEWAY_LAUNCH !== "true") return false;
  return !/^(?:0|false|no|off)$/iu.test(env.PI_LLM_GATEWAY_AUTO_WAKE?.trim() ?? "");
}

export function buildGatewayWakeUrl(param: GatewayWakeQueryParam = "q"): string {
  const url = new URL("https://chatgpt.com/");
  url.searchParams.set(param, CHATGPT_WAKE_TEXT);
  return url.toString();
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
  const cooldownMs = nonNegativeDelay(options.cooldownMs, AUTO_WAKE_COOLDOWN_MS);
  const maxFailedCycles = positiveInteger(options.maxFailedCycles, AUTO_WAKE_MAX_FAILED_CYCLES);
  const log = options.log ?? ((message: string) => console.error("[Gateway] Auto-wake: " + message));

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;
  let failedCycles = 0;
  let nextAllowedAt = 0;
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
        nextAllowedAt = 0;
        return;
      }
      if (failedCycles >= maxFailedCycles || Date.now() < nextAllowedAt) return;

      if (wakeGraceMs > 0) await sleep(wakeGraceMs);
      const rechecked = await options.store.status();
      if (rechecked.state === "active" || rechecked.worker_polling || rechecked.worker_contact === "recent") {
        hasSeenWorker = true;
      }
      if (!shouldAutoWakeGateway(rechecked, hasSeenWorker)) {
        failedCycles = 0;
        nextAllowedAt = 0;
        return;
      }

      const reconnectOnly = rechecked.queued === 0 && hasSeenWorker;
      log(reconnectOnly
        ? "the previous ChatGPT worker disconnected; opening the default browser to re-establish it."
        : "queued work has no listening ChatGPT worker; opening the default browser.");
      const driver = await getDriver();
      const outcome = await runWakeCycle(options.store, driver, confirmationMs, log, reconnectOnly);
      if (outcome === "confirmed") {
        failedCycles = 0;
        nextAllowedAt = 0;
        log("worker contact confirmed by the gateway.");
      } else if (outcome === "not_needed") {
        failedCycles = 0;
        nextAllowedAt = 0;
      } else {
        failedCycles += 1;
        nextAllowedAt = Date.now() + cooldownMs;
        if (failedCycles >= maxFailedCycles) {
          log("no worker contact after two bounded attempts; pausing until gateway state changes. Manual wake may be required.");
        } else {
          log("no worker contact yet; one rate-limited retry remains.");
        }
      }
    } catch (error) {
      failedCycles += 1;
      nextAllowedAt = Date.now() + cooldownMs;
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
  log: (message: string) => void,
  reconnectOnly: boolean,
): Promise<WakeOutcome> {
  const page = await driver.open();
  let backgroundSent = false;
  try {
    await driver.submitBackground(page);
    backgroundSent = true;
  } catch (error) {
    log("background Enter was not accepted by the window system: " + errorMessage(error));
  }

  if (backgroundSent) {
    const outcome = await waitForWakeOutcome(store, confirmationMs, reconnectOnly);
    if (outcome !== "pending") return outcome;
  }

  log("worker still absent; briefly focusing the same ChatGPT window for one Enter retry.");
  await driver.submitForeground(page);
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
  if (!env.DISPLAY?.trim()) {
    throw new GatewayAutoWakeUnavailableError(
      "Linux auto-wake currently requires an X11-compatible DISPLAY; Wayland-only sessions are not automated.",
    );
  }
  const [xdgOpen, xdotool] = await Promise.all([
    resolveExecutable("xdg-open", env),
    resolveExecutable("xdotool", env),
  ]);
  if (!xdgOpen) {
    throw new GatewayAutoWakeUnavailableError("xdg-open was not found on PATH; install xdg-utils or disable auto-wake.");
  }
  if (!xdotool) {
    throw new GatewayAutoWakeUnavailableError("xdotool was not found on PATH; install xdotool or disable auto-wake.");
  }

  const param = wakeQueryParam(env.PI_LLM_GATEWAY_AUTO_WAKE_PARAM);
  const wakeUrl = buildGatewayWakeUrl(param);

  const xdo = (args: string[], timeoutMs = 5_000): Promise<string> =>
    runExecutable(xdotool, args, env, timeoutMs);

  const activeWindow = async (): Promise<string | undefined> => {
    try {
      const id = (await xdo(["getactivewindow"])).trim();
      return /^\d+$/u.test(id) ? id : undefined;
    } catch {
      return undefined;
    }
  };

  const windowName = async (id: string): Promise<string> => {
    try {
      return (await xdo(["getwindowname", id])).trim();
    } catch {
      return "";
    }
  };

  const chatGptWindows = async (): Promise<string[]> => {
    try {
      return (await xdo(["search", "--onlyvisible", "--name", "ChatGPT"]))
        .split(/\s+/u)
        .filter((id) => /^\d+$/u.test(id));
    } catch {
      return [];
    }
  };

  const restoreWindow = async (id: string | undefined): Promise<void> => {
    if (!id) return;
    const current = await activeWindow();
    if (current === id) return;
    try {
      await xdo(["windowactivate", "--sync", id]);
    } catch {
      // The user's previous window may have closed while the browser opened.
    }
  };

  return {
    async open(): Promise<GatewayWakePage> {
      const previousWindow = await activeWindow();
      const previousTitle = previousWindow ? await windowName(previousWindow) : "";
      const previousWasChatGpt = previousTitle.toLowerCase().includes("chatgpt");
      const existingChatGptWindows = new Set(await chatGptWindows());
      await runExecutable(xdgOpen, [wakeUrl], env, 5_000);

      let target: string | undefined;
      const deadline = Date.now() + CHATGPT_WINDOW_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const active = await activeWindow();
        const activeTitle = active ? await windowName(active) : "";
        const activeIsChatGpt = activeTitle.toLowerCase().includes("chatgpt");
        const activeChangedUnambiguously =
          activeIsChatGpt &&
          (active !== previousWindow || !previousWasChatGpt || activeTitle !== previousTitle);
        if (active && activeChangedUnambiguously) {
          target = active;
          break;
        }

        const matches = await chatGptWindows();
        const newlyVisible = matches.filter((id) => !existingChatGptWindows.has(id));
        if (newlyVisible.length === 1) {
          target = newlyVisible[0];
          break;
        }
        await sleep(CHATGPT_WINDOW_POLL_MS);
      }

      await sleep(CHATGPT_SETTLE_MS);
      await restoreWindow(previousWindow);
      if (!target) {
        throw new Error(
          "the ChatGPT browser tab opened, but its window could not be identified safely without DOM inspection.",
        );
      }
      return { windowId: target };
    },

    async submitBackground(page: GatewayWakePage): Promise<void> {
      await xdo(["key", "--window", page.windowId, "--clearmodifiers", "Return"]);
    },

    async submitForeground(page: GatewayWakePage): Promise<void> {
      const previousWindow = await activeWindow();
      try {
        await xdo(["windowactivate", "--sync", page.windowId]);
        await sleep(120);
        await xdo(["key", "--clearmodifiers", "Return"]);
      } finally {
        await restoreWindow(previousWindow);
      }
    },
  };
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
      (error, stdout) => {
        if (error) {
          reject(error);
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
