import crypto from "node:crypto";
import type { Request, Response } from "express";

const PAIRING_TTL_MS = 5 * 60 * 1000;
const OWNER_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_PENDING_PAIRINGS = 32;
const MAX_PAIRING_ATTEMPTS = 5;
const MAX_OWNER_SESSIONS = 16;
const VERIFICATION_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface PendingOwnerPairing {
  expiresAt: number;
  verificationHash: string;
  attempts: number;
}

const pairingCodes = new Map<string, PendingOwnerPairing>();
const ownerSessions = new Map<string, number>();
let registrationWindowExpiresAt = 0;

export interface OwnerPairing {
  pairingUrl: string;
  verificationCode: string;
  expiresAt: string;
}

export function createOwnerPairing(serverUrl: string): OwnerPairing {
  const now = Date.now();
  prune(now);
  if (pairingCodes.size >= MAX_PENDING_PAIRINGS) {
    const oldest = pairingCodes.keys().next().value as string | undefined;
    if (oldest) pairingCodes.delete(oldest);
  }
  const code = crypto.randomBytes(32).toString("base64url");
  const verificationCode = createVerificationCode();
  const expiresAt = now + PAIRING_TTL_MS;
  pairingCodes.set(hash(code), {
    expiresAt,
    verificationHash: hash(normalizeVerificationCode(verificationCode)!),
    attempts: 0,
  });
  registrationWindowExpiresAt = Math.max(registrationWindowExpiresAt, expiresAt);
  const pairingUrl = new URL("/oauth/pair", serverUrl);
  pairingUrl.searchParams.set("code", code);
  return {
    pairingUrl: pairingUrl.toString(),
    verificationCode,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function hasPendingOwnerPairing(code: unknown): boolean {
  if (typeof code !== "string" || code.length < 32 || code.length > 256) return false;
  const now = Date.now();
  prune(now);
  const pending = pairingCodes.get(hash(code));
  return Boolean(pending && pending.expiresAt > now);
}

export function isOwnerRegistrationWindowOpen(): boolean {
  const now = Date.now();
  prune(now);
  return registrationWindowExpiresAt > now;
}

export function consumeOwnerPairing(
  _req: Request,
  res: Response,
  code: unknown,
  verificationCode: unknown,
  serverUrl: string,
): boolean {
  if (typeof code !== "string" || code.length < 32 || code.length > 256) return false;
  const normalizedVerificationCode = normalizeVerificationCode(verificationCode);
  if (!normalizedVerificationCode) return false;
  const now = Date.now();
  prune(now);
  const codeHash = hash(code);
  const pending = pairingCodes.get(codeHash);
  if (!pending || pending.expiresAt <= now) return false;

  const presentedHash = hash(normalizedVerificationCode);
  const matched = crypto.timingSafeEqual(Buffer.from(presentedHash), Buffer.from(pending.verificationHash));
  if (!matched) {
    pending.attempts += 1;
    if (pending.attempts >= MAX_PAIRING_ATTEMPTS) pairingCodes.delete(codeHash);
    return false;
  }
  pairingCodes.delete(codeHash);

  if (ownerSessions.size >= MAX_OWNER_SESSIONS) {
    const oldest = ownerSessions.keys().next().value as string | undefined;
    if (oldest) ownerSessions.delete(oldest);
  }
  const session = crypto.randomBytes(32).toString("base64url");
  ownerSessions.set(hash(session), now + OWNER_SESSION_TTL_MS);
  const secure = new URL(serverUrl).protocol === "https:";
  const cookieName = secure ? "__Host-vspilink_owner" : "vspilink_owner";
  res.cookie(cookieName, session, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: OWNER_SESSION_TTL_MS,
  });
  return true;
}

export function hasOwnerSession(req: Request): boolean {
  const now = Date.now();
  prune(now);
  const cookies = parseCookies(req.headers.cookie);
  const presented = cookies.get("__Host-vspilink_owner") || cookies.get("vspilink_owner");
  if (!presented || presented.length > 256) return false;
  const expiresAt = ownerSessions.get(hash(presented));
  return Boolean(expiresAt && expiresAt > now);
}

export function hasBootstrapAccess(req: Request, expected: string): boolean {
  const authHeader = req.headers.authorization;
  const presented = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!presented || presented.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

export function isLocalAdminRequest(req: Request): boolean {
  const hostname = requestHostname(req);
  const remoteAddress = (req.socket.remoteAddress || "").toLowerCase();
  const loopbackHost = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  const loopbackPeer = remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
  return loopbackHost && loopbackPeer;
}

/**
 * Parse the HTTP Host header without consulting Express' trust-proxy setting.
 * Express may otherwise prefer X-Forwarded-Host, which must never decide
 * whether an administrative request is local.
 */
export function requestHostname(req: Request): string {
  const host = req.headers.host;
  if (typeof host !== "string" || !host || host.length > 512 || /[\0\r\n,]/u.test(host)) return "";
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

function parseCookies(header: string | undefined): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const pair of (header || "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    try {
      parsed.set(key, decodeURIComponent(value));
    } catch {
      // Ignore malformed cookies and fail closed.
    }
  }
  return parsed;
}

function prune(now: number): void {
  for (const [key, pairing] of pairingCodes) if (pairing.expiresAt <= now) pairingCodes.delete(key);
  for (const [key, expiresAt] of ownerSessions) if (expiresAt <= now) ownerSessions.delete(key);
  if (registrationWindowExpiresAt <= now) registrationWindowExpiresAt = 0;
}

function createVerificationCode(): string {
  const bytes = crypto.randomBytes(8);
  let raw = "";
  for (const byte of bytes) raw += VERIFICATION_ALPHABET[byte % VERIFICATION_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function normalizeVerificationCode(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 32) return undefined;
  const normalized = value.toUpperCase().replace(/[\s-]/gu, "");
  return /^[A-HJ-NP-Z2-9]{8}$/u.test(normalized) ? normalized : undefined;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
