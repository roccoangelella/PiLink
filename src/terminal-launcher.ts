#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isRequiredNodeVersion, REQUIRED_NODE_VERSION } from "./runtime.js";

const modulePath = fileURLToPath(import.meta.url);
const moduleDirectory = path.dirname(modulePath);
const coreCliPath = path.join(moduleDirectory, "cli.js");
const terminalChildPath = path.join(moduleDirectory, "terminal-child.js");
const QUIET_RUNTIME_PREFIXES = ["[HTTP]", "[MCP]"] as const;
const ROUTINE_RUNTIME_PREFIXES = ["[OAuth]", "[Agents]"] as const;
const BOX_DRAWING_PREFIXES = ["╔", "║", "╠", "╚"] as const;
const PROXY_STDOUT_TTY = "PILINK_INTERNAL_PROXY_STDOUT_TTY";
const PROXY_STDERR_TTY = "PILINK_INTERNAL_PROXY_STDERR_TTY";
const STATUS_FD_ENV = "PILINK_INTERNAL_TERMINAL_STATUS_FD";
const GATEWAY_MODE_VALUES = new Set(["3", "cli", "gateway", "pilink-endpoint", "endpoint"]);
const ACTIONABLE_RUNTIME_LINE = /\b(?:error|failed|failure|refused|denied|unavailable|invalid|warning|warn|danger|expired|conflict|cannot|could not|rejected)\b/iu;

export interface TerminalStatusField {
  label: string;
  value: string;
}

export interface TerminalStatusSnapshot {
  title: string;
  fields: TerminalStatusField[];
}

export function resolveNodeExecutable(
  currentVersion = process.version,
  currentExecPath = process.execPath,
  home = os.homedir(),
): string | undefined {
  if (isRequiredNodeVersion(currentVersion)) {
    return currentExecPath;
  }
  const nvmCandidate = path.join(home, ".nvm", "versions", "node", `v${REQUIRED_NODE_VERSION}`, "bin", "node");
  if (fs.existsSync(nvmCandidate)) {
    return nvmCandidate;
  }
  const altNvmCandidate = path.join(home, ".nvm", "versions", "node", REQUIRED_NODE_VERSION, "bin", "node");
  if (fs.existsSync(altNvmCandidate)) {
    return altNvmCandidate;
  }
  return undefined;
}

export function terminalLogsAreVerbose(value = process.env.PILINK_TERMINAL_LOGS): boolean {
  return /^(?:1|true|yes|on|verbose|debug)$/iu.test(value?.trim() ?? "");
}

export function launchUsesGateway(argv: readonly string[] = process.argv.slice(2)): boolean {
  const command = argv[0] ?? "start";
  if (command === "gateway") return true;
  if (command !== "start" && command !== "serve") return false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const rawMode = argument === "--mode"
      ? argv[index + 1]
      : argument.startsWith("--mode=")
        ? argument.slice("--mode=".length)
        : undefined;
    if (rawMode && GATEWAY_MODE_VALUES.has(rawMode.trim().toLowerCase())) return true;
  }
  return false;
}

export function chatMonitorAutoLaunchRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:auto|on|true|1|yes)$/iu.test(env.PI_CHAT_CLI?.trim() ?? "");
}

export function shouldUseCompactTerminalOutput(
  argv: readonly string[] = process.argv.slice(2),
  stderrIsTty = process.stderr.isTTY === true,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const command = argv[0] ?? "start";
  return (command === "start" || command === "serve") &&
    stderrIsTty &&
    !terminalLogsAreVerbose(env.PILINK_TERMINAL_LOGS) &&
    !chatMonitorAutoLaunchRequested(env) &&
    !launchUsesGateway(argv);
}

// Kept as an exported compatibility alias for tests/downstream callers that
// used the old name before compact output also covered `serve`.
export const shouldQuietInteractiveStart = shouldUseCompactTerminalOutput;

