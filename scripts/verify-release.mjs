import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import { assertArchiveBudget, releaseArchiveBudgets } from "./release-archive-budgets.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = path.resolve(repositoryRoot, process.argv[2] ?? "release");
const maximumCapturedTextBytes = 8 * 1024 * 1024;
const maximumTarListingBytes = 4 * 1024 * 1024;
const requiredRuntimeDocuments = [
  "README.md",
  "INSTALLATION.md",
  "ILLUSTRATED_GUIDE.md",
  "CONNECT_CHATGPT.md",
  "USAGE_AND_COSTS.md",
  "ARCHITECTURE.md",
  "SECURITY_MODEL.md",
  "TROUBLESHOOTING.md",
  "GETTING_STARTED.md",
  "VSCODE_EXTENSION.md",
];
const requiredVsixEntries = [
  "extension/readme.md",
  "extension/runtime/README.md",
  "extension/runtime/LICENSE",
  "extension/runtime/NOTICE.md",
  "extension/runtime/SECURITY.md",
  "extension/runtime/CHANGELOG.md",
  ...requiredRuntimeDocuments.map((name) => `extension/runtime/docs/${name}`),
];
const requiredNpmPluginEntries = [
  ["package/plugins/pilink/README.md", "plugins/pilink/README.md"],
  ["package/plugins/pilink/.codex-plugin/plugin.json", "plugins/pilink/.codex-plugin/plugin.json"],
  ["package/plugins/pilink/.mcp.json", "plugins/pilink/.mcp.json"],
  ["package/plugins/pilink/assets/logo.png", "plugins/pilink/assets/logo.png"],
  ["package/.agents/plugins/marketplace.json", ".agents/plugins/marketplace.json"],
];
const userFacingSourceFiles = [
  "packages/vscode/package.json",
  "packages/vscode/README.md",
  "packages/vscode/media/app.js",
  "packages/vscode/media/app.css",
];
const italianUiPattern = /\b(?:Configurazione assistita|Connetti|Accedi|Avvia|Arresta|Riprova|Attenzione|Apri|Copia|Riavvia|Reimposta|Impostazioni|Agenti|Nessuna conversazione|In attesa|Cartella aperta|Accesso completo|Non collegato|È necessario intervenire)\b/iu;
const embeddedDeploymentPatterns = [
  /https:\/\/(?:mcp|vspilink)\.(?!example\.(?:com|net|org)\b)(?!(?:[a-z0-9-]+\.)*(?:example|test|invalid|localhost)\b)[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/iu,
  /(?:^|[/\\])cert-[a-z0-9_-]+\.pem\b/iu,
];

function containsEmbeddedDeploymentMarker(value) {
  return embeddedDeploymentPatterns.some((pattern) => pattern.test(value));
}

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) fail(`${command} ${args[0] ?? ""} failed`);
  return result;
}

