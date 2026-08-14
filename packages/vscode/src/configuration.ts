import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostingSelection } from "./hosting-model.js";
import type { PublicClientSummary } from "./protocol.js";
import { isRuntimeMode, type RuntimeMode } from "./runtime-mode.js";

export interface ConfigSnapshot {
  configPath: string;
  configured: boolean;
  values: Record<string, string>;
  workspace: string;
  dataDir: string;
  coordinationDataDir: string;
  port: number;
  hostingMode: string;
  unsafeFullAccess: boolean;
  fullAccessClientIds: string[];
  serverUrl: string;
  bootstrapSecret?: string;
  clients: PublicClientSummary[];
}

export function defaultConfigPath(environment: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(environment.XDG_CONFIG_HOME || path.join(home, ".config"), "pilink", ".env");
}

/**
 * Collaboration state must not share the filesystem capability root exposed
 * to MCP clients.  XDG_RUNTIME_DIR is private to the logged-in OS user and is
 * outside a normal home-directory workspace; the server recreates the
 * directory on every login when necessary.
 */
export function defaultCoordinationDataDir(
  configPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configuredRuntime = environment.XDG_RUNTIME_DIR;
  const uidRuntime = typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "";
  const runtimeRoot = configuredRuntime && path.isAbsolute(configuredRuntime)
    ? configuredRuntime
    : uidRuntime && fs.existsSync(uidRuntime)
      ? uidRuntime
      : os.tmpdir();
  const instanceKey = crypto.createHash("sha256").update(path.resolve(configPath)).digest("hex").slice(0, 16);
  return path.join(runtimeRoot, "vspilink", instanceKey, "coordination");
}

export function resolveConfigPath(
  configuredPath: string,
  workspacePath?: string,
  environment: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  const selected = configuredPath.trim() || environment.PILINK_CONFIG || defaultConfigPath(environment, home);
  const workspace = workspacePath || "";
  const expanded = selected
    .replace(/^~(?=$|[\\/])/, home)
    .replaceAll("${workspaceFolder}", workspace)
    .replaceAll("${userHome}", home);
  return path.resolve(expanded);
}

export function parseEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
    if (!match) continue;
    let raw = match[2] ?? "";
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      raw = raw.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      raw = raw.slice(1, -1);
    } else {
      raw = raw.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = raw;
  }
  return values;
}

export function updateEnvValue(contents: string, name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid configuration name: ${name}`);
  if (/\r|\n|\0/.test(value)) throw new Error(`Invalid configuration value for ${name}`);
  const entry = `${name}=${serializeEnvValue(value)}`;
  const lines = contents.split(/\r?\n/);
  const index = lines.findIndex((line) => new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=`).test(line));
  if (index >= 0) lines[index] = entry;
  else {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(entry);
  }
  return lines.join("\n");
}

export function removeEnvValue(contents: string, name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid configuration name: ${name}`);
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=`);
  return contents.split(/\r?\n/).filter((line) => !matcher.test(line)).join("\n");
}

export function parseFullAccessClientIds(value?: string): string[] {
  if (!value) return [];
  return [...new Set(value.split(/[\s,]+/u).map((entry) => entry.trim()).filter((entry) => (
    entry === "*" || /^pi_[a-f0-9]{16}$/iu.test(entry)
  )))];
}

export function writePrivateFile(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
}

