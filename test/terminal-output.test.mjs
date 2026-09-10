import assert from "node:assert/strict";
import test from "node:test";

import {
  InteractiveTerminalOutputFilter,
  PinnedTerminalStatus,
  chatMonitorAutoLaunchRequested,
  filterInteractiveTerminalLine,
  launchUsesGateway,
  parseTerminalStatusSnapshot,
  renderTerminalStatusLines,
  resolveNodeExecutable,
  shouldQuietInteractiveStart,
  shouldUseCompactTerminalOutput,
  terminalLogsAreVerbose,
  terminalProxyEnvironment,
} from "../dist/terminal-launcher.js";
import {
  PROXY_STDERR_TTY,
  PROXY_STDOUT_TTY,
  restoreProxiedTtyFlag,
} from "../dist/terminal-child.js";

test("interactive start and serve use compact output by default in a TTY", () => {
  assert.equal(shouldUseCompactTerminalOutput(["start"], true, {}), true);
  assert.equal(shouldUseCompactTerminalOutput([], true, {}), true);
  assert.equal(shouldUseCompactTerminalOutput(["serve"], true, {}), true);
  assert.equal(shouldQuietInteractiveStart(["serve"], true, {}), true, "compatibility alias follows shared compact policy");
  assert.equal(shouldUseCompactTerminalOutput(["start"], false, {}), false);
  assert.equal(shouldUseCompactTerminalOutput(["start"], true, { PILINK_TERMINAL_LOGS: "verbose" }), false);
  assert.equal(shouldUseCompactTerminalOutput(["start", "--mode", "cli"], true, {}), false);
  assert.equal(shouldUseCompactTerminalOutput(["serve", "--mode", "3"], true, {}), false);
  assert.equal(shouldUseCompactTerminalOutput(["gateway", "start"], true, {}), false);
  assert.equal(shouldUseCompactTerminalOutput(["start"], true, { PI_CHAT_CLI: "auto" }), false);
  assert.equal(terminalLogsAreVerbose("debug"), true);
  assert.equal(terminalLogsAreVerbose("quiet"), false);
});

test("gateway detection and chat monitor takeover recognize supported aliases", () => {
  assert.equal(launchUsesGateway(["start", "--mode=gateway"]), true);
  assert.equal(launchUsesGateway(["serve", "--mode", "endpoint"]), true);
  assert.equal(launchUsesGateway(["start", "--mode", "single"]), false);
  assert.equal(chatMonitorAutoLaunchRequested({}), false);
  assert.equal(chatMonitorAutoLaunchRequested({ PI_CHAT_CLI: "auto" }), true);
  assert.equal(chatMonitorAutoLaunchRequested({ PI_CHAT_CLI: "yes" }), true);
  assert.equal(chatMonitorAutoLaunchRequested({ PI_CHAT_CLI: "off" }), false);
});

test("compact launcher preserves effective terminal state and clears internal status descriptors", () => {
  const env = terminalProxyEnvironment({
    EXISTING: "yes",
    [PROXY_STDOUT_TTY]: "spoofed",
    [PROXY_STDERR_TTY]: "spoofed",
    PILINK_INTERNAL_TERMINAL_STATUS_FD: "99",
  }, false, true);
  assert.equal(env.EXISTING, "yes");
  assert.equal(env[PROXY_STDOUT_TTY], undefined);
  assert.equal(env[PROXY_STDERR_TTY], "1");
  assert.equal(env.PILINK_INTERNAL_TERMINAL_STATUS_FD, undefined);

  const proxied = {};
  restoreProxiedTtyFlag(proxied, env[PROXY_STDERR_TTY]);
  assert.equal(proxied.isTTY, true);

  const nonInteractive = {};
  restoreProxiedTtyFlag(nonInteractive, undefined);
  assert.equal(nonInteractive.isTTY, undefined);
});

