import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultConfigPath,
  localServerUrl,
  parseEnv,
  provisionWizardConfiguration,
  readConfigSnapshot,
  resolveConfigPath,
  updateEnvValue,
  writePrivateFile,
} from "../src/configuration.js";

function temporaryDirectory(t: test.TestContext, prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("parseEnv handles exports, quoting, escapes, comments and malformed lines", () => {
  const values = parseEnv([
    "# comment",
    "export ALPHA = first # ignored inline comment",
    "QUOTED=\"line\\nnext\\r\\\"quote\\\"\\\\tail\"",
    "SINGLE='literal # value'",
    "EMPTY=",
    "WITH_EQUALS=a=b=c",
    "URL=https://example.test/path#fragment",
    "INVALID-NAME=value",
    "not an assignment",
  ].join("\n"));

  assert.deepEqual(values, {
    ALPHA: "first",
    QUOTED: "line\nnext\r\"quote\"\\tail",
    SINGLE: "literal # value",
    EMPTY: "",
    WITH_EQUALS: "a=b=c",
    URL: "https://example.test/path#fragment",
  });
});

test("wizard provisioning creates paired private configuration and manages two custom hosts", (t) => {
  const root = temporaryDirectory(t, "vspilink-wizard-config-");
  const configPath = path.join(root, "private", ".env");
  const workspace = path.join(root, "workspace with spaces");
  fs.mkdirSync(workspace, { recursive: true });

  provisionWizardConfiguration({
    configPath,
    workspace,
    hosting: {
      kind: "custom-domain",
      publicUrl: "https://mcp.example.test",
      landingHostname: "link.example.test",
    },
    port: 4321,
  });
  const custom = parseEnv(fs.readFileSync(configPath, "utf8"));
  assert.equal(custom.PI_WORK_DIR, workspace);
  assert.equal(custom.PORT, "4321");
  assert.equal(custom.PI_HOSTING_MODE, "external");
  assert.equal(custom.SERVER_URL, "https://mcp.example.test");
  assert.equal(custom.PI_LANDING_HOSTNAME, "link.example.test");
  assert.equal(custom.PI_OAUTH_CONSENT_MODE, "paired");
  assert.equal(custom.TOKEN_EXPIRY, "3600");
  assert.equal(custom.PI_REFRESH_TOKEN_EXPIRY, "2592000");
  assert.equal(custom.PI_UNSAFE_FULL_ACCESS, "false");
  assert.ok(path.isAbsolute(custom.PI_COORDINATION_DATA_DIR));
  assert.equal(custom.PI_COORDINATION_DATA_DIR.startsWith(`${workspace}${path.sep}`), false);
  assert.equal(custom.TRUST_PROXY, "true");
  assert.ok((custom.JWT_SECRET || "").length >= 48);
  assert.ok((custom.PI_BOOTSTRAP_SECRET || "").length >= 48);
  if (process.platform !== "win32") assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);

  provisionWizardConfiguration({ configPath, workspace, hosting: { kind: "quick-tunnel" }, port: 4321 });
  const quick = parseEnv(fs.readFileSync(configPath, "utf8"));
  assert.equal(quick.PI_HOSTING_MODE, "quick-tunnel");
  assert.equal(quick.SERVER_URL, undefined);
  assert.equal(quick.PI_LANDING_HOSTNAME, undefined);
  assert.equal(quick.TRUST_PROXY, "true");
  assert.equal(quick.JWT_SECRET, custom.JWT_SECRET);
  assert.equal(quick.PI_BOOTSTRAP_SECRET, custom.PI_BOOTSTRAP_SECRET);
});

test("updateEnvValue replaces or appends values and round-trips serialization", () => {
  let contents = "export PORT = 3200\nKEEP=yes";
  contents = updateEnvValue(contents, "PORT", "4500");
  assert.equal(contents.split("\n")[0], "PORT=4500");

  const complexValue = "folder with spaces/#hash/\\quoted\"";
  contents = updateEnvValue(contents, "COMPLEX", complexValue);
  const parsed = parseEnv(contents);
  assert.equal(parsed.PORT, "4500");
  assert.equal(parsed.KEEP, "yes");
  assert.equal(parsed.COMPLEX, complexValue);

  assert.throws(() => updateEnvValue(contents, "INVALID-NAME", "value"), /Invalid configuration name/);
  assert.throws(() => updateEnvValue(contents, "VALID_NAME", "line one\nline two"), /Invalid configuration value/);
  assert.throws(() => updateEnvValue(contents, "VALID_NAME", "nul\0value"), /Invalid configuration value/);
});

test("configuration paths honor explicit, environment and default precedence", (t) => {
  const root = temporaryDirectory(t, "vspilink-paths-");
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const xdg = path.join(root, "xdg");

  assert.equal(defaultConfigPath({}, home), path.join(home, ".config", "pilink", ".env"));
  assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: xdg }, home), path.join(xdg, "pilink", ".env"));

  assert.equal(
    resolveConfigPath("${workspaceFolder}/private/pilink.env", workspace, {}, home),
    path.join(workspace, "private", "pilink.env"),
  );
  assert.equal(
    resolveConfigPath("", workspace, { PILINK_CONFIG: "${userHome}/custom/pilink.env" }, home),
    path.join(home, "custom", "pilink.env"),
  );
  assert.equal(
    resolveConfigPath("~/.pilink/instance.env", workspace, {}, home),
    path.join(home, ".pilink", "instance.env"),
  );
  assert.equal(
    resolveConfigPath("", workspace, { XDG_CONFIG_HOME: xdg }, home),
    path.join(xdg, "pilink", ".env"),
  );
});

