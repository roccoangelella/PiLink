import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/mcp.js";

const execFileAsync = promisify(execFile);

test("run sends ordered progress when the MCP client requests it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-mcp-progress-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const handle = createMcpServer(
    { workspace, unsafeFullAccess: false, allowWorkspaceExecution: false, maxBashTimeoutSeconds: 10 },
    "mcp:write",
  );
  const client = new Client({ name: "mcp-progress-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
  t.after(async () => {
    handle.dispose();
    await client.close();
  });

  const progress = [];
  const result = await client.callTool(
    { name: "run", arguments: { profile: "git_status" } },
    undefined,
    {
      onprogress(update) {
        progress.push(update);
      },
      resetTimeoutOnProgress: true,
      timeout: 10_000,
    },
  );

  assert.notEqual(result.isError, true);
  assert.ok(progress.length >= 2);
  assert.deepEqual(
    progress.map((update) => update.progress),
    Array.from({ length: progress.length }, (_, index) => index),
  );
  assert.equal(progress[0].message, "run git_status started");
  assert.equal(progress.at(-1).message, "run git_status completed");
  assert.ok(progress.every((update) => update.total === undefined));
  assert.ok(progress.every((update) => !/workspace|\.git|command|stdout|stderr/i.test(update.message)));
});
