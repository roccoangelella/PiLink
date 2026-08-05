import {
  CANONICAL_COLLABORATION_ROLE_IDS,
  type CanonicalCollaborationRoleId,
  type VerifiedCollaborationRoleAssignment,
  validatePersistedCollaborationRoleAssignment,
} from "./collaboration-roles.js";

export const AGENT_CHAT_ROLE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const AGENT_CHAT_ROLE_PROVENANCE_SOURCES = [
  "verified_collaboration_session",
  "generic_actor",
  "legacy_unverified",
] as const;
export const AGENT_CHAT_DISPLAY_ROLE_IDS = [
  "manager",
  "researcher",
  "dev",
  "ai-engineer",
  "collaborator",
  "agent",
] as const;

export type AgentChatRoleProvenanceSource = typeof AGENT_CHAT_ROLE_PROVENANCE_SOURCES[number];
export type AgentChatDisplayRoleId = typeof AGENT_CHAT_DISPLAY_ROLE_IDS[number];

export interface AgentChatRoleSnapshot {
  readonly schemaVersion: typeof AGENT_CHAT_ROLE_SNAPSHOT_SCHEMA_VERSION;
  readonly source: AgentChatRoleProvenanceSource;
  readonly canonicalRoleId?: CanonicalCollaborationRoleId;
  readonly occupancyLabel?: string;
  readonly contractId?: string;
  readonly contractVersion?: string;
  readonly displayRoleId: AgentChatDisplayRoleId;
  readonly displayRoleLabel: string;
}

const PROVENANCE_SOURCE_SET = new Set<string>(AGENT_CHAT_ROLE_PROVENANCE_SOURCES);
const DISPLAY_ROLE_ID_SET = new Set<string>(AGENT_CHAT_DISPLAY_ROLE_IDS);
const CANONICAL_ROLE_ID_SET = new Set<string>(CANONICAL_COLLABORATION_ROLE_IDS);
const SAFE_ID = /^[a-z0-9][a-z0-9./-]*$/u;
const SAFE_OCCUPANCY = /^[a-z0-9][a-z0-9-]*$/u;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export function createVerifiedAgentChatRoleSnapshot(
  assignmentInput: Readonly<VerifiedCollaborationRoleAssignment>,
): AgentChatRoleSnapshot {
  const assignment = validatePersistedCollaborationRoleAssignment(assignmentInput);
  const display = displayForVerifiedRole(assignment.canonicalRoleId, assignment.occupancyLabel);
  return freezeSnapshot({
    schemaVersion: AGENT_CHAT_ROLE_SNAPSHOT_SCHEMA_VERSION,
    source: "verified_collaboration_session",
    canonicalRoleId: assignment.canonicalRoleId,
    occupancyLabel: assignment.occupancyLabel,
    contractId: assignment.contractId,
    contractVersion: assignment.contractVersion,
    displayRoleId: display.id,
    displayRoleLabel: display.label,
  });
}

export function createGenericAgentChatRoleSnapshot(
  source: "generic_actor" | "legacy_unverified" = "generic_actor",
): AgentChatRoleSnapshot {
  return freezeSnapshot({
    schemaVersion: AGENT_CHAT_ROLE_SNAPSHOT_SCHEMA_VERSION,
    source,
    displayRoleId: "agent",
    displayRoleLabel: source === "legacy_unverified" ? "LEGACY AGENT" : "AGENT",
  });
}

