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

async function connect(t, scope, overrides = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-run-errors-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const handle = createMcpServer({
    workspace,
    unsafeFullAccess: false,
    allowWorkspaceExecution: false,
    maxBashTimeoutSeconds: 30,
    ...overrides,
  }, scope);
  const client = new Client({ name: "run-usability-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
  t.after(async () => {
    handle.dispose();
    await client.close();
  });
  return { client, workspace };
}

function text(result) {
  return result.content.find((entry) => entry.type === "text")?.text || "";
}

test("read-only Git run profiles work with mcp:read while repository execution still requires write", async (t) => {
  const { client, workspace } = await connect(t, "mcp:read");
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  const git = await client.callTool({ name: "run", arguments: { profile: "git_status" } });
  assert.notEqual(git.isError, true, text(git));
  assert.equal(JSON.parse(text(git)).exitCode, 0);

  const npm = await client.callTool({ name: "run", arguments: { profile: "npm_test" } });
  assert.equal(npm.isError, true);
  assert.match(text(npm), /require the mcp:write or mcp:tools scope/);
  assert.match(text(npm), /Reconnect PiLink with write access/);
});

test("disabled workspace execution names the safe opt-in and restart", async (t) => {
  const { client } = await connect(t, "mcp:tools");
  const result = await client.callTool({ name: "run", arguments: { profile: "npm_test" } });

  assert.equal(result.isError, true);
  assert.match(text(result), /executes repository code and is disabled by default in workspace mode/);
  assert.match(text(result), /PI_ALLOW_WORKSPACE_EXECUTION=true/);
  assert.match(text(result), /trusted workspace/);
  assert.match(text(result), /restart PiLink/);
});

test("invalid npm profile paths explain what to remove", async (t) => {
  const { client } = await connect(t, "mcp:tools", { allowWorkspaceExecution: true });
  const result = await client.callTool({
    name: "run",
    arguments: { profile: "npm_build", paths: ["package.json"] },
  });

  assert.equal(result.isError, true);
  assert.match(text(result), /paths cannot be used with npm_build/);
  assert.match(text(result), /Remove paths/);
  assert.match(text(result), /runs the package script in cwd/);
});
