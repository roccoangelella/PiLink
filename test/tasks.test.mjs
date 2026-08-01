import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentTaskStore } from "../dist/tasks.js";

const alice = { agentId: "agent-alice", agentName: "Alice" };
const bob = { agentId: "agent-bob", agentName: "Bob" };
const carol = { agentId: "agent-carol", agentName: "Carol" };

async function fixture(prefix = "pilink-tasks-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other-workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  await fs.mkdir(otherWorkspace);
  let nowMs = Date.parse("2026-08-01T10:00:00.000Z");
  const now = () => new Date(nowMs);
  return {
    root,
    workspace,
    otherWorkspace,
    dataDir,
    now,
    advance(seconds) { nowMs += seconds * 1000; },
    store() { return new AgentTaskStore({ workspace, dataDir, now }); },
  };
}

test("persists a typed task lifecycle with private project-scoped state", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();

  const created = await store.create({ ...alice, title: "Add safe runner", details: "Implement fixed profiles" });
  assert.equal(created.status, "open");
  assert.equal(created.revision, 1);

  const claimed = await store.claim({ ...bob, taskId: created.taskId, leaseSeconds: 60 });
  assert.equal(claimed.status, "working");
  assert.equal(claimed.ownerAgentId, bob.agentId);
  assert.equal(claimed.leaseExpiresAt, "2026-08-01T10:01:00.000Z");

  value.advance(10);
  const waiting = await store.requestInput({
    ...bob,
    taskId: created.taskId,
    statusMessage: "Need lease-semantics review",
    leaseSeconds: 120,
  });
  assert.equal(waiting.status, "input_required");
  assert.equal(waiting.statusMessage, "Need lease-semantics review");

  value.advance(5);
  const completed = await store.complete({
    ...bob,
    taskId: created.taskId,
    statusMessage: "Reviewed and merged",
    artifact: "commit deadbeef",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.ownerAgentId, undefined);
  assert.equal(completed.leaseExpiresAt, undefined);
  assert.equal(completed.artifact, "commit deadbeef");

  const reloaded = new AgentTaskStore({ workspace: value.workspace, dataDir: value.dataDir, now: value.now });
  assert.deepEqual(await reloaded.get(created.taskId), completed);
  assert.deepEqual(await reloaded.list({ statuses: ["completed"] }), [completed]);

  const separate = new AgentTaskStore({ workspace: value.otherWorkspace, dataDir: value.dataDir, now: value.now });
  assert.deepEqual(await separate.list(), []);

  assert.equal((await fs.stat(store.statePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(store.statePath))).mode & 0o777, 0o700);
});

test("leases prevent duplicate work and expired claims can be reclaimed", async (t) => {
  const value = await fixture("pilink-tasks-lease-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();
  const task = await store.create({ ...alice, title: "Audit OAuth" });

  await store.claim({ ...alice, taskId: task.taskId, leaseSeconds: 30 });
  await assert.rejects(
    store.claim({ ...bob, taskId: task.taskId, leaseSeconds: 30 }),
    /already claimed by Alice/,
  );

  value.advance(31);
  const reclaimed = await store.claim({ ...bob, taskId: task.taskId, leaseSeconds: 45 });
  assert.equal(reclaimed.status, "working");
  assert.equal(reclaimed.ownerAgentId, bob.agentId);
  assert.equal(reclaimed.revision, 4);
  assert.equal(reclaimed.statusMessage, undefined);

  const persisted = JSON.parse(await fs.readFile(store.statePath, "utf8"));
  assert.equal(persisted.tasks[0].ownerAgentId, bob.agentId);
});

test("supports release, failure artifacts, and authorized cancellation", async (t) => {
  const value = await fixture("pilink-tasks-transitions-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();

  const cancellable = await store.create({ ...alice, title: "Replace tunnel" });
  await store.claim({ ...bob, taskId: cancellable.taskId });
  await assert.rejects(
    store.cancel({ ...carol, taskId: cancellable.taskId }),
    /creator or current owner/,
  );
  const cancelled = await store.cancel({ ...alice, taskId: cancellable.taskId, statusMessage: "No longer needed" });
  assert.equal(cancelled.status, "cancelled");

  const releasable = await store.create({ ...alice, title: "Improve docs" });
  await store.claim({ ...bob, taskId: releasable.taskId });
  const released = await store.release({ ...bob, taskId: releasable.taskId, statusMessage: "Available for reassignment" });
  assert.equal(released.status, "open");
  assert.equal(released.ownerAgentId, undefined);

  await store.claim({ ...carol, taskId: releasable.taskId });
  const failed = await store.fail({
    ...carol,
    taskId: releasable.taskId,
    statusMessage: "Blocked by upstream format",
    artifact: "investigation notes",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.artifact, "investigation notes");
});

test("serializes competing claims across store instances", async (t) => {
  const value = await fixture("pilink-tasks-concurrent-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const first = value.store();
  const second = value.store();
  const task = await first.create({ ...alice, title: "Claim once" });

  const claims = await Promise.allSettled([
    first.claim({ ...alice, taskId: task.taskId }),
    second.claim({ ...bob, taskId: task.taskId }),
  ]);
  assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(claims.filter((result) => result.status === "rejected").length, 1);
  const stored = await first.get(task.taskId);
  assert.ok([alice.agentId, bob.agentId].includes(stored.ownerAgentId));
});

test("bounds retained tasks by pruning the oldest terminal entry", async (t) => {
  const value = await fixture("pilink-tasks-retention-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();
  const timestamp = "2026-08-01T10:00:00.000Z";
  const tasks = Array.from({ length: 200 }, (_, index) => ({
    taskId: randomUUID(),
    title: `Completed task ${index}`,
    status: "completed",
    createdByAgentId: alice.agentId,
    createdByAgentName: alice.agentName,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
  }));
  await fs.mkdir(path.dirname(store.statePath), { recursive: true });
  await fs.writeFile(store.statePath, JSON.stringify({ version: 1, projectKey: store.projectKey, tasks }));

  const created = await store.create({ ...alice, title: "Newest task" });
  const persisted = JSON.parse(await fs.readFile(store.statePath, "utf8"));
  assert.equal(persisted.tasks.length, 200);
  assert.equal(persisted.tasks.some((task) => task.taskId === tasks[0].taskId), false);
  assert.equal(persisted.tasks.at(-1).taskId, created.taskId);
});

test("retries malformed state after repair and validates storage boundaries", async (t) => {
  const value = await fixture("pilink-tasks-recovery-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  assert.throws(
    () => new AgentTaskStore({ workspace: value.workspace, dataDir: path.join(value.workspace, "private") }),
    /must not be stored under the workspace/,
  );

  const store = value.store();
  await fs.mkdir(path.dirname(store.statePath), { recursive: true });
  await fs.writeFile(store.statePath, "not-json\n");
  await assert.rejects(store.list(), /invalid JSON/);

  await fs.writeFile(store.statePath, JSON.stringify({
    version: 1,
    projectKey: store.projectKey,
    tasks: [],
  }));
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.list({ statuses: [] }), /non-empty array/);
  await assert.rejects(store.list({ limit: 201 }), /between 1 and 200/);
});
