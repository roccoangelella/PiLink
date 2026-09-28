import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { defaultConfigPath } from "./config.js";
import dotenv from "dotenv";
import { gatewayConnectorName, gatewayWakeText } from "./llm-gateway-wake-name.js";
import { gatewayVisiblePromptOutput } from "./llm-gateway-output.js";

const BUILT_EXTENSION = path.join(path.dirname(fileURLToPath(import.meta.url)), "browser-extension");
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function stageGatewayBrowserExtension(options: {
  source?: string;
  destination?: string;
  env?: NodeJS.ProcessEnv;
  connectorName?: string;
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
    host_permissions?: string[];
    background?: { service_worker?: string };
    content_scripts?: Array<{ matches?: string[]; js?: string[] }>;
  };
  if (manifest.manifest_version !== 3 || manifest.permissions ||
      manifest.host_permissions?.join() !== "http://127.0.0.1/*" ||
      manifest.background?.service_worker !== "background.js" || Object.keys(manifest.background).length !== 1 ||
      manifest.content_scripts?.length !== 1 || manifest.content_scripts[0].matches?.join() !== "https://chatgpt.com/*" ||
      manifest.content_scripts[0].js?.join() !== "wake.js") {
    throw new Error("Refusing an unexpected Chrome/Brave wake extension manifest");
  }
  const template = fs.readFileSync(path.join(source, "wake.js"), "utf8");
  const defaultPhrase = 'const WAKE_TEXT = "@PiLink Gateway wake up";';
  if (template.split(defaultPhrase).length !== 2) throw new Error("Unexpected PiLink wake extension template");
  const script = template.replace(defaultPhrase,
    `const WAKE_TEXT = ${JSON.stringify(gatewayWakeText({ PI_LLM_GATEWAY_CONNECTOR_NAME: options.connectorName }))};`);
  const background = fs.readFileSync(path.join(source, "background.js"), "utf8");
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of ["manifest.json", "wake.js", "background.js"]) {
    const file = path.join(destination, name);
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile())) {
      throw new Error(`Browser extension destination ${name} is not a normal file`);
    }
  }
  const manifestFile = path.join(destination, "manifest.json");
  const scriptFile = path.join(destination, "wake.js");
  const backgroundFile = path.join(destination, "background.js");
  const reloadMarker = path.join(destination, ".pilink-reload-required");
  if (fs.existsSync(reloadMarker) && (!fs.lstatSync(reloadMarker).isFile() || fs.lstatSync(reloadMarker).isSymbolicLink())) {
    throw new Error("Refusing an unsafe browser extension reload marker");
  }
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  const approvedExtensionChanged = fs.existsSync(sourceMarker) && (
    !fs.existsSync(manifestFile) || fs.readFileSync(manifestFile, "utf8") !== manifestText ||
    !fs.existsSync(scriptFile) || fs.readFileSync(scriptFile, "utf8") !== script ||
    !fs.existsSync(backgroundFile) || fs.readFileSync(backgroundFile, "utf8") !== background
  );
  fs.writeFileSync(manifestFile, manifestText, { mode: 0o600 });
  fs.writeFileSync(scriptFile, script, { mode: 0o600 });
  fs.writeFileSync(backgroundFile, background, { mode: 0o600 });
  if (approvedExtensionChanged && !fs.existsSync(reloadMarker)) fs.writeFileSync(reloadMarker, "reload required\n", { flag: "wx", mode: 0o600 });
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
  writeGatewayBrowserWake(true, configPath);
}

export function pauseGatewayBrowserWake(configPath = process.env.PILINK_CONFIG || defaultConfigPath()): void {
  writeGatewayBrowserWake(false, configPath);
}

