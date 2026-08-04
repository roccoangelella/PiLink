import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const BOOTSTRAP_SECRET = "b".repeat(32);

test("local admin agent bridge is private, bounded, and credential-free", async (t) => {
  const fixture = await startServer(t, false);
  assert.equal((await fetch(`${fixture.serverUrl}/admin/status`)).status, 403);
  const unknownAgentId = "agent_00000000-0000-4000-8000-000000000999";
  for (const operation of ["send", "cancel"]) {
    const unauthorized = await fetch(`${fixture.serverUrl}/admin/agents/${unknownAgentId}/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(operation === "send" ? { message: "private" } : {}),
    });
    assert.equal(unauthorized.status, 403);
    assert.deepEqual(await unauthorized.json(), { error: "forbidden" });
  }

  const statusResponse = await adminFetch(fixture.serverUrl, "/admin/status");
  assert.equal(statusResponse.status, 200);
  const statusText = await statusResponse.text();
  const status = JSON.parse(statusText);
  assert.equal(status.agents.state, "ready");
  assert.deepEqual(status.agents.runtime, { state: "ready", id: "pi-sdk" });
  assert.deepEqual(status.agents.coordination, { state: "ready" });
  assert.equal(statusText.includes("missing-provider"), false);
  assert.equal(statusText.includes("missing-model"), false);
  assert.equal(statusText.includes(BOOTSTRAP_SECRET), false);
  assert.equal(statusText.includes(fixture.workspace), false);
  assert.equal(statusText.includes(fixture.dataDir), false);

  const rejected = await adminFetch(fixture.serverUrl, "/admin/agents/spawn", {
    method: "POST",
    body: JSON.stringify({
      role: "developer",
      initial_message: "private prompt",
      workspace: "/",
      api_key: "must-not-appear",
    }),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.text()).includes("must-not-appear"), false);

  const spawnedResponse = await adminFetch(fixture.serverUrl, "/admin/agents/spawn", {
    method: "POST",
    body: JSON.stringify({ role: "developer", initial_message: "private-spawn-prompt" }),
  });
  assert.equal(spawnedResponse.status, 201);
  const spawnedText = await spawnedResponse.text();
  const spawned = JSON.parse(spawnedText).agent;
  assert.equal(spawned.status, "failed");
  assert.equal(spawnedText.includes("private-spawn-prompt"), false);
  assert.equal(spawnedText.includes("missing-provider"), false);
  assert.equal("workspace" in spawned, false);

  const list = await (await adminFetch(fixture.serverUrl, "/admin/agents")).json();
  assert.deepEqual(list.agents.map((agent) => agent.agent_id), [spawned.agent_id]);
  const one = await (await adminFetch(
    fixture.serverUrl,
    `/admin/agents/${encodeURIComponent(spawned.agent_id)}`,
  )).json();
  assert.equal(one.agent.agent_id, spawned.agent_id);
  assert.equal("last_error" in one.agent, false);
  const output = await (await adminFetch(
    fixture.serverUrl,
    `/admin/agents/${encodeURIComponent(spawned.agent_id)}/output`,
  )).json();
  assert.deepEqual(
    output.entries.map(({ channel, text }) => ({ channel, text })),
    [{ channel: "user", text: "private-spawn-prompt" }],
  );

  // The local UI applies a bounded list window. It must receive the newest
  // retained session first so the chat just opened by the user remains visible.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newestResponse = await adminFetch(fixture.serverUrl, "/admin/agents/spawn", {
    method: "POST",
    body: JSON.stringify({ role: "developer", initial_message: "newest-private-prompt" }),
  });
  assert.equal(newestResponse.status, 201);
  const newest = (await newestResponse.json()).agent;
  const newestWindow = await (await adminFetch(fixture.serverUrl, "/admin/agents?limit=1")).json();
  assert.deepEqual(newestWindow.agents.map((agent) => agent.agent_id), [newest.agent_id]);
  const orderedWindow = await (await adminFetch(fixture.serverUrl, "/admin/agents?limit=2")).json();
  assert.deepEqual(orderedWindow.agents.map((agent) => agent.agent_id), [newest.agent_id, spawned.agent_id]);

  const malformedSend = await adminFetch(
    fixture.serverUrl,
    `/admin/agents/${encodeURIComponent(spawned.agent_id)}/send`,
    {
      method: "POST",
      body: JSON.stringify({ message: "must-not-appear", extra: true }),
    },
  );
  assert.equal(malformedSend.status, 400);
  assert.equal((await malformedSend.text()).includes("must-not-appear"), false);
  const rejectedSend = await adminFetch(
    fixture.serverUrl,
    `/admin/agents/${encodeURIComponent(spawned.agent_id)}/send`,
    { method: "POST", body: JSON.stringify({ message: "follow-up" }) },
  );
  assert.equal(rejectedSend.status, 409);
  assert.deepEqual(await rejectedSend.json(), { error: "agent_send_rejected" });

  const malformedCancel = await adminFetch(
    fixture.serverUrl,
    `/admin/agents/${encodeURIComponent(spawned.agent_id)}/cancel`,
    { method: "POST", body: JSON.stringify({ reason: false }) },
  );
  assert.equal(malformedCancel.status, 400);
  const rejectedCancel = await adminFetch(
    fixture.serverUrl,
    `/admin/agents/${encodeURIComponent(spawned.agent_id)}/cancel`,
    { method: "POST", body: JSON.stringify({}) },
  );
  assert.equal(rejectedCancel.status, 409);
  assert.deepEqual(await rejectedCancel.json(), { error: "agent_cancel_failed" });

  const stopped = await adminFetch(
    fixture.serverUrl,
    `/admin/agents/${encodeURIComponent(spawned.agent_id)}/stop`,
    { method: "POST", body: JSON.stringify({ reason: "UI cleanup" }) },
  );
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).agent.agent_id, spawned.agent_id);
});

test("unsafe coordination data location degrades only coordination and remains explicit over MCP", async (t) => {
  const fixture = await startServer(t, true);
  const adminText = await (await adminFetch(fixture.serverUrl, "/admin/status")).text();
  const admin = JSON.parse(adminText);
  assert.equal(admin.agents.state, "degraded");
  assert.deepEqual(admin.agents.runtime, { state: "ready", id: "pi-sdk" });
  assert.deepEqual(admin.agents.coordination, { state: "unavailable", reason: "unsafe_data_location" });
  assert.equal(adminText.includes(fixture.workspace), false);
  assert.equal(adminText.includes("missing-provider"), false);

  const collaborationResponse = await adminFetch(fixture.serverUrl, "/admin/collaboration");
  assert.equal(collaborationResponse.status, 200);
  const collaborationText = await collaborationResponse.text();
  const collaboration = JSON.parse(collaborationText);
  assert.deepEqual(collaboration, {
    status: "degraded",
    error: "collaboration_unavailable",
    reason: "private_store_unavailable",
    project_key: null,
    chat: {
      oldest_cursor: 0,
      latest_cursor: 0,
      next_cursor: 0,
      gap: false,
      messages: [],
    },
    tasks: [],
    tool_activity: [],
    clients: [],
    timestamp: collaboration.timestamp,
  });
  assert.equal(collaborationText.includes(fixture.workspace), false);
  assert.equal(collaborationText.includes(fixture.dataDir), false);
  assert.equal(collaborationText.includes("must not be stored"), false);

  const accessToken = await registerAndToken(fixture.serverUrl);
  const session = await initialize(fixture.serverUrl, accessToken);
  const listed = await rpc(fixture.serverUrl, accessToken, session.sessionId, 2, "tools/list", {});
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("agent_spawn"));
  assert.ok(names.includes("agent_output_read"));
  assert.ok(names.includes("coordination_agent_chat_read"));

  const runtimeCall = await rpc(fixture.serverUrl, accessToken, session.sessionId, 3, "tools/call", {
    name: "agent_runtime_status",
    arguments: {},
  });
  const runtime = JSON.parse(runtimeCall.result.content[0].text);
  assert.deepEqual(runtime.coordination, { state: "unavailable", reason: "unsafe_data_location" });
  const chatCall = await rpc(fixture.serverUrl, accessToken, session.sessionId, 4, "tools/call", {
    name: "coordination_agent_chat_read",
    arguments: {},
  });
  assert.equal(chatCall.result.isError, true);
  assert.equal(chatCall.result.content[0].text, "Error: agent_coordination_unsafe_data_location");
});

test("a dedicated coordination directory keeps collaboration ready when OAuth data is under the workspace", async (t) => {
  const fixture = await startServer(t, true, false);
  await registerAndToken(fixture.serverUrl);
  await fs.access(path.join(fixture.dataDir, "clients.json"));

  const response = await adminFetch(fixture.serverUrl, "/admin/collaboration");
  assert.equal(response.status, 200);
  const collaboration = await response.json();
  assert.equal(collaboration.status, "ready");
  assert.match(collaboration.project_key, /^[a-f0-9]{64}$/u);
  assert.deepEqual(collaboration.chat.messages, []);
  assert.deepEqual(collaboration.tasks, []);
  assert.ok(fixture.coordinationDataDir.startsWith(`${fixture.root}${path.sep}`));
  assert.equal(fixture.coordinationDataDir.startsWith(`${fixture.workspace}${path.sep}`), false);
});

async function startServer(t, dataInsideWorkspace, coordinationDataInsideWorkspace = dataInsideWorkspace) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-agent-runtime-http-"));
  const workspace = path.join(root, "workspace");
  const dataDir = dataInsideWorkspace ? path.join(workspace, "private-data") : path.join(root, "private-data");
  const coordinationDataDir = coordinationDataInsideWorkspace
    ? path.join(workspace, "coordination-data")
    : path.join(root, "coordination-data");
  await fs.mkdir(workspace);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(coordinationDataDir, { recursive: true });
  const port = await availablePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  let stderr = "";
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
      PI_COORDINATION_DATA_DIR: coordinationDataDir,
      JWT_SECRET: "j".repeat(32),
      PI_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET,
      PI_OAUTH_CONSENT_MODE: "browser",
      PI_AGENT_PROVIDER: "missing-provider",
      PI_AGENT_MODEL: "missing-model",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGINT");
    await onceExit(server);
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForHealth(serverUrl, server, () => stderr);
  return { root, serverUrl, workspace, dataDir, coordinationDataDir };
}

async function adminFetch(serverUrl, pathname, options = {}) {
  return fetch(`${serverUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${BOOTSTRAP_SECRET}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
}

async function registerAndToken(serverUrl) {
  const registration = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BOOTSTRAP_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "agent-e2e", grant_types: ["client_credentials"], scope: "mcp:tools" }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const token = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: client.client_id,
      client_secret: client.client_secret,
      scope: "mcp:tools",
    }),
  });
  assert.equal(token.status, 200);
  return (await token.json()).access_token;
}

