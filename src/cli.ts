#!/usr/bin/env node
import crypto from "node:crypto";
import dotenv from "dotenv";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable, Transform, Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadEnvironment, loadRuntimeConfig, defaultConfigPath, defaultCoordinationDataDir, type RuntimeConfig } from "./config.js";
import { chatCliAutoLaunchEnabled, launchChatCli } from "./chat-cli.js";
import {
  effectiveClientTokenVersion,
  isClientActive,
  loadClients,
  registerClient,
  rotateClientSecret,
  setClientDisabled,
} from "./auth.js";
import { DIRECT_HTTP_PORT, DIRECT_HTTPS_PORT, DirectNetworkError, discoverPublicIpv4, isPublicIpv4, openAutomaticPortMappings, type ManagedPortMappings } from "./network.js";
import { assertRequiredNodeVersion } from "./runtime.js";
import { runHostingCli } from "./hosting/cli.js";
import { resolveCloudflaredRelease } from "./hosting/cloudflared-release.js";
import { fixedDomainCloudflaredArgs, normalizeFixedDomainHostname, normalizeFixedDomainTunnelId, provisionFixedDomainTunnel, resolveFixedDomainTokenFile } from "./hosting/fixed-domain.js";
import { runAgentAuthCli } from "./agents/auth-cli.js";

assertRequiredNodeVersion();
const [, , command = "start", ...args] = process.argv;
let configPath = process.env.PILINK_CONFIG || defaultConfigPath();
type LaunchMode = "single" | "collaboration" | "vscode";
type HostingMode = "quick-tunnel" | "nip-io" | "cloudflare-fixed";
interface LaunchOptions {
  mode?: LaunchMode;
  unsafe: boolean;
  setup: boolean;
}
const MAX_DEFERRED_SERVER_OUTPUT = 64 * 1024;
const MAX_VERIFIED_BINARY_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const BINARY_PROBE_TIMEOUT_MS = 10_000;
const CLOUDFLARED_VERSION = "2026.7.2";
const CADDY_VERSION = "2.11.4";
const CLOUDFLARED_LINUX_SHA256: Readonly<Record<"x64" | "arm64", string>> = {
  x64: "ec905ea7b7e327ff8abdde8cb64697a2152de74dbcdbf6aec9db8364eb3886cd",
  arm64: "405df476437e027fc6d18729a5a77155c0a33a6082aeee60a799a688f3052e66",
};
const CADDY_LINUX_ARCHIVE_SHA256: Readonly<Record<"x64" | "arm64", string>> = {
  x64: "527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9",
  arm64: "52d42ae12b3462097e9868da6dfed3c9648ae12edd3b3638102312af84cb6904",
};
const CADDY_LINUX_BINARY_SHA256: Readonly<Record<"x64" | "arm64", string>> = {
  x64: "b7105518e3ed1c0761f232e44fc09345535533c9cb0abf0e12809416c7ac64d9",
  arm64: "e1f904038fc11ca897ac5a12fdacfb2a7add02a8720c426d562a37f6fdad2afe",
};
let waitingForSetupCallback = false;
let deferredServerOutput = "";
let deferredServerOutputTruncated = false;
let chatCliActive = false;
let chatCliProcess: ChildProcess | undefined;

installParentShutdownBridge();

