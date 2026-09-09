import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GatewayRequestQueueTimeoutError,
  GatewayRequestTimeoutError,
  LlmGatewayJobStore,
} from "../dist/llm-gateway-store.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-llm-gateway-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private");
  await fs.mkdir(workspace);
  const store = new LlmGatewayJobStore({ workspace, dataDir });
  await store.activate();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { store };
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
        additionalProperties: false,
      },
    },
  };
}

test("gateway_exchange atomically completes one request and keeps waiting", async (t) => {
  const { store } = await fixture(t);
  const waiting = store.exchange("session-a", undefined, 2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await store.isAvailable(), true);

  const queued = await store.enqueueRequest({
    model: "pilink",
    messages: [{ role: "user", content: "ping" }],
  });
  const claimed = await waiting;
  assert.equal(claimed.state, "request");
  assert.equal(claimed.request.request_id, queued.requestId);
  assert.equal(claimed.request.messages[0].content, "ping");

  const resultWait = store.waitForResult(queued.requestId, 3);
  const idle = await store.exchange("session-a", {
    requestId: claimed.request.request_id,
    claimToken: claimed.request.claim_token,
    response: "pong",
  }, 1);
  assert.equal(idle.state, "idle");
  assert.equal(idle.continue, true);

  const completed = await resultWait;
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.response, { content: "pong" });
});

test("gateway preserves advertised tools and structured assistant tool calls", async (t) => {
  const { store } = await fixture(t);
  const waiting = store.exchange("session-tools", undefined, 3);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const queued = await store.enqueueRequest({
    model: "pilink",
    messages: [{ role: "user", content: "List /home/ubuntu/Projects" }],
    tools: [bashTool()],
    toolChoice: "auto",
    parallelToolCalls: false,
  });
  const claimed = await waiting;
  assert.equal(claimed.state, "request");
  assert.deepEqual(claimed.request.tools, [bashTool()]);
  assert.equal(claimed.request.tool_choice, "auto");
  assert.equal(claimed.request.parallel_tool_calls, false);

  const resultWait = store.waitForResult(queued.requestId, 3);
  const idle = await store.exchange("session-tools", {
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
  }, 1);
  assert.equal(idle.state, "idle");

  const completed = await resultWait;
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

test("gateway rejects tool calls not advertised by the local harness", async (t) => {
  const { store } = await fixture(t);
  const waiting = store.exchange("session-tool-contract", undefined, 3);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.enqueueRequest({
    model: "pilink",
    messages: [{ role: "user", content: "Read something" }],
    tools: [bashTool()],
    toolChoice: "auto",
  });
  const claimed = await waiting;
  assert.equal(claimed.state, "request");

  await assert.rejects(
    store.exchange("session-tool-contract", {
      requestId: claimed.request.request_id,
      claimToken: claimed.request.claim_token,
      response: {
        content: null,
        tool_calls: [{
          id: "call_unavailable",
          type: "function",
          function: { name: "read_secret_file", arguments: "{}" },
        }],
      },
    }, 1),
    /unavailable function/i,
  );

  const job = await store.job(claimed.request.request_id);
  assert.equal(job.status, "claimed");
  await store.release("test cleanup");
});

test("gateway validates tool_choice and parallel tool constraints", async (t) => {
  const { store } = await fixture(t);
  const waiting = store.exchange("session-tool-choice", undefined, 3);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.enqueueRequest({
    model: "pilink",
    messages: [{ role: "user", content: "Use bash" }],
    tools: [bashTool()],
    toolChoice: { type: "function", function: { name: "bash" } },
    parallelToolCalls: false,
  });
  const claimed = await waiting;
  assert.equal(claimed.state, "request");

  await assert.rejects(
    store.exchange("session-tool-choice", {
      requestId: claimed.request.request_id,
      claimToken: claimed.request.claim_token,
      response: { content: "I will not call the tool." },
    }, 1),
    /must call required function 'bash'/i,
  );

  await assert.rejects(
    store.exchange("session-tool-choice", {
      requestId: claimed.request.request_id,
      claimToken: claimed.request.claim_token,
      response: {
        content: null,
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "bash", arguments: "{\"command\":\"pwd\"}" } },
          { id: "call_b", type: "function", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } },
        ],
      },
    }, 1),
    /parallel tool calls/i,
  );
  await store.release("test cleanup");
});

test("a distinct fresh gateway worker cannot take over the active worker", async (t) => {
  const { store } = await fixture(t);
  const waiting = store.exchange("session-primary", undefined, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await store.isAvailable(), true);

  await assert.rejects(
    store.exchange("session-other-client", undefined, 1),
    /another ChatGPT gateway MCP session is already active/i,
  );

  await store.release("test cleanup");
  const released = await waiting;
  assert.equal(released.state, "released");
});

