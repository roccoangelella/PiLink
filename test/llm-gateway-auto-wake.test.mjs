import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGatewayWakeUrl,
  gatewayAutoWakeEnabled,
  shouldAutoWakeGateway,
  startGatewayAutoWakeSupervisor,
} from "../dist/llm-gateway-auto-wake.js";

function status(overrides = {}) {
  return {
    state: "waiting_for_chatgpt", queued: 1, claimed: 0, completed: 0, failed: 0, cancelled: 0,
    worker_polling: false, pending_worker_polls: 0, worker_contact: "never", processing_claim: false,
    oldest_queue_age_ms: 0, next_action: "wake_worker", ...overrides,
  };
}

test("auto-wake is opt-in and restricted to graphical Linux CLI endpoint launches", () => {
  const base = { PI_LLM_GATEWAY_ENABLED: "true", PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" };
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
  assert.equal(gatewayAutoWakeEnabled({ ...base, DISPLAY: ":0" }, "linux"), true);
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: "wayland-0" }, "darwin"), false);
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: "wayland-0", PI_LLM_GATEWAY_AUTO_WAKE: undefined }, "linux"), false);
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: "wayland-0", PI_LLM_GATEWAY_AUTO_WAKE: "false" }, "linux"), false);
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: undefined, DISPLAY: undefined }, "linux"), false);
  assert.equal(gatewayAutoWakeEnabled({ WAYLAND_DISPLAY: "wayland-0", PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" }, "linux"), false);
});

test("wake URLs require one random nonce and the exact prefill phrase", () => {
  const nonce = "0123456789abcdef0123456789abcdef";
  assert.equal(buildGatewayWakeUrl(nonce),
    `https://chatgpt.com/?q=%40PiLink-desktop%20wake%20up&pilink_wake=${nonce}`);
  assert.throws(() => buildGatewayWakeUrl("not-a-nonce"));
  assert.throws(() => buildGatewayWakeUrl("../123456789abcdef0123456789abcdef"));
});

test("wake needs queued work or a previously active worker and explicit wake_worker status", () => {
  assert.equal(shouldAutoWakeGateway(status()), true);
  assert.equal(shouldAutoWakeGateway(status({ queued: 0 })), false);
  assert.equal(shouldAutoWakeGateway(status({ queued: 0 }), true), true);
  assert.equal(shouldAutoWakeGateway(status({ next_action: "poll" }), true), false);
  assert.equal(shouldAutoWakeGateway(status({ worker_polling: true })), false);
  assert.equal(shouldAutoWakeGateway(status({ processing_claim: true })), false);
  assert.equal(shouldAutoWakeGateway(status({ state: "released", next_action: "none" })), false);
});

test("supervisor opens only once per persistent wake condition and waits for real worker contact", async () => {
  let state = status();
  let opens = 0;
  const logs = [];
  const supervisor = startGatewayAutoWakeSupervisor({
    store: { status: async () => state },
    env: { WAYLAND_DISPLAY: "wayland-0", PI_LLM_GATEWAY_ENABLED: "true", PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" },
    platform: "linux", driver: { wake: async () => { opens++; } }, pollIntervalMs: 5,
    wakeGraceMs: 0, confirmationMs: 40, log: (message) => logs.push(message),
  });
  assert.ok(supervisor);
  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(opens, 1);
    assert.ok(logs.some((line) => /no worker contact/.test(line)));
    state = status({ worker_polling: true, next_action: "poll" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(opens, 1);
  } finally {
    supervisor.close();
  }
});
