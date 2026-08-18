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
  operation: string;
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
  version: string;
  nodeVersion: string;
  error?: string;
}
