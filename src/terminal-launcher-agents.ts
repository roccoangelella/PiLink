#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runTerminalLauncher } from "./terminal-launcher.js";

const modulePath = fileURLToPath(import.meta.url);

export function printAgentsUsage(): void {
  console.log("Usage: pilink-agents [start|serve] [options]");
  console.log("");
  console.log("Start PiLink in full unsafe mode with multi-agent collaboration.");
  console.log("");
  console.log("Commands:");
  console.log("  pilink-agents                             Start hosted PiLink in multi-agent mode with full machine access");
  console.log("  pilink-agents serve                       Serve local PiLink in multi-agent mode with full machine access");
  console.log("");
  console.log("Options:");
  console.log("  --setup                                   Re-run setup before 'start'");
  console.log("  --help, -h                                Show this help message");
  console.log("");
  console.log("Equivalent to:");
  console.log("  pilink start --mode collaboration --allow-unsafe-full-access");
}

export function resolveAgentsCliArgs(argv: readonly string[] = process.argv.slice(2)): {
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
      throw new Error(`Unknown command '${argv[0]}' for 'pilink-agents'. Expected 'start' or 'serve'.`);
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
      if (modeValue && modeValue !== "collaboration" && modeValue !== "2") {
        throw new Error(`'pilink-agents' runs only in multi-agent collaboration mode. Found '--mode ${argv[index + 1]}'.`);
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--mode=")) {
      const modeValue = argument.slice("--mode=".length).toLowerCase();
      if (modeValue !== "collaboration" && modeValue !== "2") {
        throw new Error(`'pilink-agents' runs only in multi-agent collaboration mode. Found '${argument}'.`);
      }
      continue;
    }
    additionalArgs.push(argument);
  }

  return {
    action: "run",
    args: [subcommand, "--mode", "collaboration", "--allow-unsafe-full-access", ...additionalArgs],
  };
}

export function runAgentsLauncher(argv: readonly string[] = process.argv.slice(2)): void {
  try {
    const resolved = resolveAgentsCliArgs(argv);
    if (resolved.action === "help") {
      printAgentsUsage();
      process.exitCode = 0;
      return;
    }
    process.env.PI_UNSAFE_FULL_ACCESS = "true";
    process.env.PI_RUNTIME_MODE = "collaboration";
    process.env.PI_WORK_DIR = process.env.PI_WORK_DIR || process.cwd();
    if (!process.env.PILINK_CONFIG) {
      const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
      const candidates = [
        path.join(configHome, "pilink-agents", ".env"),
        path.join(configHome, "pilink-multi-agent", ".env"),
        path.join(configHome, "pilink-multi-agents", ".env"),
        path.join(configHome, "pilink-2", ".env"),
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
  runAgentsLauncher();
}
