import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig } from "../dist/config.js";
import { createHarnessPolicy, isToolAllowed, sanitizeToolArguments } from "../dist/harness.js";

function config(workspace, unsafeFullAccess = false, allowWorkspaceExecution = false) {
  return {
    workspace,
    unsafeFullAccess,
    allowWorkspaceExecution,
    maxBashTimeoutSeconds: 30,
  };
}

test("workspace policy rejects traversal and symlink escapes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(workspace, "escape"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const policy = createHarnessPolicy(config(workspace));

  await assert.rejects(sanitizeToolArguments(policy, "read", { path: "../outside/file.txt" }), /escapes/);
  await assert.rejects(sanitizeToolArguments(policy, "read", { path: "escape/file.txt" }), /escapes/);
  const safe = await sanitizeToolArguments(policy, "write", { path: "nested/file.txt", content: "ok" });
  assert.equal(safe.path, path.join(workspace, "nested/file.txt"));
});

test("workspace policy forbids bash while explicit unsafe mode clamps its timeout", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-"));
  try {
    await assert.rejects(sanitizeToolArguments(createHarnessPolicy(config(workspace)), "bash", { command: "pwd" }), /disabled/);
    const unsafe = await sanitizeToolArguments(createHarnessPolicy(config(workspace, true)), "bash", { command: "pwd", timeout: 999 });
    assert.equal(unsafe.timeout, 30);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("tool scopes separate read-only and write capabilities", () => {
  assert.equal(isToolAllowed("mcp:read", "read"), true);
  assert.equal(isToolAllowed("mcp:read", "write"), false);
  assert.equal(isToolAllowed("mcp:read", "run"), false);
  assert.equal(isToolAllowed("mcp:write", "run"), true);
  assert.equal(isToolAllowed("mcp:write", "bash"), true);
  assert.equal(isToolAllowed("mcp:tools", "edit"), true);
});

test("runtime configuration propagates the workspace execution opt-in", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-"));
  try {
    const runtime = loadRuntimeConfig({
      PI_WORK_DIR: workspace,
      PILINK_CONFIG: path.join(workspace, "pilink.env"),
      JWT_SECRET: "j".repeat(32),
      PI_BOOTSTRAP_SECRET: "b".repeat(32),
      PI_ALLOW_WORKSPACE_EXECUTION: "true",
    });
    assert.equal(runtime.allowWorkspaceExecution, true);
    assert.equal(createHarnessPolicy(runtime).allowWorkspaceExecution, true);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
