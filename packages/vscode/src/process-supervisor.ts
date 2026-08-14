import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { VSPILINK_SHUTDOWN_MESSAGE, windowsTaskkillArgs } from "./process-utils.js";
import type { ProcessStatus, ProcessViewState } from "./protocol.js";
import { isAwaitingCliInput, redactSensitiveOutput, stripAnsi } from "./security.js";

export interface ProcessStartOptions {
  nodeExecutable: string;
  cliPath: string;
  args: string[];
  cwd: string;
  configPath: string;
  mode: string;
  revealTerminal?: boolean;
  environment?: Readonly<Record<string, string>>;
}

export interface JsonCliOptions {
  nodeExecutable: string;
  cliPath: string;
  args: string[];
  cwd: string;
  configPath: string;
  environment?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export async function runJsonCli(options: JsonCliOptions): Promise<Record<string, unknown>> {
  for (const argument of [options.nodeExecutable, options.cliPath, options.cwd, options.configPath, ...options.args]) {
    if (typeof argument !== "string" || !argument || argument.length > 8_192 || /[\r\n\0]/.test(argument)) {
      throw new Error("Invalid VSPiLink helper-process argument.");
    }
  }
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(options.nodeExecutable, [options.cliPath, ...options.args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.environment,
        PILINK_CONFIG: options.configPath,
        ELECTRON_RUN_AS_NODE: "1",
      },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const limit = 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value as Record<string, unknown>);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) + chunk.length > limit) {
        child.kill("SIGKILL");
        finish(new Error("The helper-process JSON response is too large."));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) + chunk.length > limit) {
        child.kill("SIGKILL");
        finish(new Error("The helper-process error response is too large."));
        return;
      }
      stderr += chunk.toString("utf8");
    });
    child.once("error", () => finish(new Error("Could not start the VSPiLink helper process.")));
    child.once("close", (code) => {
      let payload: unknown;
      try {
        // The hosting CLI emits its one-line success envelope on stdout and
        // its one-line error envelope on stderr. Parse only the expected
        // channel and never surface arbitrary process output.
        payload = JSON.parse((code === 0 ? stdout : stderr).trim());
      } catch {
        finish(new Error(code === 0 ? "The helper process did not return valid JSON." : `The helper process exited with code ${code ?? "?"}.`));
        return;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        finish(new Error("Invalid helper-process JSON envelope."));
        return;
      }
      if (code !== 0) {
        finish(new Error(safeJsonCliError(payload as Record<string, unknown>, code)));
        return;
      }
      finish(undefined, payload as Record<string, unknown>);
    });
    timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("The VSPiLink helper process timed out."));
    }, options.timeoutMs ?? 120_000);
    timeout.unref();
  });
}

function safeJsonCliError(payload: Record<string, unknown>, exitCode: number | null): string {
  const error = payload.error;
  const candidate = typeof error === "string"
    ? error
    : error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string"
      ? (error as Record<string, unknown>).message as string
      : "";
  const sanitized = candidate.replace(/[\r\n\0]+/g, " ").slice(0, 500);
  return sanitized || `The helper process exited with code ${exitCode ?? "?"}.`;
}

interface StoredStartOptions extends ProcessStartOptions {}

export class ProcessSupervisor implements vscode.Disposable {
  private readonly events = new EventEmitter();
  private readonly output: vscode.LogOutputChannel;
  private processTerminal?: InteractiveProcessTerminal;
  private terminal?: vscode.Terminal;
  private status: ProcessStatus = "stopped";
  private mode?: string;
  private pid?: number;
  private startedAt?: string;
  private awaitingInput = false;
  private publicUrl?: string;
  private logText = "";
  private logPending = "";
  private detectionTail = "";
  private lastStart?: StoredStartOptions;
  private stopPromise?: Promise<void>;
  private disposed = false;

  constructor() {
    this.output = vscode.window.createOutputChannel("VSPiLink", { log: true });
  }

  onDidChange(listener: () => void): vscode.Disposable {
    this.events.on("change", listener);
    return new vscode.Disposable(() => this.events.off("change", listener));
  }

