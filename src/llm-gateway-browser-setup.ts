import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { defaultConfigPath } from "./config.js";

const BUILT_EXTENSION = path.join(path.dirname(fileURLToPath(import.meta.url)), "browser-extension");
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function stageGatewayBrowserExtension(options: {
  source?: string;
  destination?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const env = options.env ?? process.env;
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  const destination = path.resolve(options.destination ?? path.join(dataHome, "pilink", "browser-extension"));
  const source = path.resolve(options.source ?? BUILT_EXTENSION);
  if (fs.existsSync(destination) && (fs.lstatSync(destination).isSymbolicLink() || !fs.lstatSync(destination).isDirectory())) {
    throw new Error("Browser extension destination must be a normal directory, not a symlink");
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")) as {
    manifest_version?: number;
    permissions?: unknown;
    host_permissions?: unknown;
    content_scripts?: Array<{ matches?: string[]; js?: string[] }>;
  };
  if (manifest.manifest_version !== 3 || manifest.permissions || manifest.host_permissions ||
      manifest.content_scripts?.length !== 1 || manifest.content_scripts[0].matches?.join() !== "https://chatgpt.com/*" ||
      manifest.content_scripts[0].js?.join() !== "wake.js") {
    throw new Error("Refusing an unexpected Chrome/Brave wake extension manifest");
  }
  const script = fs.readFileSync(path.join(source, "wake.js"));
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of ["manifest.json", "wake.js"]) {
    const file = path.join(destination, name);
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile())) {
      throw new Error(`Browser extension destination ${name} is not a normal file`);
    }
  }
  fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(destination, "wake.js"), script, { mode: 0o600 });
  return destination;
}

export function rememberGatewayBrowserExtensionSource(destination: string, sourceRoot = REPOSITORY_ROOT): void {
  const marker = path.join(destination, ".pilink-source.json");
  if (!fs.statSync(destination).isDirectory() ||
      (fs.existsSync(marker) && (!fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink()))) {
    throw new Error("Refusing an unsafe browser extension source marker");
  }
  fs.writeFileSync(marker, JSON.stringify({ source_root: fs.realpathSync(sourceRoot) }) + "\n", { mode: 0o600 });
}

export function enableGatewayBrowserWake(configPath = process.env.PILINK_CONFIG || defaultConfigPath()): void {
  if (!fs.existsSync(configPath) || !fs.lstatSync(configPath).isFile() || fs.lstatSync(configPath).isSymbolicLink()) {
    throw new Error("PiLink .env must be an existing regular private file before enabling browser wake");
  }
  const current = fs.readFileSync(configPath, "utf8");
  const lines = current.split("\n").filter((line) => !line.startsWith("PI_LLM_GATEWAY_AUTO_WAKE="));
  lines.push("PI_LLM_GATEWAY_AUTO_WAKE=true");
  const temporary = path.join(path.dirname(configPath), `.pilink-browser-setup-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(temporary, lines.join("\n"), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, configPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export async function runGatewayBrowserSetup(enable: boolean): Promise<void> {
  const location = stageGatewayBrowserExtension();
  if (enable) {
    enableGatewayBrowserWake();
    rememberGatewayBrowserExtensionSource(location);
    console.error("Browser wake enabled in the PiLink .env. Restart the gateway to apply it.");
    console.error("If the extension is missing or disabled, disable wake with PI_LLM_GATEWAY_AUTO_WAKE=false.");
    return;
  }
  console.error(`Chrome/Brave wake extension prepared at: ${location}`);
  console.error("One-time browser approval is required; npm cannot silently install an unpacked extension in an existing browser profile.");
  console.error("In Brave/Chrome Extensions, enable Developer mode, choose 'Load unpacked', and select the directory above.");
  console.error("After confirming it is enabled, return to this terminal.");
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    console.error("Non-interactive setup: after loading the extension in your browser, run 'pilink gateway browser-extension --enable'.");
    return;
  }
  try {
    const browser = execFileSync("xdg-settings", ["get", "default-web-browser"], { encoding: "utf8", timeout: 1500 }).trim();
    if (browser === "brave-browser.desktop") execFileSync("brave", ["--new-tab", "brave://extensions"], { timeout: 3000, stdio: "ignore" });
    else if (browser === "google-chrome.desktop") execFileSync("google-chrome", ["--new-tab", "chrome://extensions"], { timeout: 3000, stdio: "ignore" });
  } catch {
    console.error("Open brave://extensions or chrome://extensions in your browser if its Extensions page did not open.");
  }
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await readline.question("Is the extension enabled in Chrome/Brave? Type yes to enable auto-wake (yes/no): ")).trim().toLowerCase();
    if (answer !== "yes") {
      console.error("Browser wake remains disabled; re-run setup whenever you are ready.");
      return;
    }
    enableGatewayBrowserWake();
    rememberGatewayBrowserExtensionSource(location);
    console.error("Browser wake enabled. Restart the gateway to apply the new setting.");
  } finally {
    readline.close();
  }
}
