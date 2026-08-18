import assert from "node:assert/strict";
import test from "node:test";

import {
  InteractiveTerminalOutputFilter,
  filterInteractiveTerminalLine,
  shouldQuietInteractiveStart,
  terminalLogsAreVerbose,
} from "../dist/terminal-launcher.js";

test("interactive pilink start is quiet by default only in a TTY", () => {
  assert.equal(shouldQuietInteractiveStart(["start"], true, {}), true);
  assert.equal(shouldQuietInteractiveStart([], true, {}), true);
  assert.equal(shouldQuietInteractiveStart(["serve"], true, {}), false);
  assert.equal(shouldQuietInteractiveStart(["start"], false, {}), false);
  assert.equal(shouldQuietInteractiveStart(["start"], true, { PILINK_TERMINAL_LOGS: "verbose" }), false);
  assert.equal(terminalLogsAreVerbose("debug"), true);
  assert.equal(terminalLogsAreVerbose("quiet"), false);
});

test("quiet terminal output removes routine runtime chatter", () => {
  assert.equal(filterInteractiveTerminalLine("[HTTP] POST /admin/oauth/pairing → 200 (8ms)"), undefined);
  assert.equal(filterInteractiveTerminalLine("[MCP] Streamable HTTP session created."), undefined);
  assert.equal(filterInteractiveTerminalLine("2026-08-18T08:35:01Z INF Registered tunnel connection"), undefined);
  assert.equal(filterInteractiveTerminalLine("2026/08/18 08:35:01 failed to sufficiently increase receive buffer size"), undefined);
  assert.equal(filterInteractiveTerminalLine("╔══════════════════════════════════════════════════╗"), undefined);
  assert.equal(filterInteractiveTerminalLine("║  Server URL: https://mcp.example.com             ║"), undefined);
});

test("quiet terminal output preserves actionable setup and errors", () => {
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
