import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const script = fs.readFileSync(new URL("../media/main.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../media/styles.css", import.meta.url), "utf8");

function functionSource(name: string): string {
  const start = script.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const next = script.indexOf("\n  function ", start + 12);
  return script.slice(start, next === -1 ? script.length : next);
}

test("the dashboard exposes an explicit runtime workflow and keeps surfaces separate", () => {
  assert.match(script, /brand__title", "PiLink"/);
  assert.match(script, /VSPiLink · optional VS Code extension/);
  assert.match(script, /restoredSurfaceMode\(restoredUiState\)/);
  assert.match(script, /value\.version === UI_STATE_VERSION/);
  assert.match(script, /setState\(\{ version: UI_STATE_VERSION, mode: uiMode \}\)/);
  assert.match(script, /selectRuntimeMode/);
  assert.match(script, /runtimeMode\.configured/);
  assert.match(functionSource("renderRuntimeModeChooser"), /Single-agent/);
  assert.match(functionSource("renderRuntimeModeChooser"), /Public chat & orchestration/);
  assert.match(functionSource("runtimeModeChoice"), /selectRuntimeMode/);
  const render = functionSource("render");
  assert.match(render, /renderRuntimeModeChooser\(\)/);
  assert.match(render, /renderRuntimeModePrompt\(\)/);
  assert.match(render, /uiMode === "remote"/);
  assert.match(render, /renderChatGptWorkspace\(\)/);
  assert.match(render, /renderRemoteAgents\(\)/);
  assert.match(render, /renderTaskBoard\(\)/);
  assert.match(render, /renderLocalModeIntro\(\)/);
  assert.match(render, /renderConversation\(\)/);
  assert.match(render, /renderServerDetails\(\)/);
});

test("volatile health timestamps do not trigger a visible-state render", () => {
  const healthSource = functionSource("healthIsOnline");
  const signatureSource = functionSource("visibleStateSignature");
  const signature = Function(`
    let hasReceivedState = true;
    function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
    function asText(value, fallback) {
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return fallback || "";
    }
    function errorMessage(value) { return value ? String(value) : ""; }
    ${healthSource}
    ${signatureSource}
    return visibleStateSignature;
  `)() as (state: Record<string, unknown>) => string;

  assert.doesNotMatch(signatureSource, /health:\s*state\.health/);
  assert.match(signatureSource, /healthOnline:\s*healthIsOnline\(state\.health\)/);
  assert.equal(
    signature({ health: { online: true, timestamp: "2026-08-04T10:00:00Z" } }),
    signature({ health: { online: true, timestamp: "2026-08-04T10:00:02Z" } }),
  );
  assert.notEqual(
    signature({ health: { online: true, timestamp: "2026-08-04T10:00:00Z" } }),
    signature({ health: { online: false, timestamp: "2026-08-04T10:00:02Z" } }),
  );
});

test("real renders preserve transcript, composer and disclosure state", () => {
  const render = functionSource("render");
  const capture = functionSource("captureRenderState");
  const restore = functionSource("restoreRenderState");

  assert.match(render, /const renderState = captureRenderState\(\)/);
  assert.match(render, /restoreRenderState\(renderState, revision\)/);
  assert.match(capture, /transcript\.scrollTop/);
  assert.match(capture, /document\.activeElement === input/);
  assert.match(capture, /draft: input\.value/);
  assert.match(capture, /details\[data-render-state-key\]/);
  assert.match(capture, /#vspilink-callback-url/);
  assert.match(capture, /value: callbackInput\.value/);
  assert.match(restore, /details\.open = renderState\.details\[key\]/);
  assert.match(restore, /refs\.composerInput\.value = composer\.draft/);
  assert.match(restore, /callbackInput\.value = renderState\.callback\.value/);
  assert.match(restore, /setSelectionRange/);
  assert.match(restore, /revision !== renderRevision/);
  assert.match(restore, /transcript\.scrollTop = renderState\.transcript\.scrollTop/);
  assert.match(functionSource("renderCompactAgents"), /renderStateKey = "agents"/);
  assert.match(functionSource("renderServerDetails"), /renderStateKey = "server"/);
  assert.match(functionSource("renderLogsDisclosure"), /renderStateKey = "logs"/);
});

test("the primary onboarding follows ChatGPT Work and keeps legacy setup secondary", () => {
  assert.doesNotMatch(
    script,
    /Apps\s*(?:→|->)\s*Create|Workspace settings|Enterprise\/Edu|Scan Tools|admin\/ca/i,
  );
  const guide = functionSource("renderChatGptConnectionGuide");
  assert.match(guide, /Connect ChatGPT Work to this workspace/);
  assert.match(guide, /Open ChatGPT Work/);
  assert.match(guide, /Install or connect the private PiLink plugin/);
  assert.match(guide, /personal or workspace plugin source/);
  assert.match(guide, /Searching for “mcp server” will show other vendors/);
  assert.match(guide, /Legacy Developer Mode compatibility/);
  assert.match(guide, /supported primary Work flow/);
  assert.match(guide, /destination: "work"/);
  assert.match(guide, /destination: "plugins"/);
  const oauth = functionSource("renderCallbackStep");
  assert.match(oauth, /Dynamic Client Registration \(DCR\)/);
  assert.match(oauth, /you do not need to find or copy it/);
  assert.match(oauth, /Only when DCR is unavailable: User-Defined setup/);
  assert.match(oauth, /Callback URL shown by ChatGPT/);
});

test("chat messages follow the narrow dashboard contract", () => {
  const normalizeState = functionSource("normalizeState");
  assert.match(normalizeState, /agentId: safeAgentId\(chat\.agentId\)/);
  assert.match(normalizeState, /status: cleanText\(chat\.status/);
  assert.match(normalizeState, /busy: chat\.busy === true/);
  assert.match(normalizeState, /messages: normalizeChatMessages\(chat\.messages\)/);
  assert.match(normalizeState, /error: cleanText\(chat\.error/);
  assert.match(normalizeState, /authReady: agentRuntime\.authReady === true/);

  const messages = functionSource("normalizeChatMessages");
  assert.match(messages, /source\.role !== "user"/);
  assert.match(messages, /source\.role !== "assistant"/);
  assert.match(messages, /source\.role !== "status"/);
  assert.match(messages, /cursor: nonNegativeInteger/);
  assert.match(messages, /createdAt: cleanText/);
});

test("the upstream public-agent chat and task board use bounded normalized data", () => {
  const state = functionSource("normalizeState");
  assert.match(state, /messages: normalizeCollaborationMessages\(collaboration\.messages\)/);
  assert.match(state, /tasks: normalizeCollaborationTasks\(collaboration\.tasks\)/);
  assert.match(state, /activity: normalizeToolActivity\(collaboration\.activity\)/);
  assert.match(state, /clients: normalizeCollaborationClients\(collaboration\.clients\)/);

  const messages = functionSource("normalizeCollaborationMessages");
  assert.match(messages, /slice\(-20\)/);
  assert.match(messages, /cleanText\(source\.message, 8192\)/);
  const tasks = functionSource("normalizeCollaborationTasks");
  assert.match(tasks, /slice\(0, 200\)/);
  assert.match(tasks, /cleanText\(source\.artifact, 16384\)/);
  assert.match(functionSource("renderCollaborationMessage"), /el\("div", "chat-message__body", message\.message\)/);
  assert.match(functionSource("renderTaskBoard"), /agent_task_\*/);
  const activity = functionSource("normalizeToolActivity");
  assert.match(activity, /slice\(-100\)/);
  assert.match(activity, /source\.outcome === "success"/);
  assert.doesNotMatch(activity, /args|prompt|path|result|output/);
  const activityView = functionSource("renderToolActivity");
  assert.match(activityView, /Recent MCP activity/);
  assert.match(activityView, /Prompts, paths, arguments, and results are not displayed/);
});

test("the remote monitor separates MCP connections from observed agent identities", () => {
  const status = functionSource("chatStatusModel");
  assert.match(status, /Active MCP connections:/);

  const workspace = functionSource("renderChatGptWorkspace");
  assert.match(workspace, /!currentState\.externalMcp\.configured/);
  assert.match(workspace, /the callback does not need to be entered again/);
  assert.match(workspace, /The OAuth client is already registered/);
  assert.match(workspace, /Write in the main ChatGPT tab/);
  assert.match(workspace, /No coordination activity yet/);
  assert.match(workspace, /MCP calls and messages published by agents will appear here automatically/);
  assert.doesNotMatch(workspace, /Waiting for the first agent message/);

  const agents = functionSource("renderRemoteAgents");
  assert.match(agents, /Observed agent identities/);
  assert.match(agents, /String\(identities\.size\)/);
  assert.doesNotMatch(agents, /Math\.max\(identities\.size,\s*currentState\.externalMcp\.activeSessions\)/);
  assert.match(agents, /This count measures MCP connections, not agents/);
  assert.match(agents, /Observed MCP clients/);
  assert.match(agents, /it is not a remote prompt box/);
});

test("the composer sends on Enter, preserves Shift+Enter and retains an unconfirmed draft", () => {
  const keys = functionSource("handleComposerKeydown");
  assert.match(keys, /event\.key === "Enter"/);
  assert.match(keys, /!event\.shiftKey/);
  assert.match(keys, /!event\.isComposing/);
  assert.match(keys, /event\.preventDefault\(\)/);
  assert.match(keys, /submitChat\(\)/);

  const submit = functionSource("submitChat");
  assert.match(submit, /postCommand\("sendChat", message\)/);
  assert.match(submit, /pendingChatSubmission = \{/);
  assert.doesNotMatch(submit, /refs\.composerInput\.value = ""/);

  const reconcile = functionSource("reconcilePendingChatSubmission");
  assert.match(reconcile, /entry\.role === "user"/);
  assert.match(reconcile, /entry\.cursor > pending\.baselineCursor/);
  assert.match(reconcile, /entry\.text\.trim\(\) === pending\.message/);
  assert.match(reconcile, /currentState\.chat\.error/);

  const settle = functionSource("settlePendingChatSubmission");
  assert.match(settle, /if \(accepted\)/);
  assert.match(settle, /refs\.composerInput\.value === pending\.draft/);
  assert.match(settle, /refs\.composerInput\.value = pending\.draft/);
  assert.match(settle, /Your text was preserved/);
});

test("composer availability and controls reflect a ready or busy chat", () => {
  const composer = functionSource("updateComposerState");
  assert.match(composer, /uiMode === "local" && isChatReady\(\)/);
  assert.match(composer, /classList\.toggle\("is-hidden", !ready\)/);
  assert.match(composer, /refs\.composerInput\.disabled = busy/);
  assert.match(composer, /refs\.cancelButton\.classList\.toggle\("is-hidden", !busy\)/);
  assert.match(composer, /refs\.sendButton\.classList\.toggle\("is-hidden", busy\)/);
  assert.match(composer, /Boolean\(pendingChatSubmission\)/);

  const readiness = functionSource("isChatReady");
  assert.match(readiness, /currentState\.trusted !== true/);
  assert.match(readiness, /currentState\.configured !== true/);
  assert.match(readiness, /!agentIsConfigured\(\)/);

  const agentConfiguration = functionSource("agentIsConfigured");
  assert.match(agentConfiguration, /currentState\.agentRuntime\.authReady/);
  assert.doesNotMatch(agentConfiguration, /configuredAuthType/);
});

test("ChatGPT is primary while local provider, new chat and stop remain available", () => {
  const initialize = functionSource("initialize");
  assert.match(initialize, /"ChatGPT MCP"/);
  assert.match(initialize, /"Pi Local"/);
  assert.match(initialize, /makeButton\("Open ChatGPT Work", "openChatGpt"/);

  const local = functionSource("renderLocalModeIntro");
  assert.match(local, /makeButton\("Provider and model", "configureAgents"/);
  assert.match(local, /makeButton\("New local chat", "newChat"/);

  const composer = functionSource("buildComposer");
  assert.match(composer, /dataset\.command = "cancelChat"/);
  assert.match(composer, /aria-label", "Stop the current turn"/);
});

test("agents are compact and expose spawn, inspect and stop commands", () => {
  const agents = functionSource("renderCompactAgents");
  assert.match(agents, /el\("details", "compact-agents"\)/);
  assert.match(agents, /makeButton\("New agent", "spawnAgent"/);
  assert.match(agents, /makeButton\("Sign out of provider", "logoutAgent"/);
  assert.match(agents, /"viewAgentOutput"/);
  assert.match(agents, /"stopAgent"/);
  assert.match(agents, /value: agent\.agentId/);
});

test("server, hosting and MCP controls stay inside advanced details", () => {
  const server = functionSource("renderServerDetails");
  assert.match(server, /el\("details", "server-details"\)/);
  assert.match(server, /MCP server and advanced settings/);
  assert.match(server, /"copyMcpUrl"/);
  assert.match(server, /"connectNativeMcp"/);
  assert.match(server, /"registerClient"/);
  assert.match(server, /"guidedSetup"/);
  assert.match(server, /"startUnsafe"/);
  assert.doesNotMatch(server, /hostingMode === "cloudflare-named"/);
  assert.match(server, /Manage full access/);
});

test("untrusted state uses the native workspace trust manager", () => {
  const empty = functionSource("emptyChatModel");
  assert.match(empty, /currentState\.trusted === false/);
  assert.match(empty, /command: "manageTrust"/);
});

test("a different configured workspace is blocked until the user confirms the open folder", () => {
  const empty = functionSource("emptyChatModel");
  assert.match(empty, /currentState\.chat\.status === "workspace-mismatch"/);
  assert.match(empty, /label: "Use this folder"/);
  assert.match(empty, /command: "setupChat"/);
});

test("an empty VS Code window explicitly asks for a workspace", () => {
  const empty = functionSource("emptyChatModel");
  assert.match(empty, /currentState\.chat\.status === "needs-workspace"/);
  assert.match(empty, /label: "Choose folder"/);
  assert.match(empty, /never chooses a folder implicitly/);
});

test("all remote text is rendered through safe DOM APIs", () => {
  assert.doesNotMatch(script, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write\s*\(/);
  assert.match(functionSource("el"), /element\.textContent = asText\(textValue\)/);
  assert.match(functionSource("renderChatMessage"), /el\("div", "chat-message__body", message\.text\)/);
});

test("styles keep the transcript primary and the composer pinned", () => {
  assert.match(styles, /\.conversation-shell\s*\{/);
  assert.match(styles, /\.transcript\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(styles, /\.composer-shell\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(styles, /\.server-details__body\s*\{/);
  assert.match(styles, /@media \(max-width:\s*720px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)/);
});
