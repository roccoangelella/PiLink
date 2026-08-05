import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const { createMcpServer } = await import(
  process.env.PILINK_TEST_SOURCE === "true" ? "../src/mcp.ts" : "../dist/mcp.js"
);

async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-approval-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return {
    workspace,
    policy: {
      workspace,
      unsafeFullAccess: true,
      allowWorkspaceExecution: true,
      requireExecutionApproval: true,
      maxBashTimeoutSeconds: 30,
    },
  };
}

async function connected(value, response, supportsElicitation = true, elicitationCapabilities = { form: {} }) {
  const handle = createMcpServer(value.policy, "mcp:tools");
  const requests = [];
  const client = new Client(
    { name: "approval-test", version: "1.0.0" },
    supportsElicitation ? { capabilities: { elicitation: elicitationCapabilities } } : undefined,
  );
  if (supportsElicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      requests.push(request);
      return typeof response === "function" ? response(request) : response;
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
  return {
    client,
    handle,
    requests,
    async close() {
      handle.dispose();
      await client.close();
    },
  };
}

function resultText(result) {
  return result.content.find((item) => item.type === "text")?.text || "";
}

test("approved unrestricted bash executes only after exact form elicitation", async (t) => {
  const value = await fixture(t);
  const connection = await connected(value, { action: "accept", content: { approved: true } });
  t.after(() => connection.close());
  const marker = path.join(value.workspace, "approved.txt");
  const command = `node -e "require('node:fs').writeFileSync('approved.txt','yes')"`;

  const result = await connection.client.callTool({ name: "bash", arguments: { command } });
  assert.notEqual(result.isError, true);
  assert.equal(await fs.readFile(marker, "utf8"), "yes");
  assert.equal(connection.requests.length, 1);
  const request = connection.requests[0];
  assert.equal(request.params.mode, "form");
  assert.match(request.params.message, /Unrestricted shell command/);
  assert.match(request.params.message, /approved\.txt/);
  assert.deepEqual(request.params.requestedSchema.required, ["approved"]);
  assert.equal(request.params.requestedSchema.properties.approved.default, false);
});

test("decline, cancel, and unchecked acceptance fail closed without execution", async (t) => {
  const value = await fixture(t);
  for (const [name, response, expected] of [
    ["decline", { action: "decline" }, /declined by the user/],
    ["cancel", { action: "cancel" }, /approval was cancelled/],
    ["unchecked", { action: "accept", content: { approved: false } }, /not explicitly approved/],
  ]) {
    const connection = await connected(value, response);
    const marker = `${name}.txt`;
    try {
      const result = await connection.client.callTool({
        name: "bash",
        arguments: { command: `node -e "require('node:fs').writeFileSync('${marker}','bad')"` },
      });
      assert.equal(result.isError, true, name);
      assert.match(resultText(result), expected, name);
      await assert.rejects(fs.access(path.join(value.workspace, marker)), undefined, name);
    } finally {
      await connection.close();
    }
  }
});

test("legacy empty elicitation capability is treated as form support", async (t) => {
  const value = await fixture(t);
  const connection = await connected(
    value,
    { action: "decline" },
    true,
    {},
  );
  t.after(() => connection.close());

  const result = await connection.client.callTool({
    name: "bash",
    arguments: { command: "node -e \"process.exit(0)\"" },
  });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /declined by the user/);
  assert.equal(connection.requests.length, 1);
});

test("clients without form elicitation cannot bypass required approval", async (t) => {
  const value = await fixture(t);
  const connection = await connected(value, undefined, false);
  t.after(() => connection.close());

  const result = await connection.client.callTool({
    name: "bash",
    arguments: { command: "node -e \"process.exit(0)\"" },
  });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /does not support form elicitation/);
});

test("approval is limited to code execution profiles, not read-only Git inspection", async (t) => {
  const value = await fixture(t);
  await fs.writeFile(path.join(value.workspace, "package.json"), JSON.stringify({
    name: "approval-run-test",
    version: "1.0.0",
    scripts: {
      test: "node -e \"require('node:fs').writeFileSync('npm-approved.txt','yes')\"",
    },
  }));
  const connection = await connected(value, { action: "accept", content: { approved: true } });
  t.after(() => connection.close());

  const git = await connection.client.callTool({ name: "run", arguments: { profile: "git_status" } });
  assert.equal(connection.requests.length, 0);
  assert.equal(git.isError, true); // The temporary directory is intentionally not a Git repository.

  const npm = await connection.client.callTool({ name: "run", arguments: { profile: "npm_test" } });
  assert.notEqual(npm.isError, true);
  assert.equal(connection.requests.length, 1);
  assert.match(connection.requests[0].params.message, /Repository-code profile npm_test/);
  assert.equal(await fs.readFile(path.join(value.workspace, "npm-approved.txt"), "utf8"), "yes");
});

test("approval review escapes control and bidirectional characters", async (t) => {
  const value = await fixture(t);
  const connection = await connected(value, { action: "decline" });
  t.after(() => connection.close());
  const command = "printf '\\u001b[31m' && echo safe\u202etxt.exe";

  const result = await connection.client.callTool({ name: "bash", arguments: { command } });
  assert.equal(result.isError, true);
  const message = connection.requests[0].params.message;
  assert.match(message, /\\u001b/);
  assert.match(message, /\\u202e/);
  assert.doesNotMatch(message, /\u001b/);
  assert.doesNotMatch(message, /\u202e/);
});

test("approval mode rejects shell commands too large for meaningful review", async (t) => {
  const value = await fixture(t);
  const connection = await connected(value, { action: "accept", content: { approved: true } });
  t.after(() => connection.close());

  const result = await connection.client.callTool({
    name: "bash",
    arguments: { command: `echo ${"x".repeat(4_100)}` },
  });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /4,000-character execution-approval review limit/);
  assert.equal(connection.requests.length, 0);
});
