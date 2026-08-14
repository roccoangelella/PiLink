import assert from "node:assert/strict";
import test from "node:test";
import { parseWebviewMessage, WEBVIEW_COMMANDS } from "../src/protocol.js";

test("parseWebviewMessage accepts every allowlisted command", () => {
  for (const command of WEBVIEW_COMMANDS) {
    const message = command === "selectRuntimeMode"
      ? { type: "command", command, value: "single" }
      : { type: "command", command };
    assert.deepEqual(parseWebviewMessage(message), {
      type: "command",
      command,
      ...(command === "selectRuntimeMode" ? { value: "single" } : {}),
    });
  }
});

test("parseWebviewMessage rejects malformed and non-allowlisted messages", () => {
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
    { type: "command", command: "refresh", value: 42 },
    { type: "command", command: "selectRuntimeMode" },
    { type: "command", command: "selectRuntimeMode", value: "remote" },
  ];

  for (const message of invalidMessages) {
    assert.equal(parseWebviewMessage(message), undefined);
  }
});

test("runtime workflow messages accept only the server modes", () => {
  assert.deepEqual(parseWebviewMessage({
    type: "command",
    command: "selectRuntimeMode",
    value: "single",
  }), {
    type: "command",
    command: "selectRuntimeMode",
    value: "single",
  });
  assert.deepEqual(parseWebviewMessage({
    type: "command",
    command: "selectRuntimeMode",
    value: "collaboration",
  }), {
    type: "command",
    command: "selectRuntimeMode",
    value: "collaboration",
  });
  assert.equal(parseWebviewMessage({
    type: "command",
    command: "selectRuntimeMode",
    value: "local",
  }), undefined);
});

test("parseWebviewMessage enforces the value size boundary", () => {
  const maximumValue = "x".repeat(16_384);
  assert.deepEqual(parseWebviewMessage({
    type: "command",
    command: "sendInput",
    value: maximumValue,
  }), {
    type: "command",
    command: "sendInput",
    value: maximumValue,
  });
  assert.deepEqual(parseWebviewMessage({
    type: "wizard",
    action: "chooseCloudflareCredential",
    requestId: "cloudflare-1",
    credentialKind: "origin-certificate",
    filePath: "/must/not/cross",
  }), {
    type: "wizard",
    action: "chooseCloudflareCredential",
    requestId: "cloudflare-1",
    credentialKind: "origin-certificate",
  });

  assert.equal(parseWebviewMessage({
    type: "command",
    command: "sendInput",
    value: `${maximumValue}x`,
  }), undefined);

  const maximumChatMessage = "x".repeat(65_536);
  assert.deepEqual(parseWebviewMessage({
    type: "command",
    command: "sendChat",
    value: maximumChatMessage,
  }), {
    type: "command",
    command: "sendChat",
    value: maximumChatMessage,
  });
  assert.equal(parseWebviewMessage({
    type: "command",
    command: "sendChat",
    value: `${maximumChatMessage}x`,
  }), undefined);
});

test("parseWebviewMessage returns only the normalized message fields", () => {
  assert.deepEqual(parseWebviewMessage({
    type: "command",
    command: "refresh",
    value: "",
    arbitrary: "must not cross the boundary",
  }), {
    type: "command",
    command: "refresh",
    value: "",
  });
});

test("parseWebviewMessage validates and normalizes wizard actions", () => {
  assert.deepEqual(parseWebviewMessage({
    type: "wizard",
    action: "configureAndStart",
    requestId: "request-1",
    accessMode: "workspace",
    hosting: {
      kind: "custom-domain",
      publicUrl: "https://mcp.example.test/",
      landingHostname: "Link.Example.Test.",
      ignored: "value",
    },
    secret: "must-not-cross",
  }), {
    type: "wizard",
    action: "configureAndStart",
    requestId: "request-1",
    accessMode: "workspace",
    hosting: {
      kind: "custom-domain",
      publicUrl: "https://mcp.example.test",
      landingHostname: "link.example.test",
    },
  });
  assert.deepEqual(parseWebviewMessage({
    type: "wizard",
    action: "submitCallback",
    requestId: "callback.1",
    callbackUrl: " https://chatgpt.com/callback ",
  }), {
    type: "wizard",
    action: "submitCallback",
    requestId: "callback.1",
    callbackUrl: "https://chatgpt.com/callback",
  });
  assert.deepEqual(parseWebviewMessage({
    type: "wizard",
    action: "copyCredential",
    requestId: "copy:1",
    field: "clientSecret",
  }), {
    type: "wizard",
    action: "copyCredential",
    requestId: "copy:1",
    field: "clientSecret",
  });
  assert.deepEqual(parseWebviewMessage({
    type: "wizard",
    action: "confirmDeveloperMode",
    requestId: "developer-mode-1",
  }), {
    type: "wizard",
    action: "confirmDeveloperMode",
    requestId: "developer-mode-1",
  });
  for (const invalid of [
    { type: "wizard", action: "finish", requestId: "" },
    { type: "wizard", action: "copyCredential", requestId: "1", field: "bootstrapSecret" },
    { type: "wizard", action: "openChatGpt", requestId: "1", destination: "https://evil.test" },
    { type: "wizard", action: "configureAndStart", requestId: "1", accessMode: "root", hosting: { kind: "local" } },
    { type: "wizard", action: "chooseCloudflareCredential", requestId: "1", credentialKind: "inline-token" },
  ]) assert.equal(parseWebviewMessage(invalid), undefined);
});
