// ─────────────────────────────────────────────────────────────
// PiLink: OAuth 2.0 Authorization Server Routes
// ─────────────────────────────────────────────────────────────

import crypto from "node:crypto";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import {
  effectiveClientTokenVersion,
  findClient,
  findActiveClient,
  verifyClientSecret,
  registerClient,
  createAuthorizationCode,
  consumeAuthorizationCode,
  peekAuthorizationCode,
  createAccessToken,
  createRefreshToken,
  rotateRefreshToken,
  deleteClient,
  inspectAccessTokenForRevocation,
  revokeAccessToken,
  verifyPKCE,
  loadClients,
} from "./auth.js";
import { loadRuntimeConfig } from "./config.js";
import {
  consumeOwnerPairing,
  createOwnerPairing,
  hasBootstrapAccess,
  hasOwnerSession,
  isLocalAdminRequest,
} from "./oauth-owner.js";
import type { OAuthClient } from "./types.js";
import { recordOAuthActivity } from "./service-status.js";
import { asyncRoute } from "./http.js";
import { createRateLimiter } from "./security.js";

const RESOURCE_SCOPES = ["mcp:tools", "mcp:read", "mcp:write"] as const;
const SUPPORTED_SCOPES = new Set([...RESOURCE_SCOPES, "offline_access"]);
const consentRequests = new Map<string, { fingerprint: string; expiresAt: number }>();
const CONSENT_REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_CONSENT_REQUESTS = 128;
const UNSAFE_OAUTH_DISPLAY_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const limitPublicDcrRegistration = createRateLimiter(10, 60_000);
const ALLOWED_PAIRING_CONTINUATIONS = new Set([
  "https://chatgpt.com/#settings/Security",
  "https://chatgpt.com/plugins",
  "https://chatgpt.com/?surface=chat",
]);

function log(msg: string) {
  console.error(`[OAuth] ${msg.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu, " ").slice(0, 500)}`);
}

