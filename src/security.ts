import type { NextFunction, Request, Response } from "express";
import { normalizeHttpOrigin } from "./config.js";

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
    const key = req.ip || req.socket.remoteAddress || "unknown";
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
