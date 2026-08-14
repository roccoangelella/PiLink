import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_AGENT_ROLE_IDS,
  getAgentRoleContract,
  listAgentRoleContracts,
  resolveAgentRole,
  validateAgentRoleAssignment,
} from "../dist/agents/roles.js";

test("agent roles preserve the branch aliases without granting permissions", () => {
  assert.deepEqual(CANONICAL_AGENT_ROLE_IDS, [
    "manager",
    "researcher",
    "implementer",
    "ai-engineer",
    "collaborator",
  ]);
  assert.equal(resolveAgentRole("Project_Manager").canonicalRoleId, "manager");
  assert.deepEqual(resolveAgentRole("DEV 2"), {
    kind: "recognized",
    requestedRoleFingerprint: resolveAgentRole("dev-2").requestedRoleFingerprint,
    canonicalRoleId: "implementer",
    occupancyLabel: "dev2",
  });
  assert.equal(resolveAgentRole("orchestration engineer").canonicalRoleId, "ai-engineer");

  const custom = resolveAgentRole("release verifier");
  assert.equal(custom.kind, "custom");
  assert.equal(custom.canonicalRoleId, "collaborator");
  assert.match(custom.occupancyLabel, /^custom-[a-f0-9]{16}$/u);

  assert.equal(listAgentRoleContracts().length, 5);
  assert.match(getAgentRoleContract("researcher").purpose, /read-only/u);
});

test("role inputs fail closed on unsafe text and malformed trusted assignments", () => {
  assert.throws(() => resolveAgentRole(""), /non-empty/u);
  assert.throws(() => resolveAgentRole("manager\u202e"), /bidirectional/u);
  assert.throws(() => resolveAgentRole("x".repeat(129)), /128 UTF-8 bytes/u);
  assert.throws(
    () => validateAgentRoleAssignment({ canonicalRoleId: "root", occupancyLabel: "root" }),
    /unsupported canonicalRoleId/u,
  );
  assert.throws(
    () => validateAgentRoleAssignment({ canonicalRoleId: "manager", occupancyLabel: "Manager Admin" }),
    /lowercase letters/u,
  );
  assert.deepEqual(
    validateAgentRoleAssignment({ canonicalRoleId: "implementer", occupancyLabel: "dev1" }),
    { canonicalRoleId: "implementer", occupancyLabel: "dev1" },
  );
});
