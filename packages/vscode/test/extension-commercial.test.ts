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

test("chat readiness requires authenticated admin runtime and isolates Named tunnel restart", () => {
  const readiness = methodSource("ensureLocalChatRuntime");
  assert.match(readiness, /readAdminStatus\(/);
  assert.match(readiness, /inspectAdminAgentRuntime\(/);
  assert.match(readiness, /waitForAdminRuntime\(/);
  assert.match(readiness, /restartManagedChatServer\(snapshot\)/);
  assert.match(readiness, /isLoopbackPortOccupied\(/);
  assert.doesNotMatch(readiness, /startConfigured\(/);

  const localStart = methodSource("setupChatOnce");
  assert.match(localStart, /ensureLocalChatRuntime\(snapshot\)/);
  assert.doesNotMatch(localStart, /openPanel\(/);
});

test("workspace selection uses real WorkspaceFolder URIs and never process.cwd", () => {
  const scope = methodSource("configurationScope");
  assert.match(scope, /vscode\.workspace\.workspaceFolders/);
  assert.match(scope, /exactFolder\.uri/);
  assert.match(scope, /containingFolder\.uri/);
  assert.doesNotMatch(source, /process\.cwd\(\)/);
  assert.match(methodSource("setupChatOnce"), /selectWorkspace\(undefined, true\)/);
});

test("new chat tombstones the old selection and cancels before stop", () => {
  const newChat = methodSource("newChat");
  assert.match(newChat, /\+\+this\.chatSelectionGeneration/);
  assert.match(newChat, /rememberDismissedChatAgent\(agentId\)/);
  assert.ok(newChat.indexOf("cancelAdminAgentTurn") < newChat.indexOf("stopAdminAgent"));
  assert.match(newChat, /finally \{/);
  assert.match(newChat, /setActiveChatAgent\(undefined, selectionGeneration\)/);

  const state = methodSource("localChatState");
  assert.match(state, /dismissedChatAgentIds\.has/);
  assert.match(state, /selectionGeneration !== this\.chatSelectionGeneration/);
});

test("ChatGPT MCP connection is primary and opens the real VS Code integrated browser", () => {
  const browser = methodSource("openIntegratedBrowser");
  assert.match(browser, /getCommands\(true\)/);
  assert.match(browser, /workbench\.action\.browser\.open/);
  assert.match(browser, /openToSide: true/);
  assert.match(browser, /reuseUrlFilter\?: string/);
  assert.match(browser, /\.\.\.\(reuseUrlFilter \? \{ reuseUrlFilter \} : \{\}\)/);
  assert.match(browser, /vscode\.env\.openExternal/);
  assert.match(browser, /Open in system browser/);
  assert.match(browser, /action !== "Open in system browser"/);
  assert.match(browser, /try \{/);
  assert.match(browser, /catch \{/);
  assert.doesNotMatch(browser, /simpleBrowser|webview|iframe/i);

  const connect = methodSource("connectChatGpt");
  assert.match(connect, /state\.externalMcp\.configured/);
  assert.match(connect, /state\.externalMcp\.connected/);
  assert.match(connect, /this\.openChatGpt\("work"\)/);
  assert.match(connect, /this\.wizard\.resumeRuntime/);
  assert.match(connect, /clipboard\.writeText\(state\.mcpUrl\)/);
  assert.match(connect, /destination: "work"/);
  assert.doesNotMatch(connect, /configureAgents/);

  const openChat = methodSource("openChatGptInVsCode");
  assert.match(openChat, /this\.openChatGpt\("work"\)/);

  const navigate = methodSource("openChatGpt");
  assert.match(navigate, /chatGptNavigation\(destination\)/);
  assert.match(navigate, /navigation\.reuseUrlFilter/);
  assert.doesNotMatch(navigate, /"https:\/\/chatgpt\.com\/\*\*"/);

  const pairing = methodSource("pairWizardOwner");
  assert.match(pairing, /requirePersistentBrowserStorage\(\)/);
  assert.match(pairing, /searchParams\.set\("continue", navigation\.url\)/);
  assert.match(pairing, /openIntegratedBrowser\(/);

  const storage = methodSource("requirePersistentBrowserStorage");
  assert.match(storage, /storage !== "ephemeral"/);
  assert.match(storage, /workbench\.browser\.dataStorage/);

  const monitor = methodSource("openCollaborationMonitor");
  assert.match(monitor, /shellArgs: \[cliPath, "chat"\]/);
  assert.match(monitor, /PILINK_CONFIG: snapshot\.configPath/);
  assert.match(monitor, /samePath\(snapshot\.workspace, workspacePath\)/);
  assert.match(monitor, /isPathInside\(snapshot\.workspace, snapshot\.dataDir\)/);
  assert.doesNotMatch(monitor, /configureAgents|setupChat/);
});


test("fixed-domain wizard provisions Cloudflare from one protected API token", () => {
  const collect = methodSource("collectHostingSelection");
  const fixedStart = collect.indexOf('if (kind === "cloudflare-fixed")');
  const fixedEnd = collect.indexOf('if (kind === "custom-domain")', fixedStart);
  assert.ok(fixedStart >= 0 && fixedEnd > fixedStart);
  const fixed = collect.slice(fixedStart, fixedEnd);
  assert.match(fixed, /Cloudflare API token/);
  assert.match(fixed, /password: true/);
  assert.match(fixed, /provisionFixedDomainViaCli/);
  assert.doesNotMatch(fixed, /Cloudflare tunnel UUID|selectCloudflareCredential|Route is configured/);

  const provision = methodSource("provisionFixedDomainViaCli");
  assert.match(provision, /runJsonCli/);
  assert.match(provision, /"fixed-domain-provision"/);
  assert.match(provision, /environment: \{ CLOUDFLARE_API_TOKEN: apiToken \}/);
  assert.match(provision, /cloudflareCredentials\.store\("tunnel-token-file", tokenFile\)/);
  assert.doesNotMatch(provision, /args: \[[^\]]*apiToken/s);
});
