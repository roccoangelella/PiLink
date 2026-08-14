import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repositoryRoot, "plugins", "pilink");

function fail(message) {
  throw new Error(message);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}

function assertRelativeAsset(relativePath) {
  if (typeof relativePath !== "string" || !relativePath.startsWith("./assets/")) {
    fail("plugin image paths must stay under ./assets");
  }
  const resolved = path.resolve(pluginRoot, relativePath);
  if (!resolved.startsWith(`${path.resolve(pluginRoot)}${path.sep}`) || !fs.statSync(resolved).isFile()) {
    fail(`plugin asset does not exist: ${relativePath}`);
  }
}

function markdownLinkTargets(markdown) {
  const targets = [];
  const inlineLink = /!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/gu;
  for (const match of markdown.matchAll(inlineLink)) {
    let value = match[1].trim();
    if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
    else value = value.match(/^\S+/u)?.[0] ?? "";
    if (value) targets.push(value);
  }
  return targets;
}

function assertPluginReadmeLinks() {
  const readmePath = path.join(pluginRoot, "README.md");
  const markdown = fs.readFileSync(readmePath, "utf8");
  for (const rawTarget of markdownLinkTargets(markdown)) {
    if (rawTarget.startsWith("#") || rawTarget.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(rawTarget)) continue;
    const encodedTarget = rawTarget.split(/[?#]/u, 1)[0];
    if (!encodedTarget) continue;
    let target;
    try {
      target = decodeURIComponent(encodedTarget).replaceAll("\\", "/");
    } catch {
      fail(`plugin README link contains invalid percent encoding: ${rawTarget}`);
    }
    if (target.startsWith("/")) fail(`plugin README must not use an absolute local link: ${rawTarget}`);
    const resolved = path.resolve(pluginRoot, target);
    const relative = path.relative(pluginRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`plugin README link escapes the plugin: ${rawTarget}`);
    if (!fs.existsSync(resolved)) fail(`plugin README contains a broken local link: ${rawTarget}`);
  }
}

function main() {
  const rootPackage = readJson("package.json");
  const manifest = readJson("plugins/pilink/.codex-plugin/plugin.json");
  const mcp = readJson("plugins/pilink/.mcp.json");
  const marketplace = readJson(".agents/plugins/marketplace.json");

  if (manifest.name !== "pilink" || manifest.version !== rootPackage.version || manifest.license !== "MIT") {
    fail("plugin identity, version, or license does not match the release");
  }
  if (manifest.mcpServers !== "./.mcp.json" || !Array.isArray(manifest.interface?.defaultPrompt) ||
      manifest.interface.defaultPrompt.length < 1 || manifest.interface.defaultPrompt.length > 3) {
    fail("plugin interface or MCP companion declaration is invalid");
  }
  for (const prompt of manifest.interface.defaultPrompt) {
    if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > 128) fail("plugin starter prompts must contain 1-128 characters");
  }
  assertRelativeAsset(manifest.interface.composerIcon);
  assertRelativeAsset(manifest.interface.logo);

  const server = mcp.mcpServers?.["pilink-local"];
  if (server?.type !== "http" || server.url !== "http://127.0.0.1:3200/sse") {
    fail("the repository plugin must target only the documented loopback PiLink endpoint");
  }
  const serializedMcp = JSON.stringify(mcp);
  if (/secret|token|authorization|bearer/iu.test(serializedMcp)) fail("plugin MCP configuration must not contain credentials");

  const entry = marketplace.plugins?.find((candidate) => candidate?.name === "pilink");
  if (marketplace.name !== "personal" || entry?.source?.source !== "local" ||
      entry.source.path !== "./plugins/pilink" || entry.policy?.installation !== "AVAILABLE" ||
      entry.policy?.authentication !== "ON_INSTALL") {
    fail("repository marketplace entry does not match the PiLink plugin");
  }
  for (const required of [
    "plugins/pilink/README.md",
    "plugins/pilink/.mcp.json",
    "plugins/pilink/.codex-plugin/plugin.json",
    ".agents/plugins/marketplace.json",
  ]) {
    if (!fs.statSync(path.join(repositoryRoot, required)).isFile()) fail(`missing plugin file: ${required}`);
  }
  assertPluginReadmeLinks();

  console.log(`Plugin verification passed for pilink@${manifest.version}.`);
}

try {
  main();
} catch (error) {
  console.error(`Plugin verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
