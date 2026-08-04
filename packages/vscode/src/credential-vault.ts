import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { CloudflareAuthKind } from "./hosting-model.js";

export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface ExternalCredentials {
  schemaVersion: 1;
  configPath: string;
  clientId: string;
  clientSecret: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  scope: string;
  tokenEndpointAuthMethod: "client_secret_post" | "client_secret_basic" | "none";
  createdAt: string;
}

export type CredentialField = "clientId" | "clientSecret";

export interface ExternalCredentialSummary {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  scope: string;
  tokenEndpointAuthMethod: ExternalCredentials["tokenEndpointAuthMethod"];
  createdAt: string;
  hasSecret: true;
}

export class CredentialVault {
  constructor(private readonly secrets: SecretStorageLike) {}

  async store(credentials: ExternalCredentials): Promise<ExternalCredentialSummary> {
    validateCredentials(credentials);
    const recordKey = credentialKey(credentials.configPath, credentials.clientId);
    await this.secrets.store(recordKey, JSON.stringify(credentials));
    await this.secrets.store(latestKey(credentials.configPath), credentials.clientId);
    return summarize(credentials);
  }

  async get(configPath: string, clientId: string): Promise<ExternalCredentials | undefined> {
    const raw = await this.secrets.get(credentialKey(configPath, clientId));
    return parseCredentials(raw, configPath, clientId);
  }

  async latest(configPath: string): Promise<ExternalCredentials | undefined> {
    const clientId = await this.secrets.get(latestKey(configPath));
    if (!clientId) return undefined;
    return this.get(configPath, clientId);
  }

  async summary(configPath: string, clientId?: string): Promise<ExternalCredentialSummary | undefined> {
    const credentials = clientId ? await this.get(configPath, clientId) : await this.latest(configPath);
    return credentials ? summarize(credentials) : undefined;
  }

  async value(configPath: string, clientId: string, field: CredentialField): Promise<string | undefined> {
    const credentials = await this.get(configPath, clientId);
    if (!credentials) return undefined;
    return field === "clientId" ? credentials.clientId : credentials.clientSecret;
  }

  async delete(configPath: string, clientId: string): Promise<void> {
    await this.secrets.delete(credentialKey(configPath, clientId));
    const latest = await this.secrets.get(latestKey(configPath));
    if (latest === clientId) await this.secrets.delete(latestKey(configPath));
  }
}

export interface CloudflareCredentialSummary {
  reference: string;
  kind: CloudflareAuthKind;
  label: string;
}

interface CloudflareCredentialRecord extends CloudflareCredentialSummary {
  schemaVersion: 1;
  filePath: string;
}

export class CloudflareCredentialVault {
  constructor(private readonly secrets: SecretStorageLike) {}

  async store(kind: CloudflareAuthKind, filePath: string): Promise<CloudflareCredentialSummary> {
    const resolved = path.resolve(filePath);
    if (!path.isAbsolute(resolved) || /[\r\n\0]/.test(resolved)) throw new Error("Invalid Cloudflare credential path.");
    const record: CloudflareCredentialRecord = {
      schemaVersion: 1,
      reference: randomUUID(),
      kind,
      label: path.basename(resolved).slice(0, 160),
      filePath: resolved,
    };
    await this.secrets.store(cloudflareCredentialKey(record.reference), JSON.stringify(record));
    return { reference: record.reference, kind: record.kind, label: record.label };
  }

  async get(summary: CloudflareCredentialSummary): Promise<{ kind: CloudflareAuthKind; filePath: string } | undefined> {
    const raw = await this.secrets.get(cloudflareCredentialKey(summary.reference));
    if (!raw) return undefined;
    try {
      const record = JSON.parse(raw) as CloudflareCredentialRecord;
      if (
        record.schemaVersion !== 1 || record.reference !== summary.reference || record.kind !== summary.kind ||
        typeof record.filePath !== "string" || !path.isAbsolute(record.filePath) || /[\r\n\0]/.test(record.filePath)
      ) return undefined;
      return { kind: record.kind, filePath: record.filePath };
    } catch {
      return undefined;
    }
  }

  async delete(reference: string): Promise<void> {
    await this.secrets.delete(cloudflareCredentialKey(reference));
  }
}

function summarize(credentials: ExternalCredentials): ExternalCredentialSummary {
  return {
    clientId: credentials.clientId,
    clientName: credentials.clientName,
    redirectUris: [...credentials.redirectUris],
    grantTypes: [...credentials.grantTypes],
    scope: credentials.scope,
    tokenEndpointAuthMethod: credentials.tokenEndpointAuthMethod,
    createdAt: credentials.createdAt,
    hasSecret: true,
  };
}

function parseCredentials(raw: string | undefined, configPath: string, clientId: string): ExternalCredentials | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as ExternalCredentials;
    validateCredentials(parsed);
    if (parsed.configPath !== configPath || parsed.clientId !== clientId) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function validateCredentials(value: ExternalCredentials): void {
  if (
    !value || value.schemaVersion !== 1 || typeof value.configPath !== "string" ||
    typeof value.clientId !== "string" || !value.clientId || typeof value.clientSecret !== "string" || !value.clientSecret ||
    typeof value.clientName !== "string" || !Array.isArray(value.redirectUris) ||
    !value.redirectUris.every((entry) => typeof entry === "string") || !Array.isArray(value.grantTypes) ||
    !value.grantTypes.every((entry) => typeof entry === "string") || typeof value.scope !== "string" ||
    !["client_secret_post", "client_secret_basic", "none"].includes(value.tokenEndpointAuthMethod) ||
    typeof value.createdAt !== "string"
  ) throw new Error("Invalid external OAuth credentials.");
}

function configHash(configPath: string): string {
  return createHash("sha256").update(configPath).digest("hex");
}

export function credentialKey(configPath: string, clientId: string): string {
  return `vspilink.externalOAuth.${configHash(configPath)}.${createHash("sha256").update(clientId).digest("hex")}`;
}

export function latestKey(configPath: string): string {
  return `vspilink.externalOAuth.latest.${configHash(configPath)}`;
}

export function cloudflareCredentialKey(reference: string): string {
  return `vspilink.cloudflareCredential.${createHash("sha256").update(reference).digest("hex")}`;
}
