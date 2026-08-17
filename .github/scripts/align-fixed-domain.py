from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


cli_path = Path("src/cli.ts")
cli = cli_path.read_text(encoding="utf-8")
cli = cli.replace('type HostingMode = "quick-tunnel" | "nip-io" | "cloudflare-named";', 'type HostingMode = "quick-tunnel" | "nip-io" | "cloudflare-fixed";')
cli = cli.replace('hostingMode === "cloudflare-named"', 'hostingMode === "cloudflare-fixed"')
cli = cli.replace('configuredMode === "cloudflare-named"', 'configuredMode === "cloudflare-fixed"')
cli = cli.replace('configuredMode !== "cloudflare-named"', 'configuredMode !== "cloudflare-fixed"')
cli = cli.replace("PI_HOSTING_MODE must be 'quick-tunnel', 'nip-io', or 'cloudflare-named'", "PI_HOSTING_MODE must be 'quick-tunnel', 'nip-io', or 'cloudflare-fixed'")
cli = cli.replace('return "cloudflare-named";', 'return "cloudflare-fixed";')
cli = cli.replace('PI_HOSTING_MODE: "cloudflare-named",', 'PI_HOSTING_MODE: "cloudflare-fixed",')
cli = cli.replace('process.env.PI_HOSTING_MODE = "cloudflare-named";', 'process.env.PI_HOSTING_MODE = "cloudflare-fixed";')
cli_path.write_text(cli, encoding="utf-8")

tests_path = Path("test/cli-guided-setup.test.mjs")
tests = tests_path.read_text(encoding="utf-8").replace('PI_HOSTING_MODE=cloudflare-named', 'PI_HOSTING_MODE=cloudflare-fixed')
tests_path.write_text(tests, encoding="utf-8")

model_path = Path("packages/vscode/src/hosting-model.ts")
model = model_path.read_text(encoding="utf-8")
model = replace_once(
    model,
    'export const HOSTING_KINDS = ["quick-tunnel", "cloudflare-named", "custom-domain", "local", "nip-io"] as const;',
    'export const HOSTING_KINDS = ["quick-tunnel", "cloudflare-fixed", "cloudflare-named", "custom-domain", "local", "nip-io"] as const;',
    "hosting kinds",
)
marker = '  if (kind === "cloudflare-named") {\n'
if model.count(marker) != 1:
    raise SystemExit("cloudflare-named normalizer marker missing")
fixed_normalizer = '''  if (kind === "cloudflare-fixed") {
    if (typeof candidate.publicUrl !== "string") return undefined;
    const publicUrl = normalizePublicBaseUrl(candidate.publicUrl);
    const tunnelId = normalizeTunnelId(candidate.tunnelId);
    if (!publicUrl || !tunnelId) return undefined;
    const credentialReference = allowCredentialReference && typeof candidate.credentialReference === "string" &&
      /^[0-9a-f-]{36}$/i.test(candidate.credentialReference) ? candidate.credentialReference : undefined;
    const credentialLabel = allowCredentialReference && typeof candidate.credentialLabel === "string"
      ? candidate.credentialLabel.replace(/[\\r\\n\\0]/g, "").slice(0, 160)
      : undefined;
    return {
      kind,
      publicUrl,
      tunnelId,
      cloudflareAuthKind: "tunnel-token-file",
      ...(credentialReference ? { credentialReference } : {}),
      ...(credentialLabel ? { credentialLabel } : {}),
    };
  }
'''
model = model.replace(marker, fixed_normalizer + marker, 1)
model = replace_once(
    model,
    '    case "cloudflare-named":\n      return { command: "serve", public: true, stable: true };\n',
    '    case "cloudflare-fixed":\n      return { command: "start", public: true, stable: true };\n    case "cloudflare-named":\n      return { command: "serve", public: true, stable: true };\n',
    "hosting start plan",
)
model = replace_once(
    model,
    '    case "cloudflare-named": return "Cloudflare fixed domain (Named Tunnel)";\n',
    '    case "cloudflare-fixed": return "Cloudflare fixed domain (Named Tunnel)";\n    case "cloudflare-named": return "Managed Cloudflare Named Tunnel";\n',
    "hosting labels",
)
model_path.write_text(model, encoding="utf-8")

config_path = Path("packages/vscode/src/configuration.ts")
config = config_path.read_text(encoding="utf-8")
switch_marker = '  switch (options.hosting.kind) {\n'
if config.count(switch_marker) != 1:
    raise SystemExit("configuration hosting switch marker missing")
