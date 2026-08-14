import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentCoordinationStore } from "../dist/agents/coordination.js";

const CONTROLLER = Object.freeze({
  actorId: "local-controller",
  actorName: "PiLink",
  authority: "controller",
});
const AGENT_ONE = Object.freeze({
  actorId: "runtime-adapter",
  actorName: "Implementer",
  authority: "agent",
  agentId: "agent_00000000-0000-4000-8000-000000000001",
});
const AGENT_TWO = Object.freeze({
  actorId: "runtime-adapter",
  actorName: "Reviewer",
  authority: "agent",
  agentId: "agent_00000000-0000-4000-8000-000000000002",
});

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-coordination-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private-data");
  await fs.mkdir(workspace);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let taskSequence = 0;
  let eventSequence = 0;
  const options = {
    workspace,
    dataDir,
    namespace: "default",
    taskIdFactory: () => `task-${++taskSequence}`,
    eventIdFactory: () => `event-${++eventSequence}`,
    ...overrides,
  };
  return { root, workspace, dataDir, options, store: new AgentCoordinationStore(options) };
}

test("namespaced chat is durable, cursor-safe, bounded, and private", async (t) => {
  const value = await fixture(t, { chatLimit: 2 });
  await value.store.agentChatPost({ ...AGENT_ONE, message: "first" });
  await value.store.agentChatPost({ ...AGENT_TWO, message: "second" });
  await value.store.agentChatPost({ ...CONTROLLER, message: "third" });

  const retained = await value.store.agentChatRead();
  assert.deepEqual(retained.messages.map((message) => message.message), ["second", "third"]);
  assert.equal(retained.oldestCursor, 2);
  assert.equal(retained.latestCursor, 3);
  assert.equal((await value.store.agentChatRead({ after: 0 })).gap, true);
  assert.deepEqual(
    (await value.store.agentChatRead({ after: 1, limit: 1 })).messages.map((message) => message.cursor),
    [2],
  );
  await assert.rejects(() => value.store.agentChatRead({ after: 4 }), /ahead of the latest/u);

  const reloaded = new AgentCoordinationStore(value.options);
  assert.deepEqual(
    (await reloaded.agentChatRead()).messages.map((message) => message.message),
    ["second", "third"],
  );
  const separate = new AgentCoordinationStore({ ...value.options, namespace: "release" });
  assert.equal((await separate.agentChatRead()).messages.length, 0);
  assert.notEqual(separate.statePath, value.store.statePath);

  const stateMode = (await fs.stat(value.store.statePath)).mode & 0o777;
  const directoryMode = (await fs.stat(path.dirname(value.store.statePath))).mode & 0o777;
  assert.equal(stateMode, 0o600);
  assert.equal(directoryMode, 0o700);

  const persisted = JSON.parse(await fs.readFile(value.store.statePath, "utf8"));
  assert.equal(persisted.audit.length, 3);
  assert.deepEqual(persisted.audit.map((event) => event.kind), [
    "agent_chat_post",
    "agent_chat_post",
    "agent_chat_post",
  ]);
  assert.equal(JSON.stringify(persisted.audit).includes("third"), false);
});

