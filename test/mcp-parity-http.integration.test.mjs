import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const AGENT_CHAT_URI = "pilink://agent-chat";

test("HTTP MCP wiring exposes verified roles, scope-pinned sessions, shared chat, and resource notifications", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-mcp-http-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  const port = await availablePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const clients = [];
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
      PI_BOOTSTRAP_SECRET: "b".repeat(32),
      PI_LAUNCH_EVENT_FD: "3",
    },
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  let launchEvents = "";
  server.stdio[3].setEncoding("utf8");
  server.stdio[3].on("data", (chunk) => {
    launchEvents += chunk;
  });

  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    if (!server.killed) server.kill("SIGINT");
    await onceExit(server);
    await fs.rm(root, { recursive: true, force: true });
  });

  await waitForHealth(`${serverUrl}/health`);
  const sender = await register(serverUrl, "Registered Sender", "mcp:tools");
  const receiver = await register(serverUrl, "Registered Receiver", "mcp:read");
  assert.equal(sender.client_name, "Registered Sender");
  assert.equal(receiver.client_name, "Registered Receiver");

  const senderToken = await token(serverUrl, sender, "mcp:tools");
  const senderNarrowToken = await token(serverUrl, sender, "mcp:read");
  const receiverToken = await token(serverUrl, receiver, "mcp:read");

  const legacyController = new AbortController();
  t.after(() => legacyController.abort());
  const legacyStream = await fetch(`${serverUrl}/sse`, {
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${senderToken}`,
    },
    signal: legacyController.signal,
  });
  assert.equal(legacyStream.status, 200);
  await waitFor(() => launchEvents.includes("mcp-connected\n"));
  assert.equal(launchEvents, "mcp-connected\n");
  legacyController.abort();
  await legacyStream.body?.cancel().catch(() => undefined);

  const senderTransport = new StreamableHTTPClientTransport(new URL(`${serverUrl}/sse`), {
    requestInit: { headers: { Authorization: `Bearer ${senderToken}` } },
  });
  const senderClient = new Client({ name: "http-sender", version: "1.0.0" });
  clients.push(senderClient);
  await senderClient.connect(senderTransport);
  assert.equal(launchEvents, "mcp-connected\n");
  const tools = (await senderClient.listTools()).tools;
  assert.ok(tools.some((tool) => tool.name === "collaboration_bootstrap"));
  const bootstrap = parseText(await senderClient.callTool({
    name: "collaboration_bootstrap",
    arguments: { requested_role_label: "Software Engineer 1" },
  }));
  assert.equal(bootstrap.assigned_role_id, "implementer");
  assert.equal(bootstrap.occupancy_label, "dev1");
  assert.match(bootstrap.collaboration_session_id, /^cs_[A-Za-z0-9_-]{24}$/u);

  const sessionId = senderTransport.sessionId;
  assert.ok(sessionId);
  const narrowerReuse = await fetch(`${serverUrl}/sse`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${senderNarrowToken}`,
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }),
  });
  assert.equal(narrowerReuse.status, 403);
  assert.deepEqual(await narrowerReuse.json(), {
    error: "forbidden",
    error_description: "Session belongs to another client",
  });

  const receiverTransport = new StreamableHTTPClientTransport(new URL(`${serverUrl}/sse`), {
    requestInit: { headers: { Authorization: `Bearer ${receiverToken}` } },
  });
  const receiverClient = new Client({ name: "http-receiver", version: "1.0.0" });
  clients.push(receiverClient);
  const notifications = [];
  receiverClient.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => notifications.push(notification));
  await receiverClient.connect(receiverTransport);
  await receiverClient.subscribeResource({ uri: AGENT_CHAT_URI });
  const forged = await senderClient.callTool({
    name: "agent_chat_post",
    arguments: { agent_name: "Forged Sender", agent_message: "must fail" },
  });
  assert.equal(forged.isError, true);

  const postedResult = await senderClient.callTool({
    name: "agent_chat_post",
    arguments: { agent_message: "coordinate" },
  });
  const posted = parseText(postedResult);
  assert.equal(posted.cursor, 1);
  assert.equal(posted.agent_id, sender.client_id);
  assert.equal(typeof posted.agent_instance_id, "string");
  assert.ok(posted.agent_instance_id.length > 0);
  assert.equal(posted.agent_name, "Registered Sender");
  assert.equal(posted.agent_message, "coordinate");
  assert.deepEqual(postedResult.structuredContent, posted);

  const receivedResult = await receiverClient.callTool({ name: "agent_chat_read", arguments: {} });
  const received = parseText(receivedResult);
  assert.deepEqual(received.messages, [posted]);
  assert.deepEqual(receivedResult.structuredContent, received);
  assert.equal(received.messages[0].agent_id, sender.client_id);
  assert.equal(received.messages[0].agent_name, sender.client_name);
  await waitFor(() => notifications.length > 0);
  assert.deepEqual(notifications[0], {
    method: "notifications/resources/updated",
    params: { uri: AGENT_CHAT_URI },
  });
});

async function register(serverUrl, clientName, scope) {
  const response = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${"b".repeat(32)}`, "Content-Type": "application/json" },
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

function parseText(result) {
  return JSON.parse(result.content.find((item) => item.type === "text").text);
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
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The child process has not bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PiLink did not become healthy");
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for MCP notification");
}

function onceExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}
