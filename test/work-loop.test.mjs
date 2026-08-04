import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentWorkLoopStore,
  computeAgentWaitSeconds,
  makeAgentTaskBoardToken,
} from "../dist/work-loop.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-work-loop-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  return { root, workspace, dataDir };
}

const worker = {
  collaborationSessionId: "cs_AAAAAAAAAAAAAAAAAAAAAAAA",
  agentId: "worker-agent",
  agentName: "Worker Agent",
  canonicalRoleId: "implementer",
  occupancyLabel: "dev1",
};

test("persists waiting lifecycle, bounded backoff, manager release provenance, and non-revival", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  let nowMs = Date.parse("2026-08-03T20:00:00.000Z");
  const store = new AgentWorkLoopStore({
    workspace: value.workspace,
    dataDir: value.dataDir,
    now: () => new Date(nowMs),
  });

  const registered = await store.register(worker);
  assert.equal(registered.lifecycle, "working");
  assert.equal(registered.revision, 1);
  await assert.rejects(
    store.releaseByManager({
      managerCollaborationSessionId: "cs_BBBBBBBBBBBBBBBBBBBBBBBB",
      targetCollaborationSessionId: worker.collaborationSessionId,
      expectedRevision: registered.revision,
      reason: "Must not release an active worker",
    }),
    /waiting_for_task or offline/,
  );

  nowMs += 1_000;
  const waiting = await store.markWaiting(worker.collaborationSessionId);
  assert.equal(waiting.lifecycle, "waiting_for_task");
  assert.equal(waiting.revision, 2);

  const token = makeAgentTaskBoardToken("[]");
  nowMs += 1_000;
  const timedOut = await store.recordOutcome({
    collaborationSessionId: worker.collaborationSessionId,
    changed: false,
    chatCursor: 4,
    taskBoardToken: token,
  });
  assert.equal(timedOut.lifecycle, "waiting_for_task");
  assert.equal(timedOut.consecutiveTimeouts, 1);
  assert.equal(timedOut.lastChatCursor, 4);
  assert.equal(timedOut.taskBoardToken, token);

  assert.equal(computeAgentWaitSeconds(0, 30, () => 0), 1);
  assert.equal(computeAgentWaitSeconds(4, 30, () => 0), 8);
  assert.equal(computeAgentWaitSeconds(20, 30, () => 0.999), 30);

  await assert.rejects(
    store.releaseByManager({
      managerCollaborationSessionId: "cs_BBBBBBBBBBBBBBBBBBBBBBBB",
      targetCollaborationSessionId: worker.collaborationSessionId,
      expectedRevision: timedOut.revision - 1,
      reason: "No longer needed",
    }),
    /Stale work-state revision/,
  );

  nowMs += 1_000;
  const released = await store.releaseByManager({
    managerCollaborationSessionId: "cs_BBBBBBBBBBBBBBBBBBBBBBBB",
    targetCollaborationSessionId: worker.collaborationSessionId,
    expectedRevision: timedOut.revision,
    reason: "Milestone complete; worker is no longer needed",
  });
  assert.equal(released.lifecycle, "released");
  assert.equal(released.releasedByCollaborationSessionId, "cs_BBBBBBBBBBBBBBBBBBBBBBBB");
  assert.match(released.releaseReason, /Milestone complete/);

  const repeatedRegister = await store.register(worker);
  assert.equal(repeatedRegister.lifecycle, "released");
  assert.equal(repeatedRegister.revision, released.revision);

  const reopenedStore = new AgentWorkLoopStore({ workspace: value.workspace, dataDir: value.dataDir });
  const persisted = await reopenedStore.get(worker.collaborationSessionId);
  assert.equal(persisted.lifecycle, "released");
  assert.equal(persisted.releasedByCollaborationSessionId, "cs_BBBBBBBBBBBBBBBBBBBBBBBB");
});

test("authoritative collaboration-session loss reconciles crash orphans to offline", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  let sessionStatus = "active";
  const collaborationSessionStore = {
    async listByActor(agentId) {
      assert.equal(agentId, worker.agentId);
      return sessionStatus === "missing"
        ? []
        : [{ collaborationSessionId: worker.collaborationSessionId, status: sessionStatus }];
    },
  };
  const store = new AgentWorkLoopStore({
    workspace: value.workspace,
    dataDir: value.dataDir,
    collaborationSessionStore,
  });

  const registered = await store.register(worker);
  assert.equal(registered.lifecycle, "working");
  sessionStatus = "revoked";
  const reconciled = await store.get(worker.collaborationSessionId);
  assert.equal(reconciled.lifecycle, "offline");
  assert.equal(reconciled.revision, registered.revision + 1);
  assert.equal(reconciled.releasedByCollaborationSessionId, undefined);
});

test("disconnect is offline rather than permanent release and can reconnect", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const store = new AgentWorkLoopStore({ workspace: value.workspace, dataDir: value.dataDir });
  await store.register(worker);
  const offline = await store.disconnect(worker.collaborationSessionId);
  assert.equal(offline.lifecycle, "offline");
  assert.equal(offline.releasedByCollaborationSessionId, undefined);

  const resumed = await store.register(worker);
  assert.equal(resumed.lifecycle, "working");
  assert.equal(resumed.consecutiveTimeouts, 0);
});
