import { createMcpServer as createCoreMcpServer } from "./mcp-core.js";
import { authenticatedHarnessClientId } from "./harness.js";
import { createGatewayMcpServer, gatewayWorkerSessionId } from "./llm-gateway-mcp.js";
import { gatewayModeEnabled, getLlmGatewayRuntime } from "./llm-gateway-runtime.js";

export * from "./mcp-core.js";

// `pilink gateway start` loads the private PiLink configuration in the parent
// CLI before it spawns the server process, so normal gateway launches can make
// the loopback completion endpoint available immediately. Direct development
// launches may import this module before configuration is loaded; in that case
// initialization is safely retried on the first authenticated MCP connection.
if (gatewayModeEnabled()) {
  try {
    getLlmGatewayRuntime();
  } catch {
    // Deferred initialization is intentional for raw/development entrypoints.
  }
}

export function createMcpServer(
  ...args: Parameters<typeof createCoreMcpServer>
): ReturnType<typeof createCoreMcpServer> {
  if (!gatewayModeEnabled()) return createCoreMcpServer(...args);

  const runtime = getLlmGatewayRuntime();
  const scopes = args[1];
  const explicitAgentInstanceId = args[5];
  const oauthClientId = authenticatedHarnessClientId(args[0]);
  const workerSessionId = explicitAgentInstanceId ?? (oauthClientId ? gatewayWorkerSessionId(oauthClientId) : undefined);
  return createGatewayMcpServer(
    scopes,
    { store: runtime.store },
    workerSessionId,
  );
}
