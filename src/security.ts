import net from "node:net";
import type { NextFunction, Request, Response } from "express";
import { normalizeHttpOrigin } from "./config.js";
import { requestHostname } from "./oauth-owner.js";

const MCP_TRANSPORT_PATHS = new Set(["/sse", "/sse/", "/messages", "/messages/"]);
const CORS_ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "Accept",
  "Last-Event-ID",
  "Mcp-Session-Id",
  "Mcp-Protocol-Version",
  "Mcp-Method",
  "Mcp-Name",
].join(", ");

export function createCorsAndOriginProtection(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    const suppliedOrigin = req.headers.origin;
    let approvedOrigin: string | undefined;

    if (suppliedOrigin !== undefined) {
      try {
        approvedOrigin = normalizeHttpOrigin(suppliedOrigin, "Origin");
      } catch {
        approvedOrigin = undefined;
      }

      if (!approvedOrigin || !allowed.has(approvedOrigin)) {
        res.vary("Origin");
        if (MCP_TRANSPORT_PATHS.has(req.path)) {
          res.status(403).json({
            error: "invalid_origin",
            error_description: "Origin is not allowed for the MCP transport",
          });
          return;
        }
      } else {
        res.setHeader("Access-Control-Allow-Origin", approvedOrigin);
        res.vary("Origin");
        res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
        res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
        res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");
      }
    }

    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

export function createRateLimiter(maxRequests: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  cleanup.unref();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    // Keep independent budgets for distinct protected operations.  A normal
    // OAuth authorization flow touches several endpoints in quick succession;
    // sharing one counter across all of them could lock out a legitimate user
    // before the flow completes.
    const peer = rateLimitClientKey(req);
    const route = `${req.baseUrl}${req.path}`;
    const key = `${peer}\0${req.method}\0${route}`;
    const previous = hits.get(key);
    const entry = !previous || previous.resetAt <= now ? { count: 0, resetAt: now + windowMs } : previous;
    entry.count += 1;
    hits.set(key, entry);
    if (entry.count > maxRequests) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      res.status(429).json({ error: "rate_limited", error_description: "Too many requests" });
      return;
    }
    next();
  };
}

/**
 * Trust forwarding metadata only from the loopback reverse proxy used by the
 * managed cloudflared service. The closest valid X-Forwarded-For address wins,
 * so an attacker cannot rotate a leftmost value to reset the budget.
 * Loopback-host administration deliberately ignores forwarding headers.
 */
export function rateLimitClientKey(req: Request): string {
  const directPeer = normalizeIp(req.socket.remoteAddress) || "unknown";
  if (!isLoopbackIp(directPeer)) return directPeer;

  const hostname = requestHostname(req);
  if (!hostname || isLoopbackHostname(hostname)) return directPeer;

  const cloudflarePeer = singleIpHeader(req.headers["cf-connecting-ip"]);
  if (cloudflarePeer) return cloudflarePeer;

  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded !== "string" || forwarded.length > 8_192) return directPeer;
  const chain = forwarded.split(",");
  if (chain.length > 64) return directPeer;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = normalizeIp(chain[index]);
    if (candidate) return candidate;
  }
  return directPeer;
}

function singleIpHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || value.length > 128 || value.includes(",")) return undefined;
  return normalizeIp(value);
}

function normalizeIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let normalized = value.trim().toLowerCase();
  if (normalized.startsWith("::ffff:") && net.isIP(normalized.slice(7)) === 4) normalized = normalized.slice(7);
  return net.isIP(normalized) ? normalized : undefined;
}

function isLoopbackIp(value: string): boolean {
  if (value === "::1") return true;
  if (net.isIP(value) !== 4) return false;
  return value.split(".")[0] === "127";
}

function isLoopbackHostname(value: string): boolean {
  return value === "localhost" || value === "::1" || (net.isIP(value) === 4 && value.split(".")[0] === "127");
}
