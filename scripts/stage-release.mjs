import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const expectedNodeVersion = "v24.18.0";
const expectedNpmVersion = "11.16.0";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = path.join(repositoryRoot, "release");

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) fail(`${command} ${args[0] ?? ""} failed; inspect the command locally with secrets redacted`);
  return result.stdout;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertSafeReleasePath() {
  const resolved = path.resolve(releaseDirectory);
  if (resolved !== path.join(repositoryRoot, "release") || path.dirname(resolved) !== repositoryRoot) {
    fail("refusing to prepare an unexpected release directory");
  }
}

function main() {
  if (process.version !== expectedNodeVersion) {
    fail(`expected Node.js ${expectedNodeVersion}, got ${process.version}`);
  }
  const npmVersion = run("npm", ["--version"]).trim();
  if (npmVersion !== expectedNpmVersion) {
    fail(`expected npm ${expectedNpmVersion}, got ${npmVersion}`);
  }

  const rootPackage = readJson(path.join(repositoryRoot, "package.json"));
  const extensionPackage = readJson(path.join(repositoryRoot, "packages", "vscode", "package.json"));
  if (rootPackage.version !== extensionPackage.version) fail("root and VS Code package versions differ");
  if (rootPackage.engines?.node !== "24.18.0" || rootPackage.packageManager !== "npm@11.16.0") {
    fail("package runtime pins are not exact");
  }

  assertSafeReleasePath();
  fs.rmSync(releaseDirectory, { recursive: true, force: true });
  fs.mkdirSync(releaseDirectory, { recursive: true, mode: 0o755 });

  run("npm", ["run", "vscode:package"]);
  const vsixName = `vspilink-${rootPackage.version}.vsix`;
  const builtVsix = path.join(repositoryRoot, "packages", "vscode", vsixName);
  if (!fs.existsSync(builtVsix)) fail(`expected VSIX was not produced: ${vsixName}`);
  fs.copyFileSync(builtVsix, path.join(releaseDirectory, vsixName));

  const packOutput = run("npm", ["pack", "--pack-destination", releaseDirectory, "--json"]);
  let packResult;
  try {
    [packResult] = JSON.parse(packOutput);
  } catch {
    fail("npm pack returned an unreadable manifest");
  }
  const tgzName = path.basename(packResult?.filename ?? "");
  const expectedTgzName = `${rootPackage.name}-${rootPackage.version}.tgz`;
  if (tgzName !== expectedTgzName || !fs.existsSync(path.join(releaseDirectory, tgzName))) {
    fail(`npm pack did not produce ${expectedTgzName}`);
  }

  const sbomName = `${rootPackage.name}-${rootPackage.version}.cdx.json`;
  const sbomRaw = run("npm", [
    "sbom",
    "--package-lock-only",
    "--omit=dev",
    "--omit=optional",
    "--sbom-format=cyclonedx",
    "--sbom-type=application",
  ]);
  let sbom;
  try {
    sbom = JSON.parse(sbomRaw);
  } catch {
    fail("npm sbom returned invalid JSON");
  }
  fs.writeFileSync(path.join(releaseDirectory, sbomName), `${JSON.stringify(sbom, null, 2)}\n`, { mode: 0o644 });

  for (const installer of ["install.sh", "install.ps1"]) {
    fs.copyFileSync(path.join(repositoryRoot, "install", installer), path.join(releaseDirectory, installer));
  }
  fs.copyFileSync(path.join(repositoryRoot, "install", "INSTALL.md"), path.join(releaseDirectory, "INSTALL.md"));
  fs.chmodSync(path.join(releaseDirectory, "install.sh"), 0o755);

  const releaseFiles = [vsixName, expectedTgzName, sbomName, "install.sh", "install.ps1", "INSTALL.md"].sort();
  const checksumLines = releaseFiles.map((name) => `${sha256(path.join(releaseDirectory, name))}  ${name}`);
  fs.writeFileSync(path.join(releaseDirectory, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, { mode: 0o644 });

  console.log(`Release candidate staged in ${path.relative(repositoryRoot, releaseDirectory)}/ with ${releaseFiles.length} checksummed files.`);
  console.log("No package, extension, tag, or GitHub release was published.");
}

try {
  main();
} catch (error) {
  console.error(`Release staging failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
