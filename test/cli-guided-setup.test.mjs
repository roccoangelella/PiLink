import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = path.resolve("dist/cli.js");

test("init creates a private configuration for the current workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-init-"));
  const configPath = path.join(root, ".env");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await runCli(["init"], root, { PILINK_CONFIG: configPath });

  assert.equal(result.code, 0);
  assert.match(result.output, /Created private configuration/);
  const config = await fs.readFile(configPath, "utf8");
  assert.match(config, new RegExp(`PI_WORK_DIR=${escapeRegExp(root)}`));
  assert.match(config, /JWT_SECRET=.{32,}/);
  assert.match(config, /PI_BOOTSTRAP_SECRET=.{32,}/);
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
});

test("serve starts the local server without a tunnel", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-serve-"));
  const configPath = path.join(root, ".env");
  const port = await availablePort();
  await writeConfig(configPath, root, port);
  const cliProcess = spawnCli(["serve"], root, { PILINK_CONFIG: configPath });
  t.after(async () => {
    cliProcess.kill("SIGINT");
    await fs.rm(root, { recursive: true, force: true });
  });

  let output = "";
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  await waitFor(() => output.includes("PiLink Server"));
  const health = await fetch(`http://127.0.0.1:${port}/health`);

  assert.equal(health.status, 200);
  const status = await health.json();
  assert.equal(status.status, "ok");
  assert.equal(status.server, "pilink");
});

test("first start guides callback registration and persists a ChatGPT OAuth client", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-cli-"));
  const configPath = path.join(root, ".env");
  const fakeCloudflared = path.join(root, "cloudflared");
  const port = await availablePort();
  await fs.writeFile(configPath, [
    `PI_WORK_DIR=${root}`,
    `PI_DATA_DIR=${path.join(root, "data")}`,
    `PORT=${port}`,
    `JWT_SECRET=${"a".repeat(32)}`,
    `PI_BOOTSTRAP_SECRET=${"b".repeat(32)}`,
  ].join("\n"));
  await fs.writeFile(fakeCloudflared, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\necho https://cli-test.trycloudflare.com\nexec sleep 30\n", { mode: 0o700 });
  const cliProcess = spawnCli(["start"], root, { PILINK_CONFIG: configPath, PI_CLOUDFLARED_PATH: fakeCloudflared });
  t.after(async () => {
    cliProcess.kill("SIGINT");
    await fs.rm(root, { recursive: true, force: true });
  });
  let output = "";
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  await waitFor(() => output.includes("Paste callback URL here:"));
  const bannerIndex = output.indexOf("╚══════════════════════════════════════════════════╝");
  const promptIndex = output.indexOf("Paste callback URL here:");
  assert.ok(bannerIndex !== -1, "Server banner box should be printed");
  assert.ok(promptIndex !== -1, "Paste callback URL prompt should be printed");
  assert.ok(bannerIndex < promptIndex, "Server banner box must be printed before Paste callback URL prompt");
  cliProcess.stdin.write("https://chatgpt.example/callback\n");
  await waitFor(() => output.includes("ChatGPT OAuth client registered"));
  assert.match(output, /Client ID: pi_[a-f0-9]{16}/);
  assert.match(output, /Client secret: [A-Za-z0-9_-]{40,}/);
  assert.match(output, /Token endpoint auth method: client_secret_post/);
  const store = JSON.parse(await fs.readFile(path.join(root, "data", "clients.json"), "utf8"));
  assert.equal(store.clients.length, 1);
  assert.deepEqual(store.clients[0].redirect_uris, ["https://chatgpt.example/callback"]);
});

