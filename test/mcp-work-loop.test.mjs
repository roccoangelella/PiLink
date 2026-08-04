import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AGENT_CHAT_URI, AgentChatBroker, AgentChatStore } from "../dist/chat.js";
import {
  createNewCollaborationRoleAssignment,
  resolveCollaborationRoleRequest,
} from "../dist/collaboration-roles.js";
import { createMcpServer } from "../dist/mcp.js";
import { AgentTaskStore } from "../dist/tasks.js";
import { AgentWorkLoopStore } from "../dist/work-loop.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-mcp-work-loop-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  return {
    root,
    workspace,
    policy: { workspace, unsafeFullAccess: false, allowWorkspaceExecution: false, maxBashTimeoutSeconds: 30 },
    broker: new AgentChatBroker(new AgentChatStore({ workspace, dataDir })),
    taskStore: new AgentTaskStore({ workspace, dataDir }),
    workLoopStore: new AgentWorkLoopStore({ workspace, dataDir }),
  };
}

class FakeBootstrap {
  constructor(identity, collaborationSessionId, { sharedLogicalSession = false } = {}) {
    this.identity = identity;
    this.collaborationSessionId = collaborationSessionId;
    this.context = undefined;
    this.sharedLogicalSession = sharedLogicalSession;
  }

  get initialized() {
    return this.context !== undefined;
  }

  async initialize(label) {
    const request = resolveCollaborationRoleRequest(label);
    if (request.kind === "none") throw new Error("role required");
    if (!this.context) {
      this.context = Object.freeze({
        ...this.identity,
        collaborationSessionId: this.collaborationSessionId,
        requestKind: request.kind,
        requestedRoleFingerprint: request.requestedRoleFingerprint,
        roleAssignment: createNewCollaborationRoleAssignment({
          assignmentSource: "server_session_policy",
          canonicalRoleId: request.canonicalRoleId,
          occupancyLabel: request.occupancyLabel,
        }),
      });
    }
    return this.context;
  }

  async verify() {
    if (!this.context) throw new Error("not initialized");
    return this.context;
  }

  async dispose() {}
}

