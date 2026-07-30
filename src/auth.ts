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

function clientStorePath(): string {
  return path.join(loadRuntimeConfig().dataDir, "clients.json");
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
  if (!Array.isArray(data.clients)) throw new Error("Client store is malformed");
  return data.clients;
}

export function saveClients(clients: OAuthClient[]): void {
  ensureDataDir();
  const clientsFile = clientStorePath();
  const store: ClientStore = { clients };
  const temporaryFile = `${clientsFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, clientsFile);
  fs.chmodSync(clientsFile, 0o600);
}

export function findClient(clientId: string): OAuthClient | undefined {
  return loadClients().find((c) => c.client_id === clientId);
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
  };

  const clients = loadClients();
  clients.push(client);
  saveClients(clients);

  return { client, client_secret: clientSecret };
}

export async function verifyClientSecret(
  client: OAuthClient,
  secret: string
): Promise<boolean> {
  return bcrypt.compare(secret, client.client_secret_hash);
}

export function createAuthorizationCode(
  clientId: string,
  redirectUri: string,
  scope: string,
  codeChallenge: string,
  codeChallengeMethod: string
): string {
  const code = crypto.randomBytes(32).toString("base64url");
  const authCode: AuthorizationCode = {
    code,
    client_id: clientId,
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
  clientId: string,
  scope: string
): { access_token: string; expires_in: number; token_type: string } {
  const config = loadRuntimeConfig();
  const payload: Omit<TokenPayload, "iat" | "exp"> = {
    sub: clientId,
    scope,
    iss: config.serverUrl,
    aud: config.serverUrl,
    jti: uuidv4(),
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

export function verifyAccessToken(token: string): TokenPayload | null {
  const config = loadRuntimeConfig();
  try {
    return jwt.verify(token, config.jwtSecret, {
      issuer: config.serverUrl,
      audience: config.serverUrl,
    }) as TokenPayload;
  } catch {
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
