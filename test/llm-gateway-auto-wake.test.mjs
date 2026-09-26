import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGatewayWakeUrl,
  gatewayAutoWakeEnabled,
  gatewayYdotoolSocketPath,
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

test("auto-wake is restricted to graphical Linux CLI endpoint launches", () => {
  const base = {
    PI_LLM_GATEWAY_ENABLED: "true",
    PILINK_GATEWAY_LAUNCH: "true",
  };
  assert.equal(gatewayAutoWakeEnabled({ ...base, DISPLAY: ":0" }, "linux"), true);
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
  assert.equal(gatewayAutoWakeEnabled(base, "linux"), false);
  assert.equal(gatewayAutoWakeEnabled({ PI_LLM_GATEWAY_ENABLED: "true", DISPLAY: ":0" }, "linux"), false);
  assert.equal(gatewayAutoWakeEnabled({ PILINK_GATEWAY_LAUNCH: "true", DISPLAY: ":0" }, "linux"), false);
  assert.equal(gatewayAutoWakeEnabled({ ...base, DISPLAY: ":0" }, "darwin"), false);
  assert.equal(gatewayAutoWakeEnabled({ ...base, DISPLAY: ":0", PI_LLM_GATEWAY_AUTO_WAKE: "false" }, "linux"), false);
});

test("wake URLs use only the supported q or prompt query parameter", () => {
  assert.equal(buildGatewayWakeUrl("q"), "https://chatgpt.com/?q=wake");
  assert.equal(buildGatewayWakeUrl("prompt"), "https://chatgpt.com/?prompt=wake");
});

test("ydotool socket follows upstream environment precedence", () => {
  assert.equal(
    gatewayYdotoolSocketPath({ YDOTOOL_SOCKET: "/custom/ydotool.sock", XDG_RUNTIME_DIR: "/run/user/1000" }),
    "/custom/ydotool.sock",
  );
  assert.equal(
    gatewayYdotoolSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" }),
    "/run/user/1000/.ydotool_socket",
  );
  assert.equal(gatewayYdotoolSocketPath({}), "/tmp/.ydotool_socket");
});

test("auto-wake requires queued work or a previously active worker and explicit wake_worker status", () => {
  assert.equal(shouldAutoWakeGateway(status()), true);
  assert.equal(shouldAutoWakeGateway(status({ queued: 0 })), false);
  assert.equal(shouldAutoWakeGateway(status({ queued: 0 }), true), true);
  assert.equal(shouldAutoWakeGateway(status({ next_action: "poll" }), true), false);
  assert.equal(shouldAutoWakeGateway(status({ worker_polling: true })), false);
  assert.equal(shouldAutoWakeGateway(status({ processing_claim: true })), false);
  assert.equal(shouldAutoWakeGateway(status({ state: "released", next_action: "none" })), false);
});
