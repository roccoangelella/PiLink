import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";

/**
 * Preserve the server process environment for workspace commands and child
 * agents, including credentials. NUL-bearing values are still omitted because
 * operating systems cannot represent them in a spawned process environment.
 */
export function filterExecutionEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const forwarded: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string" || value.includes("\0")) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

/** Spawn hook shared by direct MCP bash and supervised Pi child agents. */
export function sanitizeExecutionSpawnContext(context: BashSpawnContext): BashSpawnContext {
  return {
    ...context,
    env: filterExecutionEnvironment(context.env),
  };
}
