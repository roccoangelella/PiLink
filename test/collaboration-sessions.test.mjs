import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CollaborationSessionStore } from "../dist/collaboration-sessions.js";
import {
  classifyRuntimeOwnerLiveness,
  parseLinuxProcessStatStartTime,
  validateLocalRuntimeOwnerForPlatform,
} from "../dist/runtime-owner.js";
import {
  createNewCollaborationRoleAssignment,
  resolveCollaborationRoleRequest,
} from "../dist/collaboration-roles.js";

const startWorkerPath = fileURLToPath(new URL("fixtures/collaboration-session-worker.mjs", import.meta.url));
const handleWorkerPath = fileURLToPath(new URL("fixtures/collaboration-session-handle-worker.mjs", import.meta.url));
const orphanWorkerPath = fileURLToPath(new URL("fixtures/collaboration-session-orphan-worker.mjs", import.meta.url));
const credentialKey = Object.freeze({
  keyId: "test-key-v1",
  keyMaterial: Buffer.alloc(32, 0x5a).toString("base64url"),
});
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
    nowIso() { return new Date(nowMs).toISOString(); },
    advance(seconds) { nowMs += seconds * 1_000; },
    store(overrides = {}) {
      return new CollaborationSessionStore({
        workspace,
        dataDir,
        now,
        defaultTtlSeconds: 60,
        resumeGraceSeconds: 120,
        resumeRecoverySeconds: 30,
        touchIntervalSeconds: 60,
        credentialKey,
        ...overrides,
      });
    },
  };
}

async function spawnJson(workerPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code} signal ${signal || "none"}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Worker returned invalid JSON: ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
}

function runStartWorker({ workspace, dataDir, agentId, label, readyPath = "", gatePath = "" }) {
  return spawnJson(startWorkerPath, [
    workspace,
    dataDir,
    credentialKey.keyId,
    credentialKey.keyMaterial,
    agentId,
    label,
    readyPath,
    gatePath,
  ]);
}

function runHandleWorker({
  action,
  workspace,
  dataDir,
  agentId,
  agentName,
  collaborationSessionHandle,
  nowIso,
}) {
  return spawnJson(handleWorkerPath, [
    action,
    workspace,
    dataDir,
    credentialKey.keyId,
    credentialKey.keyMaterial,
    agentId,
    agentName,
    collaborationSessionHandle,
    nowIso,
  ]);
}

