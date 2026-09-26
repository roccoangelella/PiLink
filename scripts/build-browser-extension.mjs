import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "browser-extension");
const destination = path.join(root, "dist", "browser-extension");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3 || manifest.permissions || manifest.host_permissions || manifest.background ||
    manifest.content_scripts?.length !== 1 || manifest.content_scripts[0].matches?.join() !== "https://chatgpt.com/*") {
  throw new Error("Browser wake extension must remain a minimal ChatGPT-only MV3 content script");
}
manifest.version = pkg.version;
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
fs.copyFileSync(path.join(source, "wake.js"), path.join(destination, "wake.js"));
console.error("[PiLink] Chrome/Brave wake extension built in dist/browser-extension");

// Once the operator has explicitly enabled this checkout's browser setup,
// subsequent builds of the *same checkout* refresh the stable unpacked files.
// Never let a disposable test clone silently replace a different install.
const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(process.env.HOME || "", ".local", "share");
const installed = path.join(dataHome, "pilink", "browser-extension");
const marker = path.join(installed, ".pilink-source.json");
if (fs.existsSync(marker)) {
  if (!fs.existsSync(installed) || fs.lstatSync(installed).isSymbolicLink() ||
      !fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink()) {
    throw new Error("Refusing an unsafe browser-extension update path");
  }
  const saved = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (saved.source_root === fs.realpathSync(root)) {
    for (const name of ["manifest.json", "wake.js"]) {
      const target = path.join(installed, name);
      if (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isFile())) {
        throw new Error("Refusing to overwrite an unsafe installed browser-extension file");
      }
      fs.copyFileSync(path.join(destination, name), target);
    }
    console.error("[PiLink] Previously approved unpacked browser extension refreshed. Reload it in Chrome/Brave if it is open.");
  }
}
