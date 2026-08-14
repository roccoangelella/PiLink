import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CloudflareNamedTunnelHosting,
  HostingProvisionBlockedError,
  normalizeHostingOptions,
  redactCommand,
  renderCloudflaredConfig,
  renderSystemdUserUnits,
} from "../dist/hosting/index.js";

const TUNNEL_ID = "47a9020d-fe41-4971-a063-2dcabee7a8d4";
const ACCOUNT_ID = "a".repeat(32);
const ZONE_ID = "b".repeat(32);
const API_TOKEN = "c".repeat(40);

test("hosting validation only accepts numeric loopback origins and in-zone hostnames", async (t) => {
  const fixture = await createFixture(t, { authKind: "token" });
  const valid = normalizeHostingOptions(fixture.options);
  assert.equal(valid.origin, "http://127.0.0.1:3200");
  assert.equal(valid.zoneName, "example.com");

  const { zoneName: _omittedZone, ...missingZone } = fixture.options;
  assert.throws(
    () => normalizeHostingOptions(missingZone),
    /zoneName is required.*customer-owned Cloudflare DNS zone/,
  );

  for (const origin of [
    "http://0.0.0.0:3200",
    "http://localhost:3200",
    "http://192.168.1.20:3200",
    "https://127.0.0.1:3200",
    "http://127.0.0.1:3200/admin",
    "http://user:pass@127.0.0.1:3200",
  ]) {
    assert.throws(() => normalizeHostingOptions({ ...fixture.options, origin }), /origin must be/);
  }
  assert.throws(
    () => normalizeHostingOptions({ ...fixture.options, mcpHostname: "mcp.example.com.evil.invalid" }),
    /must be a subdomain/,
  );
  assert.throws(
    () => normalizeHostingOptions({ ...fixture.options, landingHostname: fixture.options.mcpHostname }),
    /must be distinct/,
  );

  const customer = normalizeHostingOptions({
    ...fixture.options,
    zoneName: "customer.example",
    mcpHostname: "mcp.customer.example",
    landingHostname: "connect.customer.example",
  });
  assert.equal(customer.zoneName, "customer.example");
});

test("generated ingress and user units keep secrets out and make the tunnel require the persistent server", async (t) => {
  const fixture = await createFixture(t, { authKind: "cert" });
  const normalized = normalizeHostingOptions(fixture.options);
  const config = renderCloudflaredConfig(normalized);
  const units = renderSystemdUserUnits(normalized);

  assert.match(config, /hostname: "mcp\.example\.com"/);
  assert.match(config, /hostname: "vspilink\.example\.com"/);
  assert.match(config, /service: "http:\/\/127\.0\.0\.1:3200"/);
  assert.match(config, /- service: http_status:404/);
  assert.ok(config.indexOf("mcp.example.com") < config.indexOf("vspilink.example.com"));
  assert.ok(config.indexOf("vspilink.example.com") < config.indexOf("http_status:404"));
  assert.doesNotMatch(config, /trycloudflare|--url|ARGO TUNNEL TOKEN|c{20}/i);

  assert.equal(units.server.name, "vspilink-server.service");
  assert.equal(units.tunnel.name, "vspilink-cloudflared.service");
  assert.match(units.server.content, new RegExp(escapeRegExp(`"${fixture.options.nodePath}" "${fixture.options.pilinkCliPath}" "serve"`)));
  assert.match(units.server.content, /Environment="HOST=127\.0\.0\.1"/);
  assert.match(units.server.content, /Environment="PORT=3200"/);
  assert.match(units.server.content, /Environment="SERVER_URL=https:\/\/mcp\.example\.com"/);
  assert.match(units.server.content, /Restart=on-failure/);
  assert.match(units.tunnel.content, /Requires=vspilink-server\.service/);
  assert.match(units.tunnel.content, /After=network-online\.target vspilink-server\.service/);
  assert.match(units.tunnel.content, /NoNewPrivileges=true/);
  assert.match(units.tunnel.content, /ProtectSystem=strict/);
  assert.doesNotMatch(units.tunnel.content, /cert-example|ARGO TUNNEL TOKEN|c{20}|--origincert|trycloudflare|--url/i);
});

test("dry-run plans a stable named tunnel without local or remote mutation", async (t) => {
  const fixture = await createFixture(t, { authKind: "cert" });
  const runner = new FakeRunner(fixture);
  const cloudflare = new FakeCloudflareApi();
  const hosting = new CloudflareNamedTunnelHosting(fixture.options, {
    runner,
    fetch: cloudflare.fetch,
  });

  const result = await hosting.provision();

  assert.equal(result.dryRun, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.actions.map((entry) => entry.kind), [
    "create-state-directory",
    "create-tunnel",
    "write-config",
    "create-dns-record",
    "create-dns-record",
  ]);
  assert.equal(await pathExists(fixture.stateDirectory), false);
  assert.equal(runner.calls.some((call) => call.args.includes("create")), false);
  assert.equal(cloudflare.mutations, 0);
  assert.equal(result.systemdUnits.tunnel.name, "vspilink-cloudflared.service");
});

