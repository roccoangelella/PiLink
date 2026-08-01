import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CollaborationSessionStore } from "../dist/collaboration-sessions.js";

const workerPath = fileURLToPath(new URL("fixtures/collaboration-session-worker.mjs", import.meta.url));
const alice = { agentId: "agent-alice", agentName: "Alice" };
const bob = { agentId: "agent-bob", agentName: "Bob" };

async function fixture(prefix = "pilink-collaboration-sessions-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other-workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  await fs.mkdir(otherWorkspace);
  let nowMs = Date.parse("2026-08-01T10:00:00.000Z");
  const now = () => new Date(nowMs);
  return {
    root,
    workspace,
    otherWorkspace,
    dataDir,
    now,
    advance(seconds) { nowMs += seconds * 1_000; },
    store(overrides = {}) {
      return new CollaborationSessionStore({
        workspace,
        dataDir,
        now,
        defaultTtlSeconds: 60,
        resumeGraceSeconds: 120,
        ...overrides,
      });
    },
  };
}

async function runWorker({ workspace, dataDir, agentId, label, readyPath = "", gatePath = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      workerPath,
      workspace,
      dataDir,
      agentId,
      label,
      readyPath,
      gatePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`Collaboration session worker exited with code ${code} signal ${signal || "none"}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Collaboration session worker returned invalid JSON: ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
}

async function waitForFiles(paths, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const present = await Promise.all(paths.map(async (candidate) => {
      try {
        await fs.access(candidate);
        return true;
      } catch {
        return false;
      }
    }));
    if (present.every(Boolean)) return;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for collaboration session workers");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

test("starts a private project-scoped session without persisting its bearer handle", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();

  const credential = await store.start({
    ...alice,
    label: "Dev 1 conversation",
    requestedRoleId: "implementer",
    ttlSeconds: 30,
  });
  assert.match(credential.session.collaborationSessionId, /^cs_[A-Za-z0-9_-]{24}$/);
  assert.match(
    credential.collaborationSessionHandle,
    new RegExp(`^${credential.session.collaborationSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[A-Za-z0-9_-]{43}$`),
  );
  assert.equal(credential.session.status, "active");
  assert.equal(credential.session.agentId, alice.agentId);
  assert.equal(credential.session.requestedRoleId, "implementer");
  assert.equal(credential.session.expiresAt, "2026-08-01T10:00:30.000Z");
  assert.equal(credential.session.resumeUntil, "2026-08-01T10:02:30.000Z");

  const persistedText = await fs.readFile(store.statePath, "utf8");
  const persisted = JSON.parse(persistedText);
  assert.equal(persisted.sessions.length, 1);
  assert.equal(persisted.sessions[0].collaborationSessionId, credential.session.collaborationSessionId);
  assert.match(persisted.sessions[0].credentialHash, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(persistedText.includes(credential.collaborationSessionHandle), false);
  assert.equal(persistedText.includes(credential.collaborationSessionHandle.split(".")[1]), false);
  assert.equal((await fs.stat(store.statePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(store.statePath))).mode & 0o777, 0o700);

  const separateProject = new CollaborationSessionStore({
    workspace: value.otherWorkspace,
    dataDir: value.dataDir,
    now: value.now,
  });
  assert.deepEqual(await separateProject.listByActor(alice.agentId), []);
});

test("binds handles to one OAuth actor and survives store or transport replacement", async (t) => {
  const value = await fixture("pilink-collaboration-session-binding-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const created = await value.store().start({ ...alice, label: "Stable logical run" });
  const replacementStore = value.store();

  const authenticated = await replacementStore.authenticate({
    agentId: alice.agentId,
    collaborationSessionHandle: created.collaborationSessionHandle,
  });
  assert.equal(authenticated.collaborationSessionId, created.session.collaborationSessionId);
  assert.equal(authenticated.revision, 2);
  assert.equal((await replacementStore.listByActor(alice.agentId))[0].collaborationSessionId, created.session.collaborationSessionId);

  await assert.rejects(
    replacementStore.authenticate({
      agentId: bob.agentId,
      collaborationSessionHandle: created.collaborationSessionHandle,
    }),
    /different OAuth actor/,
  );
  await assert.rejects(
    replacementStore.authenticate({
      agentId: alice.agentId,
      collaborationSessionHandle: `${created.session.collaborationSessionId}.${"A".repeat(43)}`,
    }),
    /Invalid collaboration session handle/,
  );
});

test("expires, resumes, and rotates the bearer handle with bounded recovery", async (t) => {
  const value = await fixture("pilink-collaboration-session-resume-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();
  const created = await store.start({ ...alice, ttlSeconds: 10 });

  value.advance(11);
  await assert.rejects(
    store.authenticate({
      agentId: alice.agentId,
      collaborationSessionHandle: created.collaborationSessionHandle,
    }),
    /expired; resume it/,
  );
  const expired = await store.inspect({
    agentId: alice.agentId,
    collaborationSessionHandle: created.collaborationSessionHandle,
  });
  assert.equal(expired.status, "expired");

  const resumed = await store.resume({
    ...alice,
    collaborationSessionHandle: created.collaborationSessionHandle,
    ttlSeconds: 20,
  });
  assert.equal(resumed.session.collaborationSessionId, created.session.collaborationSessionId);
  assert.equal(resumed.session.status, "active");
  assert.notEqual(resumed.collaborationSessionHandle, created.collaborationSessionHandle);
  await assert.rejects(
    store.authenticate({
      agentId: alice.agentId,
      collaborationSessionHandle: created.collaborationSessionHandle,
    }),
    /Invalid collaboration session handle/,
  );
  assert.equal((await store.authenticate({
    agentId: alice.agentId,
    collaborationSessionHandle: resumed.collaborationSessionHandle,
  })).status, "active");

  value.advance(141);
  await assert.rejects(
    store.resume({
      ...alice,
      collaborationSessionHandle: resumed.collaborationSessionHandle,
    }),
    /expired beyond its resume window/,
  );
});

test("released and revoked sessions fail closed with recovery guidance", async (t) => {
  const value = await fixture("pilink-collaboration-session-terminal-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();

  const releasable = await store.start({ ...alice, label: "Release me" });
  const released = await store.release({
    agentId: alice.agentId,
    collaborationSessionHandle: releasable.collaborationSessionHandle,
  });
  assert.equal(released.status, "released");
  await assert.rejects(
    store.authenticate({
      agentId: alice.agentId,
      collaborationSessionHandle: releasable.collaborationSessionHandle,
    }),
    /was released; start a new session/,
  );
  await assert.rejects(
    store.resume({
      ...alice,
      collaborationSessionHandle: releasable.collaborationSessionHandle,
    }),
    /was released; start a new session/,
  );

  const revocable = await store.start({ ...alice, label: "Revoke me" });
  const revoked = await store.revoke(revocable.session.collaborationSessionId);
  assert.equal(revoked.status, "revoked");
  await assert.rejects(
    store.authenticate({
      agentId: alice.agentId,
      collaborationSessionHandle: revocable.collaborationSessionHandle,
    }),
    /was revoked; start a new session/,
  );
  await assert.rejects(
    store.release({
      agentId: alice.agentId,
      collaborationSessionHandle: revocable.collaborationSessionHandle,
    }),
    /is revoked/,
  );
});

test("serializes synchronized session creation across PiLink processes", async (t) => {
  const value = await fixture("pilink-collaboration-session-process-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const gatePath = path.join(value.root, "start-workers");
  const workerCount = 8;
  const readyPaths = Array.from({ length: workerCount }, (_, index) => path.join(value.root, `ready-${index}`));
  const workers = readyPaths.map((readyPath, index) => runWorker({
    workspace: value.workspace,
    dataDir: value.dataDir,
    agentId: `agent-${index}`,
    label: `Process session ${index}`,
    readyPath,
    gatePath,
  }));

  await waitForFiles(readyPaths);
  await fs.writeFile(gatePath, "go\n", { mode: 0o600 });
  const credentials = await Promise.all(workers);
  assert.equal(new Set(credentials.map((entry) => entry.session.collaborationSessionId)).size, workerCount);

  const store = value.store();
  const persisted = JSON.parse(await fs.readFile(store.statePath, "utf8"));
  assert.equal(persisted.sessions.length, workerCount);
  assert.deepEqual(
    new Set(persisted.sessions.map((session) => session.label)),
    new Set(Array.from({ length: workerCount }, (_, index) => `Process session ${index}`)),
  );
  await assert.rejects(fs.access(`${store.statePath}.lock`), /ENOENT/);
});

test("recovers an old collaboration-session lock only after its recorded process exits", async (t) => {
  const value = await fixture("pilink-collaboration-session-lock-dead-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();
  const lockPath = `${store.statePath}.lock`;
  const deadPid = await exitedChildPid();
  await writeOldLock(lockPath, `${deadPid}:${"e".repeat(32)}`);

  assert.deepEqual(await store.listByActor(alice.agentId), []);
  await assert.rejects(fs.access(lockPath), /ENOENT/);
});

test("old live or ambiguous collaboration-session locks fail safe", async (t) => {
  const live = await fixture("pilink-collaboration-session-lock-live-");
  const malformed = await fixture("pilink-collaboration-session-lock-malformed-");
  t.after(() => Promise.all([
    fs.rm(live.root, { recursive: true, force: true }),
    fs.rm(malformed.root, { recursive: true, force: true }),
  ]));
  const liveStore = live.store();
  const malformedStore = malformed.store();
  const liveLockPath = `${liveStore.statePath}.lock`;
  const malformedLockPath = `${malformedStore.statePath}.lock`;
  await writeOldLock(liveLockPath, `${process.pid}:${"f".repeat(32)}`);
  await writeOldLock(malformedLockPath, "ambiguous-owner");

  const results = await Promise.allSettled([
    liveStore.listByActor(alice.agentId),
    malformedStore.listByActor(alice.agentId),
  ]);
  assert.equal(results.every((result) => result.status === "rejected"), true);
  for (const result of results) {
    assert.match(result.reason.message, /Timed out waiting for the collaboration session store lock/);
  }
  assert.equal((await fs.readFile(liveLockPath, "utf8")).trim(), `${process.pid}:${"f".repeat(32)}`);
  assert.equal((await fs.readFile(malformedLockPath, "utf8")).trim(), "ambiguous-owner");
});

test("validates storage boundaries and retries repaired malformed state", async (t) => {
  const value = await fixture("pilink-collaboration-session-recovery-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  assert.throws(
    () => new CollaborationSessionStore({
      workspace: value.workspace,
      dataDir: path.join(value.workspace, "private"),
    }),
    /must not be stored under the workspace/,
  );

  const store = value.store();
  await fs.mkdir(path.dirname(store.statePath), { recursive: true });
  await fs.writeFile(store.statePath, "not-json\n");
  await assert.rejects(store.listByActor(alice.agentId), /invalid JSON/);
  await fs.writeFile(store.statePath, JSON.stringify({ version: 1, projectKey: store.projectKey, sessions: [] }));
  assert.deepEqual(await store.listByActor(alice.agentId), []);
  await assert.rejects(
    store.inspect({ agentId: alice.agentId, collaborationSessionHandle: "not-a-handle" }),
    /Invalid collaboration session handle format/,
  );
});