function checksum(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verifyReleaseDirectoryContents(expectedNames) {
  const expected = new Set([...expectedNames, "SHA256SUMS"]);
  const actual = fs.readdirSync(releaseDirectory, { withFileTypes: true });
  const invalid = actual
    .filter((entry) => !entry.isFile() || !expected.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  const missing = [...expected].filter((name) => !actual.some((entry) => entry.isFile() && entry.name === name)).sort();
  if (invalid.length > 0) fail(`release directory contains stale or unexpected entries: ${invalid.join(", ")}`);
  if (missing.length > 0) fail(`release directory is missing required entries: ${missing.join(", ")}`);
}

function verifyChecksums(expectedNames) {
  const manifestPath = path.join(releaseDirectory, "SHA256SUMS");
  if (!fs.existsSync(manifestPath)) fail("SHA256SUMS is required for a release candidate");
  const entries = new Map();
  for (const line of fs.readFileSync(manifestPath, "utf8").split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/);
    if (!match) fail("SHA256SUMS contains an invalid line");
    if (entries.has(match[2])) fail(`SHA256SUMS contains duplicate entry ${match[2]}`);
    entries.set(match[2], match[1]);
  }
  if (entries.size !== expectedNames.length) fail("SHA256SUMS does not describe exactly the release files");
  for (const name of expectedNames) {
    const expected = entries.get(name);
    if (!expected) fail(`SHA256SUMS is missing ${name}`);
    if (checksum(path.join(releaseDirectory, name)) !== expected) fail(`checksum mismatch for ${name}`);
  }
}

function markdownLinkTargets(markdown) {
  const targets = [];
  const inlineLink = /!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/gu;
  for (const match of markdown.matchAll(inlineLink)) {
    let value = match[1].trim();
    if (value.startsWith("<") && value.endsWith(">")) {
      value = value.slice(1, -1);
    } else {
      value = value.match(/^\S+/u)?.[0] ?? "";
    }
    if (value) targets.push(value);
  }
  return targets;
}

function localMarkdownTarget(rawTarget) {
  if (rawTarget.startsWith("#") || rawTarget.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(rawTarget)) {
    return undefined;
  }
  const withoutFragment = rawTarget.split(/[?#]/u, 1)[0];
  if (!withoutFragment) return undefined;
  try {
    return decodeURIComponent(withoutFragment).replaceAll("\\", "/");
  } catch {
    fail(`Markdown link contains invalid percent encoding: ${rawTarget}`);
  }
}

function listMarkdownFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...listMarkdownFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".md")) result.push(absolute);
  }
  return result;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function verifySourceMarkdownLinks() {
  const files = [
    path.join(repositoryRoot, "README.md"),
    path.join(repositoryRoot, "packages", "vscode", "README.md"),
    path.join(repositoryRoot, "plugins", "pilink", "README.md"),
    path.join(repositoryRoot, "install", "INSTALL.md"),
    ...listMarkdownFiles(path.join(repositoryRoot, "docs")),
  ];
  for (const file of files) {
    const markdown = fs.readFileSync(file, "utf8");
    for (const rawTarget of markdownLinkTargets(markdown)) {
      const target = localMarkdownTarget(rawTarget);
      if (!target) continue;
      if (target.startsWith("/")) fail(`Markdown link must not use an absolute local path: ${path.relative(repositoryRoot, file)} -> ${rawTarget}`);
      const resolved = path.resolve(path.dirname(file), target);
      if (!isInside(repositoryRoot, resolved)) fail(`Markdown link escapes the repository: ${path.relative(repositoryRoot, file)} -> ${rawTarget}`);
      if (!fs.existsSync(resolved)) fail(`Broken Markdown link: ${path.relative(repositoryRoot, file)} -> ${rawTarget}`);
    }
  }
}

