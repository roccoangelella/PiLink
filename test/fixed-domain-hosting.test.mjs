import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  fixedDomainCloudflaredArgs,
  normalizeFixedDomainHostname,
  normalizeFixedDomainTunnelId,
  resolveFixedDomainTokenFile,
} from "../dist/hosting/fixed-domain.js";

const TUNNEL_ID = "11111111-2222-4333-8444-555555555555";

test("fixed-domain hosting normalizes stable Cloudflare identities", () => {
  assert.equal(normalizeFixedDomainHostname("MCP.Example.COM."), "mcp.example.com");
  assert.equal(normalizeFixedDomainTunnelId(TUNNEL_ID.toUpperCase()), TUNNEL_ID);
  assert.throws(() => normalizeFixedDomainHostname("https://mcp.example.com"), /valid lowercase DNS hostname/);
  assert.throws(() => normalizeFixedDomainTunnelId("not-a-tunnel"), /valid UUID/);
  assert.throws(() => resolveFixedDomainTokenFile("/tmp/token#unsafe"), /cannot be stored safely/);
});

test("fixed-domain token files stay private and never enter cloudflared argv as values", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-fixed-domain-"));
  const tokenFile = path.join(root, "tunnel-token");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(tokenFile, "secret-token-value\n", { mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(tokenFile, 0o600);

  assert.equal(resolveFixedDomainTokenFile(tokenFile), tokenFile);
  assert.deepEqual(fixedDomainCloudflaredArgs({ tunnelId: TUNNEL_ID, tokenFile }), [
    "tunnel",
    "--no-autoupdate",
    "--loglevel",
    "info",
    "run",
    "--token-file",
    tokenFile,
    TUNNEL_ID,
  ]);
  assert.ok(!fixedDomainCloudflaredArgs({ tunnelId: TUNNEL_ID, tokenFile }).includes("secret-token-value"));

  if (process.platform !== "win32") {
    await fs.chmod(tokenFile, 0o644);
    assert.throws(() => resolveFixedDomainTokenFile(tokenFile), /chmod 600/);
  }
});
