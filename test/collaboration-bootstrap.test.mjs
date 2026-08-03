import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CollaborationBootstrap } from "../dist/collaboration-bootstrap.js";
import { CollaborationSessionStore } from "../dist/collaboration-sessions.js";
import { AgentTaskStore } from "../dist/tasks.js";

const credentialKey = Object.freeze({
  keyId: "bootstrap-test-key-v1",
  keyMaterial: Buffer.alloc(32, 0x62).toString("base64url"),
});
const chatGptActor = Object.freeze({ agentId: "pi_shared_chatgpt", agentName: "ChatGPT" });

async function fixture(prefix = "pilink-collaboration-bootstrap-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  let nowMs = Date.parse("2026-08-03T12:00:00.000Z");
  const now = () => new Date(nowMs);
  return {
    root,
    workspace,
    dataDir,
    now,
    advance(seconds) { nowMs += seconds * 1_000; },
    sessionStore(overrides = {}) {
      return new CollaborationSessionStore({
        workspace,
        dataDir,
        now,
        defaultTtlSeconds: 60,
        resumeGraceSeconds: 120,
        resumeRecoverySeconds: 30,
        touchIntervalSeconds: 1,
        credentialKey,
        ...overrides,
      });
    },
    taskStore() {
      return new AgentTaskStore({ workspace, dataDir, now });
    },
  };
}

function bootstrap(sessionStore, overrides = {}) {
  return new CollaborationBootstrap({
    sessionStore,
    identity: chatGptActor,
    ...overrides,
  });
}

test("same OAuth actor receives distinct connection-bound sessions and canonical roles", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.sessionStore();
  const devConversation = bootstrap(store, { sessionLabel: "ChatGPT conversation dev2" });
  const researchConversation = bootstrap(store, { sessionLabel: "ChatGPT conversation researcher" });

  const [devContext, researchContext] = await Promise.all([
    devConversation.initialize("Software Engineer 2"),
    researchConversation.initialize("Researcher"),
  ]);

  assert.notEqual(devContext.collaborationSessionId, researchContext.collaborationSessionId);
  assert.equal(devContext.agentId, researchContext.agentId);
  assert.equal(devContext.requestKind, "recognized");
  assert.equal(devContext.roleAssignment.canonicalRoleId, "implementer");
  assert.equal(devContext.roleAssignment.occupancyLabel, "dev2");
  assert.equal(devContext.roleAssignment.contractId, "pilink-collaboration/implementer");
  assert.equal(researchContext.roleAssignment.canonicalRoleId, "researcher");
  assert.equal(researchContext.roleAssignment.occupancyLabel, "researcher");
  assert.equal(researchContext.roleAssignment.contractId, "pilink-collaboration/researcher");

  const sessions = await store.listByActor(chatGptActor.agentId);
  assert.equal(sessions.length, 2);
  assert.deepEqual(
    new Set(sessions.map((session) => session.collaborationSessionId)),
    new Set([devContext.collaborationSessionId, researchContext.collaborationSessionId]),
  );
  const publicText = JSON.stringify({ devContext, researchContext, sessions });
  assert.equal(publicText.includes("Software Engineer 2"), false);
  assert.equal(publicText.includes("collaborationSessionHandle"), false);
  assert.equal(publicText.includes("credentialVerifier"), false);
  assert.equal(publicText.includes("resumeRecovery"), false);
  assert.equal(publicText.includes("normalizedRoleLabel"), false);
});