fixed_case = '''  switch (options.hosting.kind) {
    case "cloudflare-fixed":
      if (!options.hosting.publicUrl || !options.hosting.tunnelId) {
        throw new Error("Configure the Cloudflare fixed hostname and tunnel UUID.");
      }
      contents = updateEnvValue(contents, "PI_HOSTING_MODE", "cloudflare-fixed");
      contents = updateEnvValue(contents, "TRUST_PROXY", "true");
      contents = updateEnvValue(contents, "SERVER_URL", options.hosting.publicUrl);
      contents = updateEnvValue(contents, "PI_CLOUDFLARE_TUNNEL_ID", options.hosting.tunnelId);
      contents = removeEnvValue(contents, "PI_LANDING_HOSTNAME");
      break;
'''
config = config.replace(switch_marker, fixed_case, 1)
runtime_key_anchor = '  "PI_CLOUDFLARED_SHA256",\n'
config = replace_once(
    config,
    runtime_key_anchor,
    runtime_key_anchor + '  "PI_CLOUDFLARE_TUNNEL_ID",\n  "PI_CLOUDFLARE_TOKEN_FILE",\n',
    "runtime environment keys",
)
config_path.write_text(config, encoding="utf-8")

ext_path = Path("packages/vscode/src/extension.ts")
ext = ext_path.read_text(encoding="utf-8")
ext = replace_once(
    ext,
    '        label: "Cloudflare fixed domain (Named Tunnel)",\n        description: "Recommended for production · stable SSE/OAuth URL and automatic startup",\n        value: "cloudflare-named" as const,\n      },\n      {\n        label: "Existing HTTPS domain",',
    '        label: "Cloudflare fixed domain (Named Tunnel)",\n        description: "Stable SSE/OAuth URL · works with a remotely managed tunnel token",\n        value: "cloudflare-fixed" as const,\n      },\n      {\n        label: "Managed Cloudflare Named Tunnel",\n        description: "Advanced Linux deployment · managed DNS and persistent systemd services",\n        value: "cloudflare-named" as const,\n      },\n      {\n        label: "Existing HTTPS domain",',
    "guided hosting choices",
)
collect_anchor = '    if (kind === "local" || kind === "quick-tunnel") return { kind };\n'
fixed_collect = '''    if (kind === "local" || kind === "quick-tunnel") return { kind };
    if (kind === "cloudflare-fixed") {
      const publicUrl = await vscode.window.showInputBox({
        title: "Fixed Cloudflare HTTPS origin",
        prompt: "Enter the hostname routed by your remotely managed Cloudflare Tunnel. Do not include /sse.",
        placeHolder: "https://mcp.example.com",
        ignoreFocusOut: true,
        validateInput: validatePublicHttpsOrigin,
      });
      if (!publicUrl) return undefined;
      const tunnelId = await vscode.window.showInputBox({
        title: "Cloudflare tunnel UUID",
        placeHolder: "00000000-0000-4000-8000-000000000000",
        ignoreFocusOut: true,
        validateInput: validateTunnelId,
      });
      if (!tunnelId) return undefined;
      const credential = await this.selectCloudflareCredential("tunnel-token-file");
      if (!credential) return undefined;
      const normalized = normalizeHostingSelection({
        kind,
        publicUrl,
        tunnelId,
        cloudflareAuthKind: "tunnel-token-file",
        credentialReference: credential.reference,
        credentialLabel: credential.label,
      }, true);
      if (!normalized) throw new Error("Invalid Cloudflare fixed-domain configuration.");
      return normalized;
    }
'''
ext = replace_once(ext, collect_anchor, fixed_collect, "fixed-domain VS Code collector")

