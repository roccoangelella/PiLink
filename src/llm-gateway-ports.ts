import { createServer } from "node:net";

const DEFAULT_MCP_PORT = 3200;
const MAX_PORT_SCAN_ATTEMPTS = 64;

export interface GatewayPortSelection {
  requestedMcpPort: number;
  requestedApiPort: number;
  mcpPort: number;
  apiPort: number;
  changed: boolean;
}

export type GatewayPortProbe = (port: number) => Promise<boolean>;

export function gatewayApiPortForMcp(mcpPort: number): number {
  assertPort(mcpPort, "MCP port");
  return mcpPort <= 65_525 ? mcpPort + 10 : 3210;
}

export async function selectGatewayPorts(
  requestedMcpPort: number,
  explicitApiPort?: number,
  probe: GatewayPortProbe = isLoopbackPortAvailable,
): Promise<GatewayPortSelection> {
  assertPort(requestedMcpPort, "MCP port");
  if (explicitApiPort !== undefined) assertPort(explicitApiPort, "PI_LLM_GATEWAY_PORT");

  if (explicitApiPort !== undefined && !await probe(explicitApiPort)) {
    throw new Error(`Configured gateway API port ${explicitApiPort} is already in use.`);
  }

  for (let offset = 0; offset < MAX_PORT_SCAN_ATTEMPTS; offset += 1) {
    const mcpPort = scanPort(requestedMcpPort, offset);
    const apiPort = explicitApiPort ?? gatewayApiPortForMcp(mcpPort);
    if (mcpPort === apiPort) continue;
    if (!await probe(mcpPort)) continue;
    if (explicitApiPort === undefined && !await probe(apiPort)) continue;
    return {
      requestedMcpPort,
      requestedApiPort: explicitApiPort ?? gatewayApiPortForMcp(requestedMcpPort),
      mcpPort,
      apiPort,
      changed: mcpPort !== requestedMcpPort || apiPort !== (explicitApiPort ?? gatewayApiPortForMcp(requestedMcpPort)),
    };
  }

  throw new Error(
    `PiLink gateway could not find a free MCP/API loopback port pair after ${MAX_PORT_SCAN_ATTEMPTS} attempts starting at ${requestedMcpPort}.`,
  );
}

export function isLoopbackPortAvailable(port: number): Promise<boolean> {
  assertPort(port, "port");
  return new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const finish = (available: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(available);
    };
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") finish(false);
      else finish(false, error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => finish(!error, error || undefined));
    });
  });
}

function scanPort(start: number, offset: number): number {
  const candidate = start + offset;
  if (candidate <= 65_535) return candidate;
  return 1024 + ((candidate - 65_536) % (65_535 - 1024 + 1));
}

function assertPort(port: number, label: string): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer from 1 through 65535.`);
  }
}

export const GATEWAY_DEFAULT_MCP_PORT = DEFAULT_MCP_PORT;
