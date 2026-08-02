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

async function connected(fixtureValue, scopes, identity, agentInstanceId) {
  const handle = createMcpServer(
    fixtureValue.policy,
    scopes,
    Object.freeze(identity),
    fixtureValue.broker,
    undefined,
    agentInstanceId,
  );
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

test("discovers tools with precise schemas, annotations, and server instructions", async () => {
  const value = await fixture();
  const connection = await connected(value, "mcp:tools", { agentId: "agent-a", agentName: "Agent A" });
  try {
    const tools = (await connection.client.listTools()).tools;
    assert.deepEqual(tools.filter((tool) => ["read", "bash", "run", "edit", "write", "grep", "find", "ls", "agent_chat_post", "agent_chat_read"].includes(tool.name)).map((tool) => tool.name), ["read", "bash", "run", "edit", "write", "grep", "find", "ls", "agent_chat_post", "agent_chat_read"]);

    assert.match(connection.client.getInstructions(), /Inspect before changing files/);

    const nativeRead = tools.find((tool) => tool.name === "read");
    assert.equal(nativeRead.annotations.readOnlyHint, true);
    assert.equal(nativeRead.annotations.openWorldHint, false);
    assert.match(nativeRead.inputSchema.properties.offset.description, /One-based text line/);
    const bash = tools.find((tool) => tool.name === "bash");
    assert.equal(bash.annotations.destructiveHint, true);
    assert.equal(bash.annotations.openWorldHint, true);

    const run = tools.find((tool) => tool.name === "run");
    assert.equal(run.annotations.destructiveHint, true);
    assert.equal(run.inputSchema.additionalProperties, false);
    assert.deepEqual(run.inputSchema.required, ["profile"]);
    assert.ok(run.inputSchema.properties.profile.enum.includes("git_status"));
    assert.ok(run.inputSchema.properties.profile.enum.includes("npm_test"));
    assert.ok(run.outputSchema.required.includes("cancelled"));
    assert.ok(run.outputSchema.required.includes("durationMs"));

    const post = tools.find((tool) => tool.name === "agent_chat_post");
    assert.deepEqual(post.inputSchema.required, ["agent_message"]);
    assert.equal(post.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(post.inputSchema.properties).sort(), ["agent_message", "agent_name"]);
    assert.equal(post.annotations.destructiveHint, false);
    assert.equal(post.outputSchema.additionalProperties, false);
    assert.deepEqual(post.outputSchema.required, ["cursor", "agent_id", "agent_instance_id", "agent_name", "agent_message"]);
    const read = tools.find((tool) => tool.name === "agent_chat_read");
    assert.equal(read.inputSchema.additionalProperties, false);
    assert.deepEqual(read.inputSchema.required, undefined);
    assert.equal(read.annotations.readOnlyHint, true);
    assert.equal(read.outputSchema.additionalProperties, false);

    assert.equal((await connection.client.callTool({ name: "agent_chat_post", arguments: { agent_name: "Agent A" } })).isError, true);
    assert.equal((await connection.client.callTool({ name: "agent_chat_post", arguments: { agent_message: "do this", extra: true } })).isError, true);
  } finally {
    await closeConnection(connection);
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test("enforces scopes, binds posts to the authenticated identity, and maps results", async () => {
  const value = await fixture();
  const writer = await connected(value, "mcp:write", { agentId: "authenticated-id", agentName: "Authenticated Name" }, "writer-instance");
  const reader = await connected(value, "mcp:read", { agentId: "reader-id", agentName: "Reader" }, "reader-instance");
  try {
    const deniedRead = await writer.client.callTool({ name: "agent_chat_read", arguments: {} });
    assert.equal(deniedRead.isError, true);
    const deniedPost = await reader.client.callTool({ name: "agent_chat_post", arguments: { agent_name: "Reader", agent_message: "no" } });
    assert.equal(deniedPost.isError, true);

    const wrongName = await writer.client.callTool({ name: "agent_chat_post", arguments: { agent_name: "Forged Name", agent_message: "action" } });
    assert.equal(wrongName.isError, true);
    const postedResult = await writer.client.callTool({ name: "agent_chat_post", arguments: { agent_message: "action" } });
    const posted = text(postedResult);
    assert.deepEqual(posted, {
      cursor: 1,
      agent_id: "authenticated-id",
      agent_instance_id: "writer-instance",
      agent_name: "Authenticated Name",
      agent_message: "action",
    });
    assert.deepEqual(postedResult.structuredContent, posted);

    const readResult = await reader.client.callTool({ name: "agent_chat_read", arguments: { after: 0 } });
    const read = text(readResult);
    assert.deepEqual(read, {
      messages: [posted],
      oldest_cursor: 1,
      latest_cursor: 1,
      next_cursor: 1,
      gap: false,
    });
    assert.deepEqual(readResult.structuredContent, read);
  } finally {
    await closeConnection(writer);
    await closeConnection(reader);
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test("authorizes the resource and suppresses only the posting connection", async () => {
  const value = await fixture();
  const sender = await connected(value, "mcp:tools", { agentId: "sender-id", agentName: "Sender" }, "sender-instance");
  const receiver = await connected(value, "mcp:read", { agentId: "receiver-id", agentName: "Receiver" }, "receiver-instance");
  const sameActor = await connected(value, "mcp:read", { agentId: "sender-id", agentName: "Sender" }, "same-actor-instance");
  const unsubscribed = await connected(value, "mcp:read", { agentId: "unsubscribed-id", agentName: "Unsubscribed" }, "unsubscribed-instance");
  const senderNotifications = [];
  const receiverNotifications = [];
  const sameActorNotifications = [];
  const unsubscribedNotifications = [];
  sender.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => senderNotifications.push(notification));
  receiver.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => receiverNotifications.push(notification));
  sameActor.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => sameActorNotifications.push(notification));
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

    await sender.client.subscribeResource({ uri: AGENT_CHAT_URI });
    await receiver.client.subscribeResource({ uri: AGENT_CHAT_URI });
    await sameActor.client.subscribeResource({ uri: AGENT_CHAT_URI });
    await unsubscribed.client.subscribeResource({ uri: AGENT_CHAT_URI });
    await unsubscribed.client.unsubscribeResource({ uri: AGENT_CHAT_URI });
    await assert.rejects(() => receiver.client.subscribeResource({ uri: "pilink://other" }));
    const posted = text(await sender.client.callTool({ name: "agent_chat_post", arguments: { agent_name: "Sender", agent_message: "coordinate" } }));
    assert.equal(posted.agent_id, "sender-id");
    assert.equal(posted.agent_instance_id, "sender-instance");
    await waitFor(() => receiverNotifications.length === 1 && sameActorNotifications.length === 1);
    const expectedNotification = { method: "notifications/resources/updated", params: { uri: AGENT_CHAT_URI } };
    assert.deepEqual(receiverNotifications[0], expectedNotification);
    assert.deepEqual(sameActorNotifications[0], expectedNotification);
    assert.equal(senderNotifications.length, 0);

    receiver.handle.dispose();
    await sender.client.callTool({ name: "agent_chat_post", arguments: { agent_name: "Sender", agent_message: "after dispose" } });
    await waitFor(() => sameActorNotifications.length === 2);
    assert.equal(receiverNotifications.length, 1);
    assert.equal(senderNotifications.length, 0);
    assert.equal(unsubscribedNotifications.length, 0);
  } finally {
    sender.handle.dispose();
    await sender.client.close();
    await closeConnection(receiver);
    await closeConnection(sameActor);
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
