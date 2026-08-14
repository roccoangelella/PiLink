import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const scanHistory = args.includes("--history");
const scanWorktree = !args.includes("--no-worktree");
const artifactsIndex = args.indexOf("--artifacts");
const artifactArguments = artifactsIndex >= 0
  ? args.slice(artifactsIndex + 1).filter((value) => !value.startsWith("--"))
  : [];

const ignoredDirectoryNames = new Set([".git", "node_modules", "dist", "runtime", "release", "__pycache__"]);
const ignoredFilePatterns = [/\.vsix$/i, /\.tgz$/i, /\.png$/i, /\.jpe?g$/i, /\.gif$/i, /\.ico$/i, /\.woff2?$/i];
const maximumTextBytes = 8 * 1024 * 1024;
const findings = new Map();

const highConfidenceRules = [
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ["OpenAI-style API key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["JWT or tunnel token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
];

const quotedSecret = /\b(client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|tunnel[_-]?token|bootstrap[_-]?secret|jwt[_-]?secret|password)\b[ \t]*[:=][ \t]*(["'`])([^\r\n"'`]{8,})\2/gi;
const dotenvSecret = /^[ \t]*(?:export[ \t]+)?(CLIENT_?SECRET|API_?KEY|ACCESS_?TOKEN|REFRESH_?TOKEN|TUNNEL_?TOKEN|PI_BOOTSTRAP_SECRET|JWT_SECRET|PASSWORD)[ \t]*=[ \t]*([^\s#][^\r\n#]{7,})/gm;
const allowedFixtureDigests = new Set([
  // Deliberately realistic fake key used twice by the redaction unit test.
  "82be8a4d9cdebab78235e6d0618fdea34065fcb6f498073283ff4ec7376e551a",
]);

function isPlaceholder(value, location = "") {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  const digest = crypto.createHash("sha256").update(value).digest("hex");
  if (allowedFixtureDigests.has(digest) && /(^|[:/])(?:test|tests)(?:[:/])/.test(location)) return true;
  if (/\$\{|process\.env|env\(|getenv|secretstorage|\[redact|<redact/.test(normalized)) return true;
  if (/(example|placeholder|dummy|fixture|fake|sample|replace[-_ ]?me|change[-_ ]?me|your[-_ ]|should-be-redacted|secret-value|token-value|test-secret|test-token)/.test(normalized)) return true;
  if (/(^|[:/])(?:test|tests)(?:[:/])/.test(location)
    && /^[a-z0-9._/# +()-]+$/i.test(normalized)
    && /(secret|token|password|private|must|never|store|legacy|read)/.test(normalized)) return true;
  if (/^(none|null|undefined|false|true|x+|\*+)$/.test(normalized)) return true;
  return false;
}

function lineNumberFor(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function addFinding(location, line, rule) {
  const key = `${location}:${line}:${rule}`;
  findings.set(key, { location, line, rule });
}

function scanText(text, location) {
  if (text.includes("\0")) return;
  const vendoredDependency = location.includes("!extension/runtime/node_modules/");
  const vendoredFixtureOrDocumentation = vendoredDependency
    && /\/(?:readme(?:-[^/]*)?\.md|docs?|examples?|test|tests)(?:[./\/]|$)/i.test(location);

  const blockRules = [
    ["private key material", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{80,}?-----END [A-Z ]*PRIVATE KEY-----/g],
    ["certificate material", /-----BEGIN CERTIFICATE-----[\s\S]{80,}?-----END CERTIFICATE-----/g],
  ];
  if (!vendoredFixtureOrDocumentation) {
    for (const [rule, expression] of blockRules) {
      expression.lastIndex = 0;
      for (const match of text.matchAll(expression)) {
        addFinding(location, lineNumberFor(text, match.index ?? 0), rule);
      }
    }
  }

  if (!vendoredFixtureOrDocumentation) {
    for (const [rule, expression] of highConfidenceRules) {
      expression.lastIndex = 0;
      for (const match of text.matchAll(expression)) {
        if (!isPlaceholder(match[0], location)) {
          addFinding(location, lineNumberFor(text, match.index ?? 0), rule);
        }
      }
    }
  }

  if (!vendoredDependency) {
    quotedSecret.lastIndex = 0;
    for (const match of text.matchAll(quotedSecret)) {
      if (!isPlaceholder(match[3], location)) {
        addFinding(location, lineNumberFor(text, match.index ?? 0), `literal ${match[1]}`);
      }
    }

    dotenvSecret.lastIndex = 0;
    for (const match of text.matchAll(dotenvSecret)) {
      if (!isPlaceholder(match[2], location)) {
        addFinding(location, lineNumberFor(text, match.index ?? 0), `literal ${match[1]}`);
      }
    }
  }
}

function walk(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectoryNames.has(entry.name)) output.push(...walk(absolute));
      continue;
    }
    if (!entry.isFile()) continue;
    if (ignoredFilePatterns.some((expression) => expression.test(entry.name))) continue;
    output.push(absolute);
  }
  return output;
}

function scanFile(absolute, location = path.relative(repositoryRoot, absolute)) {
  const stat = fs.statSync(absolute);
  if (stat.size > maximumTextBytes) return;
  scanText(fs.readFileSync(absolute, "utf8"), location.replaceAll(path.sep, "/"));
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return result;
}

function scanGitHistory() {
  const revisions = run("git", ["rev-list", "--all"]);
  if (revisions.status !== 0) throw new Error("unable to enumerate Git history");

  const candidatePattern = [
    "PRIVATE KEY",
    "CERTIFICATE",
    "gh[pousr]_[A-Za-z0-9]{20,}",
    "sk-[A-Za-z0-9_-]{20,}",
    "AKIA[0-9A-Z]{16}",
    "AIza[0-9A-Za-z_-]{35}",
    "xox[baprs]-[A-Za-z0-9-]{20,}",
    "eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}",
    "(client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|tunnel[_-]?token|bootstrap[_-]?secret|jwt[_-]?secret|password)[[:space:]]*[:=]",
  ].join("|");

  for (const revision of revisions.stdout.split(/\r?\n/).filter(Boolean)) {
    const grep = run("git", ["grep", "-I", "-n", "-E", candidatePattern, revision, "--"]);
    if (grep.status !== 0 && grep.status !== 1) throw new Error(`unable to scan Git revision ${revision}`);
    const candidateFiles = new Set();
    for (const outputLine of grep.stdout.split(/\r?\n/).filter(Boolean)) {
      const match = outputLine.match(/^[0-9a-f]+:(.*?):(\d+):(.*)$/i);
      if (!match) continue;
      candidateFiles.add(match[1]);
    }
    for (const file of candidateFiles) {
      const content = run("git", ["show", `${revision}:${file}`]);
      if (Buffer.byteLength(content.stdout) <= maximumTextBytes) {
        scanText(content.stdout, `git:${revision.slice(0, 12)}:${file}`);
      }
    }
  }
}

function openZip(archive) {
  return new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

async function scanVsix(archive) {
  const zip = await openZip(archive);
  await new Promise((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", resolve);
    zip.on("entry", (entry) => {
      if (entry.fileName.endsWith("/") || entry.uncompressedSize > maximumTextBytes) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (!buffer.includes(0)) scanText(buffer.toString("utf8"), `${path.basename(archive)}!${entry.fileName}`);
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
}

function scanTgz(archive) {
  const list = run("tar", ["-tzf", archive]);
  if (list.status !== 0) throw new Error(`unable to list ${path.basename(archive)}`);
  for (const entry of list.stdout.split(/\r?\n/).filter(Boolean)) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      addFinding(`${path.basename(archive)}!${entry}`, 0, "unsafe archive path");
      continue;
    }
    if (entry.endsWith("/")) continue;
    const extracted = run("tar", ["-xOzf", archive, entry], { maxBuffer: maximumTextBytes + 1024 });
    if (extracted.status !== 0 || Buffer.byteLength(extracted.stdout) > maximumTextBytes || extracted.stdout.includes("\0")) continue;
    scanText(extracted.stdout, `${path.basename(archive)}!${entry}`);
  }
}

async function main() {
  if (scanWorktree) {
    for (const file of walk(repositoryRoot)) scanFile(file);
  }

  if (scanHistory) scanGitHistory();

  for (const argument of artifactArguments) {
    const artifact = path.resolve(repositoryRoot, argument);
    if (!fs.existsSync(artifact)) throw new Error(`artifact not found: ${argument}`);
    if (/\.vsix$/i.test(artifact)) await scanVsix(artifact);
    else if (/\.tgz$/i.test(artifact)) scanTgz(artifact);
    else throw new Error(`unsupported artifact type: ${argument}`);
  }

  if (findings.size > 0) {
    console.error(`Secret scan failed with ${findings.size} finding(s). Values are intentionally not printed.`);
    for (const finding of findings.values()) {
      console.error(`- ${finding.location}:${finding.line} [${finding.rule}]`);
    }
    process.exitCode = 1;
    return;
  }

  const scopes = [scanWorktree ? "worktree" : null, scanHistory ? "Git history" : null, artifactArguments.length ? `${artifactArguments.length} artifact(s)` : null].filter(Boolean);
  console.log(`Secret scan passed: ${scopes.join(", ") || "no scopes"}.`);
}

main().catch((error) => {
  console.error(`Secret scan could not complete: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
