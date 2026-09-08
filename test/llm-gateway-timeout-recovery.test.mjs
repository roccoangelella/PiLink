import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  GATEWAY_MCP_DEFAULT_WAIT_SECONDS,
  GATEWAY_WORKER_INSTRUCTIONS,
  createGatewayMcpServer,
} from "../dist/llm-gateway-mcp.js";
import { LlmGatewayJobStore } from "../dist/llm-gateway-store.js";

async function connected(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-gateway-timeout-recovery-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private");
  await fs.mkdir(workspace);
  const store = new LlmGatewayJobStore({ workspace, dataDir });
  await store.activate();
  const handle = createGatewayMcpServer("mcp:tools", { store }, "gateway-timeout-recovery-session");
  const client = new Client({ name: "gateway-timeout-recovery-test", version: "1.0.0" });
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
      description: "Execute a shell command in the local harness",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  };
}

test("ChatGPT gateway uses a short transport-safe default poll and explicit timeout recovery instructions", () => {
  assert.equal(GATEWAY_MCP_DEFAULT_WAIT_SECONDS, 20);
  assert.match(GATEWAY_WORKER_INSTRUCTIONS, /Error: Request timed out\./u);
  assert.match(GATEWAY_WORKER_INSTRUCTIONS, /retry the exact same gateway tool with the exact same arguments/iu);
  assert.match(GATEWAY_WORKER_INSTRUCTIONS, /do not leave the worker loop/iu);
});

test("gateway_call_local_tool exact retry is idempotent after an ambiguous transport timeout", async (t) => {
  const { client, store } = await connected(t);

  const initialWait = client.callTool({
    name: "gateway_exchange",
    arguments: { maximum_wait_seconds: 2 },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const firstJob = await store.enqueueRequest({
    model: "pilink",
    messages: [{ role: "user", content: "List the workspace" }],
    tools: [bashTool()],
    toolChoice: "auto",
  });
  const claimed = JSON.parse((await initialWait).content[0].text);
  assert.equal(claimed.state, "request");
  assert.equal(claimed.request.request_id, firstJob.requestId);

  const exactArguments = {
    request_id: claimed.request.request_id,
    claim_token: claimed.request.claim_token,
    calls: [{ name: "bash", arguments: { command: "pwd" } }],
    maximum_wait_seconds: 1,
  };

  const firstSubmission = await client.callTool({
    name: "gateway_call_local_tool",
    arguments: exactArguments,
  });
  assert.notEqual(firstSubmission.isError, true);
  assert.equal(JSON.parse(firstSubmission.content[0].text).state, "idle");

  const completedBeforeRetry = await store.job(firstJob.requestId);
  assert.equal(completedBeforeRetry.status, "completed");
  const originalToolCallId = completedBeforeRetry.response.tool_calls[0].id;

  const nextJob = await store.enqueueRequest({
    model: "pilink",
    messages: [{ role: "user", content: "next request" }],
  });
  const retry = await client.callTool({
    name: "gateway_call_local_tool",
    arguments: exactArguments,
  });
  assert.notEqual(retry.isError, true);
  const retryResult = JSON.parse(retry.content[0].text);
  assert.equal(retryResult.state, "request");
  assert.equal(retryResult.request.request_id, nextJob.requestId);

  const completedAfterRetry = await store.job(firstJob.requestId);
  assert.equal(completedAfterRetry.status, "completed");
  assert.equal(completedAfterRetry.response.tool_calls[0].id, originalToolCallId);

  await store.release("test cleanup");
});
