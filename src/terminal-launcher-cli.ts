#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { verifyLocalGateway, ensurePiGatewayModel } from "./pilink-cli-agent.js";
import { runTerminalLauncher } from "./terminal-launcher.js";

const modulePath = fileURLToPath(import.meta.url);
const GATEWAY_COMMANDS = new Set(["start", "serve", "connect", "status", "release", "browser-extension"]);

export function resolvePiLinkCliArgs(argv: readonly string[] = process.argv.slice(2)): {
  action: "gateway" | "pi" | "pi-help";
  args: string[];
} {
  if (argv[0] === "gateway") {
    return { action: "gateway", args: ["gateway", ...(argv.length > 1 ? argv.slice(1) : ["status"])] };
  }
  // Keep the explicit management commands from the earlier launcher working,
  // but bare `pilink-cli` always opens Pi Agent in the caller's current folder.
  if (argv[0] && GATEWAY_COMMANDS.has(argv[0])) {
    return { action: "gateway", args: ["gateway", ...argv] };
  }
  if (argv.length === 1 && ["--help", "-h", "--version", "-v"].includes(argv[0])) {
    return { action: "pi-help", args: [...argv] };
  }
  if (argv.some((arg) => arg === "--provider" || arg.startsWith("--provider=") ||
      arg === "--model" || arg.startsWith("--model="))) {
    throw new Error("pilink-cli always uses the PiLink gateway model. Run 'pi' directly to choose another provider or model.");
  }
  return { action: "pi", args: ["--provider", "pilink", "--model", "pilink", ...argv] };
}

export async function runPiLinkCliLauncher(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const resolved = resolvePiLinkCliArgs(argv);
  if (resolved.action === "gateway") {
    runTerminalLauncher(resolved.args);
    return;
  }
  let environment: NodeJS.ProcessEnv = process.env;
  if (resolved.action === "pi") {
    const gateway = await verifyLocalGateway();
    ensurePiGatewayModel(gateway.baseUrl);
    environment = { ...process.env, PILINK_GATEWAY_API_KEY: gateway.apiKey };
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pi", resolved.args, {
      cwd: process.cwd(), env: environment, stdio: "inherit", windowsHide: false,
    });
    child.once("error", (error) => reject(new Error(`Could not start Pi Agent: ${error.message}`)));
    child.once("exit", (code, signal) => {
      process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
      resolve();
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  void runPiLinkCliLauncher().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