export function provisionWizardConfiguration(options: {
  configPath: string;
  workspace: string;
  hosting: HostingSelection;
  port?: number;
  runtimeMode?: RuntimeMode;
}): void {
  const workspace = path.resolve(options.workspace);
  const port = options.port ?? 3200;
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error(`Invalid VSPiLink port: ${port}`);
  let contents: string;
  if (fs.existsSync(options.configPath)) {
    contents = fs.readFileSync(options.configPath, "utf8");
  } else {
    contents = [
      "# Generated by VSPiLink. Keep this file private.",
      `PI_WORK_DIR=${serializeEnvValue(workspace)}`,
      `PI_DATA_DIR=${serializeEnvValue(path.dirname(options.configPath))}`,
      `PI_COORDINATION_DATA_DIR=${serializeEnvValue(defaultCoordinationDataDir(options.configPath))}`,
      `PI_RUNTIME_MODE=${options.runtimeMode || "collaboration"}`,
      `PORT=${port}`,
      `JWT_SECRET=${privateSecret()}`,
      `PI_BOOTSTRAP_SECRET=${privateSecret()}`,
      "PI_OAUTH_CONSENT_MODE=paired",
      "PI_OAUTH_PUBLIC_CHATGPT_DCR=false",
      "TOKEN_EXPIRY=3600",
      "PI_REFRESH_TOKEN_EXPIRY=2592000",
      "PI_MAX_BASH_TIMEOUT=120",
      "PI_MAX_MCP_SESSIONS_TOTAL=64",
      "PI_MAX_MCP_SESSIONS_PER_CLIENT=16",
      "PI_MCP_SESSION_IDLE_TIMEOUT=600",
      "PI_MCP_SESSION_RECLAIM_GRACE=5",
      "# PI_ALLOW_WORKSPACE_EXECUTION=false",
      "# PI_REQUIRE_EXECUTION_APPROVAL=false",
      "PI_AGENT_MAX_CONCURRENT=4",
      "PI_AGENT_THINKING_LEVEL=medium",
      "# PI_AGENT_PROVIDER=configure-from-vscode",
      "# PI_AGENT_MODEL=configure-from-vscode",
      "# PI_UNSAFE_FULL_ACCESS=false",
      "# PI_FULL_ACCESS_CLIENT_IDS=",
      "# CORS_ORIGINS=https://client.example",
      "",
    ].join("\n");
  }
  contents = updateEnvValue(contents, "PI_WORK_DIR", workspace);
  if (options.runtimeMode) {
    if (!isRuntimeMode(options.runtimeMode)) throw new Error("Invalid VSPiLink runtime workflow.");
    contents = updateEnvValue(contents, "PI_RUNTIME_MODE", options.runtimeMode);
  }
  if (!parseEnv(contents).PI_COORDINATION_DATA_DIR) {
    contents = updateEnvValue(contents, "PI_COORDINATION_DATA_DIR", defaultCoordinationDataDir(options.configPath));
  }
  contents = updateEnvValue(contents, "PI_UNSAFE_FULL_ACCESS", "false");
  contents = removeEnvValue(contents, "PI_FULL_ACCESS_CLIENT_IDS");
  contents = updateEnvValue(contents, "PI_OAUTH_CONSENT_MODE", "paired");
  contents = updateEnvValue(contents, "PI_OAUTH_PUBLIC_CHATGPT_DCR", options.hosting.kind === "local" ? "false" : "true");
  contents = updateEnvValue(contents, "TOKEN_EXPIRY", "3600");
  contents = updateEnvValue(contents, "PI_REFRESH_TOKEN_EXPIRY", "2592000");
  switch (options.hosting.kind) {
    case "quick-tunnel":
      contents = updateEnvValue(contents, "PI_HOSTING_MODE", "quick-tunnel");
      contents = updateEnvValue(contents, "TRUST_PROXY", "true");
      contents = removeEnvValue(contents, "SERVER_URL");
      contents = removeEnvValue(contents, "PI_LANDING_HOSTNAME");
      break;
    case "cloudflare-named":
      if (!options.hosting.publicUrl || !options.hosting.landingHostname) {
        throw new Error("Configure both Cloudflare Named Tunnel hostnames.");
      }
      contents = updateEnvValue(contents, "PI_HOSTING_MODE", "cloudflare-named");
      contents = updateEnvValue(contents, "TRUST_PROXY", "true");
      contents = updateEnvValue(contents, "SERVER_URL", options.hosting.publicUrl);
      contents = updateEnvValue(contents, "PI_LANDING_HOSTNAME", options.hosting.landingHostname);
      break;
    case "nip-io":
      contents = updateEnvValue(contents, "PI_HOSTING_MODE", "nip-io");
      contents = updateEnvValue(contents, "TRUST_PROXY", "true");
      contents = removeEnvValue(contents, "PI_LANDING_HOSTNAME");
      break;
    case "custom-domain":
      if (!options.hosting.publicUrl) throw new Error("Enter the public HTTPS domain.");
      contents = updateEnvValue(contents, "PI_HOSTING_MODE", "external");
      contents = updateEnvValue(contents, "TRUST_PROXY", "true");
      contents = updateEnvValue(contents, "SERVER_URL", options.hosting.publicUrl);
      contents = options.hosting.landingHostname
        ? updateEnvValue(contents, "PI_LANDING_HOSTNAME", options.hosting.landingHostname)
        : removeEnvValue(contents, "PI_LANDING_HOSTNAME");
      break;
    case "local":
      contents = updateEnvValue(contents, "PI_HOSTING_MODE", "local");
      contents = updateEnvValue(contents, "TRUST_PROXY", "false");
      contents = removeEnvValue(contents, "SERVER_URL");
      contents = removeEnvValue(contents, "PI_LANDING_HOSTNAME");
      break;
  }
  writePrivateFile(options.configPath, contents.endsWith("\n") ? contents : `${contents}\n`);
}

