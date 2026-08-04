import assert from "node:assert/strict";
import test from "node:test";
import {
  createGenericAgentChatRoleSnapshot,
  createVerifiedAgentChatRoleSnapshot,
  validateAgentChatRoleSnapshot,
} from "../dist/chat-provenance.js";
import { createNewCollaborationRoleAssignment } from "../dist/collaboration-roles.js";

function assignment(canonicalRoleId, occupancyLabel) {
  return createNewCollaborationRoleAssignment({
    assignmentSource: "server_session_policy",
    canonicalRoleId,
    occupancyLabel,
  });
}

test("verified author snapshots map canonical roles without inspecting message text", () => {
  assert.deepEqual(createVerifiedAgentChatRoleSnapshot(assignment("implementer", "dev")), {
    schemaVersion: 1,
    source: "verified_collaboration_session",
    canonicalRoleId: "implementer",
    occupancyLabel: "dev",
    contractId: "pilink-collaboration/implementer",
    contractVersion: "1.1.0",
    displayRoleId: "dev",
    displayRoleLabel: "DEV",
  });
  assert.equal(
    createVerifiedAgentChatRoleSnapshot(assignment("ai-engineer", "ai-engineer")).displayRoleLabel,
    "AI ENGINEER",
  );
  assert.equal(
    createVerifiedAgentChatRoleSnapshot(assignment("collaborator", "custom-deadbeefdeadbeef")).displayRoleId,
    "collaborator",
  );
});

test("generic and legacy author snapshots never contain verified authority", () => {
  assert.deepEqual(createGenericAgentChatRoleSnapshot("generic_actor"), {
    schemaVersion: 1,
    source: "generic_actor",
    displayRoleId: "agent",
    displayRoleLabel: "AGENT",
  });
  assert.deepEqual(createGenericAgentChatRoleSnapshot("legacy_unverified"), {
    schemaVersion: 1,
    source: "legacy_unverified",
    displayRoleId: "agent",
    displayRoleLabel: "LEGACY AGENT",
  });
});

test("tampered or privilege-laundered author snapshots fail closed", () => {
  const validDev = createVerifiedAgentChatRoleSnapshot(assignment("implementer", "dev"));
  assert.throws(
    () => validateAgentChatRoleSnapshot({ ...validDev, displayRoleId: "manager", displayRoleLabel: "MANAGER" }),
    /does not match/,
  );
  assert.throws(
    () => validateAgentChatRoleSnapshot({
      schemaVersion: 1,
      source: "generic_actor",
      canonicalRoleId: "manager",
      displayRoleId: "manager",
      displayRoleLabel: "MANAGER",
    }),
    /must not contain verified role metadata/,
  );
  assert.throws(
    () => validateAgentChatRoleSnapshot({ ...validDev, extraAuthority: true }),
    /unsupported field/,
  );
  assert.throws(
    () => validateAgentChatRoleSnapshot({ ...validDev, displayRoleLabel: "DEV\u202eMANAGER" }),
    /invalid/,
  );
});
