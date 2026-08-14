import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/mcp.js";

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

test("run scope denial explains how to reconnect with write access", async (t) => {
  const { client } = await connect(t, "mcp:read");
  const result = await client.callTool({ name: "run", arguments: { profile: "git_status" } });

  assert.equal(result.isError, true);
  assert.match(text(result), /requires the mcp:write or mcp:tools scope/);
  assert.match(text(result), /Reconnect VSPiLink with write access/);
});

test("disabled workspace execution names the safe opt-in and restart", async (t) => {
  const { client } = await connect(t, "mcp:tools");
  const result = await client.callTool({ name: "run", arguments: { profile: "npm_test" } });

  assert.equal(result.isError, true);
  assert.match(text(result), /executes code from the workspace and is disabled by default/);
  assert.match(text(result), /PI_ALLOW_WORKSPACE_EXECUTION=true/);
  assert.match(text(result), /trusted workspace/);
  assert.match(text(result), /restart VSPiLink/);
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
  assert.match(text(result), /configured workspace/);
});
