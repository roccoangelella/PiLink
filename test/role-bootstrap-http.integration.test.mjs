import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

test("real HTTP server exposes role bootstrap and isolates same-OAuth conversations", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-role-bootstrap-http-"));
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
      JWT_SECRET: "r".repeat(32),
      PI_BOOTSTRAP_SECRET: "s".repeat(32),
      PI_MAX_MCP_SESSIONS_TOTAL: "2",
      PI_MAX_MCP_SESSIONS_PER_CLIENT: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const diagnostics = captureChildDiagnostics(server);

  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await stopServer(server, diagnostics);
    await fs.rm(root, { recursive: true, force: true });
  });

  await waitForHealth(`${serverUrl}/health`, server, diagnostics);
  const registered = await register(serverUrl, "Shared ChatGPT OAuth Actor", "mcp:tools");
  const accessToken = await token(serverUrl, registered, "mcp:tools");
  const first = await connectRawPostOnlySession(serverUrl, accessToken, "same-oauth-conversation-1", diagnostics);
  const second = await connectClient(serverUrl, accessToken, "same-oauth-conversation-2", diagnostics);
  clients.push(second.client);

  const tools = (await second.client.listTools()).tools;
  assert.ok(tools.some((tool) => tool.name === "collaboration_bootstrap"));
  const firstResult = parseRawToolResult(await first.callTool(
    "collaboration_bootstrap",
    { requested_role_label: "Software Engineer 1" },
  ));
  const secondResult = parseText(await second.client.callTool({
    name: "collaboration_bootstrap",
    arguments: { requested_role_label: "Software Engineer 2" },
  }));

  assert.match(firstResult.collaboration_session_id, /^cs_[A-Za-z0-9_-]{24}$/);
  assert.match(secondResult.collaboration_session_id, /^cs_[A-Za-z0-9_-]{24}$/);
  assert.notEqual(firstResult.collaboration_session_id, secondResult.collaboration_session_id);
  assert.equal(firstResult.assigned_role_id, "implementer");
  assert.equal(secondResult.assigned_role_id, "implementer");
  assert.equal(firstResult.occupancy_label, "dev1");
  assert.equal(secondResult.occupancy_label, "dev2");
  assert.equal(firstResult.contract_id, "pilink-collaboration/implementer");
  assert.equal(secondResult.contract_version, "1.1.0");

  const visible = JSON.stringify({ firstResult, secondResult });
  assert.equal(visible.includes("Software Engineer 1"), false);
  assert.equal(visible.includes("Software Engineer 2"), false);
  assert.equal(visible.includes("collaborationSessionHandle"), false);
  assert.equal(visible.includes("credentialVerifier"), false);
  assert.equal(visible.includes("resumeRecovery"), false);

  const firstGuidance = parseRawToolText(await first.callTool("get_system_prompt", {}));
  const secondGuidance = parseTextString(await second.client.callTool({ name: "get_system_prompt", arguments: {} }));
  assert.match(firstGuidance, /Occupancy label: dev1/);
  assert.match(secondGuidance, /Occupancy label: dev2/);
  assert.notEqual(firstGuidance, secondGuidance);

  const collaborationStatePath = await findCollaborationSessionStatePath(dataDir);
  const collaborationLockPath = `${collaborationStatePath}.lock`;
  await fs.writeFile(collaborationLockPath, `${process.pid}:delete-response-barrier\n`, {
    flag: "wx",
    mode: 0o600,
  });
  let deleteSettled = false;
  const deletePromise = fetch(`${serverUrl}/sse`, {
    method: "DELETE",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
      "Mcp-Session-Id": second.transport.sessionId,
    },
  }).then((response) => {
    deleteSettled = true;
    return response;
  });
  try {
    await waitForDiagnostic(
      diagnostics,
      `Streamable HTTP session closed: ${second.transport.sessionId}`,
    );
    assert.equal(deleteSettled, false, "DELETE acknowledged before collaboration disposal completed");
  } finally {
    await fs.rm(collaborationLockPath, { force: true });
  }
  const deleted = await deletePromise;
  assert.ok(deleted.ok, `DELETE failed with ${deleted.status}: ${await deleted.text()}`);

  const replacement = await connectClient(serverUrl, accessToken, "same-oauth-replacement", diagnostics);
  clients.push(replacement.client);
  const replacementResult = parseText(await replacement.client.callTool({
    name: "collaboration_bootstrap",
    arguments: { requested_role_label: "Researcher" },
  }));
  assert.equal(replacementResult.assigned_role_id, "researcher");
  let persisted = await readCollaborationSessions(dataDir);
  assert.equal(findSession(persisted, secondResult.collaboration_session_id).status, "released");
  assert.equal(findSession(persisted, replacementResult.collaboration_session_id).status, "active");

  // The first MCP session is POST-only, established, and has no open stream, so
  // it is immediately reclaimable without sleeps or client-close timing races.
  const recycledReplacement = await connectClient(serverUrl, accessToken, "same-oauth-quota-recycle", diagnostics);
  clients.push(recycledReplacement.client);
  const recycledResult = parseText(await recycledReplacement.client.callTool({
    name: "collaboration_bootstrap",
    arguments: { requested_role_label: "AI Engineer" },
  }));
  assert.equal(recycledResult.assigned_role_id, "ai-engineer");
  persisted = await readCollaborationSessions(dataDir);
  assert.equal(findSession(persisted, firstResult.collaboration_session_id).status, "released");
  assert.equal(findSession(persisted, replacementResult.collaboration_session_id).status, "active");
  assert.equal(findSession(persisted, recycledResult.collaboration_session_id).status, "active");
  assert.equal(JSON.stringify(persisted).includes("Software Engineer 1"), false);
  assert.equal(JSON.stringify(persisted).includes("Software Engineer 2"), false);
});

