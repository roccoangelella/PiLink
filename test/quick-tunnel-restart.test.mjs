import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = path.resolve("dist/cli.js");

test("quick tunnel restart registers a new OAuth client without --setup", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-quick-restart-"));
  const configPath = path.join(root, ".env");
  const dataPath = path.join(root, "data");
  const fakeCloudflared = path.join(root, "cloudflared");
  const port = await availablePort();

  await fs.mkdir(dataPath);
  await fs.writeFile(configPath, [
    `PI_WORK_DIR=${root}`,
    `PI_DATA_DIR=${dataPath}`,
    "PI_RUNTIME_MODE=collaboration",
    `PORT=${port}`,
    `JWT_SECRET=${"a".repeat(32)}`,
    `PI_BOOTSTRAP_SECRET=${"b".repeat(32)}`,
    "PI_OAUTH_CONSENT_MODE=browser",
    "PI_OAUTH_PUBLIC_CHATGPT_DCR=true",
    "PI_HOSTING_MODE=quick-tunnel",
    "PI_CHAT_CLI=off",
  ].join("\n"));
  await fs.writeFile(path.join(dataPath, "clients.json"), JSON.stringify({
    clients: [{
      client_id: "pi_0123456789abcdef",
      client_secret_hash: "x".repeat(60),
      client_name: "Previous ChatGPT connector",
      redirect_uris: ["https://chatgpt.example/previous-callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "client_secret_post",
      scope: "mcp:tools offline_access",
      created_at: "2026-08-01T00:00:00.000Z",
      token_version: 1,
    }],
  }, null, 2));
  await fs.writeFile(fakeCloudflared, [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then exit 0; fi",
    "echo https://restart-test.trycloudflare.com",
    "exec sleep 30",
    "",
  ].join("\n"), { mode: 0o700 });

  const cliProcess = spawn(process.execPath, [cliPath, "start"], {
    cwd: root,
    env: {
      ...process.env,
      PILINK_CONFIG: configPath,
      PI_CLOUDFLARED_PATH: fakeCloudflared,
      PI_BROWSER_OPEN: "never",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    if (cliProcess.exitCode === null) cliProcess.kill("SIGINT");
    await fs.rm(root, { recursive: true, force: true });
  });

  let output = "";
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });

  await waitFor(() => output.includes("Paste callback URL here:"), 10_000).catch((error) => {
    throw new Error(`${error.message}\nCLI output:\n${output}`);
  });
  assert.match(output, /=== Cloudflare Quick Tunnel started ===/);
  assert.match(output, /=== First-time ChatGPT setup ===/);
  assert.doesNotMatch(output, /An OAuth client is already configured/);

  cliProcess.stdin.write("https://chatgpt.example/new-callback\n");
  await waitFor(() => output.includes("Scope: mcp:tools offline_access"), 10_000).catch((error) => {
    throw new Error(`${error.message}\nCLI output:\n${output}`);
  });

  const store = JSON.parse(await fs.readFile(path.join(dataPath, "clients.json"), "utf8"));
  assert.equal(store.clients.length, 2);
  assert.equal(store.clients[0].client_id, "pi_0123456789abcdef");
  assert.deepEqual(store.clients[1].redirect_uris, ["https://chatgpt.example/new-callback"]);

  cliProcess.kill("SIGINT");
  await once(cliProcess, "exit");
});

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Unable to allocate test port");
  return port;
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
