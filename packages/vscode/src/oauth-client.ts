import { createHash } from "node:crypto";
import type * as vscode from "vscode";
import type { ConfigSnapshot } from "./configuration.js";
import { localServerUrl } from "./configuration.js";
import { CredentialVault, type CredentialField, type ExternalCredentialSummary } from "./credential-vault.js";
import { readAuthenticatedHealth } from "./health.js";

export type McpScope = "mcp:read" | "mcp:write" | "mcp:tools";

export interface RegisteredClient {
  client_id: string;
  client_secret: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  scope: string;
  token_endpoint_auth_method: "client_secret_post" | "client_secret_basic" | "none";
}

interface NativeCredentials {
  schemaVersion: 2;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  scope: McpScope;
  approvedScope?: McpScope;
  configPath: string;
}

export class OAuthClientService {
  private readonly externalVault: CredentialVault;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.externalVault = new CredentialVault(secrets);
  }

  async hasNativeCredentials(configPath: string): Promise<boolean> {
    return Boolean(await this.readNativeCredentials(configPath));
  }

  async storedNativeToken(configPath: string, scope?: McpScope): Promise<string | undefined> {
    const credentials = await this.readNativeCredentials(configPath);
    if (!credentials?.approvedScope) return undefined;
    if (scope && credentials.approvedScope !== scope) return undefined;
    return credentials.accessToken;
  }

  async approvedNativeScope(configPath: string): Promise<McpScope | undefined> {
    return (await this.readNativeCredentials(configPath))?.approvedScope;
  }

  async connectNative(snapshot: ConfigSnapshot, scope: McpScope): Promise<string> {
    return this.issueNativeToken(snapshot, scope, true);
  }

  async refreshNative(snapshot: ConfigSnapshot, scope: McpScope): Promise<string> {
    const credentials = await this.readNativeCredentials(snapshot.configPath);
    if (!credentials || credentials.approvedScope !== scope) {
      throw new Error(`The ${scope} scope was not approved. Run “Connect to VS Code Agents” from the VSPiLink sidebar.`);
    }
    return this.issueNativeToken(snapshot, scope, false, credentials);
  }

  private async issueNativeToken(
    snapshot: ConfigSnapshot,
    scope: McpScope,
    approveScope: boolean,
    existingCredentials?: NativeCredentials,
  ): Promise<string> {
    let credentials = existingCredentials || await this.readNativeCredentials(snapshot.configPath);
    if (!credentials) {
      const registered = await this.registerClient(snapshot, {
        clientName: "VSPiLink for VS Code",
        grantTypes: ["client_credentials"],
        redirectUris: [],
        allowedScope: "mcp:tools mcp:read mcp:write",
        tokenEndpointAuthMethod: "client_secret_post",
      });
      credentials = {
        schemaVersion: 2,
        clientId: registered.client_id,
        clientSecret: registered.client_secret,
        accessToken: "",
        scope,
        ...(approveScope ? { approvedScope: scope } : {}),
        configPath: snapshot.configPath,
      };
    }
    let accessToken: string;
    try {
      accessToken = await this.requestClientCredentialsToken(
        snapshot,
        credentials.clientId,
        credentials.clientSecret,
        scope,
      );
    } catch (error) {
      if (!(error instanceof OAuthProtocolError) || error.code !== "invalid_client") throw error;
      const registered = await this.registerClient(snapshot, {
        clientName: "VSPiLink for VS Code",
        grantTypes: ["client_credentials"],
        redirectUris: [],
        allowedScope: "mcp:tools mcp:read mcp:write",
        tokenEndpointAuthMethod: "client_secret_post",
      });
      credentials = {
        schemaVersion: 2,
        clientId: registered.client_id,
        clientSecret: registered.client_secret,
        accessToken: "",
        scope,
        ...(approveScope || credentials.approvedScope ? { approvedScope: approveScope ? scope : credentials.approvedScope } : {}),
        configPath: snapshot.configPath,
      };
      accessToken = await this.requestClientCredentialsToken(snapshot, credentials.clientId, credentials.clientSecret, scope);
    }
    const approvedScope = approveScope ? scope : credentials.approvedScope;
    const updated: NativeCredentials = {
      ...credentials,
      schemaVersion: 2,
      accessToken,
      scope,
      ...(approvedScope ? { approvedScope } : {}),
      configPath: snapshot.configPath,
    };
    await this.secrets.store(secretKey(snapshot.configPath), JSON.stringify(updated));
    return accessToken;
  }

  async disconnectNative(configPath: string): Promise<void> {
    await this.secrets.delete(secretKey(configPath));
  }

  async registerExternalClient(snapshot: ConfigSnapshot, options: {
    clientName: string;
    grantTypes: string[];
    redirectUris: string[];
    allowedScope: string;
    tokenEndpointAuthMethod?: "client_secret_post" | "client_secret_basic" | "none";
  }): Promise<ExternalCredentialSummary> {
    const registered = await this.registerClient(snapshot, {
      ...options,
      tokenEndpointAuthMethod: options.tokenEndpointAuthMethod || "client_secret_post",
    });
    try {
      return await this.externalVault.store({
        schemaVersion: 1,
        configPath: snapshot.configPath,
        clientId: registered.client_id,
        clientSecret: registered.client_secret,
        clientName: registered.client_name,
        redirectUris: [...registered.redirect_uris],
        grantTypes: [...registered.grant_types],
        scope: registered.scope,
        tokenEndpointAuthMethod: registered.token_endpoint_auth_method,
        createdAt: new Date().toISOString(),
      });
    } catch (storageError) {
      try {
        await this.deleteExternalClient(snapshot, registered.client_id);
      } catch {
        // Preserve the SecretStorage failure; the server record contains only a bcrypt secret hash.
      }
      throw storageError;
    }
  }

  async deleteExternalClient(snapshot: ConfigSnapshot, clientId: string): Promise<void> {
    if (!/^[A-Za-z0-9._~-]{1,256}$/.test(clientId)) throw new Error("Invalid OAuth client identifier.");
    if (!snapshot.bootstrapSecret || snapshot.bootstrapSecret.length < 32) {
      throw new Error("PI_BOOTSTRAP_SECRET is missing or invalid.");
    }
    await this.assertAuthenticatedServer(snapshot);
    const response = await fetch(`${localServerUrl(snapshot)}/admin/oauth/clients/${encodeURIComponent(clientId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${snapshot.bootstrapSecret}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await safeJson(response);
    if (!response.ok) throw protocolError(payload, `OAuth revocation failed (HTTP ${response.status})`);
    await this.externalVault.delete(snapshot.configPath, clientId);
  }

  async externalCredentialValue(
    configPath: string,
    clientId: string,
    field: CredentialField,
  ): Promise<string | undefined> {
    return this.externalVault.value(configPath, clientId, field);
  }

  async latestExternalClient(configPath: string): Promise<ExternalCredentialSummary | undefined> {
    return this.externalVault.summary(configPath);
  }

  private async registerClient(snapshot: ConfigSnapshot, options: {
    clientName: string;
    grantTypes: string[];
    redirectUris: string[];
    allowedScope: string;
    tokenEndpointAuthMethod: "client_secret_post" | "client_secret_basic" | "none";
  }): Promise<RegisteredClient> {
    if (!snapshot.bootstrapSecret || snapshot.bootstrapSecret.length < 32) {
      throw new Error("PI_BOOTSTRAP_SECRET is missing or invalid. Initialize VSPiLink first.");
    }
    await this.assertAuthenticatedServer(snapshot);
    const response = await fetch(`${localServerUrl(snapshot)}/oauth/register`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${snapshot.bootstrapSecret}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_name: options.clientName,
        redirect_uris: options.redirectUris,
        grant_types: options.grantTypes,
        scope: options.allowedScope,
        token_endpoint_auth_method: options.tokenEndpointAuthMethod,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await safeJson(response);
    if (!response.ok) throw protocolError(payload, `OAuth registration failed (HTTP ${response.status})`);
    if (!isRegisteredClient(payload)) throw new Error("Invalid OAuth registration response.");
    return {
      ...payload,
      token_endpoint_auth_method: payload.token_endpoint_auth_method || options.tokenEndpointAuthMethod,
    };
  }

  private async requestClientCredentialsToken(
    snapshot: ConfigSnapshot,
    clientId: string,
    clientSecret: string,
    scope: McpScope,
  ): Promise<string> {
    await this.assertAuthenticatedServer(snapshot);
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    });
    const response = await fetch(`${localServerUrl(snapshot)}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await safeJson(response);
    if (!response.ok) throw protocolError(payload, `OAuth token request failed (HTTP ${response.status})`);
    if (!payload || typeof payload !== "object" || typeof (payload as Record<string, unknown>).access_token !== "string") {
      throw new Error("Invalid OAuth token response.");
    }
    return (payload as Record<string, string>).access_token;
  }

  private async assertAuthenticatedServer(snapshot: ConfigSnapshot): Promise<void> {
    if (!snapshot.bootstrapSecret || snapshot.bootstrapSecret.length < 32) {
      throw new Error("PI_BOOTSTRAP_SECRET is missing or invalid. Initialize VSPiLink first.");
    }
    const health = await readAuthenticatedHealth(snapshot.port, snapshot.bootstrapSecret);
    if (!health.online) {
      throw new Error(`The local PiLink server identity could not be verified: ${health.error || "health proof missing"}`);
    }
  }

  private async readNativeCredentials(configPath: string): Promise<NativeCredentials | undefined> {
    const raw = await this.secrets.get(secretKey(configPath));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<NativeCredentials>;
      if (
        typeof parsed.clientId !== "string" ||
        typeof parsed.clientSecret !== "string" ||
        typeof parsed.accessToken !== "string" ||
        typeof parsed.configPath !== "string" ||
        parsed.configPath !== configPath ||
        !isMcpScope(parsed.scope)
      ) return undefined;
      const approvedScope = parsed.schemaVersion === 2 && isMcpScope(parsed.approvedScope)
        ? parsed.approvedScope
        : parsed.schemaVersion === undefined && parsed.scope === "mcp:read"
          ? "mcp:read"
          : undefined;
      return {
        schemaVersion: 2,
        clientId: parsed.clientId,
        clientSecret: parsed.clientSecret,
        accessToken: parsed.accessToken,
        scope: parsed.scope,
        ...(approvedScope ? { approvedScope } : {}),
        configPath: parsed.configPath,
      };
    } catch {
      return undefined;
    }
  }
}

