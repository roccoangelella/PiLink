// ─────────────────────────────────────────────────────────────
// PiLink: OAuth 2.0 Authorization Server Routes
// ─────────────────────────────────────────────────────────────

import crypto from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import {
  findClient,
  verifyClientSecret,
  registerClient,
  createAuthorizationCode,
  consumeAuthorizationCode,
  peekAuthorizationCode,
  createAccessToken,
  verifyPKCE,
} from "./auth.js";
import { loadRuntimeConfig } from "./config.js";

const SUPPORTED_SCOPES = new Set(["mcp:tools", "mcp:read", "mcp:write"]);

function log(msg: string) {
  console.error(`[OAuth] ${msg}`);
}

export function createOAuthRouter(): Router {
  const router = Router();

  // ── RFC 8414 & OpenID Metadata ────────────────────────────────
  const sendAuthServerMetadata = (_req: Request, res: Response) => {
    const serverUrl = loadRuntimeConfig().serverUrl;
    res.json({
      issuer: serverUrl,
      authorization_endpoint: `${serverUrl}/oauth/authorize`,
      token_endpoint: `${serverUrl}/oauth/token`,
      registration_endpoint: `${serverUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "client_credentials"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
        "none",
      ],
       scopes_supported: ["mcp:tools", "mcp:read", "mcp:write"],
    });
  };

  router.get("/.well-known/oauth-authorization-server", sendAuthServerMetadata);
  router.get("/.well-known/oauth-authorization-server/*", sendAuthServerMetadata);
  router.get("/.well-known/openid-configuration", sendAuthServerMetadata);
  router.get("/.well-known/openid-configuration/*", sendAuthServerMetadata);
  router.get("*/.well-known/oauth-authorization-server", sendAuthServerMetadata);
  router.get("*/.well-known/openid-configuration", sendAuthServerMetadata);

  // ── RFC 9728: Protected Resource Metadata ──────────────────
  const sendProtectedResourceMetadata = (_req: Request, res: Response) => {
    const serverUrl = loadRuntimeConfig().serverUrl;
    res.json({
      resource: serverUrl,
      authorization_servers: [serverUrl],
       scopes_supported: ["mcp:tools", "mcp:read", "mcp:write"],
      bearer_methods_supported: ["header"],
    });
  };

  router.get("/.well-known/oauth-protected-resource", sendProtectedResourceMetadata);
  router.get("/.well-known/oauth-protected-resource/*", sendProtectedResourceMetadata);
  router.get("*/.well-known/oauth-protected-resource", sendProtectedResourceMetadata);

  // ── Authorization Endpoint (GET: consent page) ─────────────
  router.get("/oauth/authorize", (req: Request, res: Response) => {
    const {
      response_type,
      client_id,
      redirect_uri,
      scope,
      state,
      code_challenge,
      code_challenge_method,
    } = req.query as Record<string, string>;

    log(`Authorize request: client_id=${client_id} response_type=${response_type} redirect_uri=${redirect_uri}`);

    if (response_type !== "code") {
      res.status(400).json({ error: "unsupported_response_type" });
      return;
    }

    const client = findClient(client_id);
    if (!client) {
      res.status(400).json({ error: "invalid_client", error_description: "Unknown client_id" });
      return;
    }

    if (redirect_uri && !client.redirect_uris.includes(redirect_uri)) {
      res.status(400).json({ error: "invalid_request", error_description: "Invalid redirect_uri" });
      return;
    }
    if (!code_challenge || code_challenge_method !== "S256") {
      res.status(400).json({ error: "invalid_request", error_description: "S256 PKCE is required" });
      return;
    }
    const resolvedScope = validateRequestedScope(scope || client.scope, client.scope);
    if (!resolvedScope) {
      res.status(400).json({ error: "invalid_scope" });
      return;
    }

    const html = renderConsentPage(
      client.client_name,
      resolvedScope,
      client_id,
      redirect_uri || client.redirect_uris[0],
      state || "",
      code_challenge || "",
      code_challenge_method || ""
    );
    res.type("html").send(html);
  });

  // ── Authorization Endpoint (POST: handle consent) ──────────
  router.post("/oauth/authorize", (req: Request, res: Response) => {
    const {
      action,
      client_id,
      redirect_uri,
      scope,
      state,
      code_challenge,
      code_challenge_method,
    } = req.body;

    log(`Consent POST: action=${action} client_id=${client_id}`);

    const client = findClient(client_id);
    if (!client || !redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
      res.status(400).json({ error: "invalid_request", error_description: "Unknown client or redirect URI" });
      return;
    }
    const resolvedScope = validateRequestedScope(scope || client.scope, client.scope);
    if (!resolvedScope || !code_challenge || code_challenge_method !== "S256") {
      res.status(400).json({ error: "invalid_request", error_description: "Invalid scope or PKCE parameters" });
      return;
    }
    if (action !== "approve") {
      const deniedUrl = new URL(redirect_uri);
      deniedUrl.searchParams.set("error", "access_denied");
      if (state) deniedUrl.searchParams.set("state", state);
      res.redirect(deniedUrl.toString());
      return;
    }

    const code = createAuthorizationCode(
      client_id,
      redirect_uri,
      resolvedScope,
      code_challenge,
      "S256"
    );

    const callbackUrl = new URL(redirect_uri);
    callbackUrl.searchParams.set("code", code);
    if (state) callbackUrl.searchParams.set("state", state);

    log(`Authorization code issued for client '${client_id}', redirecting...`);
    res.redirect(callbackUrl.toString());
  });

  // ── Token Endpoint ─────────────────────────────────────────
  router.post("/oauth/token", async (req: Request, res: Response) => {
    const { grant_type } = req.body;
    log(`Token request: grant_type=${grant_type}`);

    // Client Credentials Grant
    if (grant_type === "client_credentials") {
      const { client_id, client_secret, scope } = extractClientCredentials(req);

      if (!client_id || !client_secret) {
        res.status(401).json({ error: "invalid_client", error_description: "Missing client credentials" });
        return;
      }

      const client = findClient(client_id);
      if (!client) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }

      const valid = await verifyClientSecret(client, client_secret);
      if (!valid) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
      if (!client.grant_types.includes("client_credentials")) {
        res.status(400).json({ error: "unauthorized_client" });
        return;
      }

      const resolvedScope = validateRequestedScope(scope || client.scope, client.scope);
      if (!resolvedScope) {
        res.status(400).json({ error: "invalid_scope" });
        return;
      }
      const token = createAccessToken(client_id, resolvedScope);
      log(`Token issued for '${client_id}' via client_credentials`);
      res.json({ ...token, scope: resolvedScope });
      return;
    }

    // Authorization Code Grant
    if (grant_type === "authorization_code") {
      const extracted = extractClientCredentials(req);
      const client_id = extracted.client_id || req.body.client_id;
      const client_secret = extracted.client_secret;
      const code = req.body.code;
      const code_verifier = req.body.code_verifier;
      const redirect_uri = req.body.redirect_uri;

      if (!code) {
        res.status(400).json({ error: "invalid_request", error_description: "Missing authorization code" });
        return;
      }

      const authCode = peekAuthorizationCode(code);
      if (!authCode) {
        res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired authorization code" });
        return;
      }

      if (client_id && authCode.client_id !== client_id) {
        res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
        return;
      }

      const client = findClient(authCode.client_id);
      if (!client || !client.grant_types.includes("authorization_code")) {
        res.status(400).json({ error: "unauthorized_client" });
        return;
      }

      if (redirect_uri && authCode.redirect_uri !== redirect_uri) {
        res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return;
      }

      if (client_secret) {
        const valid = await verifyClientSecret(client, client_secret);
        if (!valid) {
          res.status(401).json({ error: "invalid_client" });
          return;
        }
      }

      if (authCode.code_challenge) {
        if (!code_verifier) {
          res.status(400).json({ error: "invalid_grant", error_description: "code_verifier is required" });
          return;
        }
        if (!verifyPKCE(code_verifier, authCode.code_challenge)) {
          res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
      }

      const consumedCode = consumeAuthorizationCode(code);
      if (!consumedCode) {
        res.status(400).json({ error: "invalid_grant", error_description: "Authorization code was already used" });
        return;
      }
      const token = createAccessToken(consumedCode.client_id, consumedCode.scope);
      log(`Token issued for '${authCode.client_id}' via authorization_code`);
      res.json({ ...token, scope: consumedCode.scope });
      return;
    }

    res.status(400).json({
      error: "unsupported_grant_type",
      error_description: `Grant type '${grant_type}' is not supported`,
    });
  });

  // ── Dynamic Client Registration (RFC 7591) ────────────────
  router.post("/oauth/register", async (req: Request, res: Response) => {
    const { client_name, redirect_uris, grant_types, scope } = req.body;
    log(`Registration request: client_name=${client_name}`);

    if (!client_name) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "client_name is required" });
      return;
    }
    if (!hasBootstrapAccess(req)) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "invalid_token", error_description: "A registration access token is required" });
      return;
    }

    const resolvedGrantTypes = grant_types || ["client_credentials"];
    const resolvedRedirectUris = redirect_uris || [];
    const resolvedScope = scope || "mcp:tools";

    if (typeof client_name !== "string" || !Array.isArray(resolvedGrantTypes) || !Array.isArray(resolvedRedirectUris) || typeof resolvedScope !== "string" || !validateRequestedScope(resolvedScope, "mcp:tools mcp:read mcp:write") || resolvedGrantTypes.some((grant) => grant !== "authorization_code" && grant !== "client_credentials") || resolvedRedirectUris.some((uri) => !isHttpUrl(uri))) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "Invalid grant types, redirect URIs, or scope" });
      return;
    }

    if (resolvedGrantTypes.includes("authorization_code") && resolvedRedirectUris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required for authorization_code grant" });
      return;
    }

    const { client, client_secret } = await registerClient(
      client_name,
      resolvedRedirectUris,
      resolvedGrantTypes,
      resolvedScope
    );

    log(`Client registered: client_id=${client.client_id}`);

    res.status(201).json({
      client_id: client.client_id,
      client_secret,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      scope: client.scope,
      client_secret_expires_at: 0,
    });
  });

  return router;
}

function extractClientCredentials(req: Request): { client_id: string; client_secret: string; scope?: string } {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const colonIndex = decoded.indexOf(":");
    if (colonIndex > 0) {
      const client_id = decodeURIComponent(decoded.slice(0, colonIndex));
      const client_secret = decodeURIComponent(decoded.slice(colonIndex + 1));
      return { client_id, client_secret, scope: req.body.scope };
    }
  }
  return {
    client_id: req.body.client_id,
    client_secret: req.body.client_secret,
    scope: req.body.scope,
  };
}

function validateRequestedScope(requested: string, allowed: string): string | null {
  const requestedScopes = requested.split(" ").filter(Boolean);
  const allowedScopes = new Set(allowed.split(" ").filter(Boolean));
  // mcp:tools is the umbrella permission: clients such as ChatGPT request it
  // alongside the individual read/write scopes advertised in metadata.
  if (allowedScopes.has("mcp:tools")) {
    for (const scope of SUPPORTED_SCOPES) allowedScopes.add(scope);
  }
  if (!requestedScopes.length || requestedScopes.some((scope) => !SUPPORTED_SCOPES.has(scope) || !allowedScopes.has(scope))) return null;
  return requestedScopes.join(" ");
}

function hasBootstrapAccess(req: Request): boolean {
  const presented = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  const expected = loadRuntimeConfig().bootstrapSecret;
  if (!presented || presented.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function renderConsentPage(
  clientName: string,
  scope: string,
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  codeChallengeMethod: string
): string {
  const scopes = scope.split(" ").filter(Boolean);
  const scopeList = scopes.map((s) => `<li>${escapeHtml(s)}</li>`).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PiLink Authorization</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0f0f14; color: #e2e2e8;
      display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 1rem;
    }
    .card {
      background: linear-gradient(145deg, #1a1a24, #14141c);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 16px; padding: 2.5rem; max-width: 440px; width: 100%;
      box-shadow: 0 24px 48px rgba(0, 0, 0, 0.4);
    }
    .logo { font-size: 2rem; font-weight: 700; margin-bottom: 0.5rem; }
    .logo span { color: #10b981; }
    .subtitle { color: #8888a0; font-size: 0.9rem; margin-bottom: 1.8rem; }
    .client-name {
      background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.25);
      border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1.5rem; font-weight: 600; font-size: 1.05rem;
    }
    h3 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #8888a0; margin-bottom: 0.6rem; }
    ul { list-style: none; margin-bottom: 1.8rem; }
    li {
      padding: 0.5rem 0.75rem; background: rgba(255, 255, 255, 0.03); border-radius: 6px;
      margin-bottom: 0.35rem; font-family: monospace; font-size: 0.85rem; color: #b4b4cc;
    }
    li::before { content: '✓ '; color: #10b981; font-weight: bold; }
    .buttons { display: flex; gap: 0.75rem; }
    button {
      flex: 1; padding: 0.85rem; border: none; border-radius: 10px; font-size: 0.95rem; font-weight: 600; cursor: pointer;
    }
    .approve { background: linear-gradient(135deg, #10b981, #059669); color: white; }
    .deny { background: rgba(255, 255, 255, 0.06); color: #8888a0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">PI<span>-MCP</span></div>
    <p class="subtitle">Authorization Request (Pi Agent Harness)</p>
    <div class="client-name">${escapeHtml(clientName)}</div>
    <h3>Requested Permissions</h3>
    <ul>${scopeList}</ul>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="scope" value="${escapeHtml(scope)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
      <div class="buttons">
        <button type="submit" name="action" value="deny" class="deny">Deny</button>
        <button type="submit" name="action" value="approve" class="approve">Approve</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
