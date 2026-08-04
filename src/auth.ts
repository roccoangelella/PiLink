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
import type { OAuthClient, AuthorizationCode, TokenPayload, ClientStore, RefreshTokenRecord, RefreshTokenStore } from "./types.js";
import { loadRuntimeConfig } from "./config.js";
import {
  classifyPersistedRuntimeOwner,
  LOCAL_RUNTIME_OWNER,
  type RuntimeOwner,
} from "./runtime-owner.js";

const authCodes = new Map<string, AuthorizationCode>();
const MAX_AUTHORIZATION_CODES = 256;
const MAX_REFRESH_TOKENS = 512;
const OAUTH_STATE_LOCK_TIMEOUT_MS = 5_000;
const OAUTH_STATE_STALE_LOCK_MS = 30_000;
const OAUTH_STATE_LOCK_RETRY_MS = 25;
const CLIENT_ID_PATTERN = /^pi_[a-f0-9]{16}$/iu;

interface RevokedTokenRecord {
  jti: string;
  exp: number;
}

interface RevokedTokenStore {
  revoked_tokens: RevokedTokenRecord[];
}

interface OAuthStateLockOwner {
  version: 1;
  nonce: string;
  runtime: RuntimeOwner;
}

type ClientLifecycleAction =
  | "registered"
  | "disabled"
  | "enabled"
  | "secret_rotated"
  | "deleted"
  | "token_revoked";

function clientStorePath(): string {
  return path.join(loadRuntimeConfig().dataDir, "clients.json");
}

function refreshTokenStorePath(): string {
  return path.join(loadRuntimeConfig().dataDir, "refresh-tokens.json");
}

function revokedTokenStorePath(): string {
  return path.join(loadRuntimeConfig().dataDir, "revoked-tokens.json");
}

function oauthStateLockPath(): string {
  return path.join(loadRuntimeConfig().dataDir, "oauth-state.lock");
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
  if (!fs.existsSync(clientsFile)) return [];
  const data = parsePrivateJson<ClientStore>(clientsFile, "Client store is malformed");
  if (!Array.isArray(data.clients) || data.clients.some((client) => !isStoredClient(client))) {
    throw new Error("Client store is malformed");
  }
  return data.clients;
}

function saveClients(clients: OAuthClient[]): void {
  ensureDataDir();
  writePrivateJsonAtomically(clientStorePath(), { clients } satisfies ClientStore);
}

function parsePrivateJson<T>(filePath: string, errorMessage: string): T {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(errorMessage);
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    throw new Error(errorMessage);
  }
}

function writePrivateJsonAtomically(filePath: string, value: unknown): void {
  ensureDataDir();
  const temporaryFile = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryFile, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryFile, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best effort cleanup */ }
    }
    try { fs.rmSync(temporaryFile, { force: true }); } catch { /* best effort cleanup */ }
  }
}

function isStoredClient(value: unknown): value is OAuthClient {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const client = value as Partial<OAuthClient>;
  return typeof client.client_id === "string" && CLIENT_ID_PATTERN.test(client.client_id) &&
    typeof client.client_secret_hash === "string" && client.client_secret_hash.length >= 20 &&
    typeof client.client_name === "string" && client.client_name.length > 0 && client.client_name.length <= 120 &&
    Array.isArray(client.redirect_uris) && client.redirect_uris.every((uri) => typeof uri === "string") &&
    Array.isArray(client.grant_types) && client.grant_types.every((grant) => typeof grant === "string") &&
    (client.token_endpoint_auth_method === undefined ||
      ["client_secret_post", "client_secret_basic", "none"].includes(client.token_endpoint_auth_method)) &&
    typeof client.scope === "string" && typeof client.created_at === "string" &&
    (client.disabled_at === undefined || typeof client.disabled_at === "string") &&
    (client.secret_rotated_at === undefined || typeof client.secret_rotated_at === "string") &&
    (client.token_version === undefined ||
      (Number.isSafeInteger(client.token_version) && (client.token_version as number) > 0));
}

