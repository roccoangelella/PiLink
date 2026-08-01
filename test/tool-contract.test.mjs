import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentChatBroker, AgentChatStore } from "../dist/chat.js";
import { createMcpServer } from "../dist/mcp.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-tool-contract-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  return { root, workspace, dataDir };
}

test("every advertised tool has an agent-readable strict contract", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const broker = new AgentChatBroker(new AgentChatStore({ workspace: value.workspace, dataDir: value.dataDir }));
  const handle = createMcpServer(
    { workspace: value.workspace, unsafeFullAccess: false, allowWorkspaceExecution: false, maxBashTimeoutSeconds: 30 },
    "mcp:tools",
    Object.freeze({ agentId: "contract-agent", agentName: "Contract Agent" }),
    broker,
    undefined,
    "contract-instance",
  );
  const client = new Client({ name: "tool-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
  t.after(async () => {
    handle.dispose();
    await client.close();
  });

  const tools = (await client.listTools()).tools;
  assert.ok(tools.length >= 10, "expected the native, run, guidance, and coordination tools");
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length, "tool names must be unique");

  for (const tool of tools) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name}: use a stable snake_case identifier`);
    assert.ok(typeof tool.title === "string" && tool.title.trim().length >= 4, `${tool.name}: missing useful title`);
    assert.ok(
      typeof tool.description === "string" && tool.description.trim().length >= 24,
      `${tool.name}: description is too short to guide an agent`,
    );

    assert.equal(tool.inputSchema?.type, "object", `${tool.name}: input schema must be an object`);
    assert.equal(tool.inputSchema?.additionalProperties, false, `${tool.name}: input schema must reject unknown fields`);
    validateSchemaDocumentation(tool.inputSchema, `${tool.name}.inputSchema`, true);

    const annotations = tool.annotations;
    assert.ok(annotations, `${tool.name}: missing risk annotations`);
    for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.equal(typeof annotations[key], "boolean", `${tool.name}: ${key} must be explicit`);
    }
    assert.equal(
      annotations.readOnlyHint && annotations.destructiveHint,
      false,
      `${tool.name}: a tool cannot be both read-only and destructive`,
    );
    if (annotations.readOnlyHint) {
      assert.equal(annotations.idempotentHint, true, `${tool.name}: read-only tools should be idempotent`);
    }

    if (tool.outputSchema) validateSchemaDocumentation(tool.outputSchema, `${tool.name}.outputSchema`, false);
  }
});

function validateSchemaDocumentation(schema, location, requirePropertyDescriptions) {
  assert.ok(schema && typeof schema === "object" && !Array.isArray(schema), `${location}: schema must be an object`);

  if (schema.type === "object") {
    if (schema.properties) {
      for (const [name, property] of Object.entries(schema.properties)) {
        if (requirePropertyDescriptions) {
          assert.ok(
            typeof property.description === "string" && property.description.trim().length > 0,
            `${location}.properties.${name}: missing parameter description`,
          );
        }
        validateSchemaDocumentation(property, `${location}.properties.${name}`, requirePropertyDescriptions);
      }
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      validateSchemaDocumentation(schema.additionalProperties, `${location}.additionalProperties`, requirePropertyDescriptions);
    }
  }

  if (schema.type === "array" && schema.items) {
    validateSchemaDocumentation(schema.items, `${location}.items`, requirePropertyDescriptions);
  }

  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[keyword])) {
      schema[keyword].forEach((entry, index) => {
        validateSchemaDocumentation(entry, `${location}.${keyword}[${index}]`, requirePropertyDescriptions);
      });
    }
  }
}
