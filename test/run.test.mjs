import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { executeRunProfile } from "../dist/run.js";

const execFileAsync = promisify(execFile);

function policy(workspace, allowWorkspaceExecution = false) {
  return {
    workspace,
    unsafeFullAccess: false,
    allowWorkspaceExecution,
    maxBashTimeoutSeconds: 10,
  };
}

async function initializeRepository(workspace) {
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await fs.writeFile(path.join(workspace, "tracked.txt"), "before\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: workspace });
  await execFileAsync("git", [
    "-c", "user.name=PiLink Test",
    "-c", "user.email=pilink@example.invalid",
    "commit", "--quiet", "-m", "initial",
  ], { cwd: workspace });
}

test("read-only git profiles inspect only the configured workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-run-git-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initializeRepository(workspace);
  await fs.writeFile(path.join(workspace, "tracked.txt"), "after\n");
  await fs.writeFile(path.join(workspace, "untracked.txt"), "new\n");

  const status = await executeRunProfile(policy(workspace), { profile: "git_status" });
  assert.equal(status.exitCode, 0);
  assert.equal(status.timedOut, false);
  assert.equal(status.cancelled, false);
  assert.match(status.stdout, / M tracked\.txt/);
  assert.match(status.stdout, /\?\? untracked\.txt/);
  assert.deepEqual(status.command.slice(0, 2), ["git", "--no-pager"]);

  const diff = await executeRunProfile(policy(workspace), {
    profile: "git_diff",
    paths: ["tracked.txt"],
  });
  assert.equal(diff.exitCode, 0);
  assert.match(diff.stdout, /\+after/);
  assert.doesNotMatch(diff.stdout, /untracked/);

  const log = await executeRunProfile(policy(workspace), { profile: "git_log", maxCount: 1 });
  assert.equal(log.exitCode, 0);
  assert.match(log.stdout, /initial/);

  const pathLog = await executeRunProfile(policy(workspace), {
    profile: "git_log",
    paths: ["tracked.txt"],
    maxCount: 1,
  });
  assert.equal(pathLog.exitCode, 0);
  assert.match(pathLog.stdout, /initial/);

  const ignoredMaxCount = await executeRunProfile(policy(workspace), {
    profile: "git_status",
    maxCount: 99,
  });
  assert.equal(ignoredMaxCount.exitCode, 0);

  await assert.rejects(
    executeRunProfile(policy(workspace), { profile: "git_diff", paths: ["../outside.txt"] }),
    /escapes/,
  );
});

test("workspace execution is explicit and does not inherit PiLink secrets", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-run-npm-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "pilink-run-test",
    version: "1.0.0",
    scripts: {
      build: "node -e \"require('node:fs').writeFileSync('built.txt', process.env.JWT_SECRET || 'clean')\"",
      test: "node -e \"process.stdout.write('x'.repeat(70000))\"",
    },
  }));

  await assert.rejects(
    executeRunProfile(policy(workspace), { profile: "npm_build" }),
    /PI_ALLOW_WORKSPACE_EXECUTION/,
  );

  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "must-not-reach-workspace-code";
  try {
    const build = await executeRunProfile(policy(workspace, true), { profile: "npm_build" });
    assert.equal(build.exitCode, 0);
    assert.equal(await fs.readFile(path.join(workspace, "built.txt"), "utf8"), "clean");

    const noisy = await executeRunProfile(policy(workspace, true), { profile: "npm_test" });
    assert.equal(noisy.exitCode, 0);
    assert.equal(noisy.truncated, true);
    assert.match(noisy.stdout, /^\[Earlier output truncated/);
    assert.ok(Buffer.byteLength(noisy.stdout, "utf8") < 66 * 1024);
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

test("cancellation during command resolution prevents process creation", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-run-cancel-before-spawn-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "pilink-run-cancel-before-spawn-test",
    version: "1.0.0",
    scripts: { test: "node -e \"require('node:fs').writeFileSync('should-not-exist.txt', 'bad')\"" },
  }));

  const controller = new AbortController();
  const execution = executeRunProfile(policy(workspace, true), { profile: "npm_test" }, controller.signal);
  controller.abort();
  await assert.rejects(execution, /cancelled before process creation/);
  await assert.rejects(fs.access(path.join(workspace, "should-not-exist.txt")));
});

test("cancellation terminates a workspace execution profile", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-run-cancel-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "pilink-run-cancel-test",
    version: "1.0.0",
    scripts: {
      test: "node -e \"setInterval(() => {}, 1000)\"",
    },
  }));

  const controller = new AbortController();
  const execution = executeRunProfile(
    policy(workspace, true),
    { profile: "npm_test", timeout: 10 },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 100).unref();
  const result = await execution;

  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.notEqual(result.signal, null);
  assert.ok(result.durationMs < 3_000);
});
