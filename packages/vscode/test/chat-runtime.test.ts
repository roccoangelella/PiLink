import assert from "node:assert/strict";
import test from "node:test";
import {
  agentOAuthMethodChoices,
  hasConfiguredAgentAuth,
  inspectAdminAgentRuntime,
  stableDashboardHealth,
} from "../src/chat-runtime.js";

test("authenticated admin payload is authoritative for Pi agent readiness", () => {
  assert.deepEqual(inspectAdminAgentRuntime({
    agents: { state: "degraded", runtime: { state: "ready", id: "pi-sdk" } },
  }), { ready: true, state: "degraded", runtimeState: "ready" });
  assert.deepEqual(inspectAdminAgentRuntime({
    agents: { state: "disabled", runtime: { state: "disabled" } },
  }), { ready: false, state: "disabled", runtimeState: "disabled" });
  assert.equal(inspectAdminAgentRuntime(null).ready, false);
});

test("legacy PI_AGENT_API_KEY contributes only a non-secret auth readiness bit", () => {
  const secret = "legacy-secret-that-must-not-be-returned";
  const ready = hasConfiguredAgentAuth({ PI_AGENT_API_KEY: secret });
  assert.equal(ready, true);
  assert.equal(typeof ready, "boolean");
  assert.equal(JSON.stringify({ authReady: ready }).includes(secret), false);
  assert.equal(hasConfiguredAgentAuth({}, "oauth"), true);
  assert.equal(hasConfiguredAgentAuth({ PI_AGENT_API_KEY: "   " }), false);
});

test("dashboard health drops volatile and proof fields", () => {
  assert.deepEqual(stableDashboardHealth({
    server: "pilink",
    status: "ok",
    timestamp: "changes-every-poll",
    challenge: "private-challenge",
    proof: "private-proof",
    sessions: { active: 1 },
  }), {
    server: "pilink",
    status: "ok",
    sessions: { active: 1 },
  });
});

test("Remote SSH recommends device code before loopback browser OAuth", () => {
  assert.deepEqual(agentOAuthMethodChoices("ssh-remote").map((entry) => entry.value), ["device_code", "browser"]);
  assert.match(agentOAuthMethodChoices("ssh-remote")[0].description, /recommended over Remote SSH/);
  assert.deepEqual(agentOAuthMethodChoices().map((entry) => entry.value), ["browser", "device_code"]);
});