async function initialize(serverUrl, accessToken) {
  const response = await fetch(`${serverUrl}/sse`, {
    method: "POST",
    headers: mcpHeaders(accessToken),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
    }),
  });
  assert.equal(response.status, 200);
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  parseRpc(await response.text(), 1);
  const initialized = await fetch(`${serverUrl}/sse`, {
    method: "POST",
    headers: mcpHeaders(accessToken, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.ok([200, 202, 204].includes(initialized.status));
  await initialized.text();
  return { sessionId };
}

async function rpc(serverUrl, accessToken, sessionId, id, method, params) {
  const response = await fetch(`${serverUrl}/sse`, {
    method: "POST",
    headers: mcpHeaders(accessToken, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.equal(response.status, 200);
  return parseRpc(await response.text(), id);
}

function parseRpc(text, id) {
  const candidates = text.trim().startsWith("{")
    ? [JSON.parse(text)]
    : [...text.matchAll(/^data:\s*(.+)$/gmu)].map((match) => JSON.parse(match[1]));
  const selected = candidates.find((message) => message.id === id);
  assert.ok(selected, `Missing JSON-RPC response ${id}: ${text}`);
  assert.equal(selected.error, undefined, JSON.stringify(selected.error));
  return selected;
}

function mcpHeaders(accessToken, sessionId) {
  return {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Mcp-Protocol-Version": "2025-11-25",
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };
}

async function waitForHealth(serverUrl, server, stderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`PiLink exited early: ${stderr()}`);
    try {
      if ((await fetch(`${serverUrl}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`PiLink did not become healthy: ${stderr()}`);
}

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}
