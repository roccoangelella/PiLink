import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import jwt from "jsonwebtoken";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const cliPath = path.resolve("dist/cli.js");
const serverPath = path.resolve("dist/index.js");

test("local client lifecycle commands invalidate credentials and live MCP sessions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-client-lifecycle-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  const configPath = path.join(root, ".env");
  const port = await availablePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  await fs.mkdir(workspace);
  await fs.writeFile(configPath, [
    `PI_WORK_DIR=${workspace}`,
    `PI_DATA_DIR=${dataDir}`,
    `PORT=${port}`,
    "HOST=127.0.0.1",
    `SERVER_URL=${serverUrl}`,
    `JWT_SECRET=${"a".repeat(32)}`,
    `PI_BOOTSTRAP_SECRET=${"b".repeat(32)}`,
    "PI_AGENT_MODE=agent-swarm",
  ].join("\n"), { mode: 0o600 });

  const env = {
    ...process.env,
    PILINK_CONFIG: configPath,
    PI_WORK_DIR: workspace,
    PI_DATA_DIR: dataDir,
    PORT: String(port),
    HOST: "127.0.0.1",
    SERVER_URL: serverUrl,
    JWT_SECRET: "a".repeat(32),
    PI_BOOTSTRAP_SECRET: "b".repeat(32),
    PI_AGENT_MODE: "agent-swarm",
  };
  const server = spawn(process.execPath, [serverPath], { cwd: root, env, stdio: "ignore" });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    if (!server.killed) server.kill("SIGINT");
    await onceExit(server);
    await fs.rm(root, { recursive: true, force: true });
  });

  await waitForHealth(`${serverUrl}/health`);
  const registered = await register(serverUrl, "Lifecycle Agent");
  const firstToken = await issueToken(serverUrl, registered.client_id, registered.client_secret);
  assert.equal(firstToken.status, 200);

  const legacyStore = JSON.parse(await fs.readFile(path.join(dataDir, "clients.json"), "utf8"));
  delete legacyStore.clients[0].token_version;
  await fs.writeFile(path.join(dataDir, "clients.json"), JSON.stringify(legacyStore, null, 2), { mode: 0o600 });
  const preUpgradeToken = jwt.sign({
    sub: registered.client_id,
    scope: "mcp:tools",
    iss: serverUrl,
    aud: serverUrl,
    jti: "pre-upgrade-token",
  }, "a".repeat(32), { expiresIn: 60 });
  assert.notEqual((await protectedPing(serverUrl, preUpgradeToken)).status, 401, "pre-upgrade clients and JWTs must default to token version 1");

  const firstConnection = await connectClient(serverUrl, firstToken.access_token, "lifecycle-first");
  clients.push(firstConnection.client);
  await firstConnection.client.listTools();
  await firstConnection.client.subscribeResource({ uri: "pilink://agent-chat" });

  const listed = await runCli(["clients", "list"], root, env);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, new RegExp(`${registered.client_id}\\tactive\\t1\\tLifecycle Agent`));
  assert.doesNotMatch(`${listed.stdout}${listed.stderr}`, /client_secret|secret_hash|\$2[aby]\$/i);
  assert.doesNotMatch(`${listed.stdout}${listed.stderr}`, new RegExp(escapeRegExp(registered.client_secret)));

  const disabled = await runCli(["clients", "disable", registered.client_id], root, env);
  assert.equal(disabled.code, 0);
  assert.match(disabled.stderr, /existing access tokens and MCP sessions are now invalid/i);
  await delay(1_500);

  const disabledStore = await readClient(dataDir, registered.client_id);
  assert.ok(disabledStore.disabled_at);
  assert.equal(disabledStore.token_version, 2);
  assert.equal((await protectedPing(serverUrl, firstToken.access_token)).status, 401);
  assert.equal((await issueToken(serverUrl, registered.client_id, registered.client_secret)).status, 401);

  const enabled = await runCli(["clients", "enable", registered.client_id], root, env);
  assert.equal(enabled.code, 0);
  assert.equal((await protectedPing(serverUrl, firstToken.access_token)).status, 401, "re-enabling must not revive pre-disable tokens");

  const secondToken = await issueToken(serverUrl, registered.client_id, registered.client_secret);
  assert.equal(secondToken.status, 200);
  const firstSessionReuse = await sessionPing(
    serverUrl,
    secondToken.access_token,
    firstConnection.transport.sessionId,
  );
  assert.notEqual(firstSessionReuse.status, 403, "disabled-client sweep must remove the old MCP session");
  const secondConnection = await connectClient(serverUrl, secondToken.access_token, "lifecycle-second");
  clients.push(secondConnection.client);
  await secondConnection.client.listTools();
  await secondConnection.client.subscribeResource({ uri: "pilink://agent-chat" });

  const rotated = await runCli(["clients", "rotate-secret", registered.client_id], root, env);
  assert.equal(rotated.code, 0);
  const rotatedSecret = rotated.stdout.trim();
  assert.match(rotatedSecret, /^[A-Za-z0-9_-]{40,}$/);
  assert.match(rotated.stderr, /PiLink will not display it again/);
  await delay(1_500);

  assert.equal((await protectedPing(serverUrl, secondToken.access_token)).status, 401);
  assert.equal((await issueToken(serverUrl, registered.client_id, registered.client_secret)).status, 401);
  const thirdToken = await issueToken(serverUrl, registered.client_id, rotatedSecret);
  assert.equal(thirdToken.status, 200);
  const secondSessionReuse = await sessionPing(
    serverUrl,
    thirdToken.access_token,
    secondConnection.transport.sessionId,
  );
  assert.notEqual(secondSessionReuse.status, 403, "secret rotation must remove the old MCP session");

  const [concurrentDisable, concurrentRotate] = await Promise.all([
    runCli(["clients", "disable", registered.client_id], root, env),
    runCli(["clients", "rotate-secret", registered.client_id], root, env),
  ]);
  assert.equal(concurrentDisable.code, 0);
  assert.equal(concurrentRotate.code, 0);
  const finalSecret = concurrentRotate.stdout.trim();
  const concurrentlyUpdated = await readClient(dataDir, registered.client_id);
  assert.ok(concurrentlyUpdated.disabled_at, "disable must survive a concurrent secret rotation");
  assert.ok(concurrentlyUpdated.secret_rotated_at, "rotation metadata must survive a concurrent disable");
  assert.equal(concurrentlyUpdated.token_version, 5, "both concurrent invalidations must be serialized");

  assert.equal((await runCli(["clients", "enable", registered.client_id], root, env)).code, 0);
  assert.equal((await protectedPing(serverUrl, thirdToken.access_token)).status, 401);
  assert.equal((await issueToken(serverUrl, registered.client_id, rotatedSecret)).status, 401);
  assert.equal((await issueToken(serverUrl, registered.client_id, finalSecret)).status, 200);

  const finalList = await runCli(["clients", "list"], root, env);
  assert.match(finalList.stdout, new RegExp(`${registered.client_id}\\tactive\\t5\\tLifecycle Agent`));
  assert.doesNotMatch(`${finalList.stdout}${finalList.stderr}`, new RegExp(escapeRegExp(finalSecret)));

  const redirectUri = "http://127.0.0.1:7777/lifecycle-callback";
  const authorizationClient = await register(serverUrl, "Authorization Lifecycle", {
    grant_types: ["authorization_code"],
    redirect_uris: [redirectUri],
    scope: "mcp:tools",
  });
  const verifier = "v".repeat(43);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorizationCode = await authorizeCode(serverUrl, authorizationClient.client_id, redirectUri, verifier, challenge);
  assert.equal((await runCli(["clients", "disable", authorizationClient.client_id], root, env)).code, 0);
  assert.equal((await runCli(["clients", "enable", authorizationClient.client_id], root, env)).code, 0);
  const staleCodeExchange = await exchangeAuthorizationCode(
    serverUrl,
    authorizationClient.client_id,
    redirectUri,
    authorizationCode,
    verifier,
  );
  assert.equal(staleCodeExchange.status, 400);
  assert.equal(staleCodeExchange.body.error, "invalid_grant");

  const auditText = await fs.readFile(path.join(dataDir, "oauth-client-audit.jsonl"), "utf8");
  const auditEvents = auditText.trim().split("\n").map((line) => JSON.parse(line));
  const lifecycleEvents = auditEvents.filter((event) => event.client_id === registered.client_id);
  const auditActions = lifecycleEvents.map((event) => event.action);
  assert.deepEqual(auditActions.slice(0, 4), [
    "registered",
    "disabled",
    "enabled",
    "secret_rotated",
  ]);
  assert.deepEqual(auditActions.slice(4, 6).sort(), ["disabled", "secret_rotated"]);
  assert.equal(auditActions.at(-1), "enabled");
  assert.equal(auditEvents.filter((event) => event.client_id === authorizationClient.client_id).length, 3);
  assert.doesNotMatch(auditText, /client_secret|secret_hash|\$2[aby]\$/i);
  assert.doesNotMatch(auditText, new RegExp(escapeRegExp(finalSecret)));
  assert.equal((await fs.stat(path.join(dataDir, "oauth-client-audit.jsonl"))).mode & 0o777, 0o600);
});

