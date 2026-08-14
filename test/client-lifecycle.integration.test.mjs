import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import jwt from "jsonwebtoken";

const serverPath = path.resolve("dist/index.js");
const cliPath = path.resolve("dist/cli.js");

test("OAuth client lifecycle is atomic, auditable, and invalidates every credential generation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-client-lifecycle-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  const configPath = path.join(root, ".env");
  const port = await availablePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const jwtSecret = "j".repeat(32);
  const bootstrapSecret = "b".repeat(32);
  await fs.mkdir(workspace);
  await fs.mkdir(dataDir);
  await fs.writeFile(configPath, [
    `PI_WORK_DIR=${workspace}`,
    `PI_DATA_DIR=${dataDir}`,
    `PORT=${port}`,
    "HOST=127.0.0.1",
    `SERVER_URL=${serverUrl}`,
    `JWT_SECRET=${jwtSecret}`,
    `PI_BOOTSTRAP_SECRET=${bootstrapSecret}`,
    "PI_OAUTH_CONSENT_MODE=browser",
  ].join("\n"), { mode: 0o600 });
  const env = {
    ...process.env,
    PILINK_CONFIG: configPath,
    PI_WORK_DIR: workspace,
    PI_DATA_DIR: dataDir,
    PORT: String(port),
    HOST: "127.0.0.1",
    SERVER_URL: serverUrl,
    JWT_SECRET: jwtSecret,
    PI_BOOTSTRAP_SECRET: bootstrapSecret,
    PI_OAUTH_CONSENT_MODE: "browser",
  };
  let stderr = "";
  const server = spawn(process.execPath, [serverPath], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
  server.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGINT");
    await onceExit(server);
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForHealth(serverUrl, server, () => stderr);

  const metadata = await (await fetch(`${serverUrl}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.revocation_endpoint, `${serverUrl}/oauth/revoke`);
  assert.deepEqual(metadata.revocation_endpoint_auth_methods_supported, ["client_secret_post", "client_secret_basic"]);

  const registered = await register(serverUrl, bootstrapSecret, {
    client_name: "Lifecycle client",
    grant_types: ["client_credentials"],
    scope: "mcp:read",
  });
  const firstToken = await issueToken(serverUrl, registered.client_id, registered.client_secret);
  assert.equal(firstToken.status, 200);
  assert.notEqual(await protectedStatus(serverUrl, firstToken.body.access_token), 401);

  // Legacy clients and JWTs without an explicit version remain generation 1.
  const legacyStore = JSON.parse(await fs.readFile(path.join(dataDir, "clients.json"), "utf8"));
  delete legacyStore.clients[0].token_version;
  await fs.writeFile(path.join(dataDir, "clients.json"), JSON.stringify(legacyStore, null, 2), { mode: 0o600 });
  const preVersioned = jwt.sign({
    sub: registered.client_id,
    scope: "mcp:read",
    iss: serverUrl,
    aud: serverUrl,
    jti: "legacy-client-token",
  }, jwtSecret, { algorithm: "HS256", expiresIn: 60 });
  assert.notEqual(await protectedStatus(serverUrl, preVersioned), 401);

  const listed = await runCli(["clients", "list"], root, env);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, new RegExp(`${registered.client_id}\\tactive\\t1\\tLifecycle client`));
  assert.doesNotMatch(`${listed.stdout}${listed.stderr}`, /client_secret|secret_hash|\$2[aby]\$/iu);
  assert.doesNotMatch(`${listed.stdout}${listed.stderr}`, new RegExp(escapeRegExp(registered.client_secret)));

  const disabled = await runCli(["clients", "disable", registered.client_id], root, env);
  assert.equal(disabled.code, 0);
  let stored = await readClient(dataDir, registered.client_id);
  assert.ok(stored.disabled_at);
  assert.equal(stored.token_version, 2);
  assert.equal(await protectedStatus(serverUrl, firstToken.body.access_token), 401);
  assert.equal((await issueToken(serverUrl, registered.client_id, registered.client_secret)).status, 401);

  assert.equal((await runCli(["clients", "enable", registered.client_id], root, env)).code, 0);
  assert.equal(await protectedStatus(serverUrl, firstToken.body.access_token), 401);
  const secondToken = await issueToken(serverUrl, registered.client_id, registered.client_secret);
  assert.equal(secondToken.status, 200);

  const rotated = await runCli(["clients", "rotate-secret", registered.client_id], root, env);
  assert.equal(rotated.code, 0);
  const rotatedSecret = rotated.stdout.trim();
  assert.match(rotatedSecret, /^[A-Za-z0-9_-]{40,}$/u);
  assert.equal(await protectedStatus(serverUrl, secondToken.body.access_token), 401);
  assert.equal((await issueToken(serverUrl, registered.client_id, registered.client_secret)).status, 401);
  const thirdToken = await issueToken(serverUrl, registered.client_id, rotatedSecret);
  assert.equal(thirdToken.status, 200);

  const [concurrentDisable, concurrentRotate] = await Promise.all([
    runCli(["clients", "disable", registered.client_id], root, env),
    runCli(["clients", "rotate-secret", registered.client_id], root, env),
  ]);
  assert.equal(concurrentDisable.code, 0);
  assert.equal(concurrentRotate.code, 0);
  const finalSecret = concurrentRotate.stdout.trim();
  stored = await readClient(dataDir, registered.client_id);
  assert.ok(stored.disabled_at);
  assert.ok(stored.secret_rotated_at);
  assert.equal(stored.token_version, 5);
  assert.equal((await runCli(["clients", "enable", registered.client_id], root, env)).code, 0);
  assert.equal(await protectedStatus(serverUrl, thirdToken.body.access_token), 401);
  assert.equal((await issueToken(serverUrl, registered.client_id, rotatedSecret)).status, 401);
  const finalToken = await issueToken(serverUrl, registered.client_id, finalSecret);
  assert.equal(finalToken.status, 200);

  const revoked = await fetch(`${serverUrl}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: finalToken.body.access_token,
      token_type_hint: "access_token",
      client_id: registered.client_id,
      client_secret: finalSecret,
    }),
  });
  assert.equal(revoked.status, 200);
  assert.equal(await protectedStatus(serverUrl, finalToken.body.access_token), 401);
  assert.equal((await fetch(`${serverUrl}/oauth/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${finalToken.body.access_token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: finalToken.body.access_token }),
  })).status, 200);
  const revokedStore = await fs.readFile(path.join(dataDir, "revoked-tokens.json"), "utf8");
  assert.doesNotMatch(revokedStore, new RegExp(escapeRegExp(finalToken.body.access_token)));
  assert.doesNotMatch(revokedStore, new RegExp(escapeRegExp(finalSecret)));

  const redirectUri = "http://127.0.0.1:7789/callback";
  const authorizationClient = await register(serverUrl, bootstrapSecret, {
    client_name: "Authorization lifecycle",
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: [redirectUri],
    scope: "mcp:read offline_access",
    token_endpoint_auth_method: "none",
  });
  const verifier = "v".repeat(43);
  const firstCode = await authorizeCode(
    serverUrl,
    authorizationClient.client_id,
    redirectUri,
    verifier,
    "mcp:read offline_access",
  );
  const firstExchange = await exchangeCode(
    serverUrl,
    authorizationClient.client_id,
    redirectUri,
    firstCode,
    verifier,
  );
  assert.equal(firstExchange.status, 200);
  const authorizationTokens = await firstExchange.json();
  assert.ok(authorizationTokens.refresh_token);
  const code = await authorizeCode(serverUrl, authorizationClient.client_id, redirectUri, verifier);
  assert.equal((await runCli(["clients", "disable", authorizationClient.client_id], root, env)).code, 0);
  assert.equal((await runCli(["clients", "enable", authorizationClient.client_id], root, env)).code, 0);
  const staleExchange = await exchangeCode(
    serverUrl,
    authorizationClient.client_id,
    redirectUri,
    code,
    verifier,
  );
  assert.equal(staleExchange.status, 400);
  assert.equal((await staleExchange.json()).error, "invalid_grant");
  const invalidatedRefresh = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: authorizationClient.client_id,
      refresh_token: authorizationTokens.refresh_token,
    }),
  });
  assert.equal(invalidatedRefresh.status, 400);
  assert.equal((await invalidatedRefresh.json()).error, "invalid_grant");

  const auditText = await fs.readFile(path.join(dataDir, "oauth-client-audit.jsonl"), "utf8");
  const auditEvents = auditText.trim().split("\n").map((line) => JSON.parse(line));
  const actions = auditEvents
    .filter((event) => event.client_id === registered.client_id)
    .map((event) => event.action);
  assert.deepEqual(actions.slice(0, 4), ["registered", "disabled", "enabled", "secret_rotated"]);
  assert.deepEqual(actions.slice(4, 6).sort(), ["disabled", "secret_rotated"]);
  assert.equal(actions.at(-2), "enabled");
  assert.equal(actions.at(-1), "token_revoked");
  assert.doesNotMatch(auditText, /client_name|client_secret|secret_hash|scope|\$2[aby]\$/iu);
  assert.doesNotMatch(auditText, new RegExp(escapeRegExp(finalSecret)));
  assert.equal((await fs.stat(path.join(dataDir, "oauth-client-audit.jsonl"))).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(path.join(dataDir, "oauth-state.lock")), { code: "ENOENT" });
});

async function register(serverUrl, bootstrapSecret, metadata) {
  const response = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bootstrapSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function issueToken(serverUrl, clientId, clientSecret) {
  const response = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "mcp:read",
    }),
  });
  return { status: response.status, body: await response.json() };
}

async function protectedStatus(serverUrl, token) {
  const response = await fetch(`${serverUrl}/sse`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  await response.text();
  return response.status;
}

async function authorizeCode(serverUrl, clientId, redirectUri, verifier, scope = "mcp:read") {
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URL(`${serverUrl}/oauth/authorize`);
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: "lifecycle",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const page = await fetch(authorization);
  assert.equal(page.status, 200);
  const consentToken = (await page.text()).match(/name="consent_token" value="([^"]+)"/u)?.[1];
  assert.ok(consentToken);
  const consent = await fetch(`${serverUrl}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({
      action: "approve",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state: "lifecycle",
      code_challenge: challenge,
      code_challenge_method: "S256",
      consent_token: consentToken,
    }),
  });
  assert.equal(consent.status, 303);
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  assert.ok(code);
  return code;
}

function exchangeCode(serverUrl, clientId, redirectUri, code, verifier) {
  return fetch(`${serverUrl}/oauth/token`, {
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
