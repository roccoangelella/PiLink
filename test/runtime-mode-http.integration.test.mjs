import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CLASSIC_TOOLS = ["bash", "edit", "find", "get_system_prompt", "grep", "ls", "read", "run", "write"];

test("single runtime mode exposes only the classic agent harness", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-single-mode-http-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  const port = await availablePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.resolve("dist/index.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      SERVER_URL: serverUrl,
      PI_RUNTIME_MODE: "single",
      PI_WORK_DIR: workspace,
      PI_DATA_DIR: dataDir,
      PI_AGENT_PROVIDER: "missing-provider",
      PI_AGENT_MODEL: "missing-model",
      JWT_SECRET: "a".repeat(32),
      PI_BOOTSTRAP_SECRET: "b".repeat(32),
    },
    stdio: "ignore",
  });

  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    if (!server.killed) server.kill("SIGINT");
    await onceExit(server);
    await fs.rm(root, { recursive: true, force: true });
  });

  const health = await waitForHealth(`${serverUrl}/health`);
  assert.equal(health.runtime_mode, "single");

  const adminResponse = await fetch(`${serverUrl}/admin/status`, {
    headers: { Authorization: `Bearer ${"b".repeat(32)}` },
  });
  assert.equal(adminResponse.status, 200);
  const admin = await adminResponse.json();
  assert.equal(admin.runtime_mode, "single");
  assert.equal(admin.agents.state, "ready");
  assert.deepEqual(admin.agents.runtime, { state: "ready", id: "pi-sdk" });
  assert.deepEqual(admin.agents.coordination, { state: "disabled", reason: "runtime_mode_single" });
  assert.equal(admin.agents.agents.max_concurrent, 1);

  const registration = await register(serverUrl);
  const accessToken = await token(serverUrl, registration);
  const transport = new StreamableHTTPClientTransport(new URL(`${serverUrl}/sse`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "single-mode-contract", version: "1.0.0" });
  clients.push(client);
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(tools, CLASSIC_TOOLS);
  assert.equal(tools.some((name) => name.startsWith("agent_")), false);
  assert.equal(tools.some((name) => name.startsWith("coordination_")), false);
});

async function register(serverUrl) {
  const response = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${"b".repeat(32)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Single Agent",
      grant_types: ["client_credentials"],
      scope: "mcp:tools",
    }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function token(serverUrl, registration) {
  const response = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: registration.client_id,
      client_secret: registration.client_secret,
      scope: "mcp:tools",
    }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).access_token;
}

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve) => listener.close(resolve));
  assert.ok(port);
  return port;
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PiLink single-mode server did not become healthy");
}

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}
