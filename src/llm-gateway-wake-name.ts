export const DEFAULT_GATEWAY_CONNECTOR_NAME = "PiLink Gateway";

/** The name must be exactly the ChatGPT connector's display name, without @. */
export function validateGatewayConnectorName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 64 || /[@#\\\p{C}]/u.test(name) ||
      !/^[\p{L}\p{N}][\p{L}\p{N}\p{M}\p{P}\p{S} ]*$/u.test(name)) {
    throw new Error("ChatGPT connector name must start with a letter or number, use at most 64 characters, and contain no @, #, backslash or control characters.");
  }
  return name;
}

export function gatewayConnectorName(env: NodeJS.ProcessEnv = process.env): string {
  return validateGatewayConnectorName(env.PI_LLM_GATEWAY_CONNECTOR_NAME || DEFAULT_GATEWAY_CONNECTOR_NAME);
}

export function gatewayWakeText(env: NodeJS.ProcessEnv = process.env): string {
  return `@${gatewayConnectorName(env)} wake up`;
}
