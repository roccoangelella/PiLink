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

test("mutating commands are serialized and expose a busy label to the dashboard", () => {
  const register = methodSource("registerCommands");
  assert.match(register, /const operation = \(label: string, callback: \(\) => Promise<unknown>\)/);
  assert.match(register, /operation\("Connecting ChatGPT"/);
  assert.match(register, /operation\("Setting up stable endpoint"/);
  assert.match(register, /operation\("Starting PiLink"/);

  const operation = methodSource("runOperation");
  assert.match(operation, /if \(this\.operationLabel\) throw/);
  assert.match(operation, /this\.operationLabel = label/);
  assert.match(operation, /finally/);
  assert.match(operation, /this\.operationLabel = ""/);
  assert.match(methodSource("dashboardState"), /operation: this\.operationLabel/);
});

test("fresh graphical setup fixes single-agent and project-folder safety policy", () => {
  const setup = methodSource("setupAndStart");
  assert.match(setup, /runtimeMode: DEFAULT_RUNTIME_MODE/);
  assert.match(setup, /provisionWizardConfiguration/);
  assert.doesNotMatch(setup, /accessMode|allow-unsafe-full-access/);

  const start = methodSource("startConfigured");
  assert.match(start, /snapshot\.unsafeFullAccess/);
  assert.match(start, /Reconfigure PiLink safely/);
  assert.match(start, /isLoopbackPortOccupied/);
  assert.doesNotMatch(start, /allow-unsafe-full-access/);
});

test("stable setup is the primary hosted path and preflights before remote provisioning", () => {
  const stable = methodSource("setupStable");
  assert.match(stable, /assertCanReconfigure/);
  assert.match(stable, /Cloudflare fixed domain/);
  assert.match(stable, /Existing HTTPS domain/);
  assert.doesNotMatch(stable, /Quick Tunnel|Named Tunnel|nip\.io|Full access/);

  const reconfigure = methodSource("reconfigure");
  assert.match(reconfigure, /assertCanReconfigure/);
  assert.match(reconfigure, /Cloudflare fixed domain/);
  assert.match(reconfigure, /Existing HTTPS domain/);
  assert.match(reconfigure, /Cloudflare Quick Tunnel/);
  assert.match(reconfigure, /Local only/);
  assert.doesNotMatch(reconfigure, /Full access|Public chat & orchestration|model provider/);

  const preflight = methodSource("assertCanReconfigure");
  assert.match(preflight, /detectExternalRuntime/);
  assert.match(preflight, /running outside this VS Code session/);
});

test("fixed-domain setup accepts one protected Cloudflare token and never persists the account token", () => {
  const collect = methodSource("collectHostingSelection");
  assert.match(collect, /Cloudflare API token/);
  assert.match(collect, /password: true/);
  assert.match(collect, /provisionFixedDomainViaCli/);
  assert.match(collect, /tunnelTokenFile: provisioned\.tokenFile/);

  const provision = methodSource("provisionFixedDomainViaCli");
  assert.match(provision, /runJsonCli/);
  assert.match(provision, /"fixed-domain-provision"/);
  assert.match(provision, /environment: \{ CLOUDFLARE_API_TOKEN: apiToken \}/);
  assert.match(provision, /isPathInside\(tokenDirectory, tokenFile\)/);
  assert.doesNotMatch(provision, /writePrivateFile\([^)]*apiToken|updateEnvValue\([^)]*apiToken/);

  const setup = methodSource("setupAndStart");
  assert.match(setup, /hosting\.tunnelTokenFile/);
  assert.match(setup, /PI_CLOUDFLARE_TOKEN_FILE/);
});

test("workspace selection preserves the explicit project and never uses process.cwd", () => {
  const scope = methodSource("configurationScope");
  assert.match(scope, /vscode\.workspace\.workspaceFolders/);
  assert.match(scope, /exact\.uri/);
  assert.match(scope, /containing\.uri/);
  assert.doesNotMatch(source, /process\.cwd\(\)/);
  assert.match(methodSource("defaultWorkspacePath"), /this\.selectedWorkspacePath/);
  assert.match(methodSource("requireWorkspace"), /assertExistingDirectory/);
  assert.match(methodSource("chooseWorkspace"), /previousSelection/);
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
  assert.match(switchMode, /process\.env\.PI_RUNTIME_MODE/);
});

test("launcher state excludes collaboration and activity payloads", () => {
  const state = methodSource("dashboardState");
  assert.doesNotMatch(state, /readAdminCollaboration|collaboration|activity/);
  assert.doesNotMatch(source, /readAdminCollaboration|agent_chat_|agent_task_/);
});
