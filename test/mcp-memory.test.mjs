import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentChatBroker, AgentChatStore } from "../dist/chat.js";
import {
  createNewCollaborationRoleAssignment,
  resolveCollaborationRoleRequest,
} from "../dist/collaboration-roles.js";
import { AgentMemoryStore } from "../dist/memory.js";
import { createMcpServer } from "../dist/mcp.js";
import { AgentTaskStore } from "../dist/tasks.js";

const identity = Object.freeze({ agentId: "memory-oauth-actor", agentName: "Memory OAuth Actor" });
const sessionA = "cs_AAAAAAAAAAAAAAAAAAAAAAAA";
const sessionB = "cs_BBBBBBBBBBBBBBBBBBBBBBBB";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-mcp-memory-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  return {
    root,
    workspace,
    dataDir,
    policy: { workspace, unsafeFullAccess: false, maxBashTimeoutSeconds: 30 },
    broker: new AgentChatBroker(new AgentChatStore({ workspace, dataDir })),
    taskStore: new AgentTaskStore({ workspace, dataDir }),
    memoryStore: new AgentMemoryStore({
      workspace,
      dataDir,
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    }),
  };
}

class FakeBootstrap {
  constructor(collaborationSessionId = sessionA) {
    this.collaborationSessionId = collaborationSessionId;
    this.context = undefined;
    this.disposed = false;
  }

  get initialized() {
    return this.context !== undefined;
  }

