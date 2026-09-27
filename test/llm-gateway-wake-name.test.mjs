import assert from "node:assert/strict";
import test from "node:test";
import { gatewayConnectorName, gatewayWakeText, validateGatewayConnectorName } from "../dist/llm-gateway-wake-name.js";
import { buildGatewayWakeUrl } from "../dist/llm-gateway-auto-wake.js";

const nonce = "0123456789abcdef0123456789abcdef";

test("gateway wake mentions the exact chosen ChatGPT connection name", () => {
  const env = { PI_LLM_GATEWAY_CONNECTOR_NAME: "My Coding Connector" };
  assert.equal(gatewayConnectorName(env), "My Coding Connector");
  assert.equal(gatewayWakeText(env), "@My Coding Connector wake up");
  assert.equal(new URL(buildGatewayWakeUrl(nonce, env)).searchParams.get("q"), gatewayWakeText(env));
  assert.equal(gatewayWakeText({}), "@PiLink Gateway wake up");
});

test("gateway names reject terminal controls and message injection", () => {
  for (const value of ["", "@Other", "oops\nwake", "foo\u001b[31m", "<script>", "a".repeat(65)]) {
    assert.throws(() => validateGatewayConnectorName(value), /connector name/);
  }
  assert.equal(validateGatewayConnectorName("  PiLink UX-2  "), "PiLink UX-2");
  assert.equal(validateGatewayConnectorName("Équipe de code"), "Équipe de code");
  assert.equal(validateGatewayConnectorName("PiLink + Work"), "PiLink + Work");
});