test("release is the only terminal gateway lifecycle state", async (t) => {
  const { store } = await fixture(t);
  const waiting = store.exchange("session-release", undefined, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await store.release("operator stop");
  const result = await waiting;
  assert.deepEqual(result, {
    state: "released",
    continue: false,
    reason: "operator stop",
  });
  const status = await store.status();
  assert.equal(status.state, "released");
});

test("a disconnected session makes the gateway unavailable until a new exchange", async (t) => {
  const { store } = await fixture(t);
  const waiting = store.exchange("session-disconnect", undefined, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await store.isAvailable(), true);

  await store.disconnectSession("session-disconnect");
  assert.equal(await store.isAvailable(), false);
  const disconnected = await waiting;
  assert.equal(disconnected.state, "idle");
  assert.equal(disconnected.continue, true);
  assert.equal(await store.isAvailable(), false);

  const resumed = store.exchange("session-disconnect", undefined, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await store.isAvailable(), true);
  await store.release("test cleanup");
  const released = await resumed;
  assert.equal(released.state, "released");
  assert.equal(released.continue, false);
});

test("waitForResult throws GatewayRequestQueueTimeoutError fast when queued past queueTimeoutSeconds", async (t) => {
  const { store } = await fixture(t);
  const queued = await store.enqueueRequest({
    model: "pilink",
    messages: [{ role: "user", content: "hello" }],
  });

  const started = Date.now();
  await assert.rejects(
    store.waitForResult(queued.requestId, 10, undefined, 1),
    (error) => {
      assert.ok(error instanceof GatewayRequestQueueTimeoutError);
      assert.ok(error instanceof GatewayRequestTimeoutError);
      assert.match(error.message, /timed out in queue after 1s before being claimed/i);
      assert.match(error.message, /@PiLink wake/i);
      return true;
    },
  );
  const durationMs = Date.now() - started;
  assert.ok(durationMs >= 900 && durationMs < 3000, `Expected fast queue timeout around 1s, got ${durationMs}ms`);
});

test("waitForResult throws GatewayRequestTimeoutError when execution exceeds executionTimeoutSeconds after being claimed", async (t) => {
  const { store } = await fixture(t);
  const waiting = store.exchange("session-exec-timeout", undefined, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const queued = await store.enqueueRequest({
    model: "pilink",
    messages: [{ role: "user", content: "long thinking prompt" }],
  });
  const claimed = await waiting;
  assert.equal(claimed.state, "request");

  const started = Date.now();
  await assert.rejects(
    store.waitForResult(queued.requestId, 1),
    (error) => {
      assert.ok(error instanceof GatewayRequestTimeoutError);
      assert.ok(!(error instanceof GatewayRequestQueueTimeoutError));
      assert.match(error.message, /Gateway request timed out before ChatGPT returned a completion/i);
      return true;
    },
  );
  const durationMs = Date.now() - started;
  assert.ok(durationMs >= 900 && durationMs < 3000, `Expected execution timeout around 1s, got ${durationMs}ms`);
  await store.release("test cleanup");
});

test("terminal jobs strip messages and tools to prevent state bloat", async (t) => {
  const { store } = await fixture(t);
  const waiting = store.exchange("session-bloat", undefined, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const largeContent = "x".repeat(50_000);
  const queued = await store.enqueueRequest({
    model: "pilink",
    messages: [{ role: "user", content: largeContent }],
    tools: [bashTool()],
  });

  const claimed = await waiting;
  assert.equal(claimed.state, "request");
  assert.equal(claimed.request.messages[0].content.length, 50_000);

  const idle = await store.exchange("session-bloat", {
    requestId: claimed.request.request_id,
    claimToken: claimed.request.claim_token,
    response: "done",
  }, 1);
  assert.equal(idle.state, "idle");

  const completed = await store.job(queued.requestId);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.response, { content: "done" });
  assert.deepEqual(completed.messages, [{ role: "user", content: "" }]);
  assert.equal(completed.tools, undefined);

  // Verify on-disk serialized state size is tiny (< 2KB) instead of containing the 50KB payload
  const rawDisk = await fs.readFile(store.statePath, "utf8");
  assert.ok(rawDisk.length < 2048, `Expected stripped state < 2KB, got ${rawDisk.length} bytes`);
  assert.ok(!rawDisk.includes("xxxxx"), "State file must not retain bloated messages");
  await store.release("test cleanup");
});

test("pruneJobs limits stored jobs to MAX_RETAINED_JOBS", async (t) => {
  const { store } = await fixture(t);

  // Enqueue and cancel 40 requests
  for (let i = 0; i < 40; i++) {
    const job = await store.enqueueRequest({
      model: "pilink",
      messages: [{ role: "user", content: `job-${i}` }],
    });
    await store.cancelRequest(job.requestId);
  }

  const rawDisk = await fs.readFile(store.statePath, "utf8");
  const parsed = JSON.parse(rawDisk);
  assert.ok(parsed.jobs.length <= 32, `Expected <= 32 retained jobs, got ${parsed.jobs.length}`);
});