export function createOAuthRouter(): Router {
  const router = Router();

  // ── RFC 8414 & OpenID Metadata ────────────────────────────────
  const sendAuthServerMetadata = (_req: Request, res: Response) => {
    const config = loadRuntimeConfig();
    const serverUrl = config.serverUrl;
    res.json({
      issuer: serverUrl,
      authorization_endpoint: `${serverUrl}/oauth/authorize`,
      token_endpoint: `${serverUrl}/oauth/token`,
      revocation_endpoint: `${serverUrl}/oauth/revoke`,
      revocation_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      ...(config.publicChatGptDcr ? { registration_endpoint: `${serverUrl}/oauth/register` } : {}),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
        "none",
      ],
      scopes_supported: [...RESOURCE_SCOPES, "offline_access"],
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
      scopes_supported: RESOURCE_SCOPES,
      bearer_methods_supported: ["header"],
    });
  };

  router.get("/.well-known/oauth-protected-resource", sendProtectedResourceMetadata);
  router.get("/.well-known/oauth-protected-resource/*", sendProtectedResourceMetadata);
  router.get("*/.well-known/oauth-protected-resource", sendProtectedResourceMetadata);

  // The VS Code wizard calls this endpoint over the loopback origin with the
  // private bootstrap token, then opens the one-use public URL in the browser.
  router.post("/admin/oauth/pairing", (req: Request, res: Response) => {
    const config = loadRuntimeConfig();
    if (!isLocalAdminRequest(req) || !hasBootstrapAccess(req, config.bootstrapSecret)) {
      res.status(403).json({ error: "forbidden", error_description: "Local owner access is required" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    const pairing = createOwnerPairing(config.serverUrl);
    res.json({ pairing_url: pairing.pairingUrl, expires_at: pairing.expiresAt });
  });

  router.get("/oauth/pair", (req: Request, res: Response) => {
    const config = loadRuntimeConfig();
    res.setHeader("Cache-Control", "no-store");
    const continuation = pairingContinuation(req.query.continue);
    if (req.query.continue !== undefined && !continuation) {
      res.status(400).type("html").send(renderPairingResult(false));
      return;
    }
    const paired = consumeOwnerPairing(req, res, req.query.code, config.serverUrl);
    if (paired && continuation) {
      res.redirect(303, continuation);
      return;
    }
    res.status(paired ? 200 : 400).type("html").send(renderPairingResult(paired));
  });

  router.delete("/admin/oauth/clients/:clientId", asyncRoute(async (req: Request, res: Response) => {
    const config = loadRuntimeConfig();
    if (!isLocalAdminRequest(req) || !hasBootstrapAccess(req, config.bootstrapSecret)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const clientId = Array.isArray(req.params.clientId) ? "" : req.params.clientId;
    const removed = await deleteClient(clientId);
    res.status(removed ? 204 : 404).end();
  }));

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
    } = req.query as Record<string, unknown>;

    log(`Authorize request: client=${maskClientId(client_id)} response_type=${response_type}`);

    if (response_type !== "code") {
      res.status(400).json({ error: "unsupported_response_type" });
      return;
    }
    if (
      !boundedOAuthText(client_id, 256) ||
      !optionalOAuthText(redirect_uri, 2_048) ||
      !optionalOAuthText(scope, 512) ||
      !optionalOAuthText(state, 4_096) ||
      !boundedOAuthText(code_challenge, 256) ||
      !boundedOAuthText(code_challenge_method, 32)
    ) {
      res.status(400).json({ error: "invalid_request", error_description: "OAuth parameters must be bounded strings" });
      return;
    }

    const config = loadRuntimeConfig();
    if (config.oauthConsentMode === "paired" && !hasOwnerSession(req)) {
      res.status(403).type("html").send(renderPairingRequired());
      return;
    }

    const client = findActiveClient(client_id);
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

    const consentToken = createConsentRequest({
      client_id,
      redirect_uri: redirect_uri || client.redirect_uris[0],
      scope: resolvedScope,
      state: state || "",
      code_challenge: code_challenge || "",
      code_challenge_method: code_challenge_method || "",
    });
    const html = renderConsentPage(
      client.client_name,
      resolvedScope,
      client_id,
      redirect_uri || client.redirect_uris[0],
      state || "",
      code_challenge || "",
      code_challenge_method || "",
      consentToken,
    );
    setConsentRedirectPolicy(res, redirect_uri || client.redirect_uris[0]);
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
      consent_token,
    } = req.body;

    log(`Consent POST: action=${action} client=${maskClientId(client_id)}`);

    if (
      (action !== "approve" && action !== "deny") ||
      !boundedOAuthText(client_id, 256) ||
      !boundedOAuthText(redirect_uri, 2_048) ||
      !boundedOAuthText(scope, 512) ||
      !optionalOAuthText(state, 4_096) ||
      !boundedOAuthText(code_challenge, 256) ||
      !boundedOAuthText(code_challenge_method, 32) ||
      !boundedOAuthText(consent_token, 256)
    ) {
      res.status(400).json({ error: "invalid_request", error_description: "OAuth consent parameters are invalid" });
      return;
    }

    const config = loadRuntimeConfig();
    if (config.oauthConsentMode === "paired" && !hasOwnerSession(req)) {
      res.status(403).json({ error: "access_denied", error_description: "Owner pairing is required" });
      return;
    }

    const client = findActiveClient(client_id);
    if (!client || !redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
      res.status(400).json({ error: "invalid_request", error_description: "Unknown client or redirect URI" });
      return;
    }
    const resolvedScope = validateRequestedScope(scope || client.scope, client.scope);
    if (!resolvedScope || !code_challenge || code_challenge_method !== "S256") {
      res.status(400).json({ error: "invalid_request", error_description: "Invalid scope or PKCE parameters" });
      return;
    }
    if (!consumeConsentRequest(consent_token, {
      client_id,
      redirect_uri,
      scope: resolvedScope,
      state: state || "",
      code_challenge,
      code_challenge_method,
    })) {
      res.status(400).json({ error: "invalid_request", error_description: "Consent request is missing, expired, or already used" });
      return;
    }
    if (action !== "approve") {
      const deniedUrl = new URL(redirect_uri);
      deniedUrl.searchParams.set("error", "access_denied");
      if (state) deniedUrl.searchParams.set("state", state);
      setConsentRedirectPolicy(res, redirect_uri);
      res.redirect(303, deniedUrl.toString());
      return;
    }

    const code = createAuthorizationCode(
      client_id,
      effectiveClientTokenVersion(client),
      redirect_uri,
      resolvedScope,
      code_challenge,
      "S256"
    );

    const callbackUrl = new URL(redirect_uri);
    callbackUrl.searchParams.set("code", code);
    if (state) callbackUrl.searchParams.set("state", state);

    log(`Authorization code issued for client '${maskClientId(client_id)}'`);
    recordOAuthActivity(client_id, "authorized");
    setConsentRedirectPolicy(res, redirect_uri);
    res.redirect(303, callbackUrl.toString());
  });

  // ── Token Endpoint ─────────────────────────────────────────
  router.post("/oauth/token", asyncRoute(async (req: Request, res: Response) => {
    const { grant_type } = req.body;
    log(`Token request: grant_type=${grant_type}`);

    // Client Credentials Grant
    if (grant_type === "client_credentials") {
      const credentials = extractClientCredentials(req);
      const { client_id, client_secret, scope } = credentials;

      if (!client_id || !client_secret) {
        res.status(401).json({ error: "invalid_client", error_description: "Missing client credentials" });
        return;
      }

      const client = findActiveClient(client_id);
      if (!client) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }

      const valid = await authenticateAuthorizationClient(client, credentials);
      const currentClient = findActiveClient(client_id);
      if (!valid || !sameClientCredentialGeneration(client, currentClient)) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
      if (!currentClient.grant_types.includes("client_credentials")) {
        res.status(400).json({ error: "unauthorized_client" });
        return;
      }

      const resolvedScope = validateRequestedScope(scope || currentClient.scope, currentClient.scope);
      if (!resolvedScope) {
        res.status(400).json({ error: "invalid_scope" });
        return;
      }
      const token = createAccessToken(currentClient, resolvedScope);
      log(`Token issued for '${maskClientId(client_id)}' via client_credentials`);
      recordOAuthActivity(client_id, "token");
      res.json({ ...token, scope: resolvedScope });
      return;
    }

    // Authorization Code Grant
    if (grant_type === "authorization_code") {
      const extracted = extractClientCredentials(req);
      const client_id = extracted.client_id || req.body.client_id;
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

      if (!client_id || authCode.client_id !== client_id) {
        res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
        return;
      }

      const client = findActiveClient(authCode.client_id);
      if (!client || !client.grant_types.includes("authorization_code")) {
        res.status(400).json({ error: "unauthorized_client" });
        return;
      }

      if (redirect_uri && authCode.redirect_uri !== redirect_uri) {
        res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return;
      }

      if (!await authenticateAuthorizationClient(client, extracted)) {
        res.status(401).json({ error: "invalid_client" });
        return;
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
      const currentClient = findActiveClient(consumedCode.client_id);
      if (!sameClientCredentialGeneration(client, currentClient) ||
          consumedCode.client_version !== effectiveClientTokenVersion(currentClient)) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      const token = createAccessToken(currentClient, consumedCode.scope);
      const refresh = consumedCode.scope.split(" ").includes("offline_access")
        ? await createRefreshToken(currentClient, consumedCode.scope)
        : undefined;
      log(`Token issued for '${maskClientId(authCode.client_id)}' via authorization_code`);
      recordOAuthActivity(authCode.client_id, "token");
      res.json({
        ...token,
        ...(refresh ? { refresh_token: refresh.refresh_token, refresh_token_expires_in: refresh.expires_in } : {}),
        scope: consumedCode.scope,
      });
      return;
    }

    // Rotating Refresh Token Grant
    if (grant_type === "refresh_token") {
      const extracted = extractClientCredentials(req);
      const clientId = extracted.client_id || req.body.client_id;
      const presentedToken = req.body.refresh_token;
      if (!clientId || typeof presentedToken !== "string") {
        res.status(400).json({ error: "invalid_request", error_description: "client_id and refresh_token are required" });
        return;
      }
      const client = findActiveClient(clientId);
      if (!client || !client.grant_types.includes("refresh_token")) {
        res.status(400).json({ error: "unauthorized_client" });
        return;
      }
      if (!await authenticateAuthorizationClient(client, extracted)) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
      const currentClient = findActiveClient(clientId);
      if (!sameClientCredentialGeneration(client, currentClient)) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
      const rotated = await rotateRefreshToken(presentedToken, currentClient);
      if (!rotated) {
        res.status(400).json({ error: "invalid_grant", error_description: "Invalid, expired, or already-used refresh token" });
        return;
      }
      const accessToken = createAccessToken(currentClient, rotated.scope);
      log(`Token rotated for '${maskClientId(clientId)}' via refresh_token`);
      recordOAuthActivity(clientId, "refresh");
      res.json({
        ...accessToken,
        refresh_token: rotated.refresh_token,
        refresh_token_expires_in: rotated.expires_in,
        scope: rotated.scope,
      });
      return;
    }

    res.status(400).json({
      error: "unsupported_grant_type",
      error_description: `Grant type '${grant_type}' is not supported`,
    });
  }));

  // ── Token Revocation (RFC 7009) ────────────────────────────
  router.post("/oauth/revoke", createRateLimiter(20, 60_000), asyncRoute(async (req: Request, res: Response) => {
    if (!isPlainRecord(req.body) || hasUnexpectedOAuthKeys(req.body, [
      "token",
      "token_type_hint",
      "client_id",
      "client_secret",
    ])) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const token = req.body.token;
    const tokenTypeHint = req.body.token_type_hint;
    if (!boundedOAuthText(token, 64 * 1024) ||
        (tokenTypeHint !== undefined && tokenTypeHint !== "access_token")) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const config = loadRuntimeConfig();
    const payload = inspectAccessTokenForRevocation(token);
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : "";
    let authenticatedClientId: string | undefined;

    if (payload && bearer === token) {
      authenticatedClientId = payload.sub;
    } else if (isLocalAdminRequest(req) && hasBootstrapAccess(req, config.bootstrapSecret)) {
      authenticatedClientId = payload?.sub;
    } else {
      const credentials = extractClientCredentials(req);
      const client = credentials.client_id ? findActiveClient(credentials.client_id) : undefined;
      if (!client || (client.token_endpoint_auth_method || "client_secret_post") === "none" ||
          !await authenticateAuthorizationClient(client, credentials)) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
      const currentClient = findActiveClient(client.client_id);
      if (!sameClientCredentialGeneration(client, currentClient)) {
        res.status(401).json({ error: "invalid_client" });
        return;
      }
      authenticatedClientId = currentClient.client_id;
    }

    // RFC 7009 returns success for unknown tokens. Do the same for a valid
    // token owned by another authenticated client so this endpoint cannot be
    // used as a cross-client token oracle.
    if (payload && authenticatedClientId === payload.sub) await revokeAccessToken(payload);
    res.sendStatus(200);
  }));

  // ── Dynamic Client Registration (RFC 7591) ────────────────
  router.post("/oauth/register", (req: Request, res: Response, next: NextFunction) => {
    const config = loadRuntimeConfig();
    if (isLocalAdminRequest(req) && hasBootstrapAccess(req, config.bootstrapSecret)) next();
    else limitPublicDcrRegistration(req, res, next);
  }, asyncRoute(async (req: Request, res: Response) => {
    const { client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method } = req.body;
    log("Registration request received");

    if (!client_name) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "client_name is required" });
      return;
    }
    const config = loadRuntimeConfig();
    const bootstrapRegistration = isLocalAdminRequest(req) && hasBootstrapAccess(req, config.bootstrapSecret);
    const publicChatGptDcr = !bootstrapRegistration && config.publicChatGptDcr && isPublicChatGptDcrRequest(req.body);
    if (!bootstrapRegistration && !publicChatGptDcr) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "invalid_token", error_description: "A registration access token is required" });
      return;
    }

    const resolvedGrantTypes = publicChatGptDcr
      ? ["authorization_code", "refresh_token"]
      : grant_types || ["client_credentials"];
    const resolvedRedirectUris = redirect_uris || [];
    const resolvedScope = publicChatGptDcr ? "mcp:tools offline_access" : scope || "mcp:tools";
    const resolvedAuthMethod: NonNullable<OAuthClient["token_endpoint_auth_method"]> = publicChatGptDcr
      ? "none"
      : token_endpoint_auth_method || "client_secret_post";

    if (
      !safeOAuthDisplayText(client_name, 120) ||
      !Array.isArray(resolvedGrantTypes) || resolvedGrantTypes.length < 1 || resolvedGrantTypes.length > 3 ||
      !Array.isArray(resolvedRedirectUris) || resolvedRedirectUris.length > 10 ||
      typeof resolvedScope !== "string" || resolvedScope.length > 256 ||
      !validateRequestedScope(resolvedScope, "mcp:tools mcp:read mcp:write offline_access") ||
      resolvedGrantTypes.some((grant) => grant !== "authorization_code" && grant !== "refresh_token" && grant !== "client_credentials") ||
      new Set(resolvedGrantTypes).size !== resolvedGrantTypes.length ||
      resolvedRedirectUris.some((uri) => !isSafeRedirectUri(uri)) ||
      !["client_secret_post", "client_secret_basic", "none"].includes(resolvedAuthMethod)
    ) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "Invalid grant types, redirect URIs, or scope" });
      return;
    }

    if (resolvedGrantTypes.includes("authorization_code") && resolvedRedirectUris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required for authorization_code grant" });
      return;
    }
    if (resolvedGrantTypes.includes("refresh_token") && !resolvedGrantTypes.includes("authorization_code")) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "refresh_token requires authorization_code" });
      return;
    }
    if (resolvedAuthMethod === "none" && resolvedGrantTypes.includes("client_credentials")) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "Public clients cannot use client_credentials" });
      return;
    }

    if (publicChatGptDcr) {
      const existing = reusablePublicChatGptClient(resolvedRedirectUris[0]);
      if (existing) {
        res.status(201).json(publicClientRegistrationResponse(existing));
        return;
      }
      const publicDcrClients = loadClients().filter((client) =>
        client.disabled_at === undefined &&
        client.token_endpoint_auth_method === "none" &&
        client.redirect_uris.length === 1 &&
        isChatGptConnectorRedirect(client.redirect_uris[0])
      );
      if (publicDcrClients.length >= 64) {
        res.status(429).json({ error: "registration_limit_reached", error_description: "Too many pending ChatGPT clients" });
        return;
      }
    }

    const { client, client_secret } = await registerClient(
      client_name.trim(),
      resolvedRedirectUris,
      resolvedGrantTypes,
      resolvedScope,
      resolvedAuthMethod,
    );

    log(`Client registered: ${maskClientId(client.client_id)}`);
    recordOAuthActivity(client.client_id, "registered");

    res.status(201).json({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      scope: client.scope,
      ...(resolvedAuthMethod === "none" ? {} : { client_secret, client_secret_expires_at: 0 }),
    });
  }));

  return router;
}

