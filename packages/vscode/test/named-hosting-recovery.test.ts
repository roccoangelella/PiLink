import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ConfigSnapshot } from "../src/configuration.js";
import { inspectManagedNamedHosting, restartManagedServerUnit } from "../src/named-hosting-recovery.js";

function fixture(t: test.TestContext): { snapshot: ConfigSnapshot; systemdUserDirectory: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vspilink-managed-server-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, "config");
  const systemdUserDirectory = path.join(root, "systemd", "user");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(systemdUserDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(configDirectory, 0o700);
    fs.chmodSync(systemdUserDirectory, 0o700);
  }
  const configPath = path.join(configDirectory, ".env");
  fs.writeFileSync(configPath, "PI_HOSTING_MODE=cloudflare-named\n", { mode: 0o600 });
  const snapshot: ConfigSnapshot = {
    configPath,
    configured: true,
    values: { PI_HOSTING_MODE: "cloudflare-named" },
    workspace,
    dataDir: configDirectory,
    coordinationDataDir: path.join(root, "coordination"),
    port: 3200,
    hostingMode: "cloudflare-named",
    unsafeFullAccess: false,
    fullAccessClientIds: [],
    serverUrl: "https://mcp.example.test",
    bootstrapSecret: "s".repeat(48),
    clients: [],
  };
  const unit = [
    "# Managed by VSPiLink hosting. Generated file; do not edit.",
    "[Service]",
    'ExecStart="/usr/bin/node" "/private/pilink-cli.js" "serve"',
    `Environment=${JSON.stringify(`PILINK_CONFIG=${configPath}`)}`,
    `Environment=${JSON.stringify("HOST=127.0.0.1")}`,
    `Environment=${JSON.stringify("PORT=3200")}`,
    `Environment=${JSON.stringify("SERVER_URL=https://mcp.example.test")}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(systemdUserDirectory, "vspilink-server.service"), unit, { mode: 0o600 });
  return { snapshot, systemdUserDirectory };
}

function namedHostingFixture(t: test.TestContext): { snapshot: ConfigSnapshot; systemdUserDirectory: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vspilink-named-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, "config");
  const stateDirectory = path.join(configDirectory, "cloudflare");
  const systemdUserDirectory = path.join(root, "systemd", "user");
  const workspace = path.join(root, "workspace");
  for (const directory of [configDirectory, stateDirectory, systemdUserDirectory, workspace]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  }

  const configPath = path.join(configDirectory, ".env");
  const mcpHostname = "mcp.customer.example";
  const landingHostname = "link.customer.example";
  const serverUrl = `https://${mcpHostname}`;
  fs.writeFileSync(configPath, [
    "PI_HOSTING_MODE=cloudflare-named",
    `SERVER_URL=${serverUrl}`,
    `PI_LANDING_HOSTNAME=${landingHostname}`,
    "PORT=3200",
    "",
  ].join("\n"), { mode: 0o600 });

  const snapshot: ConfigSnapshot = {
    configPath,
    configured: true,
    values: {
      PI_HOSTING_MODE: "cloudflare-named",
      PI_LANDING_HOSTNAME: landingHostname,
    },
    workspace,
    dataDir: configDirectory,
    coordinationDataDir: path.join(root, "coordination"),
    port: 3200,
    hostingMode: "cloudflare-named",
    unsafeFullAccess: false,
    fullAccessClientIds: [],
    serverUrl,
    bootstrapSecret: "s".repeat(48),
    clients: [],
  };

  const tunnelName = "customer-production";
  const credentialsPath = path.join(stateDirectory, "tunnel-credentials.json");
  const cloudflaredConfigPath = path.join(stateDirectory, "config.yml");
  fs.writeFileSync(credentialsPath, JSON.stringify({
    AccountTag: "a".repeat(32),
    TunnelID: "11111111-1111-4111-8111-111111111111",
    TunnelSecret: Buffer.alloc(32, 1).toString("base64"),
  }), { mode: 0o600 });
  fs.writeFileSync(cloudflaredConfigPath, [
    "# Managed by VSPiLink Cloudflare hosting. Do not add secrets here.",
    `tunnel: ${JSON.stringify(tunnelName)}`,
    `credentials-file: ${JSON.stringify(credentialsPath)}`,
    `metrics: ${JSON.stringify("127.0.0.1:49312")}`,
    "loglevel: info",
    "ingress:",
    `  - hostname: ${JSON.stringify(mcpHostname)}`,
    `    service: ${JSON.stringify("http://127.0.0.1:3200")}`,
    "    originRequest:",
    "      connectTimeout: 10s",
    `  - hostname: ${JSON.stringify(landingHostname)}`,
    `    service: ${JSON.stringify("http://127.0.0.1:3200")}`,
    "    originRequest:",
    "      connectTimeout: 10s",
    "  - service: http_status:404",
    "",
  ].join("\n"), { mode: 0o600 });

  const serverUnit = [
    "# Managed by VSPiLink hosting. Generated file; do not edit.",
    "[Service]",
    'ExecStart="/usr/bin/node" "/private/pilink-cli.js" "serve"',
    `Environment=${JSON.stringify(`PILINK_CONFIG=${configPath}`)}`,
    `Environment=${JSON.stringify("HOST=127.0.0.1")}`,
    `Environment=${JSON.stringify("PORT=3200")}`,
    `Environment=${JSON.stringify(`SERVER_URL=${serverUrl}`)}`,
    "",
  ].join("\n");
  const tunnelUnit = [
    "# Managed by VSPiLink hosting. Generated file; do not edit.",
    "[Unit]",
    "Requires=vspilink-server.service",
    "[Service]",
    `ExecStart=${["/usr/bin/cloudflared", "tunnel", "--config", cloudflaredConfigPath, "run", tunnelName].map(JSON.stringify).join(" ")}`,
    `ReadOnlyPaths=${JSON.stringify(stateDirectory)}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(systemdUserDirectory, "vspilink-server.service"), serverUnit, { mode: 0o600 });
  fs.writeFileSync(path.join(systemdUserDirectory, "vspilink-cloudflared.service"), tunnelUnit, { mode: 0o600 });
  return { snapshot, systemdUserDirectory };
}

test("managed chat restart touches only the verified server unit", async (t) => {
  const { snapshot, systemdUserDirectory } = fixture(t);
  const calls: string[][] = [];
  await restartManagedServerUnit(snapshot, {
    systemctlPath: "/usr/bin/systemctl",
    systemdUserDirectory,
  }, async (_executable, args) => {
    calls.push([...args]);
    return args.includes("is-active") ? { code: 0, stdout: "active\n" } : { code: 0, stdout: "" };
  });
  assert.deepEqual(calls, [
    ["--user", "restart", "vspilink-server.service"],
    ["--user", "is-active", "vspilink-server.service"],
  ]);
  assert.equal(JSON.stringify(calls).includes("cloudflared"), false);
});

test("managed chat restart rejects a server unit for another configuration", async (t) => {
  const { snapshot, systemdUserDirectory } = fixture(t);
  const unitPath = path.join(systemdUserDirectory, "vspilink-server.service");
  fs.writeFileSync(unitPath, fs.readFileSync(unitPath, "utf8").replace("PORT=3200", "PORT=9999"), { mode: 0o600 });
  await assert.rejects(
    restartManagedServerUnit(snapshot, { systemctlPath: "/usr/bin/systemctl", systemdUserDirectory }, async () => {
      throw new Error("runner must not be reached");
    }),
    /does not match the active private configuration/,
  );
});

test("named hosting recovery derives generic non-secret metadata from managed files", (t) => {
  const { snapshot, systemdUserDirectory } = namedHostingFixture(t);
  const evidence = inspectManagedNamedHosting(snapshot, { systemdUserDirectory });
  assert.equal(evidence.zoneConfirmed, false);
  assert.deepEqual(evidence.hosting, {
    kind: "cloudflare-named",
    tunnelName: "customer-production",
    zoneName: "customer.example",
    mcpHostname: "mcp.customer.example",
    landingHostname: "link.customer.example",
    publicUrl: "https://mcp.customer.example",
    cloudflareAuthKind: "origin-certificate",
  });
});

test("named hosting recovery preserves only a matching explicit credential reference", (t) => {
  const { snapshot, systemdUserDirectory } = namedHostingFixture(t);
  const evidence = inspectManagedNamedHosting(snapshot, {
    systemdUserDirectory,
    preferredHosting: {
      kind: "cloudflare-named",
      tunnelName: "customer-production",
      zoneName: "customer.example",
      mcpHostname: "mcp.customer.example",
      landingHostname: "link.customer.example",
      cloudflareAuthKind: "origin-certificate",
      credentialReference: "22222222-2222-4222-8222-222222222222",
      credentialLabel: "cloudflare-origin.pem",
    },
  });
  assert.equal(evidence.zoneConfirmed, true);
  assert.equal(evidence.hosting.credentialReference, "22222222-2222-4222-8222-222222222222");
  assert.equal(evidence.hosting.credentialLabel, "cloudflare-origin.pem");
});

test("named hosting recovery ignores stale preferences from another tunnel", (t) => {
  const { snapshot, systemdUserDirectory } = namedHostingFixture(t);
  const evidence = inspectManagedNamedHosting(snapshot, {
    systemdUserDirectory,
    preferredHosting: {
      kind: "cloudflare-named",
      tunnelName: "another-tunnel",
      zoneName: "customer.example",
      mcpHostname: "mcp.customer.example",
      landingHostname: "link.customer.example",
      cloudflareAuthKind: "origin-certificate",
      credentialReference: "33333333-3333-4333-8333-333333333333",
      credentialLabel: "unrelated.pem",
    },
  });
  assert.equal(evidence.zoneConfirmed, false);
  assert.equal(evidence.hosting.credentialReference, undefined);
  assert.equal(evidence.hosting.credentialLabel, undefined);
});
