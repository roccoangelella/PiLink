import type { CredentialField } from "./credential-vault.js";
import type { ChatGptDestination } from "./chatgpt-links.js";
import type { CloudflareAuthKind, HostingSelection } from "./hosting-model.js";
import type { WizardAccessMode } from "./wizard-state.js";
import type { RuntimeMode } from "./runtime-mode.js";

/** Commands accepted from the focused launcher webview. */
export const WEBVIEW_COMMANDS = [
  "refresh",
  "manageTrust",
  "chooseWorkspace",
  "setupStable",
  "setupQuick",
  "setupLocal",
  "connectChatGpt",
  "openChatGpt",
  "start",
  "stop",
  "restart",
  "reconfigure",
  "openConfig",
  "copyMcpUrl",
  "openTerminal",
  "openPanel",
  "openDocs",
  "switchToSingle",
] as const;

export type WebviewCommand = (typeof WEBVIEW_COMMANDS)[number];

export interface WebviewCommandMessage {
  type: "command";
  command: WebviewCommand;
}

export function parseWebviewMessage(value: unknown): WebviewCommandMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "command" || typeof candidate.command !== "string") return undefined;
  if (!(WEBVIEW_COMMANDS as readonly string[]).includes(candidate.command)) return undefined;
  return { type: "command", command: candidate.command as WebviewCommand };
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
  chatGpt: boolean;
  authorized: boolean;
}

export interface DashboardState {
  configured: boolean;
  trusted: boolean;
  workspace: string;
  configPath: string;
  process: ProcessViewState;
  hostingMode: string;
  runtimeMode: RuntimeMode;
  unsafeFullAccess: boolean;
  mcpUrl: string;
  publicUrl: string;
  externalMcp: {
    configured: boolean;
    authorized: boolean;
    active: boolean;
    connected: boolean;
    activeSessions: number;
  };
  activity: Array<{
    tool: string;
    startedAt: string;
    durationMs: number;
    outcome: "success" | "error";
  }>;
  version: string;
  nodeVersion: string;
  error?: string;
}

/*
 * Compatibility-only wizard types. The launcher no longer routes wizard
 * messages, but the dormant legacy controller modules still compile against
 * these exports so older code can be removed independently.
 */
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