provision_anchor = '''    provisionWizardConfiguration({
      configPath: snapshot.configPath,
      workspace,
      hosting,
      port: snapshot.port,
      runtimeMode: this.effectiveRuntimeMode(snapshot),
    });
'''
provision_insert = provision_anchor + '''    if (hosting.kind === "cloudflare-fixed") {
      if (!hosting.credentialReference || !hosting.credentialLabel) {
        throw new Error("Cloudflare fixed-domain token-file reference is missing.");
      }
      const stored = await this.cloudflareCredentials.get({
        reference: hosting.credentialReference,
        kind: "tunnel-token-file",
        label: hosting.credentialLabel,
      });
      if (!stored || stored.kind !== "tunnel-token-file") {
        throw new Error("The selected Cloudflare tunnel token file is no longer available.");
      }
      let contents = fs.readFileSync(snapshot.configPath, "utf8");
      contents = updateEnvValue(contents, "PI_CLOUDFLARE_TOKEN_FILE", stored.filePath);
      writePrivateFile(snapshot.configPath, contents.endsWith("\\n") ? contents : `${contents}\\n`);
    }
'''
ext = replace_once(ext, provision_anchor, provision_insert, "fixed token file provisioning")
ext = replace_once(
    ext,
    '    const publicUrl = hosting.kind === "custom-domain"\n      ? hosting.publicUrl as string\n',
    '    const publicUrl = hosting.kind === "custom-domain" || hosting.kind === "cloudflare-fixed"\n      ? hosting.publicUrl as string\n',
    "fixed public URL selection",
)
ext = ext.replace(
    'snapshot.hostingMode === "cloudflare-named"\n            ? "The persistent service is not running. Start PiLink and the Named Tunnel?"',
    '(snapshot.hostingMode === "cloudflare-named" || snapshot.hostingMode === "cloudflare-fixed")\n            ? "The configured PiLink service is not running. Start PiLink and its Cloudflare tunnel?"',
    1,
)
ext = ext.replace(
    'if (snapshot.hostingMode === "cloudflare-named") await this.startConfigured();\n        else await this.runCli(["serve"], "Local · workspace access", false, snapshot.workspace);',
    'if (snapshot.hostingMode === "cloudflare-named" || snapshot.hostingMode === "cloudflare-fixed") await this.startConfigured();\n        else await this.runCli(["serve"], "Local · workspace access", false, snapshot.workspace);',
    1,
)
ext_path.write_text(ext, encoding="utf-8")

model_test_path = Path("packages/vscode/test/hosting-model.test.ts")
model_test = model_test_path.read_text(encoding="utf-8")
model_test = replace_once(
    model_test,
    '  assert.deepEqual(hostingStartPlan({ kind: "quick-tunnel" }), { command: "start", public: true, stable: false });\n',
    '  assert.deepEqual(hostingStartPlan({ kind: "quick-tunnel" }), { command: "start", public: true, stable: false });\n  assert.deepEqual(hostingStartPlan({ kind: "cloudflare-fixed", publicUrl: "https://mcp.test", tunnelId: "11111111-2222-4333-8444-555555555555" }), { command: "start", public: true, stable: true });\n',
    "fixed start plan test",
)
fixed_test_anchor = 'test("named tunnel fields are normalized without accepting credential paths from the webview", () => {\n'
fixed_test = '''test("fixed Cloudflare tunnel selection keeps the stable URL and token reference separate", () => {
  assert.deepEqual(normalizeHostingSelection({
    kind: "cloudflare-fixed",
    publicUrl: "https://MCP.Example.Test/",
    tunnelId: "11111111-2222-4333-8444-555555555555",
    credentialReference: "11111111-1111-4111-8111-111111111111",
    credentialLabel: "tunnel-token",
  }, true), {
    kind: "cloudflare-fixed",
    publicUrl: "https://mcp.example.test",
    tunnelId: "11111111-2222-4333-8444-555555555555",
    cloudflareAuthKind: "tunnel-token-file",
    credentialReference: "11111111-1111-4111-8111-111111111111",
    credentialLabel: "tunnel-token",
  });
  assert.equal(normalizeHostingSelection({
    kind: "cloudflare-fixed",
    publicUrl: "https://mcp.example.test",
    tunnelId: "not-a-uuid",
  }), undefined);
});

'''
if model_test.count(fixed_test_anchor) != 1:
    raise SystemExit("hosting model named test anchor missing")
model_test = model_test.replace(fixed_test_anchor, fixed_test + fixed_test_anchor, 1)
model_test_path.write_text(model_test, encoding="utf-8")

config_test_path = Path("packages/vscode/test/configuration.test.ts")
config_test = config_test_path.read_text(encoding="utf-8")
config_test += '''\n\ntest("fixed Cloudflare hosting persists a stable server URL without storing a token value", () => {\n  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vspilink-fixed-domain-"));\n  try {\n    const configPath = path.join(root, ".env");\n    provisionWizardConfiguration({\n      configPath,\n      workspace: root,\n      hosting: {\n        kind: "cloudflare-fixed",\n        publicUrl: "https://mcp.example.test",\n        tunnelId: "11111111-2222-4333-8444-555555555555",\n      },\n    });\n    const contents = fs.readFileSync(configPath, "utf8");\n    assert.match(contents, /^PI_HOSTING_MODE=cloudflare-fixed$/m);\n    assert.match(contents, /^SERVER_URL=https:\/\/mcp\\.example\\.test$/m);\n    assert.match(contents, /^PI_CLOUDFLARE_TUNNEL_ID=11111111-2222-4333-8444-555555555555$/m);\n    assert.doesNotMatch(contents, /PI_CLOUDFLARE_TOKEN_FILE=/);\n  } finally {\n    fs.rmSync(root, { recursive: true, force: true });\n  }\n});\n'''
config_test_path.write_text(config_test, encoding="utf-8")
