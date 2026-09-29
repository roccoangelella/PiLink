import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";

const repositoryUrl = "https://github.com/roccoangelella/PiLink.git";
const originalLogoDigest = "9cc5aa2f1682ad651da33a118615a94fdbd1c88e7525c492adb1fd5a2c76d576";
const originalIconDigest = "0a1ca2c827ddfd09a56bc520db18c06788e1d349e6ca664e0ba8a83a9011d4f7";

function withoutTechnicalIdentifiers(markdown) {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(?:\x60{3,}|~{3,})/u.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line.replace(/\x60+[^\x60\n]*\x60+/gu, "");
    })
    .join("\n");
}

function withoutInstallerCompatibilityIdentifiers(source) {
  return source
    .replace(/0xfunboy\.vspilink/giu, "")
    .replace(/\bvspilink(?=[/\\-])/giu, "")
    .replace(/\bvspilink\b/gu, "")
    .split("\n")
    .map((line) => /Join-Path\b.*["']VSPiLink["']/iu.test(line) ? "" : line)
    .join("\n");
}

async function sha256(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function pngDimensions(file) {
  const data = await fs.readFile(file);
  assert.ok(data.length >= 24, `${file} must contain a complete PNG header`);
  assert.deepEqual(
    [...data.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${file} must have the PNG signature`,
  );
  assert.equal(data.subarray(12, 16).toString("ascii"), "IHDR", `${file} must begin with an IHDR chunk`);
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
  assert.match(readme, /docs\/assets\/logo\.png/u);
  assert.doesNotMatch(readme, /independent open-source project|not affiliated with|not endorsed by/iu);
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
  assert.doesNotMatch(serverSource, /independent open-source project|not affiliated with|not endorsed by/iu);
});

test("current onboarding surfaces do not revive retired launcher labels", async () => {
  const currentLauncherDocs = [
    "README.md",
    "docs/GETTING_STARTED.md",
    "docs/CONNECT_CHATGPT.md",
    "docs/INSTALLATION.md",
    "docs/VSCODE_EXTENSION.md",
    "packages/vscode/README.md",
    "install/INSTALL.md",
    // release/INSTALL.md is a checksum-pinned snapshot of the already-shipped 2.2.0 bundle.
  ];
  const retiredUserVisibleLabels = /\bVSPiLink\b|Collaborative monitor|watch remote ChatGPT conversations/iu;

  for (const file of currentLauncherDocs) {
    const prose = withoutTechnicalIdentifiers(await fs.readFile(file, "utf8"));
    assert.doesNotMatch(prose, retiredUserVisibleLabels, `${file} must use current PiLink launcher labels`);
  }

  for (const file of ["install/install.sh", "install/install.ps1"]) {
    const source = withoutInstallerCompatibilityIdentifiers(await fs.readFile(file, "utf8"));
    assert.doesNotMatch(source, retiredUserVisibleLabels, `${file} must use current PiLink installer labels`);
  }
});

test("public and plugin surfaces reuse the exact original PiLink logo", async () => {
  const logoPaths = [
    "docs/assets/logo.png",
    "packages/vscode/media/logo.png",
    "plugins/pilink/assets/logo.png",
  ];

  for (const file of logoPaths) {
    assert.equal(await sha256(file), originalLogoDigest, `${file} must match the pre-refresh PiLink logo exactly`);
    assert.deepEqual(await pngDimensions(file), { width: 1280, height: 720 });
  }

  assert.equal(await sha256("packages/vscode/media/icon.png"), originalIconDigest);
  assert.deepEqual(await pngDimensions("packages/vscode/media/icon.png"), { width: 256, height: 256 });

  await assert.rejects(fs.access("docs/assets/brand/pilink-mark.svg"));
  await assert.rejects(fs.access("docs/assets/brand/pilink-lockup.svg"));
});
