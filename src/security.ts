import type { NextFunction, Request, Response } from "express";

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
