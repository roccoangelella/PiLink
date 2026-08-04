import assert from "node:assert/strict";
import test from "node:test";

import { isLocalAdminRequest, requestHostname } from "../dist/oauth-owner.js";

function request(host, remoteAddress = "127.0.0.1", forwardedHostname = "localhost") {
  return {
    headers: { host, "x-forwarded-host": forwardedHostname },
    hostname: forwardedHostname,
    socket: { remoteAddress },
  };
}

test("local administration uses the raw Host header and a loopback peer", () => {
  assert.equal(requestHostname(request("127.0.0.1:3200")), "127.0.0.1");
  assert.equal(requestHostname(request("[::1]:3200")), "::1");
  assert.equal(isLocalAdminRequest(request("127.0.0.1:3200")), true);
  assert.equal(isLocalAdminRequest(request("[::1]:3200", "::1")), true);

  // trust proxy may make req.hostname look local. A public raw Host must still
  // fail closed even when the TCP peer is the loopback cloudflared process.
  assert.equal(isLocalAdminRequest(request("mcp.example.com", "127.0.0.1", "localhost")), false);
  assert.equal(isLocalAdminRequest(request("localhost:3200", "203.0.113.10")), false);
  assert.equal(isLocalAdminRequest(request("localhost,evil.example")), false);
});
