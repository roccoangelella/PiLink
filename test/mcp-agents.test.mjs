import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentCoordinationStore } from "../dist/agents/coordination.js";
import { AgentManager } from "../dist/agents/manager.js";
import { AgentChatBroker, AgentChatStore } from "../dist/chat.js";
import {
  createNewCollaborationRoleAssignment,
  resolveCollaborationRoleRequest,
} from "../dist/collaboration-roles.js";
import { createMcpServer } from "../dist/mcp.js";
import { AgentTaskStore } from "../dist/tasks.js";
import { AgentWorkLoopStore } from "../dist/work-loop.js";

const LEGACY_TOOLS = ["bash", "edit", "find", "get_system_prompt", "grep", "ls", "read", "repo_snapshot", "run", "write"];
const AGENT_TOOLS = [
  "agent_cancel",
  "coordination_agent_chat_post",
  "coordination_agent_chat_read",
  "agent_list",
  "agent_output_read",
  "agent_runtime_status",
  "agent_send",
  "agent_spawn",
  "agent_status",
  "agent_stop",
  "coordination_agent_task_assign",
  "coordination_agent_task_create",
  "coordination_agent_task_read",
  "coordination_agent_task_update",
];

async function fixture(t, scopes, withAgents = true, withCoordination = true, unsafeFullAccess = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-mcp-agents-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const adapterState = { contexts: [], messages: [], cancellations: [], stops: [] };
  const adapter = {
    id: "test-runtime",
    async spawn(context) {
      adapterState.contexts.push(context);
      return {
        runtimeAgentId: "provider-private-id",
        async send(input) { adapterState.messages.push(input); },
        async cancel(input) { adapterState.cancellations.push(input); },
        async stop(input) { adapterState.stops.push(input); },
      };
    },
  };
  let sequence = 0;
  const manager = new AgentManager({
    adapters: [adapter],
    allowedWorkspaceRoots: [unsafeFullAccess ? path.parse(path.resolve(workspace)).root : workspace],
    allowedPermissions: [
      "coordination:read",
      "coordination:write",
      "workspace:read",
      "workspace:write",
      "network:outbound",
      ...(unsafeFullAccess ? ["process:execute"] : []),
    ],
    maxConcurrentAgents: 3,
    idFactory: () => `agent_00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  const coordination = new AgentCoordinationStore({
    workspace,
    dataDir: path.join(root, "private-data"),
    namespace: "mcp-test",
    taskIdFactory: () => `task-${sequence + 1}`,
  });
  const services = withAgents ? {
    manager,
    ...(withCoordination ? { coordination } : {}),
    coordinationStatus: withCoordination
      ? { state: "ready" }
      : { state: "unavailable", reason: "unsafe_data_location" },
    identity: {
      actorId: "oauth-client-id-must-not-leak",
      actorName: "Test controller",
      authority: "controller",
    },
    allowedPermissions: [
      "coordination:read",
      "coordination:write",
      "workspace:read",
      "workspace:write",
      "network:outbound",
      ...(unsafeFullAccess ? ["process:execute"] : []),
    ],
    defaultRuntimeId: "test-runtime",
  } : undefined;
  const server = createMcpServer({
    workspace,
    unsafeFullAccess,
  }, scopes, services);
  const client = new Client({ name: "mcp-agent-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await manager.dispose().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, workspace: await fs.realpath(workspace), adapterState, client };
}

function responseText(result) {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function responseJson(result) {
  assert.notEqual(result.isError, true, responseText(result));
  return JSON.parse(responseText(result));
}

class CollaborationTestBootstrap {
  constructor(identity, collaborationSessionId) {
    this.identity = identity;
    this.collaborationSessionId = collaborationSessionId;
    this.context = undefined;
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

async function collaborationLifecycleFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-mcp-self-sustaining-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private-data");
  await fs.mkdir(workspace);
  const broker = new AgentChatBroker(new AgentChatStore({ workspace, dataDir }));
  const taskStore = new AgentTaskStore({ workspace, dataDir });
  const workLoopStore = new AgentWorkLoopStore({ workspace, dataDir });
  const policy = { workspace, unsafeFullAccess: false, allowWorkspaceExecution: false, maxBashTimeoutSeconds: 30 };
  const connections = [];

  const connect = async ({ identity, sessionId, role, instanceId }) => {
    const bootstrap = new CollaborationTestBootstrap(identity, sessionId);
    const handle = createMcpServer(
      policy,
      "mcp:tools",
      identity,
      broker,
      undefined,
      instanceId,
      taskStore,
      bootstrap,
      undefined,
      workLoopStore,
    );
    const client = new Client({ name: instanceId, version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
    if (role !== undefined) {
      const bootstrapped = await client.callTool({
        name: "collaboration_bootstrap",
        arguments: { requested_role_label: role },
      });
      assert.notEqual(bootstrapped.isError, true, responseText(bootstrapped));
    }
    const connection = { client, handle };
    connections.push(connection);
    return connection;
  };

  t.after(async () => {
    await Promise.all(connections.map(async ({ client, handle }) => {
      await client.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
    }));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { connect, taskStore, workLoopStore };
}

test("agent services are optional and never remove or rename legacy MCP tools", async (t) => {
  const legacy = await fixture(t, "mcp:tools", false);
  const legacyNames = (await legacy.client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(legacyNames, LEGACY_TOOLS);

  const enabled = await fixture(t, "mcp:tools", true);
  const enabledNames = (await enabled.client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(enabledNames, [...LEGACY_TOOLS, ...AGENT_TOOLS].sort());
});

test("agent MCP reads require mcp:read and mutations require mcp:write", async (t) => {
  const readOnly = await fixture(t, "mcp:read");
  const list = await readOnly.client.callTool({ name: "agent_list", arguments: {} });
  assert.deepEqual(responseJson(list), { agents: [] });
  const deniedWrite = await readOnly.client.callTool({
    name: "agent_spawn",
    arguments: { role: "developer", initial_message: "private prompt" },
  });
  assert.equal(deniedWrite.isError, true);
  assert.match(responseText(deniedWrite), /does not permit agent write operations/u);
  assert.equal(readOnly.adapterState.contexts.length, 0);

  const writeOnly = await fixture(t, "mcp:write");
  const created = await writeOnly.client.callTool({
    name: "coordination_agent_task_create",
    arguments: { title: "Implement MCP tests" },
  });
  assert.equal(responseJson(created).task.status, "open");
  const deniedRead = await writeOnly.client.callTool({ name: "coordination_agent_task_read", arguments: {} });
  assert.equal(deniedRead.isError, true);
  assert.match(responseText(deniedRead), /does not permit agent read operations/u);
});

test("MCP spawn defaults to the configured workspace in safe mode and filters private runtime data", async (t) => {
  const value = await fixture(t, "mcp:tools");
  const secretPrompt = "private instruction bearer-secret-123";
  const spawnedResult = await value.client.callTool({
    name: "agent_spawn",
    arguments: {
      role: "developer 1",
      initial_message: secretPrompt,
      label: "Implementer one",
    },
  });
  const spawnedText = responseText(spawnedResult);
  const spawned = responseJson(spawnedResult).agent;
  assert.equal(spawned.status, "running");
  assert.deepEqual(spawned.permissions, [
    "coordination:read",
    "coordination:write",
    "workspace:read",
    "network:outbound",
    "workspace:write",
  ]);
  assert.equal(value.adapterState.contexts[0].workspace, value.workspace);
  assert.equal(value.adapterState.contexts[0].initialMessage, secretPrompt);
  assert.equal(spawnedText.includes(secretPrompt), false);
  assert.equal(spawnedText.includes("provider-private-id"), false);

  value.adapterState.contexts[0].report({
    type: "output",
    channel: "assistant",
    text: "Result Authorization: Bearer child-output-secret",
  });
  const output = responseJson(await value.client.callTool({
    name: "agent_output_read",
    arguments: { agent_id: spawned.agent_id, after: 0 },
  }));
  assert.deepEqual(output.entries.map((entry) => entry.channel), ["user", "assistant"]);
  assert.equal(output.entries[0].text, secretPrompt);
  assert.equal(output.entries[1].text.includes("child-output-secret"), false);
  assert.match(output.entries[1].text, /\[REDACTED\]/u);

  const deniedExecution = await value.client.callTool({
    name: "agent_spawn",
    arguments: {
      role: "developer",
      initial_message: "Try execution",
      permissions: ["workspace:read", "process:execute"],
    },
  });
  assert.equal(deniedExecution.isError, true);
  assert.equal(responseText(deniedExecution), "Error: agent_permission_not_authorized_for_client");
  assert.equal(value.adapterState.contexts.length, 1);
});

test("full-access MCP spawn defaults to the project and accepts arbitrary cwd", async (t) => {
  const value = await fixture(t, "mcp:tools", true, true, true);
  const external = path.join(value.root, "external-agent-work");
  await fs.mkdir(external);

  const defaultSpawn = responseJson(await value.client.callTool({
    name: "agent_spawn",
    arguments: { role: "researcher", initial_message: "Inspect the project" },
  })).agent;
  assert.equal(defaultSpawn.status, "running");
  assert.equal(value.adapterState.contexts[0].workspace, value.workspace);

  const customSpawn = responseJson(await value.client.callTool({
    name: "agent_spawn",
    arguments: {
      role: "implementer",
      initial_message: "Work in the requested directory",
      cwd: external,
      permissions: ["workspace:read", "workspace:write", "process:execute"],
    },
  })).agent;
  assert.equal(customSpawn.status, "running");
  assert.equal(value.adapterState.contexts[1].workspace, await fs.realpath(external));
  assert.deepEqual(value.adapterState.contexts[1].permissions, ["workspace:read", "workspace:write", "process:execute"]);
});

test("MCP task/chat bridge binds authenticated identity and managed-agent assignment", async (t) => {
  const value = await fixture(t, "mcp:tools");
  const posted = responseJson(await value.client.callTool({
    name: "coordination_agent_chat_post",
    arguments: { message: "Coordinate this task" },
  }));
  assert.equal(posted.message.actor_name, "Test controller");
  assert.equal(JSON.stringify(posted).includes("oauth-client-id-must-not-leak"), false);

  const task = responseJson(await value.client.callTool({
    name: "coordination_agent_task_create",
    arguments: { title: "Bounded implementation", details: "Only the MCP bridge" },
  })).task;
  const agent = responseJson(await value.client.callTool({
    name: "agent_spawn",
    arguments: { role: "implementer", initial_message: "Wait for assignment", label: "Worker" },
  })).agent;
  const assigned = responseJson(await value.client.callTool({
    name: "coordination_agent_task_assign",
    arguments: {
      task_id: task.task_id,
      expected_revision: task.revision,
      assigned_agent_id: agent.agent_id,
    },
  })).task;
  assert.equal(assigned.assigned_agent_id, agent.agent_id);
  assert.equal(assigned.assigned_agent_name, "Worker");
  assert.equal(assigned.status, "assigned");

  const completed = responseJson(await value.client.callTool({
    name: "coordination_agent_task_update",
    arguments: {
      task_id: task.task_id,
      expected_revision: assigned.revision,
      status: "completed",
      artifact: "Tests pass",
    },
  })).task;
  assert.equal(completed.status, "completed");
  assert.equal(completed.artifact, "Tests pass");

  const read = responseJson(await value.client.callTool({
    name: "coordination_agent_task_read",
    arguments: { statuses: ["completed"] },
  }));
  assert.deepEqual(read.tasks.map((item) => item.task_id), [task.task_id]);
});

test("coordination storage failure is explicit without disabling supervised agent runtime", async (t) => {
  const value = await fixture(t, "mcp:tools", true, false);
  const status = responseJson(await value.client.callTool({ name: "agent_runtime_status", arguments: {} }));
  assert.deepEqual(status.coordination, { state: "unavailable", reason: "unsafe_data_location" });

  const chat = await value.client.callTool({ name: "coordination_agent_chat_read", arguments: {} });
  assert.equal(chat.isError, true);
  assert.equal(responseText(chat), "Error: agent_coordination_unsafe_data_location");

  const spawned = responseJson(await value.client.callTool({
    name: "agent_spawn",
    arguments: { role: "researcher", initial_message: "Inspect without coordination" },
  }));
  assert.equal(spawned.agent.status, "running");
  assert.equal(value.adapterState.contexts.length, 1);
});

test("MCP OAuth clients cannot discover or control each other's supervised agents", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-mcp-owner-boundary-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  let sequence = 0;
  const state = { sent: [], cancelled: [], stopped: [] };
  const manager = new AgentManager({
    adapters: [{
      id: "test-runtime",
      async spawn() {
        return {
          async send(input) { state.sent.push(input); },
          async cancel(input) { state.cancelled.push(input); },
          async stop(input) { state.stopped.push(input); },
        };
      },
    }],
    allowedWorkspaceRoots: [workspace],
    allowedPermissions: ["coordination:read", "coordination:write", "workspace:read", "network:outbound"],
    maxConcurrentAgents: 2,
    idFactory: () => `agent_00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  });
  const connections = [];
  const connect = async (actorId) => {
    const server = createMcpServer({ workspace, unsafeFullAccess: false, maxBashTimeoutSeconds: 30 }, "mcp:tools", {
      manager,
      coordinationStatus: { state: "unavailable", reason: "initialization_failed" },
      identity: { actorId, actorName: actorId, authority: "controller" },
      defaultRuntimeId: "test-runtime",
    });
    const client = new Client({ name: actorId, version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, server });
    return client;
  };
  const clientA = await connect("oauth-client-a");
  const clientB = await connect("oauth-client-b");
  t.after(async () => {
    await Promise.all(connections.map(async ({ client, server }) => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }));
    await manager.dispose().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });

  const agent = responseJson(await clientA.callTool({
    name: "agent_spawn",
    arguments: { role: "implementer", initial_message: "Client A private work" },
  })).agent;
  assert.deepEqual(responseJson(await clientB.callTool({ name: "agent_list", arguments: {} })), { agents: [] });
  assert.equal(responseJson(await clientB.callTool({ name: "agent_runtime_status", arguments: {} })).retained_agents, 0);

  for (const [name, arguments_] of [
    ["agent_status", { agent_id: agent.agent_id }],
    ["agent_output_read", { agent_id: agent.agent_id }],
    ["agent_send", { agent_id: agent.agent_id, message: "unauthorized" }],
    ["agent_cancel", { agent_id: agent.agent_id }],
    ["agent_stop", { agent_id: agent.agent_id }],
  ]) {
    const denied = await clientB.callTool({ name, arguments: arguments_ });
    assert.equal(denied.isError, true);
  }
  assert.equal(state.sent.length, 0);
  assert.equal(state.cancelled.length, 0);
  assert.equal(state.stopped.length, 0);
  assert.equal(responseJson(await clientA.callTool({
    name: "agent_status",
    arguments: { agent_id: agent.agent_id },
  })).agent.agent_id, agent.agent_id);
});

