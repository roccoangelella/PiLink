import assert from "node:assert/strict";
import test from "node:test";
import { isAwaitingCliInput, isNodeVersionSupported, REQUIRED_NODE_VERSION, redactSensitiveOutput, stripAnsi } from "../src/security.js";

test("stripAnsi removes terminal control sequences", () => {
  assert.equal(stripAnsi("plain \u001b[31mred\u001b[0m text"), "plain red text");
});

test("redactSensitiveOutput strips ANSI and redacts every supported secret form", () => {
  const output = redactSensitiveOutput([
    "\u001b[32mClient secret: client-secret-value\u001b[0m",
    "JWT_SECRET=jwt-secret-value",
    "PI_BOOTSTRAP_SECRET = bootstrap-secret-value",
    "Authorization: Bearer aaa.bbb_cc-+/~",
    "{\"access_token\":\"access-token-value\",\"client_secret\": \"json-client-secret\",\"visible\":\"ok\"}",
    "{\"refresh_token\":\"refresh-secret\",\"api_key\":\"json-api-secret\"}",
    "PI_AGENT_API_KEY=agent-api-secret",
    "CLOUDFLARE_API_TOKEN='cloudflare-secret'",
    "Cookie: session=cookie-secret; Secure",
    "https://example.test/callback?code=oauth-code-secret&state=oauth-state-secret",
    "--token cloudflare-tunnel-secret --client-secret cli-client-secret",
    "sk-abcdefghijklmnopqrstuvwxyz123456",
  ].join("\n"));

  for (const secret of [
    "client-secret-value",
    "jwt-secret-value",
    "bootstrap-secret-value",
    "aaa.bbb_cc-+/~",
    "access-token-value",
    "json-client-secret",
    "refresh-secret",
    "json-api-secret",
    "agent-api-secret",
    "cloudflare-secret",
    "cookie-secret",
    "oauth-code-secret",
    "oauth-state-secret",
    "cloudflare-tunnel-secret",
    "cli-client-secret",
    "sk-abcdefghijklmnopqrstuvwxyz123456",
  ]) {
    assert.equal(output.includes(secret), false, `secret leaked: ${secret}`);
  }
  assert.equal(output.includes("\u001b"), false);
  assert.match(output, /Client secret: \[shown only in the terminal\]/);
  assert.match(output, /JWT_SECRET=\[redacted\]/);
  assert.match(output, /PI_BOOTSTRAP_SECRET = \[redacted\]/);
  assert.match(output, /Authorization: \[redacted\]/);
  assert.match(output, /"access_token":"\[redacted\]"/);
  assert.match(output, /"client_secret": "\[redacted\]"/);
  assert.match(output, /"refresh_token":"\[redacted\]"/);
  assert.match(output, /"visible":"ok"/);
});

test("isAwaitingCliInput recognizes every interactive PiLink prompt", () => {
  for (const prompt of [
    "Type RESET to continue: ",
    "How should PiLink continue? [1/2]: ",
    "Enter new configuration directory [default: /tmp/pilink-2]: ",
    "Enter new server port [default: 3201]: ",
    "Select hosting [1/2]: ",
    "Allow PiLink to request these temporary router mappings? [Y/n]: ",
    "Type DIRECT after completing the router configuration: ",
    "Paste callback URL here:\n> ",
  ]) {
    assert.equal(isAwaitingCliInput(`[PiLink] preparing\n${prompt}`), true, prompt);
  }
  assert.equal(isAwaitingCliInput("Server listening at: http://127.0.0.1:3200"), false);
  assert.equal(isAwaitingCliInput("The operation completed?"), false);
});

test("isNodeVersionSupported requires Node 24.18.0 exactly", () => {
  assert.equal(REQUIRED_NODE_VERSION, "24.18.0");
  for (const version of ["v24.18.0", "24.18.0", "  v24.18.0\n"]) {
    assert.equal(isNodeVersionSupported(version), true, version);
  }
  for (const version of ["v24.17.9", "v24.18.1", "24.19.0", "25.0.0", "v24.18.0-nightly", "v24.18", "not-a-version", ""]) {
    assert.equal(isNodeVersionSupported(version), false, version);
  }
});
