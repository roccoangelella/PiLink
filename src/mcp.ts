import { createMcpServer as createCoreMcpServer } from "./mcp-core.js";
import { createGatewayMcpServer } from "./llm-gateway-mcp.js";
import { gatewayModeEnabled, getLlmGatewayRuntime } from "./llm-gateway-runtime.js";

export * from "./mcp-core.js";

export function createMcpServer(
  ...args: Parameters<typeof createCoreMcpServer>
): ReturnType<typeof createCoreMcpServer> {
  if (!gatewayModeEnabled()) return createCoreMcpServer(...args);

  const runtime = getLlmGatewayRuntime();
  const scopes = args[1];
  const agentInstanceId = args[5];
  return createGatewayMcpServer(
    scopes,
    { store: runtime.store },
    agentInstanceId,
  );
}