function writeGatewayBrowserWake(enabled: boolean, configPath: string): void {
  if (!fs.existsSync(configPath) || !fs.lstatSync(configPath).isFile() || fs.lstatSync(configPath).isSymbolicLink()) {
    throw new Error("PiLink .env must be an existing regular private file before enabling browser wake");
  }
  const current = fs.readFileSync(configPath, "utf8");
  const lines = current.split("\n").filter((line) => !line.startsWith("PI_LLM_GATEWAY_AUTO_WAKE="));
  lines.push(`PI_LLM_GATEWAY_AUTO_WAKE=${enabled}`);
  const temporary = path.join(path.dirname(configPath), `.pilink-browser-setup-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(temporary, lines.join("\n"), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, configPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function configuredGatewayConnectorName(): string {
  const configPath = process.env.PILINK_CONFIG || defaultConfigPath();
  if (fs.existsSync(configPath) && fs.lstatSync(configPath).isFile() && !fs.lstatSync(configPath).isSymbolicLink()) {
    const config = dotenv.parse(fs.readFileSync(configPath));
    return gatewayConnectorName({ PI_LLM_GATEWAY_CONNECTOR_NAME:
      process.env.PI_LLM_GATEWAY_CONNECTOR_NAME || config.PI_LLM_GATEWAY_CONNECTOR_NAME });
  }
  return gatewayConnectorName();
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
      name?: string; manifest_version?: number; permissions?: unknown; host_permissions?: string[];
      background?: { service_worker?: string }; content_scripts?: Array<{ matches?: string[]; js?: string[] }>;
    };
    if (manifest.name !== "Pilink Wake" || manifest.manifest_version !== 3 || manifest.permissions ||
        manifest.host_permissions?.join() !== "http://127.0.0.1/*" ||
        manifest.background?.service_worker !== "background.js" || Object.keys(manifest.background).length !== 1 ||
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

// Brave/Chrome can finish loading an unpacked extension before writing its
// enabled state to Preferences. Give that write a short, bounded window rather
// than reporting a failed installation on the first Enter.
export async function waitForLoadedGatewayBrowserExtension(
  options: Parameters<typeof loadedGatewayBrowserExtension>[0] = {},
  timeoutMs = 5_000,
  pollMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (loadedGatewayBrowserExtension(options)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}

export function gatewayBrowserWakeEnabledMessage(startedForSetup = false): string {
  return startedForSetup
    ? "Auto-wake enabled. The gateway started for this setup and will apply the setting within a few seconds while running. To start it again later: pilink gateway start. Check it with: pilink gateway status."
    : "Auto-wake enabled. If the gateway is running, it will apply the setting within a few seconds; otherwise start it with 'pilink gateway start'. Check it with 'pilink gateway status'.";
}

export function gatewayBrowserExtensionNeedsReload(destination = path.resolve(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "pilink", "browser-extension",
)): boolean {
  const marker = path.join(destination, ".pilink-reload-required");
  return fs.existsSync(marker) && fs.lstatSync(marker).isFile() && !fs.lstatSync(marker).isSymbolicLink();
}

export async function runGatewayBrowserSetup(enable: boolean, options: { startedForSetup?: boolean } = {}): Promise<void> {
  const location = stageGatewayBrowserExtension({ connectorName: configuredGatewayConnectorName() });
  const reloadRequired = gatewayBrowserExtensionNeedsReload(location);
  if (reloadRequired) {
    const configPath = process.env.PILINK_CONFIG || defaultConfigPath();
    if (fs.existsSync(configPath) && dotenv.parse(fs.readFileSync(configPath)).PI_LLM_GATEWAY_AUTO_WAKE === "true") {
      pauseGatewayBrowserWake(configPath);
      process.env.PI_LLM_GATEWAY_AUTO_WAKE = "false";
      console.error("Auto-wake paused until the updated extension has been reloaded and confirmed.");
    }
  }
  if (!enable && !reloadRequired && loadedGatewayBrowserExtension({ destination: location })) {
    enableGatewayBrowserWake();
    rememberGatewayBrowserExtensionSource(location);
    console.error("PiLink Wake is active in the default browser; no terminal confirmation is needed.");
    console.error(gatewayBrowserWakeEnabledMessage(options.startedForSetup));
    return;
  }
  if (enable) {
    enableGatewayBrowserWake();
    rememberGatewayBrowserExtensionSource(location);
    fs.rmSync(path.join(location, ".pilink-reload-required"), { force: true });
    console.error(gatewayBrowserWakeEnabledMessage(options.startedForSetup));
    console.error("Use --enable only after checking that PiLink Wake is loaded and enabled in the browser.");
    return;
  }
  console.error(`Browser extension files: ${location}`);
  console.error("The browser must approve this extension once. PiLink cannot silently install it; auto-wake turns on by default after PiLink verifies it is loaded.");
  console.error("Open brave://extensions (Brave) or chrome://extensions (Chrome/Chromium).");
  if (reloadRequired) {
    console.error("PiLink Wake changed: click Reload on its card and keep it enabled (otherwise it will use an old wake phrase).");
  } else {
    console.error("1. Turn on Developer mode. 2. Click Load unpacked. 3. Select the DIRECTORY above, not manifest.json. 4. Keep PiLink Wake enabled.");
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    console.error("Once installed, run 'pilink gateway browser-extension' again. If PiLink cannot detect a non-default browser profile, verify the extension yourself before using 'pilink gateway browser-extension --enable'.");
    return;
  }
  try {
    const browser = execFileSync("xdg-settings", ["get", "default-web-browser"], { encoding: "utf8", timeout: 1500 }).trim();
    if (browser === "brave-browser.desktop") execFileSync("brave", ["--new-tab", "brave://extensions"], { timeout: 3000, stdio: "ignore" });
    else if (browser === "google-chrome.desktop") execFileSync("google-chrome", ["--new-tab", "chrome://extensions"], { timeout: 3000, stdio: "ignore" });
    else if (browser === "chromium.desktop") execFileSync("chromium", ["--new-tab", "chrome://extensions"], { timeout: 3000, stdio: "ignore" });
  } catch {
    console.error("Open brave://extensions or chrome://extensions in your browser if its Extensions page did not open.");
  }
  const readline = createInterface({ input: process.stdin, output: gatewayVisiblePromptOutput(), terminal: true });
  try {
    while (true) {
      const answer = (await readline.question(reloadRequired
        ? "After clicking Reload in your browser, press Enter to continue (or type skip): "
        : "After loading PiLink Wake in your browser, press Enter to check it (or type skip): ")).trim().toLowerCase();
      if (answer === "skip") {
        console.error("Auto-wake remains off. Run 'pilink gateway browser-extension' after installing the extension.");
        return;
      }
      if (answer) {
        console.error("Press Enter without text to check, or type skip to leave auto-wake off.");
        continue;
      }
      console.error("Checking browser extension status (up to 5 seconds)...");
      if (!await waitForLoadedGatewayBrowserExtension({ destination: location })) {
        console.error("PiLink still cannot verify an enabled PiLink Wake in the default browser profile. Brave/Chrome may still be saving its extension state; check the Extensions page and press Enter to retry. For a non-default profile, verify it yourself before using 'pilink gateway browser-extension --enable'.");
        continue;
      }
      enableGatewayBrowserWake();
      rememberGatewayBrowserExtensionSource(location);
      fs.rmSync(path.join(location, ".pilink-reload-required"), { force: true });
      console.error(gatewayBrowserWakeEnabledMessage(options.startedForSetup));
      return;
    }
  } finally {
    readline.close();
  }
}