export function terminalProxyEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTty = process.stdout.isTTY === true,
  stderrIsTty = process.stderr.isTTY === true,
): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  // These are internal truth markers, not user configuration. Always replace
  // any inherited values so callers cannot spoof terminal interactivity.
  if (stdoutIsTty) childEnv[PROXY_STDOUT_TTY] = "1";
  else delete childEnv[PROXY_STDOUT_TTY];
  if (stderrIsTty) childEnv[PROXY_STDERR_TTY] = "1";
  else delete childEnv[PROXY_STDERR_TTY];
  delete childEnv[STATUS_FD_ENV];
  return childEnv;
}

export function filterInteractiveTerminalLine(line: string): string | undefined {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (QUIET_RUNTIME_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return ACTIONABLE_RUNTIME_LINE.test(normalized) ? normalized : undefined;
  }
  if (ROUTINE_RUNTIME_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return ACTIONABLE_RUNTIME_LINE.test(normalized) ? normalized : undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s/u.test(normalized)) return undefined;
  if (/^\d{4}\/\d{2}\/\d{2}\s/u.test(normalized)) return undefined;
  if (BOX_DRAWING_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return undefined;
  return normalized;
}

export class InteractiveTerminalOutputFilter {
  private pending = "";

  push(chunk: string | Buffer): string {
    this.pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let output = "";
    while (true) {
      const newline = this.pending.indexOf("\n");
      if (newline < 0) break;
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      const selected = filterInteractiveTerminalLine(line);
      if (selected !== undefined) output += `${selected}\n`;
    }

    // Readline prompts such as `> ` are intentionally emitted without a
    // trailing newline. Forward ordinary partial text immediately, while
    // retaining only prefixes that may still turn into a noisy runtime line.
    if (this.pending && !couldBeRuntimeNoisePrefix(this.pending)) {
      output += this.pending;
      this.pending = "";
    }
    return output;
  }

  flush(): string {
    if (!this.pending) return "";
    const selected = filterInteractiveTerminalLine(this.pending);
    this.pending = "";
    return selected ?? "";
  }
}

function couldBeRuntimeNoisePrefix(value: string): boolean {
  if (/^\d/u.test(value)) return true;
  if (BOX_DRAWING_PREFIXES.some((prefix) => value.startsWith(prefix))) return true;
  const prefixes = [...QUIET_RUNTIME_PREFIXES, ...ROUTINE_RUNTIME_PREFIXES];
  return prefixes.some((prefix) => prefix.startsWith(value) || value.startsWith(prefix));
}

function sanitizeStatusText(value: unknown, maximumLength = 4096): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maximumLength);
}

export function parseTerminalStatusSnapshot(line: string): TerminalStatusSnapshot | undefined {
  if (Buffer.byteLength(line, "utf8") > 64 * 1024) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const title = sanitizeStatusText(record.title, 160);
  if (!title || !Array.isArray(record.fields) || record.fields.length > 12) return undefined;
  const fields: TerminalStatusField[] = [];
  for (const entry of record.fields) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const field = entry as Record<string, unknown>;
    const label = sanitizeStatusText(field.label, 40);
    const fieldValue = sanitizeStatusText(field.value, 4096);
    if (!label || !fieldValue) return undefined;
    fields.push({ label, value: fieldValue });
  }
  return { title, fields };
}

export function renderTerminalStatusLines(snapshot: TerminalStatusSnapshot, columns = 120): string[] {
  const width = Number.isSafeInteger(columns) && columns > 20 ? columns : 120;
  const lines = [`PiLink · ${snapshot.title}`];
  for (const { label, value } of snapshot.fields) lines.push(`${label}: ${value}`);
  return lines.map((line) => fitTerminalLine(line, width));
}

function fitTerminalLine(line: string, columns: number): string {
  if (line.length <= columns) return line;
  if (columns <= 1) return line.slice(0, columns);
  return `${line.slice(0, Math.max(1, columns - 1))}…`;
}

