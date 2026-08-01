// ─────────────────────────────────────────────────────────────
// PiLink: OAuth 2.0 Token & Client Management
// ─────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import type { Request, Response, NextFunction } from "express";
import type { OAuthClient, AuthorizationCode, TokenPayload, ClientStore } from "./types.js";
import { loadRuntimeConfig } from "./config.js";

const authCodes = new Map<string, AuthorizationCode>();
const CLIENT_STORE_LOCK_TIMEOUT_MS = 5_000;
const CLIENT_STORE_STALE_LOCK_MS = 30_000;

interface RevokedTokenRecord {
  jti: string;
  exp: number;
}

interface RevokedTokenStore {
  revoked_tokens: RevokedTokenRecord[];
}

type ClientLifecycleAction = "registered" | "disabled" | "enabled" | "secret_rotated";

function clientStorePath(): string {
  return path.join(loadRuntimeConfig().dataDir, "clients.json");
}

function clientStoreLockPath(): string {
  return `${clientStorePath()}.lock`;
}

function revokedTokenStorePath(): string {
  return path.join(loadRuntimeConfig().dataDir, "revoked-tokens.json");
}

function clientLifecycleAuditPath(): string {
  return path.join(loadRuntimeConfig().dataDir, "oauth-client-audit.jsonl");
}

function ensureDataDir(): void {
  const dataDir = loadRuntimeConfig().dataDir;
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(dataDir, 0o700);
}

export function loadClients(): OAuthClient[] {
  ensureDataDir();
  const clientsFile = clientStorePath();
  if (!fs.existsSync(clientsFile)) {
    fs.writeFileSync(clientsFile, JSON.stringify({ clients: [] }, null, 2), { mode: 0o600 });
    fs.chmodSync(clientsFile, 0o600);
    return [];
  }
  const data: ClientStore = JSON.parse(fs.readFileSync(clientsFile, "utf-8"));
  if (!Array.isArray(data.clients) || data.clients.some((client) => !isStoredClient(client))) {
    throw new Error("Client store is malformed");
  }
  return data.clients;
}

export function saveClients(clients: OAuthClient[]): void {
  ensureDataDir();
  const clientsFile = clientStorePath();
  const store: ClientStore = { clients };
  writePrivateJsonAtomically(clientsFile, store);
}

function loadRevokedTokens(nowSeconds = Math.floor(Date.now() / 1000)): RevokedTokenRecord[] {
  ensureDataDir();
  const storeFile = revokedTokenStorePath();
  if (!fs.existsSync(storeFile)) return [];

  const data = JSON.parse(fs.readFileSync(storeFile, "utf-8")) as RevokedTokenStore;
  if (!Array.isArray(data.revoked_tokens)) throw new Error("Revoked token store is malformed");
  if (data.revoked_tokens.some((record) =>
    !record || typeof record.jti !== "string" || !record.jti ||
    !Number.isSafeInteger(record.exp) || record.exp <= 0
  )) {
    throw new Error("Revoked token store is malformed");
  }

  const activeRecords = data.revoked_tokens.filter((record) => record.exp > nowSeconds);
  if (activeRecords.length !== data.revoked_tokens.length) saveRevokedTokens(activeRecords);
  return activeRecords;
}

function saveRevokedTokens(records: RevokedTokenRecord[]): void {
  ensureDataDir();
  writePrivateJsonAtomically(revokedTokenStorePath(), { revoked_tokens: records });
}

function writePrivateJsonAtomically(filePath: string, value: unknown): void {
  const temporaryFile = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, filePath);
  fs.chmodSync(filePath, 0o600);
}

