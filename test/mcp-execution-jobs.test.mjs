import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ExecutionJobStore } from "../dist/execution-jobs.js";
import { createMcpServer } from "../dist/mcp.js";

const execFileAsync = promisify(execFile);

function shellNode(source) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

async function fixture(t, unsafeFullAccess = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-mcp-exec-job-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  await fs.mkdir(dataDir);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ExecutionJobStore({ workspace, dataDir });
  const policy = { workspace, workingDirectory: workspace, unsafeFullAccess, allowWorkspaceExecution: true };
  const executionServices = { store, ownerId: "pi_1111111111111111", ownerName: "Owner" };
  const handle = createMcpServer(
    policy,
    "mcp:tools",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    executionServices,
  );
  const client = new Client({ name: "exec-job-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
  t.after(async () => {
    await handle.dispose();
    await client.close();
  });
  return { client, workspace };
}

function parsed(result) {
  const text = result.content.find((entry) => entry.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text);
}

test("full-access MCP exposes durable execution lifecycle without holding the start request open", async (t) => {
  const { client } = await fixture(t, true);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["exec_start", "exec_status", "exec_wait", "exec_output", "exec_cancel"]) {
    assert.ok(names.includes(name), `missing ${name}`);
  }

  const started = parsed(await client.callTool({
    name: "exec_start",
    arguments: {
      label: "mcp-long-job",
      command: shellNode("setTimeout(() => console.log('mcp-done'), 150)"),
    },
  }));
  assert.equal(started.status, "running");
  assert.match(started.job_id, /^exec_/u);

  const finished = parsed(await client.callTool({
    name: "exec_wait",
    arguments: { job_id: started.job_id, maximum_wait_seconds: 5 },
  }));
  assert.equal(finished.status, "completed");
  assert.match(finished.stdout_tail, /mcp-done/);

  const output = parsed(await client.callTool({
    name: "exec_output",
    arguments: { job_id: started.job_id, stream: "stdout", limit_bytes: 1024 },
  }));
  assert.match(output.text, /mcp-done/);
  assert.equal(output.eof, true);
});

test("safe-mode MCP hides unrestricted durable execution tools", async (t) => {
  const { client } = await fixture(t, false);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.equal(names.includes("exec_start"), false);
  assert.equal(names.includes("exec_cancel"), false);
});

test("repo_snapshot condenses routine Git inspection into one read-only tool", async (t) => {
  const { client, workspace } = await fixture(t, false);
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await fs.writeFile(path.join(workspace, "example.txt"), "hello\n");
  await execFileAsync("git", ["add", "example.txt"], { cwd: workspace });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial", "--quiet"], { cwd: workspace });
  await fs.appendFile(path.join(workspace, "example.txt"), "changed\n");

  const snapshot = parsed(await client.callTool({ name: "repo_snapshot", arguments: {} }));
  assert.equal(snapshot.status.exit_code, 0);
  assert.match(snapshot.status.stdout, /example\.txt/u);
  assert.match(snapshot.diff.stdout, /changed/u);
  assert.equal(snapshot.staged.exit_code, 0);
  assert.match(snapshot.log.stdout, /initial/u);
});
