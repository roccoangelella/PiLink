import assert from "node:assert/strict";
import test from "node:test";
import { loadRuntimeConfig, parseComputerControlClientIds } from "../dist/config.js";
import { createHarnessPolicy } from "../dist/harness.js";

function baseEnv(overrides = {}) {
  return {
    PI_RUNTIME_MODE: "single",
    PI_WORK_DIR: process.cwd(),
    PI_DATA_DIR: process.cwd(),
    JWT_SECRET: "j".repeat(32),
    PI_BOOTSTRAP_SECRET: "b".repeat(32),
    ...overrides,
  };
}

test("computer-control client allowlists are validated and deduplicated", () => {
  assert.deepEqual(
    parseComputerControlClientIds("pi_1111111111111111, pi_2222222222222222 pi_1111111111111111"),
    ["pi_1111111111111111", "pi_2222222222222222"],
  );
  assert.deepEqual(parseComputerControlClientIds("*"), ["*"]);
  assert.throws(
    () => parseComputerControlClientIds("not-a-client"),
    /PI_COMPUTER_CONTROL_CLIENT_IDS/,
  );
});

test("computer control fails closed outside Single agent mode", () => {
  assert.throws(() => loadRuntimeConfig(baseEnv({
    PI_RUNTIME_MODE: "collaboration",
    PI_COMPUTER_CONTROL: "true",
    PI_COMPUTER_CONTROL_CLIENT_IDS: "*",
  })), /only when PI_RUNTIME_MODE=single/);
});

test("computer control requires an explicit client allowlist", () => {
  assert.throws(() => loadRuntimeConfig(baseEnv({
    PI_COMPUTER_CONTROL: "true",
  })), /PI_COMPUTER_CONTROL_CLIENT_IDS/);
});

test("computer control is granted independently per OAuth client", () => {
  const config = loadRuntimeConfig(baseEnv({
    PI_COMPUTER_CONTROL: "true",
    PI_COMPUTER_CONTROL_CLIENT_IDS: "pi_1111111111111111",
  }));

  assert.equal(createHarnessPolicy(config).computerControl, false);
  assert.equal(createHarnessPolicy(config, "pi_1111111111111111").computerControl, true);
  assert.equal(createHarnessPolicy(config, "pi_2222222222222222").computerControl, false);
  assert.equal(createHarnessPolicy(config, "pi_1111111111111111").unsafeFullAccess, false);
});
