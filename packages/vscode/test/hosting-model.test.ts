import assert from "node:assert/strict";
import test from "node:test";
import { hostingStartPlan, normalizeHostingSelection, normalizeMcpEndpointOrigin, normalizePublicBaseUrl } from "../src/hosting-model.js";

test("hosting selection accepts only strict HTTPS base URLs", () => {
  assert.deepEqual(normalizeHostingSelection({
    kind: "custom-domain",
    publicUrl: "https://mcp.example.test/",
    landingHostname: "Link.Example.Test.",
  }), {
    kind: "custom-domain",
    publicUrl: "https://mcp.example.test",
    landingHostname: "link.example.test",
  });
  for (const value of [
    "http://mcp.example.test",
    "https://user:pass@mcp.example.test",
    "https://mcp.example.test:8443",
    "https://mcp.example.test/path",
    "https://mcp.example.test?query=yes",
  ]) assert.equal(normalizePublicBaseUrl(value), undefined, value);
  assert.equal(normalizeHostingSelection({ kind: "custom-domain", publicUrl: "https://same.test", landingHostname: "same.test" }), undefined);
  assert.equal(normalizeHostingSelection({ kind: "custom-domain", publicUrl: "https://mcp.test", landingHostname: "bad_host" }), undefined);
});

test("hosting plans preserve public and local modes", () => {
  assert.deepEqual(hostingStartPlan({ kind: "quick-tunnel" }), { command: "start", public: true, stable: false });
  assert.deepEqual(hostingStartPlan({ kind: "custom-domain", publicUrl: "https://mcp.test" }), { command: "serve", public: true, stable: true });
  assert.deepEqual(hostingStartPlan({ kind: "local" }), { command: "serve", public: false, stable: true });
  assert.deepEqual(hostingStartPlan({ kind: "nip-io" }), { command: "start", public: true, stable: true });
});

test("managed MCP status normalizes an exact SSE endpoint to its HTTPS origin", () => {
  assert.equal(normalizeMcpEndpointOrigin("https://mcp.example.test/sse"), "https://mcp.example.test");
  assert.equal(normalizeMcpEndpointOrigin("https://mcp.example.test/"), "https://mcp.example.test");
  assert.equal(normalizeMcpEndpointOrigin("https://mcp.example.test/health"), undefined);
  assert.equal(normalizeMcpEndpointOrigin("http://mcp.example.test/sse"), undefined);
  assert.equal(normalizeMcpEndpointOrigin("https://user@mcp.example.test/sse"), undefined);
});

test("named tunnel fields are normalized without accepting credential paths from the webview", () => {
  const normalized = normalizeHostingSelection({
    kind: "cloudflare-named",
    tunnelName: "customer-production",
    zoneName: "example.test",
    mcpHostname: "mcp.example.test",
    landingHostname: "vspilink.example.test",
    cloudflareAuthKind: "origin-certificate",
    credentialReference: "11111111-1111-4111-8111-111111111111",
    credentialLabel: "cert.pem",
    certificatePath: "/must/not/cross",
  });
  assert.deepEqual(normalized, {
    kind: "cloudflare-named",
    tunnelName: "customer-production",
    zoneName: "example.test",
    mcpHostname: "mcp.example.test",
    landingHostname: "vspilink.example.test",
    publicUrl: "https://mcp.example.test",
    cloudflareAuthKind: "origin-certificate",
  });
  assert.equal(normalizeHostingSelection({
    kind: "cloudflare-named",
    tunnelName: "vspilink",
    zoneName: "example.com",
    mcpHostname: "mcp.evil.test",
    landingHostname: "link.example.com",
    cloudflareAuthKind: "origin-certificate",
  }), undefined);
  assert.equal(normalizeHostingSelection({
    kind: "cloudflare-named",
    tunnelName: "vspilink",
    zoneName: "example.com",
    mcpHostname: "mcp.example.com",
    landingHostname: "link.example.com",
    cloudflareAuthKind: "tunnel-token-file",
    tunnelId: "not-a-uuid",
  }), undefined);
});
