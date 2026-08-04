import assert from "node:assert/strict";
import test from "node:test";

import { createRateLimiter, rateLimitClientKey } from "../dist/security.js";

function request({
  remoteAddress = "127.0.0.1",
  host = "mcp.example.com",
  forwardedFor,
  cloudflareIp,
} = {}) {
  return {
    headers: {
      host,
      ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
      ...(cloudflareIp ? { "cf-connecting-ip": cloudflareIp } : {}),
    },
    socket: { remoteAddress },
    method: "POST",
    baseUrl: "/oauth/token",
    path: "/",
  };
}

function response() {
  return {
    statusCode: 200,
    payload: undefined,
    headers: new Map(),
    setHeader(name, value) { this.headers.set(name, value); },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.payload = value; return this; },
  };
}

test("rate-limit identity ignores attacker-controlled leftmost X-Forwarded-For values", () => {
  const first = request({ forwardedFor: "attacker-one, 203.0.113.40" });
  const second = request({ forwardedFor: "attacker-two, 203.0.113.40" });
  assert.equal(rateLimitClientKey(first), "203.0.113.40");
  assert.equal(rateLimitClientKey(second), "203.0.113.40");

  const limiter = createRateLimiter(2, 60_000);
  let accepted = 0;
  limiter(first, response(), () => { accepted += 1; });
  limiter(second, response(), () => { accepted += 1; });
  const blocked = response();
  limiter(request({ forwardedFor: "attacker-three, 203.0.113.40" }), blocked, () => { accepted += 1; });
  assert.equal(accepted, 2);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.payload.error, "rate_limited");
});

test("rate limiter ignores forwarding headers from direct peers and loopback-host admin calls", () => {
  assert.equal(rateLimitClientKey(request({
    remoteAddress: "198.51.100.25",
    forwardedFor: "203.0.113.1",
  })), "198.51.100.25");
  assert.equal(rateLimitClientKey(request({
    host: "localhost:3200",
    forwardedFor: "203.0.113.2",
    cloudflareIp: "203.0.113.3",
  })), "127.0.0.1");
});

test("managed Cloudflare requests prefer its single connecting-IP header", () => {
  assert.equal(rateLimitClientKey(request({
    forwardedFor: "192.0.2.1, 192.0.2.2",
    cloudflareIp: "2001:db8::15",
  })), "2001:db8::15");
});
