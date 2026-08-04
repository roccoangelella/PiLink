import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  COORDINATION_TASK_STATUSES,
  type AgentCoordinationStore,
  type CoordinationChatMessage,
  type CoordinationIdentity,
  type CoordinationTask,
  type CoordinationTaskStatus,
} from "./coordination.js";
import type { AgentPermission } from "./types.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;

const CHILD_TASK_UPDATE_STATUSES = ["working", "blocked", "completed", "failed"] as const;
const CHILD_TASK_UPDATE_STATUS_SET = new Set<string>(CHILD_TASK_UPDATE_STATUSES);
const COORDINATION_TASK_STATUS_SET = new Set<string>(COORDINATION_TASK_STATUSES);
const RESULT_MAX_BYTES = 128 * 1024;
const CHAT_MESSAGE_MAX_BYTES = 16 * 1024;
const TASK_STATUS_MESSAGE_MAX_BYTES = 16 * 1024;
const TASK_ARTIFACT_MAX_BYTES = 32 * 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;

export interface PiCoordinationToolContext {
  store: AgentCoordinationStore;
  agentId: string;
  occupancyLabel: string;
  permissions: ReadonlySet<AgentPermission>;
}

/**
 * Build a capability-scoped coordination bridge for one child runtime.
 *
 * Identity and assignment filters are captured by the closure; no model tool
 * argument can select another actor, agent, namespace, store, or workspace.
 */
export function createPiCoordinationToolDefinitions(context: PiCoordinationToolContext): AnyToolDefinition[] {
  const identity: CoordinationIdentity = Object.freeze({
    actorId: context.agentId,
    actorName: context.occupancyLabel,
    authority: "agent",
    agentId: context.agentId,
  });
  const tools: AnyToolDefinition[] = [];

  if (context.permissions.has("coordination:read")) {
    tools.push(chatReadTool(context.store), taskListTool(context.store, context.agentId));
  }
  if (context.permissions.has("coordination:write")) {
    tools.push(chatPostTool(context.store, identity), taskUpdateTool(context.store, identity));
  }
  return tools;
}

function chatReadTool(store: AgentCoordinationStore): AnyToolDefinition {
  return {
    name: "coordination_chat_read",
    label: "coordination_chat_read",
    description: "Read recent messages from this project's private agent coordination channel using a cursor.",
    promptSnippet: "Read project-agent coordination messages",
    promptGuidelines: ["Use cursors for incremental reads and never copy credentials or authentication material into coordination chat."],
    executionMode: "parallel",
    parameters: objectSchema({
      after: integerSchema(0),
      limit: integerSchema(1, 25),
    }),
    async execute(_toolCallId: string, raw: unknown, signal?: AbortSignal) {
      requireNotAborted(signal);
      const input = recordInput(raw);
      try {
        const result = await store.agentChatRead({
          after: optionalInteger(input.after, "after", 0),
          limit: optionalInteger(input.limit, "limit", 1, 25),
        });
        return jsonResult({
          oldest_cursor: result.oldestCursor,
          latest_cursor: result.latestCursor,
          next_cursor: result.nextCursor,
          gap: result.gap,
          messages: result.messages.map(publicChatMessage),
        });
      } catch {
        throw new Error("coordination_chat_read_failed");
      }
    },
  } as AnyToolDefinition;
}

function chatPostTool(store: AgentCoordinationStore, identity: CoordinationIdentity): AnyToolDefinition {
  return {
    name: "coordination_chat_post",
    label: "coordination_chat_post",
    description: "Post a message to this project's private agent coordination channel as the current supervised agent.",
    promptSnippet: "Post a project-agent coordination message",
    promptGuidelines: ["Post only task coordination and evidence; never include credentials, tokens, cookies, or private model configuration."],
    executionMode: "sequential",
    parameters: objectSchema({ message: stringSchema(1, CHAT_MESSAGE_MAX_BYTES) }, ["message"]),
    async execute(_toolCallId: string, raw: unknown, signal?: AbortSignal) {
      requireNotAborted(signal);
      const input = recordInput(raw);
      try {
        const message = await store.agentChatPost({
          ...identity,
          message: requiredText(input.message, "message", CHAT_MESSAGE_MAX_BYTES),
        });
        return jsonResult({ message: publicChatMessage(message) });
      } catch {
        throw new Error("coordination_chat_post_failed");
      }
    },
  } as AnyToolDefinition;
}

function taskListTool(store: AgentCoordinationStore, agentId: string): AnyToolDefinition {
  return {
    name: "coordination_task_list",
    label: "coordination_task_list",
    description: "List only coordination tasks assigned to this exact supervised agent.",
    promptSnippet: "List tasks assigned to this agent",
    promptGuidelines: ["Read the current task revision before each update and remain within the assigned task."],
    executionMode: "parallel",
    parameters: objectSchema({
      statuses: arraySchema(enumSchema(COORDINATION_TASK_STATUSES), 1, COORDINATION_TASK_STATUSES.length),
      limit: integerSchema(1, 25),
    }),
    async execute(_toolCallId: string, raw: unknown, signal?: AbortSignal) {
      requireNotAborted(signal);
      const input = recordInput(raw);
      try {
        const tasks = await store.agentTaskList({
          assignedAgentId: agentId,
          statuses: optionalStatuses(input.statuses),
          limit: optionalInteger(input.limit, "limit", 1, 25),
        });
        return jsonResult({ tasks: tasks.map(publicTask) });
      } catch {
        throw new Error("coordination_task_list_failed");
      }
    },
  } as AnyToolDefinition;
}

