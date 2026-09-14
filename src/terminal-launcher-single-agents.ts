#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runTerminalLauncher } from "./terminal-launcher.js";

const modulePath = fileURLToPath(import.meta.url);

export function printSingleAgentsUsage(): void {
  console.log("Usage: pilink-single-agents [start|serve] [options]");
  console.log("");
  console.log("Start PiLink in full unsafe mode with single-agent.");
  console.log("");
  console.log("Commands:");
  console.log("  pilink-single-agents                      Start hosted PiLink in single-agent mode with full machine access");
  console.log("  pilink-single-agents serve                Serve local PiLink in single-agent mode with full machine access");
  console.log("");
  console.log("Options:");
  console.log("  --setup                                   Re-run setup before 'start'");
  console.log("  --help, -h                                Show this help message");
  console.log("");
  console.log("Equivalent to:");
  console.log("  pilink start --mode single --allow-unsafe-full-access");
}

export function resolveSingleAgentsCliArgs(argv: readonly string[] = process.argv.slice(2)): {
  action: "help" | "run";
  args: string[];
} {
  if (argv.some((arg) => arg === "--help" || arg === "-h") || (argv.length === 1 && argv[0] === "help")) {
    return { action: "help", args: [] };
  }

  let subcommand = "start";
  let restIndex = 0;

  if (argv.length > 0 && !argv[0].startsWith("-")) {
    const candidate = argv[0].toLowerCase();
    if (candidate === "start" || candidate === "serve") {
      subcommand = candidate;
      restIndex = 1;
    } else {
      throw new Error(`Unknown command '${argv[0]}' for 'pilink-single-agents'. Expected 'start' or 'serve'.`);
    }
  }

  const additionalArgs: string[] = [];
  for (let index = restIndex; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-unsafe-full-access") {
      continue;
    }
    if (argument === "--mode") {
      const modeValue = argv[index + 1]?.toLowerCase();
      if (modeValue && modeValue !== "single" && modeValue !== "1") {
        throw new Error(`'pilink-single-agents' runs only in single-agent mode. Found '--mode ${argv[index + 1]}'.`);
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--mode=")) {
      const modeValue = argument.slice("--mode=".length).toLowerCase();
      if (modeValue !== "single" && modeValue !== "1") {
        throw new Error(`'pilink-single-agents' runs only in single-agent mode. Found '${argument}'.`);
      }
      continue;
    }
    additionalArgs.push(argument);
  }

  return {
    action: "run",
    args: [subcommand, "--mode", "single", "--allow-unsafe-full-access", ...additionalArgs],
  };
}

export function runSingleAgentsLauncher(argv: readonly string[] = process.argv.slice(2)): void {
  try {
    const resolved = resolveSingleAgentsCliArgs(argv);
    if (resolved.action === "help") {
      printSingleAgentsUsage();
      process.exitCode = 0;
      return;
    }
    process.env.PI_UNSAFE_FULL_ACCESS = "true";
    process.env.PI_RUNTIME_MODE = "single";
    process.env.PI_WORK_DIR = process.env.PI_WORK_DIR || process.cwd();
    if (!process.env.PILINK_CONFIG) {
      const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
      const candidates = [
        path.join(configHome, "pilink-single-agent", ".env"),
        path.join(configHome, "pilink-single-agents", ".env"),
        path.join(configHome, "pilink-3", ".env"),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          process.env.PILINK_CONFIG = candidate;
          break;
        }
      }
    }
    runTerminalLauncher(resolved.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  runSingleAgentsLauncher();
}
