import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AgentAuthSidecar } from "../src/agent-auth.js";

test("agent auth catalog omits the private agent directory and normalizes providers", async (t) => {
  const fixture = await fakeAgentAuthCli(t);
  const service = new AgentAuthSidecar();
  t.after(() => service.dispose());
  const catalog = await service.catalog(fixture.options);

  assert.deepEqual(catalog, {
    providers: [{
      id: "openai-codex",
      name: "OpenAI Codex",
      authTypes: ["oauth", "api_key"],
      configuredAuthType: "oauth",
      models: [{
        id: "gpt-test",
        name: "GPT Test",
        providerId: "openai-codex",
        reasoning: true,
        contextWindow: 128000,
      }],
    }],
  });
  assert.equal(JSON.stringify(catalog).includes("private-agent-dir"), false);
});

test("agent login sends secrets only as prompt responses over stdin", async (t) => {
  const fixture = await fakeAgentAuthCli(t);
  const service = new AgentAuthSidecar();
  t.after(() => service.dispose());
  const secret = "api-key-only-on-stdin";
  const prompts: string[] = [];

  await service.login(fixture.options, "openai-codex", "api_key", undefined, {
    prompt: async (prompt) => {
      prompts.push(prompt.kind);
      return secret;
    },
    notify: async () => undefined,
  });

  assert.deepEqual(prompts, ["secret"]);
});

test("agent auth rejects unknown or post-completion protocol messages", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-agent-auth-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cliPath = path.join(root, "invalid.mjs");
  await fs.writeFile(cliPath, `
const emit = (value) => process.stdout.write(JSON.stringify({ protocol: "vspilink-agent-auth-v1", ...value }) + "\\n");
emit({ type: "ready", command: "login", providerId: "openai-codex", authType: "oauth" });
emit({ type: "unexpected" });
emit({ type: "complete", command: "login", result: { providerId: "openai-codex", authType: "oauth", configured: true } });
`, { mode: 0o700 });
  const service = new AgentAuthSidecar();
  t.after(() => service.dispose());
  await assert.rejects(() => service.login({
    nodeExecutable: process.execPath,
    cliPath,
    cwd: root,
    configPath: path.join(root, ".env"),
  }, "openai-codex", "oauth", "browser", {
    prompt: async () => undefined,
    notify: async () => undefined,
  }), /agent-auth message type is not allowed/i);
});

test("agent auth rejects a completion for a different provider", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-agent-auth-mismatch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cliPath = path.join(root, "mismatch.mjs");
  await fs.writeFile(cliPath, `
const emit = (value) => process.stdout.write(JSON.stringify({ protocol: "vspilink-agent-auth-v1", ...value }) + "\\n");
emit({ type: "ready", command: "login", providerId: "openai-codex", authType: "oauth" });
emit({ type: "complete", command: "login", result: { providerId: "wrong-provider", authType: "oauth", configured: true } });
`, { mode: 0o700 });
  const service = new AgentAuthSidecar();
  t.after(() => service.dispose());
  await assert.rejects(() => service.login({
    nodeExecutable: process.execPath,
    cliPath,
    cwd: root,
    configPath: path.join(root, ".env"),
  }, "openai-codex", "oauth", "browser", {
    prompt: async () => undefined,
    notify: async () => undefined,
  }), /invalid agent-auth sign-in completion message/i);
});

async function fakeAgentAuthCli(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-agent-auth-ui-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cliPath = path.join(root, "fake-agent-auth.mjs");
  await fs.writeFile(cliPath, `
import readline from "node:readline";
const protocol = "vspilink-agent-auth-v1";
const emit = (value) => process.stdout.write(JSON.stringify({ protocol, ...value }) + "\\n");
if (process.argv.includes("api-key-only-on-stdin") || Object.values(process.env).includes("api-key-only-on-stdin")) process.exit(90);
if (process.argv.includes("catalog")) {
  emit({ type: "result", command: "catalog", catalog: { agentDir: "/private-agent-dir", providers: [{
    id: "openai-codex", name: "OpenAI Codex", authTypes: ["oauth", "api_key"], configuredAuthType: "oauth",
    models: [{ id: "gpt-test", name: "GPT Test", providerId: "openai-codex", reasoning: true, contextWindow: 128000 }]
  }] } });
} else {
  emit({ type: "ready", command: "login", providerId: "openai-codex", authType: "api_key" });
  emit({ type: "prompt", prompt: { promptId: "prompt-1", kind: "secret", message: "API key" } });
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  input.once("line", (line) => {
    const message = JSON.parse(line);
    if (message.value !== "api-key-only-on-stdin") process.exit(91);
    emit({ type: "complete", command: "login", result: { providerId: "openai-codex", authType: "api_key", configured: true, models: [] } });
    input.close();
    setImmediate(() => process.exit(0));
  });
}
`, { mode: 0o700 });
  return {
    options: {
      nodeExecutable: process.execPath,
      cliPath,
      cwd: root,
      configPath: path.join(root, ".env"),
    },
  };
}
