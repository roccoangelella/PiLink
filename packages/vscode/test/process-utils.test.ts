import assert from "node:assert/strict";
import test from "node:test";
import { VSPILINK_SHUTDOWN_MESSAGE, windowsTaskkillArgs } from "../src/process-utils.js";

test("Windows shutdown uses a forced process-tree kill fallback", () => {
  assert.deepEqual(VSPILINK_SHUTDOWN_MESSAGE, { type: "vspilink.shutdown" });
  assert.deepEqual(windowsTaskkillArgs(4321), ["/PID", "4321", "/T", "/F"]);
  assert.throws(() => windowsTaskkillArgs(0), /Invalid process ID/);
  assert.throws(() => windowsTaskkillArgs(Number.NaN), /Invalid process ID/);
});
