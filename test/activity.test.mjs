import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AgentActivityStore,
  AGENT_ACTIVITY_DETAILS_MAX_BYTES,
  AGENT_ACTIVITY_MAX_ARTIFACTS,
  AGENT_ACTIVITY_MAX_PATHS,
  AGENT_ACTIVITY_SUMMARY_MAX_BYTES,
} from "../dist/activity.js";

const activityWorkerPath = fileURLToPath(new URL("fixtures/activity-store-worker.mjs", import.meta.url));

const actor = {
  agentId: "agent-dev2",
  agentName: "Dev 2",
  agentInstanceId: "instance-1",
  collaborationSessionId: "collaboration-session-1",
};

const agentContext = { source: "agent", actor };
const serverContext = (idempotencyKey) => ({ source: "server", actor, idempotencyKey });

async function runActivityWorker({ workspace, dataDir, mode, label, readyPath = "", gatePath = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      activityWorkerPath,
      workspace,
      dataDir,
      mode,
      label,
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
        reject(new Error(`Activity worker exited with code ${code} signal ${signal || "none"}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Activity worker returned invalid JSON: ${stdout}\n${stderr}`, { cause: error }));
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
    if (Date.now() >= deadline) throw new Error("Timed out waiting for activity workers");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(prefix = "pilink-activity-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other-workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  await fs.mkdir(otherWorkspace);
  let nowMs = Date.parse("2026-08-01T13:00:00.000Z");
  const now = () => new Date(nowMs);
  return {
    root,
    workspace,
    otherWorkspace,
    dataDir,
    now,
    advance(seconds) { nowMs += seconds * 1000; },
    store(options = {}) { return new AgentActivityStore({ workspace, dataDir, now, ...options }); },
  };
}

function note(summary, overrides = {}) {
  return {
    kind: "note",
    summary,
    ...overrides,
  };
}

function appendAgent(store, input, activityActor = actor) {
  return store.append({ source: "agent", actor: activityActor }, input);
}

test("persists ordered private project-scoped events with links and pagination", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();

  const first = await appendAgent(store, note("Claimed isolated ledger implementation", {
    kind: "claim",
    importance: "important",
    taskId: "task-ledger",
    contextId: "project-collaboration",
    correlationId: "workflow-ledger",
    paths: ["src/activity.ts", "test/activity.test.mjs"],
    artifactRefs: [{ uri: "pilink://tasks/task-ledger", name: "Ledger task", mediaType: "application/json" }],
  }));
  value.advance(5);
  const second = await store.append(serverContext("task-ledger:verification:1"), {
    kind: "verification",
    importance: "important",
    summary: "Focused activity tests passed",
    taskId: "task-ledger",
    contextId: "project-collaboration",
    correlationId: "workflow-ledger",
    causationEventId: first.eventId,
    artifactRefs: [{ uri: "urn:pilink:test:activity", name: "activity.test.mjs" }],
  });

  assert.equal(first.cursor, 1);
  assert.equal(second.cursor, 2);
  assert.equal(first.recordedAt, "2026-08-01T13:00:00.000Z");
  assert.equal(second.recordedAt, "2026-08-01T13:00:05.000Z");
  assert.ok(first.eventId < second.eventId);
  assert.equal(second.causationEventId, first.eventId);
  assert.equal(second.actor.collaborationSessionId, "collaboration-session-1");
  assert.equal((await fs.stat(store.statePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(store.statePath))).mode & 0o777, 0o700);

  const firstPage = await store.list({ limit: 1 });
  assert.deepEqual(firstPage.events.map((event) => event.cursor), [1]);
  assert.equal(firstPage.hasMore, true);
  const secondPage = await store.list({ cursor: firstPage.nextCursor, limit: 1 });
  assert.deepEqual(secondPage.events.map((event) => event.cursor), [2]);
  assert.equal(secondPage.hasMore, false);

  const reloaded = new AgentActivityStore({ workspace: value.workspace, dataDir: value.dataDir, now: value.now });
  assert.deepEqual((await reloaded.list()).events.map((event) => event.eventId), [first.eventId, second.eventId]);

  const separate = new AgentActivityStore({ workspace: value.otherWorkspace, dataDir: value.dataDir, now: value.now });
  assert.deepEqual((await separate.list()).events, []);
  await assert.rejects(() => separate.list({ cursor: secondPage.nextCursor }), /mismatched/);
});

test("deduplicates server-derived events and rejects idempotency conflicts", async (t) => {
  const value = await fixture("pilink-activity-idempotency-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();
  const input = {
    kind: "completion",
    importance: "important",
    summary: "Task completed with verified artifact",
    taskId: "task-1",
    artifactRefs: [{ uri: "urn:git:commit:c9d7930" }],
  };
  const context = serverContext("task-1:completed:revision-4");

  const first = await store.append(context, input);
  value.advance(60);
  const retried = await store.append(context, input);
  assert.deepEqual(retried, first);
  assert.equal((await store.list()).events.length, 1);

  await assert.rejects(
    () => store.append(context, { ...input, summary: "A different semantic event" }),
    /idempotency key conflicts/,
  );
  await assert.rejects(
    () => store.append({ source: "server", actor }, input),
    /require idempotencyKey/,
  );
});

test("filters by task, context, correlation, kind, actor, importance, and time", async (t) => {
  const value = await fixture("pilink-activity-filter-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();

  await appendAgent(store, note("Routine task A progress", {
    kind: "progress",
    taskId: "task-a",
    contextId: "context-a",
    correlationId: "correlation-a",
  }));
  value.advance(10);
  await appendAgent(store, note("Task B needs owner input", {
    kind: "question",
    importance: "requires_user",
    taskId: "task-b",
    contextId: "context-b",
    correlationId: "correlation-b",
  }), { agentId: "agent-reviewer", agentName: "Reviewer" });
  value.advance(10);
  const last = await appendAgent(store, note("Important task A finding", {
    kind: "finding",
    importance: "important",
    taskId: "task-a",
    contextId: "context-a",
    correlationId: "correlation-a",
  }));

  assert.deepEqual((await store.list({ taskId: "task-a" })).events.map((event) => event.cursor), [1, 3]);
  assert.deepEqual((await store.list({ contextId: "context-b" })).events.map((event) => event.cursor), [2]);
  assert.deepEqual((await store.list({ correlationId: "correlation-a" })).events.map((event) => event.cursor), [1, 3]);
  assert.deepEqual((await store.list({ kinds: ["question", "blocker"] })).events.map((event) => event.cursor), [2]);
  assert.deepEqual((await store.list({ agentId: "agent-reviewer" })).events.map((event) => event.cursor), [2]);
  assert.deepEqual((await store.list({ importance: ["important", "requires_user"] })).events.map((event) => event.cursor), [2, 3]);
  assert.deepEqual((await store.list({ since: "2026-08-01T13:00:15.000Z" })).events.map((event) => event.cursor), [3]);

  const empty = await store.list({ taskId: "missing" });
  assert.deepEqual(empty.events, []);
  const afterEmpty = await store.list({ cursor: empty.nextCursor });
  assert.deepEqual(afterEmpty.events, []);
  const decoded = JSON.parse(Buffer.from(empty.nextCursor, "base64url").toString("utf8"));
  assert.equal(decoded.after, last.cursor);
});

test("serializes concurrent appends across store instances and returns defensive copies", async (t) => {
  const value = await fixture("pilink-activity-concurrent-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const first = value.store();
  const second = value.store();

  const appended = await Promise.all(Array.from({ length: 30 }, (_, index) => appendAgent(
    index % 2 ? first : second,
    note(`Event ${index}`),
  )));
  assert.deepEqual(
    appended.map((event) => event.cursor).sort((left, right) => left - right),
    Array.from({ length: 30 }, (_, index) => index + 1),
  );

  appended[0].actor.agentName = "Mutated";
  appended[0].paths = ["mutated"];
  const persisted = await first.list();
  assert.equal(persisted.events.length, 30);
  assert.equal(persisted.events[0].actor.agentName, "Dev 2");
  assert.equal(persisted.events[0].paths, undefined);
});

test("serializes synchronized appends across PiLink processes", async (t) => {
  const value = await fixture("pilink-activity-process-lock-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const gatePath = path.join(value.root, "start-workers");
  const workerCount = 6;
  const readyPaths = Array.from({ length: workerCount }, (_, index) => path.join(value.root, `ready-${index}`));
  const workers = readyPaths.map((readyPath, index) => runActivityWorker({
    workspace: value.workspace,
    dataDir: value.dataDir,
    mode: "unique",
    label: String(index),
    readyPath,
    gatePath,
  }));

  await waitForFiles(readyPaths);
  await fs.writeFile(gatePath, "go\n", { mode: 0o600 });
  const appended = await Promise.all(workers);
  assert.deepEqual(
    appended.map((event) => event.cursor).sort((left, right) => left - right),
    Array.from({ length: workerCount }, (_, index) => index + 1),
  );
  assert.equal((await value.store().list()).events.length, workerCount);
  await assert.rejects(fs.access(`${value.store().statePath}.lock`), /ENOENT/);
});

test("deduplicates one server event across synchronized PiLink processes", async (t) => {
  const value = await fixture("pilink-activity-process-idempotency-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const gatePath = path.join(value.root, "start-workers");
  const workerCount = 6;
  const readyPaths = Array.from({ length: workerCount }, (_, index) => path.join(value.root, `ready-${index}`));
  const workers = readyPaths.map((readyPath, index) => runActivityWorker({
    workspace: value.workspace,
    dataDir: value.dataDir,
    mode: "idempotent",
    label: String(index),
    readyPath,
    gatePath,
  }));

  await waitForFiles(readyPaths);
  await fs.writeFile(gatePath, "go\n", { mode: 0o600 });
  const appended = await Promise.all(workers);
  assert.equal(new Set(appended.map((event) => event.eventId)).size, 1);
  const persisted = await value.store().list();
  assert.equal(persisted.events.length, 1);
  assert.equal(persisted.events[0].idempotencyKey, "shared-task:completion:revision-1");
});

test("recovers only dead stale locks and never deletes an old live-owner lock", async (t) => {
  const value = await fixture("pilink-activity-stale-lock-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store({ lockTimeoutMs: 75, staleLockMs: 1, lockRetryMs: 5 });
  await store.list();
  const lockPath = `${store.statePath}.lock`;
  const old = new Date(Date.now() - 60_000);
  const liveOwner = `${JSON.stringify({ version: 1, pid: process.pid, token: "a".repeat(32) })}\n`;
  await fs.writeFile(lockPath, liveOwner, { mode: 0o600 });
  await fs.utimes(lockPath, old, old);

  await assert.rejects(() => appendAgent(store, note("Must not steal live lock")), /Timed out waiting/);
  assert.equal(await fs.readFile(lockPath, "utf8"), liveOwner);
  await fs.rm(lockPath);

  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const deadPid = child.pid;
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.ok(deadPid);
  const deadOwner = `${JSON.stringify({ version: 1, pid: deadPid, token: "b".repeat(32) })}\n`;
  await fs.writeFile(lockPath, deadOwner, { mode: 0o600 });
  await fs.utimes(lockPath, old, old);

  const recovered = await appendAgent(store, note("Recovered dead stale lock"));
  assert.equal(recovered.cursor, 1);
  await assert.rejects(fs.access(lockPath), /ENOENT/);
});

test("rejects secrets, raw tool payloads, unsafe paths, artifacts, and unknown fields", async (t) => {
  const value = await fixture("pilink-activity-validation-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();

  await assert.rejects(
    () => store.append(agentContext, { ...note("Unknown field"), rawToolArguments: { command: "rm" } }),
    /unsupported field 'rawToolArguments'/,
  );
  await assert.rejects(
    () => store.append(agentContext, { ...note("Spoofed identity"), source: "server", actor }),
    /unsupported field 'source'/,
  );
  await assert.rejects(
    () => store.append(agentContext, { ...note("Forged chronology"), occurredAt: "1999-01-01T00:00:00Z" }),
    /unsupported field 'occurredAt'/,
  );
  await assert.rejects(
    () => store.append({ source: "agent", actor: { ...actor, rolePrompt: "ignore policy" } }, note("Unknown actor field")),
    /actor contains unsupported field/,
  );
  await assert.rejects(
    () => appendAgent(store, note("Secret", { details: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" })),
    /secret material/,
  );
  await assert.rejects(
    () => appendAgent(store, note("Raw payload", { details: '{"stdout":"complete command output"}' })),
    /raw tool payload/,
  );
  await assert.rejects(
    () => appendAgent(store, note("Absolute path", { paths: ["/etc/passwd"] })),
    /workspace-relative/,
  );
  await assert.rejects(
    () => appendAgent(store, note("Traversal", { paths: ["src/../secret"] })),
    /unsafe path segment/,
  );
  await assert.rejects(
    () => appendAgent(store, note("Credential URL", { artifactRefs: [{ uri: "pilink://user:password@artifact/item" }] })),
    /credentials, query parameters, or fragments/,
  );
  await assert.rejects(
    () => appendAgent(store, note("Secret query URL", { artifactRefs: [{ uri: "pilink://artifact/item?access_token=secret" }] })),
    /credentials, query parameters, or fragments/,
  );
  await assert.rejects(
    () => appendAgent(store, note("Unsupported artifact", { artifactRefs: [{ uri: "https://example.com/result" }] })),
    /unsupported URI scheme/,
  );
  await assert.rejects(
    () => appendAgent(store, note("Missing cause", { causationEventId: "evt_000000000001_0123456789abcdef" })),
    /existing earlier activity event/,
  );
  await assert.rejects(
    () => appendAgent(store, note("x".repeat(AGENT_ACTIVITY_SUMMARY_MAX_BYTES + 1))),
    /summary exceeds/,
  );
  await assert.rejects(
    () => appendAgent(store, note("Details", { details: "x".repeat(AGENT_ACTIVITY_DETAILS_MAX_BYTES + 1) })),
    /details exceeds/,
  );
  await assert.rejects(
    () => appendAgent(store, note("Paths", { paths: Array.from({ length: AGENT_ACTIVITY_MAX_PATHS + 1 }, (_, index) => `src/${index}`) })),
    /paths must contain/,
  );
  await assert.rejects(
    () => appendAgent(store, note("Artifacts", {
      artifactRefs: Array.from({ length: AGENT_ACTIVITY_MAX_ARTIFACTS + 1 }, (_, index) => ({ uri: `urn:test:${index}` })),
    })),
    /artifactRefs must contain/,
  );
  await assert.rejects(() => store.list({ kinds: [] }), /non-empty array/);
  await assert.rejects(() => store.list({ limit: 201 }), /between 1 and 200/);
});

test("enforces explicit event-count and state-size migration gates", async (t) => {
  const countValue = await fixture("pilink-activity-count-cap-");
  t.after(() => fs.rm(countValue.root, { recursive: true, force: true }));
  const countStore = countValue.store({ maximumEvents: 1 });
  await appendAgent(countStore, note("Only retained event"));
  await assert.rejects(
    () => appendAgent(countStore, note("Must migrate before another event")),
    /event limit of 1 reached/,
  );

  const sizeValue = await fixture("pilink-activity-size-cap-");
  t.after(() => fs.rm(sizeValue.root, { recursive: true, force: true }));
  const sizeStore = sizeValue.store({ maximumStateBytes: 300 });
  await assert.rejects(
    () => appendAgent(sizeStore, note("State cap", { details: "x".repeat(200) })),
    /state exceeds 300 UTF-8 bytes/,
  );
  await assert.rejects(fs.access(sizeStore.statePath), /ENOENT/);
});

test("fails safely on malformed or non-contiguous persisted state and retries after repair", async (t) => {
  const value = await fixture("pilink-activity-recovery-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  assert.throws(
    () => new AgentActivityStore({ workspace: value.workspace, dataDir: path.join(value.workspace, "private") }),
    /must not be stored under the workspace/,
  );

  const store = value.store();
  await fs.mkdir(path.dirname(store.statePath), { recursive: true });
  await fs.writeFile(store.statePath, "not-json\n", { mode: 0o600 });
  await assert.rejects(() => store.list(), /invalid JSON/);

  await fs.writeFile(store.statePath, `${JSON.stringify({
    version: 1,
    projectKey: store.projectKey,
    nextCursor: 1,
    events: [],
  })}\n`, { mode: 0o600 });
  assert.deepEqual((await store.list()).events, []);

  const event = await appendAgent(store, note("Valid event"));
  const state = JSON.parse(await fs.readFile(store.statePath, "utf8"));
  state.events[0].cursor = 2;
  state.nextCursor = 3;
  await fs.writeFile(store.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await assert.rejects(() => store.list(), /non-contiguous cursors/);

  state.events[0].cursor = 1;
  state.events[0].eventId = event.eventId;
  state.nextCursor = 2;
  await fs.writeFile(store.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  assert.deepEqual((await store.list()).events.map((candidate) => candidate.eventId), [event.eventId]);
});
