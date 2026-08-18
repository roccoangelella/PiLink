import { createInterface } from "node:readline/promises";
import type { Request, Response } from "express";

import {
  createAuthorizationCode,
  effectiveClientTokenVersion,
  findActiveClient,
  setClientDisabled,
} from "./auth.js";
import { loadRuntimeConfig } from "./config.js";
import { closeOwnerRegistrationWindow, isOwnerRegistrationWindowOpen } from "./oauth-owner.js";
import { recordOAuthActivity } from "./service-status.js";
import type { OAuthClient } from "./types.js";

const LOCAL_APPROVAL_TIMEOUT_MS = 90_000;
const CLIENT_ID_PATTERN = /^pi_[a-f0-9]{16}$/iu;
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const UNSAFE_TERMINAL_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_TERMINAL_TEXT_GLOBAL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

interface LocalApprovalRequest {
  client: OAuthClient;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}

let activeApprovalFingerprint: string | undefined;
let activeApproval: Promise<boolean> | undefined;

/**
 * Intercept the initial ChatGPT OAuth authorization only while the local CLI
 * has explicitly opened the short setup window. Returning false tells the
 * caller to fall through to the ordinary browser/manual OAuth behavior.
 */
export async function tryHandleLocalChatGptAuthorization(req: Request, res: Response): Promise<boolean> {
  if (req.method !== "GET" || req.path !== "/oauth/authorize") return false;

  const config = loadRuntimeConfig();
  if (
    config.oauthConsentMode !== "paired" ||
    !config.publicChatGptDcr ||
    process.env.PILINK_OAUTH_SETUP_DRIVER === "vscode" ||
    process.env.CI === "true" ||
    process.stdin.isTTY !== true ||
    !isOwnerRegistrationWindowOpen()
  ) {
    return false;
  }

  const responseType = singleQueryValue(req.query.response_type);
  const clientId = singleQueryValue(req.query.client_id);
  const redirectUri = singleQueryValue(req.query.redirect_uri);
  const requestedScope = singleQueryValue(req.query.scope);
  const state = singleQueryValue(req.query.state) ?? "";
  const codeChallenge = singleQueryValue(req.query.code_challenge);
  const codeChallengeMethod = singleQueryValue(req.query.code_challenge_method);

  if (
    responseType !== "code" ||
    !clientId || !CLIENT_ID_PATTERN.test(clientId) ||
    !redirectUri ||
    state.length > 4_096 || UNSAFE_TERMINAL_TEXT.test(state) ||
    !codeChallenge || !CODE_CHALLENGE_PATTERN.test(codeChallenge) ||
    codeChallengeMethod !== "S256"
  ) {
    return false;
  }

  const client = findActiveClient(clientId);
  if (!client || !isApprovedChatGptPublicClient(client, redirectUri)) return false;

  const scope = resolveClientScope(requestedScope, client.scope);
  if (!scope) {
    res.status(400).json({ error: "invalid_scope" });
    return true;
  }

  const approvalRequest: LocalApprovalRequest = {
    client,
    redirectUri,
    scope,
    state,
    codeChallenge,
  };
  const approved = await requestLocalApproval(approvalRequest);
  if (!approved) {
    await setClientDisabled(clientId, true);
    const denied = new URL(redirectUri);
    denied.searchParams.set("error", "access_denied");
    if (state) denied.searchParams.set("state", state);
    res.redirect(303, denied.toString());
    return true;
  }

  const currentClient = findActiveClient(clientId);
  if (!currentClient || effectiveClientTokenVersion(currentClient) !== effectiveClientTokenVersion(client)) {
    res.status(400).json({ error: "invalid_client" });
    return true;
  }

  const code = createAuthorizationCode(
    clientId,
    effectiveClientTokenVersion(currentClient),
    redirectUri,
    scope,
    codeChallenge,
    "S256",
  );
  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  if (state) callback.searchParams.set("state", state);

  closeOwnerRegistrationWindow();
  recordOAuthActivity(clientId, "authorized");
  console.error(`[OAuth] Local owner approved ChatGPT client ${maskClientId(clientId)}; DCR setup window closed.`);
  res.redirect(303, callback.toString());
  return true;
}

export function isApprovedChatGptPublicClient(client: OAuthClient, redirectUri: string): boolean {
  return client.token_endpoint_auth_method === "none" &&
    client.grant_types.includes("authorization_code") &&
    client.redirect_uris.length === 1 &&
    client.redirect_uris[0] === redirectUri &&
    isChatGptConnectorRedirect(redirectUri);
}

export function resolveClientScope(requestedScope: string | undefined, allowedScope: string): string | undefined {
  const allowed = new Set(allowedScope.split(/\s+/u).filter(Boolean));
  const requested = (requestedScope || allowedScope).split(/\s+/u).filter(Boolean);
  if (requested.length === 0 || requested.length > allowed.size) return undefined;
  if (new Set(requested).size !== requested.length) return undefined;
  if (requested.some((scope) => !allowed.has(scope))) return undefined;
  return requested.join(" ");
}

function isChatGptConnectorRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname.toLowerCase() === "chatgpt.com" &&
      !url.username && !url.password && !url.search && !url.hash &&
      /^\/connector\/oauth\/[A-Za-z0-9_-]{6,160}$/u.test(url.pathname);
  } catch {
    return false;
  }
}

async function requestLocalApproval(request: LocalApprovalRequest): Promise<boolean> {
  const fingerprint = [
    request.client.client_id,
    request.redirectUri,
    request.scope,
    request.state,
    request.codeChallenge,
  ].join("\0");

  if (activeApproval) {
    if (activeApprovalFingerprint === fingerprint) return activeApproval;
    console.error("[OAuth] Rejected a second authorization request while another local approval was pending.");
    return false;
  }

  activeApprovalFingerprint = fingerprint;
  activeApproval = promptForApproval(request);
  try {
    return await activeApproval;
  } finally {
    activeApproval = undefined;
    activeApprovalFingerprint = undefined;
  }
}

async function promptForApproval(request: LocalApprovalRequest): Promise<boolean> {
  console.error("\n=== ChatGPT connection request ===");
  console.error(`Client: ${terminalText(request.client.client_name, 120)}`);
  console.error(`Callback: ${terminalText(request.redirectUri, 300)}`);
  console.error(`Access: ${terminalText(request.scope, 256)}`);
  console.error("Approve only if you just initiated this connection in ChatGPT.");

  const readline = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_APPROVAL_TIMEOUT_MS);
  timeout.unref();
  try {
    const answer = (await readline.question("Allow this ChatGPT connection? [y/N]: ", {
      signal: controller.signal,
    })).trim().toLowerCase();
    const approved = answer === "y" || answer === "yes";
    console.error(approved ? "Connection approved." : "Connection denied.");
    return approved;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error("Connection request expired without approval.");
      return false;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    readline.close();
  }
}

function singleQueryValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function terminalText(value: string, maxLength: number): string {
  return value.replace(UNSAFE_TERMINAL_TEXT_GLOBAL, " ").slice(0, maxLength);
}

function maskClientId(clientId: string): string {
  return clientId.length > 8 ? `${clientId.slice(0, 4)}…${clientId.slice(-4)}` : "••••";
}