test("start --setup works after the saved workspace directory is renamed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-setup-"));
  const configPath = path.join(root, ".env");
  const dataPath = path.join(root, "data");
  const fakeCloudflared = path.join(root, "cloudflared");
  const port = await availablePort();
  const missingWorkspace = path.join(root, "previous-repository-name");
  await writeConfig(configPath, missingWorkspace, port, dataPath);
  await fs.mkdir(dataPath);
  await fs.writeFile(path.join(dataPath, "clients.json"), JSON.stringify({ clients: [{ client_id: "existing" }] }));
  await fs.writeFile(fakeCloudflared, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\necho https://cli-test.trycloudflare.com\nexec sleep 30\n", { mode: 0o700 });
  const cliProcess = spawnCli(["start", "--setup"], root, { PILINK_CONFIG: configPath, PI_CLOUDFLARED_PATH: fakeCloudflared });
  t.after(async () => {
    cliProcess.kill("SIGINT");
    await fs.rm(root, { recursive: true, force: true });
  });

  let output = "";
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  await waitFor(() => output.includes("Paste callback URL here:"));
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(output.endsWith("> "), "The callback prompt must remain the final output while input is pending");
  assert.doesNotMatch(output, /\[HTTP\] GET \/health/);
  cliProcess.stdin.write("https://chatgpt.example/renamed-repository-callback\n");
  await waitFor(() => output.includes("ChatGPT OAuth client registered"));
  assert.match(output, /\[HTTP\] GET \/health → 200/);

  const store = JSON.parse(await fs.readFile(path.join(dataPath, "clients.json"), "utf8"));
  assert.equal(store.clients.length, 2);
  assert.deepEqual(store.clients[1].redirect_uris, ["https://chatgpt.example/renamed-repository-callback"]);
});

test("reset --yes removes generated files without removing unrelated data", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-reset-"));
  const configPath = path.join(root, ".env");
  const dataPath = path.join(root, "data");
  await writeConfig(configPath, root, await availablePort(), dataPath);
  await fs.mkdir(path.join(root, "bin"));
  await fs.mkdir(dataPath);
  await fs.writeFile(path.join(dataPath, "clients.json"), "{}");
  await fs.writeFile(path.join(dataPath, "keep.txt"), "unrelated data");
  await fs.writeFile(path.join(root, "bin", "cloudflared"), "managed binary");
  await fs.writeFile(path.join(root, "bin", "keep.txt"), "unrelated binary");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await runCli(["reset", "--yes"], root, { PILINK_CONFIG: configPath });

  assert.equal(result.code, 0);
  assert.match(result.output, /PiLink state was reset/);
  await assert.rejects(fs.stat(configPath));
  await assert.rejects(fs.stat(path.join(dataPath, "clients.json")));
  await assert.rejects(fs.stat(path.join(root, "bin", "cloudflared")));
  assert.equal(await fs.readFile(path.join(dataPath, "keep.txt"), "utf8"), "unrelated data");
  assert.equal(await fs.readFile(path.join(root, "bin", "keep.txt"), "utf8"), "unrelated binary");
});

test("reset --yes does not delete the workspace when configuration is stored in it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-reset-workspace-"));
  const configPath = path.join(root, ".env");
  await fs.writeFile(configPath, [
    `PI_WORK_DIR=${root}`,
    `PORT=${await availablePort()}`,
    `JWT_SECRET=${"a".repeat(32)}`,
    `PI_BOOTSTRAP_SECRET=${"b".repeat(32)}`,
  ].join("\n"));
  await fs.writeFile(path.join(root, "clients.json"), "{}");
  await fs.writeFile(path.join(root, "repository-file.txt"), "must remain");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await runCli(["reset", "--yes"], root, { PILINK_CONFIG: configPath });

  assert.equal(result.code, 0);
  await assert.rejects(fs.stat(configPath));
  await assert.rejects(fs.stat(path.join(root, "clients.json")));
  assert.equal(await fs.readFile(path.join(root, "repository-file.txt"), "utf8"), "must remain");
});

function spawnCli(args, cwd, overrides) {
  return spawn(process.execPath, [cliPath, ...args], {
    cwd,
    env: cliEnvironment(overrides),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function runCli(args, cwd, overrides) {
  const cliProcess = spawnCli(args, cwd, overrides);
  let output = "";
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(cliProcess, "exit");
  return { code, output };
}

function cliEnvironment(overrides) {
  const env = { ...process.env };
  for (const name of ["PI_WORK_DIR", "PI_DATA_DIR", "PORT", "JWT_SECRET", "PI_BOOTSTRAP_SECRET", "SERVER_URL", "PILINK_CONFIG"]) {
    delete env[name];
  }
  return { ...env, ...overrides };
}

async function writeConfig(configPath, workspace, port, dataPath = path.join(path.dirname(configPath), "data")) {
  await fs.writeFile(configPath, [
    `PI_WORK_DIR=${workspace}`,
    `PI_DATA_DIR=${dataPath}`,
    `PORT=${port}`,
    `JWT_SECRET=${"a".repeat(32)}`,
    `PI_BOOTSTRAP_SECRET=${"b".repeat(32)}`,
  ].join("\n"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for CLI output");
}