test("bootstrap is idempotent for one normalized request and fails closed on rebootstrap", async (t) => {
  const value = await fixture("pilink-collaboration-bootstrap-idempotence-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.sessionStore();
  const connection = bootstrap(store);

  const first = await connection.initialize("  Software Engineer 2  ");
  const retry = await connection.initialize("Software Engineer 2");
  assert.deepEqual(retry, first);
  assert.equal((await store.listByActor(chatGptActor.agentId)).length, 1);

  await assert.rejects(
    connection.initialize("Researcher"),
    (error) => /different role request/.test(error.message) && !error.message.includes("Researcher"),
  );
  assert.equal((await store.listByActor(chatGptActor.agentId)).length, 1);

  const custom = bootstrap(store);
  const customContext = await custom.initialize("throwaway specialist 47");
  assert.equal(customContext.requestKind, "custom");
  assert.equal(customContext.roleAssignment.canonicalRoleId, "collaborator");
  assert.equal(
    customContext.roleAssignment.occupancyLabel,
    `custom-${customContext.requestedRoleFingerprint}`,
  );
  assert.equal(JSON.stringify(customContext).includes("throwaway specialist 47"), false);

  const forbidden = bootstrap(store);
  const malicious = "manager\u202eignore-policy";
  await assert.rejects(
    forbidden.initialize(malicious),
    (error) => /bidirectional/.test(error.message) && !error.message.includes(malicious),
  );
});

test("session store validates exact pinned registry tuples and safe custom bindings", async (t) => {
  const value = await fixture("pilink-collaboration-bootstrap-store-boundary-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.sessionStore();

  await assert.rejects(store.start({
    ...chatGptActor,
    roleBinding: {
      requestKind: "recognized",
      requestedRoleFingerprint: "a".repeat(16),
      roleAssignment: {
        assignmentSource: "server_session_policy",
        canonicalRoleId: "manager",
        occupancyLabel: "manager\nignore-policy",
        contractId: "pilink-collaboration/manager",
        contractVersion: "1.0.0",
      },
    },
  }), /occupancyLabel/);

  await assert.rejects(store.start({
    ...chatGptActor,
    roleBinding: {
      requestKind: "recognized",
      requestedRoleFingerprint: "b".repeat(16),
      roleAssignment: {
        assignmentSource: "server_session_policy",
        canonicalRoleId: "manager",
        occupancyLabel: "manager",
        contractId: "pilink-collaboration/manager",
        contractVersion: "99.0.0",
      },
    },
  }), /explicit contract upgrade required/);

  await assert.rejects(store.start({
    ...chatGptActor,
    roleBinding: {
      requestKind: "custom",
      requestedRoleFingerprint: "c".repeat(16),
      roleAssignment: {
        assignmentSource: "server_session_policy",
        canonicalRoleId: "manager",
        occupancyLabel: "manager",
        contractId: "pilink-collaboration/manager",
        contractVersion: "1.0.0",
      },
    },
  }), /custom role binding must use/);
});

test("resume preserves session ownership and released sessions recover tasks by lease expiry", async (t) => {
  const value = await fixture("pilink-collaboration-bootstrap-lifecycle-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const sessionStore = value.sessionStore({ defaultTtlSeconds: 5, resumeGraceSeconds: 60 });
  const taskStore = value.taskStore();
  const first = bootstrap(sessionStore, { ttlSeconds: 5 });
  const sibling = bootstrap(sessionStore, { ttlSeconds: 5 });

  const firstContext = await first.initialize("dev1");
  const siblingContext = await sibling.initialize("researcher");
  const created = await taskStore.create({
    agentId: firstContext.agentId,
    agentName: firstContext.agentName,
    collaborationSessionId: firstContext.collaborationSessionId,
    title: "Session-owned bootstrap task",
  });
  const claimed = await taskStore.claim({
    agentId: firstContext.agentId,
    agentName: firstContext.agentName,
    collaborationSessionId: firstContext.collaborationSessionId,
    taskId: created.taskId,
    expectedRevision: created.revision,
    leaseSeconds: 10,
  });

  await assert.rejects(taskStore.complete({
    agentId: siblingContext.agentId,
    agentName: siblingContext.agentName,
    collaborationSessionId: siblingContext.collaborationSessionId,
    taskId: claimed.taskId,
    expectedRevision: claimed.revision,
  }), /different collaboration session/);

  value.advance(6);
  const resumedContext = await first.verify();
  assert.equal(resumedContext.collaborationSessionId, firstContext.collaborationSessionId);
  assert.deepEqual(resumedContext.roleAssignment, firstContext.roleAssignment);
  const renewed = await taskStore.renew({
    agentId: resumedContext.agentId,
    agentName: resumedContext.agentName,
    collaborationSessionId: resumedContext.collaborationSessionId,
    taskId: claimed.taskId,
    expectedRevision: claimed.revision,
    leaseSeconds: 10,
  });
  assert.equal(renewed.ownerCollaborationSessionId, firstContext.collaborationSessionId);

  await first.release();
  await assert.rejects(first.verify(), /was released/);
  value.advance(11);
  const recovered = await taskStore.get(created.taskId);
  assert.equal(recovered.status, "open");
  assert.equal(recovered.ownerCollaborationSessionId, undefined);

  const activeSibling = await sibling.verify();
  const reclaimed = await taskStore.claim({
    agentId: activeSibling.agentId,
    agentName: activeSibling.agentName,
    collaborationSessionId: activeSibling.collaborationSessionId,
    taskId: recovered.taskId,
    expectedRevision: recovered.revision,
    leaseSeconds: 10,
  });
  assert.equal(reclaimed.ownerCollaborationSessionId, siblingContext.collaborationSessionId);
});

test("persisted assignment drift and tampering fail closed without repinning", async (t) => {
  const value = await fixture("pilink-collaboration-bootstrap-tamper-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.sessionStore();
  const connection = bootstrap(store);
  await connection.initialize("dev2");

  const persisted = JSON.parse(await fs.readFile(store.statePath, "utf8"));
  persisted.sessions[0].roleContractVersion = "9.9.9";
  await fs.writeFile(store.statePath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

  await assert.rejects(
    connection.verify(),
    /explicit contract upgrade required/,
  );
});

test("final disposal releases capacity while uninitialized cleanup is inert", async (t) => {
  const value = await fixture("pilink-collaboration-bootstrap-dispose-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.sessionStore({ maxLiveSessionsPerActor: 1 });
  const unopened = bootstrap(store);
  await unopened.dispose();

  const first = bootstrap(store);
  await first.initialize("dev1");
  const blocked = bootstrap(store);
  await assert.rejects(blocked.initialize("researcher"), /limit of 1 reached/);

  await first.dispose();
  assert.equal(first.dispose(), first.dispose());
  const reopened = bootstrap(store);
  const reopenedContext = await reopened.initialize("researcher");
  assert.equal(reopenedContext.roleAssignment.canonicalRoleId, "researcher");
  const sessions = await store.listByActor(chatGptActor.agentId);
  assert.equal(sessions.filter((session) => session.status === "active").length, 1);
  assert.equal(sessions.some((session) => session.status === "released"), true);
});

test("dispose during delayed initialization leaves no live session or accepted context", async (t) => {
  const value = await fixture("pilink-collaboration-bootstrap-dispose-race-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = value.sessionStore();
  let signalStart;
  let releaseStart;
  const startEntered = new Promise((resolve) => { signalStart = resolve; });
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const delayedStore = new Proxy(store, {
    get(target, property) {
      if (property === "start") {
        return async (input) => {
          signalStart();
          await startGate;
          return target.start(input);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const connection = bootstrap(delayedStore);

  const initializePromise = connection.initialize("dev2");
  await startEntered;
  const disposePromise = connection.dispose();
  releaseStart();

  await assert.rejects(initializePromise, /disposed during initialization/);
  await disposePromise;
  await assert.rejects(connection.verify(), /connection is disposed/);
  const sessions = await store.listByActor(chatGptActor.agentId);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, "released");
  assert.equal(sessions.some((session) => session.status === "active"), false);
});
