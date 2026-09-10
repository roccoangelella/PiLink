import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startGatewayApi } from "../dist/llm-gateway-api.js";
import { LlmGatewayJobStore } from "../dist/llm-gateway-store.js";

async function fixture(t, apiOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-gateway-api-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private");
  await fs.mkdir(workspace);
  const store = new LlmGatewayJobStore({ workspace, dataDir });
  await store.activate();
  const apiKey = "test-secret-gateway-key";
  const api = startGatewayApi({ store, apiKey, port: 0, log: () => undefined, ...apiOptions });
  await api.ready;
  assert.ok(api.server.listening);
  assert.match(api.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
  const baseUrl = api.baseUrl;
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

test("an HTTP client disconnect cancels its claimed gateway job", async (t) => {
  const { store, apiKey, baseUrl } = await fixture(t);
  const workerWait = store.exchange("api-disconnect-worker", undefined, 5);
  await sleep(20);
  const controller = new AbortController();
  const responsePromise = fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({
      model: "pilink",
      messages: [{ role: "user", content: "cancel me" }],
    }),
    signal: controller.signal,
  });
  const claimed = await workerWait;
  assert.equal(claimed.state, "request");
  controller.abort();
  await assert.rejects(responsePromise, /aborted|abort|terminated|fetch failed/iu);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await store.job(claimed.request.request_id)).status === "cancelled") break;
    await sleep(10);
  }
  const cancelled = await store.job(claimed.request.request_id);
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.error, /disconnected|cancelled/iu);
  await store.release("test cleanup");
});

test("capabilities require the gateway bearer key and describe the explicit profiles", async (t) => {
  const { apiKey, baseUrl } = await fixture(t);
  const unauthenticated = await fetch(`${baseUrl}/gateway/capabilities`);
  assert.equal(unauthenticated.status, 401);

  const response = await fetch(`${baseUrl}/gateway/capabilities`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.model, "pilink");
  assert.deepEqual(body.contract.accepted_models, ["pilink"]);
  assert.deepEqual(body.contract.n.accepted, [1]);
  assert.equal(body.contract.n.rejects_other, true);
  assert.equal(body.default_profile, "compatibility");
  assert.equal(body.configured_profile, "compatibility");
  assert.equal(body.contract.streaming, "buffered");
  assert.equal(body.contract.usage, "unavailable");
  assert.equal(body.profiles.strict.opt_in, true);
  assert.equal(body.profiles.strict.rejects_unavailable_usage_options, true);
});

test("authentication and request-size caps return JSON errors before enqueue", async (t) => {
  const { store, apiKey, baseUrl } = await fixture(t);
  const unauthorized = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("content-type") ?? "", /^application\/json/u);
  assert.equal((await unauthorized.json()).error.type, "invalid_api_key");

  const malformed = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get("content-type") ?? "", /^application\/json/u);
  assert.equal((await malformed.json()).error.type, "invalid_request_error");

  const oversized = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: " ".repeat(2 * 1024 * 1024 + 1),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.type, "invalid_request_error");
  assert.equal((await store.status()).queued, 0);
});

test("compatibility preserves ignored Pi controls but discloses bounded warnings", async (t) => {
  const { store, apiKey, baseUrl } = await fixture(t);
  const workerWait = store.exchange("compat-warning-worker", undefined, 5);
  const responsePromise = fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({
      model: "pilink",
      messages: [{ role: "user", content: "compatibility" }],
      temperature: 0.2,
      max_completion_tokens: 128,
      response_format: { type: "json_schema", json_schema: { name: "answer" } },
      tools: [{
        type: "function",
        function: {
          name: "bash",
          strict: true,
          parameters: { type: "object", properties: {} },
        },
      }],
    }),
  });
  const claimed = await workerWait;
  assert.equal(claimed.request.model, "pilink");
  assert.equal(claimed.request.tools[0].function.strict, true);
  await store.exchange("compat-warning-worker", {
    requestId: claimed.request.request_id,
    claimToken: claimed.request.claim_token,
    response: "accepted",
  }, 1);
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-pilink-gateway-warnings") ?? "", /temperature/iu);
  assert.match(response.headers.get("x-pilink-gateway-warnings") ?? "", /response_format/iu);
  assert.match(response.headers.get("x-pilink-gateway-warnings") ?? "", /strict/iu);
  assert.equal(response.headers.get("x-pilink-gateway-usage"), "unavailable");
  const body = await response.json();
  assert.equal(body.model, "pilink");
  assert.deepEqual(body.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  await store.release("test cleanup");
});

