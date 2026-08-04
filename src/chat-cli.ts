import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig } from "./config.js";

export interface ChatCliStatePaths {
  projectKey: string;
  projectDir: string;
  chatFile: string;
  tasksFile: string;
}

export interface ChatCliLaunchResult {
  child?: ChildProcess;
  error?: string;
  python?: string;
  paths: ChatCliStatePaths;
}

export function resolveChatCliStatePaths(workspace: string, dataDir: string): ChatCliStatePaths {
  const resolvedWorkspace = path.resolve(workspace);
  const canonicalWorkspace = fs.realpathSync(resolvedWorkspace);
  const canonicalDataDir = path.resolve(dataDir);
  const projectKey = crypto.createHash("sha256").update(canonicalWorkspace).digest("hex");
  const projectDir = path.join(canonicalDataDir, "projects", projectKey);
  return {
    projectKey,
    projectDir,
    chatFile: path.join(projectDir, "agent-chat.json"),
    tasksFile: path.join(projectDir, "agent-tasks.json"),
  };
}

export function bundledChatCliRoot(moduleUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "chat-cli");
}

export function chatCliAutoLaunchEnabled(
  env: NodeJS.ProcessEnv = process.env,
  streams: Readonly<{ stdinIsTTY?: boolean; stdoutIsTTY?: boolean; stderrIsTTY?: boolean }> = {
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
    stderrIsTTY: process.stderr.isTTY,
  },
): boolean {
  const configured = (env.PI_CHAT_CLI || "auto").trim().toLowerCase();
  if (["off", "false", "0", "no", "disabled", "manual"].includes(configured)) return false;
  if (!["auto", "on", "true", "1", "yes"].includes(configured)) {
    throw new Error("PI_CHAT_CLI must be 'auto' or 'off'");
  }
  if (env.CI === "true") return false;
  return Boolean(streams.stdinIsTTY && streams.stdoutIsTTY && streams.stderrIsTTY);
}

export function findChatCliPython(
  env: NodeJS.ProcessEnv = process.env,
  check: typeof spawnSync = spawnSync,
): string | undefined {
  const candidates = [env.PI_CHAT_CLI_PYTHON, "python3", "python"].filter(
    (candidate, index, all): candidate is string => Boolean(candidate) && all.indexOf(candidate) === index,
  );
  const probe = [
    "-c",
    [
      "import sys",
      "import textual",
      "version = tuple(int(part) for part in textual.__version__.split('.')[:2])",
      "sys.exit(0 if version == (0, 51) else 2)",
    ].join("; "),
  ];
  for (const candidate of candidates) {
    const result = check(candidate, probe, {
      stdio: "ignore",
      timeout: 5_000,
      env,
    });
    if (result.status === 0) return candidate;
  }
  return undefined;
}

export function launchChatCli(
  config: Pick<RuntimeConfig, "workspace" | "coordinationDataDir">,
  options: Readonly<{
    env?: NodeJS.ProcessEnv;
    python?: string;
    chatCliRoot?: string;
    spawnProcess?: typeof spawn;
  }> = {},
): ChatCliLaunchResult {
  const env = options.env || process.env;
  const paths = resolveChatCliStatePaths(config.workspace, config.coordinationDataDir);
  const chatCliRoot = options.chatCliRoot || bundledChatCliRoot();
  const packageDir = path.join(chatCliRoot, "pilink_chat_cli");
  if (!fs.existsSync(path.join(packageDir, "__main__.py"))) {
    return { paths, error: `Bundled chat CLI is missing from ${chatCliRoot}` };
  }

  const python = options.python || findChatCliPython(env);
  if (!python) {
    return {
      paths,
      error: "PiLink chat CLI needs Python 3 with Textual 0.51.x. Install it with 'python3 -m pip install \"textual>=0.51,<0.52\"' or set PI_CHAT_CLI=off.",
    };
  }

  const pythonPath = env.PYTHONPATH
    ? `${chatCliRoot}${path.delimiter}${env.PYTHONPATH}`
    : chatCliRoot;
  try {
    const child = (options.spawnProcess || spawn)(python, [
      path.join(packageDir, "__main__.py"),
      "--chat-file",
      paths.chatFile,
      "--tasks-file",
      paths.tasksFile,
      "--missing-as-empty",
    ], {
      env: {
        ...env,
        PYTHONPATH: pythonPath,
        PYTHONNOUSERSITE: "1",
      },
      stdio: "inherit",
    });
    return { child, python, paths };
  } catch (error) {
    return {
      paths,
      python,
      error: `Unable to launch PiLink chat CLI: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
