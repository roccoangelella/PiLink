import type { AgentRoleAssignment } from "./roles.js";

export const AGENT_PERMISSIONS = [
  "coordination:read",
  "coordination:write",
  "workspace:read",
  "workspace:write",
  "process:execute",
  "network:outbound",
] as const;

export type AgentPermission = typeof AGENT_PERMISSIONS[number];

export const AGENT_STATUSES = [
  "starting",
  "running",
  "waiting",
  "cancelling",
  "stopping",
  "stop_failed",
  "completed",
  "failed",
  "stopped",
] as const;

export type AgentStatus = typeof AGENT_STATUSES[number];
export type ActiveAgentStatus = Exclude<AgentStatus, "completed" | "failed" | "stopped">;

export interface AgentSpawnRequest {
  /** Authenticated controller identity. Never exposed in public snapshots. */
  controllerId: string;
  runtimeId: string;
  role: AgentRoleAssignment;
  workspace: string;
  permissions: readonly AgentPermission[];
  initialMessage: string;
  taskId?: string;
  label?: string;
}

export interface AgentSnapshot {
  agentId: string;
  runtimeId: string;
  runtimeAgentId?: string;
  role: AgentRoleAssignment;
  workspace: string;
  permissions: readonly AgentPermission[];
  taskId?: string;
  label?: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
  revision: number;
}

export interface AgentOutputEntry {
  cursor: number;
  channel: "user" | "assistant" | "status" | "stderr";
  text: string;
  createdAt: string;
}

export interface AgentOutputReadResult {
  entries: AgentOutputEntry[];
  oldestCursor: number;
  latestCursor: number;
  nextCursor: number;
  gap: boolean;
}

export type AgentRuntimeEvent =
  | Readonly<{ type: "status"; status: "running" | "waiting" }>
  | Readonly<{ type: "output"; channel: "assistant" | "status" | "stderr"; text: string }>
  | Readonly<{ type: "completed"; summary?: string }>
  | Readonly<{ type: "failed"; error: string }>;

export interface AgentRuntimeSpawnContext {
  agentId: string;
  role: AgentRoleAssignment;
  workspace: string;
  permissions: readonly AgentPermission[];
  initialMessage: string;
  taskId?: string;
  label?: string;
  signal: AbortSignal;
  report: (event: AgentRuntimeEvent) => void;
}

export interface AgentRuntimeOperationContext {
  signal: AbortSignal;
}

export interface AgentRuntimeMessageContext extends AgentRuntimeOperationContext {
  message: string;
}

export interface AgentRuntimeStopContext extends AgentRuntimeOperationContext {
  reason?: string;
}

/**
 * Runtime handles are supplied by an explicitly configured provider.  PiLink
 * never turns model input into an executable, argv array, environment, or
 * shell command.
 */
export interface AgentRuntimeHandle {
  readonly runtimeAgentId?: string;
  send(context: AgentRuntimeMessageContext): Promise<void>;
  cancel(context: AgentRuntimeStopContext): Promise<void>;
  stop(context: AgentRuntimeStopContext): Promise<void>;
}

export interface AgentRuntimeAdapter {
  readonly id: string;
  spawn(context: AgentRuntimeSpawnContext): Promise<AgentRuntimeHandle>;
}

export type AgentManagerEvent =
  | Readonly<{ type: "agent-added"; agent: AgentSnapshot }>
  | Readonly<{ type: "agent-updated"; agent: AgentSnapshot; previousStatus: AgentStatus }>
  | Readonly<{
      type: "agent-output";
      agent: AgentSnapshot;
      channel: AgentOutputEntry["channel"];
      text: string;
    }>;

export type AgentManagerListener = (event: AgentManagerEvent) => void | Promise<void>;
