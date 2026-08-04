import { z } from "zod";
import {
  MEMORY_KINDS,
  MEMORY_LIFECYCLES,
  MEMORY_MAX_BOOT_BYTES,
  MEMORY_MAX_MANIFEST_BYTES,
  MEMORY_MAX_QUERY_LIMIT,
  MEMORY_NAMESPACES,
  type AgentMemoryStore,
  type MemoryAccessContext,
  type MemoryBootOptions,
  type MemoryEntry,
  type MemoryLifecycle,
  type MemoryManifestOptions,
  type MemoryQueryOptions,
  type MemoryQueryResult,
} from "./memory.js";
import type { AgentTask } from "./tasks.js";

export interface MemoryMcpIdentity {
  agentId: string;
  agentName: string;
}

export interface MemoryMcpCollaborationContext extends MemoryMcpIdentity {
  collaborationSessionId: string;
  roleAssignment: {
    canonicalRoleId: string;
  };
}

const memoryIdSchema = z.string().regex(/^mem_[0-9a-z]{10}_[0-9a-f]{16}$/);
const timestampSchema = z.string().min(1).max(64);
const identifierSchema = z.string().min(1).max(256);
const pathSchema = z.string().min(1).max(1024);

export const memoryGetToolInputSchema = z.object({
  memory_id: memoryIdSchema,
  at: timestampSchema.optional(),
  lifecycles: z.array(z.enum(MEMORY_LIFECYCLES)).min(1).max(MEMORY_LIFECYCLES.length).optional(),
}).strict();

export const memoryQueryToolInputSchema = z.object({
  query_text: z.string().min(1).max(4096).optional(),
  memory_ids: z.array(memoryIdSchema).min(1).max(100).optional(),
  namespaces: z.array(z.enum(MEMORY_NAMESPACES)).min(1).max(MEMORY_NAMESPACES.length).optional(),
  kinds: z.array(z.enum(MEMORY_KINDS)).min(1).max(MEMORY_KINDS.length).optional(),
  lifecycles: z.array(z.enum(MEMORY_LIFECYCLES)).min(1).max(MEMORY_LIFECYCLES.length).optional(),
  subject_keys: z.array(identifierSchema).min(1).max(64).optional(),
  tags: z.array(identifierSchema).min(1).max(64).optional(),
  task_ids: z.array(identifierSchema).min(1).max(64).optional(),
  components: z.array(identifierSchema).min(1).max(64).optional(),
  paths: z.array(pathSchema).min(1).max(64).optional(),
  at: timestampSchema.optional(),
  limit: z.number().int().min(1).max(MEMORY_MAX_QUERY_LIMIT).optional(),
  include_relation_warnings: z.boolean().optional(),
}).strict();

export const memoryBootToolInputSchema = z.object({
  query_text: z.string().min(1).max(4096).optional(),
  at: timestampSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
  maximum_bytes: z.number().int().min(1024).max(MEMORY_MAX_BOOT_BYTES).optional(),
}).strict();

export const memoryManifestToolInputSchema = z.object({
  at: timestampSchema.optional(),
  limit: z.number().int().min(1).max(5_000).optional(),
  maximum_bytes: z.number().int().min(1024).max(MEMORY_MAX_MANIFEST_BYTES).optional(),
}).strict();

export type MemoryGetToolArguments = z.infer<typeof memoryGetToolInputSchema>;
export type MemoryQueryToolArguments = z.infer<typeof memoryQueryToolInputSchema>;
export type MemoryBootToolArguments = z.infer<typeof memoryBootToolInputSchema>;
export type MemoryManifestToolArguments = z.infer<typeof memoryManifestToolInputSchema>;

export interface MemoryGetToolInput {
  memoryId: string;
  at?: string;
  lifecycles?: MemoryLifecycle[];
}

export interface MemoryGetToolResult {
  found: boolean;
  entry?: MemoryEntry;
}

export interface MemoryBootToolResult {
  markdown: string;
}

export interface MemoryManifestToolResult {
  manifestJson: string;
}

/**
 * Build the least-privileged memory context for one authenticated MCP call.
 * Raw role labels and caller-supplied task IDs are never accepted here.
 */
export function buildMemoryAccessContext(
  identity: Readonly<MemoryMcpIdentity>,
  collaborationContext: Readonly<MemoryMcpCollaborationContext> | undefined,
  tasks: readonly AgentTask[] = [],
): MemoryAccessContext {
  const taskIds = collaborationContext
    ? authorizedTaskIds(identity.agentId, collaborationContext.collaborationSessionId, tasks)
    : [];
  return {
    actorId: identity.agentId,
    collaborationSessionId: collaborationContext?.collaborationSessionId,
    roleIds: collaborationContext ? [collaborationContext.roleAssignment.canonicalRoleId] : undefined,
    taskIds: taskIds.length > 0 ? taskIds : undefined,
    principalIds: [identity.agentId],
    canReadRestricted: false,
  };
}

export async function memoryGet(
  store: AgentMemoryStore,
  context: MemoryAccessContext,
  input: MemoryGetToolInput,
): Promise<MemoryGetToolResult> {
  const entry = await store.get(context, input.memoryId, {
    at: input.at,
    lifecycles: input.lifecycles,
  });
  return entry ? { found: true, entry } : { found: false };
}

export function memoryQuery(
  store: AgentMemoryStore,
  context: MemoryAccessContext,
  options: MemoryQueryOptions,
): Promise<MemoryQueryResult> {
  return store.query(context, options);
}

export async function memoryBootRead(
  store: AgentMemoryStore,
  context: MemoryAccessContext,
  options: MemoryBootOptions,
): Promise<MemoryBootToolResult> {
  return { markdown: await store.renderBootMarkdown(context, options) };
}

export async function memoryManifestRead(
  store: AgentMemoryStore,
  context: MemoryAccessContext,
  options: MemoryManifestOptions,
): Promise<MemoryManifestToolResult> {
  return { manifestJson: await store.renderManifestJson(context, options) };
}

function authorizedTaskIds(
  agentId: string,
  collaborationSessionId: string,
  tasks: readonly AgentTask[],
): string[] {
  const ids = tasks
    .filter((task) => {
      if (task.ownerAgentId !== agentId) return false;
      if (task.ownerScope === "actor") return true;
      return task.ownerScope === "collaboration_session" &&
        task.ownerCollaborationSessionId === collaborationSessionId;
    })
    .map((task) => task.taskId);
  return [...new Set(ids)].sort();
}
