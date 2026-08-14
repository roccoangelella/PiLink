import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentCoordinationStore } from "../dist/agents/coordination.js";
import { createPiCoordinationToolDefinitions } from "../dist/agents/pi-coordination-tools.js";

const CONTROLLER = Object.freeze({
  actorId: "controller-test",
  actorName: "Test controller",
  authority: "controller",
});
const AGENT_A = "agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "agent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROLE_A = Object.freeze({ canonicalRoleId: "implementer", occupancyLabel: "dev1" });
const ROLE_B = Object.freeze({ canonicalRoleId: "researcher", occupancyLabel: "researcher" });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-pi-coordination-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let taskSequence = 0;
  const store = new AgentCoordinationStore({
    workspace,
    dataDir: path.join(root, "private-data"),
    namespace: "child-tools",
    taskIdFactory: () => `task-${++taskSequence}`,
  });
  return { store };
}

function toolsFor(store, agentId, occupancyLabel, permissions) {
  return createPiCoordinationToolDefinitions({
    store,
    agentId,
    occupancyLabel,
    permissions: new Set(permissions),
  });
}

function named(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function call(tool, arguments_) {
  const result = await tool.execute("test-call", arguments_, new AbortController().signal, undefined, undefined);
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

async function assignedTask(store, agentId, role) {
  const created = await store.agentTaskCreate({
    ...CONTROLLER,
    title: `Task for ${role.occupancyLabel}`,
    details: "Bounded work only",
  });
  return store.agentTaskAssign({
    ...CONTROLLER,
    taskId: created.taskId,
    expectedRevision: created.revision,
    assignedAgentId: agentId,
    assignedAgentName: role.occupancyLabel,
    assignedRole: role,
  });
}

test("child coordination tools are exposed strictly by explicit permissions", async (t) => {
  const { store } = await fixture(t);
  assert.deepEqual(
    toolsFor(store, AGENT_A, ROLE_A.occupancyLabel, ["coordination:read"]).map((tool) => tool.name).sort(),
    ["coordination_chat_read", "coordination_task_list"],
  );
  assert.deepEqual(
    toolsFor(store, AGENT_A, ROLE_A.occupancyLabel, ["coordination:write"]).map((tool) => tool.name).sort(),
    ["coordination_chat_post", "coordination_task_update"],
  );
  assert.deepEqual(toolsFor(store, AGENT_A, ROLE_A.occupancyLabel, ["workspace:read"]), []);
});

test("child task tools are agent-bound and cannot inspect or update another agent's task", async (t) => {
  const { store } = await fixture(t);
  const ownTask = await assignedTask(store, AGENT_A, ROLE_A);
  const otherTask = await assignedTask(store, AGENT_B, ROLE_B);
  const tools = toolsFor(store, AGENT_A, ROLE_A.occupancyLabel, ["coordination:read", "coordination:write"]);

  const listed = await call(named(tools, "coordination_task_list"), { limit: 25, assigned_agent_id: AGENT_B });
  assert.deepEqual(listed.tasks.map((task) => task.task_id), [ownTask.taskId]);
  assert.equal(JSON.stringify(listed).includes(otherTask.taskId), false);

  await assert.rejects(
    () => call(named(tools, "coordination_task_update"), {
      task_id: otherTask.taskId,
      expected_revision: otherTask.revision,
      status: "working",
      agent_id: AGENT_B,
    }),
    /coordination_task_update_failed/u,
  );
  const updated = await call(named(tools, "coordination_task_update"), {
    task_id: ownTask.taskId,
    expected_revision: ownTask.revision,
    status: "working",
  });
  assert.equal(updated.task.status, "working");
  assert.equal(updated.task.assigned_agent_id, AGENT_A);
});

test("child chat identity is captured from runtime context and OAuth-style actor IDs are not exposed", async (t) => {
  const { store } = await fixture(t);
  const tools = toolsFor(store, AGENT_A, ROLE_A.occupancyLabel, ["coordination:read", "coordination:write"]);
  const posted = await call(named(tools, "coordination_chat_post"), {
    message: "Implementation is ready for review",
    actorId: "spoofed-controller",
    agentId: AGENT_B,
    actorName: "Manager",
  });
  assert.equal(posted.message.actor_name, ROLE_A.occupancyLabel);
  assert.equal(posted.message.agent_id, AGENT_A);
  assert.equal(JSON.stringify(posted).includes("spoofed-controller"), false);

  const stored = await store.agentChatRead();
  assert.equal(stored.messages[0].actorId, AGENT_A);
  assert.equal(stored.messages[0].agentId, AGENT_A);
  assert.equal(stored.messages[0].actorName, ROLE_A.occupancyLabel);
});
