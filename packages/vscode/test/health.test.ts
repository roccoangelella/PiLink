import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { cancelAdminAgentTurn, createOwnerPairing, isLoopbackPortOccupied, readAdminAgentOutput, readAdminAgents, readAdminCollaboration, readAdminStatus, readAuthenticatedHealth, readHealth, sendAdminAgentMessage, spawnAdminAgent, stopAdminAgent, waitForAdminRuntime, waitForHealth, waitForPublicHealth } from "../src/health.js";

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

test("readHealth returns a valid object payload from the health endpoint", async (t) => {
  let observedRequest: { method?: string; url?: string; accept?: string } = {};
  const port = await startHttpServer(t, (request, response) => {
    observedRequest = {
      method: request.method,
      url: request.url,
      accept: request.headers.accept,
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ server: "pilink", status: "ok", sessions: { active: 2 } }));
  });

  assert.deepEqual(await readHealth(port), {
    online: true,
    payload: { server: "pilink", status: "ok", sessions: { active: 2 } },
  });
  assert.deepEqual(observedRequest, {
    method: "GET",
    url: "/health",
    accept: "application/json",
  });
});

test("readAuthenticatedHealth verifies the private PiLink HMAC challenge", async (t) => {
  const bootstrapSecret = "b".repeat(32);
  let observedChallenge = "";
  const port = await startHttpServer(t, (request, response) => {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    observedChallenge = url.searchParams.get("challenge") || "";
    const version = "1.1.0";
    const proof = crypto
      .createHmac("sha256", bootstrapSecret)
      .update(`pilink-health-v1\0${observedChallenge}\0${version}\0${port}`)
      .digest("base64url");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      server: "pilink",
      status: "ok",
      version,
      auth_scheme: "pilink-health-hmac-v1",
      challenge: observedChallenge,
      proof,
    }));
  });

  const result = await readAuthenticatedHealth(port, bootstrapSecret);
  assert.equal(result.online, true);
  assert.match(observedChallenge, /^[A-Za-z0-9_-]{43}$/);

  const wrongSecret = await readAuthenticatedHealth(port, "x".repeat(32));
  assert.equal(wrongSecret.online, false);
  assert.match(wrongSecret.error || "", /authenticated health proof does not match/);
});

test("readAuthenticatedHealth rejects a PiLink-shaped response without a proof", async (t) => {
  const port = await startHttpServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ server: "pilink", status: "ok", version: "1.1.0" }));
  });
  const result = await readAuthenticatedHealth(port, "b".repeat(32));
  assert.equal(result.online, false);
  assert.match(result.error || "", /authenticated health proof/);
});

test("readHealth reports HTTP and malformed-payload errors", async (t) => {
  const httpErrorPort = await startHttpServer(t, (_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "starting" }));
  });
  assert.deepEqual(await readHealth(httpErrorPort), {
    online: false,
    payload: null,
    error: "HTTP 503",
  });

  const invalidJsonPort = await startHttpServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("not-json");
  });
  const invalidJson = await readHealth(invalidJsonPort);
  assert.equal(invalidJson.online, false);
  assert.equal(invalidJson.payload, null);
  assert.ok(invalidJson.error);

  const arrayPort = await startHttpServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  assert.deepEqual(await readHealth(arrayPort), {
    online: false,
    payload: null,
    error: "Invalid health response",
  });

  const impostorPort = await startHttpServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
  });
  assert.deepEqual(await readHealth(impostorPort), {
    online: false,
    payload: null,
    error: "The configured port does not belong to PiLink",
  });
});

test("readHealth rejects responses larger than 256 KiB", async (t) => {
  const port = await startHttpServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ payload: "x".repeat(256 * 1024) }));
  });

  assert.deepEqual(await readHealth(port), {
    online: false,
    payload: null,
    error: "The health response is too large",
  });
});

test("waitForHealth retries errors until the server becomes healthy", async (t) => {
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

  assert.deepEqual(await waitForHealth(port, 2_000), {
    online: true,
    payload: { server: "pilink", status: "ok" },
  });
  assert.equal(requests, 2);
});

