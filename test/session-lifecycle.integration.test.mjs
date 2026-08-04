import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../dist/config.js";

const bootstrapSecret = "b".repeat(32);

test("runtime configuration validates session limits and reclaim grace", async () => {
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
    assert.equal(defaults.mcpSessionReclaimGraceSeconds, 5);
    assert.equal(defaults.publicChatGptDcr, false);
    assert.equal(defaults.dataDir, path.dirname(base.PILINK_CONFIG));
    assert.equal(defaults.coordinationDataDir, defaults.dataDir);

    const oauthDataDir = path.join(workspace, "oauth-data");
    const coordinationDataDir = path.join(path.dirname(workspace), "coordination-data");
    const splitData = loadRuntimeConfig({
      ...base,
      PI_DATA_DIR: oauthDataDir,
      PI_COORDINATION_DATA_DIR: coordinationDataDir,
    });
    assert.equal(splitData.dataDir, path.resolve(oauthDataDir));
    assert.equal(splitData.coordinationDataDir, path.resolve(coordinationDataDir));

    const configured = loadRuntimeConfig({
      ...base,
      PI_MAX_MCP_SESSIONS_TOTAL: "12",
      PI_MAX_MCP_SESSIONS_PER_CLIENT: "3",
      PI_MCP_SESSION_IDLE_TIMEOUT: "45",
      PI_MCP_SESSION_RECLAIM_GRACE: "7",
      PI_OAUTH_PUBLIC_CHATGPT_DCR: "true",
    });
    assert.equal(configured.maxMcpSessionsTotal, 12);
    assert.equal(configured.maxMcpSessionsPerClient, 3);
    assert.equal(configured.mcpSessionIdleTimeoutSeconds, 45);
    assert.equal(configured.mcpSessionReclaimGraceSeconds, 7);
    assert.equal(configured.publicChatGptDcr, true);
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

test("quota pressure immediately recycles an established quiescent session", async (t) => {
  const fixture = await startServer(t, {
    PI_MAX_MCP_SESSIONS_TOTAL: "1",
    PI_MAX_MCP_SESSIONS_PER_CLIENT: "1",
    PI_MCP_SESSION_IDLE_TIMEOUT: "60",
    PI_MCP_SESSION_RECLAIM_GRACE: "60",
  });
  const accessToken = await registerAndToken(fixture.serverUrl, "pressure-client");

  const first = await initialize(fixture.serverUrl, accessToken, "first-session");
  assert.equal(first.response.status, 200);
  assert.ok(first.sessionId);
  await first.response.text();
  await sendInitialized(fixture.serverUrl, accessToken, first.sessionId);

  const replacement = await initialize(fixture.serverUrl, accessToken, "replacement-session");
  assert.equal(replacement.response.status, 200);
  assert.ok(replacement.sessionId);
  await replacement.response.text();
  assert.notEqual(replacement.sessionId, first.sessionId);

  const oldSession = await fetch(`${fixture.serverUrl}/sse`, {
    method: "POST",
    headers: mcpHeaders(accessToken, first.sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
  });
  assert.equal(oldSession.status, 404);
  assert.deepEqual(await oldSession.json(), { error: "Session not found or expired" });

  const status = await health(fixture.serverUrl);
  assert.equal(status.sessions.active, 1);
  assert.equal(status.sessions.pending, 0);
  await terminate(fixture.serverUrl, accessToken, replacement.sessionId);
});

test("an incomplete handshake remains protected by the reclaim grace", async (t) => {
  const fixture = await startServer(t, {
    PI_MAX_MCP_SESSIONS_TOTAL: "1",
    PI_MAX_MCP_SESSIONS_PER_CLIENT: "1",
    PI_MCP_SESSION_IDLE_TIMEOUT: "60",
    PI_MCP_SESSION_RECLAIM_GRACE: "60",
  });
  const accessToken = await registerAndToken(fixture.serverUrl, "handshake-client");

  const first = await initialize(fixture.serverUrl, accessToken, "unfinished-handshake");
  assert.equal(first.response.status, 200);
  assert.ok(first.sessionId);
  await first.response.text();

  const rejected = await initialize(fixture.serverUrl, accessToken, "must-not-recycle-unfinished");
  assert.equal(rejected.response.status, 429);
  assert.equal((await rejected.response.json()).error, "too_many_sessions");
  await terminate(fixture.serverUrl, accessToken, first.sessionId);
});

test("rapid established reconnects do not exhaust the session quota", async (t) => {
  const fixture = await startServer(t, {
    PI_MAX_MCP_SESSIONS_TOTAL: "4",
    PI_MAX_MCP_SESSIONS_PER_CLIENT: "4",
    PI_MCP_SESSION_IDLE_TIMEOUT: "60",
    PI_MCP_SESSION_RECLAIM_GRACE: "60",
  });
  const accessToken = await registerAndToken(fixture.serverUrl, "reconnect-client");
  let latestSessionId;

  for (let attempt = 0; attempt < 44; attempt += 1) {
    const connection = await initialize(fixture.serverUrl, accessToken, `reconnect-${attempt}`);
    assert.equal(connection.response.status, 200, `attempt ${attempt}`);
    assert.ok(connection.sessionId);
    await connection.response.text();
    await sendInitialized(fixture.serverUrl, accessToken, connection.sessionId);
    latestSessionId = connection.sessionId;
  }

  const status = await health(fixture.serverUrl);
  assert.equal(status.sessions.active, 4);
  assert.equal(status.sessions.busy, 0);
  assert.equal(status.sessions.pending, 0);
  await terminate(fixture.serverUrl, accessToken, latestSessionId);
});

test("an open Streamable HTTP SSE stream survives the idle timeout and is never pressure-recycled", async (t) => {
  const fixture = await startServer(t, {
    PI_MAX_MCP_SESSIONS_TOTAL: "1",
    PI_MAX_MCP_SESSIONS_PER_CLIENT: "1",
    PI_MCP_SESSION_IDLE_TIMEOUT: "1",
    PI_MCP_SESSION_RECLAIM_GRACE: "1",
  });
  const accessToken = await registerAndToken(fixture.serverUrl, "active-stream-client");
  const initialized = await initialize(fixture.serverUrl, accessToken, "active-stream-session");
  assert.equal(initialized.response.status, 200);
  assert.ok(initialized.sessionId);
  await initialized.response.text();
  await sendInitialized(fixture.serverUrl, accessToken, initialized.sessionId);

  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${fixture.serverUrl}/sse`, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${accessToken}`,
      "Mcp-Session-Id": initialized.sessionId,
      "Mcp-Protocol-Version": "2025-11-25",
    },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  await waitForBusySessions(fixture.serverUrl, 1);

  await delay(2_200);
  const stillActive = await health(fixture.serverUrl);
  assert.equal(stillActive.sessions.active, 1);
  assert.equal(stillActive.sessions.busy, 1);

  const rejected = await initialize(fixture.serverUrl, accessToken, "must-not-evict-active-stream");
  assert.equal(rejected.response.status, 429);
  assert.equal(rejected.response.headers.get("retry-after"), "1");
  assert.equal((await rejected.response.json()).error, "too_many_sessions");

  controller.abort();
  await stream.body?.cancel().catch(() => undefined);
});

async function startServer(t, limits) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-session-http-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  await fs.mkdir(dataDir);
  const port = await availablePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.resolve("dist/index.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      SERVER_URL: serverUrl,
      PILINK_CONFIG: path.join(root, "test.env"),
      PI_WORK_DIR: workspace,
      PI_DATA_DIR: dataDir,
      JWT_SECRET: "a".repeat(32),
      PI_BOOTSTRAP_SECRET: bootstrapSecret,
      PI_OAUTH_CONSENT_MODE: "browser",
      ...limits,
    },
    stdio: "ignore",
  });
  t.after(async () => {
    if (!server.killed) server.kill("SIGINT");
    await onceExit(server);
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForHealth(serverUrl);
  return { root, serverUrl };
}

async function registerAndToken(serverUrl, clientName) {
  const registration = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bootstrapSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_name: clientName,
      grant_types: ["client_credentials"],
      scope: "mcp:read",
    }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const tokenResponse = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: client.client_id,
      client_secret: client.client_secret,
      scope: "mcp:read",
    }),
  });
  assert.equal(tokenResponse.status, 200);
  return (await tokenResponse.json()).access_token;
}

async function initialize(serverUrl, accessToken, clientName) {
  const response = await fetch(`${serverUrl}/sse`, {
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
  return { response, sessionId: response.headers.get("mcp-session-id") };
}

async function sendInitialized(serverUrl, accessToken, sessionId) {
  const response = await fetch(`${serverUrl}/sse`, {
    method: "POST",
    headers: mcpHeaders(accessToken, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.ok([200, 202, 204].includes(response.status), response.status);
  await response.text();
}

async function terminate(serverUrl, accessToken, sessionId) {
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

async function health(serverUrl) {
  const response = await fetch(`${serverUrl}/health`);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForHealth(serverUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${serverUrl}/health`)).ok) return;
    } catch {
      // Server has not bound yet.
    }
    await delay(50);
  }
  throw new Error("PiLink did not become healthy");
}

async function waitForBusySessions(serverUrl, expected) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = await health(serverUrl);
    if (status.sessions.busy === expected) return;
    await delay(25);
  }
  const status = await health(serverUrl);
  assert.equal(status.sessions.busy, expected);
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

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
