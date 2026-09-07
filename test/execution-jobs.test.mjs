import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { ExecutionJobStore } from "../dist/execution-jobs.js";

const execFileAsync = promisify(execFile);

function shellNode(source) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

function fullAccessPolicy(workspace) {
  return {
    workspace,
    workingDirectory: workspace,
    unsafeFullAccess: true,
    allowWorkspaceExecution: true,
    requireExecutionApproval: false,
  };
}

test("durable execution jobs outlive the originating call and persist status/output", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-exec-job-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  await fs.mkdir(dataDir);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const store = new ExecutionJobStore({ workspace, dataDir });
  const started = await store.start(fullAccessPolicy(workspace), {
    ownerId: "pi_1111111111111111",
    ownerName: "Owner",
    label: "long-test",
    command: shellNode("setTimeout(() => { console.log('job-out'); console.error('job-err'); }, 150)"),
  });
  assert.match(started.jobId, /^exec_[0-9a-f-]{36}$/u);
  assert.equal(started.status, "running");
  assert.equal(started.cwd, await fs.realpath(workspace));

  const recovered = new ExecutionJobStore({ workspace, dataDir });
  const completed = await recovered.wait("pi_1111111111111111", started.jobId, 5);
  assert.equal(completed.status, "completed");
  assert.equal(completed.exitCode, 0);
  assert.ok(completed.stdoutBytes > 0);
  assert.ok(completed.stderrBytes > 0);

  const stdout = await recovered.output("pi_1111111111111111", started.jobId, "stdout", 0, 1024);
  const stderr = await recovered.output("pi_1111111111111111", started.jobId, "stderr", 0, 1024);
  assert.match(stdout.text, /job-out/);
  assert.match(stderr.text, /job-err/);
  assert.equal(stdout.eof, true);
  assert.equal(stderr.eof, true);

  await assert.rejects(
    recovered.status("pi_2222222222222222", started.jobId),
    /not owned by this OAuth client/,
  );
});

test("detached worker survives the PiLink process that launched it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-exec-parent-exit-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  await fs.mkdir(dataDir);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const moduleUrl = pathToFileURL(path.resolve("dist/execution-jobs.js")).href;
  const command = shellNode("setTimeout(() => console.log('survived-parent'), 300)");
  const launcher = `
    import { ExecutionJobStore } from ${JSON.stringify(moduleUrl)};
    const [workspace, dataDir, command] = process.argv.slice(1);
    const store = new ExecutionJobStore({ workspace, dataDir });
    const job = await store.start({ workspace, workingDirectory: workspace, unsafeFullAccess: true }, {
      ownerId: "pi_1111111111111111",
      ownerName: "Owner",
      command,
    });
    process.stdout.write(JSON.stringify(job));
  `;
  const launched = await execFileAsync(process.execPath, ["--input-type=module", "-e", launcher, workspace, dataDir, command], {
    cwd: workspace,
  });
  const started = JSON.parse(launched.stdout);
  const store = new ExecutionJobStore({ workspace, dataDir });
  const finished = await store.wait("pi_1111111111111111", started.jobId, 5);
  assert.equal(finished.status, "completed");
  assert.match((await store.tail("pi_1111111111111111", started.jobId, 1024)).stdout, /survived-parent/);
});

test("durable execution cancellation targets the detached job and remains durable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-exec-cancel-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  await fs.mkdir(dataDir);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const store = new ExecutionJobStore({ workspace, dataDir });
  const started = await store.start(fullAccessPolicy(workspace), {
    ownerId: "pi_1111111111111111",
    ownerName: "Owner",
    command: shellNode("setInterval(() => console.log('tick'), 50)"),
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const cancelled = await store.cancel("pi_1111111111111111", started.jobId);
  assert.equal(cancelled.status, "cancelled");
  const recovered = new ExecutionJobStore({ workspace, dataDir });
  assert.equal((await recovered.status("pi_1111111111111111", started.jobId)).status, "cancelled");
});

test("durable execution is unavailable outside explicit full-access mode", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-exec-safe-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  await fs.mkdir(dataDir);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ExecutionJobStore({ workspace, dataDir });
  await assert.rejects(store.start({ workspace, unsafeFullAccess: false }, {
    ownerId: "pi_1111111111111111",
    ownerName: "Owner",
    command: "echo no",
  }), /require explicit full-access mode/);
});
