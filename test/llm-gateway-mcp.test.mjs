import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGatewayMcpServer } from "../dist/llm-gateway-mcp.js";
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
  assert.equal(completed.response, "world");
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
