import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentManager } from "../dist/agents/manager.js";

const ROLE = Object.freeze({ canonicalRoleId: "implementer", occupancyLabel: "dev1" });
const PERMISSIONS = Object.freeze(["coordination:read", "workspace:read"]);

async function fixture(t, adapter = fakeAdapter()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-agent-manager-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let sequence = 0;
  const manager = new AgentManager({
    adapters: [adapter],
    allowedWorkspaceRoots: [workspace],
    allowedPermissions: [
      "coordination:read",
      "coordination:write",
      "workspace:read",
      "workspace:write",
    ],
    maxConcurrentAgents: 2,
    idFactory: () => `agent_00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  t.after(() => manager.dispose().catch(() => undefined));
  return { root, workspace, manager, adapter };
}

function fakeAdapter(overrides = {}) {
  const state = {
    contexts: [],
    sent: [],
    cancelled: [],
    stopped: [],
  };
  const adapter = {
    id: "test-runtime",
    state,
    async spawn(context) {
      state.contexts.push(context);
      if (overrides.spawn) return overrides.spawn(context, state);
      return {
        runtimeAgentId: `runtime-${state.contexts.length}`,
        async send(input) { state.sent.push(input); },
        async cancel(input) { state.cancelled.push(input); },
        async stop(input) { state.stopped.push(input); },
      };
    },
  };
  return adapter;
}

function request(workspace, overrides = {}) {
  return {
    controllerId: "test-controller",
    runtimeId: "test-runtime",
    role: ROLE,
    workspace,
    permissions: PERMISSIONS,
    initialMessage: "Implement the bounded task and report verification.",
    ...overrides,
  };
}

test("AgentManager requires an explicit adapter, workspace allowlist, and permissions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-agent-policy-"));
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  await fs.mkdir(allowed);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(allowed, "escape"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.throws(() => new AgentManager({
    adapters: [],
    allowedWorkspaceRoots: [allowed],
    allowedPermissions: ["workspace:read"],
    maxConcurrentAgents: 1,
  }), /explicit agent runtime adapter/u);

  const manager = new AgentManager({
    adapters: [fakeAdapter()],
    allowedWorkspaceRoots: [allowed],
    allowedPermissions: ["workspace:read"],
    maxConcurrentAgents: 1,
  });
  t.after(() => manager.dispose().catch(() => undefined));

  await assert.rejects(() => manager.spawn(request(allowed, { runtimeId: "shell" })), /Unknown agent runtime/u);
  await assert.rejects(() => manager.spawn(request(outside)), /outside the configured workspace/u);
  await assert.rejects(() => manager.spawn(request(path.join(allowed, "escape"))), /outside the configured workspace/u);
  await assert.rejects(
    () => manager.spawn(request(allowed, { permissions: ["workspace:read", "process:execute"] })),
    /not authorized/u,
  );
  await assert.rejects(() => manager.spawn(request(allowed, { permissions: [] })), /non-empty array/u);
});

test("spawn, list, status, send, cancel, and stop preserve explicit scope", async (t) => {
  const value = await fixture(t);
  const events = [];
  value.manager.subscribe((event) => events.push(event));

  const spawned = await value.manager.spawn(request(value.workspace, {
    taskId: "task-42",
    label: "API implementer",
    initialMessage: "secret task body",
  }));
  assert.equal(spawned.status, "running");
  assert.equal(spawned.runtimeAgentId, "runtime-1");
  assert.equal(spawned.workspace, await fs.realpath(value.workspace));
  assert.deepEqual(spawned.permissions, PERMISSIONS);
  assert.equal(spawned.taskId, "task-42");
  assert.equal(JSON.stringify(spawned).includes("secret task body"), false);
  assert.equal(value.adapter.state.contexts[0].initialMessage, "secret task body");
  assert.equal(value.manager.status(spawned.agentId).revision, spawned.revision);
  assert.deepEqual(value.manager.list().map((agent) => agent.agentId), [spawned.agentId]);
  assert.deepEqual(
    value.manager.outputRead(spawned.agentId).entries.map(({ channel, text }) => ({ channel, text })),
    [{ channel: "user", text: "secret task body" }],
  );

  const afterSend = await value.manager.send(spawned.agentId, "Continue with tests");
  assert.equal(afterSend.status, "running");
  assert.equal(value.adapter.state.sent[0].message, "Continue with tests");
  assert.deepEqual(
    value.manager.outputRead(spawned.agentId).entries.map(({ channel, text }) => ({ channel, text })),
    [
      { channel: "user", text: "secret task body" },
      { channel: "user", text: "Continue with tests" },
    ],
  );

  const afterCancel = await value.manager.cancel(spawned.agentId, "Change requested");
  assert.equal(afterCancel.status, "waiting");
  assert.equal(value.adapter.state.cancelled[0].reason, "Change requested");

  const afterStop = await value.manager.stop(spawned.agentId, "No longer needed");
  assert.equal(afterStop.status, "stopped");
  assert.equal(value.adapter.state.stopped[0].reason, "No longer needed");
  await assert.rejects(() => value.manager.send(spawned.agentId, "revive"), /is stopped/u);

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === "agent-added"));
  assert.ok(events.some((event) => event.type === "agent-updated" && event.agent.status === "stopped"));
});

test("cancel reaches a pending runtime turn without waiting behind send", async (t) => {
  let rejectTurn;
  let sendStartedResolve;
  let cancelReachedResolve;
  const sendStarted = new Promise((resolve) => { sendStartedResolve = resolve; });
  const cancelReached = new Promise((resolve) => { cancelReachedResolve = resolve; });
  const adapter = fakeAdapter({
    async spawn(_context, state) {
      return {
        async send(input) {
          state.sent.push(input);
          sendStartedResolve();
          await new Promise((_resolve, reject) => { rejectTurn = reject; });
        },
        async cancel(input) {
          state.cancelled.push(input);
          cancelReachedResolve();
          rejectTurn(new Error("turn aborted"));
        },
        async stop(input) { state.stopped.push(input); },
      };
    },
  });
  const value = await fixture(t, adapter);
  const spawned = await value.manager.spawn(request(value.workspace));
  const sending = value.manager.send(spawned.agentId, "Long running turn");
  const observedSend = sending.catch((error) => error);
  await sendStarted;

  const cancelling = value.manager.cancel(spawned.agentId, "User interrupted");
  let timeout;
  try {
    await Promise.race([
      cancelReached,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("cancel stayed queued behind send")), 1_000); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  const cancelled = await cancelling;
  const sendError = await observedSend;

  assert.match(sendError.message, /turn aborted/u);
  assert.equal(cancelled.status, "waiting");
  assert.equal(value.manager.status(spawned.agentId).status, "waiting");
  assert.equal(value.manager.status(spawned.agentId).lastError, undefined);
  assert.equal(value.adapter.state.cancelled[0].reason, "User interrupted");
  assert.deepEqual(
    value.manager.outputRead(spawned.agentId).entries.map(({ channel, text }) => ({ channel, text })),
    [
      { channel: "user", text: "Implement the bounded task and report verification." },
      { channel: "user", text: "Long running turn" },
    ],
  );
});

test("stop cancels and releases a pending runtime turn without waiting behind send", async (t) => {
  let rejectTurn;
  let sendStartedResolve;
  let cancelReachedResolve;
  let stopReachedResolve;
  const calls = [];
  const sendStarted = new Promise((resolve) => { sendStartedResolve = resolve; });
  const cancelReached = new Promise((resolve) => { cancelReachedResolve = resolve; });
  const stopReached = new Promise((resolve) => { stopReachedResolve = resolve; });
  const adapter = fakeAdapter({
    async spawn(_context, state) {
      return {
        async send(input) {
          state.sent.push(input);
          sendStartedResolve();
          await new Promise((_resolve, reject) => { rejectTurn = reject; });
        },
        async cancel(input) {
          calls.push("cancel");
          state.cancelled.push(input);
          cancelReachedResolve();
          rejectTurn(new Error("turn stopped"));
        },
        async stop(input) {
          calls.push("stop");
          state.stopped.push(input);
          stopReachedResolve();
        },
      };
    },
  });
  const value = await fixture(t, adapter);
  const spawned = await value.manager.spawn(request(value.workspace));
  const sending = value.manager.send(spawned.agentId, "Long running turn");
  const observedSend = sending.catch((error) => error);
  await sendStarted;

  const stopping = value.manager.stop(spawned.agentId, "User closed chat");
  let timeout;
  try {
    await Promise.race([
      stopReached,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("stop stayed queued behind send")), 1_000); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  await cancelReached;
  const stopped = await stopping;
  const sendError = await observedSend;

  assert.match(sendError.message, /turn stopped/u);
  assert.deepEqual(calls, ["cancel", "stop"]);
  assert.equal(value.adapter.state.cancelled[0].reason, "User closed chat");
  assert.equal(value.adapter.state.stopped[0].reason, "User closed chat");
  assert.equal(stopped.status, "stopped");
  assert.equal(value.manager.status(spawned.agentId).status, "stopped");
  assert.equal(value.manager.status(spawned.agentId).lastError, undefined);
});

test("remote controller views cannot discover or control another OAuth client's agents", async (t) => {
  const value = await fixture(t);
  const first = await value.manager.spawn(request(value.workspace, {
    controllerId: "oauth-client-a",
    label: "Client A worker",
  }));
  const second = await value.manager.spawn(request(value.workspace, {
    controllerId: "oauth-client-b",
    label: "Client B worker",
  }));

  assert.deepEqual(value.manager.listForController("oauth-client-a").map((agent) => agent.agentId), [first.agentId]);
  assert.deepEqual(value.manager.listForController("oauth-client-b").map((agent) => agent.agentId), [second.agentId]);
  assert.equal(JSON.stringify(value.manager.list()).includes("oauth-client-a"), false);

  assert.throws(() => value.manager.statusForController("oauth-client-b", first.agentId), /Unknown agent/u);
  assert.throws(() => value.manager.outputReadForController("oauth-client-b", first.agentId), /Unknown agent/u);
  assert.throws(() => value.manager.sendForController("oauth-client-b", first.agentId, "steal"), /Unknown agent/u);
  assert.throws(() => value.manager.cancelForController("oauth-client-b", first.agentId), /Unknown agent/u);
  assert.throws(() => value.manager.stopForController("oauth-client-b", first.agentId), /Unknown agent/u);

  assert.equal((await value.manager.sendForController("oauth-client-a", first.agentId, "continue")).agentId, first.agentId);
  assert.equal((await value.manager.stopForController("oauth-client-a", first.agentId)).status, "stopped");
});

test("parallel spawn reserves concurrency before a slow adapter returns", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = fakeAdapter({
    async spawn(_context, state) {
      await gate;
      return {
        async send(input) { state.sent.push(input); },
        async cancel(input) { state.cancelled.push(input); },
        async stop(input) { state.stopped.push(input); },
      };
    },
  });
  const value = await fixture(t, adapter);
  const manager = new AgentManager({
    adapters: [adapter],
    allowedWorkspaceRoots: [value.workspace],
    allowedPermissions: [...PERMISSIONS],
    maxConcurrentAgents: 1,
    idFactory: (() => {
      let n = 100;
      return () => `agent_00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    })(),
  });
  t.after(() => manager.dispose().catch(() => undefined));

  const first = manager.spawn(request(value.workspace));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => manager.spawn(request(value.workspace)), /concurrency limit/u);
  release();
  const started = await first;
  assert.equal(started.status, "running");
});

