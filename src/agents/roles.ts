import { createHash } from "node:crypto";

/**
 * Role names and aliases are adapted from PiLink's MIT-licensed
 * feature/agent-public-chat branch (commit 0d0f8eb).  Authority is deliberately
 * kept out of this module: a role changes behaviour, never permissions.
 */
export const CANONICAL_AGENT_ROLE_IDS = [
  "manager",
  "researcher",
  "implementer",
  "ai-engineer",
  "collaborator",
] as const;

export type CanonicalAgentRoleId = typeof CANONICAL_AGENT_ROLE_IDS[number];

export interface AgentRoleAssignment {
  canonicalRoleId: CanonicalAgentRoleId;
  occupancyLabel: string;
}

export interface AgentRoleResolution extends AgentRoleAssignment {
  kind: "recognized" | "custom";
  requestedRoleFingerprint: string;
}

export interface AgentRoleContract {
  canonicalRoleId: CanonicalAgentRoleId;
  purpose: string;
  aliases: readonly Readonly<{ label: string; occupancyLabel: string }>[];
}

const ROLE_LABEL_MAX_BYTES = 128;
const OCCUPANCY_LABEL_MAX_BYTES = 64;
const FORBIDDEN_ROLE_LABEL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const OCCUPANCY_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const ROLE_IDS = new Set<string>(CANONICAL_AGENT_ROLE_IDS);

const ROLE_CONTRACTS: Readonly<Record<CanonicalAgentRoleId, AgentRoleContract>> = Object.freeze({
  manager: contract(
    "manager",
    "Decompose work, allocate non-overlapping scope, review artifacts, and own integration.",
    [
      ["manager", "manager"],
      ["project manager", "manager"],
    ],
  ),
  researcher: contract(
    "researcher",
    "Produce decision-useful evidence while remaining read-only unless separately authorized.",
    [
      ["researcher", "researcher"],
      ["research agent", "researcher"],
      ["deep researcher", "researcher"],
      ["deep research agent", "researcher"],
      ["web researcher", "researcher"],
    ],
  ),
  implementer: contract(
    "implementer",
    "Implement one bounded task with explicit scope, verification, and artifact handoff.",
    [
      ["implementer", "implementer"],
      ["dev", "dev"],
      ["developer", "dev"],
      ["dev1", "dev1"],
      ["dev 1", "dev1"],
      ["developer 1", "dev1"],
      ["software engineer 1", "dev1"],
      ["dev2", "dev2"],
      ["dev 2", "dev2"],
      ["developer 2", "dev2"],
      ["software engineer 2", "dev2"],
      ["software engineer", "software-engineer"],
    ],
  ),
  "ai-engineer": contract(
    "ai-engineer",
    "Design agent orchestration, role contracts, evaluation, memory, and prompt boundaries.",
    [
      ["ai engineer", "ai-engineer"],
      ["ai engineering", "ai-engineer"],
      ["agent orchestration engineer", "ai-engineer"],
      ["orchestration engineer", "ai-engineer"],
    ],
  ),
  collaborator: contract(
    "collaborator",
    "Provide a non-privileged fallback for custom or unsupported role labels.",
    [],
  ),
});

const ALIASES = buildAliases();

export function listAgentRoleContracts(): readonly AgentRoleContract[] {
  return CANONICAL_AGENT_ROLE_IDS.map((roleId) => ROLE_CONTRACTS[roleId]);
}

export function getAgentRoleContract(roleId: CanonicalAgentRoleId): AgentRoleContract {
  return ROLE_CONTRACTS[roleId];
}

/** Resolve untrusted display text into a behavioural role proposal. */
export function resolveAgentRole(value: unknown): AgentRoleResolution {
  if (typeof value !== "string") throw new Error("role label must be a string");
  const trimmed = value.normalize("NFKC").trim();
  if (!trimmed) throw new Error("role label must be non-empty");
  if (Buffer.byteLength(trimmed, "utf8") > ROLE_LABEL_MAX_BYTES) {
    throw new Error(`role label exceeds ${ROLE_LABEL_MAX_BYTES} UTF-8 bytes`);
  }
  if (FORBIDDEN_ROLE_LABEL_CHARACTERS.test(trimmed)) {
    throw new Error("role label contains control or bidirectional formatting characters");
  }

  const normalized = normalizeRoleLabel(trimmed);
  const requestedRoleFingerprint = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
  const alias = ALIASES.get(normalized);
  if (alias) {
    return Object.freeze({
      kind: "recognized",
      requestedRoleFingerprint,
      ...alias,
    });
  }
  return Object.freeze({
    kind: "custom",
    requestedRoleFingerprint,
    canonicalRoleId: "collaborator",
    occupancyLabel: `custom-${requestedRoleFingerprint}`,
  });
}

/** Validate a trusted, structured assignment supplied by the local controller. */
export function validateAgentRoleAssignment(value: unknown): AgentRoleAssignment {
  if (!isRecord(value)) throw new Error("role assignment must be an object");
  if (typeof value.canonicalRoleId !== "string" || !ROLE_IDS.has(value.canonicalRoleId)) {
    throw new Error("role assignment has an unsupported canonicalRoleId");
  }
  return Object.freeze({
    canonicalRoleId: value.canonicalRoleId as CanonicalAgentRoleId,
    occupancyLabel: validateOccupancyLabel(value.occupancyLabel),
  });
}

function contract(
  canonicalRoleId: CanonicalAgentRoleId,
  purpose: string,
  aliases: ReadonlyArray<readonly [string, string]>,
): AgentRoleContract {
  return Object.freeze({
    canonicalRoleId,
    purpose,
    aliases: Object.freeze(aliases.map(([label, occupancyLabel]) => Object.freeze({ label, occupancyLabel }))),
  });
}

function buildAliases(): ReadonlyMap<string, AgentRoleAssignment> {
  const aliases = new Map<string, AgentRoleAssignment>();
  for (const roleId of CANONICAL_AGENT_ROLE_IDS) {
    for (const alias of ROLE_CONTRACTS[roleId].aliases) {
      const normalized = normalizeRoleLabel(alias.label);
      if (aliases.has(normalized)) throw new Error(`duplicate agent role alias: ${normalized}`);
      aliases.set(normalized, Object.freeze({ canonicalRoleId: roleId, occupancyLabel: alias.occupancyLabel }));
    }
  }
  return aliases;
}

function normalizeRoleLabel(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[._:/\\-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function validateOccupancyLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("occupancyLabel must be a string");
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (!normalized) throw new Error("occupancyLabel must be non-empty");
  if (Buffer.byteLength(normalized, "utf8") > OCCUPANCY_LABEL_MAX_BYTES) {
    throw new Error(`occupancyLabel exceeds ${OCCUPANCY_LABEL_MAX_BYTES} UTF-8 bytes`);
  }
  if (!OCCUPANCY_LABEL_PATTERN.test(normalized)) {
    throw new Error("occupancyLabel must contain only lowercase letters, numbers, and hyphens");
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
