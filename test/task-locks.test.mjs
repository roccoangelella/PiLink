import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentTaskStore } from "../dist/tasks.js";

async function fixture(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  const store = new AgentTaskStore({ workspace, dataDir });
  return { root, store, lockPath: `${store.statePath}.lock` };
}

async function writeOldLock(lockPath, owner) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, `${owner}\n`, { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, old, old);
}

async function exitedChildPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`PID fixture exited with code ${code} signal ${signal || "none"}`));
        return;
      }
      resolve(pid);
    });
  });
}

test("recovers an old task-store lock only after its recorded process exits", async (t) => {
  const value = await fixture("pilink-task-lock-dead-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const deadPid = await exitedChildPid();
  await writeOldLock(value.lockPath, `${deadPid}:${"a".repeat(32)}`);

  assert.deepEqual(await value.store.list(), []);
  await assert.rejects(fs.access(value.lockPath), /ENOENT/);
});

test("old live or ambiguous task-store locks fail safe instead of being deleted", async (t) => {
  const live = await fixture("pilink-task-lock-live-");
  const malformed = await fixture("pilink-task-lock-malformed-");
  t.after(() => Promise.all([
    fs.rm(live.root, { recursive: true, force: true }),
    fs.rm(malformed.root, { recursive: true, force: true }),
  ]));
  await writeOldLock(live.lockPath, `${process.pid}:${"b".repeat(32)}`);
  await writeOldLock(malformed.lockPath, "ambiguous-owner");

  const startedAt = Date.now();
  const results = await Promise.allSettled([live.store.list(), malformed.store.list()]);
  assert.equal(results.every((result) => result.status === "rejected"), true);
  for (const result of results) {
    assert.match(result.reason.message, /Timed out waiting for the agent task store lock/);
  }
  assert.ok(Date.now() - startedAt >= 4_500);
  assert.equal((await fs.readFile(live.lockPath, "utf8")).trim(), `${process.pid}:${"b".repeat(32)}`);
  assert.equal((await fs.readFile(malformed.lockPath, "utf8")).trim(), "ambiguous-owner");
});
