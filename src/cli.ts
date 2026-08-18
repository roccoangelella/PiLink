#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const coreCliPath = path.join(path.dirname(modulePath), "cli-core.js");
const QUIET_RUNTIME_PREFIXES = ["[HTTP]", "[MCP]"] as const;
const BOX_DRAWING_PREFIXES = ["╔", "║", "╠", "╚"] as const;

export function terminalLogsAreVerbose(value = process.env.PILINK_TERMINAL_LOGS): boolean {
  return /^(?:1|true|yes|on|verbose|debug)$/iu.test(value?.trim() ?? "");
}

export function shouldQuietInteractiveStart(
  argv: readonly string[] = process.argv.slice(2),
  stderrIsTty = process.stderr.isTTY === true,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const command = argv[0] ?? "start";
  return command === "start" && stderrIsTty && !terminalLogsAreVerbose(env.PILINK_TERMINAL_LOGS);
}

export function filterInteractiveTerminalLine(line: string): string | undefined {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (QUIET_RUNTIME_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return undefined;
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
  return QUIET_RUNTIME_PREFIXES.some((prefix) => prefix.startsWith(value) || value.startsWith(prefix));
}

function runCliLauncher(): void {
  const argv = process.argv.slice(2);
  const quiet = shouldQuietInteractiveStart(argv);
  const stdio: "inherit" | ["inherit", "pipe", "pipe"] | ["inherit", "inherit", "inherit", "ipc"] = quiet
    ? ["inherit", "pipe", "pipe"]
    : process.channel
      ? ["inherit", "inherit", "inherit", "ipc"]
      : "inherit";
  const child = spawn(process.execPath, [coreCliPath, ...argv], {
    env: process.env,
    stdio,
  });

  const stdoutFilter = quiet ? new InteractiveTerminalOutputFilter() : undefined;
  const stderrFilter = quiet ? new InteractiveTerminalOutputFilter() : undefined;
  if (quiet) {
    child.stdout?.on("data", (chunk: Buffer) => {
      const output = stdoutFilter?.push(chunk) ?? "";
      if (output) process.stdout.write(output);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const output = stderrFilter?.push(chunk) ?? "";
      if (output) process.stderr.write(output);
    });
  }

  if (process.channel) {
    process.on("message", (message: unknown) => {
      if (child.connected) child.send(message);
    });
    child.on("message", (message: unknown) => {
      if (process.send) process.send(message);
    });
    process.channel.unref();
  }

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  child.once("error", (error) => {
    console.error(`Unable to start the PiLink CLI: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    for (const [name, handler] of signalHandlers) process.off(name, handler);
    const stdoutTail = stdoutFilter?.flush() ?? "";
    const stderrTail = stderrFilter?.flush() ?? "";
    if (stdoutTail) process.stdout.write(stdoutTail);
    if (stderrTail) process.stderr.write(stderrTail);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  runCliLauncher();
}
