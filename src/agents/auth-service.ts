import {
  getAgentDir,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { preparePrivateAgentAuthStore, securePrivateAgentAuthFile } from "./auth-store-security.js";

const IDENTIFIER = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const MAX_PROVIDERS = 256;
const MAX_MODELS = 5_000;

export type AgentAuthType = "oauth" | "api_key";

export type AgentAuthPrompt = Readonly<{
  signal?: AbortSignal;
}> & (
  | Readonly<{ type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }>
  | Readonly<{
      type: "select";
      message: string;
      options: readonly Readonly<{ id: string; label: string; description?: string }>[];
    }>
);

export type AgentAuthEvent =
  | Readonly<{ type: "info" | "progress"; message: string; links?: readonly Readonly<{ url: string; label?: string }>[] }>
  | Readonly<{ type: "auth_url"; url: string; instructions?: string }>
  | Readonly<{
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }>;

export interface AgentAuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: AgentAuthPrompt): Promise<string>;
  notify(event: AgentAuthEvent): void;
}

export interface AgentModelSummary {
  id: string;
  name: string;
  providerId: string;
  reasoning: boolean;
  input: readonly ("text" | "image")[];
  contextWindow: number;
}

export interface AgentProviderSummary {
  id: string;
  name: string;
  authTypes: readonly AgentAuthType[];
  oauthLabel?: string;
  configuredAuthType?: AgentAuthType;
  models: readonly AgentModelSummary[];
}

export interface AgentAuthCatalog {
  agentDir: string;
  providers: readonly AgentProviderSummary[];
}

export interface AgentProviderLoginOptions {
  providerId: string;
  authType: AgentAuthType;
  interaction: AgentAuthInteraction;
  agentDir?: string;
}

export interface AgentProviderLoginResult {
  providerId: string;
  authType: AgentAuthType;
  configured: true;
  models: readonly AgentModelSummary[];
}

/**
 * Side-effect-free provider/model discovery for the VS Code wizard.
 *
 * Credentials are represented only by provider id and auth type. Access keys,
 * OAuth access/refresh tokens, account identifiers, headers and base URLs are
 * never returned to the caller.
 */
export async function inspectAgentAuth(agentDir = getAgentDir()): Promise<AgentAuthCatalog> {
  const { agentDir: privateAgentDir, authPath } = await preparePrivateAgentAuthStore(agentDir);
  const runtime = await createOfflineRuntime(privateAgentDir);
  await securePrivateAgentAuthFile(authPath, true);
  const credentials = new Map(
    (await runtime.listCredentials()).map((entry) => [entry.providerId, entry.type as AgentAuthType]),
  );
  const providers = runtime.getProviders().slice(0, MAX_PROVIDERS).flatMap((provider) => {
    const authTypes: AgentAuthType[] = [];
    if (provider.auth.oauth) authTypes.push("oauth");
    if (provider.auth.apiKey?.login) authTypes.push("api_key");
    if (authTypes.length === 0) return [];
    const configuredAuthType = credentials.get(provider.id);
    return [{
      id: provider.id,
      name: boundedText(provider.name, 200),
      authTypes: Object.freeze(authTypes),
      ...(provider.auth.oauth?.loginLabel || provider.auth.oauth?.name
        ? { oauthLabel: boundedText(provider.auth.oauth.loginLabel ?? provider.auth.oauth.name, 300) }
        : {}),
      ...(configuredAuthType ? { configuredAuthType } : {}),
      models: Object.freeze(runtime.getModels(provider.id).slice(0, MAX_MODELS).map(publicModel)),
    }];
  });
  return { agentDir: privateAgentDir, providers: Object.freeze(providers) };
}

/** Run a provider-owned OAuth/API-key flow and persist it in auth.json (0600). */
export async function loginAgentProvider(options: AgentProviderLoginOptions): Promise<AgentProviderLoginResult> {
  if (!IDENTIFIER.test(options.providerId)) throw new Error("Agent provider id is invalid");
  if (options.authType !== "oauth" && options.authType !== "api_key") {
    throw new Error("Agent authentication type is invalid");
  }
  if (!options.interaction || typeof options.interaction.prompt !== "function" || typeof options.interaction.notify !== "function") {
    throw new Error("Agent authentication interaction is required");
  }
  const { agentDir: privateAgentDir, authPath } = await preparePrivateAgentAuthStore(options.agentDir ?? getAgentDir());
  const runtime = await createOfflineRuntime(privateAgentDir);
  await securePrivateAgentAuthFile(authPath);
  const provider = runtime.getProvider(options.providerId);
  if (!provider) throw new Error("Agent provider is unavailable");
  if (options.authType === "oauth" && !provider.auth.oauth) throw new Error("Agent provider does not support OAuth");
  if (options.authType === "api_key" && !provider.auth.apiKey?.login) {
    throw new Error("Agent provider does not support API-key login");
  }
  await runtime.login(options.providerId, options.authType, options.interaction as Parameters<ModelRuntime["login"]>[2]);
  await securePrivateAgentAuthFile(authPath);
  const auth = await runtime.checkAuth(options.providerId);
  if (!auth) throw new Error("Agent provider login did not produce usable credentials");
  return {
    providerId: options.providerId,
    authType: options.authType,
    configured: true,
    models: Object.freeze(runtime.getModels(options.providerId).slice(0, MAX_MODELS).map(publicModel)),
  };
}

export async function logoutAgentProvider(providerId: string, agentDir = getAgentDir()): Promise<void> {
  if (!IDENTIFIER.test(providerId)) throw new Error("Agent provider id is invalid");
  const { agentDir: privateAgentDir, authPath } = await preparePrivateAgentAuthStore(agentDir);
  const runtime = await createOfflineRuntime(privateAgentDir);
  await securePrivateAgentAuthFile(authPath);
  if (!runtime.getProvider(providerId)) throw new Error("Agent provider is unavailable");
  await runtime.logout(providerId);
  await securePrivateAgentAuthFile(authPath);
}

async function createOfflineRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
}

function publicModel(model: ReturnType<ModelRuntime["getModels"]>[number]): AgentModelSummary {
  return {
    id: model.id,
    name: boundedText(model.name, 200),
    providerId: String(model.provider),
    reasoning: model.reasoning,
    input: Object.freeze([...model.input]),
    contextWindow: model.contextWindow,
  };
}

function boundedText(value: string, maxBytes: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu, " ").trim();
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
  return Buffer.from(normalized, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}
