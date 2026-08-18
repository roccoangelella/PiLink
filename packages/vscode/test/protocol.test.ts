import assert from "node:assert/strict";
import test from "node:test";
import { parseWebviewMessage, WEBVIEW_COMMANDS } from "../src/protocol.js";

test("parseWebviewMessage accepts every focused launcher command", () => {
  for (const command of WEBVIEW_COMMANDS) {
    assert.deepEqual(parseWebviewMessage({ type: "command", command }), {
      type: "command",
      command,
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