export function isMcpScope(value: unknown): value is McpScope {
  return value === "mcp:read" || value === "mcp:write" || value === "mcp:tools";
}

function secretKey(configPath: string): string {
  return `vspilink.nativeMcp.${createHash("sha256").update(configPath).digest("hex")}`;
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 256 * 1024) throw new Error("The OAuth response is too large.");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function oauthError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  return typeof record.error_description === "string"
    ? record.error_description
    : typeof record.error === "string" ? record.error : fallback;
}

function protocolError(payload: unknown, fallback: string): OAuthProtocolError {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  return new OAuthProtocolError(
    typeof record.error === "string" ? record.error : "oauth_error",
    oauthError(payload, fallback),
  );
}

class OAuthProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OAuthProtocolError";
  }
}

function isRegisteredClient(value: unknown): value is RegisteredClient {
  if (!value || typeof value !== "object") return false;
  const client = value as Record<string, unknown>;
  return typeof client.client_id === "string" &&
    typeof client.client_secret === "string" &&
    typeof client.client_name === "string" &&
    Array.isArray(client.redirect_uris) &&
    Array.isArray(client.grant_types) &&
    typeof client.scope === "string" &&
    (client.token_endpoint_auth_method === undefined || client.token_endpoint_auth_method === "client_secret_post" || client.token_endpoint_auth_method === "client_secret_basic" || client.token_endpoint_auth_method === "none");
}