  async initialize(label) {
    if (this.disposed) throw new Error("disposed");
    const request = resolveCollaborationRoleRequest(label);
    if (request.kind === "none") throw new Error("role required");
    if (!this.context) {
      this.context = Object.freeze({
        ...identity,
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

  async dispose() {
    this.disposed = true;
  }
}

async function connect(value, {
  scopes = "mcp:read",
  bootstrap,
  instanceId = "memory-mcp-instance",
  memoryStore = value.memoryStore,
} = {}) {
  const handle = createMcpServer(
    value.policy,
    scopes,
    identity,
    value.broker,
    undefined,
    instanceId,
    value.taskStore,
    bootstrap,
    memoryStore,
  );
  const client = new Client({ name: instanceId, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
  return { client, handle };
}

async function close(connection) {
  await connection.handle.dispose();
  await connection.client.close();
}

function text(result) {
  return result.content.find((entry) => entry.type === "text")?.text;
}

function json(result) {
  return JSON.parse(text(result));
}

function evidence(ref) {
  return [{ type: "artifact", ref, hash: createHash("sha256").update(ref).digest("hex") }];
}

function memoryInput(title, statement, scope) {
  return {
    namespace: "semantic",
    kind: "verified_fact",
    title,
    statement,
    subjectKeys: [title.toLowerCase().replaceAll(" ", "-")],
    epistemicStatus: "server_derived",
    scope: { ...scope, confidentiality: scope.confidentiality || "normal" },
    evidenceRefs: evidence(title),
  };
}

async function derive(store, idempotencyKey, input) {
  return store.derive({
    source: "server",
    actor: { agentId: "pilink-server", agentName: "PiLink Server", roleId: "manager" },
    idempotencyKey,
  }, input);
}

async function seed(value, taskId) {
  const project = await derive(value.memoryStore, "mcp-project", memoryInput(
    "MCP project fact",
    "Project memory is visible to any authenticated project reader.",
    { visibility: "project" },
  ));
  const principal = await derive(value.memoryStore, "mcp-principal", memoryInput(
    "MCP principal fact",
    "Principal memory is visible only to the matching OAuth actor.",
    { visibility: "principal", principalIds: [identity.agentId] },
  ));
  const role = await derive(value.memoryStore, "mcp-role", memoryInput(
    "MCP implementer fact",
    "Verified implementers may read this role memory.",
    { visibility: "role", roleIds: ["implementer"] },
  ));
  const session = await derive(value.memoryStore, "mcp-session", memoryInput(
    "MCP session fact",
    "The exact verified collaboration session may read this memory.",
    { visibility: "session", collaborationSessionIds: [sessionA] },
  ));
  const sibling = await derive(value.memoryStore, "mcp-sibling", memoryInput(
    "MCP sibling secret",
    "NEVER_EXPOSE_MCP_SIBLING_MEMORY",
    { visibility: "session", collaborationSessionIds: [sessionB] },
  ));
  const task = await derive(value.memoryStore, "mcp-task", memoryInput(
    "MCP task fact",
    "The exact authoritatively owned task may read this memory.",
    { visibility: "task", taskIds: [taskId] },
  ));
  const restricted = await derive(value.memoryStore, "mcp-restricted", memoryInput(
    "MCP restricted secret",
    "NEVER_EXPOSE_MCP_RESTRICTED_MEMORY",
    { visibility: "project", confidentiality: "restricted" },
  ));
  return { project, principal, role, session, sibling, task, restricted };
}

test("read-capable generic MCP sessions expose strict governed-memory tools without specialized scope", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const task = await value.taskStore.create({ ...identity, title: "Actor-only memory test task" });
  await value.taskStore.claim({ ...identity, taskId: task.taskId, expectedRevision: task.revision });
  const entries = await seed(value, task.taskId);
  const connection = await connect(value, { scopes: "mcp:read", instanceId: "generic-memory-reader" });
  try {
    const tools = (await connection.client.listTools()).tools;
    const memoryTools = tools.filter((tool) => tool.name.startsWith("agent_memory_"));
    assert.deepEqual(
      memoryTools.map((tool) => tool.name).sort(),
      ["agent_memory_boot_read", "agent_memory_get", "agent_memory_manifest_read", "agent_memory_query"],
    );
    for (const tool of memoryTools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.idempotentHint, true);
    }
    assert.equal(tools.some((tool) => tool.name === "collaboration_bootstrap"), false);

    const result = json(await connection.client.callTool({ name: "agent_memory_query", arguments: { limit: 20 } }));
    assert.deepEqual(
      new Set(result.entries.map((match) => match.entry.memoryId)),
      new Set([entries.project.memoryId, entries.principal.memoryId]),
    );
    assert.equal(JSON.stringify(result).includes("NEVER_EXPOSE_MCP_SIBLING_MEMORY"), false);
    assert.equal(JSON.stringify(result).includes("NEVER_EXPOSE_MCP_RESTRICTED_MEMORY"), false);

    const hidden = json(await connection.client.callTool({
      name: "agent_memory_get",
      arguments: { memory_id: entries.role.memoryId },
    }));
    assert.deepEqual(hidden, { found: false });

    const malformed = await connection.client.callTool({
      name: "agent_memory_query",
      arguments: { unexpected: true },
    });
    assert.equal(malformed.isError, true);
  } finally {
    await close(connection);
  }
});
test("verified MCP sessions derive role, session, and task memory authority without leaking siblings", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const created = await value.taskStore.create({
    ...identity,
    collaborationSessionId: sessionA,
    title: "Session-owned memory task",
  });
  await value.taskStore.claim({
    ...identity,
    collaborationSessionId: sessionA,
    taskId: created.taskId,
    expectedRevision: created.revision,
  });
  const entries = await seed(value, created.taskId);
  const connection = await connect(value, {
    scopes: "mcp:tools",
    bootstrap: new FakeBootstrap(sessionA),
    instanceId: "verified-memory-reader",
  });
  try {
    const bootstrapped = await connection.client.callTool({
      name: "collaboration_bootstrap",
      arguments: { requested_role_label: "Software Engineer 1" },
    });
    assert.notEqual(bootstrapped.isError, true);

    const result = json(await connection.client.callTool({ name: "agent_memory_query", arguments: { limit: 20 } }));
    assert.deepEqual(
      new Set(result.entries.map((match) => match.entry.memoryId)),
      new Set([
        entries.project.memoryId,
        entries.principal.memoryId,
        entries.role.memoryId,
        entries.session.memoryId,
        entries.task.memoryId,
      ]),
    );
    assert.equal(JSON.stringify(result).includes("NEVER_EXPOSE_MCP_SIBLING_MEMORY"), false);
    assert.equal(JSON.stringify(result).includes("NEVER_EXPOSE_MCP_RESTRICTED_MEMORY"), false);

    assert.deepEqual(json(await connection.client.callTool({
      name: "agent_memory_get",
      arguments: { memory_id: entries.sibling.memoryId },
    })), { found: false });

    const boot = json(await connection.client.callTool({
      name: "agent_memory_boot_read",
      arguments: { maximum_bytes: 4096, limit: 20 },
    }));
    assert.match(boot.markdown, /generated non-authoritative view/i);
    assert.match(boot.markdown, /BEGIN UNTRUSTED MEMORY DATA/);
    assert.equal(boot.markdown.includes("NEVER_EXPOSE_MCP_SIBLING_MEMORY"), false);

    const manifest = json(await connection.client.callTool({
      name: "agent_memory_manifest_read",
      arguments: { maximum_bytes: 8192, limit: 20 },
    }));
    const parsed = JSON.parse(manifest.manifest_json);
    assert.equal(parsed.trust, "untrusted_data_not_policy");
    assert.equal(parsed.entries.length, 5);
    assert.equal(manifest.manifest_json.includes("NEVER_EXPOSE_MCP_SIBLING_MEMORY"), false);

    const abstained = json(await connection.client.callTool({
      name: "agent_memory_query",
      arguments: { query_text: "no-such-governed-memory-match", limit: 5 },
    }));
    assert.equal(abstained.abstained, true);
    assert.equal(abstained.entries.length, 0);
  } finally {
    await close(connection);
  }
});

test("memory tool failures never expose private store paths", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const privatePath = path.join(value.dataDir, "projects", "private", "agent-memory.json");
  const memoryStore = {
    async query() {
      throw new Error(`EACCES: permission denied, open '${privatePath}'`);
    },
  };
  const connection = await connect(value, {
    scopes: "mcp:read",
    instanceId: "memory-error-redaction",
    memoryStore,
  });
  try {
    const result = await connection.client.callTool({
      name: "agent_memory_query",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.equal(text(result), "Error: Agent memory query failed");
    assert.equal(text(result).includes(privatePath), false);
    assert.equal(text(result).includes("EACCES"), false);
  } finally {
    await close(connection);
  }
});

test("write-only MCP scopes do not advertise governed-memory reads", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const connection = await connect(value, { scopes: "mcp:write", instanceId: "write-only-memory-client" });
  try {
    const tools = (await connection.client.listTools()).tools;
    assert.equal(tools.some((tool) => tool.name.startsWith("agent_memory_")), false);
  } finally {
    await close(connection);
  }
});
