import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
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
      PILINK_CONFIG: path.join(cwd, "test.env"),
      PI_WORK_DIR: cwd,
      PI_DATA_DIR: cwd,
      JWT_SECRET: "a".repeat(32),
      PI_BOOTSTRAP_SECRET: "b".repeat(32),
      PI_OAUTH_CONSENT_MODE: "browser",
      PI_LANDING_HOSTNAME: "landing.example.test",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    server.kill("SIGINT");
    await fs.rm(cwd, { recursive: true, force: true });
  });
  await waitForHealth(`${serverUrl}/health`);

  const metadata = await (await fetch(`${serverUrl}/.well-known/oauth-authorization-server`)).json();
  assert.ok(metadata.grant_types_supported.includes("refresh_token"));
  assert.ok(metadata.scopes_supported.includes("offline_access"));
  assert.equal("registration_endpoint" in metadata, false);

  const healthChallenge = crypto.randomBytes(32).toString("base64url");
  const authenticatedHealth = await fetch(`${serverUrl}/health?challenge=${healthChallenge}`);
  assert.equal(authenticatedHealth.status, 200);
  const authenticatedStatus = await authenticatedHealth.json();
  assert.equal(authenticatedStatus.auth_scheme, "pilink-health-hmac-v1");
  assert.equal(authenticatedStatus.challenge, healthChallenge);
  assert.equal(
    authenticatedStatus.proof,
    crypto
      .createHmac("sha256", "b".repeat(32))
      .update(`pilink-health-v1\0${healthChallenge}\0${authenticatedStatus.version}\0${port}`)
      .digest("base64url"),
  );

  const legacyHealth = await (await fetch(`${serverUrl}/health`)).json();
  assert.equal("proof" in legacyHealth, false);

  const landing = await requestWithHost(serverUrl, "/", "landing.example.test");
  assert.equal(landing.status, 200);
  assert.match(landing.body, /PiLink/);
  assert.doesNotMatch(landing.body, /VSPiLink/);
  const landingLogo = await requestWithHost(serverUrl, "/assets/logo.png", "landing.example.test");
  assert.equal(landingLogo.status, 200);
  assert.ok(landingLogo.body.length > 1_000);
  assert.equal((await requestWithHost(serverUrl, "/health", "landing.example.test")).status, 404);

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
  assert.ok(token.access_token);
  const disallowedBrowserOrigin = await fetch(`${serverUrl}/sse`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      Origin: "https://attacker.example",
    },
    body: "{}",
  });
  assert.equal(disallowedBrowserOrigin.status, 403);

  const verifier = "a".repeat(43);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = "http://127.0.0.1:7777/callback";
  const chatGptScopes = "mcp:tools mcp:read mcp:write offline_access";
  const authClientResponse = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${"b".repeat(32)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "pkce-test",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [redirectUri],
      scope: "mcp:tools offline_access",
      token_endpoint_auth_method: "client_secret_post",
    }),
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
  const repeatedState = new URL(authorization);
  repeatedState.searchParams.append("state", "second-state");
  assert.equal((await fetch(repeatedState)).status, 400);
  const consentPage = await fetch(authorization);
  assert.equal(consentPage.status, 200);
  assert.match(
    consentPage.headers.get("content-security-policy") || "",
    /form-action 'self' http:\/\/127\.0\.0\.1:7777(?:;|\s)/,
  );
  const consentHtml = await consentPage.text();
  const consentToken = consentHtml.match(/name="consent_token" value="([^"]+)"/)?.[1];
  assert.ok(consentToken);
  const consent = await fetch(`${serverUrl}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({ action: "approve", client_id: authClient.client_id, redirect_uri: redirectUri, scope: chatGptScopes, state: "test-state", code_challenge: challenge, code_challenge_method: "S256", consent_token: consentToken }),
  });
  assert.equal(consent.status, 303);
  assert.match(
    consent.headers.get("content-security-policy") || "",
    /form-action 'self' http:\/\/127\.0\.0\.1:7777(?:;|\s)/,
  );
  const consentLocation = new URL(consent.headers.get("location"));
  assert.equal(consentLocation.origin, "http://127.0.0.1:7777");
  assert.equal(consentLocation.pathname, "/callback");
  assert.equal(consentLocation.searchParams.get("state"), "test-state");
  const authorizationCode = consentLocation.searchParams.get("code");
  assert.ok(authorizationCode);
  const pkceTokenResponse = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", client_id: authClient.client_id, client_secret: authClient.client_secret, redirect_uri: redirectUri, code: authorizationCode, code_verifier: verifier }),
  });
  assert.equal(pkceTokenResponse.status, 200);
  const pkceToken = await pkceTokenResponse.json();
  assert.equal(pkceToken.scope, chatGptScopes);
  assert.ok(pkceToken.refresh_token);
  assert.equal(pkceToken.refresh_token_expires_in, 30 * 24 * 60 * 60);

  const refreshRequest = () => fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: authClient.client_id,
      client_secret: authClient.client_secret,
      refresh_token: pkceToken.refresh_token,
    }),
  });
  const concurrentRefreshes = await Promise.all([refreshRequest(), refreshRequest()]);
  assert.deepEqual(concurrentRefreshes.map((response) => response.status).sort(), [200, 400]);
  const refreshResponse = concurrentRefreshes.find((response) => response.status === 200);
  const replayResponse = concurrentRefreshes.find((response) => response.status === 400);
  assert.ok(refreshResponse);
  assert.ok(replayResponse);
  const refreshed = await refreshResponse.json();
  assert.ok(refreshed.access_token);
  assert.ok(refreshed.refresh_token);
  assert.notEqual(refreshed.refresh_token, pkceToken.refresh_token);
  assert.equal(refreshed.scope, chatGptScopes);

  assert.equal((await replayResponse.json()).error, "invalid_grant");

  const refreshStore = await fs.readFile(path.join(cwd, "refresh-tokens.json"), "utf8");
  assert.doesNotMatch(refreshStore, new RegExp(pkceToken.refresh_token));
  assert.doesNotMatch(refreshStore, new RegExp(refreshed.refresh_token));

  const publicRegistration = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${"b".repeat(32)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "public-pkce-test",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["http://localhost:7788/callback"],
      scope: "mcp:read offline_access",
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(publicRegistration.status, 201);
  const publicClient = await publicRegistration.json();
  assert.equal(publicClient.token_endpoint_auth_method, "none");
  assert.equal("client_secret" in publicClient, false);

  const publicAuthorization = new URL(`${serverUrl}/oauth/authorize`);
  publicAuthorization.search = new URLSearchParams({
    response_type: "code",
    client_id: publicClient.client_id,
    redirect_uri: "http://localhost:7788/callback",
    scope: "mcp:read offline_access",
    state: "public-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const publicConsentPage = await fetch(publicAuthorization);
  const publicConsentToken = (await publicConsentPage.text()).match(/name="consent_token" value="([^"]+)"/)?.[1];
  assert.ok(publicConsentToken);
  const publicConsent = await fetch(`${serverUrl}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({
      action: "approve",
      client_id: publicClient.client_id,
      redirect_uri: "http://localhost:7788/callback",
      scope: "mcp:read offline_access",
      state: "public-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      consent_token: publicConsentToken,
    }),
  });
  const publicCode = new URL(publicConsent.headers.get("location")).searchParams.get("code");
  const publicTokenResponse = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: publicClient.client_id,
      redirect_uri: "http://localhost:7788/callback",
      code: publicCode,
      code_verifier: verifier,
    }),
  });
  assert.equal(publicTokenResponse.status, 200);
  assert.ok((await publicTokenResponse.json()).refresh_token);

  const basicRegistration = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${"b".repeat(32)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "basic-client",
      grant_types: ["client_credentials"],
      scope: "mcp:read",
      token_endpoint_auth_method: "client_secret_basic",
    }),
  });
  assert.equal(basicRegistration.status, 201);
  const basicClient = await basicRegistration.json();
  const wrongMethod = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: basicClient.client_id, client_secret: basicClient.client_secret }),
  });
  assert.equal(wrongMethod.status, 401);
  const basicToken = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${encodeURIComponent(basicClient.client_id)}:${encodeURIComponent(basicClient.client_secret)}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "mcp:read" }),
  });
  assert.equal(basicToken.status, 200);
  const malformedBasic = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${basicClient.client_id}:%ZZ`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  assert.equal(malformedBasic.status, 401);
  const deletedBasicClient = await fetch(`${serverUrl}/admin/oauth/clients/${encodeURIComponent(basicClient.client_id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${"b".repeat(32)}` },
  });
  assert.equal(deletedBasicClient.status, 204);
  const deletedClientToken = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${encodeURIComponent(basicClient.client_id)}:${encodeURIComponent(basicClient.client_secret)}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "mcp:read" }),
  });
  assert.equal(deletedClientToken.status, 401);

  const unsafeRedirect = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${"b".repeat(32)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "unsafe", grant_types: ["authorization_code"], redirect_uris: ["http://attacker.example/callback"], scope: "mcp:read" }),
  });
  assert.equal(unsafeRedirect.status, 400);
});

test("bootstrap client registration is confined to the loopback administration boundary", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-oauth-register-boundary-"));
  const port = await availablePort();
  const localServerUrl = `http://127.0.0.1:${port}`;
  const publicHostname = "mcp.example.test";
  const bootstrapSecret = "l".repeat(32);
  const server = spawn(process.execPath, [path.resolve("dist/index.js")], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      SERVER_URL: `https://${publicHostname}`,
      PILINK_CONFIG: path.join(cwd, "test.env"),
      PI_WORK_DIR: cwd,
      PI_DATA_DIR: cwd,
      JWT_SECRET: "k".repeat(32),
      PI_BOOTSTRAP_SECRET: bootstrapSecret,
      PI_OAUTH_CONSENT_MODE: "paired",
      PI_OAUTH_PUBLIC_CHATGPT_DCR: "true",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    server.kill("SIGINT");
    await fs.rm(cwd, { recursive: true, force: true });
  });
  await waitForHealth(`${localServerUrl}/health`);

  const privilegedMetadata = JSON.stringify({
    client_name: "local-administrator",
    grant_types: ["client_credentials"],
    scope: "mcp:read",
  });
  const publicBootstrapRegistration = await requestWithHost(
    localServerUrl,
    "/oauth/register",
    publicHostname,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bootstrapSecret}`,
        "Content-Type": "application/json",
      },
      body: privilegedMetadata,
    },
  );
  assert.equal(publicBootstrapRegistration.status, 401);
  assert.equal(JSON.parse(publicBootstrapRegistration.body).error, "invalid_token");

  const localBootstrapRegistration = await fetch(`${localServerUrl}/oauth/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bootstrapSecret}`,
      "Content-Type": "application/json",
    },
    body: privilegedMetadata,
  });
  assert.equal(localBootstrapRegistration.status, 201);
  assert.ok((await localBootstrapRegistration.json()).client_secret);

  const publicDcrMetadata = JSON.stringify({
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/BoundaryTest_123"],
    grant_types: ["authorization_code", "refresh_token"],
    scope: "mcp:tools offline_access",
    token_endpoint_auth_method: "none",
  });
  const closedWindowRegistration = await requestWithHost(
    localServerUrl,
    "/oauth/register",
    publicHostname,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: publicDcrMetadata,
    },
  );
  assert.equal(closedWindowRegistration.status, 401, "the public PiLink URL alone must not open DCR registration");

  const pairingWindow = await fetch(`${localServerUrl}/admin/oauth/pairing`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bootstrapSecret}` },
  });
  assert.equal(pairingWindow.status, 200);

  const publicDcrRegistration = await requestWithHost(
    localServerUrl,
    "/oauth/register",
    publicHostname,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: publicDcrMetadata,
    },
  );
  assert.equal(publicDcrRegistration.status, 201);
  assert.equal(JSON.parse(publicDcrRegistration.body).token_endpoint_auth_method, "none");
});

