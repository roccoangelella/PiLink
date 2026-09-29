import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const repositoryUrl = "https://github.com/roccoangelella/PiLink.git";

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

function assertAccessibleSafeSvg(file, svg) {
  assert.match(svg, /^\s*<svg\b/iu, `${file} must be an SVG document`);
  assert.match(svg, /\brole\s*=\s*["']img["']/iu, `${file} must expose image semantics`);

  const labelledBy = svg.match(/\baria-labelledby\s*=\s*["']([^"']+)["']/iu)?.[1]?.split(/\s+/u) ?? [];
  const title = svg.match(/<title\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>\s*([^<]+?)\s*<\/title>/iu);
  const description = svg.match(/<desc\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>\s*([^<]+?)\s*<\/desc>/iu);

  assert.ok(title?.[2]?.trim(), `${file} must contain a non-empty <title>`);
  assert.ok(description?.[2]?.trim(), `${file} must contain a non-empty <desc>`);
  assert.ok(labelledBy.includes(title[1]), `${file} aria-labelledby must reference its title`);
  assert.ok(labelledBy.includes(description[1]), `${file} aria-labelledby must reference its description`);

  assert.doesNotMatch(svg, /<script\b/iu, `${file} must not contain scripts`);
  assert.doesNotMatch(svg, /\son[a-z]+\s*=/iu, `${file} must not contain script event handlers`);
  for (const match of svg.matchAll(/\b(?:href|xlink:href)\s*=\s*["']([^"']+)["']/giu)) {
    assert.match(match[1], /^#/u, `${file} must not load external href resources`);
  }
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
  assert.match(serverSource, /Not affiliated with or endorsed by OpenAI, Microsoft, or Cloudflare\./u);
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
    "release/INSTALL.md",
  ];
  const retiredUserVisibleLabels = /\bVSPiLink\b|Collaborative monitor|watch remote ChatGPT conversations/iu;

  for (const file of currentLauncherDocs) {
    const prose = withoutTechnicalIdentifiers(await fs.readFile(file, "utf8"));
    assert.doesNotMatch(prose, retiredUserVisibleLabels, `${file} must use current PiLink launcher labels`);
  }
});

test("brand SVGs are accessible and self-contained", async () => {
  const assets = [
    "docs/assets/brand/pilink-mark.svg",
    "docs/assets/brand/pilink-lockup.svg",
  ];

  for (const file of assets) {
    const svg = await fs.readFile(file, "utf8");
    assertAccessibleSafeSvg(file, svg);
    assert.doesNotMatch(svg, /OpenAI|ChatGPT|Cloudflare|Microsoft/u);
  }
});

test("important public PNG assets have expected PNG geometry", async () => {
  const assets = new Map([
    ["docs/assets/logo.png", { width: 1024, height: 1024 }],
    ["packages/vscode/media/logo.png", { width: 1024, height: 1024 }],
    ["plugins/pilink/assets/logo.png", { width: 1024, height: 1024 }],
    ["packages/vscode/media/icon.png", { width: 256, height: 256 }],
  ]);

  for (const [file, expected] of assets) {
    assert.deepEqual(await pngDimensions(file), expected);
  }
});