test("trusted private binding preserves verified collaboration across fresh HTTP sessions", async (t) => {
  const bindingHeader = "X-PiLink-Logical-Session";
  const fixture = await launchTestServer(t, {
    prefix: "pilink-role-bootstrap-continuity-",
    extraEnv: {
      PI_COLLABORATION_BINDING_HEADER: bindingHeader,
      PI_COLLABORATION_BINDING_DETACH_GRACE: "60",
      PI_MAX_MCP_SESSIONS_TOTAL: "8",
      PI_MAX_MCP_SESSIONS_PER_CLIENT: "8",
    },
  });
  const registered = await register(fixture.serverUrl, "Stateless Connector Actor", "mcp:tools");
  const accessToken = await token(fixture.serverUrl, registered, "mcp:tools");
  const sharedHeaders = { [bindingHeader]: "private-conversation-A" };

  const first = await connectRawPostOnlySession(
    fixture.serverUrl,
    accessToken,
    "fresh-connection-bootstrap",
    fixture.diagnostics,
    sharedHeaders,
  );
  const bootstrapped = parseRawToolResult(await first.callTool(
    "collaboration_bootstrap",
    { requested_role_label: "DEV" },
  ));

  const second = await connectRawPostOnlySession(
    fixture.serverUrl,
    accessToken,
    "fresh-connection-wait",
    fixture.diagnostics,
    sharedHeaders,
  );
  assert.notEqual(second.sessionId, first.sessionId);
  const guidance = parseRawToolText(await second.callTool("get_system_prompt", {}));
  assert.match(guidance, new RegExp(bootstrapped.collaboration_session_id));
  assert.match(guidance, /Canonical role: implementer/);
  const waited = parseRawToolResult(await second.callTool("agent_work_wait", {}));
  assert.equal(waited.outcome, "snapshot");
  assert.equal(
    waited.work_state.collaboration_session_id,
    bootstrapped.collaboration_session_id,
  );
  const reconnectedPost = parseRawToolResult(await second.callTool("agent_chat_post", {
    agent_message: "AI Engineer and MANAGER are mentioned, but this author remains DEV",
  }));
  assert.equal(
    reconnectedPost.collaboration_session_id,
    bootstrapped.collaboration_session_id,
  );
  assert.deepEqual(reconnectedPost.author_role, {
    schema_version: 1,
    source: "verified_collaboration_session",
    canonical_role_id: "implementer",
    occupancy_label: "dev",
    contract_id: "pilink-collaboration/implementer",
    contract_version: "1.1.0",
    display_role_id: "dev",
    display_role_label: "DEV",
  });

  const isolated = await connectRawPostOnlySession(
    fixture.serverUrl,
    accessToken,
    "fresh-connection-isolated",
    fixture.diagnostics,
    { [bindingHeader]: "private-conversation-B" },
  );
  const isolatedBootstrap = parseRawToolResult(await isolated.callTool(
    "collaboration_bootstrap",
    { requested_role_label: "DEV" },
  ));
  assert.notEqual(
    isolatedBootstrap.collaboration_session_id,
    bootstrapped.collaboration_session_id,
  );

  const unbound = await connectRawPostOnlySession(
    fixture.serverUrl,
    accessToken,
    "fresh-connection-unbound",
    fixture.diagnostics,
  );
  const failedWait = await unbound.callTool("agent_work_wait", {});
  assert.equal(failedWait.isError, true);
  const continuity = JSON.parse(parseRawToolText(failedWait).replace(/^Error:\s*/u, ""));
  assert.equal(continuity.code, "COLLABORATION_CONTEXT_CONTINUITY_UNAVAILABLE");
  assert.equal(continuity.requires_private_client_binding, true);

  const oversized = await rejectedInitializeWithHeaders(
    fixture.serverUrl,
    accessToken,
    [[bindingHeader, "x".repeat(513)]],
  );
  assert.equal(oversized.statusCode, 400);
  assert.match(oversized.body, /exceeds 512 UTF-8 bytes/i);

  const duplicate = await rejectedInitializeWithHeaders(
    fixture.serverUrl,
    accessToken,
    [[bindingHeader, "private-conversation-A"], [bindingHeader, "private-conversation-B"]],
  );
  assert.equal(duplicate.statusCode, 400);
  assert.match(duplicate.body, /must occur once/i);
});

