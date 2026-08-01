import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentChatBroker, AgentChatStore, AGENT_CHAT_HISTORY_LIMIT, AGENT_CHAT_URI } from "../dist/chat.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-chat-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  return { root, workspace, dataDir };
}

test("persists across instances and uses canonical project-scoped state", async () => {
  const { root, workspace, dataDir } = await fixture();
  try {
    const first = new AgentChatBroker(new AgentChatStore({ workspace, dataDir }));
    const posted = await first.post({ agentId: "a", agentInstanceId: "instance-a", agentName: " Alice ", agentMessage: " hello " });
    const second = new AgentChatBroker(new AgentChatStore({ workspace, dataDir }));
    assert.equal((await second.read()).messages[0].cursor, posted.cursor);

    const canonical = await fs.realpath(workspace);
    const key = crypto.createHash("sha256").update(canonical).digest("hex");
    const statePath = path.join(dataDir, "projects", key, "agent-chat.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.projectKey, key);
    assert.equal((await fs.stat(path.dirname(statePath))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("retries a failed state load after the persisted file is repaired", async () => {
  const { root, workspace, dataDir } = await fixture();
  try {
    const store = new AgentChatStore({ workspace, dataDir });
    await fs.mkdir(path.dirname(store.statePath), { recursive: true });
    await fs.writeFile(store.statePath, "{invalid-json", { mode: 0o600 });

    await assert.rejects(() => store.read(), /invalid JSON/);

    await fs.writeFile(store.statePath, `${JSON.stringify({
      version: 1,
      projectKey: store.projectKey,
      nextCursor: 2,
      messages: [{ cursor: 1, agentId: "legacy-agent", agentName: "Legacy", agentMessage: "old" }],
    })}\n`, { mode: 0o600 });

    const result = await store.read();
    assert.deepEqual(result, {
      messages: [{
        cursor: 1,
        agentId: "legacy-agent",
        agentInstanceId: "legacy:legacy-agent",
        agentName: "Legacy",
        agentMessage: "old",
      }],
      oldestCursor: 1,
      latestCursor: 1,
      nextCursor: 1,
      gap: false,
    });
    const migrated = JSON.parse(await fs.readFile(store.statePath, "utf8"));
    assert.equal(migrated.version, 2);
    assert.equal(migrated.messages[0].agentInstanceId, "legacy:legacy-agent");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects gaps within the retained cursor window", async () => {
  const { root, workspace, dataDir } = await fixture();
  try {
    const store = new AgentChatStore({ workspace, dataDir });
    await fs.mkdir(path.dirname(store.statePath), { recursive: true });
    await fs.writeFile(store.statePath, `${JSON.stringify({
      version: 2,
      projectKey: store.projectKey,
      nextCursor: 4,
      messages: [
        {
          cursor: 1,
          agentId: "agent-a",
          agentInstanceId: "instance-a",
          agentName: "Agent A",
          agentMessage: "first",
        },
        {
          cursor: 3,
          agentId: "agent-b",
          agentInstanceId: "instance-b",
          agentName: "Agent B",
          agentMessage: "third",
        },
      ],
    })}\n`, { mode: 0o600 });

    await assert.rejects(() => store.read(), /invalid cursors/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent posts and retains only the newest messages", async () => {
  const { root, workspace, dataDir } = await fixture();
  try {
    const broker = new AgentChatBroker(new AgentChatStore({ workspace, dataDir }));
    const posted = await Promise.all(Array.from({ length: 35 }, (_, index) => broker.post({
      agentId: `agent-${index}`,
      agentName: `Agent ${index}`,
      agentMessage: `message ${index}`,
    })));
    const cursors = posted.map((message) => message.cursor).sort((a, b) => a - b);
    assert.deepEqual(cursors, Array.from({ length: 35 }, (_, index) => index + 1));
    const result = await broker.read();
    assert.equal(result.messages.length, AGENT_CHAT_HISTORY_LIMIT);
    assert.deepEqual(result.messages.map((message) => message.cursor), Array.from({ length: 20 }, (_, index) => index + 16));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("serializes posts from separate stores for the same project", async () => {
  const { root, workspace, dataDir } = await fixture();
  try {
    const first = new AgentChatBroker(new AgentChatStore({ workspace, dataDir }));
    const second = new AgentChatBroker(new AgentChatStore({ workspace, dataDir }));
    const posted = await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? first : second).post({
      agentId: `agent-${index}`,
      agentName: `Agent ${index}`,
      agentMessage: `message ${index}`,
    })));
    assert.deepEqual(posted.map((message) => message.cursor).sort((a, b) => a - b), Array.from({ length: 10 }, (_, index) => index + 1));
    assert.equal((await first.read()).messages.length, 10);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("separates projects and reports stale and future cursors", async () => {
  const { root, workspace, dataDir } = await fixture();
  const otherWorkspace = path.join(root, "other-workspace");
  await fs.mkdir(otherWorkspace);
  try {
    const broker = new AgentChatBroker(new AgentChatStore({ workspace, dataDir }));
    const other = new AgentChatBroker(new AgentChatStore({ workspace: otherWorkspace, dataDir }));
    await Promise.all(Array.from({ length: 22 }, (_, index) => broker.post({ agentId: "a", agentName: "A", agentMessage: `${index}` })));
    assert.equal((await other.read()).latestCursor, 0);
    assert.equal((await broker.read(1)).gap, true);
    await assert.rejects(() => broker.read(999), /ahead/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("validates values and excludes only the posting instance from notifications", async () => {
  const { root, workspace, dataDir } = await fixture();
  try {
    const broker = new AgentChatBroker(new AgentChatStore({ workspace, dataDir }));
    for (const input of [
      { agentId: "a", agentName: " ", agentMessage: "ok" },
      { agentId: "a", agentName: "ok", agentMessage: " \n" },
      { agentId: "a", agentName: "x".repeat(101), agentMessage: "ok" },
      { agentId: "a", agentInstanceId: " ", agentName: "ok", agentMessage: "ok" },
      { agentId: "a", agentName: "ok", agentMessage: "x".repeat(8193) },
    ]) await assert.rejects(() => broker.post(input));

    const received = [];
    broker.subscribe("sender-instance", () => { throw new Error("ignored"); });
    broker.subscribe("sender-instance", (notification) => received.push(["same-instance", notification]));
    broker.subscribe("same-actor-other-instance", (notification) => received.push(["same-actor", notification]));
    broker.subscribe("receiver-instance", async () => { throw new Error("ignored"); });
    broker.subscribe("receiver-instance", (notification) => received.push(["other-actor", notification]));
    const message = await broker.post({
      agentId: "sender",
      agentInstanceId: "sender-instance",
      agentName: "Sender",
      agentMessage: "text",
    });
    await waitFor(() => received.length === 2);
    assert.deepEqual(received.sort(), [
      ["other-actor", { uri: AGENT_CHAT_URI, latestCursor: message.cursor }],
      ["same-actor", { uri: AGENT_CHAT_URI, latestCursor: message.cursor }],
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for notification");
}
