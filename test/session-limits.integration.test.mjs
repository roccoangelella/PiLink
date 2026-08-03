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

test("runtime configuration validates MCP session lifecycle settings", async () => {
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

    const configured = loadRuntimeConfig({
      ...base,
      PI_MAX_MCP_SESSIONS_TOTAL: "12",
      PI_MAX_MCP_SESSIONS_PER_CLIENT: "3",
      PI_MCP_SESSION_IDLE_TIMEOUT: "45",
      PI_MCP_SESSION_RECLAIM_GRACE: "7",
    });
    assert.equal(configured.maxMcpSessionsTotal, 12);
    assert.equal(configured.maxMcpSessionsPerClient, 3);
    assert.equal(configured.mcpSessionIdleTimeoutSeconds, 45);
    assert.equal(configured.mcpSessionReclaimGraceSeconds, 7);
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

test("parallel initialization cannot race past the quota", async (t) => {
  const fixture = await startServer(t, {
    PI_MAX_MCP_SESSIONS_TOTAL: "1",
    PI_MAX_MCP_SESSIONS_PER_CLIENT: "1",
    PI_MCP_SESSION_IDLE_TIMEOUT: "60",
    PI_MCP_SESSION_RECLAIM_GRACE: "60",
  });
  const client = await register(fixture.serverUrl, "Race client", "mcp:read");
  const accessToken = await token(fixture.serverUrl, client, "mcp:read");

  const racing = await Promise.all([
    initialize(fixture.serverUrl, accessToken, "race-a"),
    initialize(fixture.serverUrl, accessToken, "race-b"),
  ]);
  assert.deepEqual(racing.map(({ response }) => response.status).sort((a, b) => a - b), [200, 429]);
  const rejected = racing.find(({ response }) => response.status === 429).response;
  assert.equal(rejected.headers.get("retry-after"), "1");
  assert.equal((await rejected.json()).error, "too_many_sessions");

  const accepted = racing.find(({ response }) => response.status === 200);
  assert.ok(accepted.sessionId);
  await accepted.response.text();
  await terminate(fixture.serverUrl, accessToken, accepted.sessionId);
  await waitForActiveSessions(fixture.serverUrl, 0);
});

test("quota pressure immediately recycles an established quiescent session", async (t) => {
  const fixture = await startServer(t, {
    PI_MAX_MCP_SESSIONS_TOTAL: "1",
    PI_MAX_MCP_SESSIONS_PER_CLIENT: "1",
    PI_MCP_SESSION_IDLE_TIMEOUT: "60",
    PI_MCP_SESSION_RECLAIM_GRACE: "60",
  });
  const client = await register(fixture.serverUrl, "Pressure client", "mcp:read");
  const accessToken = await token(fixture.serverUrl, client, "mcp:read");

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
  assert.equal(status.sessions.busy, 0);
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
  const client = await register(fixture.serverUrl, "Handshake client", "mcp:read");
  const accessToken = await token(fixture.serverUrl, client, "mcp:read");

  const first = await initialize(fixture.serverUrl, accessToken, "unfinished-handshake");
  assert.equal(first.response.status, 200);
  assert.ok(first.sessionId);
  await first.response.text();

  const rejected = await initialize(fixture.serverUrl, accessToken, "must-not-recycle-unfinished");
  assert.equal(rejected.response.status, 429);
  assert.equal((await rejected.response.json()).error, "too_many_sessions");
  await terminate(fixture.serverUrl, accessToken, first.sessionId);
});

test("rapid reconnects from one ChatGPT connector do not exhaust the quota", async (t) => {
  const fixture = await startServer(t, {
    PI_MAX_MCP_SESSIONS_TOTAL: "4",
    PI_MAX_MCP_SESSIONS_PER_CLIENT: "4",
    PI_MCP_SESSION_IDLE_TIMEOUT: "60",
    PI_MCP_SESSION_RECLAIM_GRACE: "60",
  });
  const client = await register(fixture.serverUrl, "Reconnect client", "mcp:read");
  const accessToken = await token(fixture.serverUrl, client, "mcp:read");
  let latestSessionId;

  for (let attempt = 0; attempt < 80; attempt += 1) {
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

test("parallel reconnects from multiple public-chat agents remain bounded", async (t) => {
  const fixture = await startServer(t, {
    PI_MAX_MCP_SESSIONS_TOTAL: "12",
    PI_MAX_MCP_SESSIONS_PER_CLIENT: "4",
    PI_MCP_SESSION_IDLE_TIMEOUT: "60",
    PI_MCP_SESSION_RECLAIM_GRACE: "60",
  });
  const agentTokens = [];
  for (let agent = 0; agent < 6; agent += 1) {
    const client = await register(fixture.serverUrl, `Public chat agent ${agent}`, "mcp:read");
    agentTokens.push(await token(fixture.serverUrl, client, "mcp:read"));
  }

  const latestSessionIds = await Promise.all(agentTokens.map(async (accessToken, agent) => {
    let latestSessionId;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const connection = await initialize(fixture.serverUrl, accessToken, `agent-${agent}-reconnect-${attempt}`);
      assert.equal(connection.response.status, 200, `agent ${agent}, attempt ${attempt}`);
      assert.ok(connection.sessionId);
      await connection.response.text();
      await sendInitialized(fixture.serverUrl, accessToken, connection.sessionId);
      latestSessionId = connection.sessionId;
    }
    return latestSessionId;
  }));

  const status = await health(fixture.serverUrl);
  assert.ok(status.sessions.active <= 12, status.sessions.active);
  assert.equal(status.sessions.busy, 0);
  assert.equal(status.sessions.pending, 0);

  await Promise.all(latestSessionIds.map((sessionId, index) =>
    terminate(fixture.serverUrl, agentTokens[index], sessionId).catch(() => undefined),
  ));
});

test("parallel public-chat clients close cleanly and reconnect without accumulating", async (t) => {
  const fixture = await startServer(t, {
    PI_MAX_MCP_SESSIONS_TOTAL: "16",
    PI_MAX_MCP_SESSIONS_PER_CLIENT: "16",
    PI_MCP_SESSION_IDLE_TIMEOUT: "1",
    PI_MCP_SESSION_RECLAIM_GRACE: "5",
  });
  const registered = await register(fixture.serverUrl, "Parallel public-chat agent", "mcp:tools");
  const accessToken = await token(fixture.serverUrl, registered, "mcp:tools");

  const firstWave = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    connectStreamable(fixture, accessToken, `public-chat-wave-1-${index}`),
  ));
  await Promise.all(firstWave.map(({ client }, index) => client.callTool({
    name: "agent_chat_post",
    arguments: { agent_message: `parallel message ${index}` },
  })));

  const firstStatus = await health(fixture.serverUrl);
  assert.equal(firstStatus.sessions.active, 12);
  assert.equal(firstStatus.sessions.pending, 0);

  await Promise.all(firstWave.map(({ close }) => close()));
  await waitForBusySessions(fixture.serverUrl, 0);

  const quiescentAfterClose = await health(fixture.serverUrl);
  assert.equal(quiescentAfterClose.sessions.active, 12);
  assert.equal(quiescentAfterClose.sessions.busy, 0);

  const secondWave = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    connectStreamable(fixture, accessToken, `public-chat-wave-2-${index}`),
  ));
  const readResult = await secondWave[0].client.callTool({ name: "agent_chat_read", arguments: {} });
  const read = parseToolText(readResult);
  assert.equal(read.messages.length, 12);
  assert.deepEqual(
    new Set(read.messages.map((message) => message.agent_message)),
    new Set(Array.from({ length: 12 }, (_, index) => `parallel message ${index}`)),
  );

  const secondStatus = await health(fixture.serverUrl);
  assert.ok(secondStatus.sessions.active <= 16, secondStatus.sessions.active);
  assert.equal(secondStatus.sessions.busy, 12);
  assert.equal(secondStatus.sessions.pending, 0);
  await Promise.all(secondWave.map(({ close }) => close()));
  await waitForActiveSessions(fixture.serverUrl, 0, 5_000);
});