test("public ChatGPT DCR is opt-in, PKCE-only and restricted to ChatGPT callbacks", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-chatgpt-dcr-"));
  const port = await availablePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.resolve("dist/index.js")], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      SERVER_URL: serverUrl,
      PILINK_CONFIG: path.join(cwd, "test.env"),
      PI_WORK_DIR: cwd,
      PI_DATA_DIR: cwd,
      JWT_SECRET: "d".repeat(32),
      PI_BOOTSTRAP_SECRET: "e".repeat(32),
      PI_OAUTH_CONSENT_MODE: "paired",
      PI_OAUTH_PUBLIC_CHATGPT_DCR: "true",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    server.kill("SIGINT");
    await fs.rm(cwd, { recursive: true, force: true });
  });
  await waitForHealth(`${serverUrl}/health`);

  const metadata = await (await fetch(`${serverUrl}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.registration_endpoint, `${serverUrl}/oauth/register`);

  const redirectUri = "https://chatgpt.com/connector/oauth/DcrTest_123";
  const registrationBody = {
    client_name: "ChatGPT",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "mcp:tools offline_access",
    token_endpoint_auth_method: "client_secret_post",
  };
  const registrationWithoutLocalPairing = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(registrationBody),
  });
  assert.equal(registrationWithoutLocalPairing.status, 401, "DCR must stay closed until the local owner opens a short setup window");

  const pairingWindow = await fetch(`${serverUrl}/admin/oauth/pairing`, {
    method: "POST",
    headers: { Authorization: `Bearer ${"e".repeat(32)}` },
  });
  assert.equal(pairingWindow.status, 200);

  const registration = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(registrationBody),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  assert.match(client.client_id, /^pi_[a-f0-9]{16}$/u);
  assert.equal(client.token_endpoint_auth_method, "none");
  assert.deepEqual(client.grant_types, ["authorization_code", "refresh_token"]);
  assert.equal(client.scope, "mcp:tools offline_access");
  assert.equal("client_secret" in client, false);

  const repeated = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(registrationBody),
  });
  assert.equal(repeated.status, 201);
  assert.equal((await repeated.json()).client_id, client.client_id);

  for (const invalidBody of [
    { ...registrationBody, redirect_uris: ["https://attacker.example/oauth/callback"] },
    { ...registrationBody, redirect_uris: ["https://chatgpt.com.evil.example/connector/oauth/test123"] },
    { ...registrationBody, grant_types: ["client_credentials"] },
    { ...registrationBody, scope: "admin:all" },
  ]) {
    const rejected = await fetch(`${serverUrl}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invalidBody),
    });
    assert.equal(rejected.status, 401);
  }

  const verifier = "q".repeat(43);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URL(`${serverUrl}/oauth/authorize`);
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    scope: "mcp:tools offline_access",
    state: "dcr-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  assert.equal((await fetch(authorization)).status, 403, "registration alone must not bypass paired owner consent");

  const persisted = await fs.readFile(path.join(cwd, "clients.json"), "utf8");
  assert.doesNotMatch(persisted, /client_secret"/u);
});