test("strict opt-in rejects unsupported controls before enqueue", async (t) => {
  const { store, apiKey, baseUrl } = await fixture(t);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { ...headers(apiKey), "x-pilink-gateway-profile": "strict" },
    body: JSON.stringify({
      model: "pilink",
      messages: [{ role: "user", content: "must not queue" }],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.type, "unsupported_parameter");
  assert.equal(body.error.param, "temperature");
  assert.equal((await store.status()).queued, 0);
});

test("unknown models and n other than one are rejected before enqueue", async (t) => {
  const { store, apiKey, baseUrl } = await fixture(t);
  const unknown = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ model: "unknown", messages: [{ role: "user", content: "no" }] }),
  });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.type, "model_not_found");

  const multiple = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ model: "pilink", messages: [{ role: "user", content: "no" }], n: 2 }),
  });
  assert.equal(multiple.status, 400);
  assert.equal((await multiple.json()).error.param, "n");
  const status = await store.status();
  assert.equal(status.queued, 0);
  assert.equal(status.claimed, 0);
});

test("strict responses omit unavailable usage metadata", async (t) => {
  const { store, apiKey, baseUrl } = await fixture(t, { profile: "strict" });
  const capabilities = await fetch(`${baseUrl}/gateway/capabilities`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const capabilityBody = await capabilities.json();
  assert.equal(capabilityBody.default_profile, "strict");
  assert.equal(capabilityBody.profiles.compatibility.default, false);
  assert.equal(capabilityBody.profiles.strict.default, true);
  assert.equal(capabilityBody.profiles.strict.opt_in, false);
  const workerWait = store.exchange("strict-worker", undefined, 5);
  const responsePromise = fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({
      model: "pilink",
      messages: [{ role: "user", content: "strict" }],
      n: 1,
    }),
  });
  const claimed = await workerWait;
  await store.exchange("strict-worker", {
    requestId: claimed.request.request_id,
    claimToken: claimed.request.claim_token,
    response: "done",
  }, 1);
  const response = await responsePromise;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.model, "pilink");
  assert.equal("usage" in body, false);
  assert.equal(response.headers.get("x-pilink-gateway-profile"), "strict");
  await store.release("test cleanup");
});

test("unclaimed request times out fast with 504 gateway_timeout and wake guidance", async (t) => {
  const { store, apiKey, baseUrl } = await fixture(t, { queueTimeoutSeconds: 1, requestTimeoutSeconds: 5 });
  // Prime worker session to make gateway available
  const prime = store.exchange("worker-session-prime", undefined, 1);
  await sleep(20);
  assert.equal(await store.isAvailable(), true);
  await prime; // let prime finish, so worker is no longer polling

  // Now store is still available (within stale window), but worker is NOT polling exchange
  assert.equal(await store.isAvailable(), true);

  const started = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({
      model: "pilink",
      messages: [{ role: "user", content: "ping" }],
      stream: false,
    }),
  });

  const durationMs = Date.now() - started;
  assert.equal(response.status, 504);
  const body = await response.json();
  assert.equal(body.error.type, "gateway_timeout");
  assert.match(body.error.message, /timed out in queue after 1s before being claimed/i);
  assert.match(body.error.message, /@PiLink wake/i);
  assert.ok(durationMs >= 900 && durationMs < 3500, `Expected queue timeout around 1s, got ${durationMs}ms`);

  // Verify store state has no pending queued request
  const status = await store.status();
  assert.equal(status.queued, 0);
  assert.equal(status.cancelled, 1);
});


