import dotenv from "dotenv";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "2.2.0";

export interface RuntimeConfig {
  port: number;
  host: string;
  serverUrl: string;
  landingHostname?: string;
  workspace: string;
  dataDir: string;
  coordinationDataDir: string;
  jwtSecret: string;
  bootstrapSecret: string;
  tokenExpirySeconds: number;
  refreshTokenExpirySeconds: number;
  oauthConsentMode: "browser" | "paired";
  publicChatGptDcr: boolean;
  unsafeFullAccess: boolean;
  fullAccessClientIds: readonly string[];
  allowWorkspaceExecution: boolean;
  requireExecutionApproval: boolean;
  maxBashTimeoutSeconds: number;
  maxMcpSessionsTotal: number;
  maxMcpSessionsPerClient: number;
  mcpSessionIdleTimeoutSeconds: number;
  mcpSessionReclaimGraceSeconds: number;
  collaborationBindingHeader?: string;
  collaborationBindingDetachGraceSeconds: number;
  corsOrigins: string[];
  trustProxy: boolean;
  agentProvider?: string;
  agentModel?: string;
  agentApiKey?: string;
  agentThinkingLevel: "minimal" | "low" | "medium" | "high" | "xhigh";
  maxConcurrentAgents: number;
}

export function defaultConfigPath(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "pilink", ".env");
}

export function defaultCoordinationDataDir(
  activeConfigPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredRuntime = env.XDG_RUNTIME_DIR;
  const uidRuntime = typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "";
  const runtimeRoot = configuredRuntime && path.isAbsolute(configuredRuntime)
    ? configuredRuntime
    : uidRuntime && fs.existsSync(uidRuntime)
      ? uidRuntime
      : os.tmpdir();
  const instanceKey = createHash("sha256").update(path.resolve(activeConfigPath)).digest("hex").slice(0, 16);
  return path.join(runtimeRoot, "vspilink", instanceKey, "coordination");
}

