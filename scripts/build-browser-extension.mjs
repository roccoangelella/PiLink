import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "browser-extension");
const destination = path.join(root, "dist", "browser-extension");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3 || manifest.permissions ||
    manifest.host_permissions?.join() !== "http://127.0.0.1/*" ||
    manifest.background?.service_worker !== "background.js" || Object.keys(manifest.background).length !== 1 ||
    manifest.content_scripts?.length !== 1 || manifest.content_scripts[0].matches?.join() !== "https://chatgpt.com/*" ||
    manifest.content_scripts[0].js?.join() !== "wake.js") {
  throw new Error("Browser wake extension must remain a narrowly scoped ChatGPT/loopback MV3 extension");
}
manifest.version = pkg.version;
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
fs.copyFileSync(path.join(source, "wake.js"), path.join(destination, "wake.js"));
fs.copyFileSync(path.join(source, "background.js"), path.join(destination, "background.js"));
console.error("[PiLink] Chrome/Brave wake extension built in dist/browser-extension");

// Once the operator has explicitly enabled this checkout's browser setup,
// subsequent builds of the *same checkout* refresh the stable unpacked files.
// Never let a disposable test clone silently replace a different install.
const installed = process.env.XDG_DATA_HOME?.trim()
  ? path.join(process.env.XDG_DATA_HOME.trim(), "pilink", "browser-extension")
  : process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local"), "PiLink", "browser-extension")
    : path.join(os.homedir(), ".local", "share", "pilink", "browser-extension");
const marker = path.join(installed, ".pilink-source.json");
if (fs.existsSync(marker)) {
  if (!fs.existsSync(installed) || fs.lstatSync(installed).isSymbolicLink() ||
      !fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink()) {
    throw new Error("Refusing an unsafe browser-extension update path");
  }
  const saved = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (saved.source_root === fs.realpathSync(root)) {
    // A generated install pins the exact configured ChatGPT connection name.
    // Re-copying the default template would silently break custom wake-ups.
    const { configuredGatewayConnectorName, stageGatewayBrowserExtension } =
      await import("../dist/llm-gateway-browser-setup.js");
    stageGatewayBrowserExtension({ source: destination, destination: installed,
      connectorName: configuredGatewayConnectorName() });
    console.error("[PiLink] Previously approved unpacked browser extension refreshed. Reload it in Chrome/Brave/Chromium if it is open.");
  }
}
