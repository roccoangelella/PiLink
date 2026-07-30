import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "1.1.0";

export interface RuntimeConfig {
  port: number;
  host: string;
  serverUrl: string;
  workspace: string;
  dataDir: string;
  jwtSecret: string;
  bootstrapSecret: string;
  tokenExpirySeconds: number;
  unsafeFullAccess: boolean;
  maxBashTimeoutSeconds: number;
  corsOrigins: string[];
  trustProxy: boolean;
}

export function defaultConfigPath(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "pi-mcp", ".env");
}

export function loadEnvironment(): void {
  const inheritedEnvironment = { ...process.env };
  dotenv.config();
  dotenv.config({ path: process.env.PI_MCP_CONFIG || defaultConfigPath(), override: true });
  Object.assign(process.env, inheritedEnvironment);
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const port = positiveInteger(env.PORT, 3200, "PORT");
  const tokenExpirySeconds = positiveInteger(env.TOKEN_EXPIRY, 3600, "TOKEN_EXPIRY");
  const maxBashTimeoutSeconds = positiveInteger(env.PI_MAX_BASH_TIMEOUT, 120, "PI_MAX_BASH_TIMEOUT");
  const workspace = path.resolve(env.PI_WORK_DIR || process.cwd());
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error(`PI_WORK_DIR must name an existing directory: ${workspace}`);
  }
  const jwtSecret = requiredSecret(env.JWT_SECRET, "JWT_SECRET");
  const bootstrapSecret = requiredSecret(env.PI_BOOTSTRAP_SECRET, "PI_BOOTSTRAP_SECRET");
  const host = env.HOST || "127.0.0.1";
  const serverUrl = env.SERVER_URL || `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;

  try {
    const url = new URL(serverUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new Error("SERVER_URL must be an absolute http(s) URL");
  }

  return {
    port,
    host,
    serverUrl: serverUrl.replace(/\/$/, ""),
    workspace,
    dataDir: path.resolve(env.PI_DATA_DIR || path.dirname(env.PI_MCP_CONFIG || defaultConfigPath())),
    jwtSecret,
    bootstrapSecret,
    tokenExpirySeconds,
    unsafeFullAccess: env.PI_UNSAFE_FULL_ACCESS === "true",
    maxBashTimeoutSeconds,
    corsOrigins: (env.CORS_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === "true",
  };
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value || value.length < 32) {
    throw new Error(`${name} must be set to a random value of at least 32 characters. Run 'pi-mcp init'.`);
  }
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