export function loadEnvironment(): void {
  const inheritedEnvironment = { ...process.env };
  dotenv.config();
  dotenv.config({ path: process.env.PILINK_CONFIG || defaultConfigPath(), override: true });
  Object.assign(process.env, inheritedEnvironment);
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const port = positiveInteger(env.PORT, 3200, "PORT");
  const tokenExpirySeconds = positiveInteger(env.TOKEN_EXPIRY, 60 * 60, "TOKEN_EXPIRY");
  const refreshTokenExpirySeconds = positiveInteger(env.PI_REFRESH_TOKEN_EXPIRY, 30 * 24 * 60 * 60, "PI_REFRESH_TOKEN_EXPIRY");
  const oauthConsentMode = env.PI_OAUTH_CONSENT_MODE || "browser";
  if (oauthConsentMode !== "browser" && oauthConsentMode !== "paired") {
    throw new Error("PI_OAUTH_CONSENT_MODE must be 'browser' or 'paired'");
  }
  const maxBashTimeoutSeconds = positiveInteger(env.PI_MAX_BASH_TIMEOUT, 120, "PI_MAX_BASH_TIMEOUT");
  const maxMcpSessionsTotal = positiveInteger(env.PI_MAX_MCP_SESSIONS_TOTAL, 64, "PI_MAX_MCP_SESSIONS_TOTAL");
  const maxMcpSessionsPerClient = positiveInteger(env.PI_MAX_MCP_SESSIONS_PER_CLIENT, 16, "PI_MAX_MCP_SESSIONS_PER_CLIENT");
  const mcpSessionIdleTimeoutSeconds = positiveInteger(env.PI_MCP_SESSION_IDLE_TIMEOUT, 10 * 60, "PI_MCP_SESSION_IDLE_TIMEOUT");
  const mcpSessionReclaimGraceSeconds = positiveInteger(env.PI_MCP_SESSION_RECLAIM_GRACE, 5, "PI_MCP_SESSION_RECLAIM_GRACE");
  const collaborationBindingDetachGraceSeconds = positiveInteger(
    env.PI_COLLABORATION_BINDING_DETACH_GRACE,
    10 * 60,
    "PI_COLLABORATION_BINDING_DETACH_GRACE",
  );
  const collaborationBindingHeader = optionalHeaderName(
    env.PI_COLLABORATION_BINDING_HEADER,
    "PI_COLLABORATION_BINDING_HEADER",
  );
  const maxConcurrentAgents = positiveInteger(env.PI_AGENT_MAX_CONCURRENT, 4, "PI_AGENT_MAX_CONCURRENT");
  if (maxConcurrentAgents > 32) throw new Error("PI_AGENT_MAX_CONCURRENT cannot exceed 32");
  const agentProvider = optionalIdentifier(env.PI_AGENT_PROVIDER, "PI_AGENT_PROVIDER");
  const agentModel = optionalIdentifier(env.PI_AGENT_MODEL, "PI_AGENT_MODEL");
  if (Boolean(agentProvider) !== Boolean(agentModel)) {
    throw new Error("PI_AGENT_PROVIDER and PI_AGENT_MODEL must be configured together");
  }
  const agentThinkingLevel = env.PI_AGENT_THINKING_LEVEL || "medium";
  if (!["minimal", "low", "medium", "high", "xhigh"].includes(agentThinkingLevel)) {
    throw new Error("PI_AGENT_THINKING_LEVEL is invalid");
  }
  const agentApiKey = env.PI_AGENT_API_KEY;
  if (agentApiKey !== undefined && (!agentApiKey || agentApiKey.length > 8_192 || /[\r\n\0]/.test(agentApiKey))) {
    throw new Error("PI_AGENT_API_KEY is invalid");
  }
  if (maxMcpSessionsPerClient > maxMcpSessionsTotal) {
    throw new Error("PI_MAX_MCP_SESSIONS_PER_CLIENT cannot exceed PI_MAX_MCP_SESSIONS_TOTAL");
  }
  let workspace = path.resolve(env.PI_WORK_DIR || process.cwd());
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    const cwd = process.cwd();
    if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
      workspace = cwd;
    } else {
      throw new Error(`PI_WORK_DIR must name an existing directory: ${workspace}`);
    }
  }
  const jwtSecret = requiredSecret(env.JWT_SECRET, "JWT_SECRET");
  const bootstrapSecret = requiredSecret(env.PI_BOOTSTRAP_SECRET, "PI_BOOTSTRAP_SECRET");
  const host = env.HOST || "127.0.0.1";
  const serverUrl = env.SERVER_URL || `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  const landingHostname = optionalHostname(env.PI_LANDING_HOSTNAME, "PI_LANDING_HOSTNAME");

  try {
    const url = new URL(serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new Error("SERVER_URL must be an absolute http(s) URL");
  }

  const activeConfigPath = env.PILINK_CONFIG || defaultConfigPath();
  const dataDir = path.resolve(env.PI_DATA_DIR || path.dirname(activeConfigPath));
  const fullAccessClientIds = parseFullAccessClientIds(env.PI_FULL_ACCESS_CLIENT_IDS);

  return {
    port,
    host,
    serverUrl: serverUrl.replace(/\/$/, ""),
    ...(landingHostname ? { landingHostname } : {}),
    workspace,
    dataDir,
    coordinationDataDir: path.resolve(env.PI_COORDINATION_DATA_DIR || dataDir),
    jwtSecret,
    bootstrapSecret,
    tokenExpirySeconds,
    refreshTokenExpirySeconds,
    oauthConsentMode,
    publicChatGptDcr: env.PI_OAUTH_PUBLIC_CHATGPT_DCR === "true",
    unsafeFullAccess: env.PI_UNSAFE_FULL_ACCESS === "true",
    fullAccessClientIds,
    allowWorkspaceExecution: env.PI_ALLOW_WORKSPACE_EXECUTION === "true",
    requireExecutionApproval: env.PI_REQUIRE_EXECUTION_APPROVAL === "true",
    maxBashTimeoutSeconds,
    maxMcpSessionsTotal,
    maxMcpSessionsPerClient,
    mcpSessionIdleTimeoutSeconds,
    mcpSessionReclaimGraceSeconds,
    ...(collaborationBindingHeader ? { collaborationBindingHeader } : {}),
    collaborationBindingDetachGraceSeconds,
    corsOrigins: (env.CORS_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === "true",
    ...(agentProvider ? { agentProvider } : {}),
    ...(agentModel ? { agentModel } : {}),
    ...(agentApiKey ? { agentApiKey } : {}),
    agentThinkingLevel: agentThinkingLevel as RuntimeConfig["agentThinkingLevel"],
    maxConcurrentAgents,
  };
}

export function parseFullAccessClientIds(value: string | undefined): readonly string[] {
  if (!value?.trim()) return Object.freeze([]);
  const entries = value.split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    if (entry !== "*" && !/^pi_[a-f0-9]{16}$/iu.test(entry)) {
      throw new Error("PI_FULL_ACCESS_CLIENT_IDS must contain OAuth client IDs separated by commas");
    }
  }
  return Object.freeze([...new Set(entries)]);
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value || value.length < 32) {
    throw new Error(`${name} must be set to a random value of at least 32 characters. Run 'pilink init'.`);
  }
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function optionalHostname(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (normalized !== value.trim() || normalized.length > 253 || normalized.includes("..")) {
    throw new Error(`${name} must be a lowercase DNS hostname`);
  }
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (normalized.split(".").length < 2 || normalized.split(".").some((part) => !label.test(part))) {
    throw new Error(`${name} must be a valid DNS hostname`);
  }
  return normalized;
}

function optionalIdentifier(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  if (!/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function optionalHeaderName(value: string | undefined, name: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(normalized)) {
    throw new Error(`${name} must be a valid HTTP header name`);
  }
  if (["authorization", "mcp-session-id", "mcp-protocol-version", "cookie", "set-cookie"].includes(normalized)) {
    throw new Error(`${name} cannot reuse an authentication or MCP protocol header`);
  }
  return normalized;
}
