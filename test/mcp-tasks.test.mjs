import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentChatBroker, AgentChatStore } from "../dist/chat.js";
import { createMcpServer } from "../dist/mcp.js";
import { AgentTaskStore } from "../dist/tasks.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-mcp-tasks-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  return {
    root,
    workspace,
    dataDir,
    broker: new AgentChatBroker(new AgentChatStore({ workspace, dataDir })),
    tasks: new AgentTaskStore({ workspace, dataDir }),
    policy: { workspace, unsafeFullAccess: false, allowWorkspaceExecution: false, maxBashTimeoutSeconds: 30 },
  };
}

async function connected(value, scopes, identity, instanceId) {
  const handle = createMcpServer(
    value.policy,
    scopes,
    Object.freeze(identity),
    value.broker,
    undefined,
    instanceId,
    value.tasks,
  );
  const client = new Client({ name: `mcp-task-${instanceId}`, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
  return { client, handle };
}

async function close(connection) {
  connection.handle.dispose();
  await connection.client.close();
}

function structured(result) {
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  return result.structuredContent;
}

test("advertises a compact namespaced coordination-task surface", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const connection = await connected(
    value,
    "mcp:tools",
    { agentId: "schema-agent", agentName: "Schema Agent" },
    "schema-instance",
  );
  t.after(() => close(connection));

  const tools = (await connection.client.listTools()).tools;
  const taskTools = tools.filter((tool) => tool.name.startsWith("agent_task_"));
  assert.deepEqual(taskTools.map((tool) => tool.name).sort(), [
    "agent_task_claim",
    "agent_task_create",
    "agent_task_finish",
    "agent_task_provide_input",
    "agent_task_read",
    "agent_task_release",
    "agent_task_request_input",
  ]);
  assert.equal(tools.some((tool) => tool.name.startsWith("tasks/")), false);

  const read = taskTools.find((tool) => tool.name === "agent_task_read");
  assert.equal(read.annotations.readOnlyHint, true);
  assert.equal(read.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(read.inputSchema.properties).sort(), ["limit", "statuses", "task_id"]);
  assert.deepEqual(Object.keys(read.outputSchema.properties), ["tasks"]);

  for (const name of [
    "agent_task_create",
    "agent_task_claim",
    "agent_task_request_input",
    "agent_task_provide_input",
    "agent_task_release",
    "agent_task_finish",
  ]) {
    const tool = taskTools.find((candidate) => candidate.name === name);
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.outputSchema.additionalProperties, false);
    assert.ok(tool.outputSchema.required.includes("task_id"));
    if (name !== "agent_task_create") {
      assert.ok(tool.inputSchema.required.includes("expected_revision"));
      assert.ok(tool.inputSchema.properties.expected_revision.description.includes("stale"));
    }
  }
});