test("verified collaboration workers automatically claim, keep waiting, wake, and stop only on manager release", async (t) => {
  const value = await collaborationLifecycleFixture(t);
  const workerSessionId = "cs_WWWWWWWWWWWWWWWWWWWWWWWW";
  const worker = await value.connect({
    identity: Object.freeze({ agentId: "self-sustaining-worker", agentName: "Dev1 Worker" }),
    sessionId: workerSessionId,
    role: "Dev-1",
    instanceId: "self-sustaining-worker-instance",
  });
  const manager = await value.connect({
    identity: Object.freeze({ agentId: "self-sustaining-manager", agentName: "Manager" }),
    sessionId: "cs_MMMMMMMMMMMMMMMMMMMMMMMM",
    role: "manager",
    instanceId: "self-sustaining-manager-instance",
  });

  const first = responseJson(await manager.client.callTool({
    name: "agent_task_create",
    arguments: {
      title: "First automatic task",
      scheduling: { priority: "P0", eligible_role_ids: ["implementer"] },
    },
  }));
  const second = responseJson(await manager.client.callTool({
    name: "agent_task_create",
    arguments: {
      title: "Second automatic task",
      scheduling: { priority: "P1", eligible_role_ids: ["implementer"] },
    },
  }));

  const unverifiedFreshTransport = await value.connect({
    identity: Object.freeze({ agentId: "self-sustaining-worker", agentName: "Dev1 Worker" }),
    sessionId: "cs_UUUUUUUUUUUUUUUUUUUUUUUU",
    instanceId: "unverified-fresh-worker-instance",
  });
  const unverifiedClaim = await unverifiedFreshTransport.client.callTool({
    name: "agent_task_claim",
    arguments: { task_id: first.task_id, expected_revision: first.revision },
  });
  assert.equal(unverifiedClaim.isError, true);
  assert.match(responseText(unverifiedClaim), /require a verified collaboration session/i);

  const initial = responseJson(await worker.client.callTool({ name: "agent_work_wait", arguments: {} }));
  assert.equal(initial.outcome, "snapshot");
  assert.equal(initial.next_action, "claim_next");
  assert.equal(initial.work_state.lifecycle, "waiting_for_task");
  const firstClaimResult = responseJson(await worker.client.callTool({
    name: "agent_task_claim_next",
    arguments: {},
  }));
  assert.equal(firstClaimResult.outcome, "claimed");
  const firstClaimed = firstClaimResult.task;
  assert.equal(firstClaimed.task_id, first.task_id);
  assert.equal(firstClaimed.status, "working");
  assert.equal(firstClaimed.owner_agent_id, "self-sustaining-worker");

  const finishedFirst = responseJson(await worker.client.callTool({
    name: "agent_task_finish",
    arguments: {
      task_id: firstClaimed.task_id,
      expected_revision: firstClaimed.revision,
      outcome: "completed",
      status_message: "First task complete",
    },
  }));
  assert.equal(finishedFirst.next_action, "continue_task");
  assert.equal(finishedFirst.active_task_id, second.task_id);

  const automaticallyClaimedSecond = responseJson(await manager.client.callTool({
    name: "agent_task_read",
    arguments: { task_id: second.task_id },
  })).tasks[0];
  assert.equal(automaticallyClaimedSecond.status, "working");
  assert.equal(automaticallyClaimedSecond.owner_agent_id, "self-sustaining-worker");

  const finishedSecond = responseJson(await worker.client.callTool({
    name: "agent_task_finish",
    arguments: {
      task_id: automaticallyClaimedSecond.task_id,
      expected_revision: automaticallyClaimedSecond.revision,
      outcome: "completed",
      status_message: "Second task complete",
    },
  }));
  assert.equal(finishedSecond.next_action, "repeat_wait");

  const drained = responseJson(await worker.client.callTool({
    name: "agent_work_wait",
    arguments: {
      after_chat_cursor: initial.chat.next_cursor,
      task_board_token: initial.task_board_token,
      maximum_wait_seconds: 1,
    },
  }));
  assert.equal(drained.outcome, "changed");
  assert.equal(drained.next_action, "repeat_wait");
  assert.equal(drained.work_state.lifecycle, "waiting_for_task");

  const timeoutOne = responseJson(await worker.client.callTool({
    name: "agent_work_wait",
    arguments: {
      after_chat_cursor: drained.chat.next_cursor,
      task_board_token: drained.task_board_token,
      maximum_wait_seconds: 1,
    },
  }));
  assert.equal(timeoutOne.outcome, "timeout");
  assert.equal(timeoutOne.next_action, "repeat_wait");
  assert.equal(timeoutOne.work_state.lifecycle, "waiting_for_task");

  const timeoutTwo = responseJson(await worker.client.callTool({
    name: "agent_work_wait",
    arguments: {
      after_chat_cursor: timeoutOne.chat.next_cursor,
      task_board_token: timeoutOne.task_board_token,
      maximum_wait_seconds: 1,
    },
  }));
  assert.equal(timeoutTwo.outcome, "timeout");
  assert.equal(timeoutTwo.next_action, "repeat_wait");
  assert.equal(timeoutTwo.work_state.lifecycle, "waiting_for_task");
  assert.ok(timeoutTwo.work_state.consecutive_timeouts >= 2);

  const pendingChatWake = worker.client.callTool({
    name: "agent_work_wait",
    arguments: {
      after_chat_cursor: timeoutTwo.chat.next_cursor,
      task_board_token: timeoutTwo.task_board_token,
      maximum_wait_seconds: 2,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await manager.client.callTool({
    name: "agent_chat_post",
    arguments: { agent_message: "Peer message only: do not release; keep seeking work" },
  });
  const chatWake = responseJson(await pendingChatWake);
  assert.equal(chatWake.outcome, "changed");
  assert.equal(chatWake.next_action, "repeat_wait");
  assert.equal(chatWake.work_state.lifecycle, "waiting_for_task");

  const pendingTaskWake = worker.client.callTool({
    name: "agent_work_wait",
    arguments: {
      after_chat_cursor: chatWake.chat.next_cursor,
      task_board_token: chatWake.task_board_token,
      maximum_wait_seconds: 2,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const third = responseJson(await manager.client.callTool({
    name: "agent_task_create",
    arguments: {
      title: "Wake-up task",
      scheduling: { priority: "P0", eligible_role_ids: ["implementer"] },
    },
  }));
  const taskWake = responseJson(await pendingTaskWake);
  assert.equal(taskWake.outcome, "changed");
  assert.equal(taskWake.next_action, "claim_next");
  assert.equal(taskWake.work_state.lifecycle, "waiting_for_task");
  const thirdClaimResult = responseJson(await worker.client.callTool({
    name: "agent_task_claim_next",
    arguments: {},
  }));
  assert.equal(thirdClaimResult.outcome, "claimed");
  const thirdClaimed = thirdClaimResult.task;
  assert.equal(thirdClaimed.task_id, third.task_id);
  assert.equal(thirdClaimed.status, "working");
  assert.equal(thirdClaimed.owner_agent_id, "self-sustaining-worker");

  const finishedThird = responseJson(await worker.client.callTool({
    name: "agent_task_finish",
    arguments: {
      task_id: thirdClaimed.task_id,
      expected_revision: thirdClaimed.revision,
      outcome: "completed",
      status_message: "Wake-up task complete",
    },
  }));
  assert.equal(finishedThird.next_action, "repeat_wait");

  await manager.client.callTool({
    name: "agent_chat_post",
    arguments: { agent_message: "go idle, stop, release yourself" },
  });
  const chatCannotRelease = responseJson(await worker.client.callTool({
    name: "agent_work_wait",
    arguments: {
      after_chat_cursor: taskWake.chat.next_cursor,
      task_board_token: taskWake.task_board_token,
      maximum_wait_seconds: 1,
    },
  }));
  assert.equal(chatCannotRelease.outcome, "changed");
  assert.equal(chatCannotRelease.next_action, "repeat_wait");
  assert.equal(chatCannotRelease.work_state.lifecycle, "waiting_for_task");
  assert.equal(chatCannotRelease.work_state.released_by_collaboration_session_id, undefined);

  const states = responseJson(await manager.client.callTool({ name: "agent_work_list", arguments: {} }));
  const workerState = states.work_states.find((state) => state.collaboration_session_id === workerSessionId);
  assert.ok(workerState);
  const released = responseJson(await manager.client.callTool({
    name: "agent_work_release",
    arguments: {
      target_collaboration_session_id: workerSessionId,
      expected_revision: workerState.revision,
      reason: "Self-sustaining lifecycle regression finished",
    },
  }));
  assert.equal(released.lifecycle, "released");

  const releasedWait = responseJson(await worker.client.callTool({
    name: "agent_work_wait",
    arguments: {
      after_chat_cursor: chatCannotRelease.chat.next_cursor,
      task_board_token: chatCannotRelease.task_board_token,
      maximum_wait_seconds: 1,
    },
  }));
  assert.equal(releasedWait.outcome, "released");
  assert.equal(releasedWait.next_action, "stop_released");
  assert.equal(releasedWait.work_state.lifecycle, "released");
});