test("an open Streamable HTTP SSE stream survives idle cleanup and pressure", async (t) => {
  const fixture = await startServer(t, {
    PI_MAX_MCP_SESSIONS_TOTAL: "1",
    PI_MAX_MCP_SESSIONS_PER_CLIENT: "1",
    PI_MCP_SESSION_IDLE_TIMEOUT: "1",
    PI_MCP_SESSION_RECLAIM_GRACE: "1",
  });
  const client = await register(fixture.serverUrl, "Active stream client", "mcp:read");
  const accessToken = await token(fixture.serverUrl, client, "mcp:read");
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

test("quiescent sessions still expire after the idle timeout", async (t) => {
  const fixture = await startServer(t, {
    PI_MAX_MCP_SESSIONS_TOTAL: "2",
    PI_MAX_MCP_SESSIONS_PER_CLIENT: "2",
    PI_MCP_SESSION_IDLE_TIMEOUT: "1",
    PI_MCP_SESSION_RECLAIM_GRACE: "1",
  });
  const client = await register(fixture.serverUrl, "Idle client", "mcp:read");
  const accessToken = await token(fixture.serverUrl, client, "mcp:read");
  const initialized = await initialize(fixture.serverUrl, accessToken, "idle-session");
  assert.equal(initialized.response.status, 200);
  assert.ok(initialized.sessionId);
  await initialized.response.text();
  await sendInitialized(fixture.serverUrl, accessToken, initialized.sessionId);

  await waitForActiveSessions(fixture.serverUrl, 0, 5_000);
  const expired = await fetch(`${fixture.serverUrl}/sse`, {
    method: "POST",
    headers: mcpHeaders(accessToken, initialized.sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }),
  });
  assert.equal(expired.status, 404);
  assert.deepEqual(await expired.json(), { error: "Session not found or expired" });
});

test("legacy SSE streams remain active until the client disconnects", async (t) => {
  const fixture = await startServer(t, {
    PI_MAX_MCP_SESSIONS_TOTAL: "1",
    PI_MAX_MCP_SESSIONS_PER_CLIENT: "1",
    PI_MCP_SESSION_IDLE_TIMEOUT: "1",
    PI_MCP_SESSION_RECLAIM_GRACE: "1",
  });
  const first = await register(fixture.serverUrl, "Legacy First", "mcp:read");
  const second = await register(fixture.serverUrl, "Legacy Second", "mcp:read");
  const firstToken = await token(fixture.serverUrl, first, "mcp:read");
  const secondToken = await token(fixture.serverUrl, second, "mcp:read");

  const firstConnection = await connectLegacy(fixture, firstToken, "legacy-first");
  await delay(2_200);
  const active = await health(fixture.serverUrl);
  assert.equal(active.sessions.active, 1);
  assert.equal(active.sessions.busy, 1);

  await assert.rejects(
    connectLegacy(fixture, secondToken, "legacy-second-at-limit"),
    /429|too_many_sessions|active MCP session limit/i,
  );

  await firstConnection.close();
  await waitForActiveSessions(fixture.serverUrl, 0);
  const secondConnection = await connectLegacy(fixture, secondToken, "legacy-second-after-close");
  assert.equal((await health(fixture.serverUrl)).sessions.active, 1);
  await secondConnection.close();
  await waitForActiveSessions(fixture.serverUrl, 0);
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

function parseToolText(result) {
  return JSON.parse(result.content.find((item) => item.type === "text").text);
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
    await delay(50);
  }
  const current = await health(serverUrl);
  assert.equal(current.sessions.active, expected);
  assert.equal(current.sessions.pending, 0);
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

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
