import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { SecretStorage } from "vscode";
import type { ConfigSnapshot } from "../src/configuration.js";
import { OAuthClientService } from "../src/oauth-client.js";

class MemorySecrets {
  readonly values = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

test("native MCP OAuth credentials are registered once, reused by scope, and removed on disconnect", async (t) => {
  const requests: Array<{ path: string; authorization?: string; body: Record<string, unknown> }> = [];
  let registrations = 0;
  let port = 0;
  const server = http.createServer(async (request, response) => {
    if (respondToAuthenticatedHealth(request, response, "b".repeat(32), port)) return;
    const bodyText = await readBody(request);
    const body = request.headers["content-type"]?.startsWith("application/json")
      ? JSON.parse(bodyText)
      : Object.fromEntries(new URLSearchParams(bodyText));
    requests.push({ path: request.url || "", authorization: request.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/oauth/register") {
      registrations += 1;
      response.end(JSON.stringify({
        client_id: `native-${registrations}`,
        client_secret: `secret-${registrations}`,
        client_name: "VSPiLink for VS Code",
        redirect_uris: [],
        grant_types: ["client_credentials"],
        scope: "mcp:tools mcp:read mcp:write",
      }));
      return;
    }
    if (request.url === "/oauth/token") {
      response.end(JSON.stringify({ access_token: `token-${body.scope}`, token_type: "Bearer" }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  port = (server.address() as AddressInfo).port;
  const secrets = new MemorySecrets();
  const service = new OAuthClientService(secrets as unknown as SecretStorage);
  const snapshot = configSnapshot(port);

  assert.equal(await service.connectNative(snapshot, "mcp:read"), "token-mcp:read");
  const requestsBeforeRejectedEscalation = requests.length;
  await assert.rejects(service.refreshNative(snapshot, "mcp:tools"), /was not approved/);
  assert.equal(requests.length, requestsBeforeRejectedEscalation);
  assert.equal(await service.connectNative(snapshot, "mcp:tools"), "token-mcp:tools");
  assert.equal(await service.refreshNative(snapshot, "mcp:tools"), "token-mcp:tools");
  assert.equal(registrations, 1);
  assert.equal(requests[0].authorization, `Bearer ${snapshot.bootstrapSecret}`);
  assert.deepEqual(requests[0].body, {
    client_name: "VSPiLink for VS Code",
    redirect_uris: [],
    grant_types: ["client_credentials"],
    scope: "mcp:tools mcp:read mcp:write",
    token_endpoint_auth_method: "client_secret_post",
  });
  assert.equal(requests[1].body.client_id, "native-1");
  assert.equal(requests[1].body.client_secret, "secret-1");
  assert.equal(await service.storedNativeToken(snapshot.configPath), "token-mcp:tools");
  assert.equal(secrets.values.size, 1);
  assert.doesNotMatch([...secrets.values.keys()][0], /oauth-test|secret-1/);

  await service.disconnectNative(snapshot.configPath);
  assert.equal(await service.hasNativeCredentials(snapshot.configPath), false);
  assert.equal(secrets.values.size, 0);
});

test("native MCP OAuth transparently replaces credentials removed by a PiLink reset", async (t) => {
  let registrations = 0;
  let invalidateFirstClient = false;
  let port = 0;
  const server = http.createServer(async (request, response) => {
    if (respondToAuthenticatedHealth(request, response, "b".repeat(32), port)) return;
    const bodyText = await readBody(request);
    const form = Object.fromEntries(new URLSearchParams(bodyText));
    response.setHeader("content-type", "application/json");
    if (request.url === "/oauth/register") {
      registrations += 1;
      response.end(JSON.stringify({
        client_id: `native-${registrations}`,
        client_secret: `secret-${registrations}`,
        client_name: "VSPiLink for VS Code",
        redirect_uris: [],
        grant_types: ["client_credentials"],
        scope: "mcp:tools mcp:read mcp:write",
      }));
      return;
    }
    if (request.url === "/oauth/token" && invalidateFirstClient && form.client_id === "native-1") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "invalid_client" }));
      return;
    }
    response.end(JSON.stringify({ access_token: `token-${form.client_id}`, token_type: "Bearer" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  port = (server.address() as AddressInfo).port;
  const service = new OAuthClientService(new MemorySecrets() as unknown as SecretStorage);
  const snapshot = configSnapshot(port);

  assert.equal(await service.connectNative(snapshot, "mcp:read"), "token-native-1");
  invalidateFirstClient = true;
  assert.equal(await service.refreshNative(snapshot, "mcp:read"), "token-native-2");
  assert.equal(registrations, 2);
});

test("native OAuth refuses registration without a valid private bootstrap secret", async () => {
  const service = new OAuthClientService(new MemorySecrets() as unknown as SecretStorage);
  await assert.rejects(
    service.connectNative({ ...configSnapshot(65_534), bootstrapSecret: undefined }, "mcp:read"),
    /PI_BOOTSTRAP_SECRET/,
  );
});

test("legacy native credentials migrate conservatively", async () => {
  const readSecrets = new MemorySecrets();
  const configPath = "/tmp/vspilink-legacy-read.env";
  readSecrets.values.set(nativeSecretKey(configPath), JSON.stringify({
    clientId: "legacy-read",
    clientSecret: "secret",
    accessToken: "read-token",
    scope: "mcp:read",
    configPath,
  }));
  const readService = new OAuthClientService(readSecrets as unknown as SecretStorage);
  assert.equal(await readService.approvedNativeScope(configPath), "mcp:read");
  assert.equal(await readService.storedNativeToken(configPath, "mcp:read"), "read-token");

  const elevatedSecrets = new MemorySecrets();
  const elevatedConfigPath = "/tmp/vspilink-legacy-tools.env";
  elevatedSecrets.values.set(nativeSecretKey(elevatedConfigPath), JSON.stringify({
    clientId: "legacy-tools",
    clientSecret: "secret",
    accessToken: "tools-token",
    scope: "mcp:tools",
    configPath: elevatedConfigPath,
  }));
  const elevatedService = new OAuthClientService(elevatedSecrets as unknown as SecretStorage);
  assert.equal(await elevatedService.approvedNativeScope(elevatedConfigPath), undefined);
  assert.equal(await elevatedService.storedNativeToken(elevatedConfigPath, "mcp:tools"), undefined);
});

test("native OAuth sends no credential when authenticated health proof fails", async (t) => {
  const paths: string[] = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url || "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      server: "pilink",
      status: "ok",
      version: "1.1.0",
      auth_scheme: "pilink-health-hmac-v1",
      challenge: "wrong-challenge",
      proof: "wrong-proof",
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const service = new OAuthClientService(new MemorySecrets() as unknown as SecretStorage);

  await assert.rejects(service.connectNative(configSnapshot(port), "mcp:read"), /local PiLink server identity could not be verified/);
  assert.equal(paths.length, 1);
  assert.match(paths[0], /^\/health\?challenge=/);
});

test("external ChatGPT registration stores the secret only in SecretStorage with refresh and offline access", async (t) => {
  let port = 0;
  let registrationBody: Record<string, unknown> = {};
  const server = http.createServer(async (request, response) => {
    if (respondToAuthenticatedHealth(request, response, "b".repeat(32), port)) return;
    response.setHeader("content-type", "application/json");
    if (request.url === "/oauth/register") {
      registrationBody = JSON.parse(await readBody(request));
      response.end(JSON.stringify({
        client_id: "chatgpt-public",
        client_secret: "secret-only-once",
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        scope: "mcp:tools offline_access",
        token_endpoint_auth_method: "client_secret_post",
      }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  port = (server.address() as AddressInfo).port;
  const secrets = new MemorySecrets();
  const service = new OAuthClientService(secrets as unknown as SecretStorage);
  const snapshot = configSnapshot(port);
  const summary = await service.registerExternalClient(snapshot, {
    clientName: "ChatGPT",
    redirectUris: ["https://chatgpt.com/callback"],
    grantTypes: ["authorization_code", "refresh_token"],
    allowedScope: "mcp:tools offline_access",
    tokenEndpointAuthMethod: "client_secret_post",
  });

  assert.deepEqual(registrationBody, {
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    scope: "mcp:tools offline_access",
    token_endpoint_auth_method: "client_secret_post",
  });
  assert.equal("clientSecret" in summary, false);
  assert.equal(JSON.stringify(summary).includes("secret-only-once"), false);
  assert.equal(await service.externalCredentialValue(snapshot.configPath, summary.clientId, "clientSecret"), "secret-only-once");
});

test("external registration rolls back the server client when SecretStorage fails", async (t) => {
  let port = 0;
  let revokedClient = "";
  let revokeAuthorization = "";
  const server = http.createServer(async (request, response) => {
    if (respondToAuthenticatedHealth(request, response, "b".repeat(32), port)) return;
    if (request.url === "/oauth/register") {
      await readBody(request);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        client_id: "rollback-client",
        client_secret: "unrecoverable-secret",
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        scope: "mcp:tools offline_access",
        token_endpoint_auth_method: "client_secret_post",
      }));
      return;
    }
    if (request.method === "DELETE" && request.url === "/admin/oauth/clients/rollback-client") {
      revokedClient = "rollback-client";
      revokeAuthorization = request.headers.authorization || "";
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  port = (server.address() as AddressInfo).port;
  const failingSecrets = new MemorySecrets();
  failingSecrets.store = () => Promise.reject(new Error("SecretStorage unavailable"));
  const service = new OAuthClientService(failingSecrets as unknown as SecretStorage);
  const snapshot = configSnapshot(port);

  await assert.rejects(service.registerExternalClient(snapshot, {
    clientName: "ChatGPT",
    redirectUris: ["https://chatgpt.com/callback"],
    grantTypes: ["authorization_code", "refresh_token"],
    allowedScope: "mcp:tools offline_access",
  }), /SecretStorage unavailable/);
  assert.equal(revokedClient, "rollback-client");
  assert.equal(revokeAuthorization, `Bearer ${snapshot.bootstrapSecret}`);
});

function configSnapshot(port: number): ConfigSnapshot {
  return {
    configPath: "/tmp/vspilink-oauth-test.env",
    configured: true,
    values: {},
    workspace: "/tmp",
    dataDir: "/tmp",
    port,
    hostingMode: "quick-tunnel",
    unsafeFullAccess: false,
    serverUrl: `http://127.0.0.1:${port}`,
    bootstrapSecret: "b".repeat(32),
    clients: [],
  };
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function respondToAuthenticatedHealth(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  bootstrapSecret: string,
  port: number,
): boolean {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  if (url.pathname !== "/health") return false;
  const challenge = url.searchParams.get("challenge") || "";
  const version = "1.1.0";
  const proof = crypto
    .createHmac("sha256", bootstrapSecret)
    .update(`pilink-health-v1\0${challenge}\0${version}\0${port}`)
    .digest("base64url");
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    server: "pilink",
    status: "ok",
    version,
    auth_scheme: "pilink-health-hmac-v1",
    challenge,
    proof,
  }));
  return true;
}

function nativeSecretKey(configPath: string): string {
  return `vspilink.nativeMcp.${crypto.createHash("sha256").update(configPath).digest("hex")}`;
}