export function readConfigSnapshot(configPath: string, fallbackWorkspace: string): ConfigSnapshot {
  const configured = fs.existsSync(configPath);
  const values = configured ? parseEnv(fs.readFileSync(configPath, "utf8")) : {};
  for (const name of RUNTIME_ENVIRONMENT_KEYS) {
    if (process.env[name] !== undefined) values[name] = process.env[name] as string;
  }
  const configuredWorkspace = values.PI_WORK_DIR?.trim();
  const workspace = configuredWorkspace
    ? path.resolve(configuredWorkspace)
    : fallbackWorkspace.trim()
      ? path.resolve(fallbackWorkspace)
      : "";
  const dataDir = path.resolve(values.PI_DATA_DIR || path.dirname(configPath));
  const coordinationDataDir = path.resolve(values.PI_COORDINATION_DATA_DIR || dataDir);
  const port = parsePort(values.PORT);
  const host = values.HOST || "127.0.0.1";
  const localHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const serverUrl = (values.SERVER_URL || `http://${localHost}:${port}`).replace(/\/$/, "");
  return {
    configPath,
    configured,
    values,
    workspace,
    dataDir,
    coordinationDataDir,
    port,
    hostingMode: values.PI_HOSTING_MODE || "not configured",
    unsafeFullAccess: values.PI_UNSAFE_FULL_ACCESS === "true",
    fullAccessClientIds: parseFullAccessClientIds(values.PI_FULL_ACCESS_CLIENT_IDS),
    serverUrl,
    bootstrapSecret: values.PI_BOOTSTRAP_SECRET,
    clients: readClients(dataDir),
  };
}

const RUNTIME_ENVIRONMENT_KEYS = [
  "PI_RUNTIME_MODE",
  "PI_WORK_DIR",
  "PI_DATA_DIR",
  "PI_COORDINATION_DATA_DIR",
  "PORT",
  "HOST",
  "SERVER_URL",
  "PI_LANDING_HOSTNAME",
  "JWT_SECRET",
  "PI_BOOTSTRAP_SECRET",
  "PI_OAUTH_CONSENT_MODE",
  "PI_OAUTH_PUBLIC_CHATGPT_DCR",
  "TOKEN_EXPIRY",
  "PI_REFRESH_TOKEN_EXPIRY",
  "PI_UNSAFE_FULL_ACCESS",
  "PI_FULL_ACCESS_CLIENT_IDS",
  "PI_MAX_BASH_TIMEOUT",
  "PI_MAX_MCP_SESSIONS_TOTAL",
  "PI_MAX_MCP_SESSIONS_PER_CLIENT",
  "PI_MCP_SESSION_IDLE_TIMEOUT",
  "PI_MCP_SESSION_RECLAIM_GRACE",
  "PI_ALLOW_WORKSPACE_EXECUTION",
  "PI_REQUIRE_EXECUTION_APPROVAL",
  "PI_AGENT_MAX_CONCURRENT",
  "PI_AGENT_THINKING_LEVEL",
  "PI_AGENT_PROVIDER",
  "PI_AGENT_MODEL",
  "CORS_ORIGINS",
  "TRUST_PROXY",
  "PI_HOSTING_MODE",
  "PI_NIP_IO_NETWORK",
  "PI_NIP_IO_HOSTNAME",
  "PI_PUBLIC_IPV4",
  "PI_CLOUDFLARED_PATH",
  "PI_CLOUDFLARED_URL",
  "PI_CLOUDFLARED_SHA256",
  "PI_CADDY_PATH",
  "PI_CADDY_URL",
  "PI_CADDY_SHA256",
] as const;

