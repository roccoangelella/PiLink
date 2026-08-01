import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadRuntimeConfig } from "../dist/config.js";

const bootstrapSecret = "b".repeat(32);

test("runtime configuration validates MCP session resource limits", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-session-config-"));
  try {
    const base = {
      PI_WORK_DIR: workspace,
      PILINK_CONFIG: path.join(workspace, "pilink.env"),
      JWT_SECRET: "j".repeat(32),
      PI_BOOTSTRAP_SECRET: bootstrapSecret,
    };
    const defaults = loadRuntimeConfig(base);
    assert.equal(defaults.maxMcpSessionsTotal, 64);
    assert.equal(defaults.maxMcpSessionsPerClient, 16);
    assert.equal(defaults.mcpSessionIdleTimeoutSeconds, 600);
    const config = loadRuntimeConfig({
      ...base,
      PI_MAX_MCP_SESSIONS_TOTAL: "12",
      PI_MAX_MCP_SESSIONS_PER_CLIENT: "3",
      PI_MCP_SESSION_IDLE_TIMEOUT: "45",
    });
    assert.equal(config.maxMcpSessionsTotal, 12);
    assert.equal(config.maxMcpSessionsPerClient, 3);
    assert.equal(config.mcpSessionIdleTimeoutSeconds, 45);
    assert.throws(
      () => loadRuntimeConfig({
        ...base,
        PI_MAX_MCP_SESSIONS_TOTAL: "2",
        PI_MAX_MCP_SESSIONS_PER_CLIENT: "3",
      }),
      /cannot exceed/,
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Streamable HTTP enforces race-safe quotas, 404 expiry, and idle cleanup", async (t) => {
  const fixture = await startServer(t, {
    PI_MAX_MCP_SESSIONS_TOTAL: "2",
    PI_MAX_MCP_SESSIONS_PER_CLIENT: "1",
    PI_MCP_SESSION_IDLE_TIMEOUT: "1",
  });
  const first = await register(fixture.serverUrl, "First", "mcp:read");
  const second = await register(fixture.serverUrl, "Second", "mcp:read");
  const third = await register(fixture.serverUrl, "Third", "mcp:read");
  const firstToken = await token(fixture.serverUrl, first, "mcp:read");
  const secondToken = await token(fixture.serverUrl, second, "mcp:read");
  const thirdToken = await token(fixture.serverUrl, third, "mcp:read");

  const racing = await Promise.all([
    rawInitialize(fixture.serverUrl, firstToken, "race-a"),
    rawInitialize(fixture.serverUrl, firstToken, "race-b"),
  ]);
  assert.deepEqual(racing.map((response) => response.status).sort((a, b) => a - b), [200, 429]);
  const rejectedRace = racing.find((response) => response.status === 429);
  assert.equal(rejectedRace.headers.get("retry-after"), "5");
  const rejectedBody = await rejectedRace.json();
  assert.equal(rejectedBody.error, "too_many_sessions");
  assert.equal(rejectedBody.limits.per_client, 1);
  const acceptedRace = racing.find((response) => response.status === 200);
  const racedSessionId = acceptedRace.headers.get("mcp-session-id");
  assert.ok(racedSessionId);
  await terminateRawSession(fixture.serverUrl, firstToken, racedSessionId);
  await waitForActiveSessions(fixture.serverUrl, 0);

  const firstConnection = await connectStreamable(fixture, firstToken, "first-client");
  const firstSessionId = firstConnection.transport.sessionId;
  assert.ok(firstSessionId);
  await assert.rejects(
    connectStreamable(fixture, firstToken, "first-client-duplicate"),
    /429|too_many_sessions|session limit/i,
  );

  const secondConnection = await connectStreamable(fixture, secondToken, "second-client");
  const secondSessionId = secondConnection.transport.sessionId;
  assert.ok(secondSessionId);
  await assert.rejects(
    connectStreamable(fixture, thirdToken, "third-client-over-total"),
    /429|too_many_sessions|total MCP session limit/i,
  );

  const statusAtLimit = await health(fixture.serverUrl);
  assert.deepEqual(statusAtLimit.sessions, {
    active: 2,
    pending: 0,
    max_total: 2,
    max_per_client: 1,
    idle_timeout_seconds: 1,
  });

  await waitForActiveSessions(fixture.serverUrl, 0, 5_000);
  for (const [accessToken, expiredSessionId] of [
    [firstToken, firstSessionId],
    [secondToken, secondSessionId],
  ]) {
    const expired = await fetch(`${fixture.serverUrl}/sse`, {
      method: "POST",
      headers: mcpHeaders(accessToken, expiredSessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }),
    });
    assert.equal(expired.status, 404);
    assert.deepEqual(await expired.json(), { error: "Session not found or expired" });
  }

  const thirdConnection = await connectStreamable(fixture, thirdToken, "third-client-after-expiry");
  assert.ok(thirdConnection.transport.sessionId);
  await thirdConnection.close();
  await firstConnection.close().catch(() => undefined);
  await secondConnection.close().catch(() => undefined);
});

