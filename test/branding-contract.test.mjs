import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";

const repositoryUrl = "https://github.com/roccoangelella/PiLink.git";
const legacyLogoDigest = "9cc5aa2f1682ad651da33a118615a94fdbd1c88e7525c492adb1fd5a2c76d576";
const legacyMarketplaceIconDigest = "0a1ca2c827ddfd09a56bc520db18c06788e1d349e6ca664e0ba8a83a9011d4f7";
const markDigest = "3fd809e948fb2dbeaeae621232cfe6b102ad425a6fef724c96d1a10246bf0861";
const lockupDigest = "ceafc12b9920f37161e6bce53717f9350b48b699993d3c354555e3d206c6bd8a";

async function digest(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function pngDimensions(file) {
  const data = await fs.readFile(file);
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${file} must be a PNG`);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

test("PiLink remains the project brand and compatibility names stay stable", async () => {
  const [readme, rootPackageText, extensionPackageText, pluginManifestText, serverSource] = await Promise.all([
    fs.readFile("README.md", "utf8"),
    fs.readFile("package.json", "utf8"),
    fs.readFile("packages/vscode/package.json", "utf8"),
    fs.readFile("plugins/pilink/.codex-plugin/plugin.json", "utf8"),
    fs.readFile("src/index.ts", "utf8"),
  ]);
  const rootPackage = JSON.parse(rootPackageText);
  const extensionPackage = JSON.parse(extensionPackageText);
  const pluginManifest = JSON.parse(pluginManifestText);

  assert.match(readme, /^# PiLink$/mu);
  assert.match(readme, /docs\/assets\/brand\/pilink-lockup\.svg/u);
  assert.ok(readme.split("\n").length < 240, "the root README must remain concise");
  for (const command of [
    "pilink start --mode single",
    "pilink start --mode collaboration",
    "pilink install-vscode-plugin",
    "pilink start --mode cli",
    "pilink gateway start",
  ]) {
    assert.match(readme, new RegExp(command.replaceAll(" ", "\\s+"), "u"));
  }

  assert.equal(rootPackage.name, "pilink");
  assert.equal(rootPackage.repository.url, repositoryUrl);
  assert.deepEqual(rootPackage.bin, {
    pilink: "dist/terminal-launcher.js",
    "pilink-cli": "dist/terminal-launcher-cli.js",
    "pilink-agents": "dist/terminal-launcher-agents.js",
    "pilink-single-agents": "dist/terminal-launcher-single-agents.js",
    "pilink-single-agent": "dist/terminal-launcher-single-agents.js",
  });
  assert.match(extensionPackage.displayName, /^PiLink/u);
  assert.equal(extensionPackage.repository.url, repositoryUrl);
  assert.equal(extensionPackage.icon, "media/icon.png");
  assert.equal(extensionPackage.contributes.viewsContainers.secondarySidebar, undefined);
  assert.equal(extensionPackage.contributes.viewsContainers.activitybar?.[0]?.id, "vspilinkSecondaryViewContainer");
  for (const command of ["vspilink.start", "vspilink.stop", "vspilink.restart"]) {
    assert.ok(extensionPackage.contributes.commands.some((entry) => entry.command === command), `${command} must remain available from the installed extension`);
  }
  assert.equal(pluginManifest.name, "pilink");
  assert.doesNotMatch(serverSource, /watch remote ChatGPT conversations|Collaborative monitor/u);
  assert.doesNotMatch(serverSource, /VSPiLink/u);
});

test("brand assets intentionally use the new original PiLink mark", async () => {
  const mark = await fs.readFile("docs/assets/brand/pilink-mark.svg", "utf8");
  const lockup = await fs.readFile("docs/assets/brand/pilink-lockup.svg", "utf8");
  assert.equal(await digest("docs/assets/brand/pilink-mark.svg"), markDigest);
  assert.equal(await digest("docs/assets/brand/pilink-lockup.svg"), lockupDigest);
  assert.match(mark, /Two open geometric links joined by a bright central bridge/u);
  assert.match(lockup, />PiLink<\/text>/u);
  assert.doesNotMatch(`${mark}\n${lockup}`, /OpenAI|ChatGPT|Cloudflare|Microsoft/u);

  const sharedMarkPaths = [
    "docs/assets/logo.png",
    "packages/vscode/media/logo.png",
    "plugins/pilink/assets/logo.png",
  ];
  for (const file of sharedMarkPaths) {
    assert.deepEqual(await pngDimensions(file), { width: 1024, height: 1024 });
    assert.notEqual(await digest(file), legacyLogoDigest, `${file} must not retain the pre-refresh logo`);
  }
  assert.equal(new Set(await Promise.all(sharedMarkPaths.map(digest))).size, 1, "public/plugin header marks must stay visually aligned");

  assert.deepEqual(await pngDimensions("packages/vscode/media/icon.png"), { width: 256, height: 256 });
  assert.notEqual(await digest("packages/vscode/media/icon.png"), legacyMarketplaceIconDigest);
});