function isPublicChatGptDcrRequest(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const redirectUris = value.redirect_uris;
  const grantTypes = value.grant_types;
  const requestedScope = value.scope;
  const authMethod = value.token_endpoint_auth_method;
  return safeOAuthDisplayText(value.client_name, 120) &&
    Array.isArray(redirectUris) && redirectUris.length === 1 && isChatGptConnectorRedirect(redirectUris[0]) &&
    (grantTypes === undefined || (
      Array.isArray(grantTypes) && grantTypes.length >= 1 && grantTypes.length <= 2 &&
      grantTypes.includes("authorization_code") &&
      grantTypes.every((grant) => grant === "authorization_code" || grant === "refresh_token")
    )) &&
    (requestedScope === undefined || (
      typeof requestedScope === "string" && requestedScope.length <= 256 &&
      validateRequestedScope(requestedScope, "mcp:tools offline_access") !== null
    )) &&
    (authMethod === undefined || authMethod === "none" || authMethod === "client_secret_post" || authMethod === "client_secret_basic");
}

function pairingContinuation(value: unknown): string | undefined {
  return typeof value === "string" && ALLOWED_PAIRING_CONTINUATIONS.has(value) ? value : undefined;
}

function isChatGptConnectorRedirect(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "chatgpt.com" &&
      !url.username && !url.password && !url.search && !url.hash &&
      /^\/connector\/oauth\/[A-Za-z0-9_-]{6,160}$/u.test(url.pathname);
  } catch {
    return false;
  }
}

