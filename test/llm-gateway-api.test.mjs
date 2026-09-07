import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startGatewayApi } from "../dist/llm-gateway-api.js";
import { LlmGatewayJobStore } from "../dist/llm-gateway-store.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-gateway-api-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private");
  await fs.mkdir(workspace);
  const store = new LlmGatewayJobStore({ workspace, dataDir });
  await store.activate();
  const apiKey = "test_gateway_key";
  const api = startGatewayApi({ store, apiKey, port: 0, log: () => undefined });
  if (!api.server.listening) await new Promise((resolve) => api.server.once("listening", resolve));
  const address = api.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  t.after(async () => {
    await api.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { store, apiKey, baseUrl };
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
        additionalProperties: false,
      },
    },
  };
}

function headers(apiKey) {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("OpenAI chat completions round-trips function tools without executing them in PiLink", async (t) => {
  const { store, apiKey, baseUrl } = await fixture(t);
  const workerWait = store.exchange("api-tool-worker", undefined, 5);
  await sleep(20);

  const responsePromise = fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({
      model: "pilink",
      messages: [{ role: "user", content: "List /home/ubuntu/Projects" }],
      tools: [bashTool()],
      tool_choice: "auto",
      parallel_tool_calls: false,
      stream: false,
    }),
  });

  const claimed = await workerWait;
  assert.equal(claimed.state, "request");
  assert.deepEqual(claimed.request.tools, [bashTool()]);
  assert.equal(claimed.request.tool_choice, "auto");
  assert.equal(claimed.request.parallel_tool_calls, false);

  const nextExchange = store.exchange("api-tool-worker", {
    requestId: claimed.request.request_id,
    claimToken: claimed.request.claim_token,
    response: {
      content: null,
      tool_calls: [{
        id: "call_list_projects",
        type: "function",
        function: { name: "bash", arguments: "{\"command\":\"ls /home/ubuntu/Projects\"}" },
      }],
    },
  }, 5);

  const response = await responsePromise;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "pilink");
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(body.choices[0].message, {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "call_list_projects",
      type: "function",
      function: { name: "bash", arguments: "{\"command\":\"ls /home/ubuntu/Projects\"}" },
    }],
  });

  await store.release("test cleanup");
  assert.equal((await nextExchange).state, "released");
});

test("OpenAI endpoint accepts assistant tool history and local tool results", async (t) => {
  const { store, apiKey, baseUrl } = await fixture(t);
  const workerWait = store.exchange("api-tool-result-worker", undefined, 5);
  await sleep(20);

  const responsePromise = fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({
      model: "pilink",
      messages: [
        { role: "user", content: "List the Projects directory" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_list_projects",
            type: "function",
            function: { name: "bash", arguments: "{\"command\":\"ls /home/ubuntu/Projects\"}" },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call_list_projects",
          content: "PiLink\nOtherProject",
        },
      ],
      tools: [bashTool()],
      stream: false,
    }),
  });

  const claimed = await workerWait;
  assert.equal(claimed.state, "request");
  assert.equal(claimed.request.messages[1].content, null);
  assert.equal(claimed.request.messages[1].tool_calls[0].function.name, "bash");
  assert.equal(claimed.request.messages[2].role, "tool");
  assert.equal(claimed.request.messages[2].tool_call_id, "call_list_projects");

  const nextExchange = store.exchange("api-tool-result-worker", {
    requestId: claimed.request.request_id,
    claimToken: claimed.request.claim_token,
    response: "The Projects directory contains PiLink and OtherProject.",
  }, 5);
  const response = await responsePromise;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.choices[0].message.content, "The Projects directory contains PiLink and OtherProject.");

  await store.release("test cleanup");
  await nextExchange;
});

