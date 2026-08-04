import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = path.resolve("dist/cli.js");
const TUNNEL_ID = "47a9020d-fe41-4971-a063-2dcabee7a8d4";
const TOKEN_VALUE = "SUPER_SECRET_TUNNEL_TOKEN_MUST_NOT_BE_PRINTED";

test("production hosting CLI performs an explicit JSON dry-run/apply cutover without leaking secrets", async (t) => {
  const fixture = await createFixture(t);

  const inspected = await runHosting(fixture, "inspect");
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.equal(inspected.json.ok, true);
  assert.equal(inspected.json.dryRun, true);
  assert.equal(inspected.json.result.authentication.kind, "tunnel-token-file");
  assert.equal(inspected.json.result.authentication.secure, true);
  assertSafeOutput(inspected, fixture);

  const preview = await runHosting(fixture, "provision");
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(preview.json.result.changed, true);
  assert.equal(await exists(fixture.stateDirectory), false);
  assertSafeOutput(preview, fixture);

  const provisioned = await runHosting(fixture, "provision", ["--apply"]);
  assert.equal(provisioned.code, 0, provisioned.stderr);
  assert.equal(provisioned.json.dryRun, false);
  assert.equal((await fs.stat(fixture.stateDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(fixture.hostingConfigPath)).mode & 0o777, 0o600);
  assertSafeOutput(provisioned, fixture);

  const installPreview = await runHosting(fixture, "install");
  assert.equal(installPreview.code, 0, installPreview.stderr);
  assert.equal(installPreview.json.result.readyForInstall, true);
  assert.equal(await exists(fixture.systemdUserDirectory), false);

  const installed = await runHosting(fixture, "install", ["--apply"]);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(installed.json.result.installation.verified, true);
  for (const name of ["vspilink-server.service", "vspilink-cloudflared.service"]) {
    const unitPath = path.join(fixture.systemdUserDirectory, name);
    assert.equal((await fs.stat(unitPath)).mode & 0o777, 0o600);
  }
  assertSafeOutput(installed, fixture);

  const enablePreview = await runHosting(fixture, "enable");
  assert.equal(enablePreview.code, 0, enablePreview.stderr);
  assert.equal(enablePreview.json.result.changed, true);
  assert.equal(await exists(path.join(fixture.fakeState, "enabled")), false);
  const enabled = await runHosting(fixture, "enable", ["--apply"]);
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.equal(enabled.json.result.state, "enabled");

  const startPreview = await runHosting(fixture, "start");
  assert.equal(startPreview.code, 0, startPreview.stderr);
  assert.equal(startPreview.json.result.dryRun, true);
  assert.equal(await exists(path.join(fixture.fakeState, "vspilink-server.service.active")), false);
  const started = await runHosting(fixture, "start", ["--apply"]);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(started.json.result.state, "active");

  const status = await runHosting(fixture, "status");
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.json.result.productionReady, true);
  assert.equal(status.json.result.systemd.tunnelEnableState, "enabled");
  assert.equal(status.json.result.hosting.service.serverState, "active");
  assert.equal(status.json.result.hosting.service.state, "active");
  assertSafeOutput(status, fixture);

  const stopped = await runHosting(fixture, "stop", ["--apply"]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(stopped.json.result.state, "inactive");
  const disabled = await runHosting(fixture, "disable", ["--apply"]);
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.equal(disabled.json.result.state, "disabled");
});

test("hosting CLI rejects secret values in argv and apply on read-only commands", async (t) => {
  const fixture = await createFixture(t);
  const secret = "argv-secret-must-not-echo";
  const secretResult = await runRaw(fixture, ["hosting", "inspect", "--token", secret]);
  assert.equal(secretResult.code, 1);
  assert.equal(secretResult.json.error.code, "HOSTING_SECRET_IN_ARGV");
  assert.doesNotMatch(`${secretResult.stdout}\n${secretResult.stderr}`, new RegExp(secret));

  const applyResult = await runHosting(fixture, "status", ["--apply"]);
  assert.equal(applyResult.code, 1);
  assert.equal(applyResult.json.error.code, "HOSTING_APPLY_NOT_ALLOWED");
});

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-hosting-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const secrets = path.join(root, "secrets");
  const xdgConfigHome = path.join(root, "xdg");
  const systemdUserDirectory = path.join(xdgConfigHome, "systemd", "user");
  const fakeState = path.join(root, "fake-systemd-state");
  const stateDirectory = path.join(root, "hosting-state");
  const hostingConfigPath = path.join(stateDirectory, "config.yml");
  const tokenFile = path.join(secrets, "tunnel-token");
  const pilinkConfigPath = path.join(secrets, "pilink.env");
  const pilinkCliPath = path.join(root, "runtime", "dist", "cli.js");
  const port = await availablePort();
  await Promise.all([
    fs.mkdir(bin, { recursive: true, mode: 0o700 }),
    fs.mkdir(secrets, { recursive: true, mode: 0o700 }),
    fs.mkdir(path.dirname(pilinkCliPath), { recursive: true, mode: 0o700 }),
    fs.mkdir(fakeState, { recursive: true, mode: 0o700 }),
  ]);
  await fs.writeFile(tokenFile, TOKEN_VALUE, { mode: 0o600 });
  await fs.writeFile(pilinkConfigPath, "JWT_SECRET=fixture-only\n", { mode: 0o600 });
  await fs.writeFile(pilinkCliPath, "// fixture entrypoint\n", { mode: 0o644 });

  const cloudflaredPath = path.join(bin, "cloudflared");
  const nodePath = path.join(bin, "node-24.18.0");
  const systemctlPath = path.join(bin, "systemctl");
  const systemdAnalyzePath = path.join(bin, "systemd-analyze");
  await writeExecutable(cloudflaredPath, `#!/usr/bin/env node\nif (process.argv[2] === '--version') { console.log('cloudflared version 2026.7.3'); process.exit(0); } process.exit(2);\n`);
  await writeExecutable(nodePath, `#!/usr/bin/env node\nif (process.argv[2] === '--version') { console.log('v24.18.0'); process.exit(0); } process.exit(2);\n`);
  await writeExecutable(systemdAnalyzePath, `#!/usr/bin/env node\nif (process.argv[2] === '--version') { console.log('systemd 257'); process.exit(0); } if (process.argv[2] === '--user' && process.argv[3] === 'verify') process.exit(0); process.exit(2);\n`);
  await writeExecutable(systemctlPath, systemctlFixtureSource());

  const baseOptions = [
    "--tunnel-name", "vspilink-example",
    "--origin", `http://127.0.0.1:${port}`,
    "--zone", "example.com",
    "--mcp-hostname", "mcp.example.com",
    "--landing-hostname", "vspilink.example.com",
    "--auth-mode", "token-file",
    "--token-file", tokenFile,
    "--tunnel-id", TUNNEL_ID,
    "--state-dir", stateDirectory,
    "--cloudflared-path", cloudflaredPath,
    "--node-path", nodePath,
    "--pilink-cli-path", pilinkCliPath,
    "--pilink-config-path", pilinkConfigPath,
    "--systemctl-path", systemctlPath,
    "--systemd-analyze-path", systemdAnalyzePath,
    "--systemd-user-dir", systemdUserDirectory,
  ];
  return {
    root,
    tokenFile,
    fakeState,
    stateDirectory,
    hostingConfigPath,
    xdgConfigHome,
    systemdUserDirectory,
    baseOptions,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfigHome,
      FAKE_SYSTEMD_STATE: fakeState,
    },
  };
}

