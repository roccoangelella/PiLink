import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessPolicy } from "./harness.js";
import { resolveWorkspacePath } from "./harness.js";

/**
 * The upstream constrained runner predates the current PiLink harness type.
 * Keep its opt-in execution flag local until the core integration can add the
 * matching runtime configuration without coupling this standalone module to
 * the in-progress MCP backend work.
 */
type RunHarnessPolicy = HarnessPolicy & Readonly<{
  allowWorkspaceExecution?: boolean;
}>;

export const RUN_PROFILES = [
  "git_status",
  "git_diff",
  "git_diff_staged",
  "git_log",
  "npm_build",
  "npm_test",
] as const;

export type RunProfile = typeof RUN_PROFILES[number];

export interface RunProfileInput {
  profile: RunProfile;
  paths?: string[];
  maxCount?: number;
  timeout?: number;
}

export interface RunProfileResult {
  profile: RunProfile;
  command: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

interface ResolvedRunCommand {
  executable: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  timeoutSeconds: number;
}

const MAX_STREAM_BYTES = 64 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;

export async function executeRunProfile(
  policy: RunHarnessPolicy,
  input: RunProfileInput,
  abortSignal?: AbortSignal,
): Promise<RunProfileResult> {
  if (abortSignal?.aborted) throw new Error("Constrained command execution was cancelled before it started");
  const workspace = await fs.realpath(policy.workspace);
  const command = await resolveRunCommand(policy, input);
  if (abortSignal?.aborted) throw new Error("Constrained command execution was cancelled before process creation");
  const startedAt = Date.now();
  const stdout = new TailBuffer(MAX_STREAM_BYTES);
  const stderr = new TailBuffer(MAX_STREAM_BYTES);
  let timedOut = false;
  let cancelled = false;

  const child = spawn(command.executable, command.args, {
    cwd: workspace,
    env: command.environment,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer | string) => stdout.append(chunk));
  child.stderr.on("data", (chunk: Buffer | string) => stderr.append(chunk));

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child, "SIGTERM");
  }, command.timeoutSeconds * 1_000);
  timeoutTimer.unref();

  const forceKillTimer = setTimeout(() => {
    if (timedOut && child.exitCode === null && child.signalCode === null) {
      terminateProcessTree(child, "SIGKILL");
    }
  }, command.timeoutSeconds * 1_000 + FORCE_KILL_DELAY_MS);
  forceKillTimer.unref();

  let cancellationForceKillTimer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    cancelled = true;
    terminateProcessTree(child, "SIGTERM");
    cancellationForceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) terminateProcessTree(child, "SIGKILL");
    }, FORCE_KILL_DELAY_MS);
    cancellationForceKillTimer.unref();
  };
  abortSignal?.addEventListener("abort", onAbort, { once: true });

  const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  }).finally(() => {
    clearTimeout(timeoutTimer);
    clearTimeout(forceKillTimer);
    if (cancellationForceKillTimer) clearTimeout(cancellationForceKillTimer);
    abortSignal?.removeEventListener("abort", onAbort);
  });

  return {
    profile: input.profile,
    command: [command.executable, ...command.args],
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: stdout.text(),
    stderr: stderr.text(),
    durationMs: Date.now() - startedAt,
    timedOut,
    cancelled,
    truncated: stdout.truncated || stderr.truncated,
  };
}