async function register(serverUrl, clientName, metadata = {
  grant_types: ["client_credentials"],
  scope: "mcp:tools",
}) {
  const response = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${"b".repeat(32)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ client_name: clientName, ...metadata }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function authorizeCode(serverUrl, clientId, redirectUri, verifier, challenge) {
  const consent = await fetch(`${serverUrl}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({
      action: "approve",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "mcp:tools",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
  });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  assert.ok(code);
  return code;
}

async function exchangeAuthorizationCode(serverUrl, clientId, redirectUri, code, verifier) {
  const response = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }),
  });
  return { status: response.status, body: await response.json() };
}

async function issueToken(serverUrl, clientId, clientSecret) {
  const response = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "mcp:tools",
    }),
  });
  const body = await response.json();
  return { status: response.status, ...body };
}

async function protectedPing(serverUrl, accessToken) {
  return fetch(`${serverUrl}/sse`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
}

async function connectClient(serverUrl, accessToken, name) {
  const transport = new StreamableHTTPClientTransport(new URL(`${serverUrl}/sse`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function sessionPing(serverUrl, accessToken, sessionId) {
  assert.ok(sessionId);
  return fetch(`${serverUrl}/sse`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  });
}

function runCli(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function readClient(dataDir, clientId) {
  const store = JSON.parse(await fs.readFile(path.join(dataDir, "clients.json"), "utf8"));
  return store.clients.find((client) => client.client_id === clientId);
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
      if ((await fetch(url)).ok) return;
    } catch {
      // Server has not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PiLink did not become healthy");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function onceExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
