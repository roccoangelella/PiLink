import assert from "node:assert/strict";
import test from "node:test";
import { parseWebviewMessage, WEBVIEW_COMMANDS } from "../src/protocol.js";

test("parseWebviewMessage accepts every focused dashboard command", () => {
  for (const command of WEBVIEW_COMMANDS) {
    const taskMutation = command === "provideTaskInput" || command === "cancelTask";
    assert.deepEqual(parseWebviewMessage({
      type: "command",
      command,
      ...(taskMutation ? { taskId: "task-123", revision: 4 } : {}),
    }), {
      type: "command",
      command,
      ...(taskMutation ? { taskId: "task-123", revision: 4 } : {}),
    });
  }
});

test("parseWebviewMessage rejects malformed, legacy, and non-allowlisted messages", () => {
  const invalidMessages: unknown[] = [
    undefined,
    null,
    false,
    "refresh",
    [],
    {},
    { type: "event", command: "refresh" },
    { type: "command" },
    { type: "command", command: 1 },
    { type: "command", command: "not-a-command" },
    { type: "command", command: "provideTaskInput" },
    { type: "command", command: "cancelTask", taskId: "bad id", revision: 1 },
    { type: "command", command: "cancelTask", taskId: "task-1", revision: 0 },
    { type: "command", command: "sendChat" },
    { type: "command", command: "selectRuntimeMode" },
    { type: "wizard", action: "configureAndStart", requestId: "legacy" },
  ];

  for (const message of invalidMessages) {
    assert.equal(parseWebviewMessage(message), undefined);
  }
});

test("parseWebviewMessage strips arbitrary webview fields", () => {
  assert.deepEqual(parseWebviewMessage({
    type: "command",
    command: "refresh",
    value: "must not cross",
    arbitrary: { nested: true },
  }), {
    type: "command",
    command: "refresh",
  });
});

test("the focused protocol does not expose prompt, agent, native-MCP, or unsafe-launch commands", () => {
  const commands = new Set<string>(WEBVIEW_COMMANDS);
  for (const forbidden of [
    "sendChat",
    "setupChat",
    "configureAgents",
    "spawnAgent",
    "connectNativeMcp",
    "registerClient",
    "startUnsafe",
    "selectRuntimeMode",
    "openCollaborationMonitor",
  ]) assert.equal(commands.has(forbidden), false, forbidden);
});