test("stream=true emits buffered OpenAI-compatible SSE tool-call chunks", async (t) => {
  const { store, apiKey, baseUrl } = await fixture(t);
  const workerWait = store.exchange("api-stream-worker", undefined, 5);
  await sleep(20);

  const responsePromise = fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({
      model: "pilink",
      messages: [{ role: "user", content: "Run pwd" }],
      tools: [bashTool()],
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  const claimed = await workerWait;
  assert.equal(claimed.state, "request");
  const nextExchange = store.exchange("api-stream-worker", {
    requestId: claimed.request.request_id,
    claimToken: claimed.request.claim_token,
    response: {
      content: null,
      tool_calls: [{
        id: "call_pwd",
        type: "function",
        function: { name: "bash", arguments: "{\"command\":\"pwd\"}" },
      }],
    },
  }, 5);

  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/u);
  const body = await response.text();
  assert.match(body, /"object":"chat\.completion\.chunk"/u);
  assert.match(body, /"name":"bash"/u);
  assert.match(body, /"finish_reason":"tool_calls"/u);
  assert.match(body, /"usage":\{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0\}/u);
  assert.match(body, /data: \[DONE\]/u);

  await store.release("test cleanup");
  await nextExchange;
});

test("gateway exposes a minimal OpenAI model catalog", async (t) => {
  const { apiKey, baseUrl } = await fixture(t);
  const list = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.deepEqual(listBody.data.map((model) => model.id), ["pilink"]);

  const model = await fetch(`${baseUrl}/models/pilink`, { headers: { authorization: `Bearer ${apiKey}` } });
  assert.equal(model.status, 200);
  assert.equal((await model.json()).id, "pilink");
});

test("OpenAI endpoint accepts Pi Agent payload and executes multi-turn tool loop", async (t) => {
  const { store, apiKey, baseUrl } = await fixture(t);
  const workerWaitTurn1 = store.exchange("pi-agent-worker", undefined, 5);
  await sleep(20);

  const tools = [
    bashTool(),
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a file from disk",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    },
    {
      type: "function",
      function: {
        name: "edit",
        description: "Edit a file on disk",
        parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      },
    },
    {
      type: "function",
      function: {
        name: "write",
        description: "Write a file to disk",
        parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      },
    },
  ];

  // Turn 1: Client sends request mimicking Pi Agent
  const turn1Promise = fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({
      model: "pilink",
      messages: [{ role: "user", content: [{ type: "text", text: "List the files in this folder" }] }],
      tools,
      stream: false,
      store: false,
      max_completion_tokens: 4096,
      temperature: 0.2,
      top_p: 1.0,
    }),
  });

  const claimedTurn1 = await workerWaitTurn1;
  assert.equal(claimedTurn1.state, "request");
  assert.equal(claimedTurn1.request.messages[0].content, "List the files in this folder");
  assert.equal(claimedTurn1.request.tools.length, 4);
  assert.deepEqual(claimedTurn1.request.tools.map((tool) => tool.function.name), ["bash", "read", "edit", "write"]);

  // Worker decides to call local bash tool
  const workerWaitTurn2 = store.exchange("pi-agent-worker", {
    requestId: claimedTurn1.request.request_id,
    claimToken: claimedTurn1.request.claim_token,
    response: {
      content: null,
      tool_calls: [{
        id: "call_ls_123",
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command: "ls -la" }) },
      }],
    },
  }, 5);

  const turn1Response = await turn1Promise;
  assert.equal(turn1Response.status, 200);
  const turn1Body = await turn1Response.json();
  assert.equal(turn1Body.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(turn1Body.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  const toolCall = turn1Body.choices[0].message.tool_calls[0];
  assert.equal(toolCall.id, "call_ls_123");
  assert.equal(toolCall.function.name, "bash");
  assert.equal(toolCall.function.arguments, "{\"command\":\"ls -la\"}");

  // Harness simulates local execution of bash command
  const localExecutionResult = "total 8\ndrwxr-xr-x 2 user user 4096 Sep 7 12:00 .\n-rw-r--r-- 1 user user   15 Sep 7 12:00 README.md";

  // Turn 2: Client sends tool execution result back to completions endpoint
  const turn2Promise = fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({
      model: "pilink",
      messages: [
        { role: "user", content: [{ type: "text", text: "List the files in this folder" }] },
        turn1Body.choices[0].message,
        {
          role: "tool",
          tool_call_id: toolCall.id,
          content: localExecutionResult,
        },
      ],
      tools,
      stream: false,
      store: false,
      max_completion_tokens: 4096,
    }),
  });

  const claimedTurn2 = await workerWaitTurn2;
  assert.equal(claimedTurn2.state, "request");
  assert.equal(claimedTurn2.request.messages.length, 3);
  assert.equal(claimedTurn2.request.messages[1].role, "assistant");
  assert.equal(claimedTurn2.request.messages[2].role, "tool");
  assert.equal(claimedTurn2.request.messages[2].content, localExecutionResult);

  // Worker provides final answer
  const cleanupWait = store.exchange("pi-agent-worker", {
    requestId: claimedTurn2.request.request_id,
    claimToken: claimedTurn2.request.claim_token,
    response: "The folder contains README.md.",
  }, 5);

  const turn2Response = await turn2Promise;
  assert.equal(turn2Response.status, 200);
  const turn2Body = await turn2Response.json();
  assert.equal(turn2Body.choices[0].finish_reason, "stop");
  assert.equal(turn2Body.choices[0].message.content, "The folder contains README.md.");

  await store.release("test cleanup");
  await cleanupWait;
});

