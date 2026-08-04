import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectAgentAuth,
  loginAgentProvider,
  logoutAgentProvider,
} from "../dist/agents/auth-service.js";

test("agent auth catalog is offline, bounded, and credential-blind", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-agent-auth-"));
  const agentDir = path.join(root, "agent");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const catalog = await inspectAgentAuth(agentDir);
  assert.equal(catalog.agentDir, agentDir);
  const codex = catalog.providers.find((provider) => provider.id === "openai-codex");
  assert.ok(codex);
  assert.ok(codex.authTypes.includes("oauth"));
  assert.ok(codex.models.length > 0);
  assert.equal(codex.models.every((model) => model.providerId === "openai-codex"), true);
  assert.doesNotMatch(JSON.stringify(catalog), /access|refresh|accountId|apiKey|baseUrl/i);

  if (process.platform !== "win32") {
    assert.equal((await fs.stat(agentDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(agentDir, "auth.json"))).mode & 0o777, 0o600);
  }
});

test("agent auth operations reject untrusted provider input before interaction", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-agent-auth-deny-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let prompted = false;
  const interaction = {
    prompt: async () => { prompted = true; return ""; },
    notify: () => undefined,
  };

  await assert.rejects(
    loginAgentProvider({ providerId: "../../bad", authType: "oauth", interaction, agentDir: root }),
    /provider id/i,
  );
  assert.equal(prompted, false);
  await assert.rejects(logoutAgentProvider("../../bad", root), /provider id/i);
});

test("agent auth rejects an insecure pre-existing credential file before runtime access", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-agent-auth-mode-"));
  const agentDir = path.join(root, "agent");
  const authPath = path.join(agentDir, "auth.json");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(agentDir, { mode: 0o700 });
  await fs.writeFile(authPath, "{}\n", { mode: 0o644 });

  await assert.rejects(inspectAgentAuth(agentDir), /mode 0600/i);
  assert.equal((await fs.lstat(authPath)).mode & 0o777, 0o644);
  assert.equal(await fs.readFile(authPath, "utf8"), "{}\n");
});

test("agent auth rejects a symbolic-link credential store without touching its target", { skip: process.platform === "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-agent-auth-symlink-"));
  const agentDir = path.join(root, "agent");
  const target = path.join(root, "target.json");
  const authPath = path.join(agentDir, "auth.json");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(agentDir, { mode: 0o700 });
  await fs.writeFile(target, "{\"sentinel\":true}\n", { mode: 0o600 });
  await fs.symlink(target, authPath);

  await assert.rejects(inspectAgentAuth(agentDir), /symbolic link|regular file/i);
  assert.equal(await fs.readFile(target, "utf8"), "{\"sentinel\":true}\n");
  assert.equal((await fs.lstat(authPath)).isSymbolicLink(), true);
});