async function resolveRunCommand(
  policy: RunHarnessPolicy,
  input: RunProfileInput,
): Promise<ResolvedRunCommand> {
  const timeoutSeconds = clampTimeout(input.timeout, policy.maxBashTimeoutSeconds);
  const relativePaths = await normalizePaths(policy, input.paths);
  const gitBase = [
    "--no-pager",
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${os.devNull}`,
    "-c", "log.showSignature=false",
    "--literal-pathspecs",
  ];

  switch (input.profile) {
    case "git_status":
      return {
        executable: "git",
        args: [...gitBase, "status", "--porcelain=v1", "--branch", "--untracked-files=all", ...pathspec(relativePaths)],
        environment: gitEnvironment(),
        timeoutSeconds,
      };
    case "git_diff":
      return {
        executable: "git",
        args: [...gitBase, "diff", "--no-ext-diff", "--no-textconv", ...pathspec(relativePaths)],
        environment: gitEnvironment(),
        timeoutSeconds,
      };
    case "git_diff_staged":
      return {
        executable: "git",
        args: [...gitBase, "diff", "--cached", "--no-ext-diff", "--no-textconv", ...pathspec(relativePaths)],
        environment: gitEnvironment(),
        timeoutSeconds,
      };
    case "git_log": {
      const maxCount = input.maxCount ?? 20;
      if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > 100) {
        throw new Error("maxCount must be an integer between 1 and 100");
      }
      return {
        executable: "git",
        args: [...gitBase, "log", "--oneline", "--decorate=short", `--max-count=${maxCount}`, ...pathspec(relativePaths)],
        environment: gitEnvironment(),
        timeoutSeconds,
      };
    }
    case "npm_build":
      requireWorkspaceExecution(policy, input);
      return {
        executable: npmExecutable(),
        args: ["run", "build", "--if-present"],
        environment: workspaceExecutionEnvironment(),
        timeoutSeconds,
      };
    case "npm_test":
      requireWorkspaceExecution(policy, input);
      return {
        executable: npmExecutable(),
        args: ["test"],
        environment: workspaceExecutionEnvironment(),
        timeoutSeconds,
      };
    default:
      return assertNever(input.profile);
  }
}

async function normalizePaths(policy: RunHarnessPolicy, suppliedPaths: string[] | undefined): Promise<string[]> {
  if (!suppliedPaths) return [];
  if (suppliedPaths.length > 50) throw new Error("paths may contain at most 50 entries");

  const confinedPolicy: RunHarnessPolicy = { ...policy, unsafeFullAccess: false };
  const normalized: string[] = [];
  for (const suppliedPath of suppliedPaths) {
    if (typeof suppliedPath !== "string" || suppliedPath.length === 0 || suppliedPath.includes("\0")) {
      throw new Error("Every path must be a non-empty string without NUL bytes");
    }
    const absolutePath = await resolveWorkspacePath(confinedPolicy, suppliedPath);
    const relativePath = path.relative(policy.workspace, absolutePath);
    normalized.push(relativePath === "" ? "." : relativePath.split(path.sep).join("/"));
  }
  return normalized;
}

function pathspec(paths: string[]): string[] {
  return paths.length > 0 ? ["--", ...paths] : [];
}

function requireWorkspaceExecution(policy: RunHarnessPolicy, input: RunProfileInput): void {
  if (input.paths && input.paths.length > 0) {
    throw new Error(
      `paths cannot be used with ${input.profile}. Remove paths; this profile runs the package script for the configured workspace.`,
    );
  }
  if (!policy.allowWorkspaceExecution && !policy.unsafeFullAccess) {
    throw new Error(
      `${input.profile} executes code from the workspace and is disabled by default. ` +
      "For a trusted workspace, set PI_ALLOW_WORKSPACE_EXECUTION=true and restart PiLink, or authorize explicit full-access mode.",
    );
  }
}

function clampTimeout(timeout: number | undefined, maximum: number): number {
  const selected = timeout ?? maximum;
  if (!Number.isFinite(selected) || selected <= 0) throw new Error("timeout must be a positive number");
  return Math.min(Math.max(1, selected), maximum);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return minimalEnvironment({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    LC_ALL: "C",
    LANG: "C",
  });
}

function workspaceExecutionEnvironment(): NodeJS.ProcessEnv {
  return minimalEnvironment({
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  });
}

function minimalEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LOCALAPPDATA",
    "APPDATA",
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, ...overrides };
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

class TailBuffer {
  private buffer = Buffer.alloc(0);
  public truncated = false;

  public constructor(private readonly maximumBytes: number) {}

  public append(chunk: Buffer | string): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const combined = Buffer.concat([this.buffer, incoming]);
    if (combined.length > this.maximumBytes) {
      this.truncated = true;
      this.buffer = combined.subarray(combined.length - this.maximumBytes);
    } else {
      this.buffer = combined;
    }
  }

  public text(): string {
    const content = this.buffer.toString("utf8");
    return this.truncated ? `[Earlier output truncated; showing the last ${this.maximumBytes} bytes]\n${content}` : content;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported run profile: ${String(value)}`);
}
