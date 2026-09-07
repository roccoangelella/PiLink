import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGatewayMcpServer, gatewayWorkerSessionId } from "../dist/llm-gateway-mcp.js";
import { LlmGatewayJobStore } from "../dist/llm-gateway-store.js";

async function connected(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-gateway-mcp-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private");
  await fs.mkdir(workspace);
  const store = new LlmGatewayJobStore({ workspace, dataDir });
  await store.activate();
  const handle = createGatewayMcpServer("mcp:tools", { store }, "gateway-test-session");
  const client = new Client({ name: "gateway-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.connect(serverTransport)]);
  t.after(async () => {
    await client.close();
    await handle.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { client, store };
}

function bashTool() {
  return {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a shell command in the local agent harness",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  };
}

test("gateway OAuth worker identity is stable without exposing the client id", () => {
  const first = gatewayWorkerSessionId("pi_client_alpha");
  const repeated = gatewayWorkerSessionId("pi_client_alpha");
  const second = gatewayWorkerSessionId("pi_client_beta");
  assert.equal(first, repeated);
  assert.notEqual(first, second);
  assert.match(first, /^oauth_[A-Za-z0-9_-]{43}$/u);
  assert.doesNotMatch(first, /pi_client_alpha/u);
});

test("gateway MCP catalog exposes only gateway_exchange", async (t) => {
  const { client, store } = await connected(t);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(tools, ["gateway_exchange"]);

  const wait = client.callTool({ name: "gateway_exchange", arguments: { maximum_wait_seconds: 2 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const queued = await store.enqueueRequest({
    model: "pilink",
    messages: [{ role: "user", content: "hello" }],
  });
  const claimed = JSON.parse((await wait).content[0].text);
  assert.equal(claimed.state, "request");
  assert.equal(claimed.request.request_id, queued.requestId);

  const second = client.callTool({
    name: "gateway_exchange",
    arguments: {
      request_id: claimed.request.request_id,
      claim_token: claimed.request.claim_token,
      response: "world",
      maximum_wait_seconds: 2,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const nextJob = await store.enqueueRequest({
    model: "pilink",
    messages: [{ role: "user", content: "next" }],
  });
  const exchanged = JSON.parse((await second).content[0].text);
  assert.equal(exchanged.state, "request");
  assert.equal(exchanged.request.request_id, nextJob.requestId);

  const completed = await store.job(queued.requestId);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.response, { content: "world" });
});

test("gateway_exchange carries harness tools and returns typed tool calls", async (t) => {
  const { client, store } = await connected(t);
  const wait = client.callTool({ name: "gateway_exchange", arguments: { maximum_wait_seconds: 2 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const queued = await store.enqueueRequest({
    model: "pilink",
    messages: [{ role: "user", content: "List /home/ubuntu/Projects" }],
    tools: [bashTool()],
    toolChoice: "auto",
    parallelToolCalls: false,
  });
  const claimed = JSON.parse((await wait).content[0].text);
  assert.equal(claimed.state, "request");
  assert.deepEqual(claimed.request.tools, [bashTool()]);
  assert.equal(claimed.request.tool_choice, "auto");
  assert.equal(claimed.request.parallel_tool_calls, false);

  const submit = client.callTool({
    name: "gateway_exchange",
    arguments: {
      request_id: claimed.request.request_id,
      claim_token: claimed.request.claim_token,
      tool_calls: [{
        id: "call_list_projects",
        type: "function",
        function: {
          name: "bash",
          arguments: "{\"command\":\"ls /home/ubuntu/Projects\"}",
        },
      }],
      maximum_wait_seconds: 1,
    },
  });
  const submitted = JSON.parse((await submit).content[0].text);
  assert.equal(submitted.state, "idle");

  const completed = await store.job(queued.requestId);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.response, {
    content: null,
    tool_calls: [{
      id: "call_list_projects",
      type: "function",
      function: { name: "bash", arguments: "{\"command\":\"ls /home/ubuntu/Projects\"}" },
    }],
  });
});

test("gateway_exchange rejects a tool call for an unadvertised function", async (t) => {
  const { client, store } = await connected(t);
  const wait = client.callTool({ name: "gateway_exchange", arguments: { maximum_wait_seconds: 2 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.enqueueRequest({
    model: "pilink",
    messages: [{ role: "user", content: "Do something" }],
    tools: [bashTool()],
  });
  const claimed = JSON.parse((await wait).content[0].text);
  const result = await client.callTool({
    name: "gateway_exchange",
    arguments: {
      request_id: claimed.request.request_id,
      claim_token: claimed.request.claim_token,
      tool_calls: [{
        id: "call_bad",
        type: "function",
        function: { name: "delete_everything", arguments: "{}" },
      }],
      maximum_wait_seconds: 1,
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unavailable function/i);
  await store.release("test cleanup");
});

test("same OAuth worker survives ChatGPT MCP transport replacement", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-gateway-reconnect-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private");
  await fs.mkdir(workspace);
  const store = new LlmGatewayJobStore({ workspace, dataDir });
  await store.activate();
  const workerId = gatewayWorkerSessionId("pi_reconnecting_chatgpt_client");

  const handleA = createGatewayMcpServer("mcp:tools", { store }, workerId);
  const clientA = new Client({ name: "gateway-reconnect-a", version: "1.0.0" });
  const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
  await Promise.all([clientA.connect(clientTransportA), handleA.connect(serverTransportA)]);

  const firstIdle = await clientA.callTool({
    name: "gateway_exchange",
    arguments: { maximum_wait_seconds: 1 },
  });
  assert.equal(JSON.parse(firstIdle.content[0].text).state, "idle");

  const handleB = createGatewayMcpServer("mcp:tools", { store }, workerId);
  const clientB = new Client({ name: "gateway-reconnect-b", version: "1.0.0" });
  const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
  await Promise.all([clientB.connect(clientTransportB), handleB.connect(serverTransportB)]);

  const waitingB = clientB.callTool({
    name: "gateway_exchange",
    arguments: { maximum_wait_seconds: 2 },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await store.isAvailable(), true);

  await clientA.close();
  await handleA.close();
  assert.equal(await store.isAvailable(), true, "closing the superseded transport must not disconnect the replacement");

  const queued = await store.enqueueRequest({
    model: "pilink",
    messages: [{ role: "user", content: "transport replacement" }],
  });
  const claimed = JSON.parse((await waitingB).content[0].text);
  assert.equal(claimed.state, "request");
  assert.equal(claimed.request.request_id, queued.requestId);

  await store.release("test cleanup");
  await clientB.close();
  await handleB.close();
  await fs.rm(root, { recursive: true, force: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
});

test("gateway_exchange rejects partial completion tuples", async (t) => {
  const { client } = await connected(t);
  const result = await client.callTool({
    name: "gateway_exchange",
    arguments: { request_id: "req_00000000-0000-0000-0000-000000000000" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /request_id, claim_token/i);
});