function taskUpdateTool(store: AgentCoordinationStore, identity: CoordinationIdentity): AnyToolDefinition {
  return {
    name: "coordination_task_update",
    label: "coordination_task_update",
    description: "Update a task assigned to this exact supervised agent using its expected revision.",
    promptSnippet: "Update this agent's assigned task",
    promptGuidelines: ["Use blocked with a reason when progress cannot continue; attach artifacts only to completed or failed tasks."],
    executionMode: "sequential",
    parameters: objectSchema({
      task_id: stringSchema(1, 256),
      expected_revision: integerSchema(1),
      status: enumSchema(CHILD_TASK_UPDATE_STATUSES),
      status_message: stringSchema(1, TASK_STATUS_MESSAGE_MAX_BYTES),
      artifact: stringSchema(1, TASK_ARTIFACT_MAX_BYTES),
    }, ["task_id", "expected_revision", "status"]),
    async execute(_toolCallId: string, raw: unknown, signal?: AbortSignal) {
      requireNotAborted(signal);
      const input = recordInput(raw);
      try {
        const task = await store.agentTaskUpdate({
          ...identity,
          taskId: identifier(input.task_id, "task_id"),
          expectedRevision: requiredInteger(input.expected_revision, "expected_revision", 1),
          status: childUpdateStatus(input.status),
          statusMessage: optionalText(input.status_message, "status_message", TASK_STATUS_MESSAGE_MAX_BYTES),
          artifact: optionalText(input.artifact, "artifact", TASK_ARTIFACT_MAX_BYTES),
        });
        return jsonResult({ task: publicTask(task) });
      } catch {
        throw new Error("coordination_task_update_failed");
      }
    },
  } as AnyToolDefinition;
}

function publicChatMessage(message: CoordinationChatMessage) {
  return {
    cursor: message.cursor,
    actor_name: message.actorName,
    agent_id: message.agentId,
    message: message.message,
    created_at: message.createdAt,
  };
}

function publicTask(task: CoordinationTask) {
  return {
    task_id: task.taskId,
    title: task.title,
    details: task.details,
    status: task.status,
    status_message: task.statusMessage,
    artifact: task.artifact,
    assigned_agent_id: task.assignedAgentId,
    assigned_agent_name: task.assignedAgentName,
    assigned_role: task.assignedRole && {
      canonical_role_id: task.assignedRole.canonicalRoleId,
      occupancy_label: task.assignedRole.occupancyLabel,
    },
    updated_at: task.updatedAt,
    revision: task.revision,
  };
}

function jsonResult(value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > RESULT_MAX_BYTES) throw new Error("coordination_result_too_large");
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function recordInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_coordination_arguments");
  return value as Record<string, unknown>;
}

function optionalStatuses(value: unknown): readonly CoordinationTaskStatus[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > COORDINATION_TASK_STATUSES.length) {
    throw new Error("statuses must be a bounded non-empty array");
  }
  const statuses = value.map((candidate) => {
    if (typeof candidate !== "string" || !COORDINATION_TASK_STATUS_SET.has(candidate)) {
      throw new Error("Unsupported task status");
    }
    return candidate as CoordinationTaskStatus;
  });
  return [...new Set(statuses)];
}

function childUpdateStatus(value: unknown): typeof CHILD_TASK_UPDATE_STATUSES[number] {
  if (typeof value !== "string" || !CHILD_TASK_UPDATE_STATUS_SET.has(value)) {
    throw new Error("Unsupported child task update status");
  }
  return value as typeof CHILD_TASK_UPDATE_STATUSES[number];
}

function identifier(value: unknown, field: string): string {
  const selected = requiredText(value, field, 256);
  if (!IDENTIFIER_PATTERN.test(selected)) throw new Error(`${field} is invalid`);
  return selected;
}

function requiredText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const selected = value.trim();
  if (!selected || Buffer.byteLength(selected, "utf8") > maximumBytes) throw new Error(`${field} is invalid`);
  return selected;
}

function optionalText(value: unknown, field: string, maximumBytes: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, field, maximumBytes);
}

function requiredInteger(value: unknown, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be a bounded integer`);
  }
  return value as number;
}

function optionalInteger(value: unknown, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return value === undefined ? undefined : requiredInteger(value, field, minimum, maximum);
}

function requireNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("coordination_operation_aborted");
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[] = []) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
  } as any;
}

function stringSchema(minLength: number, maxLength: number) {
  return { type: "string", minLength, maxLength };
}

function integerSchema(minimum: number, maximum?: number) {
  return { type: "integer", minimum, ...(maximum === undefined ? {} : { maximum }) };
}

function enumSchema(values: readonly string[]) {
  return { type: "string", enum: [...values] };
}

function arraySchema(items: unknown, minItems: number, maxItems: number) {
  return { type: "array", items, minItems, maxItems, uniqueItems: true };
}