async function runHosting(fixture, command, additional = []) {
  return await runRaw(fixture, ["hosting", command, ...fixture.baseOptions, ...additional]);
}

async function runRaw(fixture, args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: fixture.root,
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const serialized = (code === 0 ? stdout : stderr).trim();
  assert.ok(serialized, `expected JSON output (stdout=${stdout}, stderr=${stderr})`);
  const lines = serialized.split(/\r?\n/);
  assert.equal(lines.length, 1, `expected exactly one JSON line: ${serialized}`);
  return { code, stdout, stderr, json: JSON.parse(lines[0]) };
}

function assertSafeOutput(result, fixture) {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(output, new RegExp(TOKEN_VALUE));
  assert.doesNotMatch(output, new RegExp(escapeRegExp(fixture.tokenFile)));
  assert.doesNotMatch(output, /credentials-contents|client_secret|ARGO TUNNEL TOKEN/i);
}

async function writeExecutable(targetPath, source) {
  await fs.writeFile(targetPath, source, { mode: 0o700 });
  await fs.chmod(targetPath, 0o700);
}

function systemctlFixtureSource() {
  return `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const state = process.env.FAKE_SYSTEMD_STATE;
if (!state || !path.isAbsolute(state)) process.exit(90);
const args = process.argv.slice(2);
const operation = args[1];
const unit = args[2];
const marker = (name) => path.join(state, name);
if (operation === 'is-enabled') {
  if (fs.existsSync(marker('enabled'))) { console.log('enabled'); process.exit(0); }
  console.log('disabled'); process.exit(1);
}
if (operation === 'is-active') {
  if (fs.existsSync(marker(unit + '.active'))) { console.log('active'); process.exit(0); }
  console.log('inactive'); process.exit(3);
}
if (operation === 'daemon-reload') process.exit(0);
if (operation === 'enable') { fs.writeFileSync(marker('enabled'), '1', { mode: 0o600 }); process.exit(0); }
if (operation === 'disable') { fs.rmSync(marker('enabled'), { force: true }); process.exit(0); }
if (operation === 'start') {
  fs.writeFileSync(marker('vspilink-server.service.active'), '1', { mode: 0o600 });
  fs.writeFileSync(marker('vspilink-cloudflared.service.active'), '1', { mode: 0o600 });
  process.exit(0);
}
if (operation === 'stop') {
  for (const name of args.slice(2)) fs.rmSync(marker(name + '.active'), { force: true });
  process.exit(0);
}
process.exit(2);
`;
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