async function connect(value, { identity, sessionId, role, instanceId, scopes = "mcp:tools", bootstrap }) {
  const selectedBootstrap = bootstrap || new FakeBootstrap(identity, sessionId);
  const handle = createMcpServer(
    value.policy,
    scopes,
    identity,
    value.broker,
    undefined,
    instanceId,
    value.taskStore,
    selectedBootstrap,
    undefined,
    value.workLoopStore,
  );
  const client = new Client({ name: instanceId, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
  if (role !== undefined) {
    const result = await client.callTool({
      name: "collaboration_bootstrap",
      arguments: { requested_role_label: role },
    });
    assert.notEqual(result.isError, true);
  }
  return { client, handle, bootstrap: selectedBootstrap };
}

function text(result) {
  return result.content.find((entry) => entry.type === "text")?.text;
}

function json(result) {
  return JSON.parse(text(result));
}

async function close(connection) {
  await connection.handle.dispose();
  await connection.client.close();
}

test("read-only OAuth scope cannot mutate the durable work lifecycle", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const readOnly = await connect(value, {
    identity: Object.freeze({ agentId: "read-only-actor", agentName: "Read Only" }),
    sessionId: "cs_RRRRRRRRRRRRRRRRRRRRRRRR",
    instanceId: "read-only-instance",
    scopes: "mcp:read",
  });
  t.after(() => close(readOnly));

  const denied = await readOnly.client.callTool({ name: "agent_work_wait", arguments: {} });
  assert.equal(denied.isError, true);
  assert.match(text(denied), /scope does not permit 'agent_work_wait'/i);
});

test("bounded wait wakes on task change and only a verified manager can permanently release", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));

  const workerIdentity = Object.freeze({ agentId: "worker-actor", agentName: "Worker" });
  const managerIdentity = Object.freeze({ agentId: "manager-actor", agentName: "Manager" });
  const workerSessionId = "cs_AAAAAAAAAAAAAAAAAAAAAAAA";
  const managerSessionId = "cs_BBBBBBBBBBBBBBBBBBBBBBBB";
  const worker = await connect(value, {
    identity: workerIdentity,
    sessionId: workerSessionId,
    role: "ai engineer",
    instanceId: "worker-instance",
  });
  const manager = await connect(value, {
    identity: managerIdentity,
    sessionId: managerSessionId,
    role: "manager",
    instanceId: "manager-instance",
  });
  t.after(async () => {
    await close(worker);
    await close(manager);
  });

  const initial = json(await worker.client.callTool({ name: "agent_work_wait", arguments: {} }));
  assert.equal(initial.outcome, "snapshot");
  assert.equal(initial.work_state.lifecycle, "working");
  assert.match(initial.task_board_token, /^wt_/);

  const pendingWait = worker.client.callTool({
    name: "agent_work_wait",
    arguments: {
      after_chat_cursor: initial.chat.next_cursor,
      task_board_token: initial.task_board_token,
      maximum_wait_seconds: 2,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const created = json(await manager.client.callTool({
    name: "agent_task_create",
    arguments: {
      title: "AI Engineer follow-up",
      details: "Implement the next bounded orchestration change",
    },
  }));

  const changed = json(await pendingWait);
  assert.equal(changed.outcome, "changed");
  assert.ok(changed.waited_seconds >= 0.5, "server-side wait should sleep instead of hot-polling from the model");
  assert.ok(changed.tasks.some((task) => task.task_id === created.task_id));

  const unauthorizedList = await worker.client.callTool({ name: "agent_work_list", arguments: {} });
  assert.equal(unauthorizedList.isError, true);
  assert.match(text(unauthorizedList), /verified manager/i);

  const claimed = json(await worker.client.callTool({
    name: "agent_task_claim",
    arguments: { task_id: created.task_id, expected_revision: created.revision, lease_seconds: 60 },
  }));
  const statesWithOwnedTask = json(await manager.client.callTool({
    name: "agent_work_list",
    arguments: { lifecycles: ["working", "waiting_for_task"] },
  }));
  const workerStateWithOwnedTask = statesWithOwnedTask.work_states.find(
    (state) => state.collaboration_session_id === workerSessionId,
  );
  assert.ok(workerStateWithOwnedTask);

  const blockedRelease = await manager.client.callTool({
    name: "agent_work_release",
    arguments: {
      target_collaboration_session_id: workerSessionId,
      expected_revision: workerStateWithOwnedTask.revision,
      reason: "Attempted while task is still owned",
    },
  });
  assert.equal(blockedRelease.isError, true);
  assert.match(text(blockedRelease), /still owns non-terminal tasks/i);

  const completed = await worker.client.callTool({
    name: "agent_task_finish",
    arguments: {
      task_id: claimed.task_id,
      expected_revision: claimed.revision,
      outcome: "completed",
      status_message: "Done for release test",
    },
  });
  assert.notEqual(completed.isError, true);

  const postCompletionChanged = json(await worker.client.callTool({
    name: "agent_work_wait",
    arguments: {
      after_chat_cursor: changed.chat.next_cursor,
      task_board_token: changed.task_board_token,
      maximum_wait_seconds: 1,
    },
  }));
  assert.equal(postCompletionChanged.outcome, "changed");
  const waiting = json(await worker.client.callTool({
    name: "agent_work_wait",
    arguments: {
      after_chat_cursor: postCompletionChanged.chat.next_cursor,
      task_board_token: postCompletionChanged.task_board_token,
      maximum_wait_seconds: 1,
    },
  }));
  assert.equal(waiting.outcome, "timeout");
  assert.equal(waiting.work_state.lifecycle, "waiting_for_task");

  const states = json(await manager.client.callTool({ name: "agent_work_list", arguments: {} }));
  const workerState = states.work_states.find((state) => state.collaboration_session_id === workerSessionId);
  assert.ok(workerState);
  const released = json(await manager.client.callTool({
    name: "agent_work_release",
    arguments: {
      target_collaboration_session_id: workerSessionId,
      expected_revision: workerState.revision,
      reason: "Milestone complete; AI Engineer is no longer needed",
    },
  }));
  assert.equal(released.lifecycle, "released");
  assert.equal(released.released_by_collaboration_session_id, managerSessionId);

  const blockedProjectTool = await worker.client.callTool({
    name: "agent_task_read",
    arguments: { statuses: ["open"] },
  });
  assert.equal(blockedProjectTool.isError, true);
  assert.match(text(blockedProjectTool), /permanently released by the manager/i);
  await assert.rejects(
    () => worker.client.readResource({ uri: AGENT_CHAT_URI }),
    /permanently released by the manager/i,
  );
  await assert.rejects(
    () => worker.client.subscribeResource({ uri: AGENT_CHAT_URI }),
    /permanently released by the manager/i,
  );

  const reattached = await connect(value, {
    identity: workerIdentity,
    sessionId: workerSessionId,
    instanceId: "worker-reattached-instance",
    bootstrap: worker.bootstrap,
  });
  t.after(() => close(reattached));
  const blockedOnFirstReattachedCall = await reattached.client.callTool({
    name: "agent_task_read",
    arguments: { statuses: ["open"] },
  });
  assert.equal(blockedOnFirstReattachedCall.isError, true);
  assert.match(text(blockedOnFirstReattachedCall), /permanently released by the manager/i);

  const releasedWait = json(await worker.client.callTool({
    name: "agent_work_wait",
    arguments: {
      after_chat_cursor: waiting.chat.next_cursor,
      task_board_token: waiting.task_board_token,
      maximum_wait_seconds: 1,
    },
  }));
  assert.equal(releasedWait.outcome, "released");
  assert.equal(releasedWait.work_state.lifecycle, "released");
});

test("disposing one shared logical handle does not mark another active handle offline", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const identity = Object.freeze({ agentId: "shared-worker", agentName: "Shared Worker" });
  const sessionId = "cs_SSSSSSSSSSSSSSSSSSSSSSSS";
  const bootstrap = new FakeBootstrap(identity, sessionId, { sharedLogicalSession: true });
  const first = await connect(value, {
    identity,
    sessionId,
    role: "AI Engineer",
    instanceId: "shared-worker-one",
    bootstrap,
  });
  const second = await connect(value, {
    identity,
    sessionId,
    instanceId: "shared-worker-two",
    bootstrap,
  });
  try {
    const initial = json(await first.client.callTool({ name: "agent_work_wait", arguments: {} }));
    assert.equal(initial.work_state.lifecycle, "working");
    const prompt = await second.client.callTool({ name: "get_system_prompt", arguments: {} });
    assert.notEqual(prompt.isError, true);

    await close(first);
    const afterOneClose = await value.workLoopStore.get(sessionId);
    assert.equal(afterOneClose.lifecycle, "working");
  } finally {
    await close(second);
  }
});

