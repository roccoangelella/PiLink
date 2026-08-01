import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { AgentChatBroker, AgentChatStore, AGENT_CHAT_URI } from "../dist/chat.js";
import { createMcpServer } from "../dist/mcp.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-mcp-chat-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  return {
    root,
    workspace,
    broker: new AgentChatBroker(new AgentChatStore({ workspace, dataDir })),
    policy: { workspace, unsafeFullAccess: false, maxBashTimeoutSeconds: 30 },
  };
}

async function connected(fixtureValue, scopes, identity) {
  const handle = createMcpServer(fixtureValue.policy, scopes, Object.freeze(identity), fixtureValue.broker);
  const client = new Client({ name: "mcp-chat-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.server.connect(serverTransport)]);
  return { client, handle };
}

function text(result) {
  return JSON.parse(result.content.find((item) => item.type === "text").text);
}

async function closeConnection(connection) {
  connection.handle.dispose();
  await connection.client.close();
}

test("discovers native and chat tools with exact chat schemas", async () => {
  const value = await fixture();
  const connection = await connected(value, "mcp:tools", { agentId: "agent-a", agentName: "Agent A" });
  try {
    const tools = (await connection.client.listTools()).tools;
    assert.deepEqual(tools.filter((tool) => ["read", "bash", "edit", "write", "grep", "find", "ls", "agent_chat_post", "agent_chat_read"].includes(tool.name)).map((tool) => tool.name), ["read", "bash", "edit", "write", "grep", "find", "ls", "agent_chat_post", "agent_chat_read"]);

    const post = tools.find((tool) => tool.name === "agent_chat_post");
    assert.deepEqual(post.inputSchema.required, ["agent_name", "agent_message"]);
    assert.equal(post.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(post.inputSchema.properties).sort(), ["agent_message", "agent_name"]);
    const read = tools.find((tool) => tool.name === "agent_chat_read");
    assert.equal(read.inputSchema.additionalProperties, false);
    assert.deepEqual(read.inputSchema.required, undefined);

    assert.equal((await connection.client.callTool({ name: "agent_chat_post", arguments: { agent_name: "Agent A" } })).isError, true);
    assert.equal((await connection.client.callTool({ name: "agent_chat_post", arguments: { agent_name: "Agent A", agent_message: "do this", extra: true } })).isError, true);
  } finally {
    await closeConnection(connection);
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test("enforces scopes, binds posts to the authenticated identity, and maps results", async () => {
  const value = await fixture();
  const writer = await connected(value, "mcp:write", { agentId: "authenticated-id", agentName: "Authenticated Name" });
  const reader = await connected(value, "mcp:read", { agentId: "reader-id", agentName: "Reader" });
  try {
    const deniedRead = await writer.client.callTool({ name: "agent_chat_read", arguments: {} });
    assert.equal(deniedRead.isError, true);
    const deniedPost = await reader.client.callTool({ name: "agent_chat_post", arguments: { agent_name: "Reader", agent_message: "no" } });
    assert.equal(deniedPost.isError, true);

    const wrongName = await writer.client.callTool({ name: "agent_chat_post", arguments: { agent_name: "Forged Name", agent_message: "action" } });
    assert.equal(wrongName.isError, true);
    const posted = text(await writer.client.callTool({ name: "agent_chat_post", arguments: { agent_name: "Authenticated Name", agent_message: "action" } }));
    assert.deepEqual(posted, { cursor: 1, agent_id: "authenticated-id", agent_name: "Authenticated Name", agent_message: "action" });

    const read = text(await reader.client.callTool({ name: "agent_chat_read", arguments: { after: 0 } }));
    assert.deepEqual(read, {
      messages: [posted],
      oldest_cursor: 1,
      latest_cursor: 1,
      next_cursor: 1,
      gap: false,
    });
  } finally {
    await closeConnection(writer);
    await closeConnection(reader);
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test("authorizes the resource and fans out subscribed updates without same-agent notifications", async () => {
  const value = await fixture();
  const sender = await connected(value, "mcp:write", { agentId: "sender-id", agentName: "Sender" });
  const receiver = await connected(value, "mcp:read", { agentId: "receiver-id", agentName: "Receiver" });
  const sameAgent = await connected(value, "mcp:read", { agentId: "sender-id", agentName: "Sender" });
  const unsubscribed = await connected(value, "mcp:read", { agentId: "unsubscribed-id", agentName: "Unsubscribed" });
  const notifications = [];
  const unsubscribedNotifications = [];
  receiver.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => notifications.push(notification));
  sameAgent.client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => notifications.push({ sameAgent: true }));
  unsubscribed.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => unsubscribedNotifications.push(notification));
  try {
    const resource = (await receiver.client.listResources()).resources.find((item) => item.name === "agent_chat");
    assert.equal(resource.uri, AGENT_CHAT_URI);
    assert.equal(resource.mimeType, "application/json");
    assert.deepEqual(text(await receiver.client.callTool({ name: "agent_chat_read", arguments: {} })), {
      messages: [], oldest_cursor: 0, latest_cursor: 0, next_cursor: 0, gap: false,
    });
    const resourceResult = await receiver.client.readResource({ uri: AGENT_CHAT_URI });
    assert.deepEqual(JSON.parse(resourceResult.contents[0].text), {
      messages: [], oldest_cursor: 0, latest_cursor: 0, next_cursor: 0, gap: false,
    });

    const forbidden = await connected(value, "mcp:write", { agentId: "write-only", agentName: "Writer" });
    try {
      await assert.rejects(() => forbidden.client.readResource({ uri: AGENT_CHAT_URI }));
      await assert.rejects(() => forbidden.client.subscribeResource({ uri: AGENT_CHAT_URI }));
    } finally {
      await closeConnection(forbidden);
    }

    await receiver.client.subscribeResource({ uri: AGENT_CHAT_URI });
    await sameAgent.client.subscribeResource({ uri: AGENT_CHAT_URI });
    await unsubscribed.client.subscribeResource({ uri: AGENT_CHAT_URI });
    await unsubscribed.client.unsubscribeResource({ uri: AGENT_CHAT_URI });
    await assert.rejects(() => receiver.client.subscribeResource({ uri: "pilink://other" }));
    await sender.client.callTool({ name: "agent_chat_post", arguments: { agent_name: "Sender", agent_message: "coordinate" } });
    await waitFor(() => notifications.length === 1);
    assert.deepEqual(notifications[0], { method: "notifications/resources/updated", params: { uri: AGENT_CHAT_URI } });

    receiver.handle.dispose();
    await sender.client.callTool({ name: "agent_chat_post", arguments: { agent_name: "Sender", agent_message: "after dispose" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(notifications.length, 1);
    assert.equal(unsubscribedNotifications.length, 0);
  } finally {
    sender.handle.dispose();
    await sender.client.close();
    await closeConnection(receiver);
    await closeConnection(sameAgent);
    await closeConnection(unsubscribed);
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for notification");
}