test("enforces task scopes and binds lifecycle mutations to OAuth identities", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const alice = await connected(
    value,
    "mcp:tools",
    { agentId: "agent-alice", agentName: "Alice" },
    "alice-instance",
  );
  const bob = await connected(
    value,
    "mcp:tools",
    { agentId: "agent-bob", agentName: "Bob" },
    "bob-instance",
  );
  const bobTwin = await connected(
    value,
    "mcp:tools",
    { agentId: "agent-bob", agentName: "Bob" },
    "bob-second-instance",
  );
  const reader = await connected(
    value,
    "mcp:read",
    { agentId: "agent-reader", agentName: "Reader" },
    "reader-instance",
  );
  const writerOnly = await connected(
    value,
    "mcp:write",
    { agentId: "agent-writer", agentName: "Writer" },
    "writer-instance",
  );
  t.after(async () => {
    await Promise.all([close(alice), close(bob), close(bobTwin), close(reader), close(writerOnly)]);
  });

  const deniedCreate = await reader.client.callTool({
    name: "agent_task_create",
    arguments: { title: "Should fail" },
  });
  assert.equal(deniedCreate.isError, true);
  const deniedRead = await writerOnly.client.callTool({ name: "agent_task_read", arguments: {} });
  assert.equal(deniedRead.isError, true);

  const createdResult = await alice.client.callTool({
    name: "agent_task_create",
    arguments: {
      title: "Expose durable task tools",
      details: "Use authenticated identities and leases",
    },
  });
  assert.notEqual(createdResult.isError, true);
  const created = structured(createdResult);
  assert.equal(created.status, "open");
  assert.equal(created.created_by_agent_id, "agent-alice");
  assert.equal(created.created_by_agent_name, "Alice");
  assert.equal(created.owner_agent_id, undefined);

  const listed = structured(await reader.client.callTool({
    name: "agent_task_read",
    arguments: { statuses: ["open"], limit: 10 },
  }));
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].task_id, created.task_id);

  const invalidRead = await reader.client.callTool({
    name: "agent_task_read",
    arguments: { task_id: created.task_id, limit: 1 },
  });
  assert.equal(invalidRead.isError, true);

  const claimed = structured(await bob.client.callTool({
    name: "agent_task_claim",
    arguments: { task_id: created.task_id, expected_revision: created.revision, lease_seconds: 120 },
  }));
  assert.equal(claimed.status, "working");
  assert.equal(claimed.owner_agent_id, "agent-bob");
  assert.equal(claimed.owner_agent_name, "Bob");

  const staleSameIdentity = await bobTwin.client.callTool({
    name: "agent_task_claim",
    arguments: { task_id: created.task_id, expected_revision: created.revision, lease_seconds: 120 },
  });
  assert.equal(staleSameIdentity.isError, true);
  assert.match(staleSameIdentity.content[0].text, /revision changed: expected 1, current 2/);

  const duplicateClaim = await alice.client.callTool({
    name: "agent_task_claim",
    arguments: { task_id: created.task_id, expected_revision: claimed.revision },
  });
  assert.equal(duplicateClaim.isError, true);

  const waiting = structured(await bob.client.callTool({
    name: "agent_task_request_input",
    arguments: {
      task_id: created.task_id,
      expected_revision: claimed.revision,
      status_message: "Should completion include the commit hash?",
      lease_seconds: 120,
    },
  }));
  assert.equal(waiting.status, "input_required");
  assert.equal(waiting.status_message, "Should completion include the commit hash?");

  const bypass = await bob.client.callTool({
    name: "agent_task_claim",
    arguments: { task_id: created.task_id, expected_revision: waiting.revision },
  });
  assert.equal(bypass.isError, true);

  const unauthorizedInput = await reader.client.callTool({
    name: "agent_task_provide_input",
    arguments: { task_id: created.task_id, expected_revision: waiting.revision, status_message: "No" },
  });
  assert.equal(unauthorizedInput.isError, true);

  const resumed = structured(await alice.client.callTool({
    name: "agent_task_provide_input",
    arguments: {
      task_id: created.task_id,
      expected_revision: waiting.revision,
      status_message: "Yes, include the commit hash",
      lease_seconds: 120,
    },
  }));
  assert.equal(resumed.status, "working");
  assert.equal(resumed.owner_agent_id, "agent-bob");
  assert.equal(resumed.status_message, "Yes, include the commit hash");

  const renewed = structured(await bob.client.callTool({
    name: "agent_task_claim",
    arguments: { task_id: created.task_id, expected_revision: resumed.revision, lease_seconds: 180 },
  }));
  assert.equal(renewed.status, "working");
  assert.equal(renewed.owner_agent_id, "agent-bob");
  assert.equal(renewed.status_message, "Yes, include the commit hash");

  const completed = structured(await bob.client.callTool({
    name: "agent_task_finish",
    arguments: {
      task_id: created.task_id,
      expected_revision: renewed.revision,
      outcome: "completed",
      status_message: "Implemented and tested",
      artifact: "commit 0123456",
    },
  }));
  assert.equal(completed.status, "completed");
  assert.equal(completed.artifact, "commit 0123456");
  assert.equal(completed.owner_agent_id, undefined);

  const completedAgain = await bob.client.callTool({
    name: "agent_task_finish",
    arguments: { task_id: created.task_id, expected_revision: completed.revision, outcome: "completed" },
  });
  assert.equal(completedAgain.isError, true);

  const exact = structured(await reader.client.callTool({
    name: "agent_task_read",
    arguments: { task_id: created.task_id },
  }));
  assert.deepEqual(exact.tasks, [completed]);
});

test("creator cancellation is terminal and rejects cancellation artifacts", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const alice = await connected(
    value,
    "mcp:tools",
    { agentId: "agent-alice", agentName: "Alice" },
    "alice-cancel-instance",
  );
  const bob = await connected(
    value,
    "mcp:tools",
    { agentId: "agent-bob", agentName: "Bob" },
    "bob-cancel-instance",
  );
  t.after(async () => Promise.all([close(alice), close(bob)]));

  const created = structured(await alice.client.callTool({
    name: "agent_task_create",
    arguments: { title: "Obsolete work" },
  }));
  const claimed = structured(await bob.client.callTool({
    name: "agent_task_claim",
    arguments: { task_id: created.task_id, expected_revision: created.revision },
  }));

  const invalid = await alice.client.callTool({
    name: "agent_task_finish",
    arguments: {
      task_id: created.task_id,
      expected_revision: claimed.revision,
      outcome: "cancelled",
      artifact: "must not be accepted",
    },
  });
  assert.equal(invalid.isError, true);

  const cancelled = structured(await alice.client.callTool({
    name: "agent_task_finish",
    arguments: {
      task_id: created.task_id,
      expected_revision: claimed.revision,
      outcome: "cancelled",
      status_message: "Requirement was withdrawn",
    },
  }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.status_message, "Requirement was withdrawn");
  assert.equal(cancelled.owner_agent_id, undefined);

  const staleOwnerFinish = await bob.client.callTool({
    name: "agent_task_finish",
    arguments: { task_id: created.task_id, expected_revision: cancelled.revision, outcome: "completed" },
  });
  assert.equal(staleOwnerFinish.isError, true);
});