function appendClientLifecycleAudit(action: ClientLifecycleAction, client: OAuthClient): void {
  const event = {
    timestamp: new Date().toISOString(),
    action,
    client_id: client.client_id,
    client_name: client.client_name,
    active: isClientActive(client),
    token_version: effectiveClientTokenVersion(client),
  };
  try {
    const auditPath = clientLifecycleAuditPath();
    fs.appendFileSync(auditPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    fs.chmodSync(auditPath, 0o600);
  } catch (error) {
    console.error("[OAuth] Unable to append the client lifecycle audit event:", error);
  }
}

function isStoredClient(value: unknown): value is OAuthClient {
  if (!value || typeof value !== "object") return false;
  const client = value as Partial<OAuthClient>;
  return typeof client.client_id === "string" && Boolean(client.client_id) &&
    typeof client.client_secret_hash === "string" && Boolean(client.client_secret_hash) &&
    typeof client.client_name === "string" && Boolean(client.client_name) &&
    Array.isArray(client.redirect_uris) && client.redirect_uris.every((uri) => typeof uri === "string") &&
    Array.isArray(client.grant_types) && client.grant_types.every((grant) => typeof grant === "string") &&
    typeof client.scope === "string" && typeof client.created_at === "string" &&
    (client.disabled_at === undefined || typeof client.disabled_at === "string") &&
    (client.secret_rotated_at === undefined || typeof client.secret_rotated_at === "string") &&
    (client.token_version === undefined || (Number.isSafeInteger(client.token_version) && client.token_version > 0));
}

async function withClientStoreLock<T>(operation: () => Promise<T> | T): Promise<T> {
  ensureDataDir();
  const lockPath = clientStoreLockPath();
  const deadline = Date.now() + CLIENT_STORE_LOCK_TIMEOUT_MS;
  let descriptor: number | undefined;

  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (lockAge > CLIENT_STORE_STALE_LOCK_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the OAuth client store lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await operation();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lockPath, { force: true });
  }
}

export function effectiveClientTokenVersion(client: OAuthClient): number {
  return Number.isSafeInteger(client.token_version) && (client.token_version as number) > 0
    ? client.token_version as number
    : 1;
}

export function isClientActive(client: OAuthClient): boolean {
  return !client.disabled_at;
}

export function findClient(clientId: string): OAuthClient | undefined {
  return loadClients().find((client) => client.client_id === clientId);
}

export function findActiveClient(clientId: string): OAuthClient | undefined {
  const client = findClient(clientId);
  return client && isClientActive(client) ? client : undefined;
}