async function withOAuthStateLock<T>(operation: () => Promise<T> | T): Promise<T> {
  ensureDataDir();
  const lockPath = oauthStateLockPath();
  const owner: OAuthStateLockOwner = {
    version: 1,
    nonce: crypto.randomBytes(16).toString("hex"),
    runtime: { ...LOCAL_RUNTIME_OWNER },
  };
  const serializedOwner = `${JSON.stringify(owner)}\n`;
  const deadline = Date.now() + OAUTH_STATE_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, "wx", 0o600);
      let initialized = false;
      try {
        await handle.writeFile(serializedOwner, "utf8");
        await handle.sync();
        initialized = true;
      } finally {
        await handle.close();
        if (!initialized) await fs.promises.rm(lockPath, { force: true });
      }
      break;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      await removeDeadOAuthStateLock(lockPath);
      if (Date.now() >= deadline) throw new Error("OAuth state is busy");
      await delay(OAUTH_STATE_LOCK_RETRY_MS);
    }
  }

  try {
    return await operation();
  } finally {
    try {
      if (await fs.promises.readFile(lockPath, "utf8") === serializedOwner) {
        await fs.promises.rm(lockPath, { force: true });
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
}

async function removeDeadOAuthStateLock(lockPath: string): Promise<void> {
  try {
    const first = await fs.promises.stat(lockPath);
    if (Date.now() - first.mtimeMs <= OAUTH_STATE_STALE_LOCK_MS) return;
    const serialized = await fs.promises.readFile(lockPath, "utf8");
    const owner = parseOAuthStateLockOwner(serialized);
    if (!owner || classifyPersistedRuntimeOwner(owner.runtime) !== "dead") return;
    const second = await fs.promises.stat(lockPath);
    const current = await fs.promises.readFile(lockPath, "utf8");
    if (current !== serialized || second.dev !== first.dev || second.ino !== first.ino) return;
    await fs.promises.rm(lockPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function parseOAuthStateLockOwner(serialized: string): OAuthStateLockOwner | undefined {
  try {
    const value = JSON.parse(serialized) as Partial<OAuthStateLockOwner>;
    const runtime = value.runtime as Partial<RuntimeOwner> | undefined;
    if (value.version !== 1 || typeof value.nonce !== "string" || !/^[a-f0-9]{32}$/u.test(value.nonce) ||
        !runtime || runtime.version !== 1 || !Number.isSafeInteger(runtime.pid) || (runtime.pid as number) < 1 ||
        typeof runtime.runtimeInstanceId !== "string") return undefined;
    return value as OAuthStateLockOwner;
  } catch {
    return undefined;
  }
}

function appendClientLifecycleAudit(action: ClientLifecycleAction, client: OAuthClient): void {
  const event = {
    event_version: 1,
    timestamp: new Date().toISOString(),
    action,
    client_id: client.client_id,
    active: action === "deleted" ? false : isClientActive(client),
    token_version: effectiveClientTokenVersion(client),
  };
  try {
    const auditPath = clientLifecycleAuditPath();
    fs.appendFileSync(auditPath, `${JSON.stringify(event)}\n`, { mode: 0o600, flag: "a" });
    fs.chmodSync(auditPath, 0o600);
  } catch {
    console.error("[OAuth] Unable to append a client lifecycle audit event.");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export function findClient(clientId: string): OAuthClient | undefined {
  return loadClients().find((client) => client.client_id === clientId);
}

export function findActiveClient(clientId: string): OAuthClient | undefined {
  const client = findClient(clientId);
  return client && isClientActive(client) ? client : undefined;
}

export function effectiveClientTokenVersion(client: OAuthClient): number {
  return Number.isSafeInteger(client.token_version) && (client.token_version as number) > 0
    ? client.token_version as number
    : 1;
}

export function isClientActive(client: OAuthClient): boolean {
  return client.disabled_at === undefined;
}

export async function deleteClient(clientId: string): Promise<boolean> {
  if (!CLIENT_ID_PATTERN.test(clientId)) return false;
  return withOAuthStateLock(() => {
    const clients = loadClients();
    const index = clients.findIndex((client) => client.client_id === clientId);
    if (index < 0) return false;
    const [removed] = clients.splice(index, 1);
    saveClients(clients);
    removeRefreshTokensUnlocked(clientId);
    appendClientLifecycleAudit("deleted", removed);
    return true;
  });
}

export async function registerClient(
  clientName: string,
  redirectUris: string[],
  grantTypes: string[],
  scope: string,
  tokenEndpointAuthMethod: OAuthClient["token_endpoint_auth_method"] = "client_secret_post",
): Promise<{ client: OAuthClient; client_secret: string }> {
  const clientId = `pi_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
  const clientSecret = crypto.randomBytes(32).toString("base64url");
  // Public PKCE clients never authenticate with this value. Avoid exposing a
  // secret and avoid an attacker turning tightly rate-limited DCR into an
  // expensive bcrypt workload.
  const clientSecretHash = tokenEndpointAuthMethod === "none"
    ? crypto.createHash("sha256").update(clientSecret).digest("hex")
    : await bcrypt.hash(clientSecret, 12);

  const client: OAuthClient = {
    client_id: clientId,
    client_secret_hash: clientSecretHash,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    scope,
    created_at: new Date().toISOString(),
    token_version: 1,
  };

  await withOAuthStateLock(() => {
    const clients = loadClients();
    if (clients.some((candidate) => candidate.client_id === client.client_id)) {
      throw new Error("Unable to allocate a unique OAuth client ID");
    }
    clients.push(client);
    saveClients(clients);
    appendClientLifecycleAudit("registered", client);
  });

  return { client, client_secret: clientSecret };
}

export async function setClientDisabled(clientId: string, disabled: boolean): Promise<OAuthClient | null> {
  if (!CLIENT_ID_PATTERN.test(clientId)) return null;
  return withOAuthStateLock(() => {
    const clients = loadClients();
    const index = clients.findIndex((client) => client.client_id === clientId);
    if (index < 0) return null;
    const current = clients[index];
    if (disabled === !isClientActive(current)) return { ...current };

    let updated: OAuthClient;
    if (disabled) {
      updated = {
        ...current,
        disabled_at: new Date().toISOString(),
        token_version: effectiveClientTokenVersion(current) + 1,
      };
      removeRefreshTokensUnlocked(clientId);
    } else {
      const { disabled_at: _disabledAt, ...enabled } = current;
      updated = enabled;
    }
    clients[index] = updated;
    saveClients(clients);
    appendClientLifecycleAudit(disabled ? "disabled" : "enabled", updated);
    return { ...updated };
  });
}

export async function rotateClientSecret(
  clientId: string,
): Promise<{ client: OAuthClient; client_secret: string } | null> {
  if (!CLIENT_ID_PATTERN.test(clientId)) return null;
  const clientSecret = crypto.randomBytes(32).toString("base64url");
  const clientSecretHash = await bcrypt.hash(clientSecret, 12);

  return withOAuthStateLock(() => {
    const clients = loadClients();
    const index = clients.findIndex((client) => client.client_id === clientId);
    if (index < 0) return null;
    const current = clients[index];
    if ((current.token_endpoint_auth_method || "client_secret_post") === "none") {
      throw new Error("Public OAuth clients do not have a rotatable secret");
    }
    const updated: OAuthClient = {
      ...current,
      client_secret_hash: clientSecretHash,
      secret_rotated_at: new Date().toISOString(),
      token_version: effectiveClientTokenVersion(current) + 1,
    };
    clients[index] = updated;
    saveClients(clients);
    removeRefreshTokensUnlocked(clientId);
    appendClientLifecycleAudit("secret_rotated", updated);
    return { client: { ...updated }, client_secret: clientSecret };
  });
}

export async function verifyClientSecret(
  client: OAuthClient,
  secret: string
): Promise<boolean> {
  if (typeof secret !== "string" || secret.length > 512 || typeof client.client_secret_hash !== "string") return false;
  try {
    return await bcrypt.compare(secret, client.client_secret_hash);
  } catch {
    return false;
  }
}

export function createAuthorizationCode(
  clientId: string,
  clientVersion: number,
  redirectUri: string,
  scope: string,
  codeChallenge: string,
  codeChallengeMethod: string
): string {
  pruneAuthorizationCodes(Date.now());
  while (authCodes.size >= MAX_AUTHORIZATION_CODES) {
    const oldest = authCodes.keys().next().value as string | undefined;
    if (!oldest) break;
    authCodes.delete(oldest);
  }
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
  // Authorization codes are bearer credentials. Never print even a prefix:
  // partial values create avoidable correlation data in support logs.
  console.error("[OAuth] One-time authorization code created for an approved client.");
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

function pruneAuthorizationCodes(now: number): void {
  for (const [code, authorization] of authCodes) {
    if (authorization.expires_at <= now) authCodes.delete(code);
  }
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
    algorithm: "HS256",
    expiresIn: config.tokenExpirySeconds,
  });

  return {
    access_token,
    expires_in: config.tokenExpirySeconds,
    token_type: "Bearer",
  };
}

export async function createRefreshToken(
  client: OAuthClient,
  scope: string,
): Promise<{ refresh_token: string; expires_in: number }> {
  const config = loadRuntimeConfig();
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  const now = Date.now();
  const record: RefreshTokenRecord = {
    token_hash: hashRefreshToken(refreshToken),
    client_id: client.client_id,
    scope,
    created_at: new Date(now).toISOString(),
    expires_at: now + config.refreshTokenExpirySeconds * 1000,
    client_version: effectiveClientTokenVersion(client),
  };
  await withOAuthStateLock(() => {
    const current = loadClients().find((candidate) => candidate.client_id === client.client_id);
    if (!current || !isClientActive(current) ||
        effectiveClientTokenVersion(current) !== record.client_version) {
      throw new Error("OAuth client credentials changed");
    }
    const tokens = loadRefreshTokens().filter((candidate) => candidate.expires_at > now);
    tokens.push(record);
    saveRefreshTokens(tokens.slice(-MAX_REFRESH_TOKENS));
  });
  return { refresh_token: refreshToken, expires_in: config.refreshTokenExpirySeconds };
}

export async function rotateRefreshToken(
  refreshToken: string,
  client: OAuthClient,
): Promise<{ refresh_token: string; expires_in: number; scope: string } | null> {
  if (!refreshToken || !client.client_id) return null;
  const presentedHash = hashRefreshToken(refreshToken);
  const config = loadRuntimeConfig();
  const replacement = crypto.randomBytes(48).toString("base64url");
  return withOAuthStateLock(() => {
    const now = Date.now();
    const current = loadClients().find((candidate) => candidate.client_id === client.client_id);
    if (!current || !isClientActive(current) ||
        effectiveClientTokenVersion(current) !== effectiveClientTokenVersion(client)) return null;
    const tokens = loadRefreshTokens();
    const index = tokens.findIndex((candidate) => (
      candidate.client_id === client.client_id &&
      (candidate.client_version ?? 1) === effectiveClientTokenVersion(current) &&
      candidate.expires_at > now &&
      safeHashEqual(candidate.token_hash, presentedHash)
    ));
    if (index < 0) {
      const active = tokens.filter((candidate) => candidate.expires_at > now);
      if (active.length !== tokens.length) saveRefreshTokens(active);
      return null;
    }
    const [consumed] = tokens.splice(index, 1);
    tokens.push({
      token_hash: hashRefreshToken(replacement),
      client_id: consumed.client_id,
      scope: consumed.scope,
      created_at: new Date(now).toISOString(),
      expires_at: now + config.refreshTokenExpirySeconds * 1000,
      client_version: effectiveClientTokenVersion(current),
    });
    saveRefreshTokens(tokens.filter((candidate) => candidate.expires_at > now).slice(-MAX_REFRESH_TOKENS));
    return {
      refresh_token: replacement,
      expires_in: config.refreshTokenExpirySeconds,
      scope: consumed.scope,
    };
  });
}

function loadRefreshTokens(): RefreshTokenRecord[] {
  ensureDataDir();
  const storePath = refreshTokenStorePath();
  if (!fs.existsSync(storePath)) return [];
  const parsed = parsePrivateJson<RefreshTokenStore>(storePath, "Refresh token store is malformed");
  if (!parsed || !Array.isArray(parsed.tokens)) throw new Error("Refresh token store is malformed");
  if (parsed.tokens.some((candidate) => !(
    candidate &&
    typeof candidate.token_hash === "string" && /^[a-f0-9]{64}$/.test(candidate.token_hash) &&
    typeof candidate.client_id === "string" && CLIENT_ID_PATTERN.test(candidate.client_id) &&
    typeof candidate.scope === "string" &&
    typeof candidate.created_at === "string" &&
    Number.isSafeInteger(candidate.expires_at) && candidate.expires_at > 0 &&
    (candidate.client_version === undefined ||
      (Number.isSafeInteger(candidate.client_version) && candidate.client_version > 0))
  ))) throw new Error("Refresh token store is malformed");
  return parsed.tokens;
}

function saveRefreshTokens(tokens: RefreshTokenRecord[]): void {
  writePrivateJsonAtomically(refreshTokenStorePath(), { tokens } satisfies RefreshTokenStore);
}

function removeRefreshTokensUnlocked(clientId: string): void {
  const tokens = loadRefreshTokens();
  const remaining = tokens.filter((candidate) => candidate.client_id !== clientId);
  if (remaining.length !== tokens.length) saveRefreshTokens(remaining);
}

export async function revokeRefreshTokens(clientId: string): Promise<void> {
  if (!CLIENT_ID_PATTERN.test(clientId)) return;
  await withOAuthStateLock(() => removeRefreshTokensUnlocked(clientId));
}

function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function safeStringEqual(left: string, right: string): boolean {
  const leftHash = crypto.createHash("sha256").update(left).digest();
  const rightHash = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function loadRevokedTokens(): RevokedTokenRecord[] {
  ensureDataDir();
  const storePath = revokedTokenStorePath();
  if (!fs.existsSync(storePath)) return [];
  const parsed = parsePrivateJson<RevokedTokenStore>(storePath, "Revoked token store is malformed");
  if (!parsed || !Array.isArray(parsed.revoked_tokens) || parsed.revoked_tokens.some((record) => (
    !record || typeof record.jti !== "string" || !record.jti || record.jti.length > 256 ||
    !Number.isSafeInteger(record.exp) || record.exp <= 0
  ))) throw new Error("Revoked token store is malformed");
  return parsed.revoked_tokens;
}

function saveRevokedTokens(records: RevokedTokenRecord[]): void {
  writePrivateJsonAtomically(revokedTokenStorePath(), { revoked_tokens: records } satisfies RevokedTokenStore);
}

function verifySignedAccessToken(token: string, ignoreExpiration = false): TokenPayload | null {
  const config = loadRuntimeConfig();
  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ["HS256"],
      issuer: config.serverUrl,
      audience: config.serverUrl,
      ignoreExpiration,
    }) as TokenPayload;
    if (
      !payload || typeof payload.sub !== "string" || !CLIENT_ID_PATTERN.test(payload.sub) ||
      typeof payload.scope !== "string" || typeof payload.jti !== "string" || !payload.jti ||
      !Number.isSafeInteger(payload.exp) || (payload.exp as number) <= 0 ||
      (payload.client_version !== undefined &&
        (!Number.isSafeInteger(payload.client_version) || payload.client_version <= 0))
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

export function inspectAccessTokenForRevocation(token: string): TokenPayload | null {
  return verifySignedAccessToken(token, true);
}

export async function revokeAccessToken(payload: TokenPayload): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= nowSeconds) return;
  await withOAuthStateLock(() => {
    const records = loadRevokedTokens().filter((record) => record.exp > nowSeconds);
    if (!records.some((record) => safeStringEqual(record.jti, payload.jti))) {
      records.push({ jti: payload.jti, exp: payload.exp! });
      saveRevokedTokens(records);
      try {
        const client = loadClients().find((candidate) => candidate.client_id === payload.sub);
        if (client) appendClientLifecycleAudit("token_revoked", client);
      } catch {
        // Revocation is authoritative; an unavailable optional audit trail must not undo it.
        console.error("[OAuth] Unable to append the token revocation audit event");
      }
    }
  });
}

export function verifyAccessToken(token: string): TokenPayload | null {
  const payload = verifySignedAccessToken(token);
  if (!payload) return null;
  try {
    if (loadRevokedTokens().some((record) => safeStringEqual(record.jti, payload.jti))) return null;
    const client = findActiveClient(payload.sub);
    if (!client || (payload.client_version ?? 1) !== effectiveClientTokenVersion(client)) return null;
    return payload;
  } catch {
    console.error("[OAuth] OAuth lifecycle state is unreadable; access was denied.");
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