export function validateAgentChatRoleSnapshot(value: unknown): AgentChatRoleSnapshot {
  if (!isRecord(value)) throw new Error("authorRole must be an object");
  assertExactKeys(value, [
    "schemaVersion",
    "source",
    "canonicalRoleId",
    "occupancyLabel",
    "contractId",
    "contractVersion",
    "displayRoleId",
    "displayRoleLabel",
  ]);
  if (value.schemaVersion !== AGENT_CHAT_ROLE_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("authorRole has an unsupported schemaVersion");
  }
  if (typeof value.source !== "string" || !PROVENANCE_SOURCE_SET.has(value.source)) {
    throw new Error("authorRole has an unsupported source");
  }
  if (typeof value.displayRoleId !== "string" || !DISPLAY_ROLE_ID_SET.has(value.displayRoleId)) {
    throw new Error("authorRole has an unsupported displayRoleId");
  }
  const displayRoleLabel = validateDisplayLabel(value.displayRoleLabel);
  const source = value.source as AgentChatRoleProvenanceSource;
  const displayRoleId = value.displayRoleId as AgentChatDisplayRoleId;

  if (source !== "verified_collaboration_session") {
    if (value.canonicalRoleId !== undefined || value.occupancyLabel !== undefined ||
        value.contractId !== undefined || value.contractVersion !== undefined) {
      throw new Error("unverified authorRole must not contain verified role metadata");
    }
    if (displayRoleId !== "agent") throw new Error("unverified authorRole must use the agent display role");
    const expectedLabel = source === "legacy_unverified" ? "LEGACY AGENT" : "AGENT";
    if (displayRoleLabel !== expectedLabel) throw new Error("unverified authorRole has an invalid display label");
    return freezeSnapshot({
      schemaVersion: AGENT_CHAT_ROLE_SNAPSHOT_SCHEMA_VERSION,
      source,
      displayRoleId,
      displayRoleLabel,
    });
  }

  if (typeof value.canonicalRoleId !== "string" || !CANONICAL_ROLE_ID_SET.has(value.canonicalRoleId)) {
    throw new Error("verified authorRole requires a canonicalRoleId");
  }
  const canonicalRoleId = value.canonicalRoleId as CanonicalCollaborationRoleId;
  const occupancyLabel = validateOccupancy(value.occupancyLabel);
  const contractId = validateSafeIdentifier(value.contractId, "authorRole.contractId", 128);
  const contractVersion = validateSafeIdentifier(value.contractVersion, "authorRole.contractVersion", 64);
  const assignment = validatePersistedCollaborationRoleAssignment({
    assignmentSource: "server_session_policy",
    canonicalRoleId,
    occupancyLabel,
    contractId,
    contractVersion,
  });
  const expectedDisplay = displayForVerifiedRole(assignment.canonicalRoleId, assignment.occupancyLabel);
  if (displayRoleId !== expectedDisplay.id || displayRoleLabel !== expectedDisplay.label) {
    throw new Error("verified authorRole display metadata does not match the canonical role snapshot");
  }
  return freezeSnapshot({
    schemaVersion: AGENT_CHAT_ROLE_SNAPSHOT_SCHEMA_VERSION,
    source,
    canonicalRoleId: assignment.canonicalRoleId,
    occupancyLabel: assignment.occupancyLabel,
    contractId: assignment.contractId,
    contractVersion: assignment.contractVersion,
    displayRoleId,
    displayRoleLabel,
  });
}

export function copyAgentChatRoleSnapshot(snapshot: AgentChatRoleSnapshot): AgentChatRoleSnapshot {
  return freezeSnapshot({ ...snapshot });
}

function displayForVerifiedRole(
  canonicalRoleId: CanonicalCollaborationRoleId,
  occupancyLabel: string,
): Readonly<{ id: AgentChatDisplayRoleId; label: string }> {
  switch (canonicalRoleId) {
    case "manager":
      return Object.freeze({ id: "manager", label: "MANAGER" });
    case "researcher":
      return Object.freeze({ id: "researcher", label: "RESEARCHER" });
    case "ai-engineer":
      return Object.freeze({ id: "ai-engineer", label: "AI ENGINEER" });
    case "implementer":
      if (occupancyLabel === "dev1") return Object.freeze({ id: "dev", label: "DEV 1" });
      if (occupancyLabel === "dev2") return Object.freeze({ id: "dev", label: "DEV 2" });
      if (occupancyLabel === "software-engineer") {
        return Object.freeze({ id: "dev", label: "SOFTWARE ENGINEER" });
      }
      return Object.freeze({ id: "dev", label: "DEV" });
    case "collaborator":
      return Object.freeze({ id: "collaborator", label: "COLLABORATOR" });
  }
}

function freezeSnapshot(snapshot: AgentChatRoleSnapshot): AgentChatRoleSnapshot {
  return Object.freeze({ ...snapshot });
}

function validateOccupancy(value: unknown): string {
  if (typeof value !== "string" || !SAFE_OCCUPANCY.test(value) || Buffer.byteLength(value, "utf8") > 64) {
    throw new Error("verified authorRole requires a safe occupancyLabel");
  }
  return value;
}

function validateSafeIdentifier(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function validateDisplayLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("authorRole.displayRoleLabel must be a string");
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 64 || FORBIDDEN_TEXT.test(normalized)) {
    throw new Error("authorRole.displayRoleLabel is invalid");
  }
  return normalized;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`authorRole contains unsupported field '${key}'`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
