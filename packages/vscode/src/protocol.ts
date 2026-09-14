import type { RuntimeMode } from "./runtime-mode.js";
import type { CollaborationDashboardState } from "./collaboration-model.js";

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
  "createTask",
  "provideTaskInput",
  "cancelTask",
] as const;

export type WebviewCommand = (typeof WEBVIEW_COMMANDS)[number];

export interface WebviewCommandMessage {
  type: "command";
  command: WebviewCommand;
  taskId?: string;
  revision?: number;
}

const TASK_MUTATION_COMMANDS = new Set<WebviewCommand>(["provideTaskInput", "cancelTask"]);
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;

export function parseWebviewMessage(value: unknown): WebviewCommandMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "command" || typeof candidate.command !== "string") return undefined;
  if (!(WEBVIEW_COMMANDS as readonly string[]).includes(candidate.command)) return undefined;
  const command = candidate.command as WebviewCommand;
  if (!TASK_MUTATION_COMMANDS.has(command)) return { type: "command", command };
  if (typeof candidate.taskId !== "string" || !TASK_ID_PATTERN.test(candidate.taskId)) return undefined;
  if (!Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 1) return undefined;
  return { type: "command", command, taskId: candidate.taskId, revision: Number(candidate.revision) };
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
  collaboration?: CollaborationDashboardState;
  version: string;
  nodeVersion: string;
  error?: string;
}
