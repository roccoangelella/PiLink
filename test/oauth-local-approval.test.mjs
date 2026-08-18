import assert from "node:assert/strict";
import test from "node:test";

import {
  isApprovedChatGptPublicClient,
  resolveClientScope,
} from "../dist/oauth-local-approval.js";

function client(overrides = {}) {
  return {
    client_id: "pi_0123456789abcdef",
    client_secret_hash: "x".repeat(64),
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/abcdef123456"],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
    scope: "mcp:tools offline_access",
    created_at: new Date(0).toISOString(),
    token_version: 1,
    ...overrides,
  };
}

test("local approval accepts only the exact public ChatGPT callback client", () => {
  const redirect = "https://chatgpt.com/connector/oauth/abcdef123456";
  assert.equal(isApprovedChatGptPublicClient(client(), redirect), true);
  assert.equal(isApprovedChatGptPublicClient(client({ token_endpoint_auth_method: "client_secret_post" }), redirect), false);
  assert.equal(isApprovedChatGptPublicClient(client(), "https://attacker.example/callback"), false);
  assert.equal(isApprovedChatGptPublicClient(client({
    redirect_uris: ["https://chatgpt.com/connector/oauth/another123456"],
  }), redirect), false);
});

test("local approval never expands the registered OAuth scope", () => {
  assert.equal(resolveClientScope(undefined, "mcp:tools offline_access"), "mcp:tools offline_access");
  assert.equal(resolveClientScope("mcp:tools", "mcp:tools offline_access"), "mcp:tools");
  assert.equal(resolveClientScope("offline_access mcp:tools", "mcp:tools offline_access"), "offline_access mcp:tools");
  assert.equal(resolveClientScope("mcp:read", "mcp:tools offline_access"), undefined);
  assert.equal(resolveClientScope("mcp:tools mcp:tools", "mcp:tools offline_access"), undefined);
});