function reusablePublicChatGptClient(redirectUri: string): OAuthClient | undefined {
  return loadClients().find((client) =>
    client.disabled_at === undefined &&
    client.token_endpoint_auth_method === "none" &&
    client.grant_types.includes("authorization_code") &&
    client.grant_types.includes("refresh_token") &&
    client.scope === "mcp:tools offline_access" &&
    client.redirect_uris.length === 1 && client.redirect_uris[0] === redirectUri
  );
}

function publicClientRegistrationResponse(client: OAuthClient): Record<string, unknown> {
  return {
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    token_endpoint_auth_method: "none",
    scope: client.scope,
  };
}

interface ExtractedClientCredentials {
  client_id: string;
  client_secret: string;
  scope?: string;
  method: "client_secret_basic" | "client_secret_post" | "none";
}

function extractClientCredentials(req: Request): ExtractedClientCredentials {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
      const colonIndex = decoded.indexOf(":");
      if (colonIndex > 0) {
        const client_id = decodeURIComponent(decoded.slice(0, colonIndex));
        const client_secret = decodeURIComponent(decoded.slice(colonIndex + 1));
        return { client_id, client_secret, scope: req.body.scope, method: "client_secret_basic" };
      }
    } catch {
      // Malformed percent encoding is an invalid credential, never a 500.
    }
  }
  const clientSecret = typeof req.body.client_secret === "string" ? req.body.client_secret : "";
  return {
    client_id: req.body.client_id,
    client_secret: clientSecret,
    scope: req.body.scope,
    method: clientSecret ? "client_secret_post" : "none",
  };
}