test("paired consent requires a one-use owner session and protects the local admin status", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-paired-oauth-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-paired-data-"));
  const port = await availablePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const bootstrapSecret = "p".repeat(32);
  const server = spawn(process.execPath, [path.resolve("dist/index.js")], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      SERVER_URL: serverUrl,
      PI_WORK_DIR: cwd,
      PI_DATA_DIR: dataDir,
      JWT_SECRET: "o".repeat(32),
      PI_BOOTSTRAP_SECRET: bootstrapSecret,
      PI_OAUTH_CONSENT_MODE: "paired",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    server.kill("SIGINT");
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await waitForHealth(`${serverUrl}/health`);

  const health = await fetch(`${serverUrl}/health`);
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.equal("sessions" in await health.json(), false);

  const registered = await fetch(`${serverUrl}/oauth/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bootstrapSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "paired-test",
      grant_types: ["authorization_code"],
      redirect_uris: ["http://127.0.0.1:7799/callback"],
      scope: "mcp:read",
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registered.status, 201);
  const client = await registered.json();
  const verifier = "z".repeat(43);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URL(`${serverUrl}/oauth/authorize`);
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:7799/callback",
    scope: "mcp:read",
    state: "paired-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  assert.equal((await fetch(authorization)).status, 403);

  const pairingResponse = await fetch(`${serverUrl}/admin/oauth/pairing`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bootstrapSecret}` },
  });
  assert.equal(pairingResponse.status, 200);
  const pairing = await pairingResponse.json();
  assert.match(pairing.pairing_url, new RegExp(`^${serverUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/oauth/pair\\?code=`));
  assert.match(pairing.verification_code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
  const pairResult = await fetch(pairing.pairing_url);
  assert.equal(pairResult.status, 200);
  assert.equal(pairResult.headers.get("set-cookie"), null, "possessing the pairing URL alone must not create an owner session");
  assert.match(await pairResult.text(), /verification code shown by PiLink in the local terminal/i);

  const pairingUrl = new URL(pairing.pairing_url);
  const wrongVerification = await fetch(`${serverUrl}/oauth/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: pairingUrl.searchParams.get("code") || "",
      verification_code: "AAAA-AAAA",
    }),
  });
  assert.equal(wrongVerification.status, 400);
  assert.equal(wrongVerification.headers.get("set-cookie"), null);

  const verifiedPairing = await fetch(`${serverUrl}/oauth/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: pairingUrl.searchParams.get("code") || "",
      verification_code: pairing.verification_code,
    }),
  });
  assert.equal(verifiedPairing.status, 200);
  const ownerCookie = verifiedPairing.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(ownerCookie);
  assert.equal((await fetch(pairing.pairing_url)).status, 400);

  const continuedPairingResponse = await fetch(`${serverUrl}/admin/oauth/pairing`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bootstrapSecret}` },
  });
  const continuedPairing = await continuedPairingResponse.json();
  const continuedUrl = new URL(continuedPairing.pairing_url);
  continuedUrl.searchParams.set("continue", "https://chatgpt.com/plugins");
  const continuedPrompt = await fetch(continuedUrl, { redirect: "manual" });
  assert.equal(continuedPrompt.status, 200);
  assert.equal(continuedPrompt.headers.get("set-cookie"), null);
  const continuedResult = await fetch(`${serverUrl}/oauth/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({
      code: continuedUrl.searchParams.get("code") || "",
      verification_code: continuedPairing.verification_code,
      continue: "https://chatgpt.com/plugins",
    }),
  });
  assert.equal(continuedResult.status, 303);
  assert.equal(continuedResult.headers.get("location"), "https://chatgpt.com/plugins");
  assert.ok(continuedResult.headers.get("set-cookie"));

  const rejectedPairingResponse = await fetch(`${serverUrl}/admin/oauth/pairing`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bootstrapSecret}` },
  });
  const rejectedPairing = await rejectedPairingResponse.json();
  const rejectedContinuation = new URL(rejectedPairing.pairing_url);
  rejectedContinuation.searchParams.set("continue", "https://attacker.example/");
  assert.equal((await fetch(rejectedContinuation, { redirect: "manual" })).status, 400);
  assert.equal((await fetch(rejectedPairing.pairing_url)).status, 200, "an invalid continuation must not consume the one-use pairing code");

  const consentPage = await fetch(authorization, { headers: { Cookie: ownerCookie } });
  assert.equal(consentPage.status, 200);
  const consentToken = (await consentPage.text()).match(/name="consent_token" value="([^"]+)"/)?.[1];
  assert.ok(consentToken);
  const approved = await fetch(`${serverUrl}/oauth/authorize`, {
    method: "POST",
    headers: { Cookie: ownerCookie, "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "manual",
    body: new URLSearchParams({
      action: "approve",
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:7799/callback",
      scope: "mcp:read",
      state: "paired-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      consent_token: consentToken,
    }),
  });
  assert.equal(approved.status, 303);
  assert.match(
    approved.headers.get("content-security-policy") || "",
    /form-action 'self' http:\/\/127\.0\.0\.1:7799(?:;|\s)/,
  );

  assert.equal((await fetch(`${serverUrl}/admin/status`)).status, 403);
  const adminStatus = await fetch(`${serverUrl}/admin/status`, {
    headers: { Authorization: `Bearer ${bootstrapSecret}` },
  });
  assert.equal(adminStatus.status, 200);
  assert.ok((await adminStatus.json()).activity);

  assert.equal((await fetch(`${serverUrl}/admin/collaboration`)).status, 403);
  const collaboration = await fetch(`${serverUrl}/admin/collaboration`, {
    headers: { Authorization: `Bearer ${bootstrapSecret}` },
  });
  assert.equal(collaboration.status, 200);
  const collaborationState = await collaboration.json();
  assert.deepEqual(collaborationState.chat.messages, []);
  assert.deepEqual(collaborationState.tasks, []);
  assert.equal(collaborationState.project_key.length, 64);
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

function requestWithHost(serverUrl, requestPath, host, options = {}) {
  const target = new URL(serverUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: requestPath,
      method: options.method || "GET",
      headers: { ...options.headers, Host: host },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