export async function registerClient(
  clientName: string,
  redirectUris: string[],
  grantTypes: string[],
  scope: string
): Promise<{ client: OAuthClient; client_secret: string }> {
  const clientId = `pi_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
  const clientSecret = crypto.randomBytes(32).toString("base64url");
  const clientSecretHash = await bcrypt.hash(clientSecret, 12);

  const client: OAuthClient = {
    client_id: clientId,
    client_secret_hash: clientSecretHash,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    scope,
    created_at: new Date().toISOString(),
    token_version: 1,
  };

  await withClientStoreLock(() => {
    const clients = loadClients();
    clients.push(client);
    saveClients(clients);
    appendClientLifecycleAudit("registered", client);
  });

  return { client, client_secret: clientSecret };
}

export async function setClientDisabled(clientId: string, disabled: boolean): Promise<OAuthClient | null> {
  return withClientStoreLock(() => {
    const clients = loadClients();
    const index = clients.findIndex((client) => client.client_id === clientId);
    if (index === -1) return null;

    const current = clients[index];
    if (disabled === !isClientActive(current)) return current;
    const updated: OAuthClient = disabled
      ? {
          ...current,
          disabled_at: new Date().toISOString(),
          token_version: effectiveClientTokenVersion(current) + 1,
        }
      : (() => {
          const { disabled_at: _disabledAt, ...enabledClient } = current;
          return enabledClient;
        })();
    clients[index] = updated;
    saveClients(clients);
    appendClientLifecycleAudit(disabled ? "disabled" : "enabled", updated);
    return updated;
  });
}

export async function rotateClientSecret(clientId: string): Promise<{ client: OAuthClient; client_secret: string } | null> {
  const clientSecret = crypto.randomBytes(32).toString("base64url");
  const clientSecretHash = await bcrypt.hash(clientSecret, 12);

  return withClientStoreLock(() => {
    const clients = loadClients();
    const index = clients.findIndex((client) => client.client_id === clientId);
    if (index === -1) return null;

    const current = clients[index];
    const updated: OAuthClient = {
      ...current,
      client_secret_hash: clientSecretHash,
      secret_rotated_at: new Date().toISOString(),
      token_version: effectiveClientTokenVersion(current) + 1,
    };
    clients[index] = updated;
    saveClients(clients);
    appendClientLifecycleAudit("secret_rotated", updated);
    return { client: updated, client_secret: clientSecret };
  });
}

export async function verifyClientSecret(
  client: OAuthClient,
  secret: string
): Promise<boolean> {
  return bcrypt.compare(secret, client.client_secret_hash);
}

export function createAuthorizationCode(
  clientId: string,
  clientVersion: number,
  redirectUri: string,
  scope: string,
  codeChallenge: string,
  codeChallengeMethod: string
): string {
  const code = crypto.randomBytes(32).toString("base64url");
  const authCode: AuthorizationCode = {
    code,
    client_id: clientId,
    client_version: clientVersion,
    redirect_uri: redirectUri,
    scope,
    code_challenge: codeChallenge || "",
    code_challenge_method: (codeChallengeMethod || "S256") as "S256",
    expires_at: Date.now() + 10 * 60 * 1000,
  };
  authCodes.set(code, authCode);
  console.error(`[OAuth] Auth code created: ${code.slice(0, 8)}... for client ${clientId}`);
  return code;
}

export function consumeAuthorizationCode(code: string): AuthorizationCode | null {
  const authCode = authCodes.get(code);
  if (!authCode) return null;
  authCodes.delete(code);
  if (Date.now() > authCode.expires_at) return null;
  return authCode;
}

export function peekAuthorizationCode(code: string): AuthorizationCode | null {
  const authCode = authCodes.get(code);
  if (!authCode) return null;
  if (Date.now() > authCode.expires_at) {
    authCodes.delete(code);
    return null;
  }
  return authCode;
}

export function verifyPKCE(codeVerifier: string, codeChallenge: string): boolean {
  const hash = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return hash === codeChallenge;
}

export function createAccessToken(
  client: OAuthClient,
  scope: string
): { access_token: string; expires_in: number; token_type: string } {
  const config = loadRuntimeConfig();
  const payload: Omit<TokenPayload, "iat" | "exp"> = {
    sub: client.client_id,
    scope,
    iss: config.serverUrl,
    aud: config.serverUrl,
    jti: uuidv4(),
    client_version: effectiveClientTokenVersion(client),
  };

  const access_token = jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.tokenExpirySeconds,
  });

  return {
    access_token,
    expires_in: config.tokenExpirySeconds,
    token_type: "Bearer",
  };
}

function verifySignedAccessToken(token: string, ignoreExpiration = false): TokenPayload | null {
  const config = loadRuntimeConfig();
  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      issuer: config.serverUrl,
      audience: config.serverUrl,
      ignoreExpiration,
    }) as TokenPayload;
    if (
      !payload || typeof payload.sub !== "string" || typeof payload.scope !== "string" ||
      typeof payload.jti !== "string" || !payload.jti || !Number.isSafeInteger(payload.exp) ||
      (payload.client_version !== undefined && (!Number.isSafeInteger(payload.client_version) || payload.client_version <= 0))
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function inspectAccessTokenForRevocation(token: string): TokenPayload | null {
  return verifySignedAccessToken(token, true);
}

export function revokeAccessToken(payload: TokenPayload): void {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= nowSeconds) return;

  const records = loadRevokedTokens(nowSeconds);
  if (records.some((record) => record.jti === payload.jti)) return;
  records.push({ jti: payload.jti, exp: payload.exp });
  saveRevokedTokens(records);
}

export function verifyAccessToken(token: string): TokenPayload | null {
  const payload = verifySignedAccessToken(token);
  if (!payload) return null;

  try {
    if (loadRevokedTokens().some((record) => record.jti === payload.jti)) return null;
    const client = findActiveClient(payload.sub);
    if (!client) return null;
    const tokenVersion = payload.client_version ?? 1;
    if (tokenVersion !== effectiveClientTokenVersion(client)) return null;
    return payload;
  } catch (error) {
    console.error("[OAuth] Refusing access because OAuth lifecycle state could not be read:", error);
    return null;
  }
}

export function authenticateBearer(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const config = loadRuntimeConfig();
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.setHeader(
      "WWW-Authenticate",
       `Bearer resource_metadata="${config.serverUrl}/.well-known/oauth-protected-resource"`
    );
    res.status(401).json({ error: "unauthorized", error_description: "Missing Bearer token" });
    return;
  }

  const token = authHeader.slice(7);
  const payload = verifyAccessToken(token);

  if (!payload) {
    res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
    res.status(401).json({ error: "invalid_token", error_description: "Token is invalid or expired" });
    return;
  }

  (req as any).tokenPayload = payload;
  next();
}