test("stop during startup aborts and disposes the late runtime handle", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = fakeAdapter({
    async spawn(context, state) {
      await gate;
      return {
        async send(input) { state.sent.push(input); },
        async cancel(input) { state.cancelled.push(input); },
        async stop(input) { state.stopped.push(input); },
      };
    },
  });
  const value = await fixture(t, adapter);
  let startingId;
  value.manager.subscribe((event) => {
    if (event.type === "agent-added") startingId = event.agent.agentId;
  });
  const spawning = value.manager.spawn(request(value.workspace));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(startingId);
  const stopping = value.manager.stop(startingId, "Setup cancelled");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.adapter.state.contexts[0].signal.aborted, true);
  release();
  assert.equal((await stopping).status, "stopped");
  assert.equal((await spawning).status, "stopped");
  assert.equal(value.adapter.state.stopped.length, 1);
});

test("adapter startup failure is visible and releases concurrency capacity", async (t) => {
  let fail = true;
  const adapter = fakeAdapter({
    async spawn(_context, state) {
      if (fail) throw new Error("provider unavailable\u202e Authorization: Bearer secret-token-123 api_key=raw-secret-value");
      return {
        async send(input) { state.sent.push(input); },
        async cancel(input) { state.cancelled.push(input); },
        async stop(input) { state.stopped.push(input); },
      };
    },
  });
  const value = await fixture(t, adapter);
  const failed = await value.manager.spawn(request(value.workspace));
  assert.equal(failed.status, "failed");
  assert.equal(failed.lastError.includes("\u202e"), false);
  assert.equal(failed.lastError.includes("secret-token-123"), false);
  assert.equal(failed.lastError.includes("raw-secret-value"), false);
  assert.match(failed.lastError, /\[REDACTED\]/u);

  fail = false;
  const next = await value.manager.spawn(request(value.workspace));
  assert.equal(next.status, "running");
});

