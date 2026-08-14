import type { CredentialField } from "./credential-vault.js";
import type { ChatGptDestination } from "./chatgpt-links.js";
import { CHATGPT_DESTINATIONS } from "./chatgpt-links.js";
import type { CloudflareAuthKind, HostingSelection } from "./hosting-model.js";
import { CLOUDFLARE_AUTH_KINDS, normalizeHostingSelection } from "./hosting-model.js";
import type { WizardAccessMode, WizardViewState } from "./wizard-state.js";
import type { RuntimeMode } from "./runtime-mode.js";

export const WEBVIEW_COMMANDS = [
  "selectRuntimeMode",
  "refresh",
  "manageTrust",
  "connectChatGpt",
  "openChatGpt",
  "setupChat",
  "sendChat",
  "cancelChat",
  "newChat",
  "initialize",
  "start",
  "startUnsafe",
  "guidedSetup",
  "legacySetup",
  "serve",
  "stop",
  "restart",
  "openConfig",
  "copyMcpUrl",
  "registerClient",
  "connectNativeMcp",
  "disconnectNativeMcp",
  "openTerminal",
  "openCollaborationMonitor",
  "openPanel",
  "reset",
  "useWorkspace",
  "sendInput",
  "openDocs",
  "configureAgents",
  "logoutAgent",
  "spawnAgent",
  "stopAgent",
  "viewAgentOutput",
] as const;

export type WebviewCommand = (typeof WEBVIEW_COMMANDS)[number];

export interface LegacyWebviewCommandMessage {
  type: "command";
  command: WebviewCommand;
  value?: string;
}

export const WIZARD_ACTIONS = [
  "open",
  "acceptWorkspace",
  "chooseWorkspace",
  "chooseCloudflareCredential",
  "configureAndStart",
  "openChatGpt",
  "confirmDeveloperMode",
  "submitCallback",
  "copyCredential",
  "finish",
  "dismiss",
  "retry",
] as const;

export type WizardAction = (typeof WIZARD_ACTIONS)[number];
export type WizardCopyField = CredentialField | "authorizationUrl" | "tokenUrl" | "mcpUrl";

interface WizardMessageBase {
  type: "wizard";
  action: WizardAction;
  requestId: string;
}

export type WizardWebviewMessage =
  | (WizardMessageBase & { action: "open" | "acceptWorkspace" | "chooseWorkspace" | "confirmDeveloperMode" | "finish" | "dismiss" | "retry" })
  | (WizardMessageBase & { action: "chooseCloudflareCredential"; credentialKind: CloudflareAuthKind })
  | (WizardMessageBase & { action: "configureAndStart"; hosting: HostingSelection; accessMode: WizardAccessMode })
  | (WizardMessageBase & { action: "openChatGpt"; destination: ChatGptDestination })
  | (WizardMessageBase & { action: "submitCallback"; callbackUrl: string })
  | (WizardMessageBase & { action: "copyCredential"; field: WizardCopyField });

export type WebviewCommandMessage = LegacyWebviewCommandMessage | WizardWebviewMessage;

export function parseWebviewMessage(value: unknown): WebviewCommandMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "command") return parseLegacyMessage(candidate);
  if (candidate.type === "wizard") return parseWizardMessage(candidate);
  return undefined;
}

function parseLegacyMessage(candidate: Record<string, unknown>): LegacyWebviewCommandMessage | undefined {
  if (typeof candidate.command !== "string" || !(WEBVIEW_COMMANDS as readonly string[]).includes(candidate.command)) return undefined;
  if (candidate.value !== undefined && typeof candidate.value !== "string") return undefined;
  if (candidate.command === "selectRuntimeMode" && candidate.value !== "single" && candidate.value !== "collaboration") return undefined;
  const valueLimit = candidate.command === "sendChat" ? 65_536 : 16_384;
  if (typeof candidate.value === "string" && candidate.value.length > valueLimit) return undefined;
  return {
    type: "command",
    command: candidate.command as WebviewCommand,
    ...(typeof candidate.value === "string" ? { value: candidate.value } : {}),
  };
}

