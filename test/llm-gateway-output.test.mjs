import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = String.raw`
  import { installGatewayCompactOutput, writeGatewayCompactBlock } from "./dist/llm-gateway-output.js";
  installGatewayCompactOutput();
  console.error("2026-09-07T10:38:08Z INF noisy cloudflared line");
  console.error("[HTTP] POST /sse → 401 (3ms)");
  console.error("[MCP] New Streamable HTTP session initializing...");
  console.error("[OAuth] Registration request received");
  console.error("[Gateway] API key: secret-noise");
  console.error("[MCP] Error handling Streamable HTTP request: useful");
  process.stderr.write("Allow this ChatGPT connection? [y/N]: ");
  writeGatewayCompactBlock(["PiLink Gateway ready", "ChatGPT MCP: https://mcp.example.com/sse"]);
`;

test("gateway compact output suppresses routine noise but preserves errors, prompts, and the footer", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /noisy cloudflared/u);
  assert.doesNotMatch(result.stderr, /\[HTTP\]/u);
  assert.doesNotMatch(result.stderr, /New Streamable HTTP session/u);
  assert.doesNotMatch(result.stderr, /Registration request received/u);
  assert.doesNotMatch(result.stderr, /secret-noise/u);
  assert.match(result.stderr, /Error handling Streamable HTTP request: useful/u);
  assert.match(result.stderr, /Allow this ChatGPT connection\? \[y\/N\]:/u);
  assert.match(result.stderr, /PiLink Gateway ready/u);
  assert.match(result.stderr, /ChatGPT MCP: https:\/\/mcp\.example\.com\/sse/u);
});