test("read-only OAuth sessions stay generic and create no collaboration state", async (t) => {
  const fixture = await launchTestServer(t, {
    prefix: "pilink-role-bootstrap-read-only-",
  });
  const registered = await register(fixture.serverUrl, "Read-only MCP Client", "mcp:read");
  const accessToken = await token(fixture.serverUrl, registered, "mcp:read");
  const connected = await connectClient(
    fixture.serverUrl,
    accessToken,
    "read-only-generic-client",
    fixture.diagnostics,
  );
  fixture.clients.push(connected.client);

  const tools = (await connected.client.listTools()).tools;
  assert.equal(tools.some((tool) => tool.name === "collaboration_bootstrap"), false);
  assert.deepEqual(
    tools.filter((tool) => tool.name.startsWith("agent_memory_")).map((tool) => tool.name).sort(),
    ["agent_memory_boot_read", "agent_memory_get", "agent_memory_manifest_read", "agent_memory_query"],
  );
  const guidance = parseTextString(await connected.client.callTool({
    name: "get_system_prompt",
    arguments: {},
  }));
  assert.equal(guidance.includes("Call collaboration_bootstrap first"), false);
  for (const specializedFragment of [
    "PILINK VERIFIED ROLE ASSIGNMENT",
    "PILINK MANAGER ROLE",
    "PILINK RESEARCHER ROLE",
    "PILINK IMPLEMENTER ROLE",
    "PILINK AI ENGINEER ROLE",
    "PILINK COLLABORATOR ROLE",
  ]) {
    assert.equal(guidance.includes(specializedFragment), false);
  }
  const memoryResult = parseText(await connected.client.callTool({
    name: "agent_memory_query",
    arguments: {},
  }));
  assert.equal(memoryResult.abstained, true);
  assert.equal(memoryResult.entries.length, 0);
  const boot = parseText(await connected.client.callTool({
    name: "agent_memory_boot_read",
    arguments: { maximum_bytes: 4096 },
  }));
  assert.match(boot.markdown, /generated non-authoritative view/i);
  assert.match(boot.markdown, /untrusted evidence-bearing data/i);

  const listing = await connected.client.callTool({ name: "ls", arguments: {} });
  assert.equal(listing.isError, undefined);
  assert.equal(await collaborationStateExists(fixture.dataDir), false);
  assert.equal(await projectStateFileExists(fixture.dataDir, "agent-memory.json"), false);
});