function verifyVirtualMarkdownLinks(markdownFiles, archiveEntries) {
  for (const [source, markdown] of markdownFiles) {
    for (const rawTarget of markdownLinkTargets(markdown)) {
      const target = localMarkdownTarget(rawTarget);
      if (!target) continue;
      if (target.startsWith("/")) fail(`Packaged Markdown link uses an absolute local path: ${source} -> ${rawTarget}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), target)).replace(/\/+$/u, "");
      if (!resolved.startsWith("extension/")) fail(`Packaged Markdown link escapes the VSIX: ${source} -> ${rawTarget}`);
      const exists = archiveEntries.has(resolved) || [...archiveEntries].some((entry) => entry.startsWith(`${resolved}/`));
      if (!exists) fail(`Broken packaged Markdown link: ${source} -> ${rawTarget}`);
    }
  }
}

function assertEnglishUi(content, label) {
  if (italianUiPattern.test(content)) fail(`${label} contains an Italian user-interface string`);
}

function verifySourceUiLanguage() {
  for (const relative of userFacingSourceFiles) {
    assertEnglishUi(fs.readFileSync(path.join(repositoryRoot, relative), "utf8"), relative);
  }
}

function verifyRepositoryPlugin() {
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts", "verify-plugin.mjs")], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (result.stdout.trim()) console.error(result.stdout.trim());
    if (result.stderr.trim()) console.error(result.stderr.trim());
    fail("repository plugin verification failed");
  }
  if (result.stdout.trim()) console.log(result.stdout.trim());
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function shouldCaptureMarkdown(normalized) {
  return normalized === "extension/readme.md"
    || /^extension\/runtime\/(?:README|NOTICE|SECURITY|CHANGELOG)\.md$/u.test(normalized)
    || (normalized.startsWith("extension/runtime/docs/") && normalized.endsWith(".md"));
}

function shouldCapturePackagedUi(normalized) {
  return normalized === "extension/package.json"
    || normalized === "extension/media/app.js"
    || normalized === "extension/media/app.css"
    || normalized === "extension/readme.md";
}

async function inspectVsix(file, expected) {
  const budget = releaseArchiveBudgets.vsix;
  assertArchiveBudget("VSIX", { compressedBytes: fs.statSync(file).size }, budget);
  const zip = await openZip(file);
  let entries = 0;
  let uncompressedBytes = 0;
  let extensionPackage;
  const archiveEntries = new Set();
  const markdownFiles = new Map();
  const packagedUi = new Map();

  await new Promise((resolve, reject) => {
    let settled = false;
    const abort = (error) => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch { /* archive is already closed */ }
      reject(error);
    };

    zip.on("error", abort);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on("entry", (entry) => {
      entries += 1;
      uncompressedBytes += entry.uncompressedSize;
      try {
        assertArchiveBudget("VSIX", { entries, uncompressedBytes }, budget);
      } catch (error) {
        abort(error);
        return;
      }

      const normalized = entry.fileName.replaceAll("\\", "/");
      if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
        abort(new Error("VSIX contains an unsafe path"));
        return;
      }
      archiveEntries.add(normalized.replace(/\/$/u, ""));
      if (normalized.endsWith("/")) {
        zip.readEntry();
        return;
      }

      const capture = shouldCapturePackagedUi(normalized) || shouldCaptureMarkdown(normalized);
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          abort(error ?? new Error(`Unable to inspect ${normalized}`));
          return;
        }
        const chunks = [];
        let capturedBytes = 0;
        let scanTail = "";
        stream.on("data", (chunk) => {
          const scanText = `${scanTail}${chunk.toString("utf8")}`;
          if (containsEmbeddedDeploymentMarker(scanText)) {
            stream.destroy();
            abort(new Error(`VSIX contains an owner-specific deployment marker in ${normalized}`));
            return;
          }
          scanTail = scanText.slice(-256);
          if (capture) {
            capturedBytes += chunk.length;
            if (capturedBytes > maximumCapturedTextBytes) {
              stream.destroy();
              abort(new Error(`VSIX text entry is unexpectedly large: ${normalized}`));
              return;
            }
            chunks.push(chunk);
          }
        });
        stream.on("error", abort);
        stream.on("end", () => {
          if (settled) return;
          if (capture) {
            const content = Buffer.concat(chunks).toString("utf8");
            try {
              if (normalized === "extension/package.json") extensionPackage = JSON.parse(content);
              if (shouldCaptureMarkdown(normalized)) markdownFiles.set(normalized, content);
              if (shouldCapturePackagedUi(normalized)) packagedUi.set(normalized, content);
            } catch (parseError) {
              abort(parseError);
              return;
            }
          }
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });

  if (!extensionPackage) fail("VSIX is missing extension/package.json");
  if (extensionPackage.name !== "vspilink" || extensionPackage.publisher !== "0xfunboy" || extensionPackage.version !== expected.version) {
    fail("VSIX identity or version does not match the release");
  }
  for (const required of requiredVsixEntries) {
    if (!archiveEntries.has(required)) fail(`VSIX is missing required release document ${required}`);
  }
  for (const required of ["extension/media/app.js", "extension/media/app.css"]) {
    if (!archiveEntries.has(required)) fail(`VSIX is missing dashboard asset ${required}`);
  }
  for (const legacy of ["extension/media/main.js", "extension/media/styles.css"]) {
    if (archiveEntries.has(legacy)) fail(`VSIX still contains legacy dashboard asset ${legacy}`);
  }
  for (const [name, content] of packagedUi) assertEnglishUi(content, name);
  verifyVirtualMarkdownLinks(markdownFiles, archiveEntries);
}

function runTar(file, args, options = {}) {
  const result = spawnSync("tar", [...args, file], {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return result;
}

function inspectTgz(file, expected) {
  const budget = releaseArchiveBudgets.npm;
  assertArchiveBudget("npm archive", { compressedBytes: fs.statSync(file).size }, budget);

  const listingResult = runTar(file, ["-tzf"], { maxBuffer: maximumTarListingBytes });
  if (listingResult.error?.code === "ENOBUFS") fail("npm archive listing exceeds the release inspection budget");
  if (listingResult.status !== 0) fail("unable to list npm archive");
  const listing = listingResult.stdout.toString("utf8").split(/\r?\n/).filter(Boolean);
  if (listing.length === 0) fail("npm archive is empty");
  assertArchiveBudget("npm archive", { entries: listing.length }, budget);
  const seenEntries = new Set();
  for (const entry of listing) {
    const normalized = entry.replaceAll("\\", "/");
    if (!normalized.startsWith("package/") || normalized.split("/").includes("..")) fail("npm archive contains an unsafe path");
    if (seenEntries.has(normalized)) fail(`npm archive contains duplicate entry ${normalized}`);
    seenEntries.add(normalized);
    if (/(^|\/)(\.env|auth\.json|clients\.json|refresh-tokens\.json|credentials(?:-[^/]*)?\.json|tunnel-token(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx))$/i.test(normalized)) {
      fail(`npm archive contains forbidden private file ${normalized}`);
    }
  }

  const payloadResult = runTar(file, ["-xOzf"], { maxBuffer: budget.uncompressedBytes + 1 });
  if (payloadResult.error?.code === "ENOBUFS") {
    assertArchiveBudget("npm archive", { uncompressedBytes: budget.uncompressedBytes + 1 }, budget);
  }
  if (payloadResult.status !== 0) fail("unable to inspect npm archive payload");
  assertArchiveBudget("npm archive", { uncompressedBytes: payloadResult.stdout.length }, budget);
  const archiveText = payloadResult.stdout.toString("utf8");
  if (containsEmbeddedDeploymentMarker(archiveText)) fail("npm archive contains an owner-specific deployment marker");
  const packageResult = run("tar", ["-xOzf", file, "package/package.json"]);
  const packageJson = JSON.parse(packageResult.stdout);
  if (packageJson.name !== expected.name || packageJson.version !== expected.version) fail("npm archive identity or version does not match the release");
  if (packageJson.engines?.node !== "24.18.0" || packageJson.packageManager !== "npm@11.16.0") fail("npm archive runtime pins are not exact");
  for (const required of [
    "package/SECURITY.md",
    "package/NOTICE.md",
    "package/CHANGELOG.md",
    ...requiredNpmPluginEntries.map(([archiveEntry]) => archiveEntry),
  ]) {
    if (!listing.includes(required)) fail(`npm archive is missing ${required}`);
  }
  for (const [archiveEntry, sourceFile] of requiredNpmPluginEntries) {
    if (!listing.includes(archiveEntry)) fail(`npm archive is missing local Codex plugin file ${archiveEntry}`);
    const packaged = spawnSync("tar", ["-xOzf", file, archiveEntry], {
      cwd: repositoryRoot,
      encoding: null,
      maxBuffer: maximumCapturedTextBytes,
    });
    if (packaged.status !== 0) fail(`unable to inspect local Codex plugin file ${archiveEntry}`);
    const source = fs.readFileSync(path.join(repositoryRoot, sourceFile));
    if (!packaged.stdout.equals(source)) fail(`npm archive local Codex plugin file differs from source: ${archiveEntry}`);
  }
}

function inspectSbom(file, expected) {
  const sbom = readJson(file);
  const component = sbom.metadata?.component;
  const expectedPurl = `pkg:npm/${expected.name}@${expected.version}`;
  if (sbom.bomFormat !== "CycloneDX" || component?.purl !== expectedPurl || component?.version !== expected.version) {
    fail("CycloneDX SBOM identity does not match the release");
  }
  if (!Array.isArray(sbom.components) || sbom.components.length === 0) fail("CycloneDX SBOM has no dependency components");
}

function inspectInstallers(expected) {
  const shell = fs.readFileSync(path.join(releaseDirectory, "install.sh"), "utf8");
  const powershell = fs.readFileSync(path.join(releaseDirectory, "install.ps1"), "utf8");
  for (const [name, content] of [["install.sh", shell], ["install.ps1", powershell]]) {
    if (!content.includes("v24.18.0") || !content.includes("0xfunboy.vspilink") || !content.includes("Developer: Reload Window") || !content.includes("Remote-SSH")) {
      fail(`${name} is missing required version, identity, reload, or Remote-SSH guidance`);
    }
    if (!content.includes("VSPILINK_ALLOW_UNVERIFIED_DEVELOPMENT_INSTALL") || !content.includes("Refusing an unverified install")) {
      fail(`${name} does not fail closed when SHA256SUMS is absent`);
    }
    if (/optional for local development builds/iu.test(content)) fail(`${name} still treats SHA256SUMS as optional by default`);
    if (/NPM_TOKEN|NODE_AUTH_TOKEN|client[_-]?secret\s+["']?\$|Start-BitsTransfer/i.test(content)) {
      fail(`${name} contains a publishing secret reference or unsupported downloader`);
    }
  }
  if (!shell.includes(expected.version) && !shell.includes("vspilink-*.vsix")) fail("shell installer cannot locate the release VSIX");
  const combined = `${shell}\n${powershell}`;
  const pinnedNodeHashes = [
    "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742",
    "58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6",
    "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
    "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1",
    "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
    "f274669adb93b1fd0fbf8f21fd078609e9dcc84333d4f2718d2dde3f9a161a01",
  ];
  if (!combined.includes("https://nodejs.org/dist/v24.18.0")) fail("installers do not use the pinned official Node.js source");
  for (const hash of pinnedNodeHashes) {
    if (!combined.includes(hash)) fail("installers are missing a pinned Node.js archive checksum");
  }
}

function inspectReleaseGuide() {
  const guide = fs.readFileSync(path.join(releaseDirectory, "INSTALL.md"), "utf8");
  for (const required of ["./install.sh", ".\\install.ps1", "SHA256SUMS", "Secondary Side Bar", "PiLink"]) {
    if (!guide.includes(required)) fail(`release INSTALL.md is missing required guidance: ${required}`);
  }
}

async function main() {
  if (process.version !== "v24.18.0") fail(`expected Node.js v24.18.0, got ${process.version}`);
  verifySourceMarkdownLinks();
  verifySourceUiLanguage();
  verifyRepositoryPlugin();
  if (!fs.existsSync(releaseDirectory) || !fs.statSync(releaseDirectory).isDirectory()) fail("release directory does not exist");

  const expected = readJson(path.join(repositoryRoot, "package.json"));
  const vsixName = `vspilink-${expected.version}.vsix`;
  const tgzName = `${expected.name}-${expected.version}.tgz`;
  const sbomName = `${expected.name}-${expected.version}.cdx.json`;
  const expectedNames = [vsixName, tgzName, sbomName, "install.sh", "install.ps1", "INSTALL.md"].sort();

  verifyReleaseDirectoryContents(expectedNames);
  verifyChecksums(expectedNames);
  await inspectVsix(path.join(releaseDirectory, vsixName), expected);
  inspectTgz(path.join(releaseDirectory, tgzName), expected);
  inspectSbom(path.join(releaseDirectory, sbomName), expected);
  inspectInstallers(expected);
  inspectReleaseGuide();

  const scan = spawnSync(process.execPath, [
    path.join(repositoryRoot, "scripts", "secret-scan.mjs"),
    "--no-worktree",
    "--artifacts",
    path.join(releaseDirectory, vsixName),
    path.join(releaseDirectory, tgzName),
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (scan.status !== 0) {
    if (scan.stderr.trim()) console.error(scan.stderr.trim());
    fail("release artifact secret scan failed");
  }
  if (scan.stdout.trim()) console.log(scan.stdout.trim());

  console.log(`Release verification passed for ${expected.name}@${expected.version}.`);
  console.log("Verification did not publish or upload any artifact.");
}

main().catch((error) => {
  console.error(`Release verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
