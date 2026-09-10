import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LlmGatewayJobStore } from "../dist/llm-gateway-store.js";
import { GATEWAY_WORKER_INSTRUCTIONS } from "../dist/llm-gateway-mcp.js";

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-gateway-first-release-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private");
  await fs.mkdir(workspace);
  const store = new LlmGatewayJobStore({ workspace, dataDir, ...options });
  await store.activate();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { store };
}

function request(content) {
  return { model: "pilink", messages: [{ role: "user", content }] };
}

function tool(name = "bash") {
  return {
    type: "function",
    function: {
      name,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  };
}

function call(name = "bash") {
  return {
    id: `call_${name}`,
    type: "function",
    function: { name, arguments: "{}" },
  };
}

async function eventuallyResult(promise, timeoutMs = 500) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`result did not arrive within ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

test("replays a lost initial delivery and a lost completion response without claiming C", async (t) => {
  const { store } = await fixture(t);
  const firstPoll = store.exchange("single-worker", undefined, 2);
  const jobA = await store.enqueueRequest(request("A"));
  const jobB = await store.enqueueRequest(request("B"));
  const claimedA = await firstPoll;
  assert.equal(claimedA.state, "request");

  // The first poll response is lost: retrying the poll must still return A.
  const repeatedPoll = await store.exchange("single-worker", undefined, 1);
  assert.equal(repeatedPoll.state, "request");
  assert.equal(repeatedPoll.request.request_id, jobA.requestId);

  // The completion response carrying B is lost. C is queued before the retry;
  // the exact retry must replay B and must not skip to C.
  const firstSubmit = await store.exchange("single-worker", {
    requestId: claimedA.request.request_id,
    claimToken: claimedA.request.claim_token,
    response: "answer A",
  }, 1);
  assert.equal(firstSubmit.state, "request");
  assert.equal(firstSubmit.request.request_id, jobB.requestId);
  const jobC = await store.enqueueRequest(request("C"));

  const retry = await store.exchange("single-worker", {
    requestId: claimedA.request.request_id,
    claimToken: claimedA.request.claim_token,
    response: "answer A",
  }, 1);
  assert.equal(retry.state, "request");
  assert.equal(retry.request.request_id, firstSubmit.request.request_id);
  assert.equal(retry.request.claim_token, firstSubmit.request.claim_token);
  assert.equal((await store.job(jobC.requestId)).status, "queued");
  await assert.rejects(
    store.exchange("single-worker", {
      requestId: claimedA.request.request_id,
      claimToken: claimedA.request.claim_token,
      response: "different answer",
    }, 1),
    /conflicts with the already accepted completion/i,
  );

  await store.release("test cleanup");
});

test("terminal duplicate conflicts remain rejected after replay metadata is unavailable", async (t) => {
  const { store } = await fixture(t);
  const job = await store.enqueueRequest(request("terminal conflict"));
  const claimed = await store.exchange("terminal-conflict-worker", undefined, 1);
  await store.exchange("terminal-conflict-worker", {
    requestId: job.requestId,
    claimToken: claimed.request.claim_token,
    response: "accepted",
  }, 1);

  const raw = JSON.parse(await fs.readFile(store.statePath, "utf8"));
  delete raw.exchangeReplays;
  await fs.writeFile(store.statePath, `${JSON.stringify(raw)}\n`);
  const dataDir = path.dirname(path.dirname(store.rootDir));
  const restarted = new LlmGatewayJobStore({ workspace: store.workspace, dataDir });
  await assert.rejects(
    restarted.exchange("terminal-conflict-worker", {
      requestId: job.requestId,
      claimToken: claimed.request.claim_token,
      response: "different",
    }, 1),
    /conflicts with the already accepted completion/i,
  );
});

test("replay records stay within count and UTF-8 byte bounds", async (t) => {
  const { store } = await fixture(t);
  const large = "r".repeat(240_000);
  for (let index = 0; index < 10; index++) {
    await store.enqueueRequest({
      model: "pilink",
      messages: Array.from({ length: 4 }, (_, messageIndex) => ({
        role: "user",
        content: `${index}:${messageIndex}:${large}`,
      })),
    });
  }
  let claimed = await store.exchange("replay-bound-worker", undefined, 1);
  for (let index = 0; index < 9; index++) {
    const next = await store.exchange("replay-bound-worker", {
      requestId: claimed.request.request_id,
      claimToken: claimed.request.claim_token,
      response: `done-${index}`,
    }, 1);
    assert.equal(next.state, "request");
    claimed = next;
  }
  const raw = JSON.parse(await fs.readFile(store.statePath, "utf8"));
  const replays = raw.exchangeReplays ?? [];
  assert.ok(replays.length <= 8);
  assert.ok(Buffer.byteLength(JSON.stringify(replays), "utf8") <= 4 * 1024 * 1024);
  await store.release("test cleanup");
});

test("a replayed delivery is reclaimed with a fresh token after its lease expires", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-gateway-replay-expiry-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private");
  await fs.mkdir(workspace);
  const store = new LlmGatewayJobStore({ workspace, dataDir, claimLeaseSeconds: 1 });
  await store.activate();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const jobA = await store.enqueueRequest(request("A"));
  const jobB = await store.enqueueRequest(request("B"));
  const claimedA = await store.exchange("expiry-replay-worker", undefined, 1);
  const firstSubmit = await store.exchange("expiry-replay-worker", {
    requestId: claimedA.request.request_id,
    claimToken: claimedA.request.claim_token,
    response: "answer A",
  }, 1);
  const oldToken = firstSubmit.request.claim_token;

  // Simulate a process boundary after B's lease expires. The new store reads
  // the durable state rather than sharing the first store's cache.
  const raw = JSON.parse(await fs.readFile(store.statePath, "utf8"));
  raw.jobs.find((job) => job.requestId === jobB.requestId).leaseExpiresAt = "2000-01-01T00:00:00.000Z";
  await fs.writeFile(store.statePath, `${JSON.stringify(raw)}\n`);
  const restarted = new LlmGatewayJobStore({ workspace, dataDir, claimLeaseSeconds: 1 });
  const retry = await restarted.exchange("expiry-replay-worker", {
    requestId: claimedA.request.request_id,
    claimToken: claimedA.request.claim_token,
    response: "answer A",
  }, 1);
  assert.equal(retry.state, "request");
  assert.equal(retry.request.request_id, jobB.requestId);
  assert.notEqual(retry.request.claim_token, oldToken);
  assert.equal((await restarted.job(jobB.requestId)).status, "claimed");
});

test("a replay never redelivers a delivery cancelled after the original reply", async (t) => {
  const { store } = await fixture(t);
  const jobA = await store.enqueueRequest(request("A"));
  const jobB = await store.enqueueRequest(request("B"));
  const claimedA = await store.exchange("cancel-replay-worker", undefined, 1);
  await store.exchange("cancel-replay-worker", {
    requestId: claimedA.request.request_id,
    claimToken: claimedA.request.claim_token,
    response: "answer A",
  }, 1);
  await store.cancelRequest(jobB.requestId, "caller stopped waiting");

  const jobC = await store.enqueueRequest(request("C"));
  const next = await store.exchange("cancel-replay-worker", undefined, 1);
  assert.equal(next.state, "request");
  assert.equal(next.request.request_id, jobC.requestId);

  // Even after the worker has a newer delivery, the retry must report the
  // terminal B outcome rather than staying worker_busy forever.
  const retry = await store.exchange("cancel-replay-worker", {
    requestId: jobA.requestId,
    claimToken: claimedA.request.claim_token,
    response: "answer A",
  }, 1);
  assert.equal(retry.state, "recovery");
  assert.equal(retry.code, "request_cancelled");
  assert.equal(retry.next_action, "poll");
  assert.equal(retry.request_id, jobB.requestId);
  await store.release("test cleanup");
});

test("restart preserves an accepted completion replay and repairs its next claim", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-gateway-restart-replay-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private");
  await fs.mkdir(workspace);
  const options = { workspace, dataDir };
  const store = new LlmGatewayJobStore(options);
  await store.activate();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const jobA = await store.enqueueRequest(request("A"));
  const jobB = await store.enqueueRequest(request("B"));
  const claimedA = await store.exchange("restart-worker", undefined, 1);
  const firstSubmit = await store.exchange("restart-worker", {
    requestId: claimedA.request.request_id,
    claimToken: claimedA.request.claim_token,
    response: "answer A",
  }, 1);

  const restarted = new LlmGatewayJobStore(options);
  await restarted.activate();
  const retry = await restarted.exchange("restart-worker", {
    requestId: jobA.requestId,
    claimToken: claimedA.request.claim_token,
    response: "answer A",
  }, 1);
  assert.equal(retry.state, "request");
  assert.equal(retry.request.request_id, jobB.requestId);
  assert.notEqual(retry.request.claim_token, firstSubmit.request.claim_token);
  await restarted.release("test cleanup");
});

test("concurrent polls and duplicate submits remain single-flight", async (t) => {
  const { store } = await fixture(t);
  const jobA = await store.enqueueRequest(request("A"));
  const jobB = await store.enqueueRequest(request("B"));
  const [first, second] = await Promise.all([
    store.exchange("concurrent-worker", undefined, 2),
    store.exchange("concurrent-worker", undefined, 2),
  ]);
  assert.equal(first.state, "request");
  assert.equal(second.state, "request");
  assert.equal(first.request.request_id, jobA.requestId);
  assert.equal(second.request.request_id, jobA.requestId);

  const [submitOne, submitTwo] = await Promise.all([
    store.exchange("concurrent-worker", {
      requestId: first.request.request_id,
      claimToken: first.request.claim_token,
      response: "A done",
    }, 1),
    store.exchange("concurrent-worker", {
      requestId: first.request.request_id,
      claimToken: first.request.claim_token,
      response: "A done",
    }, 1),
  ]);
  assert.equal(submitOne.state, "request");
  assert.equal(submitTwo.state, "request");
  assert.equal(submitOne.request.request_id, jobB.requestId);
  assert.equal(submitTwo.request.request_id, jobB.requestId);
  await store.release("test cleanup");
});

test("a completion for a non-current request returns structured worker_busy recovery", async (t) => {
  const { store } = await fixture(t);
  const jobA = await store.enqueueRequest(request("A"));
  const jobB = await store.enqueueRequest(request("B"));
  const claimedA = await store.exchange("busy-worker", undefined, 1);
  const result = await store.exchange("busy-worker", {
    requestId: jobB.requestId,
    claimToken: claimedA.request.claim_token,
    response: "wrong request",
  }, 1);
  assert.deepEqual(result, {
    state: "recovery",
    continue: true,
    code: "worker_busy",
    next_action: "bounded_wait",
    message: "A different gateway request is still outstanding for this worker; retry the exact current delivery after it is resolved.",
    request_id: jobA.requestId,
  });
  assert.equal((await store.job(jobA.requestId)).status, "claimed");
  assert.equal((await store.job(jobB.requestId)).status, "queued");
  await store.release("test cleanup");
});

test("durable completion wakes a result waiter without waiting for the polling timer", async (t) => {
  const { store } = await fixture(t);
  const poll = store.exchange("notification-worker", undefined, 2);
  const job = await store.enqueueRequest(request("notify"));
  const claimed = await poll;
  const resultWait = store.waitForResult(job.requestId, 5);
  const started = Date.now();
  const submit = store.exchange("notification-worker", {
    requestId: claimed.request.request_id,
    claimToken: claimed.request.claim_token,
    response: "done",
  }, 2);

  const completed = await eventuallyResult(resultWait);
  assert.equal(completed.status, "completed");
  assert.ok(Date.now() - started < 500, "completion notification should be immediate after commit");
  await store.release("test cleanup");
  await submit;
});

test("abort is honored when a waiter is registered at the same time as cancellation", async (t) => {
  const { store } = await fixture(t);
  const job = await store.enqueueRequest(request("abort"));
  const controller = new AbortController();
  const waiting = store.waitForResult(job.requestId, 5, controller.signal);
  controller.abort();
  await assert.rejects(waiting, /Gateway (?:request )?wait was cancelled/iu);
});

test("no-tools and explicit tool_choice=none requests reject every tool call", async (t) => {
  const { store } = await fixture(t);
  const noToolsPoll = store.exchange("contract-worker", undefined, 2);
  const noToolsJob = await store.enqueueRequest(request("no tools"));
  const noToolsClaim = await noToolsPoll;
  await assert.rejects(
    store.exchange("contract-worker", {
      requestId: noToolsJob.requestId,
      claimToken: noToolsClaim.request.claim_token,
      response: { content: null, tool_calls: [call()] },
    }, 1),
    /unavailable function/i,
  );
  await store.exchange("contract-worker", {
    requestId: noToolsJob.requestId,
    claimToken: noToolsClaim.request.claim_token,
    response: "done",
  }, 1);

  const nonePoll = store.exchange("contract-worker", undefined, 2);
  const noneJob = await store.enqueueRequest({
    ...request("none"),
    tools: [tool()],
    toolChoice: "none",
  });
  const noneClaim = await nonePoll;
  await assert.rejects(
    store.exchange("contract-worker", {
      requestId: noneJob.requestId,
      claimToken: noneClaim.request.claim_token,
      response: { content: null, tool_calls: [call()] },
    }, 1),
    /toolChoice=none/i,
  );
  await assert.rejects(
    store.enqueueRequest({ ...request("duplicate tools"), tools: [tool(), tool()] }),
    /Duplicate function tool/i,
  );
  await store.release("test cleanup");
});

test("empty tools and required or named choices are rejected before execution", async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(
    store.enqueueRequest({
      ...request("required without tools"),
      tools: [],
      toolChoice: "required",
    }),
    /toolChoice requires at least one function tool/i,
  );
  await assert.rejects(
    store.enqueueRequest({
      ...request("named tool missing"),
      tools: [tool()],
      toolChoice: { type: "function", function: { name: "missing" } },
    }),
    /unavailable function/i,
  );

  const wait = store.exchange("empty-tools-worker", undefined, 1);
  const job = await store.enqueueRequest({
    ...request("empty tools"),
    tools: [],
    toolChoice: "auto",
  });
  const claimed = await wait;
  await assert.rejects(
    store.exchange("empty-tools-worker", {
      requestId: job.requestId,
      claimToken: claimed.request.claim_token,
      response: { content: null, tool_calls: [call()] },
    }, 1),
    /unavailable function/i,
  );
  await store.release("test cleanup");
});

test("late cancelled and expired claims return typed recovery and the worker can poll on", async (t) => {
  const { store } = await fixture(t, { claimLeaseSeconds: 1 });
  const poll = store.exchange("recovery-worker", undefined, 2);
  const cancelled = await store.enqueueRequest(request("cancelled"));
  const cancelledClaim = await poll;
  await store.cancelRequest(cancelled.requestId, "caller stopped waiting");
  const cancelledRecovery = await store.exchange("recovery-worker", {
    requestId: cancelled.request_id ?? cancelledClaim.request.request_id,
    claimToken: cancelledClaim.request.claim_token,
    response: "late",
  }, 1);
  assert.deepEqual(cancelledRecovery, {
    state: "recovery",
    continue: true,
    code: "request_cancelled",
    next_action: "poll",
    message: "The caller cancelled this gateway request before the worker result arrived; discard the late result and poll for the next request.",
    request_id: cancelled.requestId,
  });

  const next = await store.enqueueRequest(request("next"));
  const nextClaim = await store.exchange("recovery-worker", undefined, 1);
  assert.equal(nextClaim.state, "request");
  assert.equal(nextClaim.request.request_id, next.requestId);

  let now = Date.now();
  const expiringStore = (await fixture(t, { claimLeaseSeconds: 1, now: () => new Date(now) })).store;
  const expiringPoll = expiringStore.exchange("expiry-worker", undefined, 2);
  const expiring = await expiringStore.enqueueRequest(request("expiry"));
  const expiringClaim = await expiringPoll;
  now += 2_000;
  const stale = await expiringStore.exchange("expiry-worker", {
    requestId: expiring.requestId,
    claimToken: expiringClaim.request.claim_token,
    response: "late",
  }, 1);
  assert.equal(stale.state, "recovery");
  assert.equal(stale.code, "stale_claim");
  assert.equal(stale.next_action, "resync");
  await store.release("test cleanup");
  await expiringStore.release("test cleanup");
});

test("idle heartbeats do not rewrite the durable state file", async (t) => {
  const { store } = await fixture(t);
  await store.exchange("idle-worker", undefined, 1);
  const before = await fs.stat(store.statePath);
  await store.exchange("idle-worker", undefined, 1);
  const after = await fs.stat(store.statePath);
  assert.equal(after.mtimeNs, before.mtimeNs);
});

test("a failed durable transition does not leak into the in-memory state", async (t) => {
  const { store } = await fixture(t);
  await fs.rm(store.statePath);
  await fs.mkdir(store.statePath);
  await assert.rejects(
    store.enqueueRequest(request("must not leak")),
    /EISDIR|directory/u,
  );
  assert.equal((await store.status()).queued, 0);

  await fs.rm(store.statePath, { recursive: true, force: true });
  const recovered = await store.enqueueRequest(request("durable again"));
  assert.equal(recovered.status, "queued");
});

test("a post-rename directory-sync failure reloads the committed state", async (t) => {
  const { store } = await fixture(t);
  const originalOpen = fs.open;
  let injected = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (!injected && args[0] === store.rootDir) {
      injected = true;
      handle.sync = async () => {
        throw new Error("injected directory sync failure");
      };
    }
    return handle;
  };
  t.after(() => {
    fs.open = originalOpen;
  });

  await assert.rejects(
    store.enqueueRequest(request("committed despite sync error")),
    /injected directory sync failure/u,
  );
  assert.equal((await store.status()).queued, 1);

  const restarted = new LlmGatewayJobStore({ workspace: store.workspace, dataDir: path.dirname(path.dirname(store.rootDir)) });
  assert.equal((await restarted.status()).queued, 1);
});

test("a wrong token for the current delivery is rejected, not acknowledged as recovery", async (t) => {
  const { store } = await fixture(t);
  const job = await store.enqueueRequest(request("token"));
  const claimed = await store.exchange("wrong-token-worker", undefined, 1);
  const otherJob = await store.enqueueRequest(request("other token"));
  const wrongToken = `claim_${"x".repeat(32)}`;
  await assert.rejects(
    store.exchange("wrong-token-worker", {
      requestId: otherJob.requestId,
      claimToken: wrongToken,
      response: "must not be accepted",
    }, 1),
    /claim token does not match the current worker delivery/i,
  );
  await assert.rejects(
    store.exchange("wrong-token-worker", {
      requestId: job.requestId,
      claimToken: wrongToken,
      response: "must not be accepted",
    }, 1),
    /claim token does not match the active request/i,
  );
  assert.equal((await store.job(job.requestId)).status, "claimed");
  await store.exchange("wrong-token-worker", {
    requestId: claimed.request.request_id,
    claimToken: claimed.request.claim_token,
    response: "accepted",
  }, 1);
  await store.release("test cleanup");
});

test("the lifecycle instruction prefix is self-contained and under 512 bytes", () => {
  const prefix = GATEWAY_WORKER_INSTRUCTIONS.split("\n\n", 1)[0];
  assert.ok(Buffer.byteLength(prefix, "utf8") <= 512);
  assert.match(prefix, /poll/iu);
  assert.match(prefix, /complete/iu);
  assert.match(prefix, /idle/iu);
  assert.match(prefix, /released/iu);
  assert.match(prefix, /next_action/iu);
});