test("compact terminal output removes routine runtime chatter but keeps actionable diagnostics", () => {
  assert.equal(filterInteractiveTerminalLine("[HTTP] POST /admin/oauth/pairing → 200 (8ms)"), undefined);
  assert.equal(filterInteractiveTerminalLine("[MCP] Streamable HTTP session created."), undefined);
  assert.equal(filterInteractiveTerminalLine("[OAuth] Registration request received"), undefined);
  assert.equal(filterInteractiveTerminalLine("[Agents] Child runtime initialized"), undefined);
  assert.equal(filterInteractiveTerminalLine("2026-08-18T08:35:01Z INF Registered tunnel connection"), undefined);
  assert.equal(filterInteractiveTerminalLine("2026/08/18 08:35:01 failed to sufficiently increase receive buffer size"), undefined);
  assert.equal(filterInteractiveTerminalLine("╔══════════════════════════════════════════════════╗"), undefined);
  assert.equal(filterInteractiveTerminalLine("║  Server URL: https://mcp.example.com             ║"), undefined);
  assert.equal(
    filterInteractiveTerminalLine("[MCP] Error handling Streamable HTTP request: useful"),
    "[MCP] Error handling Streamable HTTP request: useful",
  );
  assert.equal(
    filterInteractiveTerminalLine("[OAuth] Rejected a second authorization request while another local approval was pending."),
    "[OAuth] Rejected a second authorization request while another local approval was pending.",
  );
});

test("compact terminal output preserves actionable setup text and ordinary errors", () => {
  assert.equal(
    filterInteractiveTerminalLine("=== First-time ChatGPT setup (safe DCR) ==="),
    "=== First-time ChatGPT setup (safe DCR) ===",
  );
  assert.equal(
    filterInteractiveTerminalLine("Open this one-use owner pairing URL in the same browser where you use ChatGPT:"),
    "Open this one-use owner pairing URL in the same browser where you use ChatGPT:",
  );
  assert.equal(
    filterInteractiveTerminalLine("PiLink could not listen on 127.0.0.1:3200: the address is already in use."),
    "PiLink could not listen on 127.0.0.1:3200: the address is already in use.",
  );
});

test("chunked runtime logs stay hidden while newline-free prompts remain visible", () => {
  const filter = new InteractiveTerminalOutputFilter();
  let output = "";
  output += filter.push("2026-08-18T08:35");
  output += filter.push(":01Z INF tunnel chatter\n=== First-time ChatGPT setup");
  output += filter.push(" (safe DCR) ===\n");
  output += filter.flush();
  assert.equal(output, "=== First-time ChatGPT setup (safe DCR) ===\n");

  const promptFilter = new InteractiveTerminalOutputFilter();
  assert.equal(promptFilter.push("> "), "> ");
  assert.equal(promptFilter.flush(), "");
});

test("terminal status snapshots are bounded, sanitized, and rendered to terminal width", () => {
  const snapshot = parseTerminalStatusSnapshot(JSON.stringify({
    title: "Ready\u0007",
    fields: [
      { label: "Mode", value: "Single agent" },
      { label: "Next", value: "Connect ChatGPT" },
    ],
  }));
  assert.deepEqual(snapshot, {
    title: "Ready",
    fields: [
      { label: "Mode", value: "Single agent" },
      { label: "Next", value: "Connect ChatGPT" },
    ],
  });
  assert.equal(parseTerminalStatusSnapshot("not-json"), undefined);
  assert.equal(parseTerminalStatusSnapshot(JSON.stringify({ title: "Ready", fields: new Array(13).fill({ label: "x", value: "y" }) })), undefined);
  assert.deepEqual(renderTerminalStatusLines(snapshot, 28), [
    "PiLink · Ready",
    "Mode: Single agent",
    "Next: Connect ChatGPT",
  ]);
  const narrow = renderTerminalStatusLines({ title: "Ready", fields: [{ label: "Next", value: "A very long next action" }] }, 21);
  assert.equal(narrow[1].length, 21);
  assert.ok(narrow[1].endsWith("…"));
});

test("pinned status clears before output and redraws after complete lines", () => {
  let written = "";
  const status = new PinnedTerminalStatus((value) => { written += value; }, () => 80);
  status.set({ title: "Ready", fields: [{ label: "Mode", value: "Single agent" }] });
  assert.match(written, /PiLink · Ready\nMode: Single agent/);
  const afterSet = written.length;

  status.beforeOutput();
  const cleared = written.slice(afterSet);
  assert.match(cleared, /\x1b\[1A\r\x1b\[2K/);
  const afterClear = written.length;
  status.afterOutput("warning\n");
  assert.match(written.slice(afterClear), /PiLink · Ready/);

  status.beforeOutput();
  const afterPromptClear = written.length;
  status.afterOutput("> ");
  assert.equal(written.length, afterPromptClear, "newline-free prompt leaves the footer hidden");
  status.dispose();
});

test("resolveNodeExecutable finds matching node version or fallback path", () => {
  const currentExec = process.execPath;
  assert.equal(resolveNodeExecutable("24.18.0", currentExec), currentExec);
  assert.equal(resolveNodeExecutable("v24.18.0", currentExec), currentExec);
});
