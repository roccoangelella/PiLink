import assert from "node:assert/strict";
import test from "node:test";
import { startProgressReporter } from "../dist/progress.js";

test("emits ordered rate-limited progress and stops after finish", async () => {
  const notifications = [];
  const reporter = await startProgressReporter({
    _meta: { progressToken: "progress-1" },
    async sendNotification(notification) {
      notifications.push(notification);
    },
  }, "run npm_test", { intervalMs: 10 });

  await new Promise((resolve) => setTimeout(resolve, 36));
  await reporter.finish("run npm_test completed");
  const countAfterFinish = notifications.length;
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(notifications.length, countAfterFinish);
  assert.ok(notifications.length >= 4);
  assert.deepEqual(
    notifications.map((notification) => notification.params.progress),
    Array.from({ length: notifications.length }, (_, index) => index),
  );
  assert.ok(notifications.every((notification) => notification.method === "notifications/progress"));
  assert.ok(notifications.every((notification) => notification.params.progressToken === "progress-1"));
  assert.equal(notifications[0].params.message, "run npm_test started");
  assert.match(notifications.at(-1).params.message, /completed$/);
  assert.ok(notifications.slice(1, -1).every((notification) => /running for \d+s$/.test(notification.params.message)));
});

test("does nothing without a client progress token", async () => {
  let sends = 0;
  const reporter = await startProgressReporter({
    async sendNotification() {
      sends += 1;
    },
  }, "run git_status", { intervalMs: 1 });

  await new Promise((resolve) => setTimeout(resolve, 5));
  await reporter.finish("run git_status completed");
  assert.equal(sends, 0);
});

test("notification failures never fail the operation", async () => {
  let sends = 0;
  const reporter = await startProgressReporter({
    _meta: { progressToken: 42 },
    async sendNotification() {
      sends += 1;
      throw new Error("transport unavailable");
    },
  }, "run git_log", { intervalMs: 5 });

  await new Promise((resolve) => setTimeout(resolve, 12));
  await reporter.finish("run git_log failed");
  assert.ok(sends >= 2);
});

test("validates the heartbeat interval when progress is requested", async () => {
  await assert.rejects(
    startProgressReporter({
      _meta: { progressToken: "invalid" },
      async sendNotification() {},
    }, "run git_status", { intervalMs: 0 }),
    /positive safe integer/,
  );
});