test("failed post-reservation setup always returns pending capacity to zero", async (t) => {
  const fixture = await launchTestServer(t, {
    prefix: "pilink-role-bootstrap-setup-failure-",
    dataDirInsideWorkspace: true,
  });
  const registered = await register(fixture.serverUrl, "Failing Setup Client", "mcp:tools");
  const accessToken = await token(fixture.serverUrl, registered, "mcp:tools");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      rawMcpRequest({
        serverUrl: fixture.serverUrl,
        accessToken,
        diagnostics: fixture.diagnostics,
        id: attempt + 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: `forced-streamable-failure-${attempt}`, version: "1.0.0" },
        },
      }),
      /Raw MCP initialize failed with 500/,
    );
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${fixture.serverUrl}/sse`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    assert.equal(response.status, 500);
  }

  const healthResponse = await fetch(`${fixture.serverUrl}/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.sessions.pending, 0);
  assert.equal(health.sessions.active, 0);
  assert.equal(await collaborationStateExists(fixture.dataDir), false);
});

async function launchTestServer(t, { prefix, dataDirInsideWorkspace = false, extraEnv = {} }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const dataDir = dataDirInsideWorkspace
    ? path.join(workspace, "unsafe-data")
    : path.join(root, "data");
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
      JWT_SECRET: "r".repeat(32),
      PI_BOOTSTRAP_SECRET: "s".repeat(32),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const diagnostics = captureChildDiagnostics(server);
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await stopServer(server, diagnostics);
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForHealth(`${serverUrl}/health`, server, diagnostics);
  return { root, workspace, dataDir, serverUrl, clients, server, diagnostics };
}

async function projectStateFileExists(dataDir, filename) {
  try {
    const entries = await fs.readdir(path.join(dataDir, "projects"), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await fs.access(path.join(dataDir, "projects", entry.name, filename));
        return true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function collaborationStateExists(dataDir) {
  try {
    await findCollaborationSessionStatePath(dataDir);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || /state file was not created/.test(error?.message || "")) return false;
    throw error;
  }
}

async function connectRawPostOnlySession(serverUrl, accessToken, name, diagnostics, requestHeaders = {}) {
  let nextId = 1;
  const initialization = await rawMcpRequest({
    serverUrl,
    accessToken,
    diagnostics,
    id: nextId++,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name, version: "1.0.0" },
    },
    requestHeaders,
  });
  const sessionId = initialization.response.headers.get("mcp-session-id");
  assert.ok(sessionId, "Raw MCP initialize response omitted Mcp-Session-Id");
  const protocolVersion = initialization.envelope.result.protocolVersion;
  assert.equal(typeof protocolVersion, "string");

  await rawMcpRequest({
    serverUrl,
    accessToken,
    diagnostics,
    sessionId,
    protocolVersion,
    method: "notifications/initialized",
    params: {},
    requestHeaders,
  });

  return {
    sessionId,
    async callTool(toolName, args) {
      const call = await rawMcpRequest({
        serverUrl,
        accessToken,
        diagnostics,
        sessionId,
        protocolVersion,
        id: nextId++,
        method: "tools/call",
        params: { name: toolName, arguments: args },
        requestHeaders,
      });
      if (call.envelope.error) {
        throw new Error(`Raw MCP tool ${toolName} failed: ${JSON.stringify(call.envelope.error)}`);
      }
      return call.envelope.result;
    },
  };
}

