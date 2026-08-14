import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDirectory = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(extensionDirectory, "..", "..");
const runtimeDirectory = path.join(extensionDirectory, "runtime");
const packageJson = JSON.parse(fs.readFileSync(path.join(extensionDirectory, "package.json"), "utf8"));
const vsixPath = path.join(extensionDirectory, `vspilink-${packageJson.version}.vsix`);
const runtimeRootFiles = [
  "package.json",
  "package-lock.json",
  "README.md",
  "LICENSE",
  "NOTICE.md",
  "SECURITY.md",
  "CHANGELOG.md",
];
const requiredDocumentation = [
  "README.md",
  "INSTALLATION.md",
  "ILLUSTRATED_GUIDE.md",
  "CONNECT_CHATGPT.md",
  "USAGE_AND_COSTS.md",
  "ARCHITECTURE.md",
  "SECURITY_MODEL.md",
  "TROUBLESHOOTING.md",
  "FUNCTIONAL_PARITY.md",
  "PRODUCT_STRATEGY.md",
  "UPSTREAM_LINEAGE.md",
  "UPSTREAM_PARITY_INTEGRATION.md",
  "GETTING_STARTED.md",
  "VSCODE_EXTENSION.md",
];

assertRequiredFiles([
  ...runtimeRootFiles.map((filename) => path.join(repositoryRoot, filename)),
  ...requiredDocumentation.map((filename) => path.join(repositoryRoot, "docs", filename)),
]);

runNpm(["run", "build"], repositoryRoot);
run(process.execPath, [path.join(scriptDirectory, "build.mjs")], repositoryRoot);

fs.rmSync(runtimeDirectory, { recursive: true, force: true });
fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
for (const filename of runtimeRootFiles) {
  fs.copyFileSync(path.join(repositoryRoot, filename), path.join(runtimeDirectory, filename));
}
fs.cpSync(path.join(repositoryRoot, "dist"), path.join(runtimeDirectory, "dist"), { recursive: true });
fs.cpSync(path.join(repositoryRoot, "chat-cli"), path.join(runtimeDirectory, "chat-cli"), {
  recursive: true,
  filter: (source) => {
    const name = path.basename(source);
    return name !== "__pycache__" && !name.endsWith(".pyc") && !name.endsWith(".pyo") && name !== "tests";
  },
});
// Keep the complete linked documentation topology intact. Copying only a
// hand-maintained subset made the runtime README point to documents that were
// absent from the installed VSIX.
fs.cpSync(path.join(repositoryRoot, "docs"), path.join(runtimeDirectory, "docs"), { recursive: true });
// The VS Code extension uses Pi's headless SDK and does not need the optional
// native clipboard bindings. Omitting them keeps one VSIX portable across the
// supported desktop/Remote SSH platforms instead of baking in the build host.
// Lifecycle scripts are unnecessary for the prebuilt runtime and must not run
// arbitrary dependency code while a release artifact is being assembled.
runNpm(["ci", "--prefix", runtimeDirectory, "--omit=dev", "--omit=optional", "--ignore-scripts"], repositoryRoot);

fs.rmSync(vsixPath, { force: true });
const vsce = path.join(repositoryRoot, "node_modules", "@vscode", "vsce", "vsce");
run(process.execPath, [vsce, "package", "--no-dependencies", "--out", vsixPath], extensionDirectory);
await assertVsixContainsNoPrivateMaterial(vsixPath);
process.stdout.write(`${vsixPath}\n`);

function runNpm(args, cwd) {
  const candidates = [
    process.env.npm_execpath,
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
  if (npmCli) {
    run(process.env.npm_node_execpath || process.execPath, [npmCli, ...args], cwd);
    return;
  }
  if (process.platform === "win32") {
    throw new Error("npm-cli.js was not found. Start packaging with 'npm run vscode:package'.");
  }
  run("npm", args, cwd);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${result.status}.`);
}

function assertRequiredFiles(files) {
  const missing = files.filter((file) => !fs.existsSync(file));
  if (missing.length === 0) return;
  throw new Error(
    `Cannot package VSPiLink because required release files are missing:\n${missing.map((file) => `- ${path.relative(repositoryRoot, file)}`).join("\n")}`,
  );
}

async function assertVsixContainsNoPrivateMaterial(targetPath) {
  const forbiddenName = /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|clients\.json|refresh-tokens\.json|credentials(?:[-_.][^/]*)?\.json|tunnel-token(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx|log))$/i;
  // Match complete credential blocks, not format-marker strings legitimately
  // present in the hosting implementation itself.
  const forbiddenContent = /-----BEGIN (?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED) )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=,: -]+\r?\n){1,}-----END (?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED) )?PRIVATE KEY-----|-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n){1,}-----END CERTIFICATE-----|-----BEGIN ARGO TUNNEL TOKEN-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n){1,}-----END ARGO TUNNEL TOKEN-----/i;
  await new Promise((resolve, reject) => {
    yauzl.open(targetPath, { lazyEntries: true, autoClose: true }, (openError, archive) => {
      if (openError || !archive) {
        reject(new Error("Unable to inspect the VSIX contents."));
        return;
      }
      let settled = false;
      let entries = 0;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        archive.close();
        reject(new Error(message));
      };
      archive.once("error", () => fail("Unable to inspect the VSIX contents."));
      archive.once("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      archive.on("entry", (entry) => {
        entries += 1;
        if (entries > 50_000) return fail("The VSIX contains an unexpected number of files.");
        const normalized = entry.fileName.replaceAll("\\", "/");
        if (forbiddenName.test(normalized)) return fail("The VSIX contains a private file forbidden by the release policy.");
        if (normalized.endsWith("/")) {
          archive.readEntry();
          return;
        }
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail("Unable to inspect a file in the VSIX.");
          let tail = "";
          stream.on("data", (chunk) => {
            const text = `${tail}${chunk.toString("utf8")}`;
            if (forbiddenContent.test(text)) {
              stream.destroy();
              fail("The VSIX contains authentication material forbidden by the release policy.");
              return;
            }
            tail = text.slice(-128 * 1024);
          });
          stream.once("error", () => fail("Unable to inspect a file in the VSIX."));
          stream.once("end", () => {
            if (!settled) archive.readEntry();
          });
        });
      });
      archive.readEntry();
    });
  });
}