test("provision is resumable, private, and idempotent for an account-certificate tunnel", async (t) => {
  const fixture = await createFixture(t, { authKind: "cert" });
  const runner = new FakeRunner(fixture);
  const cloudflare = new FakeCloudflareApi();
  const hosting = new CloudflareNamedTunnelHosting(fixture.options, {
    runner,
    fetch: cloudflare.fetch,
  });

  const first = await hosting.provision({ dryRun: false });
  assert.equal(first.changed, true);
  assert.equal(first.inspection.tunnel.id, TUNNEL_ID);
  assert.deepEqual(first.inspection.dns.map((entry) => entry.state), ["matching", "matching"]);
  assert.equal((await fs.stat(fixture.stateDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(fixture.credentialsPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(fixture.configPath)).mode & 0o777, 0o600);
  const config = await fs.readFile(fixture.configPath, "utf8");
  assert.doesNotMatch(config, new RegExp(API_TOKEN));
  assert.doesNotMatch(config, /ARGO TUNNEL TOKEN/);
  assert.equal(cloudflare.mutations, 2);
  assert.equal(runner.calls.some((call) => call.args.includes("--url")), false);
  assert.equal(runner.calls.some((call) => call.args.includes("start") || call.args.includes("enable")), false);

  const second = await hosting.provision({ dryRun: false });
  assert.equal(second.changed, false);
  assert.deepEqual(second.actions, []);
  assert.equal(cloudflare.mutations, 2);
});

test("an existing named tunnel safely recovers scoped credentials without printing them", async (t) => {
  const fixture = await createFixture(t, { authKind: "cert", createStateDirectory: true });
  const runner = new FakeRunner(fixture);
  runner.tunnelId = TUNNEL_ID;
  const cloudflare = new FakeCloudflareApi({
    records: matchingRecords(),
  });
  const hosting = new CloudflareNamedTunnelHosting(fixture.options, {
    runner,
    fetch: cloudflare.fetch,
    originIsOccupied: async () => false,
  });

  const plan = await hosting.plan();
  assert.ok(plan.actions.some((entry) => entry.kind === "recover-tunnel-credentials"));
  await hosting.provision({ dryRun: false });

  assert.equal((await fs.stat(fixture.credentialsPath)).mode & 0o777, 0o600);
  const recovery = runner.calls.find((call) => call.args.includes("token"));
  assert.ok(recovery);
  assert.equal(recovery.captureOutput, false);
  assert.doesNotMatch(redactCommand(recovery.command, recovery.args), new RegExp(escapeRegExp(fixture.certificatePath)));
  assert.doesNotMatch(redactCommand(recovery.command, recovery.args), new RegExp(escapeRegExp(fixture.credentialsPath)));
});

test("token customers use a per-tunnel token file and never call account APIs", async (t) => {
  const fixture = await createFixture(t, { authKind: "token" });
  const runner = new FakeRunner(fixture);
  let fetchCalled = false;
  const hosting = new CloudflareNamedTunnelHosting(fixture.options, {
    runner,
    fetch: async () => {
      fetchCalled = true;
      throw new Error("account API must not be called in token mode");
    },
  });

  const result = await hosting.provision({ dryRun: false });
  assert.equal(result.changed, true);
  assert.equal(fetchCalled, false);
  assert.deepEqual(result.inspection.dns.map((entry) => entry.state), ["external", "external"]);
  const config = await fs.readFile(fixture.configPath, "utf8");
  assert.match(config, new RegExp(TUNNEL_ID));
  assert.doesNotMatch(config, /credentials-file|test-tunnel-token/);
  assert.match(result.systemdUnits.tunnel.content, /--token-file/);
  assert.doesNotMatch(result.systemdUnits.tunnel.content, /test-tunnel-token/);
  assert.equal(runner.calls.some((call) => call.args.includes("create") || call.args.includes("route")), false);
});

test("insecure certificates and unmanaged configs block every real mutation", async (t) => {
  const fixture = await createFixture(t, { authKind: "cert", certificateMode: 0o644, createStateDirectory: true });
  await fs.writeFile(fixture.configPath, "tunnel: someone-elses-tunnel\n", { mode: 0o600 });
  const runner = new FakeRunner(fixture);
  const cloudflare = new FakeCloudflareApi();
  const hosting = new CloudflareNamedTunnelHosting(fixture.options, { runner, fetch: cloudflare.fetch });

  const plan = await hosting.plan();
  assert.match(plan.blockers.join("\n"), /origin certificate.*mode must be 0600/i);
  assert.match(plan.blockers.join("\n"), /not managed by PiLink/i);
  await assert.rejects(
    hosting.provision({ dryRun: false }),
    (error) => error instanceof HostingProvisionBlockedError,
  );
  assert.equal(cloudflare.calls, 0);
  assert.equal(runner.calls.some((call) => call.args.includes("create")), false);
});

test("lifecycle is explicit, dry-run by default, and starts both units through systemd dependencies", async (t) => {
  const fixture = await createFixture(t, { authKind: "cert" });
  const runner = new FakeRunner(fixture);
  const cloudflare = new FakeCloudflareApi();
  const hosting = new CloudflareNamedTunnelHosting(fixture.options, {
    runner,
    fetch: cloudflare.fetch,
    originIsOccupied: async () => false,
  });
  await hosting.provision({ dryRun: false });

  const preview = await hosting.start();
  assert.equal(preview.dryRun, true);
  assert.match(preview.command, /systemctl --user start vspilink-cloudflared\.service/);
  assert.equal(runner.lifecycleMutations, 0);

  const started = await hosting.start({ dryRun: false });
  assert.equal(started.state, "active");
  assert.equal(runner.services.get("vspilink-server.service"), "active");
  assert.equal(runner.services.get("vspilink-cloudflared.service"), "active");
  const stopped = await hosting.stop({ dryRun: false });
  assert.equal(stopped.state, "inactive");
  assert.equal(runner.services.get("vspilink-server.service"), "inactive");
  assert.equal(runner.services.get("vspilink-cloudflared.service"), "inactive");
});

test("command rendering redacts secret-bearing flags in split and inline forms", () => {
  const rendered = redactCommand("/usr/bin/cloudflared", [
    "tunnel",
    "--origincert",
    "/private/cert.pem",
    "run",
    "--token=very-secret-token",
    "--credentials-contents",
    "secret-json",
  ]);
  assert.doesNotMatch(rendered, /private\/cert|very-secret-token|secret-json/);
  assert.equal((rendered.match(/\[REDACTED\]/g) ?? []).length, 3);
});

class FakeRunner {
  constructor(fixture) {
    this.fixture = fixture;
    this.calls = [];
    this.tunnelId = null;
    this.services = new Map([
      ["vspilink-server.service", "inactive"],
      ["vspilink-cloudflared.service", "inactive"],
    ]);
    this.lifecycleMutations = 0;
  }

  async run(request) {
    this.calls.push({ ...request, args: [...request.args] });
    if (request.args.length === 1 && request.args[0] === "--version") {
      if (request.command === this.fixture.options.nodePath) {
        return { exitCode: 0, stdout: "v24.18.0\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "cloudflared version 2026.7.3\n", stderr: "" };
    }
    if (request.command === this.fixture.options.systemctlPath) return this.#systemctl(request.args);
    if (request.args.includes("list")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(this.tunnelId ? [{ id: this.tunnelId, name: this.fixture.options.tunnelName, connections: [] }] : []),
        stderr: "",
      };
    }
    if (request.args.includes("create")) {
      this.tunnelId = TUNNEL_ID;
      const outputPath = request.args[request.args.indexOf("--credentials-file") + 1];
      await fs.writeFile(outputPath, JSON.stringify({ TunnelID: TUNNEL_ID, TunnelSecret: "not-logged" }), { mode: 0o600 });
      return { exitCode: 0, stdout: "discarded", stderr: "" };
    }
    if (request.args.includes("token")) {
      const outputPath = request.args[request.args.indexOf("--cred-file") + 1];
      await fs.writeFile(outputPath, JSON.stringify({ TunnelID: TUNNEL_ID, TunnelSecret: "not-logged" }), { mode: 0o600 });
      return { exitCode: 0, stdout: "sensitive-output-must-be-discarded", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected fake command" };
  }

  #systemctl(args) {
    const operation = args[1];
    if (operation === "is-active") {
      const state = this.services.get(args[2]) ?? "unknown";
      return { exitCode: state === "active" ? 0 : state === "inactive" ? 3 : 4, stdout: `${state}\n`, stderr: "" };
    }
    if (operation === "start") {
      this.lifecycleMutations += 1;
      this.services.set("vspilink-server.service", "active");
      this.services.set("vspilink-cloudflared.service", "active");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (operation === "stop") {
      this.lifecycleMutations += 1;
      for (const unit of args.slice(2)) this.services.set(unit, "inactive");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected systemctl operation" };
  }
}

class FakeCloudflareApi {
  constructor({ records = new Map() } = {}) {
    this.records = new Map(records);
    this.calls = 0;
    this.mutations = 0;
    this.fetch = this.fetch.bind(this);
  }

  async fetch(input, init = {}) {
    this.calls += 1;
    assert.equal(init.headers.Authorization, `Bearer ${API_TOKEN}`);
    const url = new URL(input);
    const method = init.method ?? "GET";
    if (method !== "GET") this.mutations += 1;
    if (url.pathname === `/client/v4/zones/${ZONE_ID}` && method === "GET") {
      return response({ id: ZONE_ID, name: "example.com", status: "active" });
    }
    if (url.pathname === `/client/v4/zones/${ZONE_ID}/dns_records` && method === "GET") {
      const record = this.records.get(url.searchParams.get("name"));
      return response(record ? [record] : []);
    }
    if (url.pathname === `/client/v4/zones/${ZONE_ID}/dns_records` && method === "POST") {
      const body = JSON.parse(init.body);
      const record = {
        id: recordId(body.name),
        name: body.name,
        type: body.type,
        content: body.content,
        proxied: body.proxied,
      };
      this.records.set(body.name, record);
      return response(record);
    }
    const recordMatch = url.pathname.match(new RegExp(`^/client/v4/zones/${ZONE_ID}/dns_records/([0-9a-f]{32})$`));
    if (recordMatch && method === "PATCH") {
      const existing = [...this.records.values()].find((entry) => entry.id === recordMatch[1]);
      assert.ok(existing);
      existing.proxied = true;
      return response(existing);
    }
    return new Response(JSON.stringify({ success: false, errors: [{ code: 1000 }] }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function createFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-hosting-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secretsDirectory = path.join(root, "secrets");
  const stateDirectory = path.join(root, "state");
  const certificatePath = path.join(secretsDirectory, "cloudflare-origin.pem");
  const tokenFile = path.join(secretsDirectory, "tunnel-token");
  const pilinkConfigPath = path.join(secretsDirectory, "pilink.env");
  const pilinkCliPath = path.join(root, "dist", "cli.js");
  const credentialsPath = path.join(stateDirectory, "credentials.json");
  const configPath = path.join(stateDirectory, "config.yml");
  await fs.mkdir(secretsDirectory, { mode: 0o700 });
  await fs.mkdir(path.dirname(pilinkCliPath), { recursive: true });
  await fs.writeFile(pilinkCliPath, "// fixture\n", { mode: 0o644 });
  await fs.writeFile(pilinkConfigPath, "JWT_SECRET=fixture\n", { mode: 0o600 });
  if (options.authKind === "cert") {
    const payload = Buffer.from(JSON.stringify({ accountID: ACCOUNT_ID, zoneID: ZONE_ID, apiToken: API_TOKEN })).toString("base64");
    await fs.writeFile(
      certificatePath,
      `-----BEGIN ARGO TUNNEL TOKEN-----\n${payload}\n-----END ARGO TUNNEL TOKEN-----\n`,
      { mode: options.certificateMode ?? 0o600 },
    );
  } else {
    await fs.writeFile(tokenFile, "test-tunnel-token", { mode: 0o600 });
  }
  if (options.createStateDirectory) await fs.mkdir(stateDirectory, { mode: 0o700 });

  return {
    root,
    stateDirectory,
    certificatePath,
    tokenFile,
    credentialsPath,
    configPath,
    options: {
      tunnelName: "vspilink-example",
      origin: "http://127.0.0.1:3200",
      zoneName: "example.com",
      mcpHostname: "mcp.example.com",
      landingHostname: "vspilink.example.com",
      stateDirectory,
      configPath,
      credentialsPath,
      cloudflaredPath: "/opt/cloudflared",
      nodePath: "/opt/node-v24.18.0/bin/node",
      pilinkCliPath,
      pilinkConfigPath,
      systemctlPath: "/opt/systemctl",
      auth: options.authKind === "cert"
        ? { kind: "origin-certificate", certificatePath }
        : { kind: "tunnel-token-file", tokenFile, tunnelId: TUNNEL_ID, dnsManagedExternally: true },
    },
  };
}

function matchingRecords() {
  return new Map(["mcp.example.com", "vspilink.example.com"].map((hostname) => [
    hostname,
    {
      id: recordId(hostname),
      name: hostname,
      type: "CNAME",
      content: `${TUNNEL_ID}.cfargotunnel.com`,
      proxied: true,
    },
  ]));
}

function recordId(hostname) {
  return hostname.startsWith("mcp.") ? "d".repeat(32) : "e".repeat(32);
}

function response(result) {
  return new Response(JSON.stringify({ success: true, result, errors: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