function spawnOrphanOwner({ workspace, dataDir, agentId, count, readyPath, nowIso }) {
  const child = spawn(process.execPath, [
    orphanWorkerPath,
    workspace,
    dataDir,
    credentialKey.keyId,
    credentialKey.keyMaterial,
    agentId,
    String(count),
    readyPath,
    nowIso,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return {
    child,
    diagnostics() { return stderr; },
  };
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

function collaborationStateKeyBindingMac(projectKey, stateVersion) {
  return createHmac("sha256", Buffer.from(credentialKey.keyMaterial, "base64url"))
    .update("pilink/collaboration-session/state-key-binding/v1", "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify([credentialKey.keyId, projectKey, `state-version:${stateVersion}`]), "utf8")
    .digest("base64url");
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

test("parses Linux process starttime after complex command names", () => {
  const suffix = [
    "S",
    ...Array.from({ length: 18 }, (_, index) => String(index + 4)),
    "424242",
    "99",
  ];
  assert.equal(
    parseLinuxProcessStatStartTime(`123 (worker ) with spaces)) ${suffix.join(" ")}`),
    "424242",
  );
  assert.equal(parseLinuxProcessStatStartTime("123 malformed stat"), undefined);
  assert.equal(parseLinuxProcessStatStartTime("123 (short) S 1 2"), undefined);
});

test("requires a validated server key and persists only versioned HMAC verifiers", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  assert.throws(
    () => new CollaborationSessionStore({ workspace: value.workspace, dataDir: value.dataDir }),
    /credentialKey must be provided explicitly/,
  );
  assert.throws(
    () => value.store({ credentialKey: { keyId: "bad key", keyMaterial: "not-base64url" } }),
    /credentialKey\.keyId|keyMaterial/,
  );

  const store = value.store();
  const resolvedRole = resolveCollaborationRoleRequest("Software Engineer 1");
  assert.equal(resolvedRole.kind, "recognized");
  const roleAssignment = createNewCollaborationRoleAssignment({
    assignmentSource: "server_session_policy",
    canonicalRoleId: resolvedRole.canonicalRoleId,
    occupancyLabel: resolvedRole.occupancyLabel,
  });
  const credential = await store.start({
    ...alice,
    label: "Dev 1 conversation",
    roleBinding: {
      requestKind: resolvedRole.kind,
      requestedRoleFingerprint: resolvedRole.requestedRoleFingerprint,
      roleAssignment,
    },
    ttlSeconds: 30,
  });
  assert.match(credential.session.collaborationSessionId, /^cs_[A-Za-z0-9_-]{24}$/);
  assert.match(credential.collaborationSessionHandle, /^cs_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(credential.session.status, "active");
  assert.equal(credential.session.requestKind, "recognized");
  assert.equal(credential.session.requestedRoleFingerprint, resolvedRole.requestedRoleFingerprint);
  assert.equal(credential.session.assignedRoleId, "implementer");
  assert.equal(credential.session.occupancyLabel, "dev1");
  assert.equal(credential.session.roleContractId, "pilink-collaboration/implementer");
  assert.equal(credential.session.roleContractVersion, "1.1.0");
  assert.equal(credential.session.credentialGeneration, 1);
  assert.equal(credential.session.expiresAt, "2026-08-01T10:00:30.000Z");
  assert.equal(credential.session.resumeUntil, "2026-08-01T10:02:30.000Z");
  assert.equal(Object.hasOwn(credential.session, "credentialVerifier"), false);
  assert.equal(Object.hasOwn(credential.session, "resumeRecovery"), false);
  assert.equal(Object.hasOwn(credential.session, "requestedRoleId"), false);
  assert.equal(Object.hasOwn(credential.session, "requestedRoleLabel"), false);
  assert.equal(Object.hasOwn(credential.session, "runtimeOwner"), false);

  const persistedText = await fs.readFile(store.statePath, "utf8");
  const persisted = JSON.parse(persistedText);
  assert.equal(persisted.version, 3);
  assert.deepEqual(persisted.credentialKeyBinding, {
    version: 1,
    keyId: credentialKey.keyId,
    mac: persisted.credentialKeyBinding.mac,
  });
  assert.match(persisted.credentialKeyBinding.mac, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(persisted.sessions.length, 1);
  assert.deepEqual(persisted.sessions[0].credentialVerifier, {
    version: 1,
    keyId: credentialKey.keyId,
    generation: 1,
    mac: persisted.sessions[0].credentialVerifier.mac,
  });
  assert.match(persisted.sessions[0].credentialVerifier.mac, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.hasOwn(persisted.sessions[0], "credentialHash"), false);
  assert.deepEqual(persisted.sessions[0].runtimeOwner, {
    version: 1,
    runtimeInstanceId: persisted.sessions[0].runtimeOwner.runtimeInstanceId,
    pid: process.pid,
    bootId: persisted.sessions[0].runtimeOwner.bootId,
    processStartMarker: persisted.sessions[0].runtimeOwner.processStartMarker,
  });
  if (process.platform === "linux") {
    assert.match(persisted.sessions[0].runtimeOwner.bootId, /^[0-9a-f-]{36}$/);
    assert.match(persisted.sessions[0].runtimeOwner.processStartMarker, /^[0-9]+$/);
  }
  assert.match(persisted.sessions[0].runtimeOwner.runtimeInstanceId, /^[0-9a-f]{32}$/);
  assert.equal(persistedText.includes(credential.collaborationSessionHandle), false);
  assert.equal(persistedText.includes(credential.collaborationSessionHandle.split(".")[1]), false);
  assert.equal(persistedText.includes(credentialKey.keyMaterial), false);
  assert.equal(persistedText.includes("Software Engineer 1"), false);
  assert.equal((await fs.stat(store.statePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(store.statePath))).mode & 0o777, 0o700);

  const separateProject = new CollaborationSessionStore({
    workspace: value.otherWorkspace,
    dataDir: value.dataDir,
    now: value.now,
    credentialKey,
  });
  assert.deepEqual(await separateProject.listByActor(alice.agentId), []);

  const wrongKeyId = value.store({
    credentialKey: { keyId: "other-key-v1", keyMaterial: credentialKey.keyMaterial },
  });
  await assert.rejects(wrongKeyId.listByActor(alice.agentId), /key ID does not match/);

  const stateBeforeWrongMaterial = await fs.readFile(store.statePath, "utf8");
  const wrongMaterial = value.store({
    credentialKey: { keyId: credentialKey.keyId, keyMaterial: Buffer.alloc(32, 0x33).toString("base64url") },
  });
  await assert.rejects(
    wrongMaterial.listByActor(alice.agentId),
    /key material does not match persisted state/,
  );
  await assert.rejects(
    wrongMaterial.start({ ...alice, label: "Must not corrupt keyed state" }),
    /key material does not match persisted state/,
  );
  await assert.rejects(
    wrongMaterial.authenticate({
      agentId: alice.agentId,
      collaborationSessionHandle: credential.collaborationSessionHandle,
    }),
    /key material does not match persisted state/,
  );
  await assert.rejects(
    wrongMaterial.resume({
      ...alice,
      collaborationSessionHandle: credential.collaborationSessionHandle,
      resumeRequestId: "wrong-material-0001",
    }),
    /key material does not match persisted state/,
  );
  assert.equal(await fs.readFile(store.statePath, "utf8"), stateBeforeWrongMaterial);
  assert.equal((await store.listByActor(alice.agentId)).length, 1);
});

test("binds handles to one OAuth actor and throttles liveness revisions", async (t) => {
  const value = await fixture("pilink-collaboration-session-binding-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const created = await value.store().start({ ...alice, label: "Stable logical run", ttlSeconds: 120 });
  const replacementStore = value.store();

  const immediate = await replacementStore.authenticate({
    agentId: alice.agentId,
    collaborationSessionHandle: created.collaborationSessionHandle,
  });
  assert.equal(immediate.revision, 1);
  value.advance(61);
  const touched = await replacementStore.authenticate({
    agentId: alice.agentId,
    collaborationSessionHandle: created.collaborationSessionHandle,
  });
  assert.equal(touched.revision, 2);
  assert.equal(touched.lastSeenAt, value.nowIso());

  await assert.rejects(
    replacementStore.authenticate({
      agentId: bob.agentId,
      collaborationSessionHandle: created.collaborationSessionHandle,
    }),
    /different OAuth actor/,
  );
  const secret = created.collaborationSessionHandle.split(".")[1];
  await assert.rejects(
    replacementStore.authenticate({
      agentId: alice.agentId,
      collaborationSessionHandle: `${created.session.collaborationSessionId}.${"A".repeat(43)}`,
    }),
    (error) => /Invalid collaboration session handle/.test(error.message) && !error.message.includes(secret),
  );
});

test("pins every private bearer operation to the exact PiLink runtime", async (t) => {
  const value = await fixture("pilink-collaboration-session-runtime-pin-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();
  const created = await store.start({ ...alice, ttlSeconds: 120 });

  for (const action of ["authenticate", "inspect", "resume", "release"]) {
    await assert.rejects(
      runHandleWorker({
        action,
        workspace: value.workspace,
        dataDir: value.dataDir,
        agentId: alice.agentId,
        agentName: alice.agentName,
        collaborationSessionHandle: created.collaborationSessionHandle,
        nowIso: value.nowIso(),
      }),
      /different PiLink runtime/,
    );
  }

  const wrongHandle = `${created.session.collaborationSessionId}.${"A".repeat(43)}`;
  await assert.rejects(
    runHandleWorker({
      action: "resume",
      workspace: value.workspace,
      dataDir: value.dataDir,
      agentId: alice.agentId,
      agentName: alice.agentName,
      collaborationSessionHandle: wrongHandle,
      nowIso: value.nowIso(),
    }),
    (error) => /Invalid collaboration session handle or resume request/.test(error.message) &&
      !/different PiLink runtime/.test(error.message),
  );

  assert.equal((await store.authenticate({
    agentId: alice.agentId,
    collaborationSessionHandle: created.collaborationSessionHandle,
  })).status, "active");
  assert.equal((await store.inspect({
    agentId: alice.agentId,
    collaborationSessionHandle: created.collaborationSessionHandle,
  })).status, "active");
});

test("resume rotation is generation-bound and idempotent after response loss", async (t) => {
  const value = await fixture("pilink-collaboration-session-resume-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();
  const created = await store.start({ ...alice, ttlSeconds: 10 });
  const requestId = "resume-request-0001";

  value.advance(11);
  await assert.rejects(
    store.authenticate({
      agentId: alice.agentId,
      collaborationSessionHandle: created.collaborationSessionHandle,
    }),
    /expired; resume it/,
  );
  assert.equal((await store.inspect({
    agentId: alice.agentId,
    collaborationSessionHandle: created.collaborationSessionHandle,
  })).status, "expired");

  const resumed = await store.resume({
    ...alice,
    collaborationSessionHandle: created.collaborationSessionHandle,
    resumeRequestId: requestId,
    ttlSeconds: 20,
  });
  assert.equal(resumed.session.collaborationSessionId, created.session.collaborationSessionId);
  assert.equal(resumed.session.status, "active");
  assert.equal(resumed.session.credentialGeneration, 2);
  assert.equal(resumed.session.lastCredentialRotatedAt, value.nowIso());
  assert.notEqual(resumed.collaborationSessionHandle, created.collaborationSessionHandle);
  await assert.rejects(
    runHandleWorker({
      action: "resume",
      workspace: value.workspace,
      dataDir: value.dataDir,
      agentId: alice.agentId,
      agentName: alice.agentName,
      collaborationSessionHandle: created.collaborationSessionHandle,
      nowIso: value.nowIso(),
    }),
    /different PiLink runtime/,
  );

  const retry = await store.resume({
    ...alice,
    collaborationSessionHandle: created.collaborationSessionHandle,
    resumeRequestId: requestId,
    ttlSeconds: 20,
  });
  assert.equal(retry.collaborationSessionHandle, resumed.collaborationSessionHandle);
  assert.deepEqual(retry.session, resumed.session);

  await assert.rejects(
    store.authenticate({
      agentId: alice.agentId,
      collaborationSessionHandle: created.collaborationSessionHandle,
    }),
    /Invalid collaboration session handle/,
  );
  await assert.rejects(
    store.resume({
      ...alice,
      collaborationSessionHandle: created.collaborationSessionHandle,
      resumeRequestId: "resume-request-other",
      ttlSeconds: 20,
    }),
    /conflicts with a completed credential rotation/,
  );
  await assert.rejects(
    store.resume({
      ...alice,
      collaborationSessionHandle: created.collaborationSessionHandle,
      resumeRequestId: requestId,
      ttlSeconds: 21,
    }),
    /parameters conflict/,
  );
  await assert.rejects(
    store.resume({
      ...alice,
      collaborationSessionHandle: resumed.collaborationSessionHandle,
      resumeRequestId: requestId,
      ttlSeconds: 20,
    }),
    /already completed/,
  );
  assert.equal((await store.authenticate({
    agentId: alice.agentId,
    collaborationSessionHandle: resumed.collaborationSessionHandle,
  })).status, "active");

  const persistedText = await fs.readFile(store.statePath, "utf8");
  const persisted = JSON.parse(persistedText).sessions[0];
  assert.equal(persisted.credentialGeneration, 2);
  assert.equal(persisted.resumeRecovery.sourceGeneration, 1);
  assert.equal(persisted.resumeRecovery.targetGeneration, 2);
  assert.equal(persisted.resumeRecovery.ttlSeconds, 20);
  assert.match(persisted.resumeRecovery.requestIdMac, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(persistedText.includes(requestId), false);
  assert.equal(persistedText.includes(created.collaborationSessionHandle.split(".")[1]), false);
  assert.equal(persistedText.includes(resumed.collaborationSessionHandle.split(".")[1]), false);

  value.advance(31);
  await assert.rejects(
    store.resume({
      ...alice,
      collaborationSessionHandle: created.collaborationSessionHandle,
      resumeRequestId: requestId,
      ttlSeconds: 20,
    }),
    /Invalid collaboration session handle or resume request/,
  );
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(store.statePath, "utf8")).sessions[0], "resumeRecovery"), false);

  value.advance(120);
  await assert.rejects(
    store.resume({
      ...alice,
      collaborationSessionHandle: resumed.collaborationSessionHandle,
      resumeRequestId: "resume-request-0002",
      ttlSeconds: 20,
    }),
    /expired beyond its resume window/,
  );
});

test("omitted TTL retries keep the winning default across store replacement", async (t) => {
  const value = await fixture("pilink-collaboration-session-default-retry-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const originalStore = value.store({ defaultTtlSeconds: 60 });
  const created = await originalStore.start({ ...alice });
  const requestId = "default-change-retry-01";
  const rotated = await originalStore.resume({
    ...alice,
    collaborationSessionHandle: created.collaborationSessionHandle,
    resumeRequestId: requestId,
  });
  assert.equal(rotated.session.expiresAt, "2026-08-01T10:01:00.000Z");

  const replacementStore = value.store({ defaultTtlSeconds: 120 });
  const recovered = await replacementStore.resume({
    ...alice,
    collaborationSessionHandle: created.collaborationSessionHandle,
    resumeRequestId: requestId,
  });
  assert.equal(recovered.collaborationSessionHandle, rotated.collaborationSessionHandle);
  assert.equal(recovered.session.expiresAt, rotated.session.expiresAt);
  assert.equal(recovered.session.credentialGeneration, 2);
});

test("released and revoked sessions fail closed and erase retry recovery", async (t) => {
  const value = await fixture("pilink-collaboration-session-terminal-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();

  const releasable = await store.start({ ...alice, label: "Release me" });
  const rotated = await store.resume({
    ...alice,
    collaborationSessionHandle: releasable.collaborationSessionHandle,
    resumeRequestId: "release-rotation-01",
  });
  const released = await store.release({
    agentId: alice.agentId,
    collaborationSessionHandle: rotated.collaborationSessionHandle,
  });
  assert.equal(released.status, "released");
  assert.deepEqual(await store.release({
    agentId: alice.agentId,
    collaborationSessionHandle: rotated.collaborationSessionHandle,
  }), released);
  assert.equal((await store.inspect({
    agentId: alice.agentId,
    collaborationSessionHandle: rotated.collaborationSessionHandle,
  })).status, "released");
  await assert.rejects(
    store.inspect({
      agentId: bob.agentId,
      collaborationSessionHandle: rotated.collaborationSessionHandle,
    }),
    (error) => /different OAuth actor/.test(error.message) && !/released|runtime/.test(error.message),
  );
  await assert.rejects(
    store.inspect({
      agentId: alice.agentId,
      collaborationSessionHandle: `${released.collaborationSessionId}.${"A".repeat(43)}`,
    }),
    (error) => /Invalid collaboration session handle/.test(error.message) && !/released|runtime/.test(error.message),
  );
  await assert.rejects(
    store.authenticate({
      agentId: alice.agentId,
      collaborationSessionHandle: rotated.collaborationSessionHandle,
    }),
    /was released; start a new session/,
  );
  await assert.rejects(
    store.resume({
      ...alice,
      collaborationSessionHandle: rotated.collaborationSessionHandle,
      resumeRequestId: "released-current-handle-01",
    }),
    /was released; start a new session/,
  );
  await assert.rejects(
    store.resume({
      ...alice,
      collaborationSessionHandle: releasable.collaborationSessionHandle,
      resumeRequestId: "release-rotation-01",
    }),
    /Invalid collaboration session handle or resume request/,
  );

  const revocable = await store.start({ ...alice, label: "Revoke me" });
  const revoked = await store.revoke(revocable.session.collaborationSessionId);
  assert.equal(revoked.status, "revoked");
  assert.equal((await store.inspect({
    agentId: alice.agentId,
    collaborationSessionHandle: revocable.collaborationSessionHandle,
  })).status, "revoked");
  await assert.rejects(
    store.resume({
      ...bob,
      collaborationSessionHandle: revocable.collaborationSessionHandle,
      resumeRequestId: "revoked-wrong-actor-01",
    }),
    (error) => /different OAuth actor/.test(error.message) && !/revoked|runtime/.test(error.message),
  );
  await assert.rejects(
    store.authenticate({
      agentId: alice.agentId,
      collaborationSessionHandle: revocable.collaborationSessionHandle,
    }),
    /was revoked; start a new session/,
  );
  await assert.rejects(
    store.resume({
      ...alice,
      collaborationSessionHandle: revocable.collaborationSessionHandle,
      resumeRequestId: "revoked-current-handle-01",
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

test("enforces a bounded live or resumable session quota per OAuth actor", async (t) => {
  const value = await fixture("pilink-collaboration-session-actor-quota-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store({ maxLiveSessionsPerActor: 2 });
  const first = await store.start({ ...alice, label: "One" });
  await store.start({ ...alice, label: "Two" });
  await assert.rejects(store.start({ ...alice, label: "Three" }), /limit of 2 reached/);
  assert.equal((await store.start({ ...bob, label: "Bob one" })).session.agentId, bob.agentId);

  await store.release({
    agentId: alice.agentId,
    collaborationSessionHandle: first.collaborationSessionHandle,
  });
  assert.equal((await store.start({ ...alice, label: "Replacement" })).session.status, "active");
});

test("migrates unkeyed legacy sessions to revoked keyed tombstones", async (t) => {
  const value = await fixture("pilink-collaboration-session-legacy-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();
  const sessionId = "cs_AAAAAAAAAAAAAAAAAAAAAAAA";
  await fs.mkdir(path.dirname(store.statePath), { recursive: true });
  await fs.writeFile(store.statePath, JSON.stringify({
    version: 1,
    projectKey: store.projectKey,
    sessions: [{
      collaborationSessionId: sessionId,
      projectKey: store.projectKey,
      agentId: alice.agentId,
      agentName: alice.agentName,
      status: "active",
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T09:00:00.000Z",
      lastSeenAt: "2026-08-01T09:00:00.000Z",
      expiresAt: "2026-08-01T11:00:00.000Z",
      resumeUntil: "2026-08-01T12:00:00.000Z",
      revision: 1,
      credentialHash: "A".repeat(43),
    }],
  }));

  const sessions = await store.listByActor(alice.agentId);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, "revoked");
  assert.equal(sessions[0].credentialGeneration, 1);
  assert.equal(sessions[0].revision, 2);

  const persistedText = await fs.readFile(store.statePath, "utf8");
  const persisted = JSON.parse(persistedText);
  assert.equal(persisted.version, 3);
  assert.equal(persisted.sessions[0].status, "revoked");
  assert.equal(Object.hasOwn(persisted.sessions[0], "credentialHash"), false);
  assert.equal(persistedText.includes("A".repeat(43)), false);
  await assert.rejects(
    store.authenticate({
      agentId: alice.agentId,
      collaborationSessionHandle: `${sessionId}.${"B".repeat(43)}`,
    }),
    /Invalid collaboration session handle/,
  );
});

test("migrates ownerless version 2 sessions to revoked version 3 tombstones", async (t) => {
  const value = await fixture("pilink-collaboration-session-v2-runtime-owner-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();
  const created = await store.start({ ...alice, label: "Version two orphan" });
  const versionTwo = JSON.parse(await fs.readFile(store.statePath, "utf8"));
  versionTwo.version = 2;
  versionTwo.credentialKeyBinding.mac = collaborationStateKeyBindingMac(store.projectKey, 2);
  delete versionTwo.sessions[0].runtimeOwner;
  await fs.writeFile(store.statePath, `${JSON.stringify(versionTwo)}\n`, { mode: 0o600 });

  const restarted = value.store({ maxLiveSessionsPerActor: 1 });
  const sessions = await restarted.listByActor(alice.agentId);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].collaborationSessionId, created.session.collaborationSessionId);
  assert.equal(sessions[0].status, "revoked");
  assert.equal(Object.hasOwn(sessions[0], "runtimeOwner"), false);
  const migrated = JSON.parse(await fs.readFile(store.statePath, "utf8"));
  assert.equal(migrated.version, 3);
  assert.equal(migrated.sessions[0].status, "revoked");
  assert.equal(Object.hasOwn(migrated.sessions[0], "runtimeOwner"), false);
  assert.equal((await restarted.start({ ...alice, label: "Safe replacement" })).session.status, "active");
});

test("reclaims a stale same-PID owner tuple and clears private ownership", async (t) => {
  const value = await fixture("pilink-collaboration-session-stale-owner-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();
  const created = await store.start({ ...alice, label: "Stale owner" });
  const persisted = JSON.parse(await fs.readFile(store.statePath, "utf8"));
  const owner = persisted.sessions[0].runtimeOwner;
  owner.processStartMarker = owner.processStartMarker === "1" ? "2" : "1";
  await fs.writeFile(store.statePath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

  const sessions = await store.listByActor(alice.agentId);
  assert.equal(sessions[0].collaborationSessionId, created.session.collaborationSessionId);
  assert.equal(sessions[0].status, "revoked");
  assert.equal(Object.hasOwn(sessions[0], "runtimeOwner"), false);
  assert.equal(Object.hasOwn(sessions[0], "revocationReason"), false);
  const reclaimed = JSON.parse(await fs.readFile(store.statePath, "utf8")).sessions[0];
  assert.equal(reclaimed.status, "revoked");
  assert.equal(reclaimed.revocationReason, "runtime_lost");
  assert.equal(Object.hasOwn(reclaimed, "runtimeOwner"), false);
});

test("classifies PID reuse, reboot, and ambiguous liveness deterministically", () => {
  const currentOwner = {
    version: 1,
    runtimeInstanceId: "a".repeat(32),
    pid: 100,
    bootId: "11111111-1111-1111-1111-111111111111",
    processStartMarker: "1000",
  };
  const foreignOwner = {
    version: 1,
    runtimeInstanceId: "b".repeat(32),
    pid: 200,
    bootId: currentOwner.bootId,
    processStartMarker: "2000",
  };
  assert.equal(classifyRuntimeOwnerLiveness({
    owner: currentOwner,
    currentOwner,
    platform: "linux",
    processExistence: "exists",
    observedProcessStartMarker: "1000",
  }), "alive");
  assert.equal(classifyRuntimeOwnerLiveness({
    owner: { ...foreignOwner, pid: currentOwner.pid },
    currentOwner,
    platform: "linux",
    processExistence: "exists",
    observedProcessStartMarker: currentOwner.processStartMarker,
  }), "dead");
  assert.equal(classifyRuntimeOwnerLiveness({
    owner: { ...foreignOwner, bootId: "22222222-2222-2222-2222-222222222222" },
    currentOwner,
    platform: "linux",
    processExistence: "exists",
    observedProcessStartMarker: foreignOwner.processStartMarker,
  }), "dead");
  assert.equal(classifyRuntimeOwnerLiveness({
    owner: foreignOwner,
    currentOwner,
    platform: "linux",
    processExistence: "absent",
  }), "dead");
  assert.equal(classifyRuntimeOwnerLiveness({
    owner: foreignOwner,
    currentOwner,
    platform: "linux",
    processExistence: "exists",
    observedProcessStartMarker: "2001",
  }), "dead");
  assert.equal(classifyRuntimeOwnerLiveness({
    owner: foreignOwner,
    currentOwner,
    platform: "linux",
    processExistence: "exists",
    observedProcessStartMarker: "2000",
  }), "alive");
  assert.equal(classifyRuntimeOwnerLiveness({
    owner: foreignOwner,
    currentOwner,
    platform: "linux",
    processExistence: "ambiguous",
  }), "ambiguous");
  assert.equal(classifyRuntimeOwnerLiveness({
    owner: foreignOwner,
    currentOwner,
    platform: "linux",
    processExistence: "exists",
  }), "ambiguous");
});

test("Linux local owner acquisition fails closed when identity is incomplete", () => {
  const incomplete = {
    version: 1,
    runtimeInstanceId: "c".repeat(32),
    pid: 123,
  };
  assert.throws(
    () => validateLocalRuntimeOwnerForPlatform(incomplete, "linux"),
    /Unable to establish the local Linux runtime identity/,
  );
  assert.deepEqual(validateLocalRuntimeOwnerForPlatform(incomplete, "darwin"), incomplete);
});

test("rejects an incomplete persisted Linux owner tuple", async (t) => {
  if (process.platform !== "linux") return;
  const value = await fixture("pilink-collaboration-session-incomplete-owner-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.store();
  await store.start({ ...alice, label: "Complete before tamper" });
  const persisted = JSON.parse(await fs.readFile(store.statePath, "utf8"));
  delete persisted.sessions[0].runtimeOwner.bootId;
  await fs.writeFile(store.statePath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
  await assert.rejects(
    value.store().listByActor(alice.agentId),
    /Linux live owner tuple is incomplete/,
  );
});

test("reclaims crash-owned capacity but preserves sessions of a live peer process", async (t) => {
  const value = await fixture("pilink-collaboration-session-crash-owner-");
  const readyPath = path.join(value.root, "crash-owner-ready.json");
  const owner = spawnOrphanOwner({
    workspace: value.workspace,
    dataDir: value.dataDir,
    agentId: alice.agentId,
    count: 2,
    readyPath,
    nowIso: value.nowIso(),
  });
  t.after(async () => {
    if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill("SIGKILL");
    await new Promise((resolve) => {
      if (owner.child.exitCode !== null || owner.child.signalCode !== null) resolve();
      else owner.child.once("exit", resolve);
    });
    await fs.rm(value.root, { recursive: true, force: true });
  });

  await waitForFiles([readyPath]);
  assert.equal(owner.child.exitCode, null, owner.diagnostics());
  const { collaborationSessionIds, collaborationSessionHandles } = JSON.parse(
    await fs.readFile(readyPath, "utf8"),
  );
  assert.equal(collaborationSessionIds.length, 2);
  assert.equal(collaborationSessionHandles.length, 2);

  const peerStore = value.store({ maxLiveSessionsPerActor: 2 });
  const livePeerSessions = await peerStore.listByActor(alice.agentId);
  assert.deepEqual(
    new Set(livePeerSessions.map((session) => session.collaborationSessionId)),
    new Set(collaborationSessionIds),
  );
  assert.equal(livePeerSessions.every((session) => session.status === "active"), true);
  await assert.rejects(
    peerStore.start({ ...alice, label: "Must not evict live peer" }),
    /limit of 2 reached/,
  );

  const exited = new Promise((resolve, reject) => {
    owner.child.once("error", reject);
    owner.child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(owner.child.kill("SIGKILL"), true);
  const outcome = await exited;
  assert.equal(outcome.signal, "SIGKILL", owner.diagnostics());

  const replacement = await peerStore.start({ ...alice, label: "After crash" });
  assert.equal(replacement.session.status, "active");
  const recovered = await peerStore.listByActor(alice.agentId);
  for (const sessionId of collaborationSessionIds) {
    assert.equal(
      recovered.find((session) => session.collaborationSessionId === sessionId)?.status,
      "revoked",
    );
  }
  assert.equal(
    recovered.find((session) => session.collaborationSessionId === replacement.session.collaborationSessionId)?.status,
    "active",
  );
  const persisted = JSON.parse(await fs.readFile(peerStore.statePath, "utf8"));
  for (const sessionId of collaborationSessionIds) {
    const crashed = persisted.sessions.find((session) => session.collaborationSessionId === sessionId);
    assert.equal(crashed.status, "revoked");
    assert.equal(crashed.revocationReason, "runtime_lost");
    assert.equal(Object.hasOwn(crashed, "runtimeOwner"), false);
  }

  const runtimeLostHandle = collaborationSessionHandles[0];
  assert.equal((await peerStore.inspect({
    agentId: alice.agentId,
    collaborationSessionHandle: runtimeLostHandle,
  })).status, "revoked");
  await assert.rejects(peerStore.authenticate({
    agentId: alice.agentId,
    collaborationSessionHandle: runtimeLostHandle,
  }), /was revoked; start a new session/);
  await assert.rejects(peerStore.resume({
    ...alice,
    collaborationSessionHandle: runtimeLostHandle,
    resumeRequestId: "runtime-lost-terminal-01",
  }), /was revoked; start a new session/);
  await assert.rejects(peerStore.release({
    agentId: alice.agentId,
    collaborationSessionHandle: runtimeLostHandle,
  }), /is revoked/);
});

test("serializes synchronized session creation across PiLink processes", async (t) => {
  const value = await fixture("pilink-collaboration-session-process-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const gatePath = path.join(value.root, "start-workers");
  const workerCount = 8;
  const readyPaths = Array.from({ length: workerCount }, (_, index) => path.join(value.root, `ready-${index}`));
  const workers = readyPaths.map((readyPath, index) => runStartWorker({
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

  const persisted = JSON.parse(await fs.readFile(value.store().statePath, "utf8"));
  assert.equal(persisted.sessions.length, workerCount);
  assert.deepEqual(
    new Set(persisted.sessions.map((session) => session.label)),
    new Set(Array.from({ length: workerCount }, (_, index) => `Process session ${index}`)),
  );
});

test("same-runtime concurrent resume retries converge on one deterministic credential", async (t) => {
  const value = await fixture("pilink-collaboration-session-resume-same-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const created = await value.store().start({ ...alice });
  const stores = Array.from({ length: 6 }, () => value.store());
  const results = await Promise.all(stores.map((store) => store.resume({
    ...alice,
    collaborationSessionHandle: created.collaborationSessionHandle,
    resumeRequestId: "same-runtime-same-01",
    ttlSeconds: 60,
  })));
  assert.equal(new Set(results.map((entry) => entry.collaborationSessionHandle)).size, 1);
  assert.equal(new Set(results.map((entry) => entry.session.credentialGeneration)).size, 1);
  assert.equal(results[0].session.credentialGeneration, 2);
  assert.equal(JSON.parse(await fs.readFile(value.store().statePath, "utf8")).sessions[0].revision, 2);
});

test("different same-runtime resume requests produce exactly one winner", async (t) => {
  const value = await fixture("pilink-collaboration-session-resume-conflict-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const created = await value.store().start({ ...alice });
  const stores = Array.from({ length: 6 }, () => value.store());
  const results = await Promise.allSettled(stores.map((store, index) => store.resume({
    ...alice,
    collaborationSessionHandle: created.collaborationSessionHandle,
    resumeRequestId: `same-runtime-conflict-${String(index).padStart(2, "0")}`,
    ttlSeconds: 60,
  })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, stores.length - 1);
  for (const result of results.filter((entry) => entry.status === "rejected")) {
    assert.match(result.reason.message, /conflicts with a completed credential rotation/);
  }
  const persisted = JSON.parse(await fs.readFile(value.store().statePath, "utf8")).sessions[0];
  assert.equal(persisted.credentialGeneration, 2);
  assert.equal(persisted.revision, 2);
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

test("validates storage boundaries, strict state, and repaired malformed files", async (t) => {
  const value = await fixture("pilink-collaboration-session-recovery-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  assert.throws(
    () => new CollaborationSessionStore({
      workspace: value.workspace,
      dataDir: path.join(value.workspace, "private"),
      credentialKey,
    }),
    /must not be stored under the workspace/,
  );

  const store = value.store();
  await fs.mkdir(path.dirname(store.statePath), { recursive: true });
  await fs.writeFile(store.statePath, "not-json\n");
  await assert.rejects(store.listByActor(alice.agentId), /invalid JSON/);
  await fs.writeFile(store.statePath, JSON.stringify({ version: 1, projectKey: store.projectKey, sessions: [] }));
  assert.deepEqual(await store.listByActor(alice.agentId), []);
  assert.equal(JSON.parse(await fs.readFile(store.statePath, "utf8")).version, 3);

  const created = await store.start({ ...alice });
  const persisted = JSON.parse(await fs.readFile(store.statePath, "utf8"));
  persisted.sessions[0].credentialSecret = created.collaborationSessionHandle.split(".")[1];
  await fs.writeFile(store.statePath, JSON.stringify(persisted));
  await assert.rejects(store.listByActor(alice.agentId), /unknown field/);
  delete persisted.sessions[0].credentialSecret;
  await fs.writeFile(store.statePath, JSON.stringify(persisted));
  assert.equal((await store.listByActor(alice.agentId)).length, 1);
  await assert.rejects(
    store.inspect({ agentId: alice.agentId, collaborationSessionHandle: "not-a-handle" }),
    /Invalid collaboration session handle format/,
  );
});
