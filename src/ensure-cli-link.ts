import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export type CliLinkStatus = "linked" | "already-linked" | "skipped" | "conflict";

export interface CliLinkResult {
  status: CliLinkStatus;
  linkPath?: string;
  reason?: string;
}

export interface CliLinkOptions {
  cliTarget?: string;
  homeDirectory?: string;
  pathValue?: string;
  nodeExecutable?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");

export function ensureCliLink(options: CliLinkOptions = {}): CliLinkResult {
  const env = options.env ?? process.env;
  const info = options.info ?? ((message: string) => console.log(message));
  const warn = options.warn ?? ((message: string) => console.warn(message));
  if (isTruthy(env.CI) || isTruthy(env.PILINK_SKIP_CLI_LINK)) {
    return { status: "skipped", reason: "disabled" };
  }

  const platform = options.platform ?? process.platform;
  const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
  const pathValue = options.pathValue ?? env.PATH ?? "";
  const nodeExecutable = path.resolve(options.nodeExecutable ?? process.execPath);
  const cliTarget = path.resolve(options.cliTarget ?? path.join(repositoryRoot, "dist", "cli.js"));
  if (!fs.existsSync(cliTarget)) {
    throw new Error(`PiLink CLI build output is missing: ${cliTarget}`);
  }

  const binDirectory = selectCliBinDirectory({
    pathValue,
    homeDirectory,
    nodeExecutable,
    platform,
  });
  if (!binDirectory) {
    warn("[PiLink] Build succeeded, but `pilink` was not added to PATH because no existing user-writable PATH directory was found.");
    warn("[PiLink] Use `npm exec -- pilink start` from this checkout, or configure a user-owned npm prefix and run `npm link` once.");
    return { status: "skipped", reason: "no-safe-path-directory" };
  }

  if (platform === "win32") {
    return ensureWindowsShim(binDirectory, cliTarget, nodeExecutable, info, warn);
  }
  return ensurePosixLink(binDirectory, cliTarget, info, warn);
}

export function selectCliBinDirectory(options: {
  pathValue: string;
  homeDirectory: string;
  nodeExecutable: string;
  platform: NodeJS.Platform;
}): string | undefined {
  const pathEntries = options.pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry))
    .filter((entry) => !isNpmInjectedBin(entry, options.platform));
  const key = (value: string) => options.platform === "win32" ? value.toLowerCase() : value;
  const pathKeys = new Set(pathEntries.map(key));
  const preferred = [
    path.join(options.homeDirectory, ".local", "bin"),
    path.join(options.homeDirectory, "bin"),
    path.dirname(options.nodeExecutable),
  ].filter((candidate) => pathKeys.has(key(path.resolve(candidate))));

  let realHome: string;
  try {
    realHome = fs.realpathSync(options.homeDirectory);
  } catch {
    return undefined;
  }

  const seen = new Set<string>();
  for (const candidate of [...preferred, ...pathEntries]) {
    const resolved = path.resolve(candidate);
    const candidateKey = key(resolved);
    if (seen.has(candidateKey)) continue;
    seen.add(candidateKey);
    if (!isWithinHome(resolved, options.homeDirectory, options.platform)) continue;
    try {
      if (!fs.statSync(resolved).isDirectory()) continue;
      const realCandidate = fs.realpathSync(resolved);
      if (!isWithinHome(realCandidate, realHome, options.platform)) continue;
      fs.accessSync(resolved, fs.constants.W_OK);
      return resolved;
    } catch {
      continue;
    }
  }
  return undefined;
}

function ensurePosixLink(
  binDirectory: string,
  cliTarget: string,
  info: (message: string) => void,
  warn: (message: string) => void,
): CliLinkResult {
  fs.chmodSync(cliTarget, 0o755);
  const linkPath = path.join(binDirectory, "pilink");
  if (fs.existsSync(linkPath) || isDanglingSymlink(linkPath)) {
    try {
      if (fs.realpathSync(linkPath) === fs.realpathSync(cliTarget)) {
        info(`[PiLink] CLI already available: ${linkPath}`);
        return { status: "already-linked", linkPath };
      }
    } catch {
      // Fall through to the conflict warning for stale or unreadable links.
    }
    warn(`[PiLink] Build succeeded, but ${linkPath} already exists and was not replaced.`);
    return { status: "conflict", linkPath, reason: "existing-command" };
  }

  fs.symlinkSync(cliTarget, linkPath, "file");
  info(`[PiLink] CLI available as \`pilink\` via ${linkPath}`);
  return { status: "linked", linkPath };
}

function ensureWindowsShim(
  binDirectory: string,
  cliTarget: string,
  nodeExecutable: string,
  info: (message: string) => void,
  warn: (message: string) => void,
): CliLinkResult {
  const linkPath = path.join(binDirectory, "pilink.cmd");
  const marker = "@REM Generated by PiLink source build";
  const shim = `${marker}\r\n@echo off\r\n"${escapeCmdLiteral(nodeExecutable)}" "${escapeCmdLiteral(cliTarget)}" %*\r\n`;
  if (fs.existsSync(linkPath)) {
    const existing = fs.readFileSync(linkPath, "utf8");
    if (!existing.startsWith(marker)) {
      warn(`[PiLink] Build succeeded, but ${linkPath} already exists and was not replaced.`);
      return { status: "conflict", linkPath, reason: "existing-command" };
    }
    if (existing === shim) {
      info(`[PiLink] CLI already available: ${linkPath}`);
      return { status: "already-linked", linkPath };
    }
  }
  fs.writeFileSync(linkPath, shim, { mode: 0o700 });
  info(`[PiLink] CLI available as \`pilink\` via ${linkPath}`);
  return { status: "linked", linkPath };
}

function isWithinHome(candidate: string, homeDirectory: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => platform === "win32" ? value.toLowerCase() : value;
  const relative = path.relative(normalize(path.resolve(homeDirectory)), normalize(path.resolve(candidate)));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isNpmInjectedBin(candidate: string, platform: NodeJS.Platform): boolean {
  const normalized = candidate.replaceAll("\\", "/");
  const comparable = platform === "win32" ? normalized.toLowerCase() : normalized;
  return comparable.endsWith("/node_modules/.bin") || comparable.includes("/node_modules/.bin/");
}

function isDanglingSymlink(targetPath: string): boolean {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function escapeCmdLiteral(value: string): string {
  return value.replaceAll("%", "%%").replaceAll('"', '""');
}

function isTruthy(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/iu.test(value ?? "");
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    ensureCliLink();
  } catch (error) {
    console.error(`[PiLink] Unable to expose the CLI: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
