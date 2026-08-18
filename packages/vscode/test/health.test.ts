import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  createOwnerPairing,
  isLoopbackPortOccupied,
  readAdminActivity,
  readAdminStatus,
  readAuthenticatedHealth,
  readHealth,
  waitForHealth,
  waitForPublicHealth,
} from "../src/health.js";

async function startHttpServer(t: test.TestContext, listener: http.RequestListener): Promise<number> {
  const server = http.createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  return (server.address() as AddressInfo).port;
}

function authenticatedHealth(
  bootstrapSecret: string,
  port: number,
  requestUrl: string | undefined,
  version = "2.2.0",
): Record<string, unknown> {
  const url = new URL(requestUrl || "/", `http://127.0.0.1:${port}`);
  const challenge = url.searchParams.get("challenge") || "";
  const proof = crypto
    .createHmac("sha256", bootstrapSecret)
    .update(`pilink-health-v1\0${challenge}\0${version}\0${port}`)
    .digest("base64url");
  return {
    server: "pilink",
    status: "ok",
    version,
    auth_scheme: "pilink-health-hmac-v1",
    challenge,
    proof,
  };
}

test("readHealth accepts only a PiLink health payload", async (t) => {
  let observedRequest: { method?: string; url?: string; accept?: string } = {};
  const port = await startHttpServer(t, (request, response) => {
    observedRequest = { method: request.method, url: request.url, accept: request.headers.accept };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ server: "pilink", status: "ok" }));
  });

  assert.deepEqual(await readHealth(port), {
    online: true,
    payload: { server: "pilink", status: "ok" },
  });
  assert.deepEqual(observedRequest, { method: "GET", url: "/health", accept: "application/json" });
});

test("readHealth rejects impostors, malformed JSON, and oversized responses", async (t) => {
  const impostor = await startHttpServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ server: "other" }));
  });
  assert.match((await readHealth(impostor)).error || "", /does not belong to PiLink/);

  const malformed = await startHttpServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("not-json");
  });
  assert.equal((await readHealth(malformed)).online, false);

  const oversized = await startHttpServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ server: "pilink", padding: "x".repeat(256 * 1024) }));
  });
  assert.match((await readHealth(oversized)).error || "", /too large/);
});

test("readAuthenticatedHealth verifies the private PiLink HMAC challenge", async (t) => {
  const bootstrapSecret = "b".repeat(32);
  let port = 0;
  port = await startHttpServer(t, (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(authenticatedHealth(bootstrapSecret, port, request.url)));
  });

  assert.equal((await readAuthenticatedHealth(port, bootstrapSecret)).online, true);
  const wrongSecret = await readAuthenticatedHealth(port, "x".repeat(32));
  assert.equal(wrongSecret.online, false);
  assert.match(wrongSecret.error || "", /health proof does not match/);
});

test("waitForHealth retries until PiLink becomes reachable", async (t) => {
  let requests = 0;
  const port = await startHttpServer(t, (_request, response) => {
    requests += 1;
    if (requests === 1) {
      response.writeHead(503);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ server: "pilink", status: "ok" }));
  });

  const result = await waitForHealth(port, 2_000);
  assert.equal(result.online, true);
  assert.equal(requests, 2);
});

test("admin status and owner pairing require authenticated local identity", async (t) => {
  const bootstrapSecret = "s".repeat(32);
  const observed: Array<{ method?: string; path: string; authorization?: string }> = [];
  let port = 0;
  port = await startHttpServer(t, (request, response) => {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/health") {
      response.end(JSON.stringify(authenticatedHealth(bootstrapSecret, port, request.url)));
      return;
    }
    observed.push({ method: request.method, path: url.pathname, authorization: request.headers.authorization });
    if (url.pathname === "/admin/status") {
      response.end(JSON.stringify({ sessions: { active: 3, total: 4 }, activity: { chatgptConnected: true } }));
      return;
    }
    if (url.pathname === "/admin/oauth/pairing") {
      response.end(JSON.stringify({
        pairing_url: "https://mcp.example.test/oauth/pair?code=one-use",
        verification_code: "ABCD-2345",
        expires_at: "2027-08-03T01:00:00.000Z",
      }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });

  const status = await readAdminStatus(port, bootstrapSecret);
  assert.equal(status.online, true);
  assert.equal(status.chatGptConnected, true);
  assert.equal(status.activeSessions, 3);
  assert.deepEqual(await createOwnerPairing(port, bootstrapSecret), {
    pairingUrl: "https://mcp.example.test/oauth/pair?code=one-use",
    verificationCode: "ABCD-2345",
    expiresAt: "2027-08-03T01:00:00.000Z",
  });
  assert.deepEqual(observed, [
    { method: "GET", path: "/admin/status", authorization: `Bearer ${bootstrapSecret}` },
    { method: "POST", path: "/admin/oauth/pairing", authorization: `Bearer ${bootstrapSecret}` },
  ]);
});

test("readAdminActivity discards collaboration content and returns only bounded tool metadata", async (t) => {
  const bootstrapSecret = "c".repeat(32);
  let port = 0;
  port = await startHttpServer(t, (request, response) => {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/health") {
      response.end(JSON.stringify(authenticatedHealth(bootstrapSecret, port, request.url)));
      return;
    }
    assert.equal(request.headers.authorization, `Bearer ${bootstrapSecret}`);
    assert.equal(url.pathname, "/admin/collaboration");
    assert.equal(url.searchParams.get("chat_limit"), "1");
    assert.equal(url.searchParams.get("task_limit"), "1");
    response.end(JSON.stringify({
      chat: { messages: [{ message: "must not cross" }] },
      tasks: [{ title: "must not cross" }],
      clients: [{ clientId: "must not cross" }],
      tool_activity: [{
        tool: "read",
        started_at: "2026-08-18T12:00:00.000Z",
        duration_ms: 42,
        outcome: "success",
        access_mode: "workspace",
        client_id: "must-not-cross",
        args: { path: "/secret" },
        result: "must-not-cross",
      }, {
        tool: "bash",
        started_at: "invalid",
        duration_ms: 1,
        outcome: "success",
      }],
    }));
  });

  assert.deepEqual(await readAdminActivity(port, bootstrapSecret), [{
    tool: "read",
    startedAt: "2026-08-18T12:00:00.000Z",
    durationMs: 42,
    outcome: "success",
  }]);
});

test("loopback port probe distinguishes an occupied PiLink port from a released port", async () => {
  const server = http.createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  assert.equal(await isLoopbackPortOccupied(port), true);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.equal(await isLoopbackPortOccupied(port), false);
});

test("waitForPublicHealth rejects non-HTTPS origins before fetching", async () => {
  let calls = 0;
  const result = await waitForPublicHealth("http://mcp.example.test", 10, async () => {
    calls += 1;
    throw new Error("must not run");
  });
  assert.equal(result.online, false);
  assert.match(result.error || "", /must use HTTPS/);
  assert.equal(calls, 0);
});

test("waitForPublicHealth validates the remote service identity and disables redirects", async () => {
  const requests: Array<{ url: string; redirect?: RequestRedirect }> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), redirect: init?.redirect });
    return new Response(JSON.stringify({ server: "pilink", status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await waitForPublicHealth("https://mcp.example.test", 1_000, fetchImplementation);
  assert.equal(result.online, true);
  assert.deepEqual(requests, [{ url: "https://mcp.example.test/health", redirect: "error" }]);
});
