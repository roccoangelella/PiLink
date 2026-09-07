import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LlmGatewayJobStore } from "../dist/llm-gateway-store.js";

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
  assert.equal(completed.response, "pong");
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
