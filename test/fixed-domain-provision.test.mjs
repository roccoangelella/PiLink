import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { provisionFixedDomainTunnel } from "../dist/hosting/fixed-domain.js";

const accountId = "a".repeat(32);
const zoneId = "b".repeat(32);
const recordId = "c".repeat(32);
const tunnelId = "11111111-2222-4333-8444-555555555555";
const hostname = "mcp.example.com";
const origin = "http://127.0.0.1:3200";
const apiToken = "cloudflare-test-api-token-abcdefghijklmnopqrstuvwxyz";
const tunnelToken = "eyJ.test-scoped-cloudflare-tunnel-token.abcdefghijklmnopqrstuvwxyz";

function response(result, status = 200) {
  return new Response(JSON.stringify({ success: status >= 200 && status < 300, result, errors: [] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function exactTunnelConfig() {
  return {
    config: {
      ingress: [
        { hostname, service: origin, originRequest: {} },
        { service: "http_status:404" },
      ],
    },
  };
}

test("fixed-domain API provisioning creates tunnel, ingress, DNS, and a private run-token file", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-cf-api-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || "GET";
    calls.push({ method, pathname: url.pathname, search: url.search, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: init.headers?.Authorization });
    assert.equal(init.headers?.Authorization, `Bearer ${apiToken}`);
    if (method === "GET" && url.pathname === "/client/v4/zones" && url.searchParams.get("name") === "mcp.example.com") return response([]);
    if (method === "GET" && url.pathname === "/client/v4/zones" && url.searchParams.get("name") === "example.com") {
      return response([{ id: zoneId, name: "example.com", status: "active", account: { id: accountId } }]);
    }
    if (method === "GET" && url.pathname === `/client/v4/accounts/${accountId}/cfd_tunnel`) return response([]);
    if (method === "POST" && url.pathname === `/client/v4/accounts/${accountId}/cfd_tunnel`) return response({ id: tunnelId, name: calls.at(-1).body.name });
    if (method === "PUT" && url.pathname === `/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`) return response({});
    if (method === "GET" && url.pathname === `/client/v4/zones/${zoneId}/dns_records`) return response([]);
    if (method === "POST" && url.pathname === `/client/v4/zones/${zoneId}/dns_records`) return response({ id: recordId });
    if (method === "GET" && url.pathname === `/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`) return response(tunnelToken);
    throw new Error(`unexpected Cloudflare API call: ${method} ${url.pathname}${url.search}`);
  };

  const result = await provisionFixedDomainTunnel({
    hostname,
    origin,
    apiToken,
    tokenDirectory: path.join(root, "cloudflare"),
    fetch,
  });

  assert.equal(result.hostname, hostname);
  assert.equal(result.zoneName, "example.com");
  assert.equal(result.tunnelId, tunnelId);
  assert.equal(result.createdTunnel, true);
  assert.equal(result.updatedTunnelConfiguration, true);
  assert.equal(result.createdDnsRecord, true);
  assert.equal(result.enabledDnsProxy, false);
  assert.equal((await fs.readFile(result.tokenFile, "utf8")).trim(), tunnelToken);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(result.tokenFile)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(result.tokenFile))).mode & 0o777, 0o700);
  }
  assert.ok(calls.some((call) => call.method === "PUT" && call.body.config.ingress[0].hostname === hostname));
  assert.ok(calls.some((call) => call.method === "POST" && call.pathname.endsWith("/dns_records") && call.body.content === `${tunnelId}.cfargotunnel.com`));
  assert.ok(calls.every((call) => !JSON.stringify(call).includes(tunnelToken)));
});

test("fixed-domain API provisioning reuses an exact existing tunnel and refuses to rewrite unrelated state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-cf-api-existing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let mutations = 0;
  const tunnelName = "pilink-mcp-example-com-" + (await import("node:crypto")).createHash("sha256").update(hostname).digest("hex").slice(0, 10);
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || "GET";
    if (method !== "GET") mutations += 1;
    if (method === "GET" && url.pathname === "/client/v4/zones" && url.searchParams.get("name") === "mcp.example.com") return response([]);
    if (method === "GET" && url.pathname === "/client/v4/zones" && url.searchParams.get("name") === "example.com") return response([{ id: zoneId, name: "example.com", status: "active", account: { id: accountId } }]);
    if (method === "GET" && url.pathname === `/client/v4/accounts/${accountId}/cfd_tunnel`) return response([{ id: tunnelId, name: tunnelName }]);
    if (method === "GET" && url.pathname.endsWith(`/${tunnelId}/configurations`)) return response(exactTunnelConfig());
    if (method === "GET" && url.pathname === `/client/v4/zones/${zoneId}/dns_records`) return response([{ id: recordId, name: hostname, type: "CNAME", content: `${tunnelId}.cfargotunnel.com`, proxied: true }]);
    if (method === "GET" && url.pathname.endsWith(`/${tunnelId}/token`)) return response(tunnelToken);
    throw new Error(`unexpected Cloudflare API call: ${method} ${url.pathname}${url.search}`);
  };
  const result = await provisionFixedDomainTunnel({ hostname, origin, apiToken, tokenDirectory: path.join(root, "cloudflare"), fetch });
  assert.equal(result.createdTunnel, false);
  assert.equal(result.updatedTunnelConfiguration, false);
  assert.equal(result.createdDnsRecord, false);
  assert.equal(mutations, 0);
});

test("fixed-domain API provisioning rejects an occupied hostname without modifying DNS", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-cf-api-conflict-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tunnelName = "pilink-mcp-example-com-" + (await import("node:crypto")).createHash("sha256").update(hostname).digest("hex").slice(0, 10);
  let dnsMutated = false;
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || "GET";
    if (method === "GET" && url.pathname === "/client/v4/zones" && url.searchParams.get("name") === "mcp.example.com") return response([]);
    if (method === "GET" && url.pathname === "/client/v4/zones" && url.searchParams.get("name") === "example.com") return response([{ id: zoneId, name: "example.com", status: "active", account: { id: accountId } }]);
    if (method === "GET" && url.pathname === `/client/v4/accounts/${accountId}/cfd_tunnel`) return response([{ id: tunnelId, name: tunnelName }]);
    if (method === "GET" && url.pathname.endsWith(`/${tunnelId}/configurations`)) return response(exactTunnelConfig());
    if (method === "GET" && url.pathname === `/client/v4/zones/${zoneId}/dns_records`) return response([{ id: recordId, name: hostname, type: "A", content: "192.0.2.1", proxied: true }]);
    if (url.pathname.includes("dns_records") && method !== "GET") dnsMutated = true;
    throw new Error(`unexpected Cloudflare API call: ${method} ${url.pathname}${url.search}`);
  };
  await assert.rejects(
    provisionFixedDomainTunnel({ hostname, origin, apiToken, tokenDirectory: path.join(root, "cloudflare"), fetch }),
    /already occupied by an unrelated Cloudflare DNS record/,
  );
  assert.equal(dnsMutated, false);
});


test("fixed-domain CLI source scrubs an inherited account token after provisioning", async () => {
  const source = await fs.readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function configureCloudflareNamedHosting");
  const end = source.indexOf("async function questionSecret", start);
  assert.ok(start >= 0 && end > start);
  const configure = source.slice(start, end);
  assert.match(configure, /delete process\.env\.CLOUDFLARE_API_TOKEN/);
  assert.ok(configure.indexOf("delete process.env.CLOUDFLARE_API_TOKEN") > configure.indexOf("await provisionFixedDomainTunnel"));
});
