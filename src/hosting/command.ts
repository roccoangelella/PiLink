import { spawn } from "node:child_process";

import { redactCommand } from "./security.js";
import type { CommandRequest, CommandResult, CommandRunner } from "./types.js";

const MAX_CAPTURE_BYTES = 1024 * 1024;

export class SpawnCommandRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(request.command, request.args, {
        env: request.env ? { ...process.env, ...request.env } : process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        settled = true;
        reject(new Error(`Command timed out: ${redactCommand(request.command, request.args)}`));
      }, request.timeoutMs ?? 30_000);
      timeout.unref();

      const capture = (current: string, chunk: Buffer): string => {
        if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) return current;
        return (current + chunk.toString("utf8")).slice(0, MAX_CAPTURE_BYTES);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (request.captureOutput !== false) stdout = capture(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (request.captureOutput !== false) stderr = capture(stderr, chunk);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ exitCode: error.code === "ENOENT" ? 127 : 126, stdout: "", stderr: error.code ?? "spawn_failed" });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }
}

export class RedactedCommandError extends Error {
  readonly exitCode: number;
  readonly command: string;

  constructor(request: CommandRequest, exitCode: number) {
    const command = redactCommand(request.command, request.args);
    super(`Command failed with exit code ${exitCode}: ${command}`);
    this.name = "RedactedCommandError";
    this.exitCode = exitCode;
    this.command = command;
  }
}

export async function runChecked(runner: CommandRunner, request: CommandRequest): Promise<CommandResult> {
  const result = await runner.run(request);
  if (result.exitCode !== 0) throw new RedactedCommandError(request, result.exitCode);
  return result;
}
