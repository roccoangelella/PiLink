import assert from "node:assert/strict";
import test from "node:test";
import { effectiveProcessState } from "../src/dashboard-model.js";

test("a persistent authenticated runtime cannot be reported as stopped", () => {
  const supervised = { status: "stopped" as const, awaitingInput: false };
  assert.deepEqual(effectiveProcessState(supervised, true, "unknown", "unknown"), {
    status: "running",
    awaitingInput: false,
    mode: "Detected service",
  });
  assert.deepEqual(effectiveProcessState(supervised, false, "active", "active"), {
    status: "running",
    awaitingInput: false,
    mode: "Persistent service",
  });
});

test("offline and transitional supervised states are preserved", () => {
  assert.deepEqual(
    effectiveProcessState({ status: "stopped", awaitingInput: false }, false, "inactive", "inactive"),
    { status: "stopped", awaitingInput: false },
  );
  assert.deepEqual(
    effectiveProcessState({ status: "starting", awaitingInput: false }, true, "active", "active"),
    { status: "starting", awaitingInput: false },
  );
});
