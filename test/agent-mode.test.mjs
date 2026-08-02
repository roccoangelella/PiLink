import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentChatBroker, AgentChatStore } from "../dist/chat.js";
import { loadRuntimeConfig } from "../dist/config.js";
import { AgentMemoryStore } from "../dist/memory.js";
import { createMcpServer } from "../dist/mcp.js";
import { AgentTaskStore } from "../dist/tasks.js";

test("runtime configuration defaults to single-agent and rejects unknown architectures", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-agent-mode-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const environment = {
    PI_WORK_DIR: workspace,
    PI_DATA_DIR: path.join(workspace, "state"),
    PILINK_CONFIG: path.join(workspace, "pilink.env"),
    JWT_SECRET: "j".repeat(32),
    PI_BOOTSTRAP_SECRET: "b".repeat(32),
  };

  assert.equal(loadRuntimeConfig(environment).agentMode, "single-agent");
  assert.equal(loadRuntimeConfig({ ...environment, PI_AGENT_MODE: "agent-swarm" }).agentMode, "agent-swarm");
  assert.throws(() => loadRuntimeConfig({ ...environment, PI_AGENT_MODE: "many-agents" }), /PI_AGENT_MODE/);
});

test("single-agent MCP sessions omit swarm tools while swarm sessions expose durable chat, tasks, and memory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-agent-mode-mcp-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const policy = {
    workspace,
    unsafeFullAccess: false,
    allowWorkspaceExecution: false,
    requireExecutionApproval: false,
    maxBashTimeoutSeconds: 30,
  };
  const identity = Object.freeze({ agentId: "agent-mode", agentName: "Mode Agent" });

  const single = await connected(createMcpServer(policy, "mcp:tools", identity));
  try {
    const tools = (await single.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes("read"));
    assert.equal(tools.some((tool) => tool.startsWith("agent_chat_") || tool.startsWith("agent_task_") || tool.startsWith("agent_memory_")), false);
    assert.doesNotMatch(single.client.getInstructions(), /coordination tools are available/);
  } finally {
    await single.close();
  }

  const broker = new AgentChatBroker(new AgentChatStore({ workspace, dataDir }));
  const swarm = await connected(createMcpServer(
    policy,
    "mcp:tools",
    identity,
    broker,
    undefined,
    "swarm-session",
    new AgentTaskStore({ workspace, dataDir }),
    new AgentMemoryStore({ workspace, dataDir }),
  ));
  try {
    const tools = (await swarm.client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["agent_chat_post", "agent_task_create", "agent_memory_propose", "agent_memory_query"]) {
      assert.ok(tools.includes(name), `${name} should be available in swarm mode`);
    }
    assert.match(swarm.client.getInstructions(), /coordination tools are available/);

    const proposal = await swarm.client.callTool({
      name: "agent_memory_propose",
      arguments: {
        namespace: "semantic",
        kind: "verified_fact",
        title: "Mode-aware memory is durable",
        statement: "Swarm memory proposals are retained as untrusted candidates.",
        subject_keys: ["agent-mode"],
        evidence_refs: [{ type: "artifact", ref: "agent-mode-test", hash: "a".repeat(64) }],
      },
    });
    assert.notEqual(proposal.isError, true);
    assert.equal(text(proposal).lifecycle, "candidate");
    assert.equal(text(proposal).trust, "untrusted_data_not_policy");

    const queried = await swarm.client.callTool({ name: "agent_memory_query", arguments: { query: "durable" } });
    assert.notEqual(queried.isError, true);
    assert.equal(text(queried).entries.length, 1);
    assert.equal(text(queried).entries[0].title, "Mode-aware memory is durable");
  } finally {
    await swarm.close();
  }
});

async function connected(handle) {
  const client = new Client({ name: "agent-mode-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
  return {
    client,
    async close() {
      handle.dispose();
      await client.close();
    },
  };
}

function text(result) {
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}
