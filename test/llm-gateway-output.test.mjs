import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const compactScript = String.raw`
  import { installGatewayCompactOutput, writeGatewayCompactBlock } from "./dist/llm-gateway-output.js";
  installGatewayCompactOutput();
  console.error("2026-09-07T10:38:08Z INF noisy cloudflared line");
  console.error("[HTTP] POST /sse → 401 (3ms)");
  console.error("[MCP] New Streamable HTTP session initializing...");
  console.error("[OAuth] Registration request received");
  console.error("[OAuth] Client registered: pi_deadbeef");
  console.error("[Gateway] API key: secret-noise");
  console.error("[MCP] Error handling Streamable HTTP request: useful");
  console.error("[OAuth] Rejected a second authorization request while another local approval was pending.");
  process.stderr.write("Approve this ChatGPT connection? [y/N]: ");
  writeGatewayCompactBlock([
    "PiLink Gateway",
    "  Status        ready",
    "",
    "Connection details",
    "  ChatGPT MCP   https://mcp.example.com/sse",
    "  Local API     http://127.0.0.1:3210/v1",
    "  OAuth setup   pilink gateway connect",
    "  Wake          @PiLink wake",
  ]);
`;

const verboseScript = String.raw`
  import { installGatewayCompactOutput, gatewayCompactOutputEnabled } from "./dist/llm-gateway-output.js";
  installGatewayCompactOutput();
  console.error("[HTTP] POST /sse → 401 (3ms)");
  console.error("[Gateway] API key: visible-in-verbose-test");
  console.error("compact=" + gatewayCompactOutputEnabled());
`;

test("gateway compact output suppresses routine noise and keeps actionable events ordered", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", compactScript], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /noisy cloudflared/u);
  assert.doesNotMatch(result.stderr, /\[HTTP\]/u);
  assert.doesNotMatch(result.stderr, /New Streamable HTTP session/u);
  assert.doesNotMatch(result.stderr, /Registration request received/u);
  assert.doesNotMatch(result.stderr, /Client registered/u);
  assert.doesNotMatch(result.stderr, /secret-noise/u);
  assert.match(result.stderr, /Error handling Streamable HTTP request: useful/u);
  assert.doesNotMatch(result.stderr, /\[MCP\]/u);
  assert.match(result.stderr, /Rejected a second authorization request/u);
  assert.doesNotMatch(result.stderr, /\[OAuth\]/u);
  assert.match(result.stderr, /Approve this ChatGPT connection\? \[y\/N\]:/u);
  assert.match(result.stderr, /PiLink Gateway/u);
  assert.match(result.stderr, /Connection details/u);
  assert.match(result.stderr, /ChatGPT MCP\s+https:\/\/mcp\.example\.com\/sse/u);
  assert.ok(result.stderr.indexOf("Connection details") < result.stderr.indexOf("ChatGPT MCP"));
  assert.ok(result.stderr.indexOf("ChatGPT MCP") < result.stderr.indexOf("Wake          @PiLink wake"));
});

test("PILINK_TERMINAL_LOGS=verbose restores raw gateway diagnostics", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", verboseScript], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PILINK_TERMINAL_LOGS: "verbose" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[HTTP\] POST \/sse/u);
  assert.match(result.stderr, /\[Gateway\] API key: visible-in-verbose-test/u);
  assert.match(result.stderr, /compact=false/u);
});

const hostingPromptsScript = String.raw`
  import { installGatewayCompactOutput } from "./dist/llm-gateway-output.js";
  installGatewayCompactOutput();
  process.stderr.write("Select hosting [1/2/3]: ");
  process.stderr.write("Fixed Cloudflare hostname (for example mcp.example.com): ");
  process.stderr.write("Cloudflare API token: ");
  process.stderr.write("Allow PiLink to request these temporary router mappings? [y/N]: ");
  process.stderr.write("Type DIRECT after completing the router configuration: ");
  process.stderr.write("routine unprompted buffer without newline");
`;

test("gateway compact output preserves interactive hosting and network setup prompts without trailing newlines", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", hostingPromptsScript], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Select hosting \[1\/2\/3\]: /u);
  assert.match(result.stderr, /Fixed Cloudflare hostname \(for example mcp\.example\.com\): /u);
  assert.match(result.stderr, /Cloudflare API token: /u);
  assert.match(result.stderr, /Allow PiLink to request these temporary router mappings\? \[y\/N\]: /u);
  assert.match(result.stderr, /Type DIRECT after completing the router configuration: /u);
  assert.doesNotMatch(result.stderr, /routine unprompted buffer without newline/u);
});

test("filterGatewayTerminalLine preserves hosting prompts and filters noise", async () => {
  const { filterGatewayTerminalLine } = await import("../dist/llm-gateway-output.js");
  assert.equal(filterGatewayTerminalLine("Select hosting [1/2/3]: "), "Select hosting [1/2/3]: ");
  assert.equal(filterGatewayTerminalLine("Fixed Cloudflare hostname (for example mcp.example.com): "), "Fixed Cloudflare hostname (for example mcp.example.com): ");
  assert.equal(filterGatewayTerminalLine("Cloudflare API token: "), "Cloudflare API token: ");
  assert.equal(filterGatewayTerminalLine("Allow PiLink to request these temporary router mappings? [y/N]: "), "Allow PiLink to request these temporary router mappings? [y/N]: ");
  assert.equal(filterGatewayTerminalLine("Type DIRECT after completing the router configuration: "), "Type DIRECT after completing the router configuration: ");
  assert.equal(filterGatewayTerminalLine("[OAuth] Registration request received"), undefined);
  assert.equal(filterGatewayTerminalLine("[HTTP] GET /health"), undefined);
});
