export interface AgentRuntimeInspection {
  ready: boolean;
  state: string;
  runtimeState: string;
}

export interface AgentOAuthMethodChoice {
  label: string;
  description: string;
  value: "browser" | "device_code";
}

/** Interpret only the non-secret runtime status returned by /admin/status. */
export function inspectAdminAgentRuntime(payload: Record<string, unknown> | null): AgentRuntimeInspection {
  const agents = record(payload?.agents);
  const runtime = record(agents?.runtime);
  const state = safeState(agents?.state, "unavailable");
  const runtimeState = safeState(runtime?.state, "unavailable");
  return { ready: runtimeState === "ready", state, runtimeState };
}

/**
 * Return a readiness bit without ever copying provider credentials into the
 * dashboard state. PI_AGENT_API_KEY remains supported for legacy installs.
 */
export function hasConfiguredAgentAuth(
  values: Readonly<Record<string, string>>,
  configuredAuthType?: string,
): boolean {
  return Boolean(configuredAuthType || values.PI_AGENT_API_KEY?.trim());
}

/** Remove request-time fields so routine health polling does not repaint UI. */
export function stableDashboardHealth(payload: Record<string, unknown> | null): Record<string, unknown> {
  if (!payload) return {};
  const stable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "timestamp" || key === "challenge" || key === "proof") continue;
    stable[key] = value;
  }
  return stable;
}

/** Loopback browser OAuth is unreliable when the extension host is remote. */
export function agentOAuthMethodChoices(remoteName?: string): AgentOAuthMethodChoice[] {
  const browser: AgentOAuthMethodChoice = {
    label: "Automatic browser",
    description: remoteName
      ? "Requires the localhost callback to be forwarded to the remote server"
      : "Opens the OAuth page immediately (recommended)",
    value: "browser",
  };
  const device: AgentOAuthMethodChoice = {
    label: "Device code",
    description: remoteName
      ? "Copies the code and opens verification (recommended over Remote SSH)"
      : "Copies the code and opens the verification page",
    value: "device_code",
  };
  return remoteName ? [device, browser] : [browser, device];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeState(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9_.-]{1,80}$/i.test(value) ? value : fallback;
}
