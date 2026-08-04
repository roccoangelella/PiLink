import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PiSdkRuntimeAdapter } from "../dist/agents/pi-sdk-adapter.js";

test("Pi SDK adapter starts a real session contract with explicit bounded permissions", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-pi-adapter-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const events = [];
  const prompts = [];
  const factories = [];
  let listener = () => undefined;
  let aborts = 0;
  let disposed = false;
  const session = {
    isStreaming: false,
    async prompt(message) {
      prompts.push(message);
      listener({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Child result" }] },
      });
    },
    async abort() { aborts += 1; },
    async waitForIdle() {},
    dispose() { disposed = true; },
    subscribe(next) { listener = next; return () => { listener = () => undefined; }; },
  };
  const adapter = new PiSdkRuntimeAdapter({
    policy: { workspace, unsafeFullAccess: false, maxBashTimeoutSeconds: 30 },
    providerId: "test-provider",
    modelId: "test-model",
    sessionFactory: async (context) => { factories.push(context); return session; },
  });
  const lifetime = new AbortController();
  const handle = await adapter.spawn({
    agentId: "agent_12345678-1234-4123-8123-123456789abc",
    role: { canonicalRoleId: "researcher", occupancyLabel: "researcher" },
    workspace,
    permissions: ["coordination:read", "workspace:read", "network:outbound"],
    initialMessage: "Inspect the project",
    signal: lifetime.signal,
    report: (event) => events.push(event),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(factories.length, 1);
  assert.deepEqual([...factories[0].permissions], ["coordination:read", "workspace:read", "network:outbound"]);
  assert.match(factories[0].rolePrompt, /Role: researcher/);
  assert.match(prompts[0], /Task:\nInspect the project/);
  assert.ok(events.some((event) => event.type === "output" && event.text === "Child result"));
  assert.ok(events.some((event) => event.type === "status" && event.status === "waiting"));
  assert.equal(events.some((event) => event.type === "completed"), false);
  assert.match(handle.runtimeAgentId, /^pi-/);

  await handle.send({ message: "Continue", signal: lifetime.signal });
  assert.equal(prompts.at(-1), "Continue");
  await handle.cancel({ signal: lifetime.signal });
  await handle.stop({ signal: new AbortController().signal });
  assert.ok(aborts >= 2);
  assert.equal(disposed, true);
});

test("Pi SDK adapter redacts configured and header credentials from provider failures", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-pi-adapter-redaction-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const apiKey = "exact-provider-secret-value";
  const adapter = new PiSdkRuntimeAdapter({
    policy: { workspace, unsafeFullAccess: false, maxBashTimeoutSeconds: 30 },
    providerId: "test-provider",
    modelId: "test-model",
    apiKey,
    sessionFactory: async () => {
      throw new Error(`Provider failed with ${apiKey}; Authorization: Bearer another-secret-token`);
    },
  });
  await assert.rejects(() => adapter.spawn({
    agentId: "agent_12345678-1234-4123-8123-123456789abc",
    role: { canonicalRoleId: "implementer", occupancyLabel: "implementer" },
    workspace,
    permissions: ["workspace:read", "network:outbound"],
    initialMessage: "Start",
    signal: new AbortController().signal,
    report: () => undefined,
  }), (error) => {
    assert.equal(error.message.includes(apiKey), false);
    assert.equal(error.message.includes("another-secret-token"), false);
    assert.match(error.message, /\[REDACTED\]/u);
    return true;
  });
});

test("Pi SDK adapter refuses model access without network permission", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-pi-adapter-deny-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let factoryCalled = false;
  const adapter = new PiSdkRuntimeAdapter({
    policy: { workspace, unsafeFullAccess: false, maxBashTimeoutSeconds: 30 },
    providerId: "test-provider",
    modelId: "test-model",
    sessionFactory: async () => { factoryCalled = true; throw new Error("unexpected"); },
  });
  await assert.rejects(() => adapter.spawn({
    agentId: "agent_12345678-1234-4123-8123-123456789abc",
    role: { canonicalRoleId: "implementer", occupancyLabel: "implementer" },
    workspace,
    permissions: ["workspace:read"],
    initialMessage: "No network",
    signal: new AbortController().signal,
    report: () => undefined,
  }), /network:outbound/);
  assert.equal(factoryCalled, false);
});

test("Pi child-agent bash receives operational variables without inheriting server secrets", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-pi-adapter-env-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let factoryContext;
  const session = {
    isStreaming: false,
    async prompt() {},
    async abort() {},
    async waitForIdle() {},
    dispose() {},
    subscribe() { return () => undefined; },
  };
  const adapter = new PiSdkRuntimeAdapter({
    policy: { workspace, unsafeFullAccess: true, maxBashTimeoutSeconds: 30 },
    providerId: "test-provider",
    modelId: "test-model",
    sessionFactory: async (context) => { factoryContext = context; return session; },
  });
  const handle = await adapter.spawn({
    agentId: "agent_12345678-1234-4123-8123-123456789abc",
    role: { canonicalRoleId: "implementer", occupancyLabel: "implementer" },
    workspace,
    permissions: ["process:execute", "network:outbound"],
    initialMessage: "Wait",
    signal: new AbortController().signal,
    report: () => undefined,
  });
  t.after(() => handle.stop({ signal: new AbortController().signal }));

  const names = ["LC_VSPILINK_CHILD_TEST", "JWT_SECRET", "PI_BOOTSTRAP_SECRET", "ANTHROPIC_API_KEY"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.LC_VSPILINK_CHILD_TEST = "preserved";
  process.env.JWT_SECRET = "child-jwt-secret";
  process.env.PI_BOOTSTRAP_SECRET = "child-bootstrap-secret";
  process.env.ANTHROPIC_API_KEY = "child-provider-key";

  const bash = factoryContext.toolDefinitions.find((tool) => tool.name === "workspace_bash");
  assert.ok(bash);
  const result = await bash.execute(
    "call_env_test",
    {
      command: `node -e "process.stdout.write(JSON.stringify({safe:process.env.LC_VSPILINK_CHILD_TEST,jwt:process.env.JWT_SECRET,bootstrap:process.env.PI_BOOTSTRAP_SECRET,provider:process.env.ANTHROPIC_API_KEY}))"`,
    },
    new AbortController().signal,
  );

  assert.deepEqual(JSON.parse(result.content.find((item) => item.type === "text").text), {
    safe: "preserved",
  });
});
