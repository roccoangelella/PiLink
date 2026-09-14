import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createSystemComputerBackend,
  findExecutable,
  parsePngSize,
  type ComputerAction,
  type ComputerBackend,
  type ComputerObservation,
} from "./computer.js";

const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const MAX_HELPER_STDOUT_BYTES = 24 * 1024 * 1024;
const MAX_HELPER_STDERR_BYTES = 8 * 1024;
const HELPER_REQUEST_TIMEOUT_MS = 120_000;

interface HelperResponse {
  id?: number;
  ok?: boolean;
  error?: string;
  data?: string;
}

interface PendingRequest {
  id: number;
  resolve: (value: HelperResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const sessionType = env.XDG_SESSION_TYPE?.trim().toLowerCase();
  return sessionType === "wayland" || Boolean(env.WAYLAND_DISPLAY?.trim() && sessionType !== "x11");
}

export function createPiLinkComputerBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ComputerBackend {
  if (platform === "linux" && isWaylandSession(env)) {
    return new LinuxWaylandPortalComputerBackend(env);
  }
  return createSystemComputerBackend(env, platform);
}

class LinuxWaylandPortalComputerBackend implements ComputerBackend {
  public readonly name = "linux-wayland-portal";
  private readonly env: NodeJS.ProcessEnv;
  private child?: ChildProcessWithoutNullStreams;
  private pending?: PendingRequest;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrTail = "";
  private nextId = 1;
  private queue: Promise<void> = Promise.resolve();

  public constructor(env: NodeJS.ProcessEnv) {
    this.env = { ...env };
  }

  public observe(): Promise<ComputerObservation> {
    return this.serialized(async () => {
      const response = await this.request({ op: "observe" });
      if (typeof response.data !== "string") throw new Error("Wayland helper returned no screenshot data");
      const data = Buffer.from(response.data, "base64");
      if (data.length <= 0 || data.length > MAX_SCREENSHOT_BYTES) {
        throw new Error("Wayland portal produced an invalid or oversized screenshot");
      }
      const { width, height } = parsePngSize(data);
      return {
        data,
        mimeType: "image/png",
        width,
        height,
        capturedAt: new Date().toISOString(),
        backend: this.name,
      };
    });
  }

  public action(input: ComputerAction): Promise<void> {
    return this.serialized(async () => {
      await this.request({ op: "action", input });
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private request(payload: Record<string, unknown>): Promise<HelperResponse> {
    this.ensureHelper();
    if (!this.child) return Promise.reject(new Error("Wayland portal helper could not start"));
    if (this.pending) return Promise.reject(new Error("Wayland portal helper received overlapping requests"));

    const id = this.nextId++;
    return new Promise<HelperResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id === id) this.pending = undefined;
        this.stopHelper();
        reject(new Error("Wayland portal request timed out while waiting for local desktop permission or capture"));
      }, HELPER_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending = { id, resolve, reject, timer };
      const line = `${JSON.stringify({ id, ...payload })}\n`;
      this.child!.stdin.write(line, "utf8", (error) => {
        if (!error) return;
        if (this.pending?.id === id) {
          clearTimeout(this.pending.timer);
          this.pending = undefined;
        }
        reject(new Error(`Could not send request to Wayland portal helper: ${safeMessage(error.message)}`));
      });
    }).then((response) => {
      if (response.ok !== true) throw new Error(safeMessage(response.error || "Wayland portal operation failed"));
      return response;
    });
  }

  private ensureHelper(): void {
    if (this.child && this.child.exitCode === null && !this.child.killed) return;

    const python = findExecutable(this.env.PI_COMPUTER_PYTHON?.trim() || "python3", this.env);
    if (!python) {
      throw new Error(
        "Wayland Computer Use requires python3 with PyGObject/GStreamer. " +
        "Install python3-gi, GStreamer, the PipeWire GStreamer plugin, and xdg-desktop-portal for the active desktop.",
      );
    }
    const helper = this.resolveHelperPath();
    if (!fs.existsSync(helper) || !fs.statSync(helper).isFile()) {
      throw new Error(`Wayland Computer Use helper is missing: ${helper}`);
    }

    const child = spawn(python, [helper], {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrTail = "";

    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-MAX_HELPER_STDERR_BYTES);
    });
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.failHelper(new Error(`Wayland portal helper failed to start: ${safeMessage(error.message)}`));
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      const detail = this.stderrTail.trim();
      const suffix = detail ? `: ${safeMessage(detail)}` : "";
      this.failHelper(new Error(`Wayland portal helper exited (${signal || (code ?? "unknown")})${suffix}`));
    });
  }

  private consumeStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.length > MAX_HELPER_STDOUT_BYTES) {
      this.failHelper(new Error("Wayland portal helper returned an oversized response"));
      this.stopHelper();
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.stdoutBuffer.subarray(0, newline).toString("utf8");
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (!line.trim()) continue;
      let response: HelperResponse;
      try {
        response = JSON.parse(line) as HelperResponse;
      } catch {
        this.failHelper(new Error("Wayland portal helper returned malformed JSON"));
        this.stopHelper();
        return;
      }
      const pending = this.pending;
      if (!pending || response.id !== pending.id) {
        this.failHelper(new Error("Wayland portal helper returned an unexpected response"));
        this.stopHelper();
        return;
      }
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.resolve(response);
    }
  }

  private failHelper(error: Error): void {
    const pending = this.pending;
    if (pending) {
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.reject(error);
    }
    this.child = undefined;
  }

  private stopHelper(): void {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }

  private resolveHelperPath(): string {
    const configured = this.env.PI_COMPUTER_WAYLAND_HELPER?.trim();
    if (configured) return path.resolve(configured);
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    return path.join(packageRoot, "src", "computer-wayland-helper.py");
  }
}

function safeMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 1_000) || "Wayland portal operation failed";
}