test("runtime events update status and bound output without exposing handles", async (t) => {
  const value = await fixture(t);
  const output = [];
  value.manager.subscribe((event) => {
    if (event.type === "agent-output") output.push(event);
  });
  const spawned = await value.manager.spawn(request(value.workspace));
  const context = value.adapter.state.contexts[0];

  context.report({ type: "status", status: "waiting" });
  assert.equal(value.manager.status(spawned.agentId).status, "waiting");
  context.report({ type: "output", channel: "assistant", text: "done" });
  context.report({ type: "completed", summary: "verified" });
  assert.equal(value.manager.status(spawned.agentId).status, "completed");
  context.report({ type: "status", status: "running" });
  assert.equal(value.manager.status(spawned.agentId).status, "completed");

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    output.map(({ channel, text }) => ({ channel, text })),
    [
      { channel: "user", text: "Implement the bounded task and report verification." },
      { channel: "assistant", text: "done" },
    ],
  );
  assert.equal(value.adapter.state.stopped.length, 1);
  assert.match(value.adapter.state.stopped[0].reason, /Completed agent runtime cleanup/u);
  assert.equal(value.manager.status(spawned.agentId).status, "completed");
  assert.equal("handle" in value.manager.status(spawned.agentId), false);
});

test("failed runtime events preserve failure status while releasing the provider handle", async (t) => {
  const value = await fixture(t);
  const spawned = await value.manager.spawn(request(value.workspace));
  value.adapter.state.contexts[0].report({ type: "failed", error: "provider turn failed" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(value.manager.status(spawned.agentId).status, "failed");
  assert.equal(value.adapter.state.stopped.length, 1);
  assert.match(value.adapter.state.stopped[0].reason, /Failed agent runtime cleanup/u);
  await value.manager.dispose();
  assert.equal(value.adapter.state.stopped.length, 1);
});

test("agent output buffers are bounded, cursor-safe, redacted, and isolated per agent", async (t) => {
  const value = await fixture(t);
  let sequence = 200;
  const manager = new AgentManager({
    adapters: [value.adapter],
    allowedWorkspaceRoots: [value.workspace],
    allowedPermissions: [...PERMISSIONS],
    maxConcurrentAgents: 2,
    maxOutputBytes: 40,
    maxRetainedOutputEntries: 2,
    maxRetainedOutputBytes: 128,
    idFactory: () => `agent_00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  t.after(() => manager.dispose().catch(() => undefined));
  const first = await manager.spawn(request(value.workspace, { initialMessage: "private prompt one" }));
  const second = await manager.spawn(request(value.workspace, { initialMessage: "private prompt two" }));
  const firstContext = value.adapter.state.contexts.at(-2);
  const secondContext = value.adapter.state.contexts.at(-1);

  firstContext.report({ type: "output", channel: "status", text: "first entry" });
  firstContext.report({
    type: "output",
    channel: "stderr",
    text: "Authorization: Bearer output-secret-token",
  });
  firstContext.report({ type: "output", channel: "assistant", text: "x".repeat(200) });
  secondContext.report({ type: "output", channel: "assistant", text: "second agent only" });

  const firstOutput = manager.outputRead(first.agentId, { after: 0, limit: 10 });
  assert.equal(firstOutput.gap, true);
  assert.deepEqual(firstOutput.entries.map((entry) => entry.cursor), [3, 4]);
  assert.equal(JSON.stringify(firstOutput).includes("output-secret-token"), false);
  assert.ok(firstOutput.entries.every((entry) => Buffer.byteLength(entry.text, "utf8") <= 40));
  assert.ok(firstOutput.entries.reduce((total, entry) => total + Buffer.byteLength(entry.text, "utf8"), 0) <= 128);

  const secondOutput = manager.outputRead(second.agentId);
  assert.deepEqual(
    secondOutput.entries.map(({ channel, text }) => ({ channel, text })),
    [
      { channel: "user", text: "private prompt two" },
      { channel: "assistant", text: "second agent only" },
    ],
  );
  assert.equal(JSON.stringify(secondOutput).includes("xxxxxxxx"), false);
});

test("a failed stop remains active, blocks over-capacity spawn, and can be retried", async (t) => {
  let stopAttempts = 0;
  const adapter = fakeAdapter({
    async spawn(_context, state) {
      return {
        async send(input) { state.sent.push(input); },
        async cancel(input) { state.cancelled.push(input); },
        async stop(input) {
          state.stopped.push(input);
          stopAttempts += 1;
          if (stopAttempts === 1) throw new Error("process still alive");
        },
      };
    },
  });
  const value = await fixture(t, adapter);
  const manager = new AgentManager({
    adapters: [adapter],
    allowedWorkspaceRoots: [value.workspace],
    allowedPermissions: [...PERMISSIONS],
    maxConcurrentAgents: 1,
  });
  t.after(() => manager.dispose().catch(() => undefined));

  const spawned = await manager.spawn(request(value.workspace));
  await assert.rejects(() => manager.stop(spawned.agentId), /process still alive/u);
  assert.equal(manager.status(spawned.agentId).status, "stop_failed");
  await assert.rejects(() => manager.spawn(request(value.workspace)), /concurrency limit/u);
  assert.equal((await manager.stop(spawned.agentId)).status, "stopped");
  assert.equal((await manager.spawn(request(value.workspace))).status, "running");
});
