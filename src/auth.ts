// ─────────────────────────────────────────────────────────────
// PI-MCP: OAuth 2.0 Token & Client Management
// ─────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import type { Request, Response, NextFunction } from "express";
import type { OAuthClient, AuthorizationCode, TokenPayload, ClientStore } from "./types.js";

const JWT_SECRET = process.env.JWT_SECRET || "pi-mcp-jwt-secret-change-me";
const TOKEN_EXPIRY = parseInt(process.env.TOKEN_EXPIRY || "3600", 10);
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3200";
const DATA_DIR = path.resolve(process.cwd(), "data");
const CLIENTS_FILE = path.join(DATA_DIR, "clients.json");

const authCodes = new Map<string, AuthorizationCode>();

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadClients(): OAuthClient[] {
  ensureDataDir();
  if (!fs.existsSync(CLIENTS_FILE)) {
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify({ clients: [] }, null, 2));
    return [];
  }
  const data: ClientStore = JSON.parse(fs.readFileSync(CLIENTS_FILE, "utf-8"));
  return data.clients;
}

export function saveClients(clients: OAuthClient[]): void {
  ensureDataDir();
  const store: ClientStore = { clients };
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(store, null, 2));
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
  const payload: Omit<TokenPayload, "iat" | "exp"> = {
    sub: clientId,
    scope,
    iss: SERVER_URL,
    aud: SERVER_URL,
    jti: uuidv4(),
  };

  const access_token = jwt.sign(payload, JWT_SECRET, {
    expiresIn: TOKEN_EXPIRY,
  });

  return {
    access_token,
    expires_in: TOKEN_EXPIRY,
    token_type: "Bearer",
  };
}

export function verifyAccessToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET, {
      issuer: SERVER_URL,
      audience: SERVER_URL,
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
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${SERVER_URL}/.well-known/oauth-protected-resource"`
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