export function localServerUrl(snapshot: Pick<ConfigSnapshot, "port">): string {
  return `http://127.0.0.1:${snapshot.port}`;
}

function readClients(dataDir: string): PublicClientSummary[] {
  const filePath = path.join(dataDir, "clients.json");
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { clients?: unknown[] };
    if (!Array.isArray(parsed.clients)) return [];
    const authorizations = readActiveRefreshAuthorizations(dataDir);
    return parsed.clients.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const client = value as Record<string, unknown>;
      if (
        typeof client.client_id !== "string" || typeof client.client_name !== "string" ||
        typeof client.disabled_at === "string"
      ) return [];
      const grantTypes = Array.isArray(client.grant_types)
        ? client.grant_types.filter((item): item is string => typeof item === "string")
        : [];
      const redirectUris = Array.isArray(client.redirect_uris)
        ? client.redirect_uris.filter((item): item is string => typeof item === "string")
        : [];
      const tokenVersion = Number.isSafeInteger(client.token_version) && (client.token_version as number) > 0
        ? client.token_version as number
        : 1;
      return [{
        id: client.client_id,
        name: client.client_name,
        grantTypes,
        scope: typeof client.scope === "string" ? client.scope : "",
        createdAt: typeof client.created_at === "string" ? client.created_at : "",
        chatGpt: grantTypes.includes("authorization_code") && redirectUris.some(isChatGptRedirectUri),
        authorized: authorizations.has(`${client.client_id}:${tokenVersion}`),
      }];
    });
  } catch {
    return [];
  }
}

/**
 * Read only the non-secret lifecycle metadata needed to distinguish a client
 * that was merely registered from one that completed OAuth. Token hashes are
 * never returned or copied into dashboard state.
 */
function readActiveRefreshAuthorizations(dataDir: string, now = Date.now()): Set<string> {
  const result = new Set<string>();
  const filePath = path.join(dataDir, "refresh-tokens.json");
  if (!fs.existsSync(filePath)) return result;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { tokens?: unknown[] };
    if (!Array.isArray(parsed.tokens)) return result;
    for (const value of parsed.tokens) {
      if (!value || typeof value !== "object") continue;
      const token = value as Record<string, unknown>;
      if (
        typeof token.client_id !== "string" ||
        typeof token.token_hash !== "string" || !/^[a-f0-9]{64}$/u.test(token.token_hash) ||
        typeof token.expires_at !== "number" || !Number.isSafeInteger(token.expires_at) || token.expires_at <= now
      ) continue;
      const version = Number.isSafeInteger(token.client_version) && (token.client_version as number) > 0
        ? token.client_version as number
        : 1;
      result.add(`${token.client_id}:${version}`);
    }
  } catch {
    // A malformed private store must fail closed and never expose its content.
  }
  return result;
}

function isChatGptRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && (
      hostname === "chatgpt.com" || hostname === "www.chatgpt.com" || hostname === "chat.openai.com"
    );
  } catch {
    return false;
  }
}

function parsePort(value?: string): number {
  const parsed = Number.parseInt(value || "3200", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : 3200;
}

function serializeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+,-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function privateSecret(): string {
  return crypto.randomBytes(48).toString("base64url");
}
