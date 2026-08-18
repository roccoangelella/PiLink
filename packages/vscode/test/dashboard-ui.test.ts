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

test("first run keeps advanced choices out of the safe single-agent path", () => {
  const primary = functionSource("primaryModel");
  assert.match(primary, /single-agent MCP toolset are the normal graphical defaults/);
  assert.match(primary, /Quick start for ChatGPT/);
  assert.match(primary, /hosting: \{ kind: "quick-tunnel" \}/);
  assert.match(primary, /accessMode: "workspace"/);
  assert.match(primary, /Local only/);
  assert.match(primary, /Advanced setup…/);
  assert.match(primary, /Quick start uses a temporary HTTPS address/);
  assert.doesNotMatch(primary, /accessMode: "full"/);
  assert.match(primary, /Quick start for ChatGPT"[\s\S]{0,220}variant: "primary"/);
  assert.doesNotMatch(primary, /Advanced setup…"[\s\S]{0,120}variant: "primary"/);
});

test("normal lifecycle has one dominant action per bridge state", () => {
  const primary = functionSource("primaryModel");
  assert.match(primary, /PiLink is stopped/);
  assert.match(primary, /Start PiLink", command: "start", variant: "primary"/);
  assert.match(primary, /PiLink is running locally/);
  assert.match(primary, /Advanced remote setup…", command: "guidedSetup", variant: "primary"/);
  assert.match(primary, /PiLink is online/);
  assert.match(primary, /Connect ChatGPT", command: "connectChatGpt", variant: "primary"/);
  assert.match(primary, /Finish connecting ChatGPT/);
  assert.match(primary, /Continue connection", command: "connectChatGpt", variant: "primary"/);
  assert.match(primary, /ChatGPT is connected/);
  assert.match(primary, /PiLink is ready/);
  assert.match(primary, /Open ChatGPT Work", command: "openChatGpt", variant: "primary"/);
});

test("Full access is detected but never offered as a normal graphical start", () => {
  const primary = functionSource("primaryModel");
  assert.match(primary, /if \(currentState\.unsafeFullAccess\)/);
  assert.match(primary, /Full machine access is running/);
  assert.match(primary, /Full machine access is saved/);
  assert.match(primary, /Reconfigure safely/);
  assert.match(primary, /PiLink CLI/);
  assert.doesNotMatch(script, /Start with Full access|Start configured Full access|startUnsafe/);
  assert.match(functionSource("renderFullAccessNotice"), /outside the normal graphical workflow/);
  assert.match(functionSource("topStatus"), /Full access/);
});

test("collaboration is migration state, not a promoted main-screen workflow", () => {
  assert.doesNotMatch(script, /Enable collaboration/);
  const notice = functionSource("renderCollaborationNotice");
  assert.match(notice, /Advanced collaboration configuration detected/);
  assert.match(notice, /Switch to single-agent/);
  assert.match(notice, /selectRuntimeMode/);
  assert.match(notice, /"single"/);
});

test("details and recovery contain bridge operations rather than specialist products", () => {
  const advanced = functionSource("renderAdvanced");
  assert.match(advanced, /Details & recovery/);
  assert.match(advanced, /Endpoint, config, terminal/);
  assert.match(advanced, /Advanced setup/);
  assert.match(advanced, /Copy MCP URL/);
  assert.match(advanced, /Open config/);
  assert.match(advanced, /Show terminal/);
  assert.match(advanced, /Open guide/);
  assert.match(advanced, /Advanced setup can expose legacy hosting, workflow, and access choices/);
  assert.match(advanced, /Local model-provider chat, native VS Code MCP, and manual OAuth registration/);
  assert.doesNotMatch(script, /advancedLocalAgentSection|advancedIntegrationSection|advancedAccessSection/);
  assert.doesNotMatch(script, /registerClient|connectNativeMcp|configureAgents|spawnAgent|logoutAgent/);
});

test("status separates server, endpoint and ChatGPT readiness", () => {
  const grid = functionSource("renderStatusGrid");
  assert.match(grid, /Server/);
  assert.match(grid, /Endpoint/);
  assert.match(grid, /ChatGPT/);

  const endpoint = functionSource("endpointStatus");
  assert.match(endpoint, /Public HTTPS/);
  assert.match(endpoint, /Local only/);

  const chatgpt = functionSource("chatGptStatus");
  assert.match(chatgpt, /OAuth ready/);
  assert.match(chatgpt, /Authorize/);
  assert.match(chatgpt, /Not connected/);
  assert.match(chatgpt, /activeSessions/);
});

test("recent activity stays metadata-only and bounded", () => {
  const normalize = functionSource("normalizeActivity");
  assert.match(normalize, /slice\(-8\)/);
  assert.match(normalize, /tool:/);
  assert.match(normalize, /outcome:/);
  assert.match(normalize, /durationMs:/);
  assert.doesNotMatch(normalize, /prompt|args|arguments|result|output|path/);

  const render = functionSource("renderActivity");
  assert.match(render, /slice\(-5\)\.reverse\(\)/);
  assert.match(render, /Metadata only/);
  assert.match(render, /Arguments, file paths, prompts, and results are intentionally not shown here/);
});

test("polling preserves the only disclosure state", () => {
  assert.match(script, /if \(signature === lastSignature\) return/);
  assert.match(script, /vscode\.getState/);
  assert.match(script, /vscode\.setState\(uiState\)/);
  assert.match(script, /advancedOpen/);
  assert.doesNotMatch(script, /localAgentOpen/);
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
  assert.match(styles, /@media \(max-width: 420px\)/);
  assert.match(styles, /grid-template-columns: 1fr/);
  assert.doesNotMatch(styles, /font-family:\s*(?:Arial|Helvetica|Roboto)/i);
  assert.doesNotMatch(styles, /agent-row|nested-details/);
});
