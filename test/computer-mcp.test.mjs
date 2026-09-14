import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerComputerTools } from "../dist/computer-mcp.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1xkAAAAASUVORK5CYII=",
  "base64",
);

function observation() {
  return {
    data: PNG_1X1,
    mimeType: "image/png",
    width: 1,
    height: 1,
    cursor: { x: 0, y: 0 },
    capturedAt: "2026-09-14T10:00:00.000Z",
    backend: "fake",
  };
}

async function connectedServer(t, { computerControl = true, scopes = "mcp:tools" } = {}) {
  const actions = [];
  const backend = {
    name: "fake",
    async observe() {
      return observation();
    },
    async action(input) {
      actions.push(input);
    },
  };
  const server = new McpServer({ name: "computer-test", version: "1.0.0" });
  registerComputerTools(
    server,
    { workspace: process.cwd(), unsafeFullAccess: false, computerControl },
    scopes,
    undefined,
    "pi_1111111111111111",
    backend,
  );
  const client = new Client({ name: "computer-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return { client, actions };
}

test("Computer Use advertises exactly the observe/act add-on tools when enabled", async (t) => {
  const { client } = await connectedServer(t);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["computer_action", "computer_observe"]);
});

test("computer_observe returns an MCP image plus structured geometry", async (t) => {
  const { client } = await connectedServer(t);
  const result = await client.callTool({ name: "computer_observe", arguments: {} });
  assert.notEqual(result.isError, true);
  const image = result.content.find((entry) => entry.type === "image");
  assert.ok(image);
  assert.equal(image.mimeType, "image/png");
  assert.equal(Buffer.from(image.data, "base64").equals(PNG_1X1), true);
  assert.equal(result.structuredContent.width, 1);
  assert.equal(result.structuredContent.height, 1);
  assert.equal(result.structuredContent.backend, "fake");
});

test("computer_action executes one action and returns a post-action screenshot", async (t) => {
  const { client, actions } = await connectedServer(t);
  const result = await client.callTool({
    name: "computer_action",
    arguments: { action: "click", x: 0, y: 0, observe_after_ms: 0 },
  });
  assert.notEqual(result.isError, true);
  assert.deepEqual(actions, [{ action: "click", x: 0, y: 0 }]);
  assert.equal(result.structuredContent.action, "click");
  assert.ok(result.content.some((entry) => entry.type === "image"));
});

test("Computer Use tools are absent when the per-client policy is disabled", async (t) => {
  const { client } = await connectedServer(t, { computerControl: false });
  assert.deepEqual((await client.listTools()).tools, []);
});

test("read-only OAuth scope cannot inject desktop input", async (t) => {
  const { client, actions } = await connectedServer(t, { scopes: "mcp:read" });
  const observe = await client.callTool({ name: "computer_observe", arguments: {} });
  assert.notEqual(observe.isError, true);
  const action = await client.callTool({
    name: "computer_action",
    arguments: { action: "keypress", keys: ["ENTER"], observe_after_ms: 0 },
  });
  assert.equal(action.isError, true);
  assert.deepEqual(actions, []);
});