test("task claim and manager release are serialized by the durable work lifecycle", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const workerSessionId = "cs_CCCCCCCCCCCCCCCCCCCCCCCC";
  const worker = await connect(value, {
    identity: Object.freeze({ agentId: "race-worker", agentName: "Race Worker" }),
    sessionId: workerSessionId,
    role: "ai engineer",
    instanceId: "race-worker-instance",
  });
  const manager = await connect(value, {
    identity: Object.freeze({ agentId: "race-manager", agentName: "Race Manager" }),
    sessionId: "cs_DDDDDDDDDDDDDDDDDDDDDDDD",
    role: "manager",
    instanceId: "race-manager-instance",
  });
  t.after(async () => {
    await close(worker);
    await close(manager);
  });

  const initial = json(await worker.client.callTool({ name: "agent_work_wait", arguments: {} }));
  const created = json(await manager.client.callTool({
    name: "agent_task_create",
    arguments: { title: "Race task", details: "Exactly one of claim or permanent release may win" },
  }));
  const changed = json(await worker.client.callTool({
    name: "agent_work_wait",
    arguments: {
      after_chat_cursor: initial.chat.next_cursor,
      task_board_token: initial.task_board_token,
      maximum_wait_seconds: 1,
    },
  }));
  assert.equal(changed.outcome, "changed");
  const waiting = json(await worker.client.callTool({
    name: "agent_work_wait",
    arguments: {
      after_chat_cursor: changed.chat.next_cursor,
      task_board_token: changed.task_board_token,
      maximum_wait_seconds: 1,
    },
  }));
  assert.equal(waiting.work_state.lifecycle, "waiting_for_task");

  const [claimResult, releaseResult] = await Promise.all([
    worker.client.callTool({
      name: "agent_task_claim",
      arguments: { task_id: created.task_id, expected_revision: created.revision, lease_seconds: 60 },
    }),
    manager.client.callTool({
      name: "agent_work_release",
      arguments: {
        target_collaboration_session_id: workerSessionId,
        expected_revision: waiting.work_state.revision,
        reason: "Concurrent release race test",
      },
    }),
  ]);

  const claimSucceeded = claimResult.isError !== true;
  const releaseSucceeded = releaseResult.isError !== true;
  assert.notEqual(claimSucceeded, releaseSucceeded, "exactly one concurrent transition must win");

  const task = json(await manager.client.callTool({
    name: "agent_task_read",
    arguments: { task_id: created.task_id },
  })).tasks[0];
  const state = json(await manager.client.callTool({ name: "agent_work_list", arguments: {} }))
    .work_states.find((candidate) => candidate.collaboration_session_id === workerSessionId);
  assert.ok(state);
  if (claimSucceeded) {
    assert.equal(task.status, "working");
    assert.equal(state.lifecycle, "working");
    assert.match(text(releaseResult), /waiting_for_task or offline|still owns non-terminal tasks|stale work-state revision/i);
  } else {
    assert.equal(task.status, "open");
    assert.equal(state.lifecycle, "released");
    assert.match(text(claimResult), /permanently released by the manager/i);
  }
});