  get viewState(): ProcessViewState {
    return {
      status: this.status,
      ...(this.mode ? { mode: this.mode } : {}),
      ...(this.pid ? { pid: this.pid } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      awaitingInput: this.awaitingInput,
    };
  }

  get capturedPublicUrl(): string | undefined {
    return this.publicUrl;
  }

  get logs(): string[] {
    return this.logText.split(/\r?\n/).filter(Boolean).slice(-300);
  }

  get isActive(): boolean {
    return Boolean(this.processTerminal?.isRunning);
  }

  async waitForPublicUrl(timeoutMs = 120_000): Promise<string> {
    if (this.publicUrl) return this.publicUrl;
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        disposable.dispose();
        if (error) reject(error);
        else resolve(value as string);
      };
      const disposable = this.onDidChange(() => {
        if (this.publicUrl) finish(undefined, this.publicUrl);
        else if (this.status === "error" || (this.status === "stopped" && !this.isActive)) {
          finish(new Error("The PiLink process stopped before publishing its endpoint."));
        }
      });
      const timeout = setTimeout(() => finish(new Error("Timed out while waiting for the PiLink endpoint.")), timeoutMs);
      timeout.unref();
    });
  }

  async start(options: ProcessStartOptions): Promise<void> {
    if (this.disposed) throw new Error("The VSPiLink supervisor has already been closed.");
    if (this.isActive || this.status === "starting") throw new Error("PiLink is already running.");

    this.lastStart = { ...options, args: [...options.args] };
    this.mode = options.mode;
    this.status = "starting";
    this.pid = undefined;
    this.startedAt = new Date().toISOString();
    this.awaitingInput = false;
    this.publicUrl = undefined;
    this.logText = "";
    this.logPending = "";
    this.detectionTail = "";
    this.emitChange();

    const terminalBridge = new InteractiveProcessTerminal(options, {
      onSpawn: (child) => {
        this.pid = child.pid;
        this.status = "running";
        // Do not print argv: legacy/custom invocations may contain credential
        // paths or future secret-bearing flags. The graphical status already
        // exposes the safe, user-facing mode.
        this.output.info(`PiLink process started · mode: ${options.mode}.`);
        this.emitChange();
      },
      onOutput: (chunk) => this.captureOutput(chunk),
      onInput: () => {
        this.awaitingInput = false;
        this.emitChange();
      },
      onError: (error) => {
        this.status = "error";
        this.captureOutput(`\n[VSPiLink] ${error.message}\n`);
      },
      onExit: (code, signal) => {
        const wasStopping = this.status === "stopping";
        if (code === 0 || wasStopping || signal === "SIGINT" || signal === "SIGTERM") this.status = "stopped";
        else this.status = "error";
        this.pid = undefined;
        this.awaitingInput = false;
        this.publicUrl = undefined;
        this.detectionTail = "";
        this.captureOutput(`\n[VSPiLink] Process exited (${signal ?? code ?? "unknown"}).\n`);
        this.processTerminal = undefined;
        this.terminal = undefined;
        this.emitChange();
      },
    });
    this.processTerminal = terminalBridge;
    if (options.revealTerminal === false) {
      // The commercial wizard is fully graphical: run the same supervised PTY
      // bridge in the background without creating an Integrated Terminal tab.
      terminalBridge.open();
    } else {
      this.terminal = vscode.window.createTerminal({ name: `VSPiLink · ${options.mode}`, pty: terminalBridge });
      this.terminal.show(true);
    }
  }

  async restart(): Promise<void> {
    if (!this.lastStart) throw new Error("There is no previous VSPiLink start command to repeat.");
    const options = { ...this.lastStart, args: [...this.lastStart.args] };
    await this.stop();
    await this.start(options);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const bridge = this.processTerminal;
    if (!bridge?.isRunning) {
      this.status = "stopped";
      this.pid = undefined;
      this.awaitingInput = false;
      this.publicUrl = undefined;
      this.detectionTail = "";
      this.emitChange();
      return;
    }
    this.status = "stopping";
    this.emitChange();
    this.stopPromise = bridge.stop().finally(() => {
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }

  sendLine(value: string): void {
    if (!this.processTerminal?.isRunning) throw new Error("No interactive PiLink process is running.");
    this.processTerminal.writeInputLine(value);
  }

  showTerminal(): void {
    if (!this.terminal) throw new Error("The VSPiLink terminal is not available yet.");
    this.terminal.show(false);
  }

  showOutput(): void {
    this.output.show(true);
  }

  async disposeAsync(): Promise<void> {
    this.disposed = true;
    await this.stop();
    this.terminal?.dispose();
    this.output.dispose();
    this.events.removeAllListeners();
  }

  dispose(): void {
    void this.disposeAsync();
  }

  private captureOutput(chunk: string): void {
    const plain = stripAnsi(chunk);
    this.detectionTail = `${this.detectionTail}${plain}`.slice(-8 * 1024);
    const publicUrl = this.detectionTail.match(/https:\/\/[-a-z0-9.]+(?:\.trycloudflare\.com|\.nip\.io)/i)?.[0];
    if (publicUrl) this.publicUrl = publicUrl.replace(/\/$/, "");
    this.awaitingInput = isAwaitingCliInput(this.detectionTail);

    this.logPending += chunk;
    const lastNewline = this.logPending.lastIndexOf("\n");
    if (lastNewline >= 0) {
      const completeLines = this.logPending.slice(0, lastNewline + 1);
      this.logPending = this.logPending.slice(lastNewline + 1);
      const redacted = redactSensitiveOutput(completeLines);
      this.logText = `${this.logText}${redacted}`.slice(-96 * 1024);
      this.output.append(redacted);
    }
    this.emitChange();
  }

  private emitChange(): void {
    this.events.emit("change");
  }
}

interface TerminalCallbacks {
  onSpawn(child: ChildProcessWithoutNullStreams): void;
  onOutput(chunk: string): void;
  onInput(): void;
  onError(error: Error): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
}

class InteractiveProcessTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  private child?: ChildProcessWithoutNullStreams;
  private inputBuffer = "";
  private stopping = false;
  private finalized = false;
  private exitPromise?: Promise<void>;
  private resolveExit?: () => void;

  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  constructor(
    private readonly options: ProcessStartOptions,
    private readonly callbacks: TerminalCallbacks,
  ) {}

  get isRunning(): boolean {
    return Boolean(this.child && !this.finalized);
  }

  open(): void {
    if (this.child) return;
    const detached = process.platform !== "win32";
    const child = spawn(this.options.nodeExecutable, [this.options.cliPath, ...this.options.args], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.environment,
        PILINK_CONFIG: this.options.configPath,
        ELECTRON_RUN_AS_NODE: "1",
      },
      detached,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    child.once("spawn", () => this.callbacks.onSpawn(child));
    child.stdout.on("data", (chunk: Buffer) => this.forwardOutput(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => this.forwardOutput(chunk.toString()));
    child.once("error", (error) => this.callbacks.onError(error));
    child.once("close", (code, signal) => {
      if (this.finalized) return;
      this.finalized = true;
      this.resolveExit?.();
      this.callbacks.onExit(code, signal);
      this.closeEmitter.fire(code ?? undefined);
      this.disposeEmitters();
    });
  }

  close(): void {
    void this.stop();
  }

  handleInput(data: string): void {
    for (const character of data) {
      if (character === "\u0003") {
        void this.stop();
        continue;
      }
      if (character === "\r" || character === "\n") {
        this.writeEmitter.fire("\r\n");
        this.child?.stdin.write(`${this.inputBuffer}\n`);
        this.inputBuffer = "";
        this.callbacks.onInput();
        continue;
      }
      if (character === "\u007f" || character === "\b") {
        if (this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this.writeEmitter.fire("\b \b");
        }
        continue;
      }
      if (character >= " ") {
        this.inputBuffer += character;
        this.writeEmitter.fire(character);
      }
    }
  }

  writeInputLine(value: string): void {
    this.child?.stdin.write(`${value.replace(/[\r\n]+/g, "")}\n`);
    this.writeEmitter.fire("\r\n");
    this.callbacks.onInput();
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || !this.isRunning || this.stopping) return this.exitPromise;
    this.stopping = true;
    if (process.platform === "win32") {
      this.requestGracefulWindowsShutdown();
      const graceful = await waitForExit(this.exitPromise, 2_500);
      if (!graceful && this.isRunning && child.pid) {
        await killWindowsProcessTree(child.pid);
      }
      const terminated = graceful || await waitForExit(this.exitPromise, 2_500);
      if (!terminated && this.isRunning) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process has already exited.
        }
      }
      await waitForExit(this.exitPromise, 1_000);
      return;
    }
    this.signal("SIGINT");
    const graceful = await waitForExit(this.exitPromise, 2_500);
    if (!graceful && this.isRunning) this.signal("SIGTERM");
    const terminated = graceful || await waitForExit(this.exitPromise, 2_500);
    if (!terminated && this.isRunning) this.signal("SIGKILL");
    await waitForExit(this.exitPromise, 1_000);
  }

  private signal(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The process has already exited.
      }
    }
  }

  private requestGracefulWindowsShutdown(): void {
    const child = this.child;
    if (!child?.connected) return;
    try {
      child.send(VSPILINK_SHUTDOWN_MESSAGE, () => undefined);
    } catch {
      // A legacy or already-closed CLI falls back to taskkill below.
    }
  }

  private forwardOutput(value: string): void {
    this.callbacks.onOutput(value);
    this.writeEmitter.fire(toTerminalNewlines(value));
  }

  private disposeEmitters(): void {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", windowsTaskkillArgs(pid), {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    killer.once("error", finish);
    killer.once("close", finish);
  });
}

function toTerminalNewlines(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

async function waitForExit(exitPromise: Promise<void> | undefined, timeoutMs: number): Promise<boolean> {
  if (!exitPromise) return true;
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const exited = exitPromise.then(() => true);
  const result = await Promise.race([exited, timedOut]);
  if (timeout) clearTimeout(timeout);
  return result;
}

export function resolveCliPath(extensionPath: string): string {
  const packaged = path.join(extensionPath, "runtime", "dist", "cli.js");
  const development = path.resolve(extensionPath, "..", "..", "dist", "cli.js");
  return fs.existsSync(packaged) ? packaged : development;
}