test("writePrivateFile atomically creates and replaces a private file", (t) => {
  const root = temporaryDirectory(t, "vspilink-private-");
  const directory = path.join(root, "nested", "state");
  const filePath = path.join(directory, ".env");

  writePrivateFile(filePath, "FIRST=value\n");
  writePrivateFile(filePath, "SECOND=replaced\n");

  assert.equal(fs.readFileSync(filePath, "utf8"), "SECOND=replaced\n");
  assert.deepEqual(fs.readdirSync(directory), [".env"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
});

test("readConfigSnapshot applies defaults and never exposes client secret hashes", (t) => {
  const root = temporaryDirectory(t, "vspilink-snapshot-");
  const configPath = path.join(root, "config", ".env");
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private-data");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  writePrivateFile(configPath, [
    `PI_WORK_DIR=${workspace}`,
    `PI_DATA_DIR=${dataDir}`,
    "PORT=4321",
    "HOST=0.0.0.0",
    "PI_HOSTING_MODE=quick-tunnel",
    "PI_UNSAFE_FULL_ACCESS=true",
    "PI_FULL_ACCESS_CLIENT_IDS=pi_1111111111111111,pi_2222222222222222",
    "PI_BOOTSTRAP_SECRET=bootstrap-value",
  ].join("\n"));
  fs.writeFileSync(path.join(dataDir, "clients.json"), JSON.stringify({
    clients: [
      {
        client_id: "pi_public",
        client_name: "Visible client",
        client_secret_hash: "hash-must-never-be-exposed",
        client_secret: "plaintext-must-never-be-exposed",
        grant_types: ["authorization_code", 12, "client_credentials"],
        scope: "mcp:tools",
        created_at: "2026-08-03T00:00:00.000Z",
      },
      {
        client_id: "pi_chatgpt00000001",
        client_name: "ChatGPT VSPiLink",
        client_secret_hash: "hash-must-never-be-exposed",
        redirect_uris: ["https://chatgpt.com/connector/oauth/testCallback123"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
        scope: "mcp:tools offline_access",
        created_at: "2026-08-03T01:00:00.000Z",
        token_version: 2,
      },
      {
        client_id: "pi_disabled0000001",
        client_name: "ChatGPT disabled",
        client_secret_hash: "hash-must-never-be-exposed",
        redirect_uris: ["https://chatgpt.com/connector/oauth/disabled123"],
        grant_types: ["authorization_code"],
        scope: "mcp:tools",
        created_at: "2026-08-03T02:00:00.000Z",
        disabled_at: "2026-08-03T03:00:00.000Z",
      },
      { client_id: "missing-name", client_secret_hash: "another-hash" },
      null,
    ],
  }));
  fs.writeFileSync(path.join(dataDir, "refresh-tokens.json"), JSON.stringify({
    tokens: [
      {
        token_hash: "a".repeat(64),
        client_id: "pi_chatgpt00000001",
        scope: "mcp:tools offline_access",
        created_at: new Date().toISOString(),
        expires_at: Date.now() + 60_000,
        client_version: 2,
      },
      {
        token_hash: "b".repeat(64),
        client_id: "pi_public",
        scope: "mcp:tools",
        created_at: new Date().toISOString(),
        expires_at: Date.now() - 1,
      },
    ],
  }));

  const snapshot = readConfigSnapshot(configPath, path.join(root, "fallback"));
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.workspace, workspace);
  assert.equal(snapshot.dataDir, dataDir);
  assert.equal(snapshot.port, 4321);
  assert.equal(snapshot.serverUrl, "http://127.0.0.1:4321");
  assert.equal(snapshot.hostingMode, "quick-tunnel");
  assert.equal(snapshot.unsafeFullAccess, true);
  assert.deepEqual(snapshot.fullAccessClientIds, ["pi_1111111111111111", "pi_2222222222222222"]);
  assert.equal(snapshot.bootstrapSecret, "bootstrap-value");
  assert.equal(localServerUrl(snapshot), "http://127.0.0.1:4321");
  assert.deepEqual(snapshot.clients, [{
    id: "pi_public",
    name: "Visible client",
    grantTypes: ["authorization_code", "client_credentials"],
    scope: "mcp:tools",
    createdAt: "2026-08-03T00:00:00.000Z",
    chatGpt: false,
    authorized: false,
  }, {
    id: "pi_chatgpt00000001",
    name: "ChatGPT VSPiLink",
    grantTypes: ["authorization_code", "refresh_token"],
    scope: "mcp:tools offline_access",
    createdAt: "2026-08-03T01:00:00.000Z",
    chatGpt: true,
    authorized: true,
  }]);
  const publicClients = JSON.stringify(snapshot.clients);
  assert.doesNotMatch(publicClients, /client_secret|hash-must|plaintext-must/);

  const missingConfigPath = path.join(root, "missing", ".env");
  const fallbackWorkspace = path.join(root, "fallback-workspace");
  const defaults = readConfigSnapshot(missingConfigPath, fallbackWorkspace);
  assert.equal(defaults.configured, false);
  assert.equal(defaults.workspace, path.resolve(fallbackWorkspace));
  assert.equal(defaults.dataDir, path.dirname(missingConfigPath));
  assert.equal(defaults.port, 3200);
  assert.equal(defaults.hostingMode, "not configured");
  assert.equal(defaults.unsafeFullAccess, false);
  assert.deepEqual(defaults.fullAccessClientIds, []);
  assert.equal(defaults.serverUrl, "http://127.0.0.1:3200");
  assert.deepEqual(defaults.clients, []);

  const withoutFolder = readConfigSnapshot(missingConfigPath, "");
  assert.equal(withoutFolder.workspace, "");
});
