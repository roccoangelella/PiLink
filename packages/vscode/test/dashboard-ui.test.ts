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

test("the dashboard is a PiLink control surface rather than a second chat product", () => {
  assert.match(script, /brand__title", "PiLink"/);
  assert.match(functionSource("primaryModel"), /Start PiLink/);
  assert.match(functionSource("primaryModel"), /Connect ChatGPT/);
  assert.match(functionSource("primaryModel"), /Open ChatGPT Work/);
  assert.doesNotMatch(script, /mode-switch/);
  assert.doesNotMatch(script, /buildComposer|composerInput|renderConversation|renderTaskBoard/);
  assert.doesNotMatch(script, /Waiting for the first agent message/);
});

test("first run defaults to the safe single-agent path", () => {
  const primary = functionSource("primaryModel");
  assert.match(primary, /single-agent workflow, project-folder access, no unrestricted shell/);
  assert.match(primary, /Quick start for ChatGPT/);
  assert.match(primary, /hosting: \{ kind: "quick-tunnel" \}/);
  assert.match(primary, /accessMode: "workspace"/);
  assert.match(primary, /Local only/);
  assert.match(primary, /Stable endpoint…/);
  assert.match(primary, /temporary HTTPS address/);
  assert.doesNotMatch(primary, /Full access.*variant: "primary"/s);
});

test("normal lifecycle exposes one obvious action for each state", () => {
  const primary = functionSource("primaryModel");
  assert.match(primary, /PiLink is stopped/);
  assert.match(primary, /Start PiLink", command: "start", variant: "primary"/);
  assert.match(primary, /PiLink is online/);
  assert.match(primary, /Connect ChatGPT", command: "connectChatGpt", variant: "primary"/);
  assert.match(primary, /Finish the ChatGPT connection/);
  assert.match(primary, /Continue connection", command: "connectChatGpt", variant: "primary"/);
  assert.match(primary, /ChatGPT is using PiLink/);
  assert.match(primary, /PiLink is ready/);
  assert.match(primary, /Open ChatGPT Work", command: "openChatGpt", variant: "primary"/);
  assert.match(primary, /this panel only manages the bridge/);
});

test("Full access can never look like an ordinary safe restart", () => {
  const primary = functionSource("primaryModel");
  assert.match(primary, /!online && currentState\.unsafeFullAccess/);
  assert.match(primary, /Full machine access is configured/);
  assert.match(primary, /Return to Project-folder access/);
  assert.match(primary, /Start configured Full access/);
  assert.match(primary, /variant: "danger"/);
  assert.match(functionSource("renderFullAccessNotice"), /Full machine access is active/);
  assert.match(functionSource("topStatus"), /Full access/);
  assert.match(functionSource("advancedServerSection"), /!isOnline\(\) && !currentState\.unsafeFullAccess/);
});

test("advanced capabilities are progressively disclosed", () => {
  const advanced = functionSource("renderAdvanced");
  assert.match(advanced, /el\("details", "advanced"\)/);
  assert.match(advanced, /Hosting, workflow, access, integrations/);
  assert.match(advanced, /advancedServerSection\(\)/);
  assert.match(advanced, /advancedWorkflowSection\(\)/);
  assert.match(advanced, /advancedAccessSection\(\)/);
  assert.match(advanced, /advancedIntegrationSection\(\)/);
  assert.match(advanced, /advancedLocalAgentSection\(\)/);

  const workflow = functionSource("advancedWorkflowSection");
  assert.match(workflow, /Single-agent is the default/);
  assert.match(workflow, /Enable collaboration…/);
  assert.match(workflow, /Switch back to single-agent/);
  assert.match(workflow, /selectRuntimeMode/);

  const access = functionSource("advancedAccessSection");
  assert.match(access, /Start with Full access…/);
  assert.match(access, /client\.grantTypes\.includes\("authorization_code"\)/);
  assert.match(access, /mcp:tools/);
  assert.match(access, /!eligible/);
  assert.match(access, /Return to Project-folder access/);
});

test("optional local agents remain available without becoming the main UI", () => {
  const local = functionSource("advancedLocalAgentSection");
  assert.match(local, /Optional local Pi agent/);
  assert.match(local, /separate from ChatGPT MCP/);
  assert.match(local, /Provider & model…/);
  assert.match(local, /Create local agent…/);
  assert.match(local, /viewAgentOutput/);
  assert.match(local, /stopAgent/);
});

test("status distinguishes service, OAuth readiness and active MCP sessions", () => {
  const remote = functionSource("remoteStatus");
  assert.match(remote, /Local only/);
  assert.match(remote, /OAuth ready/);
  assert.match(remote, /Authorize/);
  assert.match(remote, /Not connected/);
  assert.match(remote, /activeSessions/);

  const top = functionSource("topStatus");
  assert.match(top, /Restricted/);
  assert.match(top, /Stopped/);
  assert.match(top, /Connected/);
  assert.match(top, /Ready/);
  assert.match(top, /Online/);
});

test("recent activity stays metadata-only and bounded", () => {
  const normalize = functionSource("normalizeActivity");
  assert.match(normalize, /slice\(-8\)/);
  assert.match(normalize, /tool:/);
  assert.match(normalize, /outcome:/);
  assert.match(normalize, /durationMs:/);
  assert.match(normalize, /accessMode:/);
  assert.doesNotMatch(normalize, /prompt|args|arguments|result|output|path/);

  const render = functionSource("renderActivity");
  assert.match(render, /slice\(-5\)\.reverse\(\)/);
  assert.match(render, /Metadata only/);
  assert.match(render, /Arguments, file paths, prompts, and results are intentionally not shown here/);
});

test("polling does not constantly rebuild the dashboard or collapse disclosures", () => {
  assert.match(script, /if \(signature === lastSignature\) return/);
  const signature = functionSource("visibleSignature");
  assert.doesNotMatch(signature, /health/);
  assert.match(script, /vscode\.getState/);
  assert.match(script, /vscode\.setState\(uiState\)/);
  assert.match(script, /advancedOpen/);
  assert.match(script, /localAgentOpen/);
});

test("webview content is built with textContent rather than HTML interpolation", () => {
  const element = functionSource("el");
  assert.match(element, /node\.textContent = String\(content\)/);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(script, /replace\(\/\\0\/g, ""\)/);
});

test("the new assets are the only dashboard entry point", () => {
  assert.match(dashboard, /media", "app\.css"/);
  assert.match(dashboard, /media", "app\.js"/);
  assert.doesNotMatch(dashboard, /styles\.css|main\.js/);
  assert.match(dashboard, /Content-Security-Policy/);
  assert.match(dashboard, /script-src 'nonce-\$\{nonce\}'/);
});

test("the layout uses VS Code theme tokens and adapts to a narrow sidebar", () => {
  assert.match(styles, /--vscode-foreground/);
  assert.match(styles, /--vscode-button-background/);
  assert.match(styles, /--vscode-focusBorder/);
  assert.match(styles, /@media \(max-width: 420px\)/);
  assert.match(styles, /grid-template-columns: 1fr/);
  assert.doesNotMatch(styles, /font-family:\s*(?:Arial|Helvetica|Roboto)/i);
});