function boundedOAuthText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && !/[\0\r\n]/u.test(value) &&
    Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function optionalOAuthText(value: unknown, maximumBytes: number): value is string | undefined {
  return value === undefined || boundedOAuthText(value, maximumBytes);
}

function safeOAuthDisplayText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes && !UNSAFE_OAUTH_DISPLAY_TEXT.test(value);
}

function validateRequestedScope(requested: string, allowed: string): string | null {
  const requestedScopes = requested.split(" ").filter(Boolean);
  const allowedScopes = new Set(allowed.split(" ").filter(Boolean));
  // mcp:tools is the umbrella permission: clients such as ChatGPT request it
  // alongside the individual read/write scopes advertised in metadata.
  if (allowedScopes.has("mcp:tools")) {
    for (const scope of RESOURCE_SCOPES) allowedScopes.add(scope);
  }
  if (!requestedScopes.length || requestedScopes.some((scope) => !SUPPORTED_SCOPES.has(scope) || !allowedScopes.has(scope))) return null;
  return requestedScopes.join(" ");
}

async function authenticateAuthorizationClient(
  client: NonNullable<ReturnType<typeof findClient>>,
  credentials: ExtractedClientCredentials,
): Promise<boolean> {
  const method = client.token_endpoint_auth_method || "client_secret_post";
  if (method === "none") return credentials.method === "none";
  if (credentials.method !== method || !credentials.client_secret) return false;
  return verifyClientSecret(client, credentials.client_secret);
}