test("legacy SSE shares per-client quotas and expires idle streams", async (t) => {
  const fixture = await startServer(t, {
    PI_MAX_MCP_SESSIONS_TOTAL: "1",
    PI_MAX_MCP_SESSIONS_PER_CLIENT: "1",
    PI_MCP_SESSION_IDLE_TIMEOUT: "1",
  });
  const first = await register(fixture.serverUrl, "Legacy First", "mcp:read");
  const second = await register(fixture.serverUrl, "Legacy Second", "mcp:read");
  const firstToken = await token(fixture.serverUrl, first, "mcp:read");
  const secondToken = await token(fixture.serverUrl, second, "mcp:read");

  const firstConnection = await connectLegacy(fixture, firstToken, "legacy-first");
  assert.equal((await health(fixture.serverUrl)).sessions.active, 1);

  await assert.rejects(
    connectLegacy(fixture, secondToken, "legacy-second-at-limit"),
    /429|too_many_sessions|total MCP session limit/i,
  );

  await waitForActiveSessions(fixture.serverUrl, 0, 5_000);
  const secondConnection = await connectLegacy(fixture, secondToken, "legacy-second-after-expiry");
  assert.equal((await health(fixture.serverUrl)).sessions.active, 1);

  await secondConnection.close();
  await firstConnection.close().catch(() => undefined);
  await waitForActiveSessions(fixture.serverUrl, 0);
});

async function startServer(t, limits) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-session-http-"));
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
      PI_WORK_DIR: workspace,
      PI_DATA_DIR: dataDir,
      JWT_SECRET: "a".repeat(32),
      PI_BOOTSTRAP_SECRET: bootstrapSecret,
      ...limits,
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
  await waitForHealth(serverUrl);
  return { root, serverUrl, clients };
}

async function connectStreamable(fixture, accessToken, name) {
  const transport = new StreamableHTTPClientTransport(new URL(`${fixture.serverUrl}/sse`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name, version: "1.0.0" });
  fixture.clients.push(client);
  await client.connect(transport);
  return {
    client,
    transport,
    close: () => client.close(),
  };
}

async function connectLegacy(fixture, accessToken, name) {
  const authorization = `Bearer ${accessToken}`;
  const transport = new SSEClientTransport(new URL(`${fixture.serverUrl}/sse`), {
    requestInit: { headers: { Authorization: authorization } },
  });
  const client = new Client({ name, version: "1.0.0" });
  fixture.clients.push(client);
  await client.connect(transport);
  return {
    client,
    transport,
    close: () => client.close(),
  };
}

async function rawInitialize(serverUrl, accessToken, clientName) {
  return fetch(`${serverUrl}/sse`, {
    method: "POST",
    headers: mcpHeaders(accessToken),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: clientName, version: "1.0.0" },
      },
    }),
  });
}

async function terminateRawSession(serverUrl, accessToken, sessionId) {
  const response = await fetch(`${serverUrl}/sse`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Mcp-Session-Id": sessionId,
      "Mcp-Protocol-Version": "2025-11-25",
    },
  });
  assert.ok([200, 202, 204].includes(response.status), response.status);
}

function mcpHeaders(accessToken, sessionId) {
  const headers = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Mcp-Protocol-Version": "2025-11-25",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  return headers;
}

async function register(serverUrl, clientName, scope) {
  const response = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bootstrapSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: clientName, grant_types: ["client_credentials"], scope }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function token(serverUrl, client, scope) {
  const response = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: client.client_id,
      client_secret: client.client_secret,
      scope,
    }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).access_token;
}

async function health(serverUrl) {
  const response = await fetch(`${serverUrl}/health`);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForActiveSessions(serverUrl, expected, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await health(serverUrl);
    if (current.sessions.active === expected && current.sessions.pending === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const current = await health(serverUrl);
  assert.equal(current.sessions.active, expected);
  assert.equal(current.sessions.pending, 0);
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

async function waitForHealth(serverUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${serverUrl}/health`)).ok) return;
    } catch {
      // Server has not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("PiLink did not become healthy");
}

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}
