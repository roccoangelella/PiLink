import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const script = fs.readFileSync(new URL("../media/app.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../media/app.css", import.meta.url), "utf8");
const dashboard = fs.readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");

function functionSource(name: string): string {
  const start = script.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const next = script.indexOf("\n  function ", start + 12);
  return script.slice(start, next === -1 ? script.length : next);
}

test("the dashboard is a launcher and bridge monitor, not a second agent product", () => {
  assert.match(script, /brand__title", "PiLink"/);
  const primary = functionSource("primaryModel");
  assert.match(primary, /Start PiLink/);
  assert.match(primary, /Connect ChatGPT/);
  assert.match(primary, /Open ChatGPT Work/);
  assert.match(primary, /this panel only manages and monitors the bridge/);
  assert.doesNotMatch(script, /mode-switch|buildComposer|composerInput|renderConversation|renderTaskBoard/);
  assert.doesNotMatch(script, /Provider & model|Create local agent|Connect VS Code agents/);
});

test("first run recommends stable hosting and fixes the safety policy", () => {
  const primary = functionSource("primaryModel");
  assert.match(primary, /single-agent toolset/);
  assert.match(primary, /Set up stable endpoint", command: "setupStable", variant: "primary"/);
  assert.match(primary, /Temporary quick start", command: "setupQuick", variant: "secondary"/);
  assert.match(primary, /Local only", command: "setupLocal", variant: "ghost"/);
  assert.match(primary, /Stable hosting is recommended for ChatGPT/);
  assert.doesNotMatch(primary, /accessMode|Start with Full access|startUnsafe/);
});

test("the webview sends only the focused command protocol with bounded task identity when needed", () => {
  assert.match(script, /const message = \{ type: "command", command: command \}/);
  assert.match(script, /message\.taskId = taskId/);
  assert.match(script, /message\.revision = revision/);
  assert.match(script, /vscode\.postMessage\(message\)/);
  assert.doesNotMatch(script, /type: "wizard"|postWizard|wizardButton|configureAndStart/);
});

test("state-changing operations become an explicit single busy state", () => {
  assert.match(functionSource("normalizeState"), /operation: text\(source\.operation/);
  const primary = functionSource("primaryModel");
  assert.match(primary, /if \(currentState\.operation\)/);
  assert.match(primary, /PiLink disables other state-changing actions/);
  assert.match(functionSource("commandButton"), /if \(currentState\.operation\) button\.disabled = true/);
  assert.match(functionSource("taskCommandButton"), /collaboration\.status !== "ready"/);
  assert.match(script, /currentState\.operation\) return/);
});

 test("dashboard renders loading, empty, stale, and error states explicitly", () => {
  assert.match(functionSource("renderLoading"), /Checking PiLink/);
  assert.match(functionSource("renderKanbanColumn"), /No tasks/);
  const board = functionSource("renderCollaborationBoard");
  assert.match(board, /Showing the last good task snapshot/);
  assert.match(board, /Task board data is unavailable/);
  assert.match(board, /role", board\.status === "error" \? "alert" : "status"/);
});

test("normal lifecycle has one dominant action per bridge state", () => {
  const primary = functionSource("primaryModel");
  assert.match(primary, /PiLink is stopped/);
  assert.match(primary, /Start PiLink", command: "start", variant: "primary"/);
  assert.match(primary, /PiLink is running locally/);
  assert.match(primary, /Configure remote endpoint", command: "setupStable", variant: "primary"/);
  assert.match(primary, /PiLink is online/);
  assert.match(primary, /Connect ChatGPT", command: "connectChatGpt", variant: "primary"/);
  assert.match(primary, /Finish connecting ChatGPT/);
  assert.match(primary, /Continue connection", command: "connectChatGpt", variant: "primary"/);
  assert.match(primary, /ChatGPT is connected/);
  assert.match(primary, /PiLink is ready/);
  assert.match(primary, /Open ChatGPT Work", command: "openChatGpt", variant: "primary"/);
});

test("Full access is detected but never offered as a graphical launch", () => {
  const primary = functionSource("primaryModel");
  assert.match(primary, /if \(currentState\.unsafeFullAccess\)/);
  assert.match(primary, /Full machine access is running/);
  assert.match(primary, /Full machine access is saved/);
  assert.match(primary, /Reconfigure safely/);
  assert.match(primary, /PiLink CLI\/operator workflow/);
  assert.doesNotMatch(script, /Start with Full access|startUnsafe/);
  assert.match(functionSource("renderFullAccessNotice"), /not part of the normal VS Code workflow/);
});

test("collaboration mode exposes the authoritative durable Kanban without changing single-agent setup", () => {
  assert.doesNotMatch(script, /Enable collaboration/);
  const notice = functionSource("renderCollaborationNotice");
  assert.match(notice, /Collaboration mode is active/);
  assert.match(notice, /Task ownership and scheduling decisions remain server-authoritative/);
  assert.match(notice, /Switch to single-agent/);
  const board = functionSource("renderCollaborationBoard");
  assert.match(board, /MULTI-AGENT CONTROL ROOM/);
  assert.match(board, /Open \/ Ready/);
  assert.match(board, /Working/);
  assert.match(board, /Needs input \/ Blocked/);
  assert.match(board, /Done \/ Failed/);
  assert.match(board, /authoritative durable collaboration tasks/);
  assert.match(board, /Local supervised-agent operations are a separate runtime surface/);
  assert.match(board, /Worker release is a separate manager-authorized lifecycle action/);
  const roster = functionSource("renderParticipantRoster");
  assert.match(roster, /Waiting for task/);
  assert.match(roster, /Working/);
  assert.match(roster, /Released/);
  assert.match(roster, /Offline/);
  assert.match(roster, /collaborationSessionId/);
});

test("process ownership is visible and external services are never given stop/restart controls", () => {
  const external = functionSource("isExternalRuntime");
  assert.match(external, /detected service/);
  const notice = functionSource("renderExternalRuntimeNotice");
  assert.match(notice, /started outside VS Code/);
  assert.match(notice, /will not stop, restart, or reconfigure/);
  const advanced = functionSource("renderAdvanced");
  assert.match(advanced, /isOnline\(\) && !isExternalRuntime\(\)/);
  assert.match(advanced, /if \(!isExternalRuntime\(\)\) actions\.appendChild\(commandButton\("Reconfigure endpoint/);
  assert.match(functionSource("serverStatus"), /Running · external/);
});

test("details and recovery contain bridge operations only", () => {
  const advanced = functionSource("renderAdvanced");
  assert.match(advanced, /Details & recovery/);
  assert.match(advanced, /Endpoint, config, terminal/);
  assert.match(advanced, /Reconfigure endpoint/);
  assert.match(advanced, /Copy MCP URL/);
  assert.match(advanced, /Open config/);
  assert.match(advanced, /Show terminal/);
  assert.match(advanced, /Open guide/);
  assert.match(advanced, /intentionally not part of the ordinary graphical workflow/);
  assert.doesNotMatch(script, /registerClient|connectNativeMcp|configureAgents|spawnAgent|logoutAgent/);
});

test("status separates server, endpoint and ChatGPT readiness", () => {
  const grid = functionSource("renderStatusGrid");
  assert.match(grid, /Server/);
  assert.match(grid, /Endpoint/);
  assert.match(grid, /ChatGPT/);
  assert.match(functionSource("endpointStatus"), /Public HTTPS/);
  assert.match(functionSource("endpointStatus"), /Local only/);
  const chatgpt = functionSource("chatGptStatus");
  assert.match(chatgpt, /OAuth ready/);
  assert.match(chatgpt, /Authorize/);
  assert.match(chatgpt, /Not connected/);
  assert.match(chatgpt, /activeSessions/);
});

test("collaboration UI shows task metadata without ingesting chat transcripts or tool audit content", () => {
  assert.doesNotMatch(script, /normalizeActivity|renderActivity|Recent MCP activity|Metadata only/);
  assert.doesNotMatch(script, /collaboration\.activity|agent_chat_/);
  const task = functionSource("renderTaskCard");
  assert.match(task, /Task ID/);
  assert.match(task, /Owner/);
  assert.match(task, /Session/);
  assert.match(task, /Role/);
  assert.match(task, /Priority \/ risk/);
  assert.match(task, /Dependencies/);
  assert.match(task, /Lease/);
  assert.match(task, /Updated/);
  assert.match(task, /Artifact/);
  assert.match(task, /Provide input/);
  assert.match(task, /Cancel task/);
});

test("polling preserves disclosure state, selected task, focus, and Kanban scroll", () => {
  assert.match(script, /if \(signature === lastSignature\) return/);
  assert.match(script, /vscode\.getState/);
  assert.match(script, /vscode\.setState\(uiState\)/);
  assert.match(script, /advancedOpen/);
  assert.match(script, /selectedTaskId/);
  assert.match(script, /boardScrollLeft/);
  assert.match(script, /focusedTaskId/);
  assert.match(script, /preventScroll: true/);
});

test("webview content is built with textContent rather than HTML interpolation", () => {
  const element = functionSource("el");
  assert.match(element, /node\.textContent = String\(content\)/);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(script, /replace\(\/\\0\/g, ""\)/);
});

test("the focused assets remain the only dashboard implementation", () => {
  assert.match(dashboard, /media", "app\.css"/);
  assert.match(dashboard, /media", "app\.js"/);
  assert.doesNotMatch(dashboard, /styles\.css|main\.js/);
  assert.equal(fs.existsSync(new URL("../media/main.js", import.meta.url)), false);
  assert.equal(fs.existsSync(new URL("../media/styles.css", import.meta.url)), false);
  assert.match(dashboard, /Content-Security-Policy/);
  assert.match(dashboard, /script-src 'nonce-\$\{nonce\}'/);
});

test("the layout uses VS Code tokens and stays usable in a narrow sidebar", () => {
  assert.match(styles, /--vscode-foreground/);
  assert.match(styles, /--vscode-button-background/);
  assert.match(styles, /--vscode-focusBorder/);
  assert.match(styles, /detail-grid/);
  assert.match(styles, /\.kanban/);
  assert.match(styles, /overflow-x: auto/);
  assert.match(styles, /task-card__summary:focus-visible/);
  assert.match(styles, /@media \(max-width: 420px\)/);
  assert.match(styles, /grid-template-columns: 1fr/);
  assert.doesNotMatch(styles, /font-family:\s*(?:Arial|Helvetica|Roboto)/i);
});
