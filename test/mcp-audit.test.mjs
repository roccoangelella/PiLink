import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolAuditLog } from "../dist/audit.js";
import { AgentChatBroker, AgentChatStore } from "../dist/chat.js";
import { createMcpServer } from "../dist/mcp.js";
import { AgentTaskStore } from "../dist/tasks.js";

const execFileAsync = promisify(execFile);

test("audits every MCP tool category without recording arguments or results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-mcp-audit-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "note.txt"), "sensitive file contents\n");
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });

  const audit = new ToolAuditLog({ workspace, dataDir });
  const broker = new AgentChatBroker(new AgentChatStore({ workspace, dataDir }));
  const tasks = new AgentTaskStore({ workspace, dataDir });
  const handle = createMcpServer(
    { workspace, unsafeFullAccess: false, allowWorkspaceExecution: false, maxBashTimeoutSeconds: 10 },
    "mcp:tools",
    Object.freeze({ agentId: "audit-agent", agentName: "Audit Agent" }),
    broker,
    audit,
    "audit-instance",
    tasks,
  );
  const client = new Client({ name: "mcp-audit-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);

  try {
    await client.callTool({ name: "get_system_prompt", arguments: {} });
    const read = await client.callTool({ name: "read", arguments: { path: "note.txt" } });
    assert.notEqual(read.isError, true);
    const missing = await client.callTool({ name: "read", arguments: { path: "missing.txt" } });
    assert.equal(missing.isError, true);
    const run = await client.callTool({ name: "run", arguments: { profile: "git_status" } });
    assert.notEqual(run.isError, true);
    await client.callTool({ name: "agent_chat_post", arguments: { agent_message: "coordinate privately" } });
    await client.callTool({
      name: "agent_task_create",
      arguments: { title: "sensitive coordination task", details: "private acceptance criteria" },
    });

    await audit.flush();
    const events = (await fs.readFile(audit.logPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map((event) => event.tool), [
      "get_system_prompt",
      "read",
      "read",
      "run",
      "agent_chat_post",
      "agent_task_create",
    ]);
    assert.deepEqual(events.map((event) => event.outcome), ["success", "success", "error", "success", "success", "success"]);
    assert.ok(events.every((event) => event.agentId === "audit-agent"));
    assert.ok(events.every((event) => event.accessMode === "workspace"));
    assert.equal(new Set(events.map((event) => event.callId)).size, events.length);
    assert.ok(events.every((event) => Number.isSafeInteger(event.durationMs) && event.durationMs >= 0));

    const runEvent = events.find((event) => event.tool === "run");
    assert.deepEqual(
      {
        exitCode: runEvent.exitCode,
        timedOut: runEvent.timedOut,
        cancelled: runEvent.cancelled,
        truncated: runEvent.truncated,
      },
      { exitCode: 0, timedOut: false, cancelled: false, truncated: false },
    );

    const serialized = JSON.stringify(events);
    for (const sensitive of [
      "note.txt",
      "missing.txt",
      "sensitive file contents",
      "coordinate privately",
      "sensitive coordination task",
      "private acceptance criteria",
    ]) {
      assert.doesNotMatch(serialized, new RegExp(sensitive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.ok(events.every((event) => !Object.hasOwn(event, "input") && !Object.hasOwn(event, "result") && !Object.hasOwn(event, "error")));
  } finally {
    handle.dispose();
    await client.close();
    await audit.flush();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("audit sink failures never change tool results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-mcp-audit-failure-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);

  let attempts = 0;
  const audit = {
    record() {
      attempts += 1;
      if (attempts === 1) throw new Error("synchronous audit failure");
      return Promise.reject(new Error("asynchronous audit failure"));
    },
  };
  const handle = createMcpServer(
    { workspace, unsafeFullAccess: false, allowWorkspaceExecution: false, maxBashTimeoutSeconds: 10 },
    "mcp:read",
    undefined,
    undefined,
    audit,
  );
  const client = new Client({ name: "mcp-audit-failure-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalError = console.error;
  console.error = () => undefined;
  await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);

  try {
    const first = await client.callTool({ name: "get_system_prompt", arguments: {} });
    const second = await client.callTool({ name: "get_system_prompt", arguments: {} });
    assert.notEqual(first.isError, true);
    assert.notEqual(second.isError, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 2);
  } finally {
    console.error = originalError;
    handle.dispose();
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
