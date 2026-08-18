#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);

export const PROXY_STDOUT_TTY = "PILINK_INTERNAL_PROXY_STDOUT_TTY";
export const PROXY_STDERR_TTY = "PILINK_INTERNAL_PROXY_STDERR_TTY";

interface TtyFlagStream {
  readonly isTTY?: boolean;
}

export function restoreProxiedTtyFlag(stream: TtyFlagStream, marker: string | undefined): void {
  if (marker !== "1") return;
  Object.defineProperty(stream, "isTTY", {
    value: true,
    configurable: true,
  });
}

export function restoreProxiedTerminalState(env: NodeJS.ProcessEnv = process.env): void {
  restoreProxiedTtyFlag(process.stdout, env[PROXY_STDOUT_TTY]);
  restoreProxiedTtyFlag(process.stderr, env[PROXY_STDERR_TTY]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  restoreProxiedTerminalState();
  await import("./cli.js");
}
