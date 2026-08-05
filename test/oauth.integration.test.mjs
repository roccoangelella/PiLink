import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("OAuth registration is bootstrap-protected and issued scopes are retained", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-integration-"));
  const port = 35991;
  const serverUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.resolve("dist/index.js")], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      SERVER_URL: serverUrl,
      PI_WORK_DIR: cwd,
      PI_DATA_DIR: cwd,
      JWT_SECRET: "a".repeat(32),
      PI_BOOTSTRAP_SECRET: "b".repeat(32),
    },
    stdio: "ignore",
  });
  t.after(async () => {
    server.kill("SIGINT");
    await fs.rm(cwd, { recursive: true, force: true });
  });
  await waitForHealth(`${serverUrl}/health`);

  const metadata = await (await fetch(`${serverUrl}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.revocation_endpoint, `${serverUrl}/oauth/revoke`);
  assert.deepEqual(metadata.revocation_endpoint_auth_methods_supported, ["client_secret_post", "client_secret_basic"]);

  const rejected = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "untrusted" }),
  });
  assert.equal(rejected.status, 401);

  const registered = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${"b".repeat(32)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "test", grant_types: ["client_credentials"], scope: "mcp:read" }),
  });
  assert.equal(registered.status, 201);
  const client = await registered.json();
  const tokenResponse = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: client.client_id, client_secret: client.client_secret, scope: "mcp:read" }),
  });
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json();
  assert.equal(token.scope, "mcp:read");
  assert.equal(token.expires_in, 30 * 24 * 60 * 60);
  assert.ok(token.access_token);

  const verifier = "a".repeat(43);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = "http://127.0.0.1:7777/callback";
  const chatGptScopes = "mcp:tools mcp:read mcp:write";
  const authClientResponse = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${"b".repeat(32)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "pkce-test", grant_types: ["authorization_code"], redirect_uris: [redirectUri], scope: "mcp:tools" }),
  });
  const authClient = await authClientResponse.json();
  const authorization = new URL(`${serverUrl}/oauth/authorize`);
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: authClient.client_id,
    redirect_uri: redirectUri,
    scope: chatGptScopes,
    state: "test-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const consentPage = await fetch(authorization);
  assert.equal(consentPage.status, 200);
  const consent = await fetch(`${serverUrl}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({ action: "approve", client_id: authClient.client_id, redirect_uri: redirectUri, scope: chatGptScopes, state: "test-state", code_challenge: challenge, code_challenge_method: "S256" }),
  });
  assert.equal(consent.status, 302);
  const authorizationCode = new URL(consent.headers.get("location")).searchParams.get("code");
  assert.ok(authorizationCode);
  const pkceTokenResponse = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", client_id: authClient.client_id, redirect_uri: redirectUri, code: authorizationCode, code_verifier: verifier }),
  });
  assert.equal(pkceTokenResponse.status, 200);
  assert.equal((await pkceTokenResponse.json()).scope, chatGptScopes);

  const revoked = await fetch(`${serverUrl}/oauth/revoke`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token: token.access_token }),
  });
  assert.equal(revoked.status, 200);

  const rejectedRevokedToken = await fetch(`${serverUrl}/sse`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(rejectedRevokedToken.status, 401);
  assert.equal((await rejectedRevokedToken.json()).error, "invalid_token");

  const revokedStore = JSON.parse(await fs.readFile(path.join(cwd, "revoked-tokens.json"), "utf8"));
  assert.equal(revokedStore.revoked_tokens.length, 1);
  assert.ok(revokedStore.revoked_tokens[0].jti);
});

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The child process has not bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PiLink did not become healthy");
}
