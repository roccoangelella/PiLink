import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentCoordinationStore } from "../dist/agents/coordination.js";
import { AgentManager } from "../dist/agents/manager.js";
import { createMcpServer } from "../dist/mcp.js";

const LEGACY_TOOLS = ["bash", "edit", "find", "get_system_prompt", "grep", "ls", "read", "run", "write"];
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

async function fixture(t, scopes, withAgents = true, withCoordination = true) {
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
    allowedWorkspaceRoots: [workspace],
    allowedPermissions: [
      "coordination:read",
      "coordination:write",
      "workspace:read",
      "workspace:write",
      "network:outbound",
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
    defaultRuntimeId: "test-runtime",
  } : undefined;
  const server = createMcpServer({
    workspace,
    unsafeFullAccess: false,
    maxBashTimeoutSeconds: 30,
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
  return { workspace: await fs.realpath(workspace), adapterState, client };
}

function responseText(result) {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function responseJson(result) {
  assert.notEqual(result.isError, true, responseText(result));
  return JSON.parse(responseText(result));
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

test("MCP spawn is workspace-fixed, defaults to bounded permissions, and filters private runtime data", async (t) => {
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
  assert.equal(responseText(deniedExecution), "Error: agent_spawn_failed");
  assert.equal(value.adapterState.contexts.length, 1);
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
