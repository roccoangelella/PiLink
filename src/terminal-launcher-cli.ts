#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runTerminalLauncher } from "./terminal-launcher.js";

const modulePath = fileURLToPath(import.meta.url);

export function resolveGatewayCliArgs(argv: readonly string[] = process.argv.slice(2)): {
  action: "help" | "run";
  args: string[];
} {
  if (argv.some((arg) => arg === "--help" || arg === "-h") || (argv.length === 1 && argv[0] === "help")) {
    return { action: "help", args: [] };
  }
  const subcommand = argv[0] ?? "start";
  if (!["start", "serve", "connect", "status", "release", "browser-extension"].includes(subcommand)) {
    throw new Error(`Unknown pilink-cli command '${subcommand}'. Expected start, serve, connect, status, release, or browser-extension.`);
  }
  return { action: "run", args: ["gateway", ...(argv.length ? argv : ["status"])] };
}

export function runGatewayCliLauncher(argv: readonly string[] = process.argv.slice(2)): void {
  try {
    const resolved = resolveGatewayCliArgs(argv);
    if (resolved.action === "help") {
      console.log("Usage: pilink-cli [status|start|serve|connect|release|browser-extension] [options]");
      console.log("Without arguments, reports the current gateway status; 'start' launches a new gateway.");
      console.log("Starts the safe ChatGPT model gateway (not the full-unsafe MCP).");
      console.log("Configuration defaults to ~/.config/pilink-gateway/.env; PILINK_CONFIG overrides it.");
      return;
    }
    if (!process.env.PILINK_CONFIG) {
      process.env.PILINK_CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "pilink-gateway", ".env");
    }
    runTerminalLauncher(resolved.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  runGatewayCliLauncher();
}
