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
  const sourceMarker = path.join(destination, ".pilink-source.json");
  if (fs.existsSync(sourceMarker)) {
    if (!fs.lstatSync(sourceMarker).isFile() || fs.lstatSync(sourceMarker).isSymbolicLink()) {
      throw new Error("Refusing an unsafe browser extension source marker");
    }
    const owner = JSON.parse(fs.readFileSync(sourceMarker, "utf8")) as { source_root?: unknown };
    if (owner.source_root !== fs.realpathSync(REPOSITORY_ROOT)) {
      throw new Error("Refusing to overwrite an extension approved from another PiLink checkout");
    }
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

export function loadedGatewayBrowserExtension(options: {
  destination?: string;
  profileRoot?: string;
  browser?: "brave" | "chrome" | "chromium";
} = {}): boolean {
  if (process.platform !== "linux") return false;
  const destination = path.resolve(options.destination ?? path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "pilink", "browser-extension"));
  const manifestFile = path.join(destination, "manifest.json");
  try {
    if (!fs.statSync(destination).isDirectory() || fs.lstatSync(destination).isSymbolicLink() ||
        !fs.statSync(manifestFile).isFile() || fs.lstatSync(manifestFile).isSymbolicLink()) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      name?: string; manifest_version?: number; permissions?: unknown; host_permissions?: unknown;
      content_scripts?: Array<{ matches?: string[]; js?: string[] }>;
    };
    if (manifest.name !== "Pilink Wake" || manifest.manifest_version !== 3 || manifest.permissions || manifest.host_permissions ||
        manifest.content_scripts?.length !== 1 || manifest.content_scripts[0].matches?.join() !== "https://chatgpt.com/*" ||
        manifest.content_scripts[0].js?.join() !== "wake.js") return false;
    let browser = options.browser;
    if (!browser && !options.profileRoot) {
      const desktop = execFileSync("xdg-settings", ["get", "default-web-browser"], { encoding: "utf8", timeout: 1500 }).trim();
      browser = desktop === "brave-browser.desktop" ? "brave" : desktop === "google-chrome.desktop" ? "chrome" :
        desktop === "chromium.desktop" ? "chromium" : undefined;
    }
    const root = options.profileRoot ?? (browser === "brave"
      ? path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser")
      : browser === "chrome" ? path.join(os.homedir(), ".config", "google-chrome")
        : browser === "chromium" ? path.join(os.homedir(), ".config", "chromium") : undefined);
    if (!root || !fs.statSync(root).isDirectory()) return false;
    const installedPath = fs.realpathSync(destination);
    for (const profile of fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).slice(0, 32)) {
      const preferences = path.join(root, profile.name, "Preferences");
      if (!fs.existsSync(preferences) || fs.lstatSync(preferences).isSymbolicLink() ||
          !fs.statSync(preferences).isFile() || fs.statSync(preferences).size > 8 * 1024 * 1024) continue;
      const settings = (JSON.parse(fs.readFileSync(preferences, "utf8")) as {
        extensions?: { settings?: Record<string, unknown> };
      }).extensions?.settings ?? {};
      for (const candidate of Object.values(settings)) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        const entry = candidate as {
          path?: unknown; location?: unknown; state?: unknown; disable_reasons?: unknown; withholding_permissions?: unknown;
          active_permissions?: { scriptable_host?: unknown };
        };
        if (entry.location !== 4 || typeof entry.path !== "string" || !path.isAbsolute(entry.path) ||
            !fs.existsSync(entry.path) || fs.realpathSync(entry.path) !== installedPath ||
            (entry.state !== undefined && entry.state !== 1) ||
            (entry.disable_reasons !== undefined && entry.disable_reasons !== 0) ||
            entry.withholding_permissions === true ||
            !Array.isArray(entry.active_permissions?.scriptable_host) ||
            entry.active_permissions.scriptable_host.join() !== "https://chatgpt.com/*") continue;
        return true;
      }
    }
  } catch {
    // Unsupported browser layout or concurrently written preferences: ask
    // the user explicitly instead of guessing that an extension is enabled.
  }
  return false;
}

export async function runGatewayBrowserSetup(enable: boolean): Promise<void> {
  const location = stageGatewayBrowserExtension();
  if (!enable && loadedGatewayBrowserExtension({ destination: location })) {
    enableGatewayBrowserWake();
    rememberGatewayBrowserExtensionSource(location);
    console.error("PiLink Wake is already loaded in the default browser. Auto-wake enabled without another confirmation; the running gateway applies it within a few seconds.");
    return;
  }
  if (enable) {
    enableGatewayBrowserWake();
    rememberGatewayBrowserExtensionSource(location);
    console.error("Browser wake enabled in the private PiLink .env. A running gateway applies it within a few seconds.");
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
    console.error("Browser wake enabled. A running gateway applies it within a few seconds.");
  } finally {
    readline.close();
  }
}
