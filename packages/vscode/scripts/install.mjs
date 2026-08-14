import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDirectory = path.resolve(scriptDirectory, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(extensionDirectory, "package.json"), "utf8"));
const vsixPath = path.join(extensionDirectory, `vspilink-${packageJson.version}.vsix`);
if (!fs.existsSync(vsixPath)) throw new Error(`VSIX not found: ${vsixPath}`);

if (process.platform === "win32" && /[%!"\r\n]/.test(vsixPath)) {
  throw new Error("The VSIX path contains characters that are unsafe for cmd.exe.");
}
const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "code";
const args = process.platform === "win32"
  ? ["/d", "/s", "/c", `call code.cmd --install-extension "${vsixPath}" --force`]
  : ["--install-extension", vsixPath, "--force"];
const result = spawnSync(command, args, {
  stdio: "inherit",
  env: process.env,
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`VSIX installation exited with code ${result.status}.`);
