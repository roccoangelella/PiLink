import assert from "node:assert/strict";
import test from "node:test";
import { gatewayApiPortForMcp, selectGatewayPorts } from "../dist/llm-gateway-ports.js";

test("gateway derives its local API port ten above MCP", () => {
  assert.equal(gatewayApiPortForMcp(3200), 3210);
  assert.equal(gatewayApiPortForMcp(3201), 3211);
});

test("gateway falls from occupied 3200 to 3201 and moves the API pair with it", async () => {
  const probed = [];
  const selection = await selectGatewayPorts(3200, undefined, async (port) => {
    probed.push(port);
    return port !== 3200;
  });

  assert.equal(selection.requestedMcpPort, 3200);
  assert.equal(selection.requestedApiPort, 3210);
  assert.equal(selection.mcpPort, 3201);
  assert.equal(selection.apiPort, 3211);
  assert.equal(selection.changed, true);
  assert.deepEqual(probed.slice(0, 3), [3200, 3201, 3211]);
});

test("gateway skips a candidate whose derived API port is occupied", async () => {
  const unavailable = new Set([3200, 3211]);
  const selection = await selectGatewayPorts(3200, undefined, async (port) => !unavailable.has(port));
  assert.equal(selection.mcpPort, 3202);
  assert.equal(selection.apiPort, 3212);
});

test("an explicit busy gateway API port fails instead of silently changing operator configuration", async () => {
  await assert.rejects(
    selectGatewayPorts(3200, 4100, async (port) => port !== 4100),
    /Configured gateway API port 4100 is already in use/,
  );
});