if (command === "init") {
  initialize();
} else if (command === "start") {
  try {
    const options = parseLaunchOptions(args, "start");
    if (options === "help") {
      printUsage();
    } else {
      void start(options).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else if (command === "serve") {
  try {
    const options = parseLaunchOptions(args, "serve");
    if (options === "help") {
      printUsage();
    } else {
      serve(options.unsafe, options.mode);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else if (command === "chat") {
  openChatCli();
} else if (command === "reset") {
  void reset(args);
} else if (command === "hosting") {
  void runHostingCli(args).then((exitCode) => { process.exitCode = exitCode; });
} else if (command === "agent-auth") {
  void runAgentAuthCli(args).then((exitCode) => { process.exitCode = exitCode; });
} else if (command === "clients") {
  void manageClients(args).catch(() => {
    console.error("Unable to update the OAuth client store.");
    process.exitCode = 1;
  });
} else {
  printUsage();
  process.exitCode = 1;
}

function printUsage(): void {
  console.error("Usage: pilink <init|start|serve|chat|reset|hosting|agent-auth|clients> [options]");
  console.error("");
  console.error("Launch modes:");
  console.error("  pilink start                              Choose an experience interactively in a TTY");
  console.error("  pilink start --mode single                Classic single-agent PiLink");
  console.error("  pilink start --mode collaboration         Collaborative public-chat orchestration");
  console.error("  pilink start --mode vscode                VS Code graphical experience");
  console.error("  pilink serve --mode <single|collaboration> Start the local server in an explicit mode");
  console.error("  --allow-unsafe-full-access                Opt in to unrestricted access for explicitly selected clients");
  console.error("  --setup                                   Re-run first-time setup (start only)");
  console.error("");
  console.error("Other commands:");
  console.error("  pilink chat");
  console.error("  pilink clients list");
  console.error("  pilink clients disable <client-id>");
  console.error("  pilink clients enable <client-id>");
  console.error("  pilink clients rotate-secret <client-id>");
}

function parseLaunchOptions(commandArgs: string[], commandName: "start" | "serve"): LaunchOptions | "help" {
  let mode: LaunchMode | undefined;
  let unsafe = false;
  let setup = false;

  for (let index = 0; index < commandArgs.length; index += 1) {
    const argument = commandArgs[index];
    if (argument === "--help" || argument === "-h") return "help";
    if (argument === "--allow-unsafe-full-access") {
      unsafe = true;
      continue;
    }
    if (argument === "--setup") {
      if (commandName !== "start") {
        throw new Error("'--setup' is supported only by 'pilink start'.");
      }
      setup = true;
      continue;
    }
    // `--yes` has historically been consumed by `start --setup`; keep it
    // accepted here so scripted setup invocations remain compatible.
    if (argument === "--yes" && commandName === "start") continue;

    let rawMode: string | undefined;
    if (argument === "--mode") {
      rawMode = commandArgs[index + 1];
      if (!rawMode || rawMode.startsWith("-")) {
        throw new Error("'--mode' requires one of: single, collaboration, vscode.");
      }
      index += 1;
    } else if (argument.startsWith("--mode=")) {
      rawMode = argument.slice("--mode=".length);
      if (!rawMode) throw new Error("'--mode' requires one of: single, collaboration, vscode.");
    }

    if (rawMode !== undefined) {
      const normalized = normalizeLaunchMode(rawMode);
      if (!normalized) {
        throw new Error(`Unknown launch mode '${rawMode}'. Choose single, collaboration, or vscode.`);
      }
      if (mode && mode !== normalized) {
        throw new Error(`Launch mode was specified more than once (${mode} and ${normalized}).`);
      }
      mode = normalized;
      continue;
    }

    throw new Error(`Unknown option '${argument}' for 'pilink ${commandName}'. Run 'pilink ${commandName} --help'.`);
  }

  if (commandName === "serve" && mode === "vscode") {
    throw new Error("The VS Code graphical experience is launched with 'pilink start --mode vscode'; 'serve' accepts only single or collaboration.");
  }
  if (commandName === "start" && mode === "vscode" && (unsafe || setup)) {
    throw new Error("The VS Code graphical experience cannot be combined with --setup or --allow-unsafe-full-access. Configure those choices from the VS Code sidebar.");
  }
  return { mode, unsafe, setup };
}

function normalizeLaunchMode(value: string): LaunchMode | undefined {
  switch (value.trim().toLowerCase()) {
    case "1":
    case "single":
    case "classic":
    case "single-agent":
    case "single_agent":
      return "single";
    case "2":
    case "collaboration":
    case "collaborative":
    case "collab":
    case "public-chat":
    case "public_chat":
    case "orchestration":
      return "collaboration";
    case "3":
    case "vscode":
    case "vs-code":
    case "graphical":
    case "gui":
      return "vscode";
    default:
      return undefined;
  }
}

async function manageClients(commandArgs: string[]): Promise<void> {
  if (!fs.existsSync(configPath)) {
    console.error("PiLink is not configured. Run 'pilink init' first.");
    process.exitCode = 1;
    return;
  }
  loadEnvironment();
  loadRuntimeConfig();

  const [action = "list", clientId, ...extra] = commandArgs;
  if (extra.length > 0 || (action === "list" && clientId !== undefined) ||
      (action !== "list" && !isOAuthClientId(clientId))) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (action === "list") {
    const clients = loadClients();
    if (clients.length === 0) {
      console.log("No OAuth clients are registered.");
      return;
    }
    console.log("CLIENT_ID\tSTATUS\tTOKEN_VERSION\tNAME\tSCOPE\tCREATED_AT");
    for (const client of clients) {
      console.log([
        terminalField(client.client_id),
        isClientActive(client) ? "active" : "disabled",
        String(effectiveClientTokenVersion(client)),
        terminalField(client.client_name),
        terminalField(client.scope),
        terminalField(client.created_at),
      ].join("\t"));
    }
    return;
  }

  if (action === "disable" || action === "enable") {
    const disabled = action === "disable";
    const client = await setClientDisabled(clientId, disabled);
    if (!client) {
      console.error("OAuth client not found.");
      process.exitCode = 1;
      return;
    }
    console.error(`${disabled ? "Disabled" : "Enabled"} OAuth client ${terminalField(client.client_id)}.`);
    if (disabled) console.error("Existing access tokens, refresh tokens, and authenticated MCP requests are now invalid.");
    return;
  }

  if (action === "rotate-secret") {
    const rotated = await rotateClientSecret(clientId);
    if (!rotated) {
      console.error("OAuth client not found.");
      process.exitCode = 1;
      return;
    }
    console.error(`Rotated the secret for OAuth client ${terminalField(rotated.client.client_id)}.`);
    console.error("Existing access tokens, refresh tokens, and authenticated MCP requests are now invalid.");
    console.error("Store this new secret now; PiLink will not display it again:");
    console.log(rotated.client_secret);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

function isOAuthClientId(value: unknown): value is string {
  return typeof value === "string" && /^pi_[a-f0-9]{16}$/iu.test(value);
}

function terminalField(value: string): string {
  const safe = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu, " ");
  return JSON.stringify(safe).slice(1, -1);
}

function installParentShutdownBridge(): void {
  if (!process.channel) return;
  let shutdownRequested = false;
  process.on("message", (message: unknown) => {
    if (
      shutdownRequested ||
      !message ||
      typeof message !== "object" ||
      (message as Record<string, unknown>).type !== "vspilink.shutdown"
    ) return;
    shutdownRequested = true;
    const handled = process.emit("SIGINT");
    if (!handled) process.exit(0);
  });
  process.channel.unref();
}

function initialize(portOverride?: number): void {
  if (fs.existsSync(configPath)) {
    console.error(`Configuration already exists: ${configPath}`);
    return;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const workspace = process.cwd();
  const config = [
    "# Generated by pilink init. Keep this file private.",
    `PI_WORK_DIR=${workspace}`,
    `PI_DATA_DIR=${path.dirname(configPath)}`,
    `PI_COORDINATION_DATA_DIR=${defaultCoordinationDataDir(configPath)}`,
    "PI_RUNTIME_MODE=collaboration",
    `PORT=${portOverride ?? 3200}`,
    `JWT_SECRET=${secret()}`,
    `PI_BOOTSTRAP_SECRET=${secret()}`,
    "PI_MAX_BASH_TIMEOUT=120",
    "PI_MAX_MCP_SESSIONS_TOTAL=64",
    "PI_MAX_MCP_SESSIONS_PER_CLIENT=16",
    "PI_MCP_SESSION_IDLE_TIMEOUT=600",
    "PI_MCP_SESSION_RECLAIM_GRACE=5",
    "TOKEN_EXPIRY=3600",
    "PI_REFRESH_TOKEN_EXPIRY=2592000",
    "PI_OAUTH_CONSENT_MODE=paired",
    "PI_OAUTH_PUBLIC_CHATGPT_DCR=false",
    "PI_AGENT_MAX_CONCURRENT=4",
    "PI_AGENT_THINKING_LEVEL=medium",
    "# PI_AGENT_PROVIDER=provider-id",
    "# PI_AGENT_MODEL=model-id",
    "# PI_AGENT_API_KEY=store-only-in-this-private-file",
    "# PI_ALLOW_WORKSPACE_EXECUTION=false",
    "# PI_REQUIRE_EXECUTION_APPROVAL=false",
    "# PI_CHAT_CLI=auto  # open the original read-only monitor after the first authenticated MCP connection; set off to disable",
    "# PI_UNSAFE_FULL_ACCESS=false",
    "# PI_FULL_ACCESS_CLIENT_IDS=",
    "# CORS_ORIGINS=https://client.example",
    "",
  ].join("\n");
  fs.writeFileSync(configPath, config, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  console.error(`Created private configuration: ${configPath}`);
  console.error("Use 'pilink start --allow-unsafe-full-access' only if you accept remote shell access to this machine.");
}

async function reset(args: string[]): Promise<void> {
  const targets = resetTargets();
  console.error("This deletes PiLink's generated configuration, OAuth clients, managed hosting binaries, and Caddy TLS state.");
  console.error("It does not delete your repository or configured workspace.");
  console.error(`Targets:\n${targets.map((target) => `  - ${target}`).join("\n")}`);
  if (!args.includes("--yes")) {
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    const confirmation = (await readline.question("Type RESET to continue: ")).trim();
    readline.close();
    if (confirmation !== "RESET") {
      console.error("Reset cancelled.");
      return;
    }
  }
  removeGeneratedState(targets);
  console.error("PiLink state was reset. The next start is a first-time setup.");
  if (args.includes("--start")) {
    await start({ unsafe: args.includes("--allow-unsafe-full-access"), setup: false });
  }
}

function removeGeneratedState(targets = resetTargets()): void {
  for (const target of targets) fs.rmSync(target, { recursive: true, force: true });
}

function resetTargets(): string[] {
  const configDirectory = path.dirname(configPath);
  let dataDirectory = configDirectory;
  if (fs.existsSync(configPath)) {
    const config = dotenv.parse(fs.readFileSync(configPath));
    if (config.PI_DATA_DIR) dataDirectory = path.resolve(config.PI_DATA_DIR);
  }
  const targets = new Set<string>([
    configPath,
    path.join(dataDirectory, "clients.json"),
    path.join(dataDirectory, "refresh-tokens.json"),
    path.join(dataDirectory, "revoked-tokens.json"),
    path.join(dataDirectory, "oauth-client-audit.jsonl"),
    path.join(dataDirectory, "oauth-state.lock"),
    path.join(configDirectory, "bin", cloudflaredFileName()),
    path.join(configDirectory, "bin", caddyFileName()),
    path.join(configDirectory, "Caddyfile"),
    path.join(configDirectory, "caddy"),
  ]);
  for (const target of targets) assertSafeResetTarget(target);
  return [...targets];
}

function assertSafeResetTarget(target: string): void {
  const resolved = path.resolve(target);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(process.env.HOME || "")) {
    throw new Error(`Refusing to reset unsafe target: ${resolved}`);
  }
}

async function handleSetupMode(): Promise<void> {
  if (!fs.existsSync(configPath) || args.includes("--yes")) {
    console.error("--setup deletes PiLink's generated configuration, OAuth clients, managed hosting binaries, and Caddy TLS state before starting fresh.");
    removeGeneratedState();
    return;
  }

  const existingConfigPath = path.resolve(configPath);
  const existingConfigDirectory = path.dirname(existingConfigPath);
  const existingPort = readPortFromConfig(existingConfigPath);

  console.error("\n=== Setup configuration ===");
  console.error(`Existing configuration found at: ${existingConfigPath}`);
  console.error("1. Create a new separate instance (new config directory and port)");
  console.error("2. Completely overwrite and reset the existing instance");
  const readline = createInterface({ input: process.stdin, output: process.stderr });

  try {
    const choice = (await readline.question("How should PiLink continue? [1/2]: ")).trim();

    if (choice === "1") {
      const defaultConfigDirectory = nextSeparateConfigDirectory(existingConfigDirectory);
      const customDirectory = (await readline.question(`Enter new configuration directory [default: ${defaultConfigDirectory}]: `)).trim();
      const newConfigDirectory = path.resolve(customDirectory || defaultConfigDirectory);
      if (newConfigDirectory === existingConfigDirectory) {
        throw new Error("The separate instance must use a different configuration directory.");
      }
      if (fs.existsSync(newConfigDirectory) && fs.readdirSync(newConfigDirectory).length > 0) {
        throw new Error(`The separate instance configuration directory must be new or empty: ${newConfigDirectory}`);
      }

      const defaultPort = nextSeparatePort(existingPort);
      const customPort = (await readline.question(`Enter new server port [default: ${defaultPort}]: `)).trim();
      const newPort = customPort ? parsePort(customPort) : defaultPort;
      if (newPort === existingPort) {
        throw new Error(`The separate instance must use a different port than ${existingPort}.`);
      }

      configPath = path.join(newConfigDirectory, ".env");
      process.env.PILINK_CONFIG = configPath;
      process.env.PORT = String(newPort);
      initialize(newPort);
      return;
    }

    if (choice === "2") {
      console.error("--setup deletes PiLink's generated configuration, OAuth clients, managed hosting binaries, and Caddy TLS state before starting fresh.");
      removeGeneratedState();
      return;
    }

    throw new Error("Setup cancelled: choose 1 for a separate instance or 2 to overwrite the existing instance.");
  } finally {
    readline.close();
  }
}

function serve(unsafe: boolean, requestedMode?: LaunchMode): void {
  configureRuntimeMode(requestedMode);
  const server = startServer(unsafe);
  armChatCliAutoLaunch(server, Promise.resolve());
}

function openChatCli(): void {
  if (!fs.existsSync(configPath)) {
    console.error(`PiLink configuration does not exist: ${configPath}. Run 'pilink init' first.`);
    process.exitCode = 1;
    return;
  }
  try {
    loadEnvironment();
    const config = loadRuntimeConfig();
    if (config.runtimeMode === "single") {
      throw new Error("The collaboration chat monitor is unavailable in classic single-agent mode. Restart with 'pilink start --mode collaboration' or set PI_RUNTIME_MODE=collaboration.");
    }
    const result = launchChatCli(config);
    if (!result.child) {
      console.error(result.error || "Unable to launch PiLink chat CLI.");
      process.exitCode = 1;
      return;
    }
    result.child.once("error", (error) => {
      console.error(`PiLink chat CLI failed: ${error.message}`);
      process.exitCode = 1;
    });
    result.child.once("exit", (code, signal) => {
      if (code !== 0 && signal === null) process.exitCode = code ?? 1;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function selectLaunchMode(requestedMode?: LaunchMode): Promise<LaunchMode | undefined> {
  loadEnvironment();
  if (requestedMode) return requestedMode;

  const configured = process.env.PI_RUNTIME_MODE?.trim().toLowerCase();
  if (configured && configured !== "single" && configured !== "collaboration") {
    throw new Error("PI_RUNTIME_MODE must be 'single' or 'collaboration'. Choose a mode with 'pilink start --mode <single|collaboration|vscode>'.");
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY || process.env.CI === "true") {
    // Headless and existing automation keep the integrated runtime's default
    // (collaboration) and never block waiting for a terminal answer.
    return configured as "single" | "collaboration" | undefined;
  }

  const defaultMode: "single" | "collaboration" = configured === "single" ? "single" : "collaboration";
  console.error("\n=== Choose your PiLink experience ===");
  console.error("1. Classic single-agent PiLink");
  console.error("   One MCP client and one PiLink tool harness, with collaboration surfaces disabled.");
  console.error("2. Collaborative public-chat orchestration");
  console.error("   Shared agent chat, task coordination, memory, work loops, and supervised agents.");
  console.error("3. VS Code graphical experience");
  console.error("   Open the optional VSPiLink sidebar and use its graphical PiLink controls for either mode.");
  console.error(`Press Enter to keep the current mode (${defaultMode}).`);

  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const choice = (await readline.question("Select experience [1/2/3]: ")).trim();
    if (!choice) return defaultMode;
    const selected = normalizeLaunchMode(choice);
    if (!selected) throw new Error("Launch setup cancelled: choose 1 for single-agent, 2 for collaboration, or 3 for VS Code.");
    return selected;
  } finally {
    readline.close();
  }
}

function configureRuntimeMode(mode?: LaunchMode): "single" | "collaboration" | undefined {
  if (!mode || mode === "vscode") return undefined;
  if (!fs.existsSync(configPath)) initialize();
  saveConfig({ PI_RUNTIME_MODE: mode });
  process.env.PI_RUNTIME_MODE = mode;
  return mode;
}

function launchVscodeExperience(): void {
  const workspace = path.resolve(process.env.PI_WORK_DIR || process.cwd());
  const configuredCommand = process.env.PI_VSCODE_COMMAND?.trim();
  const command = configuredCommand || (process.platform === "win32" ? "code.cmd" : "code");
  if (!command || /[\u0000\r\n]/u.test(command)) {
    throw new Error("PI_VSCODE_COMMAND is invalid. Set it to the VS Code command-line executable, usually 'code'.");
  }
  if (!canRun(command)) {
    throw new Error(
      `VS Code's '${command}' command was not found. Install VS Code and enable its 'code' command, or set PI_VSCODE_COMMAND. ` +
      "Then run 'pilink start --mode vscode' again.",
    );
  }

  console.error("\n=== VS Code graphical experience ===");
  console.error(`Opening workspace: ${workspace}`);
  console.error("If the optional VSPiLink sidebar is not installed, run 'npm run vscode:install' from the PiLink checkout first.");
  console.error("After VS Code opens, use the VSPiLink sidebar to choose a PiLink single-agent or collaborative workflow and start safely in workspace access.");
  try {
    const child = spawn(command, ["--reuse-window", workspace], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => {
      console.error(`Could not open VS Code: ${error.message}`);
      process.exitCode = 1;
    });
    child.unref();
  } catch (error) {
    throw new Error(`Could not open VS Code: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface StartedServer {
  process: ChildProcess;
  ready: Promise<boolean>;
  connected: Promise<boolean>;
  config: RuntimeConfig;
}

function armChatCliAutoLaunch(server: StartedServer, prerequisite: Promise<unknown>): void {
  if (server.config.runtimeMode === "single") return;
  let enabled: boolean;
  try {
    enabled = chatCliAutoLaunchEnabled();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return;
  }
  if (!enabled) return;

  void Promise.all([server.connected, prerequisite]).then(([connected]) => {
    if (!connected || server.process.exitCode !== null || server.process.killed || chatCliProcess) return;
    const result = launchChatCli(server.config);
    if (!result.child) {
      console.error(result.error || "Unable to launch PiLink chat CLI.");
      return;
    }

    const child = result.child;
    chatCliProcess = child;
    chatCliActive = true;
    let finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (finished) return;
      finished = true;
      chatCliActive = false;
      chatCliProcess = undefined;
      if (error) console.error(`PiLink chat CLI failed: ${error.message}`);
      if (server.process.exitCode === null && !server.process.killed) server.process.kill("SIGINT");
      if (error || (code !== 0 && signal === null)) process.exitCode = code ?? 1;
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("exit", (code, signal) => finish(code, signal));
    server.process.once("exit", () => {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    });
  }).catch((error) => {
    console.error(`PiLink chat CLI could not start: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function start(options: LaunchOptions): Promise<void> {
  if (options.setup) {
    await handleSetupMode();
  }
  const mode = await selectLaunchMode(options.mode);
  if (mode === "vscode") {
    // The graphical handoff does not need a server configuration yet; let the
    // VS Code wizard create or select one so it can own the first-run choices.
    launchVscodeExperience();
    return;
  }
  if (!fs.existsSync(configPath)) initialize();
  configureRuntimeMode(mode);
  let hostingMode: HostingMode;
  try {
    hostingMode = await selectHostingMode(options.setup);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to configure hosting");
    process.exitCode = 1;
    return;
  }
  saveConfig({ PI_OAUTH_PUBLIC_CHATGPT_DCR: "true" });
  process.env.PI_OAUTH_PUBLIC_CHATGPT_DCR = "true";
  if (hostingMode === "nip-io") {
    await startNipIo(options.unsafe, options.setup);
    return;
  }
  if (hostingMode === "cloudflare-fixed") {
    await startCloudflareNamed(options.unsafe, options.setup);
    return;
  }
  await startQuickTunnel(options.unsafe, options.setup);
}

async function startCloudflareNamed(unsafe: boolean, forceSetup: boolean): Promise<void> {
  loadEnvironment();
  const serverUrl = configuredFixedDomainServerUrl();
  const tunnelId = normalizeFixedDomainTunnelId(process.env.PI_CLOUDFLARE_TUNNEL_ID || "");
  const tokenFile = resolveFixedDomainTokenFile(process.env.PI_CLOUDFLARE_TOKEN_FILE || "");
  let executable: string;
  try {
    executable = await ensureCloudflared();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to install cloudflared");
    process.exitCode = 1;
    return;
  }

  const tunnel = spawn(executable, fixedDomainCloudflaredArgs({ tunnelId, tokenFile }), {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let server: ChildProcess | undefined;
  let shuttingDown = false;
  tunnel.stderr?.on("data", (chunk: Buffer) => writeServerOutput(chunk.toString()));
  tunnel.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") console.error("cloudflared could not be executed after installation.");
    else console.error(`Unable to start the Cloudflare Named Tunnel: ${error.message}`);
    server?.kill("SIGINT");
    process.exitCode = 1;
  });
  tunnel.on("exit", (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Cloudflare Named Tunnel exited (${code ?? "signal"}); stopping PiLink.`);
    server?.kill("SIGINT");
    process.exitCode = code === 0 ? 0 : 1;
  });

  printCloudflareNamedStartupInstructions(serverUrl);
  const startedServer = startServer(unsafe, serverUrl, tunnel);
  server = startedServer.process;
  const setup = startedServer.ready.then((serverReady) => {
    if (serverReady) return runFirstTimeSetup(serverUrl, forceSetup);
  });
  armChatCliAutoLaunch(startedServer, setup);
}

function configuredFixedDomainServerUrl(): string {
  const raw = process.env.SERVER_URL?.trim();
  if (!raw) throw new Error("Cloudflare fixed-domain hosting requires SERVER_URL. Run the hosting setup again.");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Cloudflare fixed-domain SERVER_URL is invalid. Run the hosting setup again.");
  }
  const hostname = normalizeFixedDomainHostname(parsed.hostname);
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
    (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash
  ) {
    throw new Error("Cloudflare fixed-domain SERVER_URL must be a bare HTTPS origin such as https://mcp.example.com");
  }
  return `https://${hostname}`;
}

async function startQuickTunnel(unsafe: boolean, forceSetup: boolean): Promise<void> {
  const port = readPort();
  let executable: string;
  try {
    executable = await ensureCloudflared();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to install cloudflared");
    process.exitCode = 1;
    return;
  }
  const tunnel = spawn(executable, ["tunnel", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  let server: ChildProcess | undefined;
  let shuttingDown = false;
  let output = "";
  const discoverUrl = (chunk: Buffer) => {
    output += chunk.toString();
    const url = output.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i)?.[0];
    if (url) {
      tunnel.stdout?.removeAllListeners("data");
      tunnel.stderr?.removeAllListeners("data");
      printQuickTunnelStartupInstructions(url);
      const startedServer = startServer(unsafe, url, tunnel);
      server = startedServer.process;
      const setup = startedServer.ready.then((serverReady) => {
        if (serverReady) return runFirstTimeSetup(url, forceSetup, true);
      });
      armChatCliAutoLaunch(startedServer, setup);
    }
  };
  tunnel.stdout?.on("data", discoverUrl);
  tunnel.stderr?.on("data", discoverUrl);
  tunnel.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") console.error("cloudflared could not be executed after installation.");
    else console.error(`Unable to start cloudflared: ${error.message}`);
    process.exitCode = 1;
  });
  tunnel.on("exit", (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`cloudflared exited (${code ?? "signal"}); stopping PiLink.`);
    server?.kill("SIGINT");
    process.exitCode = code === 0 ? 0 : 1;
  });
}

async function selectHostingMode(forceSetup: boolean): Promise<HostingMode> {
  loadEnvironment();
  const configuredMode = process.env.PI_HOSTING_MODE?.trim();
  if (!forceSetup && (configuredMode === "quick-tunnel" || configuredMode === "nip-io" || configuredMode === "cloudflare-fixed")) {
    return configuredMode;
  }
  if (configuredMode && configuredMode !== "quick-tunnel" && configuredMode !== "nip-io" && configuredMode !== "cloudflare-fixed") {
    throw new Error("PI_HOSTING_MODE must be 'quick-tunnel', 'nip-io', or 'cloudflare-fixed'");
  }

  if (forceSetup) console.error("\n=== Reconfigure public hosting ===");
  console.error("\n=== Choose public hosting ===");
  console.error("1. Cloudflare Quick Tunnel (recommended for a first test)");
  console.error("   No account, router changes, or extra setup. Its URL changes every restart, so ChatGPT requires a new connector and OAuth client each session.");
  console.error("2. Direct nip.io HTTPS hosting");
  console.error("   Keeps the same URL while your public IPv4 address stays the same. It exposes this computer to the Internet and requires router port forwarding plus a reachable public IPv4 address.");
  console.error("3. Cloudflare fixed domain (Named Tunnel)");
  console.error("   Uses a hostname you own, such as mcp.example.com. The SSE/OAuth URLs stay the same across PiLink restarts; no inbound router ports are required.");
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const choice = (await readline.question("Select hosting [1/2/3]: ")).trim();
  readline.close();
  if (choice === "" || choice === "1") {
    saveConfig({ PI_HOSTING_MODE: "quick-tunnel", PI_OAUTH_PUBLIC_CHATGPT_DCR: "true" });
    process.env.PI_HOSTING_MODE = "quick-tunnel";
    process.env.PI_OAUTH_PUBLIC_CHATGPT_DCR = "true";
    return "quick-tunnel";
  }
  if (choice === "2") {
    await configureNipIoHosting();
    return "nip-io";
  }
  if (choice === "3") {
    await configureCloudflareNamedHosting();
    return "cloudflare-fixed";
  }
  throw new Error("Hosting setup cancelled: choose 1, 2, or 3.");
}

async function configureCloudflareNamedHosting(): Promise<void> {
  const port = readPort();
  console.error("\n=== Cloudflare fixed-domain setup ===");
  console.error("PiLink can create the remotely managed tunnel, ingress rule, DNS record, and scoped tunnel token automatically.");
  console.error("Your domain must already use Cloudflare DNS. Create a scoped Cloudflare API token with:");
  console.error("  Account → Cloudflare Tunnel → Edit");
  console.error("  Zone → DNS → Edit");
  console.error("  Zone → Zone → Read");
  console.error("Scope the token to the account and DNS zone you want PiLink to use. PiLink uses this token only for provisioning and never writes it to configuration.");
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  let hostname: string;
  try {
    hostname = normalizeFixedDomainHostname(await readline.question("Fixed Cloudflare hostname (for example mcp.example.com): "));
  } finally {
    readline.close();
  }
  const configuredToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const apiToken = configuredToken || await questionSecret("Cloudflare API token (input hidden): ");
  if (configuredToken) console.error("Using CLOUDFLARE_API_TOKEN from the current process environment; it will not be saved.");
  const tokenDirectory = path.join(path.dirname(configPath), "cloudflare");
  console.error(`Provisioning ${hostname} through Cloudflare…`);
  const provisioned = await provisionFixedDomainTunnel({
    hostname,
    origin: `http://127.0.0.1:${port}`,
    apiToken,
    tokenDirectory,
  });
  if (configuredToken) delete process.env.CLOUDFLARE_API_TOKEN;
  const serverUrl = `https://${hostname}`;
  saveConfig({
    PI_HOSTING_MODE: "cloudflare-fixed",
    PI_CLOUDFLARE_TUNNEL_ID: provisioned.tunnelId,
    PI_CLOUDFLARE_TOKEN_FILE: provisioned.tokenFile,
    SERVER_URL: serverUrl,
    TRUST_PROXY: "true",
    PI_OAUTH_PUBLIC_CHATGPT_DCR: "true",
  });
  process.env.PI_HOSTING_MODE = "cloudflare-fixed";
  process.env.PI_CLOUDFLARE_TUNNEL_ID = provisioned.tunnelId;
  process.env.PI_CLOUDFLARE_TOKEN_FILE = provisioned.tokenFile;
  process.env.SERVER_URL = serverUrl;
  process.env.TRUST_PROXY = "true";
  process.env.PI_OAUTH_PUBLIC_CHATGPT_DCR = "true";
  console.error(`Cloudflare tunnel ready: ${provisioned.tunnelName}`);
  console.error(`PiLink saved only the scoped tunnel run token at: ${provisioned.tokenFile}`);
  console.error("The Cloudflare account API token was not saved.");
  console.error(`PiLink will reuse the fixed MCP URL: ${serverUrl}/sse`);
}

async function questionSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("Set CLOUDFLARE_API_TOKEN in the process environment when fixed-domain provisioning is non-interactive.");
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  process.stderr.write(prompt);
  muted = true;
  try {
    return (await readline.question("")).trim();
  } finally {
    muted = false;
    readline.close();
    process.stderr.write("\n");
  }
}

async function configureNipIoHosting(): Promise<void> {
  console.error("\n=== Direct nip.io HTTPS setup ===");
  console.error("PiLink can automatically request temporary router mappings for public TCP 80 → local 8080 and public TCP 443 → local 8443.");
  console.error("It tries UPnP first, then NAT-PMP; mappings are renewed while PiLink runs and removed when it stops.");
  console.error("This exposes PiLink to the Internet. Keep its generated secrets private and enable unsafe full access only for a fully trusted client.");
  console.error("If your system uses firewalld, allow Caddy's local forwarded ports before continuing:");
  console.error("  sudo firewall-cmd --state");
  console.error("  sudo firewall-cmd --list-all");
  console.error("  sudo firewall-cmd --permanent --add-port=8080/tcp");
  console.error("  sudo firewall-cmd --permanent --add-port=8443/tcp");
  console.error("  sudo firewall-cmd --reload");
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const automatic = (await readline.question("Allow PiLink to request these temporary router mappings? [Y/n]: ")).trim().toLowerCase();
  readline.close();
  if (automatic === "" || automatic === "y" || automatic === "yes") {
    saveConfig({ PI_HOSTING_MODE: "nip-io", PI_NIP_IO_NETWORK: "auto", PI_OAUTH_PUBLIC_CHATGPT_DCR: "true" });
    process.env.PI_HOSTING_MODE = "nip-io";
    process.env.PI_NIP_IO_NETWORK = "auto";
    process.env.PI_OAUTH_PUBLIC_CHATGPT_DCR = "true";
    console.error("PiLink will now try automatic router setup. It can take up to 15 seconds; unsupported routers fall back to manual instructions.");
    return;
  }
  if (automatic !== "n" && automatic !== "no") throw new Error("Direct nip.io hosting cancelled.");
  await configureManualNipIoHosting();
}

async function configureManualNipIoHosting(): Promise<void> {
  console.error("\n=== Manual direct nip.io requirements ===");
  console.error("1. Your ISP must give this machine a reachable public IPv4 address (not CGNAT).");
  console.error("2. Reserve this computer's LAN address in your router so port forwarding stays correct.");
  console.error(`3. In your router, forward public TCP port 80 to this computer's TCP port ${DIRECT_HTTP_PORT}.`);
  console.error(`4. In your router, forward public TCP port 443 to this computer's TCP port ${DIRECT_HTTPS_PORT}.`);
  console.error("5. If firewalld is active, allow TCP 8080 and 8443 with the commands shown above.");
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const confirmation = (await readline.question("Type DIRECT after completing the router configuration: ")).trim();
  if (confirmation !== "DIRECT") {
    readline.close();
    throw new Error("Direct nip.io hosting cancelled.");
  }
  readline.close();
  const configuredPublicIp = process.env.PI_PUBLIC_IPV4?.trim();
  if (configuredPublicIp && !isPublicIpv4(configuredPublicIp)) throw new Error("PI_PUBLIC_IPV4 must be a reachable public IPv4 address.");
  console.error("Detecting the public IPv4 address...");
  const publicIp = configuredPublicIp || await discoverPublicIpv4();
  const hostname = `pilink-${publicIp.replaceAll(".", "-")}.nip.io`;
  saveConfig({
    PI_HOSTING_MODE: "nip-io",
    PI_NIP_IO_NETWORK: "manual",
    PI_NIP_IO_HOSTNAME: hostname,
    SERVER_URL: `https://${hostname}`,
    PI_OAUTH_PUBLIC_CHATGPT_DCR: "true",
  });
  process.env.PI_HOSTING_MODE = "nip-io";
  process.env.PI_NIP_IO_NETWORK = "manual";
  process.env.PI_NIP_IO_HOSTNAME = hostname;
  process.env.SERVER_URL = `https://${hostname}`;
  process.env.PI_OAUTH_PUBLIC_CHATGPT_DCR = "true";
  console.error(`PiLink will use the persistent address: https://${hostname}`);
}

async function startNipIo(unsafe: boolean, forceSetup: boolean): Promise<void> {
  loadEnvironment();
  let hostname = process.env.PI_NIP_IO_HOSTNAME || "";
  let portMappings: ManagedPortMappings | undefined;
  const networkMode = process.env.PI_NIP_IO_NETWORK || "manual";
  if (networkMode !== "auto" && networkMode !== "manual") {
    console.error("PI_NIP_IO_NETWORK must be 'auto' or 'manual'.");
    process.exitCode = 1;
    return;
  }
  if (networkMode === "auto") {
    try {
      console.error("Requesting temporary router port mappings through UPnP or NAT-PMP...");
      portMappings = await openAutomaticPortMappings();
      hostname = `pilink-${portMappings.publicIp.replaceAll(".", "-")}.nip.io`;
      saveConfig({ PI_NIP_IO_HOSTNAME: hostname, SERVER_URL: `https://${hostname}` });
      process.env.PI_NIP_IO_HOSTNAME = hostname;
      process.env.SERVER_URL = `https://${hostname}`;
      console.error(`Router mappings active. Public address: https://${hostname}`);
    } catch (error) {
      if (error instanceof DirectNetworkError && !error.canUseManualFallback) {
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
      console.error(`Automatic router setup failed: ${error instanceof Error ? error.message : "unknown error"}`);
      console.error("PiLink will use manual router configuration instead.");
      try {
        await configureManualNipIoHosting();
        hostname = process.env.PI_NIP_IO_HOSTNAME || "";
      } catch (manualError) {
        console.error(manualError instanceof Error ? manualError.message : "Direct nip.io hosting cancelled.");
        process.exitCode = 1;
        return;
      }
    }
  }
  if (!hostname.endsWith(".nip.io") || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(hostname)) {
    console.error("PI_NIP_IO_HOSTNAME must be a valid .nip.io hostname. Run 'pilink reset --yes --start' to choose hosting again.");
    process.exitCode = 1;
    return;
  }
  const port = readPort();
  let caddy: ChildProcess;
  let certificateReady: Promise<boolean>;
  try {
    ({ process: caddy, certificateReady } = await startCaddy(hostname, port));
  } catch (error) {
    await portMappings?.release().catch(() => undefined);
    console.error(error instanceof Error ? error.message : "Unable to start Caddy");
    process.exitCode = 1;
    return;
  }
  const serverUrl = `https://${hostname}`;
  printNipIoStartupInstructions(serverUrl, Boolean(portMappings));
  const startedServer = startServer(unsafe, serverUrl, caddy);
  const server = startedServer.process;
  let shuttingDown = false;
  let caddyRunning = true;
  let mappingsReleased = false;
  const releaseMappings = () => {
    if (mappingsReleased) return;
    mappingsReleased = true;
    void portMappings?.release().catch((error: unknown) => {
      console.error(`Could not remove automatic router mappings: ${error instanceof Error ? error.message : "unknown error"}`);
    });
  };
  process.once("SIGINT", releaseMappings);
  process.once("SIGTERM", releaseMappings);
  caddy.on("error", (error: NodeJS.ErrnoException) => {
    caddyRunning = false;
    releaseMappings();
    console.error(`Unable to start Caddy: ${error.message}`);
    server.kill("SIGINT");
    process.exitCode = 1;
  });
  caddy.on("exit", (code) => {
    caddyRunning = false;
    releaseMappings();
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Caddy exited (${code ?? "signal"}); stopping PiLink.`);
    server.kill("SIGINT");
    process.exitCode = code === 0 ? 0 : 1;
  });
  const setup = Promise.all([startedServer.ready, certificateReady]).then(([serverReady, certificateObtained]) => {
    if (serverReady && certificateObtained && caddyRunning) return runFirstTimeSetup(serverUrl, forceSetup);
  });
  armChatCliAutoLaunch(startedServer, setup);
}

function printCloudflareNamedStartupInstructions(serverUrl: string): void {
  console.error("\n=== Cloudflare fixed domain started ===");
  console.error(`1. Your persistent public address is: ${serverUrl}`);
  console.error(`2. Use this MCP server URL in ChatGPT: ${serverUrl}/sse`);
  console.error("3. Keep the Cloudflare Published application route pointed at this PiLink instance.");
  console.error("4. This URL remains the same across ordinary PiLink restarts, so an existing ChatGPT connector and OAuth client can be reused.");
}

function printQuickTunnelStartupInstructions(serverUrl: string): void {
  console.error("\n=== Cloudflare Quick Tunnel started ===");
  console.error(`1. Keep this terminal open. Your current public address is: ${serverUrl}`);
  console.error(`2. Use this MCP server URL in ChatGPT: ${serverUrl}/sse`);
  console.error("3. Continue with the ChatGPT OAuth setup below.");
  console.error("Important: this Quick Tunnel URL changes every restart, so ChatGPT needs a new connector and OAuth client each time.");
}

function printNipIoStartupInstructions(serverUrl: string, automaticMappings: boolean): void {
  console.error("\n=== Direct nip.io hosting started ===");
  console.error(`1. Keep this terminal open. Your persistent public address is: ${serverUrl}`);
  if (automaticMappings) {
    console.error("2. Automatic router mappings are active and will be removed when PiLink stops.");
  } else {
    console.error(`2. Keep your manual router forwarding active: public TCP 80 → local ${DIRECT_HTTP_PORT}; public TCP 443 → local ${DIRECT_HTTPS_PORT}.`);
  }
  console.error("3. Wait for Caddy to report that it obtained a public TLS certificate before connecting ChatGPT.");
  console.error(`4. Then use this MCP server URL in ChatGPT: ${serverUrl}/sse`);
}

async function runFirstTimeSetup(serverUrl: string, forceSetup: boolean, allowAdditionalClient = false): Promise<void> {
  let retryCommand = allowAdditionalClient ? "pilink start" : "pilink start --setup";
  try {
    loadEnvironment();
    const runtimeConfig = loadRuntimeConfig();
    const clients = loadClients();
    if (clients.length === 0) retryCommand = "pilink start";
    if (!forceSetup && clients.length > 0 && !allowAdditionalClient) {
      console.error("An OAuth client is already configured. Use 'pilink start --setup' to register another client.");
      return;
    }

    if (runtimeConfig.oauthConsentMode === "paired" && runtimeConfig.publicChatGptDcr) {
      const externallyManagedPairing = process.env.PILINK_OAUTH_SETUP_DRIVER === "vscode";
      const localTerminalApproval = !externallyManagedPairing &&
        process.stdin.isTTY === true && process.stderr.isTTY === true && process.env.CI !== "true";

      if (localTerminalApproval) {
        // Open only the short DCR registration window. The pairing URL/code are
        // deliberately kept local and unused; the exact PKCE authorization is
        // approved in the terminal by oauth-local-approval.ts.
        await requestOwnerPairing(
          runtimeConfig.port,
          runtimeConfig.bootstrapSecret,
          serverUrl,
        );
        printChatGptDcrSetupInstructions(serverUrl, true);
        console.error("Waiting for ChatGPT. PiLink will ask here before granting access.\n");
        return;
      }

      if (externallyManagedPairing) {
        printChatGptDcrSetupInstructions(serverUrl, false);
        console.error("VSPiLink will handle its local-owner verification flow.\n");
        return;
      }

      // Headless/redirected launches cannot answer the local y/N prompt. Keep
      // the established browser pairing fallback instead of weakening consent.
      const ownerPairing = await requestOwnerPairing(
        runtimeConfig.port,
        runtimeConfig.bootstrapSecret,
        serverUrl,
      );
      printChatGptDcrSetupInstructions(serverUrl, false);
      openOwnerPairing(ownerPairing);
      console.error("Back in ChatGPT, save/connect the MCP URL and choose Dynamic Client Registration (DCR) if prompted.");
      console.error("PiLink accepts that secretless PKCE registration only during this short owner-opened setup window.");
      console.error("After verifying this computer in the browser, complete the PiLink OAuth approval in ChatGPT.\n");
      return;
    }

    printChatGptSetupInstructions(serverUrl);
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    let callbackUrl: string;
    try {
      waitingForSetupCallback = true;
      console.error("\nPaste callback URL here:");
      callbackUrl = (await readline.question("> ")).trim();
    } finally {
      waitingForSetupCallback = false;
      readline.close();
      flushDeferredServerOutput();
    }
    if (!callbackUrl) {
      console.error(`ChatGPT client registration skipped. Restart with '${retryCommand}' when you have the callback URL.`);
      return;
    }
    assertHttpUrl(callbackUrl, "callback URL");
    const ownerPairing = runtimeConfig.oauthConsentMode === "paired"
      ? await requestOwnerPairing(runtimeConfig.port, runtimeConfig.bootstrapSecret, serverUrl)
      : undefined;
    const { client, client_secret: clientSecret } = await registerClient(
      "ChatGPT",
      [callbackUrl],
      ["authorization_code", "refresh_token"],
      "mcp:tools offline_access",
    );
    console.error("\nChatGPT OAuth client registered. Copy these values into ChatGPT now; the secret is shown only once.");
    console.error(`Client ID: ${client.client_id}`);
    console.error(`Client secret: ${clientSecret}`);
    console.error("Token endpoint auth method: client_secret_post");
    console.error(`Authorization URL: ${serverUrl}/oauth/authorize`);
    console.error(`Token URL: ${serverUrl}/oauth/token`);
    console.error("Scope: mcp:tools offline_access");
    if (ownerPairing) openOwnerPairing(ownerPairing);
    console.error("Back in ChatGPT, click Scan Tools, complete the PiLink OAuth approval, and wait for the scan to finish.\n");
  } catch (error) {
    console.error(`First-time ChatGPT setup could not complete: ${error instanceof Error ? error.message : "unknown error"}`);
    console.error(`The MCP server is still running. Restart with '${retryCommand}' to try again.`);
  }
}

interface CliOwnerPairing {
  pairingUrl: string;
  verificationCode: string;
  expiresAt: string;
}

async function requestOwnerPairing(
  port: number,
  bootstrapSecret: string,
  expectedServerUrl: string,
): Promise<CliOwnerPairing> {
  const response = await fetch(`http://127.0.0.1:${port}/admin/oauth/pairing`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bootstrapSecret}`,
      accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Owner pairing request failed (HTTP ${response.status})`);
  if (Buffer.byteLength(body, "utf8") > 16 * 1024) throw new Error("Owner pairing response is too large");

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Owner pairing response is invalid");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Owner pairing response is invalid");
  }
  const pairingUrl = (payload as Record<string, unknown>).pairing_url;
  const verificationCode = (payload as Record<string, unknown>).verification_code;
  const expiresAt = (payload as Record<string, unknown>).expires_at;
  if (
    typeof pairingUrl !== "string" ||
    typeof verificationCode !== "string" ||
    !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u.test(verificationCode) ||
    typeof expiresAt !== "string"
  ) {
    throw new Error("Owner pairing response is invalid");
  }
  validateOwnerPairingUrl(pairingUrl, expectedServerUrl, expiresAt);
  return { pairingUrl, verificationCode, expiresAt };
}

function validateOwnerPairingUrl(pairingUrl: string, expectedServerUrl: string, expiresAt: string): void {
  let pairing: URL;
  let expected: URL;
  try {
    pairing = new URL(pairingUrl);
    expected = new URL(expectedServerUrl);
  } catch {
    throw new Error("Owner pairing URL is invalid");
  }
  if (
    pairing.protocol !== expected.protocol || pairing.origin !== expected.origin || pairing.pathname !== "/oauth/pair" ||
    pairing.username || pairing.password || pairing.hash ||
    [...pairing.searchParams.keys()].some((key) => key !== "code") ||
    !/^[A-Za-z0-9_-]{20,512}$/.test(pairing.searchParams.get("code") || "")
  ) {
    throw new Error("Owner pairing URL does not match the configured PiLink server");
  }
  const expiration = Date.parse(expiresAt);
  if (!Number.isFinite(expiration) || expiration <= Date.now()) throw new Error("Owner pairing URL is already expired");
}

function openOwnerPairing(pairing: CliOwnerPairing): void {
  console.error("Open this one-use owner pairing URL in the same browser where you use ChatGPT:");
  console.error(pairing.pairingUrl);
  console.error(`Local verification code: ${pairing.verificationCode}`);
  console.error("The URL alone cannot authorize this computer; the browser must also receive the code shown only by this local PiLink process.");
  if (!shouldOpenBrowser()) {
    console.error("Automatic browser opening is disabled for this non-interactive session. Open the URL printed above manually and enter the local verification code.");
    return;
  }
  const opener = process.platform === "win32"
    ? { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", pairing.pairingUrl] }
    : process.platform === "darwin"
      ? { command: "open", args: [pairing.pairingUrl] }
      : { command: "xdg-open", args: [pairing.pairingUrl] };
  const opened = spawnSync(opener.command, opener.args, {
    stdio: "ignore",
    timeout: 10_000,
    windowsHide: true,
  }).status === 0;
  if (opened) {
    console.error("PiLink opened the owner pairing page. Enter the local verification code there before continuing in ChatGPT.");
    return;
  }
  console.error("PiLink could not open the owner pairing page automatically.");
  console.error("Open the URL printed above manually, enter the local verification code, then return to ChatGPT.");
}

function shouldOpenBrowser(): boolean {
  const configured = process.env.PI_BROWSER_OPEN?.trim().toLowerCase();
  if (configured === "always") return true;
  if (configured === "never") return false;
  if (configured && configured !== "auto") {
    console.error("PI_BROWSER_OPEN is invalid; automatic browser opening is disabled. Use auto, always, or never.");
    return false;
  }
  return process.stdin.isTTY === true && process.env.CI !== "true";
}

function printChatGptDcrSetupInstructions(serverUrl: string, localTerminalApproval: boolean): void {
  if (localTerminalApproval) {
    console.error("\n=== Connect ChatGPT ===");
    console.error("1. In ChatGPT, add an MCP connection.");
    console.error(`2. Set the MCP server URL to: ${serverUrl}/sse`);
    console.error("3. Select Authentication: OAuth.");
    console.error("4. Select Dynamic Client Registration (DCR) if asked.");
    return;
  }

  console.error("\n=== First-time ChatGPT setup (safe DCR) ===");
  console.error("1. In ChatGPT, open Settings → Apps/Connectors (or your MCP connections page) → Add connection.");
  console.error(`2. Set the connection/MCP server URL to: ${serverUrl}/sse`);
  console.error("3. Select Authentication: OAuth.");
  console.error("4. Select Dynamic Client Registration (DCR) if ChatGPT asks for a registration method.");
}

function printChatGptSetupInstructions(serverUrl: string): void {
  console.error("\n=== First-time ChatGPT setup (manual OAuth fallback) ===");
  console.error("1. In ChatGPT, open Settings → Apps/Connectors (or your MCP connections page) → Add connection.");
  console.error(`2. Set the connection/MCP server URL to: ${serverUrl}/sse`);
  console.error("3. Select Authentication: OAuth.");
  console.error("4. Only if DCR is unavailable, open Advanced OAuth settings and select Registration method: User defined.");
  console.error("5. Copy ChatGPT's callback URL and paste it below. PiLink will create and print the client ID and secret.");
}

function assertHttpUrl(value: string, label: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new Error(`The ${label} must be an absolute http(s) URL`);
  }
}

interface VerifiedDownloadSource {
  url: string;
  sha256: string;
}

async function downloadFileWithFallback(sources: VerifiedDownloadSource[], destination: string, label: string): Promise<void> {
  const destinationDirectory = ensurePrivateManagedDirectory(path.dirname(destination));

  let lastError: Error | undefined;

  for (const source of sources) {
    const temporaryDirectory = fs.mkdtempSync(path.join(destinationDirectory, ".vspilink-download-"));
    fs.chmodSync(temporaryDirectory, 0o700);
    const temporary = path.join(temporaryDirectory, "payload");
    const url = source.url;
    assertHttpUrl(url, `${label} download URL`);
    const expectedSha256 = normalizedSha256(source.sha256, `${label} SHA-256`);
    try {
      await fetchVerifiedDownload(url, temporary, expectedSha256, label);
      replaceManagedFile(temporary, destination);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }

  throw new Error(`Could not install ${label} automatically: ${lastError ? lastError.message : "download failed"}`);
}

async function fetchVerifiedDownload(
  initialUrl: string,
  destination: string,
  expectedSha256: string,
  label: string,
): Promise<void> {
  let current = new URL(initialUrl);
  const loopbackDevelopmentDownload = current.protocol === "http:" && isLoopbackDownloadHost(current.hostname);
  if (current.protocol !== "https:" && !loopbackDevelopmentDownload) {
    throw new Error("binary downloads must use HTTPS; plain HTTP is accepted only from loopback for local tests");
  }
  const signal = AbortSignal.timeout(600_000);

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("download redirect did not include a destination");
      }
      const next = new URL(location, current);
      const permitted = next.protocol === "https:" ||
        (loopbackDevelopmentDownload && next.protocol === "http:" && isLoopbackDownloadHost(next.hostname));
      await response.body?.cancel().catch(() => undefined);
      if (!permitted) throw new Error("download redirect attempted to leave the verified HTTPS boundary");
      current = next;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP download failed (${response.status})`);
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && /^\d+$/.test(declaredLength) && BigInt(declaredLength) > BigInt(MAX_VERIFIED_BINARY_DOWNLOAD_BYTES)) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`${label} download exceeds the ${MAX_VERIFIED_BINARY_DOWNLOAD_BYTES / (1024 * 1024)} MiB safety limit`);
    }

    const hash = crypto.createHash("sha256");
    let receivedBytes = 0;
    const verifier = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_VERIFIED_BINARY_DOWNLOAD_BYTES) {
          callback(new Error(`${label} download exceeds the ${MAX_VERIFIED_BINARY_DOWNLOAD_BYTES / (1024 * 1024)} MiB safety limit`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      verifier,
      fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
    if (receivedBytes === 0) throw new Error(`${label} download was empty`);
    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error(`${label} download failed SHA-256 verification`);
    }
    fs.chmodSync(destination, 0o700);
    return;
  }
  throw new Error("download exceeded the maximum redirect count");
}

function ensurePrivateManagedDirectory(directory: string): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Managed binary directory must be a real directory: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
  return directory;
}

function replaceManagedFile(source: string, destination: string): void {
  try {
    const existing = fs.lstatSync(destination);
    if (existing.isDirectory()) throw new Error(`Managed binary destination is a directory: ${destination}`);
    fs.rmSync(destination, { force: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  fs.renameSync(source, destination);
}

function isLoopbackDownloadHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function normalizedSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be exactly 64 hexadecimal characters`);
  return normalized;
}

async function sha256RegularFile(file: string, label: string): Promise<string> {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) {
    throw new Error(`${label} must be a non-empty regular file`);
  }
  if (stat.size > MAX_VERIFIED_BINARY_DOWNLOAD_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_VERIFIED_BINARY_DOWNLOAD_BYTES / (1024 * 1024)} MiB safety limit`);
  }
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function isVerifiedManagedFile(file: string, expectedSha256: string): Promise<boolean> {
  try {
    return await sha256RegularFile(file, "Cached managed binary") === expectedSha256;
  } catch {
    return false;
  }
}

function customOrPinnedDownload(
  label: string,
  customUrl: string | undefined,
  customSha256: string | undefined,
  pinnedUrl: string,
  pinnedSha256: string,
): VerifiedDownloadSource {
  const url = customUrl?.trim();
  const sha256 = customSha256?.trim();
  if (url || sha256) {
    if (!url || !sha256) {
      throw new Error(`${label} overrides require both the download URL and its SHA-256 digest`);
    }
    return { url, sha256: normalizedSha256(sha256, `${label} SHA-256`) };
  }
  return { url: pinnedUrl, sha256: pinnedSha256 };
}

async function ensureCloudflared(): Promise<string> {
  const configuredPath = process.env.PI_CLOUDFLARED_PATH;
  if (configuredPath) {
    if (canRun(configuredPath)) return configuredPath;
    throw new Error(`PI_CLOUDFLARED_PATH is not executable: ${configuredPath}`);
  }
  if (canRun("cloudflared")) return "cloudflared";

  const destination = path.join(path.dirname(configPath), "bin", cloudflaredFileName());
  const release = process.platform === "linux"
    ? {
        asset: cloudflaredAsset(),
        sha256: CLOUDFLARED_LINUX_SHA256[supportedLinuxArchitecture("cloudflared")],
      }
    : resolveCloudflaredRelease();
  const { asset } = release;
  const source = customOrPinnedDownload(
    "cloudflared",
    process.env.PI_CLOUDFLARED_URL,
    process.env.PI_CLOUDFLARED_SHA256,
    `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`,
    release.sha256,
  );
  if (await isVerifiedManagedFile(destination, source.sha256) && canRun(destination)) return destination;
  console.error(`cloudflared is not installed; downloading verified cloudflared ${CLOUDFLARED_VERSION} (${asset}) for this first launch...`);

  try {
    await downloadFileWithFallback([source], destination, asset);
  } catch (error) {
    throw new Error(
      `Could not install cloudflared automatically: ${error instanceof Error ? error.message : "unknown error"}. ` +
      `Install cloudflared manually (e.g. from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and set PI_CLOUDFLARED_PATH if needed.`
    );
  }

  if (!await isVerifiedManagedFile(destination, source.sha256) || !canRun(destination)) {
    fs.rmSync(destination, { force: true });
    throw new Error("Downloaded cloudflared did not run successfully. Install it manually from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
  }
  return destination;
}

async function startCaddy(hostname: string, port: number): Promise<{ process: ChildProcess; certificateReady: Promise<boolean> }> {
  const executable = await ensureCaddy();
  const configDirectory = path.dirname(configPath);
  const caddyfilePath = path.join(configDirectory, "Caddyfile");
  const caddyfile = [
    "{",
    "  admin off",
    "  persist_config off",
    `  http_port ${DIRECT_HTTP_PORT}`,
    `  https_port ${DIRECT_HTTPS_PORT}`,
    "}",
    "",
    `https://${hostname} {`,
    `  reverse_proxy 127.0.0.1:${port}`,
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(caddyfilePath, caddyfile, { mode: 0o600 });
  fs.chmodSync(caddyfilePath, 0o600);
  const caddy = spawn(executable, ["run", "--config", caddyfilePath, "--adapter", "caddyfile"], {
    env: { ...process.env, XDG_DATA_HOME: configDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let certificateVerified = false;
  let resolveCertificate: (obtained: boolean) => void;
  const certificateReady = new Promise<boolean>((resolve) => {
    resolveCertificate = resolve;
  });
  let certificateSettled = false;
  let retry: NodeJS.Timeout | undefined;
  const settleCertificate = (obtained: boolean) => {
    if (certificateSettled) return;
    certificateSettled = true;
    if (retry) clearTimeout(retry);
    if (obtained && !certificateVerified) {
      certificateVerified = true;
      writeServerOutput("[PiLink] Caddy obtained a public TLS certificate; external HTTP reachability was verified by ACME.\n");
    }
    resolveCertificate(obtained);
  };
  const verifyCachedCertificate = () => {
    if (certificateSettled) return;
    const retryVerification = () => {
      if (certificateSettled || retry) return;
      retry = setTimeout(() => {
        retry = undefined;
        verifyCachedCertificate();
      }, 500);
    };
    const request = https.get({
      hostname,
      port: DIRECT_HTTPS_PORT,
      path: "/health",
      lookup: (_name, _options, callback) => callback(null, "127.0.0.1", 4),
      timeout: 2_000,
    }, (response) => {
      response.resume();
      settleCertificate(true);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", retryVerification);
    request.on("close", retryVerification);
  };
  const forwardCaddyOutput = (chunk: Buffer) => {
    const output = chunk.toString();
    writeServerOutput(output);
    if (output.includes("certificate obtained successfully")) settleCertificate(true);
  };
  caddy.stdout?.on("data", forwardCaddyOutput);
  caddy.stderr?.on("data", forwardCaddyOutput);
  caddy.once("error", () => settleCertificate(false));
  caddy.once("exit", () => settleCertificate(false));
  verifyCachedCertificate();
  return { process: caddy, certificateReady };
}

async function ensureCaddy(): Promise<string> {
  const configuredPath = process.env.PI_CADDY_PATH;
  if (configuredPath) {
    if (canRun(configuredPath)) return configuredPath;
    throw new Error(`PI_CADDY_PATH is not executable: ${configuredPath}`);
  }
  if (canRun("caddy")) return "caddy";

  if (process.platform !== "linux") {
    throw new Error("Caddy is required for direct nip.io HTTPS hosting. Install Caddy and set PI_CADDY_PATH to its executable.");
  }
  const nodeArchitecture = supportedLinuxArchitecture("Caddy");
  const architecture = nodeArchitecture === "x64" ? "amd64" : "arm64";
  const destination = path.join(path.dirname(configPath), "bin", caddyFileName());
  const verificationMetadataPath = `${destination}.verified.json`;
  const archiveName = `caddy_${CADDY_VERSION}_linux_${architecture}.tar.gz`;
  const customSource = Boolean(process.env.PI_CADDY_URL?.trim() || process.env.PI_CADDY_SHA256?.trim());
  const source = customOrPinnedDownload(
    "Caddy",
    process.env.PI_CADDY_URL,
    process.env.PI_CADDY_SHA256,
    `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${archiveName}`,
    CADDY_LINUX_ARCHIVE_SHA256[nodeArchitecture],
  );
  if (await isVerifiedCaddyCache(
    destination,
    verificationMetadataPath,
    source.sha256,
    customSource ? undefined : CADDY_LINUX_BINARY_SHA256[nodeArchitecture],
  ) && canRun(destination)) return destination;

  const binaryDirectory = ensurePrivateManagedDirectory(path.dirname(destination));
  const installationDirectory = fs.mkdtempSync(path.join(binaryDirectory, ".caddy-install-"));
  fs.chmodSync(installationDirectory, 0o700);
  const archivePath = path.join(installationDirectory, archiveName);
  const extractionDirectory = path.join(installationDirectory, "extracted");
  fs.mkdirSync(extractionDirectory, { mode: 0o700 });
  console.error(`Caddy is not installed; downloading verified Caddy ${CADDY_VERSION} for Linux ${architecture}...`);

  try {
    await downloadFileWithFallback([source], archivePath, `Caddy ${CADDY_VERSION} archive (${architecture})`);
    const extraction = spawnSync("tar", ["-xzf", archivePath, "-C", extractionDirectory, "caddy"], {
      stdio: "ignore",
      timeout: 120_000,
    });
    const extracted = path.join(extractionDirectory, "caddy");
    if (extraction.error || extraction.signal || extraction.status !== 0 || !fs.existsSync(extracted) || !fs.lstatSync(extracted).isFile()) {
      throw new Error("the verified archive could not be extracted safely; install Caddy manually and set PI_CADDY_PATH");
    }
    const extractedSha256 = await sha256RegularFile(extracted, "Extracted Caddy binary");
    const pinnedBinarySha256 = customSource ? undefined : CADDY_LINUX_BINARY_SHA256[nodeArchitecture];
    if (pinnedBinarySha256 && extractedSha256 !== pinnedBinarySha256) {
      throw new Error("the extracted Caddy binary did not match the pinned release digest");
    }
    fs.chmodSync(extracted, 0o700);
    replaceManagedFile(extracted, destination);
    if (customSource) {
      const metadataTemporary = path.join(installationDirectory, "verified.json");
      fs.writeFileSync(metadataTemporary, `${JSON.stringify({
        sourceSha256: source.sha256,
        binarySha256: extractedSha256,
      })}\n`, { flag: "wx", mode: 0o600 });
      replaceManagedFile(metadataTemporary, verificationMetadataPath);
    } else {
      fs.rmSync(verificationMetadataPath, { force: true });
    }
  } catch (error) {
    throw new Error(`Could not install Caddy automatically: ${error instanceof Error ? error.message : "unknown error"}`);
  } finally {
    fs.rmSync(installationDirectory, { recursive: true, force: true });
  }

  if (!await isVerifiedCaddyCache(
    destination,
    verificationMetadataPath,
    source.sha256,
    customSource ? undefined : CADDY_LINUX_BINARY_SHA256[nodeArchitecture],
  ) || !canRun(destination)) {
    fs.rmSync(destination, { force: true });
    fs.rmSync(verificationMetadataPath, { force: true });
    throw new Error("Downloaded Caddy did not run successfully. Install it manually and set PI_CADDY_PATH.");
  }
  return destination;
}

async function isVerifiedCaddyCache(
  executable: string,
  metadataPath: string,
  sourceSha256: string,
  pinnedBinarySha256?: string,
): Promise<boolean> {
  try {
    if (pinnedBinarySha256) return await isVerifiedManagedFile(executable, pinnedBinarySha256);
    const metadataStat = fs.lstatSync(metadataPath);
    if (metadataStat.isSymbolicLink() || !metadataStat.isFile() || metadataStat.size > 4096) return false;
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      sourceSha256?: unknown;
      binarySha256?: unknown;
    };
    if (metadata.sourceSha256 !== sourceSha256 || typeof metadata.binarySha256 !== "string") return false;
    const expectedBinarySha256 = normalizedSha256(metadata.binarySha256, "Cached Caddy SHA-256");
    return await isVerifiedManagedFile(executable, expectedBinarySha256);
  } catch {
    return false;
  }
}

function cloudflaredAsset(): string {
  const architecture = supportedLinuxArchitecture("cloudflared") === "x64" ? "amd64" : "arm64";
  return `cloudflared-linux-${architecture}`;
}

function supportedLinuxArchitecture(label: string): "x64" | "arm64" {
  if (process.arch === "x64" || process.arch === "arm64") return process.arch;
  throw new Error(`Automatic ${label} installation is unsupported for architecture '${process.arch}'. Install it manually and configure its explicit path.`);
}

function cloudflaredFileName(): string {
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function caddyFileName(): string {
  return process.platform === "win32" ? "caddy.exe" : "caddy";
}

function canRun(executable: string): boolean {
  const result = spawnSync(executable, ["--version"], {
    stdio: "ignore",
    timeout: BINARY_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  return !result.error && !result.signal && result.status === 0;
}

function startServer(unsafe: boolean, serverUrl?: string, edge?: ChildProcess): StartedServer {
  if (!fs.existsSync(configPath)) initialize();
  loadEnvironment();
  const config = loadRuntimeConfig();
  if (unsafe) console.error("DANGER: full-machine filesystem and shell access is enabled only for the explicitly selected OAuth client IDs.");
  const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");

  let resolveReady: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  let readySettled = false;
  const settleReady = (started: boolean) => {
    if (readySettled) return;
    readySettled = true;
    resolveReady(started);
  };
  let resolveConnected: (connected: boolean) => void;
  const connected = new Promise<boolean>((resolve) => {
    resolveConnected = resolve;
  });
  let connectedSettled = false;
  const settleConnected = (value: boolean) => {
    if (connectedSettled) return;
    connectedSettled = true;
    resolveConnected(value);
  };

  const server = spawn(process.execPath, [indexPath], {
    env: {
      ...process.env,
      PILINK_CONFIG: configPath,
      HOST: "127.0.0.1",
      PI_DATA_DIR: config.dataDir,
      PI_COORDINATION_DATA_DIR: config.coordinationDataDir,
      ...(serverUrl ? { SERVER_URL: serverUrl } : {}),
      ...(unsafe ? {
        PI_UNSAFE_FULL_ACCESS: "true",
        PI_FULL_ACCESS_CLIENT_IDS: process.env.PI_FULL_ACCESS_CLIENT_IDS || "*",
      } : {}),
      PI_LAUNCH_EVENT_FD: "3",
    },
    stdio: ["inherit", "inherit", "pipe", "pipe"],
  });

  const eventStream = server.stdio[3] as NodeJS.ReadableStream | null;
  let eventBuffer = "";
  eventStream?.on("data", (chunk: Buffer) => {
    eventBuffer += chunk.toString("utf8");
    while (true) {
      const newline = eventBuffer.indexOf("\n");
      if (newline === -1) break;
      const event = eventBuffer.slice(0, newline).trim();
      eventBuffer = eventBuffer.slice(newline + 1);
      if (event === "mcp-connected") settleConnected(true);
    }
  });

  let stderrBuffer = "";
  server.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    writeServerOutput(text);
    stderrBuffer += text;
    if (stderrBuffer.includes("╚══════════════════════════════════════════════════╝")) {
      settleReady(true);
    }
  });

  const shutdown = () => {
    chatCliProcess?.kill("SIGTERM");
    server.kill("SIGINT");
    edge?.kill("SIGTERM");
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.on("exit", (code) => {
    settleReady(false);
    settleConnected(false);
    edge?.kill("SIGTERM");
    process.exitCode = code ?? 1;
  });
  return { process: server, ready, connected, config };
}

function saveConfig(values: Record<string, string>): void {
  const existing = fs.readFileSync(configPath, "utf8");
  const lines = existing.split("\n");
  for (const [name, value] of Object.entries(values)) {
    if (/\r|\n/.test(value)) throw new Error(`Invalid configuration value for ${name}`);
    const index = lines.findIndex((line) => line.startsWith(`${name}=`));
    const entry = `${name}=${value}`;
    if (index === -1) lines.push(entry);
    else lines[index] = entry;
  }
  fs.writeFileSync(configPath, lines.join("\n"), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
}

function writeServerOutput(output: string): void {
  if (chatCliActive) return;
  if (waitingForSetupCallback) {
    const remaining = MAX_DEFERRED_SERVER_OUTPUT - deferredServerOutput.length;
    if (remaining > 0) deferredServerOutput += output.slice(0, remaining);
    if (output.length > remaining) deferredServerOutputTruncated = true;
  } else {
    process.stderr.write(output);
  }
}

function flushDeferredServerOutput(): void {
  if (deferredServerOutput) process.stderr.write(deferredServerOutput);
  if (deferredServerOutputTruncated) {
    process.stderr.write("[PiLink] Some server output was omitted while waiting for the callback URL.\n");
  }
  deferredServerOutput = "";
  deferredServerOutputTruncated = false;
}

function readPort(): number {
  const environmentPort = Number(process.env.PORT);
  if (Number.isSafeInteger(environmentPort) && environmentPort > 0 && environmentPort <= 65535) return environmentPort;
  return readPortFromConfig(configPath);
}

function readPortFromConfig(configFile: string): number {
  if (!fs.existsSync(configFile)) return 3200;
  const match = fs.readFileSync(configFile, "utf8").match(/^PORT=(\d+)$/m);
  return match ? parsePort(match[1]) : 3200;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid port: ${value}`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid port: ${value}`);
  return port;
}

function nextSeparatePort(existingPort: number): number {
  return existingPort < 65535 ? existingPort + 1 : 3200;
}

function nextSeparateConfigDirectory(existingDirectory: string): string {
  let suffix = 2;
  let candidate = `${existingDirectory}-${suffix}`;
  while (fs.existsSync(candidate)) {
    suffix += 1;
    candidate = `${existingDirectory}-${suffix}`;
  }
  return candidate;
}

function secret(): string {
  return crypto.randomBytes(32).toString("base64url");
}
