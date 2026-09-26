import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGatewayWakeUrl,
  gatewayAutoWakeEnabled,
  shouldAutoWakeGateway,
} from "../dist/llm-gateway-auto-wake.js";

function status(overrides = {}) {
  return {
    state: "waiting_for_chatgpt",
    queued: 1,
    claimed: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    worker_polling: false,
    pending_worker_polls: 0,
    worker_contact: "never",
    processing_claim: false,
    oldest_queue_age_ms: 0,
    next_action: "wake_worker",
    ...overrides,
  };
}

test("auto-wake is restricted to Linux CLI endpoint launches", () => {
  const cliGatewayEnv = {
    PI_LLM_GATEWAY_ENABLED: "true",
    PILINK_GATEWAY_LAUNCH: "true",
  };
  assert.equal(gatewayAutoWakeEnabled(cliGatewayEnv, "linux"), true);
  assert.equal(gatewayAutoWakeEnabled({ PI_LLM_GATEWAY_ENABLED: "true" }, "linux"), false);
  assert.equal(gatewayAutoWakeEnabled({ PILINK_GATEWAY_LAUNCH: "true" }, "linux"), false);
  assert.equal(gatewayAutoWakeEnabled(cliGatewayEnv, "darwin"), false);
  assert.equal(gatewayAutoWakeEnabled({ ...cliGatewayEnv, PI_LLM_GATEWAY_AUTO_WAKE: "false" }, "linux"), false);
});

test("wake URLs use only the supported q or prompt query parameter", () => {
  assert.equal(buildGatewayWakeUrl("q"), "https://chatgpt.com/?q=%40PiLink+wake");
  assert.equal(buildGatewayWakeUrl("prompt"), "https://chatgpt.com/?prompt=%40PiLink+wake");
});

test("auto-wake requires queued work and an explicit wake_worker status", () => {
  assert.equal(shouldAutoWakeGateway(status()), true);
  assert.equal(shouldAutoWakeGateway(status({ queued: 0 })), false);
  assert.equal(shouldAutoWakeGateway(status({ next_action: "poll" })), false);
  assert.equal(shouldAutoWakeGateway(status({ worker_polling: true })), false);
  assert.equal(shouldAutoWakeGateway(status({ processing_claim: true })), false);
  assert.equal(shouldAutoWakeGateway(status({ state: "released", next_action: "none" })), false);
});
