import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AgentTaskStore } from "../dist/tasks.js";

const alice = { agentId: "agent-alice", agentName: "Alice" };
const bob = { agentId: "agent-bob", agentName: "Bob" };
const carol = { agentId: "agent-carol", agentName: "Carol" };

const mutation = (task) => ({ taskId: task.taskId, expectedRevision: task.revision });
const taskWorkerPath = fileURLToPath(new URL("fixtures/task-store-worker.mjs", import.meta.url));

async function runTaskWorker({ workspace, dataDir, agentId, title, readyPath = "", gatePath = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      taskWorkerPath,
      workspace,
      dataDir,
      agentId,
      title,
      readyPath,
      gatePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`Task worker exited with code ${code} signal ${signal || "none"}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Task worker returned invalid JSON: ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
}

async function waitForFiles(paths, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const present = await Promise.all(paths.map(async (candidate) => {
      try {
        await fs.access(candidate);
        return true;
      } catch {
        return false;
      }
    }));
    if (present.every(Boolean)) return;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for task workers");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

  const claimed = await store.claim({ ...bob, ...mutation(created), leaseSeconds: 60 });
  assert.equal(claimed.status, "working");
  assert.equal(claimed.ownerAgentId, bob.agentId);
  assert.equal(claimed.leaseExpiresAt, "2026-08-01T10:01:00.000Z");

  value.advance(10);
  const waiting = await store.requestInput({
    ...bob,
    ...mutation(claimed),
    statusMessage: "Need lease-semantics review",
    leaseSeconds: 120,
  });
  assert.equal(waiting.status, "input_required");
  assert.equal(waiting.statusMessage, "Need lease-semantics review");

  value.advance(5);
  const completed = await store.complete({
    ...bob,
    ...mutation(waiting),
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

  const firstClaim = await store.claim({ ...alice, ...mutation(task), leaseSeconds: 30 });
  await assert.rejects(
    store.claim({ ...bob, ...mutation(firstClaim), leaseSeconds: 30 }),
    /already claimed by Alice/,
  );

  value.advance(31);
  const expired = await store.get(task.taskId);
  const reclaimed = await store.claim({ ...bob, ...mutation(expired), leaseSeconds: 45 });
  assert.equal(reclaimed.status, "working");
  assert.equal(reclaimed.ownerAgentId, bob.agentId);
  assert.equal(reclaimed.revision, 4);
  assert.equal(reclaimed.statusMessage, undefined);

  const persisted = JSON.parse(await fs.readFile(store.statePath, "utf8"));
  assert.equal(persisted.tasks[0].ownerAgentId, bob.agentId);
});

test("input-required survives lease expiry and resumes only after authorized input", async (t) => {
  const value = await fixture("pilink-tasks-input-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();
  const task = await store.create({ ...alice, title: "Resolve deployment choice" });
  const claimed = await store.claim({ ...bob, ...mutation(task), leaseSeconds: 30 });
  await store.requestInput({
    ...bob,
    ...mutation(claimed),
    statusMessage: "Which hosting mode should be used?",
    leaseSeconds: 30,
  });

  value.advance(31);
  const expired = await store.get(task.taskId);
  assert.equal(expired.status, "input_required");
  assert.equal(expired.statusMessage, "Which hosting mode should be used?");
  assert.equal(expired.ownerAgentId, undefined);
  assert.equal(expired.leaseExpiresAt, undefined);
  await assert.rejects(
    store.claim({ ...carol, ...mutation(expired) }),
    /requires input before it can be claimed/,
  );
  await assert.rejects(
    store.provideInput({ ...carol, ...mutation(expired), statusMessage: "Use a tunnel" }),
    /creator or current owner/,
  );

  const resumedOpen = await store.provideInput({
    ...alice,
    ...mutation(expired),
    statusMessage: "Use the quick tunnel",
  });
  assert.equal(resumedOpen.status, "open");
  assert.equal(resumedOpen.statusMessage, "Use the quick tunnel");
  assert.equal(resumedOpen.ownerAgentId, undefined);

  const reclaimed = await store.claim({ ...carol, ...mutation(resumedOpen), leaseSeconds: 45 });
  assert.equal(reclaimed.status, "working");
  assert.equal(reclaimed.ownerAgentId, carol.agentId);
});

test("active owners resume after input and release preserves blocked status", async (t) => {
  const value = await fixture("pilink-tasks-input-owner-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();
  const task = await store.create({ ...alice, title: "Review task semantics" });
  const claimed = await store.claim({ ...bob, ...mutation(task), leaseSeconds: 60 });
  const waiting = await store.requestInput({
    ...bob,
    ...mutation(claimed),
    statusMessage: "Need creator confirmation",
    leaseSeconds: 60,
  });
  await assert.rejects(
    store.claim({ ...bob, ...mutation(waiting), leaseSeconds: 60 }),
    /requires input before it can be claimed/,
  );

  const resumedWorking = await store.provideInput({
    ...alice,
    ...mutation(waiting),
    statusMessage: "Proceed with durable input state",
    leaseSeconds: 120,
  });
  assert.equal(resumedWorking.status, "working");
  assert.equal(resumedWorking.ownerAgentId, bob.agentId);
  assert.equal(resumedWorking.leaseExpiresAt, "2026-08-01T10:02:00.000Z");

  const waitingAgain = await store.requestInput({
    ...bob,
    ...mutation(resumedWorking),
    statusMessage: "Need one more decision",
    leaseSeconds: 60,
  });
  const released = await store.release({ ...bob, ...mutation(waitingAgain) });
  assert.equal(released.status, "input_required");
  assert.equal(released.statusMessage, "Need one more decision");
  assert.equal(released.ownerAgentId, undefined);
  assert.equal(released.leaseExpiresAt, undefined);
});

test("supports release, failure artifacts, and authorized cancellation", async (t) => {
  const value = await fixture("pilink-tasks-transitions-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();

  const cancellable = await store.create({ ...alice, title: "Replace tunnel" });
  const cancellableClaim = await store.claim({ ...bob, ...mutation(cancellable) });
  await assert.rejects(
    store.cancel({ ...carol, ...mutation(cancellableClaim) }),
    /creator or current owner/,
  );
  const cancelled = await store.cancel({ ...alice, ...mutation(cancellableClaim), statusMessage: "No longer needed" });
  assert.equal(cancelled.status, "cancelled");

  const releasable = await store.create({ ...alice, title: "Improve docs" });
  const releasableClaim = await store.claim({ ...bob, ...mutation(releasable) });
  const released = await store.release({ ...bob, ...mutation(releasableClaim), statusMessage: "Available for reassignment" });
  assert.equal(released.status, "open");
  assert.equal(released.ownerAgentId, undefined);

  const carolClaim = await store.claim({ ...carol, ...mutation(released) });
  const failed = await store.fail({
    ...carol,
    ...mutation(carolClaim),
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
    first.claim({ ...alice, ...mutation(task) }),
    second.claim({ ...bob, ...mutation(task) }),
  ]);
  assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(claims.filter((result) => result.status === "rejected").length, 1);
  const stored = await first.get(task.taskId);
  assert.ok([alice.agentId, bob.agentId].includes(stored.ownerAgentId));
});

test("observes task updates written by another PiLink process", async (t) => {
  const value = await fixture("pilink-tasks-process-refresh-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();
  assert.deepEqual(await store.list(), []);

  const created = await runTaskWorker({
    workspace: value.workspace,
    dataDir: value.dataDir,
    agentId: "external-agent",
    title: "Created in another process",
  });

  const visible = await store.get(created.taskId);
  assert.equal(visible.title, "Created in another process");
  assert.equal(visible.createdByAgentId, "external-agent");
});

test("serializes synchronized task creation across PiLink processes", async (t) => {
  const value = await fixture("pilink-tasks-process-lock-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const gatePath = path.join(value.root, "start-workers");
  const workerCount = 8;
  const readyPaths = Array.from({ length: workerCount }, (_, index) => path.join(value.root, `ready-${index}`));
  const workers = readyPaths.map((readyPath, index) => runTaskWorker({
    workspace: value.workspace,
    dataDir: value.dataDir,
    agentId: `process-${index}`,
    title: `Cross-process task ${index}`,
    readyPath,
    gatePath,
  }));

  await waitForFiles(readyPaths);
  await fs.writeFile(gatePath, "go\n", { mode: 0o600 });
  const created = await Promise.all(workers);
  assert.equal(new Set(created.map((task) => task.taskId)).size, workerCount);

  const persisted = await value.store().list({ limit: 200 });
  assert.equal(persisted.length, workerCount);
  assert.deepEqual(
    new Set(persisted.map((task) => task.title)),
    new Set(Array.from({ length: workerCount }, (_, index) => `Cross-process task ${index}`)),
  );
  await assert.rejects(fs.access(`${value.store().statePath}.lock`), /ENOENT/);
});

test("rejects stale mutations from parallel sessions sharing one agent identity", async (t) => {
  const value = await fixture("pilink-tasks-revision-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const first = value.store();
  const second = value.store();
  const created = await first.create({ ...alice, title: "Coordinate shared identity" });

  const claimed = await first.claim({ ...alice, ...mutation(created), leaseSeconds: 60 });
  await assert.rejects(
    second.claim({ ...alice, ...mutation(created), leaseSeconds: 120 }),
    /revision changed: expected 1, current 2/,
  );

  const waiting = await first.requestInput({
    ...alice,
    ...mutation(claimed),
    statusMessage: "Choose the final interface",
    leaseSeconds: 60,
  });
  await assert.rejects(
    second.release({ ...alice, ...mutation(claimed) }),
    /revision changed: expected 2, current 3/,
  );

  const resumed = await second.provideInput({
    ...alice,
    ...mutation(waiting),
    statusMessage: "Use the compact interface",
    leaseSeconds: 60,
  });
  await assert.rejects(
    first.complete({ ...alice, ...mutation(waiting), statusMessage: "stale completion" }),
    /revision changed: expected 3, current 4/,
  );

  const completed = await first.complete({
    ...alice,
    ...mutation(resumed),
    statusMessage: "Completed after refreshing",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.revision, 5);
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
