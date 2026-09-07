import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "./config.js";

export type ToolName = "read" | "bash" | "run" | "edit" | "write" | "grep" | "find" | "ls";

export interface HarnessPolicy {
  workspace: string;
  /** Default base for relative tool paths and process cwd. */
  workingDirectory?: string;
  unsafeFullAccess: boolean;
  /** Explicit opt-in for fixed profiles that execute trusted workspace code. */
  allowWorkspaceExecution?: boolean;
  /** Optional client-side elicitation gate for process execution. */
  requireExecutionApproval?: boolean;
}

export function createHarnessPolicy(config: RuntimeConfig, clientId?: string): HarnessPolicy {
  const configuredClientIds = config.fullAccessClientIds ?? [];
  const clientMayUseFullAccess = clientId === undefined || configuredClientIds.includes("*") || configuredClientIds.includes(clientId);
  const workspace = path.resolve(config.workspace);
  const unsafeFullAccess = config.unsafeFullAccess && clientMayUseFullAccess;
  return {
    workspace,
    // Full Access broadens authority, not the default point of reference.
    // Keep ordinary relative operations project-centric while absolute paths
    // and explicit cwd values remain unrestricted for authorized clients.
    workingDirectory: workspace,
    unsafeFullAccess,
    allowWorkspaceExecution: config.allowWorkspaceExecution,
    requireExecutionApproval: config.requireExecutionApproval,
  };
}

export function operationBase(policy: Pick<HarnessPolicy, "workspace" | "workingDirectory" | "unsafeFullAccess">): string {
  if (policy.workingDirectory) return path.resolve(policy.workingDirectory);
  return path.resolve(policy.workspace);
}

export function isToolAllowed(scopes: string, tool: ToolName): boolean {
  const granted = new Set(scopes.split(" ").filter(Boolean));
  if (granted.has("mcp:tools")) return true;
  if (["read", "grep", "find", "ls"].includes(tool)) return granted.has("mcp:read");
  return granted.has("mcp:write");
}

export async function sanitizeToolArguments<T extends Record<string, unknown>>(
  policy: HarnessPolicy,
  tool: ToolName,
  args: T,
): Promise<T> {
  if (tool === "bash") {
    if (!policy.unsafeFullAccess) {
      throw new Error("bash is disabled in workspace mode. Restart with --allow-unsafe-full-access only for a trusted MCP client.");
    }
    if (typeof args.timeout === "number") {
      if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error("timeout must be a positive number");
      return { ...args, timeout: args.timeout };
    }
    const { timeout: _timeout, ...withoutTimeout } = args;
    return withoutTimeout as T;
  }

  const sanitized = { ...args } as Record<string, unknown>;
  if (typeof sanitized.path === "string") {
    sanitized.path = await resolveWorkspacePath(policy, sanitized.path);
  }

  if ((tool === "find" || tool === "grep") && typeof sanitized.glob === "string") {
    assertSafeGlob(sanitized.glob);
  }
  if (tool === "find" && typeof sanitized.pattern === "string") assertSafeGlob(sanitized.pattern);
  return sanitized as T;
}

export async function resolveWorkspacePath(policy: HarnessPolicy, suppliedPath: string): Promise<string> {
  const candidate = path.resolve(operationBase(policy), suppliedPath);
  if (policy.unsafeFullAccess) return candidate;

  const workspace = await fs.realpath(policy.workspace);
  const canonicalCandidate = await canonicalizeExistingAncestor(candidate);
  if (!isWithin(workspace, canonicalCandidate)) {
    throw new Error(`Path escapes the configured workspace: ${suppliedPath}`);
  }
  return candidate;
}

async function canonicalizeExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  const suffix: string[] = [];
  while (true) {
    try {
      const resolved = await fs.realpath(current);
      return path.resolve(resolved, ...suffix.reverse());
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSafeGlob(glob: string): void {
  if (path.isAbsolute(glob) || glob.split(/[\\/]/).includes("..")) {
    throw new Error("Glob patterns may not be absolute or traverse outside the workspace");
  }
}