function sameClientCredentialGeneration(
  expected: OAuthClient,
  current: OAuthClient | undefined,
): current is OAuthClient {
  return Boolean(current &&
    current.client_secret_hash === expected.client_secret_hash &&
    effectiveClientTokenVersion(current) === effectiveClientTokenVersion(expected));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnexpectedOAuthKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const selected = new Set(allowed);
  return Object.keys(value).some((key) => !selected.has(key));
}

function isSafeRedirectUri(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * The global policy deliberately limits form submissions to this origin.
 * OAuth consent is the one exception: the POST is local, then the browser
 * must follow the authorization response to the client's registered callback.
 * Restrict that exception to the exact, already-validated callback origin.
 */
function setConsentRedirectPolicy(res: Response, redirectUri: string): void {
  const callbackOrigin = new URL(redirectUri).origin;
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'`,
  );
}

interface ConsentFields {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
}

function createConsentRequest(fields: ConsentFields): string {
  const now = Date.now();
  pruneConsentRequests(now);
  if (consentRequests.size >= MAX_CONSENT_REQUESTS) {
    const oldest = consentRequests.keys().next().value as string | undefined;
    if (oldest) consentRequests.delete(oldest);
  }
  const token = crypto.randomBytes(32).toString("base64url");
  consentRequests.set(token, {
    fingerprint: consentFingerprint(fields),
    expiresAt: now + CONSENT_REQUEST_TTL_MS,
  });
  return token;
}

