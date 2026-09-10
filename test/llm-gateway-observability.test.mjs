import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LlmGatewayJobStore } from "../dist/llm-gateway-store.js";

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-llm-gateway-observability-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private");
  await fs.mkdir(workspace);
  const store = new LlmGatewayJobStore({ workspace, dataDir, ...options });
  await store.activate();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return store;
}

function request(content) {
  return { model: "pilink", messages: [{ role: "user", content }] };
}

async function eventuallyStatus(store, predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await store.status();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`status condition was not met: ${JSON.stringify(latest)}`);
}

test("status separates an active wait, an unconfirmed claim, and the idle gap", async (t) => {
  const store = await fixture(t, { claimLeaseSeconds: 30 });
  assert.deepEqual(await store.status(), {
    state: "waiting_for_chatgpt",
    queued: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    worker_polling: false,
    pending_worker_polls: 0,
    worker_contact: "never",
    processing_claim: false,
    oldest_queue_age_ms: 0,
    next_action: "wake_worker",
  });

  const poll = store.exchange("observability-worker", undefined, 2);
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 1);
  const queued = await store.enqueueRequest(request("claim me"));
  const claimed = await poll;
  assert.equal(claimed.state, "request");

  const claimSnapshot = await store.job(queued.requestId);
  const claimedStatus = await store.status();
  assert.equal(claimedStatus.worker_polling, false);
  assert.equal(claimedStatus.pending_worker_polls, 0);
  assert.equal(claimedStatus.processing_claim, true);
  assert.equal(claimedStatus.worker_contact, "recent");
  assert.ok(claimedStatus.claim_age_ms >= 0);
  assert.equal(claimedStatus.lease_expires_at, claimSnapshot.leaseExpiresAt);
  assert.equal(claimedStatus.oldest_queue_age_ms, 0);
  assert.equal(claimedStatus.next_action, "wait_for_worker");
  assert.equal("generating" in claimedStatus, false);

  const completion = store.exchange("observability-worker", {
    requestId: claimed.request.request_id,
    claimToken: claimed.request.claim_token,
    response: "done",
  }, 1);
  const idleGap = await eventuallyStatus(
    store,
    (status) => status.pending_worker_polls === 1 && status.processing_claim === false,
  );
  assert.equal(idleGap.worker_polling, true);
  assert.equal(idleGap.worker_contact, "recent");
  assert.equal(idleGap.next_action, "wait_for_worker");
  assert.equal((await completion).state, "idle");
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 0);
  await store.release("test cleanup");
});

test("concurrent polls are counted independently and leave no poller behind", async (t) => {
  const store = await fixture(t);
  const first = store.exchange("concurrent-observability-worker", undefined, 2);
  const second = store.exchange("concurrent-observability-worker", undefined, 2);
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 2 && status.worker_polling === true);

  const queued = await store.enqueueRequest(request("one delivery"));
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.state, "request");
  assert.equal(secondResult.state, "request");
  assert.equal(firstResult.request.request_id, queued.requestId);
  assert.equal(secondResult.request.request_id, queued.requestId);
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 0 && status.worker_polling === false);
  assert.equal((await store.status()).processing_claim, true);
  await store.release("test cleanup");
});

test("abort, exchange errors, timeout, and release all decrement pending polls", async (t) => {
  const store = await fixture(t);

  const abortController = new AbortController();
  const aborted = store.exchange("lifecycle-worker", undefined, 2, abortController.signal);
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 1);
  abortController.abort();
  await assert.rejects(aborted, /Gateway exchange was cancelled|Gateway wait was cancelled/iu);
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 0);

  const primaryController = new AbortController();
  const primary = store.exchange("lifecycle-worker", undefined, 2, primaryController.signal);
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 1);
  await assert.rejects(
    store.exchange("different-worker", undefined, 1),
    /another ChatGPT gateway MCP session is already active/iu,
  );
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 1);
  primaryController.abort();
  await assert.rejects(primary, /Gateway exchange was cancelled|Gateway wait was cancelled/iu);
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 0);

  const timedOut = await store.exchange("lifecycle-worker", undefined, 1);
  assert.equal(timedOut.state, "idle");
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 0);

  const releasedPoll = store.exchange("lifecycle-worker", undefined, 2);
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 1);
  await store.release("operator stop");
  assert.equal((await releasedPoll).state, "released");
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 0);
});

test("replacement generations retire the old poll without decrementing the replacement", async (t) => {
  const store = await fixture(t);
  const oldPoll = store.exchange("replacement-worker", undefined, 2);
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 1);

  const disconnecting = store.disconnectSession("replacement-worker");
  const replacement = store.exchange("replacement-worker", undefined, 2);

  assert.equal((await oldPoll).state, "idle");
  await disconnecting;
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 1);
  const queued = await store.enqueueRequest(request("after replacement"));
  const replacementClaim = await replacement;
  assert.equal(replacementClaim.state, "request");
  assert.equal(replacementClaim.request.request_id, queued.requestId);
  await eventuallyStatus(store, (status) => status.pending_worker_polls === 0);
  await store.release("test cleanup");
});
