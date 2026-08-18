import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");

function methodSource(name: string): string {
  const expression = new RegExp(`\\n  private (?:async )?${name}\\(`, "u");
  const match = expression.exec(source);
  assert.ok(match, `missing ${name}`);
  const start = match.index;
  const next = source.indexOf("\n  private ", start + match[0].length);
  return source.slice(start, next === -1 ? source.length : next);
}

test("the extension controller is an MCP launcher rather than a multiproduct agent surface", () => {
  assert.doesNotMatch(source, /AgentAuthSidecar|OAuthClientService|WizardController|RuntimeModeStore/);
  assert.doesNotMatch(source, /registerNativeMcpProvider|setupChat\(|sendChat\(|spawnAgent\(|configureAgents\(/);
  assert.doesNotMatch(source, /startUnsafe\(|registerClient\(|connectNativeMcp\(|openCollaborationMonitor\(/);
  assert.match(source, /ProcessSupervisor/);
  assert.match(source, /createOwnerPairing/);
  assert.match(source, /readAdminStatus/);
});

test("registered commands expose a small public surface plus state-aware dashboard actions", () => {
  const register = methodSource("registerCommands");
  for (const command of [
    "openSidebar", "openPanel", "connectChatGpt", "stop", "guidedSetup", "openConfig", "refresh", "useWorkspace", "openDocs",
    "manageTrust", "chooseWorkspace", "setupStable", "setupQuick", "setupLocal", "start", "restart", "openChatGpt", "copyMcpUrl", "openTerminal", "switchToSingle",
  ]) assert.match(register, new RegExp(`register\\("${command}"`));
  assert.doesNotMatch(register, /startUnsafe|configureAgents|spawnAgent|connectNativeMcp|registerClient/);
});

test("fresh graphical setup fixes single-agent and project-folder safety policy", () => {
  const setup = methodSource("setupAndStart");
  assert.match(setup, /runtimeMode: DEFAULT_RUNTIME_MODE/);
  assert.match(setup, /provisionWizardConfiguration/);
  assert.doesNotMatch(setup, /accessMode|unsafeFullAccess|allow-unsafe-full-access/);

  const start = methodSource("startConfigured");
  assert.match(start, /snapshot\.unsafeFullAccess/);
  assert.match(start, /Reconfigure PiLink safely/);
  assert.doesNotMatch(start, /allow-unsafe-full-access/);
});

test("stable setup is the primary hosted path and does not expose legacy hosting products", () => {
  const stable = methodSource("setupStable");
  assert.match(stable, /Cloudflare fixed domain/);
  assert.match(stable, /Existing HTTPS domain/);
  assert.doesNotMatch(stable, /Quick Tunnel|Named Tunnel|nip\.io|Full access/);

  const reconfigure = methodSource("reconfigure");
  assert.match(reconfigure, /Cloudflare fixed domain/);
  assert.match(reconfigure, /Existing HTTPS domain/);
  assert.match(reconfigure, /Cloudflare Quick Tunnel/);
  assert.match(reconfigure, /Local only/);
  assert.doesNotMatch(reconfigure, /Full access|Public chat & orchestration|model provider/);
});

test("fixed-domain setup accepts one protected Cloudflare token and never persists the account token", () => {
  const collect = methodSource("collectHostingSelection");
  assert.match(collect, /Cloudflare API token/);
  assert.match(collect, /password: true/);
  assert.match(collect, /provisionFixedDomainViaCli/);

  const provision = methodSource("provisionFixedDomainViaCli");
  assert.match(provision, /runJsonCli/);
  assert.match(provision, /"fixed-domain-provision"/);
  assert.match(provision, /environment: \{ CLOUDFLARE_API_TOKEN: apiToken \}/);
  assert.match(provision, /isPathInside\(tokenDirectory, tokenFile\)/);
  assert.doesNotMatch(provision, /writePrivateFile\([^)]*apiToken|updateEnvValue\([^)]*apiToken/);
});

test("workspace selection uses VS Code folders and never process.cwd", () => {
  const scope = methodSource("configurationScope");
  assert.match(scope, /vscode\.workspace\.workspaceFolders/);
  assert.match(scope, /exact\.uri/);
  assert.match(scope, /containing\.uri/);
  assert.doesNotMatch(source, /process\.cwd\(\)/);
  assert.match(methodSource("requireWorkspace"), /selectWorkspace\(undefined, true\)/);
});

test("ChatGPT connection uses local owner verification and a real integrated browser", () => {
  const connect = methodSource("connectChatGpt");
  assert.match(connect, /state\.externalMcp\.connected/);
  assert.match(connect, /clipboard\.writeText\(state\.mcpUrl\)/);
  assert.match(connect, /pairOwner\(state\.publicUrl, snapshot, "plugins"\)/);
  assert.doesNotMatch(connect, /configureAgents|registerExternalClient|client_secret/);

  const pairing = methodSource("pairOwner");
  assert.match(pairing, /createOwnerPairing/);
  assert.match(pairing, /pairing\.verificationCode/);
  assert.match(pairing, /clipboard\.writeText\(pairing\.verificationCode\)/);
  assert.match(pairing, /searchParams\.set\("continue", navigation\.url\)/);
  assert.match(pairing, /openIntegratedBrowser/);

  const browser = methodSource("openIntegratedBrowser");
  assert.match(browser, /workbench\.action\.browser\.open/);
  assert.match(browser, /openToSide: true/);
  assert.match(browser, /vscode\.env\.openExternal/);
  assert.doesNotMatch(browser, /simpleBrowser|iframe/i);
});

test("Quick Tunnel authorization is bound to the observed transient origin", () => {
  const state = methodSource("dashboardState");
  assert.match(state, /QUICK_TUNNEL_AUTHORIZED_ORIGIN_KEY/);
  assert.match(state, /quickAuthorizedOrigin === publicUrl/);
  assert.match(state, /quickTunnel/);
  assert.match(state, /durableAuthorization/);
});

test("the extension refuses to manage processes it did not start", () => {
  const stop = methodSource("stopConfigured");
  assert.match(stop, /this\.supervisor\.isActive/);
  assert.match(stop, /running outside this VS Code session/);

  const restart = methodSource("restartConfigured");
  assert.match(restart, /running outside this VS Code session/);
  assert.match(restart, /snapshot\.unsafeFullAccess/);

  const switchMode = methodSource("switchToSingle");
  assert.match(switchMode, /detectExternalRuntime/);
  assert.match(switchMode, /PI_RUNTIME_MODE/);
  assert.match(switchMode, /"single"/);
});

test("activity monitoring remains metadata-only", () => {
  const state = methodSource("dashboardState");
  assert.match(state, /readAdminCollaboration/);
  assert.match(state, /activity = collaboration\.activity\.slice\(-8\)/);
  assert.match(state, /tool: item\.tool/);
  assert.match(state, /durationMs: item\.durationMs/);
  assert.match(state, /outcome: item\.outcome/);
  assert.doesNotMatch(state, /item\.arguments|item\.result|item\.prompt|item\.path/);
});