test("task assignment and updates bind agent authority to an exact agent ID", async (t) => {
  const value = await fixture(t);
  const created = await value.store.agentTaskCreate({
    ...CONTROLLER,
    title: "Implement API",
    details: "Keep OAuth unchanged",
  });
  assert.equal(created.status, "open");
  await assert.rejects(() => value.store.agentTaskAssign({
    ...AGENT_ONE,
    taskId: created.taskId,
    expectedRevision: created.revision,
    assignedAgentId: AGENT_ONE.agentId,
    assignedAgentName: AGENT_ONE.actorName,
  }), /Only the local controller/u);

  const assigned = await value.store.agentTaskAssign({
    ...CONTROLLER,
    taskId: created.taskId,
    expectedRevision: created.revision,
    assignedAgentId: AGENT_ONE.agentId,
    assignedAgentName: AGENT_ONE.actorName,
    assignedRole: { canonicalRoleId: "implementer", occupancyLabel: "dev1" },
  });
  assert.equal(assigned.status, "assigned");
  assert.equal(assigned.assignedAgentId, AGENT_ONE.agentId);
  assert.deepEqual(assigned.assignedRole, { canonicalRoleId: "implementer", occupancyLabel: "dev1" });

  await assert.rejects(() => value.store.agentTaskUpdate({
    ...AGENT_TWO,
    taskId: assigned.taskId,
    expectedRevision: assigned.revision,
    status: "working",
  }), /exact agent ID/u);
  await assert.rejects(() => value.store.agentTaskUpdate({
    ...AGENT_ONE,
    taskId: assigned.taskId,
    expectedRevision: assigned.revision - 1,
    status: "working",
  }), /Stale task revision/u);

  const working = await value.store.agentTaskUpdate({
    ...AGENT_ONE,
    taskId: assigned.taskId,
    expectedRevision: assigned.revision,
    status: "working",
    statusMessage: "Writing tests",
  });
  await assert.rejects(() => value.store.agentTaskUpdate({
    ...AGENT_ONE,
    taskId: working.taskId,
    expectedRevision: working.revision,
    status: "blocked",
  }), /statusMessage is required/u);
  const completed = await value.store.agentTaskUpdate({
    ...AGENT_ONE,
    taskId: working.taskId,
    expectedRevision: working.revision,
    status: "completed",
    statusMessage: "Verified",
    artifact: "commit deadbeef",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.artifact, "commit deadbeef");
  await assert.rejects(() => value.store.agentTaskUpdate({
    ...CONTROLLER,
    taskId: completed.taskId,
    expectedRevision: completed.revision,
    status: "cancelled",
  }), /already completed/u);

  const listed = await value.store.agentTaskList({ statuses: ["completed"], assignedAgentId: AGENT_ONE.agentId });
  assert.deepEqual(listed.map((task) => task.taskId), [created.taskId]);
  const audit = await value.store.auditRead();
  assert.deepEqual(audit.events.map((event) => event.kind), [
    "agent_task_create",
    "agent_task_assign",
    "agent_task_update",
    "agent_task_update",
  ]);
  const serializedAudit = JSON.stringify(audit.events);
  assert.equal(serializedAudit.includes("Keep OAuth unchanged"), false);
  assert.equal(serializedAudit.includes("commit deadbeef"), false);
  assert.equal(serializedAudit.includes("Writing tests"), false);
});

test("task limits prune only the oldest terminal task", async (t) => {
  const value = await fixture(t, { taskLimit: 2 });
  const first = await value.store.agentTaskCreate({ ...CONTROLLER, title: "first" });
  const firstAssigned = await value.store.agentTaskAssign({
    ...CONTROLLER,
    taskId: first.taskId,
    expectedRevision: first.revision,
    assignedAgentId: AGENT_ONE.agentId,
    assignedAgentName: AGENT_ONE.actorName,
  });
  await value.store.agentTaskUpdate({
    ...AGENT_ONE,
    taskId: first.taskId,
    expectedRevision: firstAssigned.revision,
    status: "completed",
  });
  await value.store.agentTaskCreate({ ...CONTROLLER, title: "second" });
  await value.store.agentTaskCreate({ ...CONTROLLER, title: "third" });
  assert.deepEqual((await value.store.agentTaskList()).map((task) => task.title).sort(), ["second", "third"]);

  const activeOnly = await fixture(t, { taskLimit: 1, namespace: "active" });
  await activeOnly.store.agentTaskCreate({ ...CONTROLLER, title: "active" });
  await assert.rejects(
    () => activeOnly.store.agentTaskCreate({ ...CONTROLLER, title: "overflow" }),
    /active tasks reached/u,
  );
});

test("concurrent store instances serialize mutations and reject malformed state", async (t) => {
  const value = await fixture(t);
  const second = new AgentCoordinationStore(value.options);
  await Promise.all([
    value.store.agentChatPost({ ...AGENT_ONE, message: "one" }),
    second.agentChatPost({ ...AGENT_TWO, message: "two" }),
    value.store.agentTaskCreate({ ...CONTROLLER, title: "task one" }),
    second.agentTaskCreate({ ...CONTROLLER, title: "task two" }),
  ]);
  assert.deepEqual((await value.store.agentChatRead()).messages.map((message) => message.cursor), [1, 2]);
  assert.equal((await second.agentTaskList()).length, 2);
  assert.deepEqual((await value.store.auditRead()).events.map((event) => event.sequence), [1, 2, 3, 4]);

  const persisted = JSON.parse(await fs.readFile(value.store.statePath, "utf8"));
  persisted.audit[0].namespace = "other";
  await fs.writeFile(value.store.statePath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
  await assert.rejects(() => value.store.auditRead(), /mismatched|Malformed/u);
});

test("coordination storage rejects unsafe locations and untrusted text", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-coordination-policy-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.throws(() => new AgentCoordinationStore({
    workspace,
    dataDir: path.join(workspace, "private"),
    namespace: "default",
  }), /outside the workspace/u);
  assert.throws(() => new AgentCoordinationStore({
    workspace,
    dataDir: path.join(root, "private"),
    namespace: "../escape",
  }), /namespace/u);

  const store = new AgentCoordinationStore({
    workspace,
    dataDir: path.join(root, "private"),
    namespace: "default",
  });
  await assert.rejects(() => store.agentChatPost({ ...AGENT_ONE, message: "unsafe\u202e" }), /bidirectional/u);
  await assert.rejects(() => store.agentTaskCreate({ ...CONTROLLER, title: "x".repeat(257) }), /256 UTF-8 bytes/u);
  await assert.rejects(() => store.agentTaskUpdate({
    ...AGENT_ONE,
    taskId: "missing",
    expectedRevision: 1,
    status: "completed",
    artifact: "x",
  }), /Unknown coordination task/u);
});