async function rejectedInitializeWithHeaders(serverUrl, accessToken, headerPairs) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "invalid-binding-client", version: "1.0.0" },
    },
  });
  const headers = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
  };
  for (const [name, value] of headerPairs) {
    const current = headers[name];
    headers[name] = current === undefined
      ? value
      : Array.isArray(current) ? [...current, value] : [current, value];
  }
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(`${serverUrl}/sse`), { method: "POST", headers }, (response) => {
      response.setEncoding("utf8");
      let responseBody = "";
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, body: responseBody }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

async function rawMcpRequest({
  serverUrl,
  accessToken,
  diagnostics,
  sessionId,
  protocolVersion,
  id,
  method,
  params,
  requestHeaders = {},
}) {
  const headers = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  Object.assign(headers, requestHeaders);
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (protocolVersion) headers["Mcp-Protocol-Version"] = protocolVersion;
  const body = { jsonrpc: "2.0", method, params };
  if (id !== undefined) body.id = id;
  const response = await fetch(`${serverUrl}/sse`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Raw MCP ${method} failed with ${response.status}: ${text}\n${diagnostics.text()}`);
  }
  if (response.status === 202 || id === undefined) {
    return { response, envelope: undefined };
  }
  const envelope = parseRpcEnvelope(text, response.headers.get("content-type"), id);
  return { response, envelope };
}

function parseRpcEnvelope(text, contentType, expectedId) {
  if (contentType?.includes("application/json")) {
    const envelope = JSON.parse(text);
    assert.equal(envelope.id, expectedId);
    return envelope;
  }
  const envelopes = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length).trim()));
  const envelope = envelopes.find((candidate) => candidate.id === expectedId);
  assert.ok(envelope, `Missing JSON-RPC response ${expectedId} in SSE body: ${text}`);
  return envelope;
}

function parseRawToolResult(result) {
  return JSON.parse(parseRawToolText(result));
}

function parseRawToolText(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return text;
}

async function connectClient(serverUrl, accessToken, name, diagnostics) {
  const transport = new StreamableHTTPClientTransport(new URL(`${serverUrl}/sse`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name, version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`${name} failed to connect: ${error instanceof Error ? error.message : String(error)}\n${diagnostics.text()}`);
  }
  assert.ok(transport.sessionId);
  return { client, transport };
}

async function register(serverUrl, clientName, scope) {
  const response = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${"s".repeat(32)}`, "Content-Type": "application/json" },
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
  return JSON.parse(parseTextString(result));
}

function findSession(state, collaborationSessionId) {
  const session = state.sessions.find((candidate) => candidate.collaborationSessionId === collaborationSessionId);
  assert.ok(session, `Missing collaboration session ${collaborationSessionId}`);
  return session;
}

async function findCollaborationSessionStatePath(dataDir) {
  const projectsDir = path.join(dataDir, "projects");
  const entries = await fs.readdir(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(projectsDir, entry.name, "collaboration-sessions.json");
    try {
      await fs.access(statePath);
      return statePath;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("Collaboration session state file was not created");
}

async function readCollaborationSessions(dataDir) {
  return JSON.parse(await fs.readFile(await findCollaborationSessionStatePath(dataDir), "utf8"));
}

function parseTextString(result) {
  return result.content.find((item) => item.type === "text").text;
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

async function waitForHealth(url, child, diagnostics) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`PiLink exited before becoming healthy (${child.exitCode})\n${diagnostics.text()}`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Child process has not bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`PiLink did not become healthy\n${diagnostics.text()}`);
}

async function waitForDiagnostic(diagnostics, pattern, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (diagnostics.text().includes(pattern)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for child diagnostic: ${pattern}\n${diagnostics.text()}`);
}

function captureChildDiagnostics(child) {
  let stdout = "";
  let stderr = "";
  const append = (current, chunk) => `${current}${chunk}`.slice(-16 * 1024);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
  return {
    text() {
      return `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
    },
  };
}

async function stopServer(child, diagnostics) {
  const wasRunning = child.exitCode === null;
  if (wasRunning) child.kill("SIGINT");
  const { code, signal } = await onceExit(child);
  if (code !== 0) {
    throw new Error(`PiLink exited with code ${code} signal ${signal || "none"}\n${diagnostics.text()}`);
  }
}

function onceExit(child) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}
