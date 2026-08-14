import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";

const repositoryUrl = "https://github.com/roccoangelella/PiLink.git";

test("PiLink remains the project brand and VSPiLink is scoped to the optional extension", async () => {
  const [readme, rootPackageText, extensionPackageText, marketplaceText, pluginManifestText, serverSource] = await Promise.all([
    fs.readFile("README.md", "utf8"),
    fs.readFile("package.json", "utf8"),
    fs.readFile("packages/vscode/package.json", "utf8"),
    fs.readFile(".agents/plugins/marketplace.json", "utf8"),
    fs.readFile("plugins/pilink/.codex-plugin/plugin.json", "utf8"),
    fs.readFile("src/index.ts", "utf8"),
  ]);
  const rootPackage = JSON.parse(rootPackageText);
  const extensionPackage = JSON.parse(extensionPackageText);
  const marketplace = JSON.parse(marketplaceText);
  const pluginManifest = JSON.parse(pluginManifestText);

  assert.match(readme, /^# PiLink$/mu);
  assert.match(readme, /docs\/assets\/logo\.png/u);
  assert.match(readme, /VSPiLink.*optional|optional.*VSPiLink/su);
  assert.equal(rootPackage.name, "pilink");
  assert.equal(rootPackage.repository.url, repositoryUrl);
  assert.match(extensionPackage.displayName, /^VSPiLink/u);
  assert.match(extensionPackage.displayName, /PiLink/u);
  assert.equal(extensionPackage.repository.url, repositoryUrl);
  assert.equal(extensionPackage.icon, "media/icon.png");
  assert.equal(marketplace.interface.displayName, "PiLink Repository");
  assert.equal(marketplace.plugins[0].name, "pilink");
  assert.equal(marketplace.plugins[0].source.path, "./plugins/pilink");
  assert.equal(pluginManifest.name, "pilink");
  assert.doesNotMatch(serverSource, /VSPiLink/u);
});

test("public and plugin surfaces reuse the original PiLink logo", async () => {
  const paths = [
    "docs/assets/logo.png",
    "packages/vscode/media/logo.png",
    "plugins/pilink/assets/logo.png",
  ];
  const digests = await Promise.all(paths.map(async (file) =>
    crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex")));
  assert.equal(new Set(digests).size, 1);
  await assert.rejects(fs.access("docs/assets/brand/vspilink-hero.webp"));
  await assert.rejects(fs.access("docs/assets/brand/vspilink-lockup.svg"));
});