function consumeConsentRequest(token: unknown, fields: ConsentFields): boolean {
  if (typeof token !== "string" || token.length < 32 || token.length > 256) return false;
  const now = Date.now();
  pruneConsentRequests(now);
  const request = consentRequests.get(token);
  consentRequests.delete(token);
  return Boolean(request && request.expiresAt > now && request.fingerprint === consentFingerprint(fields));
}

function consentFingerprint(fields: ConsentFields): string {
  return crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function pruneConsentRequests(now: number): void {
  for (const [token, request] of consentRequests) {
    if (request.expiresAt <= now) consentRequests.delete(token);
  }
}

function renderPairingResult(paired: boolean): string {
  return renderNoticePage(
    paired ? "PiLink connected" : "Invalid connection",
    paired
      ? "This browser session can now approve the OAuth connection. Return to the wizard and continue in ChatGPT."
      : "This code has expired or has already been used. Return to the PiLink wizard and select Retry.",
    paired,
  );
}

function renderPairingRequired(): string {
  return renderNoticePage(
    "Confirm the request in VS Code",
    "To protect this computer, open the PiLink wizard in VS Code and select “Authorize this browser”, then retry the connection in ChatGPT.",
    false,
  );
}

function renderNoticePage(title: string, message: string, success: boolean): string {
  const color = success ? "#10b981" : "#f59e0b";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0f0f14;color:#e7e7ec;font:16px/1.5 system-ui,sans-serif}.card{width:min(560px,100%);padding:32px;border:1px solid #2b2b38;border-radius:18px;background:#181821;box-shadow:0 24px 80px #0008}.mark{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;margin-bottom:18px;background:${color}22;color:${color};font-size:24px;font-weight:800}h1{font-size:24px;margin:0 0 12px}p{margin:0;color:#b5b5c3}</style></head><body><main class="card"><div class="mark">${success ? "✓" : "!"}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function renderConsentPage(
  clientName: string,
  scope: string,
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  codeChallengeMethod: string,
  consentToken: string,
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
      <input type="hidden" name="consent_token" value="${escapeHtml(consentToken)}">
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

function maskClientId(value: unknown): string {
  if (typeof value !== "string" || value.length < 9) return "unknown";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