export class PinnedTerminalStatus {
  private lines: string[] = [];
  private visible = false;

  constructor(
    private readonly write: (value: string) => void,
    private readonly columns: () => number = () => process.stderr.columns || 120,
  ) {}

  set(snapshot: TerminalStatusSnapshot): void {
    this.clear();
    this.lines = renderTerminalStatusLines(snapshot, this.columns());
    this.render();
  }

  beforeOutput(): void {
    this.clear();
  }

  afterOutput(output: string): void {
    if (output.endsWith("\n")) this.render();
  }

  clear(): void {
    if (!this.visible || this.lines.length === 0) return;
    for (let index = 0; index < this.lines.length; index += 1) {
      this.write("\x1b[1A\r\x1b[2K");
    }
    this.visible = false;
  }

  dispose(): void {
    this.clear();
    this.lines = [];
  }

  private render(): void {
    if (this.visible || this.lines.length === 0) return;
    this.write(`\n${this.lines.join("\n")}\n`);
    this.visible = true;
  }
}

function runTerminalLauncher(): void {
  const nodeExecutable = resolveNodeExecutable();
  if (!nodeExecutable) {
    console.error(`PiLink requires Node.js ${REQUIRED_NODE_VERSION} exactly; current runtime is ${process.version}.`);
    console.error(`Please install or select Node.js ${REQUIRED_NODE_VERSION} (e.g. using 'nvm use ${REQUIRED_NODE_VERSION}').`);
    process.exitCode = 1;
    return;
  }

  const argv = process.argv.slice(2);
  const compact = shouldUseCompactTerminalOutput(argv);
  const childEnv = compact ? terminalProxyEnvironment() : process.env;
  if (compact) childEnv[STATUS_FD_ENV] = "3";
  const child = spawn(nodeExecutable, [compact ? terminalChildPath : coreCliPath, ...argv], {
    env: childEnv,
    stdio: compact ? ["inherit", "pipe", "pipe", "pipe"] : "inherit",
  });

  const stdoutFilter = compact ? new InteractiveTerminalOutputFilter() : undefined;
  const stderrFilter = compact ? new InteractiveTerminalOutputFilter() : undefined;
  const pinnedStatus = compact ? new PinnedTerminalStatus((value) => process.stderr.write(value)) : undefined;
  let statusBuffer = "";

  const writeVisible = (target: NodeJS.WriteStream, output: string) => {
    if (!output) return;
    pinnedStatus?.beforeOutput();
    target.write(output);
    pinnedStatus?.afterOutput(output);
  };

  if (compact) {
    child.stdout?.on("data", (chunk: Buffer) => {
      writeVisible(process.stdout, stdoutFilter?.push(chunk) ?? "");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      writeVisible(process.stderr, stderrFilter?.push(chunk) ?? "");
    });
    const statusStream = child.stdio[3] as NodeJS.ReadableStream | null;
    statusStream?.on("data", (chunk: Buffer) => {
      statusBuffer += chunk.toString("utf8");
      if (statusBuffer.length > 128 * 1024) statusBuffer = statusBuffer.slice(-64 * 1024);
      while (true) {
        const newline = statusBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = statusBuffer.slice(0, newline);
        statusBuffer = statusBuffer.slice(newline + 1);
        const snapshot = parseTerminalStatusSnapshot(line);
        if (snapshot) pinnedStatus?.set(snapshot);
      }
    });
  }

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = () => {
      pinnedStatus?.dispose();
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  child.once("error", (error) => {
    pinnedStatus?.dispose();
    console.error(`Unable to start the PiLink CLI: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    for (const [name, handler] of signalHandlers) process.off(name, handler);
    pinnedStatus?.dispose();
    const stdoutTail = stdoutFilter?.flush() ?? "";
    const stderrTail = stderrFilter?.flush() ?? "";
    if (stdoutTail) process.stdout.write(stdoutTail);
    if (stderrTail) process.stderr.write(stderrTail);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  runTerminalLauncher();
}
