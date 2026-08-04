import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CollaborationBootstrap } from "../dist/collaboration-bootstrap.js";
import { CollaborationContextRegistry } from "../dist/collaboration-context-registry.js";
import { CollaborationSessionStore } from "../dist/collaboration-sessions.js";

const credentialKey = Object.freeze({
  keyId: "context-registry-test-key-v1",
  keyMaterial: Buffer.alloc(32, 0x72).toString("base64url"),
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-context-registry-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  const sessionStore = new CollaborationSessionStore({
    workspace,
    dataDir,
    credentialKey,
  });
  const registry = new CollaborationContextRegistry({
    bindingKeyMaterial: Buffer.alloc(32, 0x42),
    detachGraceSeconds: 60,
    createBootstrap(identity) {
      return new CollaborationBootstrap({ sessionStore, identity });
    },
  });
  return { root, dataDir, sessionStore, registry };
}

const actor = Object.freeze({ agentId: "shared-oauth-actor", agentName: "ChatGPT" });

test("trusted binding reattaches the same private collaboration bootstrap", async (t) => {
  const value = await fixture();
  t.after(async () => {
    await value.registry.disposeAll();
    await fs.rm(value.root, { recursive: true, force: true });
  });

  const first = value.registry.attach({
    identity: actor,
    clientVersion: 3,
    logicalBinding: "private-conversation-binding-A",
  });
  const firstContext = await first.initialize("DEV");
  await first.dispose();

  const second = value.registry.attach({
    identity: actor,
    clientVersion: 3,
    logicalBinding: "private-conversation-binding-A",
  });
  assert.equal(second.initialized, true);
  const reattachedContext = await second.verify();
  assert.equal(reattachedContext.collaborationSessionId, firstContext.collaborationSessionId);
  assert.equal(reattachedContext.roleAssignment.canonicalRoleId, "implementer");
  await assert.rejects(() => second.initialize("manager"), /different role request/i);

  const sessions = await value.sessionStore.listByActor(actor.agentId);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].collaborationSessionId, firstContext.collaborationSessionId);
});

test("same OAuth actor remains isolated across different trusted bindings", async (t) => {
  const value = await fixture();
  t.after(async () => {
    await value.registry.disposeAll();
    await fs.rm(value.root, { recursive: true, force: true });
  });

  const dev = value.registry.attach({
    identity: actor,
    clientVersion: 1,
    logicalBinding: "private-dev-conversation",
  });
  const manager = value.registry.attach({
    identity: actor,
    clientVersion: 1,
    logicalBinding: "private-manager-conversation",
  });
  const [devContext, managerContext] = await Promise.all([
    dev.initialize("DEV"),
    manager.initialize("manager"),
  ]);

  assert.notEqual(devContext.collaborationSessionId, managerContext.collaborationSessionId);
  assert.equal(devContext.roleAssignment.canonicalRoleId, "implementer");
  assert.equal(managerContext.roleAssignment.canonicalRoleId, "manager");

  const persisted = await fs.readFile(value.sessionStore.statePath, "utf8");
  assert.equal(persisted.includes("private-dev-conversation"), false);
  assert.equal(persisted.includes("private-manager-conversation"), false);
});

test("overlapping attachments prevent premature disposal and expiry cleans up once", async () => {
  let disposeCount = 0;
  let logicalDisposeCount = 0;
  let initialized = false;
  const registry = new CollaborationContextRegistry({
    bindingKeyMaterial: Buffer.alloc(32, 0x24),
    detachGraceSeconds: 1,
    createBootstrap() {
      return {
        get initialized() { return initialized; },
        async initialize() {
          initialized = true;
          return Object.freeze({});
        },
        async verify() {
          if (!initialized) throw new Error("not initialized");
          return Object.freeze({});
        },
        async dispose() {
          disposeCount += 1;
        },
      };
    },
    async onLogicalSessionDispose() {
      logicalDisposeCount += 1;
    },
  });

  const first = registry.attach({
    identity: actor,
    clientVersion: 1,
    logicalBinding: "overlapping-private-binding",
  });
  const second = registry.attach({
    identity: actor,
    clientVersion: 1,
    logicalBinding: "overlapping-private-binding",
  });
  await first.initialize("DEV");
  await first.dispose();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(disposeCount, 0, "one detached transport must not release an entry still in use");
  assert.equal(logicalDisposeCount, 0, "one detached transport must not offline a logical session still in use");
  await second.verify();

  await second.dispose();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(logicalDisposeCount, 1, "the final detach must trigger logical lifecycle cleanup once");
  assert.equal(disposeCount, 1, "the final detach must dispose once after the grace period");
  await registry.disposeAll();
  assert.equal(logicalDisposeCount, 1, "global shutdown must not repeat logical lifecycle cleanup");
  assert.equal(disposeCount, 1, "global shutdown must not double-dispose expired entries");
});

test("same raw binding is isolated across different OAuth actors", async (t) => {
  const value = await fixture();
  t.after(async () => {
    await value.registry.disposeAll();
    await fs.rm(value.root, { recursive: true, force: true });
  });
  const otherActor = Object.freeze({ agentId: "different-oauth-actor", agentName: "Other ChatGPT" });
  const sharedBinding = "private-binding-reused-by-two-actors";
  const first = value.registry.attach({ identity: actor, clientVersion: 1, logicalBinding: sharedBinding });
  const second = value.registry.attach({ identity: otherActor, clientVersion: 1, logicalBinding: sharedBinding });
  const [firstContext, secondContext] = await Promise.all([
    first.initialize("DEV"),
    second.initialize("DEV"),
  ]);
  assert.notEqual(firstContext.collaborationSessionId, secondContext.collaborationSessionId);
  assert.equal(firstContext.agentId, actor.agentId);
  assert.equal(secondContext.agentId, otherActor.agentId);
});

test("binding is scoped to OAuth client credential version", async (t) => {
  const value = await fixture();
  t.after(async () => {
    await value.registry.disposeAll();
    await fs.rm(value.root, { recursive: true, force: true });
  });

  const oldVersion = value.registry.attach({
    identity: actor,
    clientVersion: 1,
    logicalBinding: "same-private-binding",
  });
  const newVersion = value.registry.attach({
    identity: actor,
    clientVersion: 2,
    logicalBinding: "same-private-binding",
  });
  const [oldContext, newContext] = await Promise.all([
    oldVersion.initialize("DEV"),
    newVersion.initialize("DEV"),
  ]);
  assert.notEqual(oldContext.collaborationSessionId, newContext.collaborationSessionId);
});