function parseWizardMessage(candidate: Record<string, unknown>): WizardWebviewMessage | undefined {
  if (
    typeof candidate.action !== "string" || !(WIZARD_ACTIONS as readonly string[]).includes(candidate.action) ||
    typeof candidate.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(candidate.requestId)
  ) return undefined;
  const base = { type: "wizard" as const, action: candidate.action as WizardAction, requestId: candidate.requestId };
  switch (base.action) {
    case "open":
    case "acceptWorkspace":
    case "chooseWorkspace":
    case "confirmDeveloperMode":
    case "finish":
    case "dismiss":
    case "retry":
      return base as WizardWebviewMessage;
    case "chooseCloudflareCredential":
      if (typeof candidate.credentialKind !== "string" || !(CLOUDFLARE_AUTH_KINDS as readonly string[]).includes(candidate.credentialKind)) return undefined;
      return { ...base, action: "chooseCloudflareCredential", credentialKind: candidate.credentialKind as CloudflareAuthKind };
    case "configureAndStart": {
      const hosting = normalizeHostingSelection(candidate.hosting);
      if (!hosting || (candidate.accessMode !== "workspace" && candidate.accessMode !== "full")) return undefined;
      return { ...base, action: "configureAndStart", hosting, accessMode: candidate.accessMode };
    }
    case "openChatGpt":
      if (typeof candidate.destination !== "string" || !(CHATGPT_DESTINATIONS as readonly string[]).includes(candidate.destination)) return undefined;
      return { ...base, action: "openChatGpt", destination: candidate.destination as ChatGptDestination };
    case "submitCallback":
      if (typeof candidate.callbackUrl !== "string" || !candidate.callbackUrl.trim() || candidate.callbackUrl.length > 2_048) return undefined;
      return { ...base, action: "submitCallback", callbackUrl: candidate.callbackUrl.trim() };
    case "copyCredential":
      if (!['clientId', 'clientSecret', 'authorizationUrl', 'tokenUrl', 'mcpUrl'].includes(String(candidate.field))) return undefined;
      return { ...base, action: "copyCredential", field: candidate.field as WizardCopyField };
  }
}

export type ProcessStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export interface ProcessViewState {
  status: ProcessStatus;
  mode?: string;
  pid?: number;
  startedAt?: string;
  awaitingInput: boolean;
}

export interface PublicClientSummary {
  id: string;
  name: string;
  grantTypes: string[];
  scope: string;
  createdAt: string;
  /** True only when the persisted redirect belongs to ChatGPT. */
  chatGpt: boolean;
  /** True when a non-expired refresh token proves OAuth completed. */
  authorized: boolean;
}

export interface DashboardState {
  runtimeMode: {
    mode: RuntimeMode;
    /** True once the user has deliberately chosen a workflow. */
    configured: boolean;
  };
  configured: boolean;
  trusted: boolean;
  workspace: string;
  configPath: string;
  process: ProcessViewState;
  health: Record<string, unknown> | null;
  hostingMode: string;
  unsafeFullAccess: boolean;
  fullAccessClientCount: number;
  mcpUrl: string;
  publicUrl: string;
  oauthEndpoints: {
    authorization: string;
    token: string;
    registration: string;
  };
  clients: PublicClientSummary[];
  logs: string[];
  nativeMcp: {
    connected: boolean;
    scope: string;
  };
  externalMcp: {
    /** A ChatGPT OAuth client is present in the private persistent store. */
    configured: boolean;
    /** OAuth completed and remains recoverable across server restarts. */
    authorized: boolean;
    /** The current server process has observed an initialized MCP client. */
    active: boolean;
    /** Backwards-compatible aggregate: authorized or active. */
    connected: boolean;
    activeSessions: number;
  };
  collaboration: {
    available: boolean;
    latestCursor: number;
    messages: Array<{
      cursor: number;
      agentId: string;
      agentInstanceId: string;
      agentName: string;
      message: string;
    }>;
    tasks: Array<{
      taskId: string;
      title: string;
      details?: string;
      status: string;
      statusMessage?: string;
      artifact?: string;
      createdBy: string;
      owner?: string;
      leaseExpiresAt?: string;
      createdAt?: string;
      updatedAt?: string;
      revision: number;
    }>;
    activity: Array<{
      tool: string;
      startedAt: string;
      durationMs: number;
      outcome: "success" | "error";
      accessMode: "workspace" | "full-access";
      clientId?: string;
      exitCode?: number | null;
      timedOut?: boolean;
      cancelled?: boolean;
    }>;
    clients: Array<{
      clientId: string;
      activeMcpSessions: number;
      registeredAt?: string;
      authorizedAt?: string;
      tokenIssuedAt?: string;
      refreshedAt?: string;
      mcpInitializedAt?: string;
    }>;
    error?: string;
  };
  managedHosting: {
    configured: boolean;
    productionReady: boolean;
    serverState: string;
    tunnelState: string;
    enableState: string;
    publicUrl?: string;
    landingUrl?: string;
    error?: string;
  };
  agentRuntime: {
    state: string;
    runtimeState: string;
    coordinationState: string;
    active: number;
    retained: number;
    maxConcurrent: number;
    byStatus: Record<string, number>;
    selectedProvider?: string;
    selectedModel?: string;
    selectedProviderName?: string;
    selectedModelName?: string;
    configuredAuthType?: string;
    authReady: boolean;
    catalogAvailable: boolean;
    authBusy: boolean;
    agents: Array<{
      agentId: string;
      role: string;
      label?: string;
      status: string;
      hasError: boolean;
      updatedAt?: string;
    }>;
    error?: string;
  };
  chat: {
    agentId?: string;
    status: string;
    busy: boolean;
    messages: Array<{
      cursor: number;
      role: "user" | "assistant" | "status";
      text: string;
      createdAt?: string;
    }>;
    error?: string;
  };
  wizard: WizardViewState;
  version: string;
  nodeVersion: string;
  error?: string;
}