test("private admin endpoints report real ChatGPT activity and create one-use pairing", async (t) => {
  const bootstrapSecret = "s".repeat(32);
  const observed: Array<{ method?: string; path: string; authorization?: string }> = [];
  let port = 0;
  port = await startHttpServer(t, (request, response) => {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/health") {
      const challenge = url.searchParams.get("challenge") || "";
      const version = "1.1.0";
      const proof = crypto.createHmac("sha256", bootstrapSecret)
        .update(`pilink-health-v1\0${challenge}\0${version}\0${port}`)
        .digest("base64url");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ server: "pilink", version, auth_scheme: "pilink-health-hmac-v1", challenge, proof }));
      return;
    }
    observed.push({ method: request.method, path: url.pathname, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/admin/status") {
      response.end(JSON.stringify({ sessions: { active: 3, total: 4 }, activity: { chatgptConnected: true } }));
      return;
    }
    if (url.pathname === "/admin/oauth/pairing") {
      response.end(JSON.stringify({
        pairing_url: "https://mcp.example.test/oauth/pair?code=one-use",
        verification_code: "ABCD-2345",
        expires_at: "2026-08-03T01:00:00.000Z",
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
    expiresAt: "2026-08-03T01:00:00.000Z",
  });
  assert.deepEqual(observed, [
    { method: "GET", path: "/admin/status", authorization: `Bearer ${bootstrapSecret}` },
    { method: "POST", path: "/admin/oauth/pairing", authorization: `Bearer ${bootstrapSecret}` },
  ]);
});

test("collaboration monitor reads bounded ChatGPT agent chat, tasks and MCP clients", async (t) => {
  const bootstrapSecret = "c".repeat(32);
  let port = 0;
  port = await startHttpServer(t, (request, response) => {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/health") {
      const challenge = url.searchParams.get("challenge") || "";
      const version = "2.2.0";
      const proof = crypto.createHmac("sha256", bootstrapSecret)
        .update(`pilink-health-v1\0${challenge}\0${version}\0${port}`)
        .digest("base64url");
      response.end(JSON.stringify({ server: "pilink", version, auth_scheme: "pilink-health-hmac-v1", challenge, proof }));
      return;
    }
    assert.equal(request.headers.authorization, `Bearer ${bootstrapSecret}`);
    assert.equal(url.pathname, "/admin/collaboration");
    assert.equal(url.searchParams.get("chat_limit"), "20");
    assert.equal(url.searchParams.get("task_limit"), "200");
    response.end(JSON.stringify({
      project_key: "a".repeat(64),
      chat: {
        latest_cursor: 7,
        messages: [{ cursor: 7, agent_id: "client-1", agent_instance_id: "instance-1", agent_name: "dev1", message: "Implementazione completata" }],
      },
      tasks: [{
        task_id: "12345678-1234-4234-8234-123456789abc",
        title: "Aggiorna OAuth",
        status: "working",
        created_by: "manager",
        owner: "dev1",
        created_at: "2026-08-04T00:00:00.000Z",
        updated_at: "2026-08-04T00:01:00.000Z",
        revision: 2,
      }],
      tool_activity: [{
        tool: "read",
        started_at: "2026-08-04T00:01:30.000Z",
        duration_ms: 42,
        outcome: "success",
        access_mode: "workspace",
        client_id: "client-1",
      }, {
        tool: "bash",
        started_at: "invalid",
        duration_ms: 1,
        outcome: "success",
        access_mode: "full-access",
        args: { command: "must never enter the webview" },
      }],
      clients: [{ clientId: "abcd…wxyz", activeMcpSessions: 1, mcpInitializedAt: "2026-08-04T00:00:00.000Z" }],
    }));
  });

  const result = await readAdminCollaboration(port, bootstrapSecret);
  assert.equal(result.projectKey, "a".repeat(64));
  assert.equal(result.latestCursor, 7);
  assert.deepEqual(result.messages[0], {
    cursor: 7,
    agentId: "client-1",
    agentInstanceId: "instance-1",
    agentName: "dev1",
    message: "Implementazione completata",
  });
  assert.equal(result.tasks[0]?.owner, "dev1");
  assert.deepEqual(result.activity, [{
    tool: "read",
    startedAt: "2026-08-04T00:01:30.000Z",
    durationMs: 42,
    outcome: "success",
    accessMode: "workspace",
    clientId: "client-1",
  }]);
  assert.equal(result.clients[0]?.activeMcpSessions, 1);
});

