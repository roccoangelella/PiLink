import assert from "node:assert/strict";
import test from "node:test";
import {
  dependencySummary,
  taskColumn,
  updateCollaborationDashboardState,
} from "../src/collaboration-model.js";
import type { CollaborationTaskView } from "../src/health.js";

function task(overrides: Partial<CollaborationTaskView> = {}): CollaborationTaskView {
  return {
    taskId: "task-1",
    title: "Implement board",
    status: "open",
    priority: "P1",
    dependencies: [],
    eligibleRoleIds: ["implementer"],
    requiredCapabilities: ["workspace-read"],
    risk: "medium",
    createdBy: "Manager",
    createdAt: "2026-09-10T10:00:00.000Z",
    updatedAt: "2026-09-10T10:00:00.000Z",
    revision: 1,
    actions: { provideInput: false, cancel: false, release: false },
    ...overrides,
  };
}

test("collaboration state keeps the last good snapshot when refresh degrades", () => {
  const ready = updateCollaborationDashboardState(undefined, {
    online: true,
    board: {
      status: "ready",
      tasks: [task()],
      participants: [],
      timestamp: "2026-09-10T10:00:00.000Z",
    },
  }, new Date("2026-09-10T10:00:01.000Z"));
  assert.equal(ready.status, "ready");
  assert.equal(ready.tasks.length, 1);

  const stale = updateCollaborationDashboardState(ready, {
    online: false,
    board: null,
    error: "admin timeout",
  }, new Date("2026-09-10T10:01:00.000Z"));
  assert.equal(stale.status, "stale");
  assert.deepEqual(stale.tasks, ready.tasks);
  assert.equal(stale.error, "admin timeout");
  assert.equal(stale.sourceTimestamp, ready.sourceTimestamp);
});

test("collaboration state exposes an explicit error before any good snapshot", () => {
  const state = updateCollaborationDashboardState(undefined, {
    online: false,
    board: null,
    error: "offline",
  }, new Date("2026-09-10T10:00:00.000Z"));
  assert.deepEqual(state.tasks, []);
  assert.equal(state.status, "error");
  assert.equal(state.error, "offline");
});

test("task columns cover ready, working, blocked, not-before, and terminal states", () => {
  const ready = task({ taskId: "ready" });
  const dependency = task({ taskId: "dep", status: "working" });
  const blocked = task({ taskId: "blocked", dependencies: [{ taskId: "dep", condition: "completed" }] });
  const future = task({ taskId: "future", notBefore: "2026-09-10T12:00:00.000Z" });
  const tasks = [ready, dependency, blocked, future];
  const now = new Date("2026-09-10T11:00:00.000Z");
  assert.equal(taskColumn(ready, tasks, now), "open");
  assert.equal(taskColumn(dependency, tasks, now), "working");
  assert.equal(taskColumn(blocked, tasks, now), "blocked");
  assert.equal(taskColumn(future, tasks, now), "blocked");
  assert.equal(taskColumn(task({ status: "input_required" }), tasks, now), "blocked");
  assert.equal(taskColumn(task({ status: "completed" }), tasks, now), "done");
  assert.equal(taskColumn(task({ status: "failed" }), tasks, now), "done");
  assert.equal(taskColumn(task({ status: "cancelled" }), tasks, now), "done");
});

test("dependency readiness distinguishes satisfied and blocked open work", () => {
  const dependency = task({ taskId: "dep", status: "working" });
  const dependent = task({ taskId: "child", dependencies: [{ taskId: "dep", condition: "completed" }] });
  assert.equal(dependencySummary(dependent, [dependency, dependent]), "1 blocker");
  assert.equal(dependencySummary(dependent, [{ ...dependency, status: "completed" }, dependent]), "Ready");
});