test("waitForAdminRuntime requires HMAC identity and a ready Pi agent runtime", async (t) => {
  const bootstrapSecret = "r".repeat(32);
  let adminRequests = 0;
  let port = 0;
  port = await startHttpServer(t, (request, response) => {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/health") {
      const challenge = url.searchParams.get("challenge") || "";
      const version = "1.1.0";
      const proof = crypto.createHmac("sha256", bootstrapSecret)
        .update(`pilink-health-v1\0${challenge}\0${version}\0${port}`)
        .digest("base64url");
      response.end(JSON.stringify({ server: "pilink", version, auth_scheme: "pilink-health-hmac-v1", challenge, proof }));
      return;
    }
    if (url.pathname === "/admin/status") {
      adminRequests += 1;
      response.end(JSON.stringify({
        sessions: { active: 0 },
        agents: adminRequests > 1
          ? { state: "ready", runtime: { state: "ready" } }
          : { state: "disabled", runtime: { state: "disabled" } },
      }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });

  const result = await waitForAdminRuntime(port, bootstrapSecret, 2_000);
  assert.equal(result.online, true);
  assert.equal(adminRequests, 2);
});

test("loopback port probe is conservative for occupied and released ports", async () => {
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

test("waitForPublicHealth verifies HTTPS origin identity without following redirects", async () => {
  const requests: Array<{ url: string; redirect?: RequestRedirect }> = [];
  let attempts = 0;
  const fetchImplementation: typeof fetch = async (input, init) => {
    attempts += 1;
    requests.push({ url: String(input), redirect: init?.redirect });
    if (attempts === 1) return new Response("temporary", { status: 503 });
    return new Response(JSON.stringify({ server: "pilink", status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  assert.deepEqual(await waitForPublicHealth("https://mcp.example.test", 2_000, fetchImplementation), {
    online: true,
    payload: { server: "pilink", status: "ok" },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(requests, [
    { url: "https://mcp.example.test/health", redirect: "error" },
    { url: "https://mcp.example.test/health", redirect: "error" },
  ]);
  assert.equal((await waitForPublicHealth("http://mcp.example.test", 1, fetchImplementation)).online, false);
});

test("agent output pagination returns the complete retained conversation", async (t) => {
  const bootstrapSecret = "p".repeat(32);
  const retained = Array.from({ length: 150 }, (_value, index) => ({
    cursor: index + 1,
    channel: (index + 1) % 2 === 0 ? "assistant" : "user",
    text: `message-${index + 1}`,
    created_at: "2026-08-04T00:00:00.000Z",
  }));
  const observedAfter: number[] = [];
  let healthRequests = 0;
  let port = 0;
  port = await startHttpServer(t, (request, response) => {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/health") {
      healthRequests += 1;
      const challenge = url.searchParams.get("challenge") || "";
      const version = "2.2.0";
      const proof = crypto.createHmac("sha256", bootstrapSecret)
        .update(`pilink-health-v1\0${challenge}\0${version}\0${port}`)
        .digest("base64url");
      response.end(JSON.stringify({ server: "pilink", version, auth_scheme: "pilink-health-hmac-v1", challenge, proof }));
      return;
    }
    assert.equal(request.headers.authorization, `Bearer ${bootstrapSecret}`);
    assert.equal(url.pathname, "/admin/agents/agent-1/output");
    assert.equal(url.searchParams.get("limit"), "100");
    const after = Number(url.searchParams.get("after"));
    observedAfter.push(after);
    const entries = retained.filter((entry) => entry.cursor > after).slice(0, 100);
    response.end(JSON.stringify({
      oldest_cursor: 1,
      latest_cursor: retained.at(-1)?.cursor,
      next_cursor: entries.at(-1)?.cursor ?? after,
      gap: false,
      entries,
    }));
  });

  const output = await readAdminAgentOutput(port, bootstrapSecret, "agent-1");
  assert.equal(output.length, 150);
  assert.deepEqual([output[0]?.text, output.at(-1)?.text], ["message-1", "message-150"]);
  assert.deepEqual(observedAfter, [0, 100]);
  assert.equal(healthRequests, 2);
});

test("graphical agent administration verifies local identity before every bounded request", async (t) => {
  const bootstrapSecret = "a".repeat(32);
  let healthRequests = 0;
  const bodies: unknown[] = [];
  let port = 0;
  port = await startHttpServer(t, async (request, response) => {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/health") {
      healthRequests += 1;
      const challenge = url.searchParams.get("challenge") || "";
      const version = "1.1.0";
      const proof = crypto.createHmac("sha256", bootstrapSecret)
        .update(`pilink-health-v1\0${challenge}\0${version}\0${port}`)
        .digest("base64url");
      response.end(JSON.stringify({ server: "pilink", version, auth_scheme: "pilink-health-hmac-v1", challenge, proof }));
      return;
    }
    assert.equal(request.headers.authorization, `Bearer ${bootstrapSecret}`);
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      bodies.push(JSON.parse(body));
    }
    const agent = {
      agent_id: "agent-1",
      role: { canonical_role_id: "implementer", occupancy_label: "dev" },
      label: "Test agent",
      status: "running",
      has_error: false,
      updated_at: "2026-08-03T00:00:00.000Z",
    };
    if (url.pathname === "/admin/agents") response.end(JSON.stringify({ state: "ready", agents: [agent] }));
    else if (url.pathname === "/admin/agents/spawn") { response.statusCode = 201; response.end(JSON.stringify({ agent })); }
    else if (url.pathname === "/admin/agents/agent-1/send") { response.statusCode = 202; response.end(JSON.stringify({ agent })); }
    else if (url.pathname === "/admin/agents/agent-1/cancel") response.end(JSON.stringify({ agent: { ...agent, status: "waiting" } }));
    else if (url.pathname === "/admin/agents/agent-1/stop") response.end(JSON.stringify({ agent: { ...agent, status: "stopped" } }));
    else if (url.pathname === "/admin/agents/agent-1/output") response.end(JSON.stringify({ entries: [{ cursor: 1, channel: "assistant", text: "done", created_at: "now" }] }));
    else { response.statusCode = 404; response.end("{}"); }
  });

  assert.equal((await readAdminAgents(port, bootstrapSecret)).agents[0]?.agentId, "agent-1");
  assert.equal((await spawnAdminAgent(port, bootstrapSecret, {
    role: "implementer",
    initialMessage: "bounded task",
    permissions: ["workspace:read", "workspace:write"],
  })).status, "running");
  assert.equal((await sendAdminAgentMessage(port, bootstrapSecret, "agent-1", "continue safely")).status, "running");
  assert.equal((await cancelAdminAgentTurn(port, bootstrapSecret, "agent-1", "stop this turn")).status, "waiting");
  assert.equal((await stopAdminAgent(port, bootstrapSecret, "agent-1")).status, "stopped");
  assert.equal((await readAdminAgentOutput(port, bootstrapSecret, "agent-1"))[0]?.text, "done");
  assert.equal(healthRequests, 6);
  assert.deepEqual(bodies[0], {
    role: "implementer",
    initial_message: "bounded task",
    permissions: ["workspace:read", "workspace:write"],
  });
  assert.deepEqual(bodies[1], { message: "continue safely" });
  assert.deepEqual(bodies[2], { reason: "stop this turn" });
});
