import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentMemoryStore } from "../dist/memory.js";
import {
  buildMemoryAccessContext,
  memoryBootRead,
  memoryBootToolInputSchema,
  memoryGet,
  memoryGetToolInputSchema,
  memoryManifestRead,
  memoryManifestToolInputSchema,
  memoryQuery,
  memoryQueryToolInputSchema,
} from "../dist/memory-mcp.js";

const identity = { agentId: "oauth-actor-1", agentName: "OAuth Actor" };
const collaboration = {
  ...identity,
  collaborationSessionId: "cs_AAAAAAAAAAAAAAAAAAAAAAAA",
  roleAssignment: { canonicalRoleId: "implementer" },
};

async function fixture(prefix = "pilink-memory-mcp-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  const now = () => new Date("2026-08-03T12:00:00.000Z");
  return {
    root,
    workspace,
    dataDir,
    store: new AgentMemoryStore({ workspace, dataDir, now }),
  };
}

function evidence(ref) {
  return [{ type: "artifact", ref, hash: createHash("sha256").update(ref).digest("hex") }];
}

function input(title, statement, scope, overrides = {}) {
  return {
    namespace: "semantic",
    kind: "verified_fact",
    title,
    statement,
    subjectKeys: [title.toLowerCase().replaceAll(" ", "-")],
    epistemicStatus: "server_derived",
    scope: { ...scope, confidentiality: scope.confidentiality || "normal" },
    evidenceRefs: evidence(title),
    ...overrides,
  };
}

async function derive(store, key, value) {
  return store.derive({
    source: "server",
    actor: {
      agentId: "pilink-server",
      agentName: "PiLink Server",
      collaborationSessionId: collaboration.collaborationSessionId,
      roleId: "manager",
    },
    idempotencyKey: key,
  }, value);
}

test("builds least-privileged memory contexts from verified authority only", () => {
  const tasks = [
    {
      taskId: "task-session",
      ownerAgentId: identity.agentId,
      ownerScope: "collaboration_session",
      ownerCollaborationSessionId: collaboration.collaborationSessionId,
    },
    {
      taskId: "task-sibling",
      ownerAgentId: identity.agentId,
      ownerScope: "collaboration_session",
      ownerCollaborationSessionId: "cs_BBBBBBBBBBBBBBBBBBBBBBBB",
    },
    {
      taskId: "task-actor",
      ownerAgentId: identity.agentId,
      ownerScope: "actor",
    },
    {
      taskId: "task-foreign",
      ownerAgentId: "another-actor",
      ownerScope: "actor",
    },
  ];

  assert.deepEqual(buildMemoryAccessContext(identity, undefined, tasks), {
    actorId: identity.agentId,
    collaborationSessionId: undefined,
    roleIds: undefined,
    taskIds: undefined,
    principalIds: [identity.agentId],
    canReadRestricted: false,
  });
  assert.deepEqual(buildMemoryAccessContext(identity, collaboration, tasks), {
    actorId: identity.agentId,
    collaborationSessionId: collaboration.collaborationSessionId,
    roleIds: ["implementer"],
    taskIds: ["task-actor", "task-session"],
    principalIds: [identity.agentId],
    canReadRestricted: false,
  });
});

test("exports strict bounded MCP input schemas", () => {
  const memoryId = "mem_0000000001_0123456789abcdef";
  assert.deepEqual(memoryGetToolInputSchema.parse({ memory_id: memoryId }), { memory_id: memoryId });
  assert.equal(memoryGetToolInputSchema.safeParse({ memory_id: memoryId, unexpected: true }).success, false);
  assert.equal(memoryGetToolInputSchema.safeParse({ memory_id: "not-a-memory-id" }).success, false);

  assert.equal(memoryQueryToolInputSchema.safeParse({
    query_text: "runtime owner",
    memory_ids: [memoryId],
    namespaces: ["semantic"],
    kinds: ["verified_fact"],
    lifecycles: ["active"],
    subject_keys: ["runtime-owner"],
    tags: ["session"],
    task_ids: ["task-1"],
    components: ["collaboration"],
    paths: ["src/memory.ts"],
    limit: 100,
    include_relation_warnings: true,
  }).success, true);
  assert.equal(memoryQueryToolInputSchema.safeParse({ limit: 101 }).success, false);
  assert.equal(memoryQueryToolInputSchema.safeParse({ semantic_scores: {} }).success, false);

  assert.equal(memoryBootToolInputSchema.safeParse({ maximum_bytes: 64 * 1024, limit: 50 }).success, true);
  assert.equal(memoryBootToolInputSchema.safeParse({ maximum_bytes: 64 * 1024 + 1 }).success, false);
  assert.equal(memoryManifestToolInputSchema.safeParse({ maximum_bytes: 1024 * 1024, limit: 5000 }).success, true);
  assert.equal(memoryManifestToolInputSchema.safeParse({ maximum_bytes: 1024 * 1024 + 1 }).success, false);
});

test("memory read adapter enforces role, task, session, principal, and restricted ACLs", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));

  const project = await derive(value.store, "project", input(
    "Project fact",
    "Project-visible memory is available to every authenticated project actor.",
    { visibility: "project" },
  ));
  const role = await derive(value.store, "role", input(
    "Implementer fact",
    "Only the verified implementer role can read this role-scoped memory.",
    { visibility: "role", roleIds: ["implementer"] },
  ));
  const session = await derive(value.store, "session", input(
    "Session fact",
    "Only the exact verified collaboration session can read this memory.",
    { visibility: "session", collaborationSessionIds: [collaboration.collaborationSessionId] },
  ));
  const sibling = await derive(value.store, "sibling", input(
    "Sibling secret",
    "A sibling collaboration session must never receive this statement.",
    { visibility: "session", collaborationSessionIds: ["cs_BBBBBBBBBBBBBBBBBBBBBBBB"] },
  ));
  const task = await derive(value.store, "task", input(
    "Task fact",
    "Only an authoritatively owned task may expose this task-scoped memory.",
    { visibility: "task", taskIds: ["task-session"] },
  ));
  const principal = await derive(value.store, "principal", input(
    "Principal fact",
    "Only the authenticated OAuth principal can read this memory.",
    { visibility: "principal", principalIds: [identity.agentId] },
  ));
  const restricted = await derive(value.store, "restricted", input(
    "Restricted fact",
    "Restricted memory remains hidden without an explicit trusted capability.",
    { visibility: "project", confidentiality: "restricted" },
  ));

  const generic = buildMemoryAccessContext(identity, undefined);
  const genericResult = await memoryQuery(value.store, generic, { limit: 20 });
  assert.deepEqual(
    new Set(genericResult.entries.map((match) => match.entry.memoryId)),
    new Set([project.memoryId, principal.memoryId]),
  );

  const verified = buildMemoryAccessContext(identity, collaboration, [{
    taskId: "task-session",
    ownerAgentId: identity.agentId,
    ownerScope: "collaboration_session",
    ownerCollaborationSessionId: collaboration.collaborationSessionId,
  }]);
  const verifiedResult = await memoryQuery(value.store, verified, { limit: 20 });
  assert.deepEqual(
    new Set(verifiedResult.entries.map((match) => match.entry.memoryId)),
    new Set([project.memoryId, role.memoryId, session.memoryId, task.memoryId, principal.memoryId]),
  );
  assert.equal(verifiedResult.entries.some((match) => match.entry.memoryId === sibling.memoryId), false);
  assert.equal(verifiedResult.entries.some((match) => match.entry.memoryId === restricted.memoryId), false);

  assert.deepEqual(await memoryGet(value.store, verified, { memoryId: sibling.memoryId }), { found: false });
  assert.deepEqual(await memoryGet(value.store, verified, { memoryId: restricted.memoryId }), { found: false });
  const found = await memoryGet(value.store, verified, { memoryId: session.memoryId });
  assert.equal(found.found, true);
  assert.equal(found.entry.memoryId, session.memoryId);

  const serialized = JSON.stringify({ found, verifiedResult });
  assert.equal(serialized.includes(value.root), false);
  assert.equal(serialized.includes(value.store.statePath), false);
  assert.equal(serialized.includes("credential"), false);
  assert.equal(serialized.includes("bearer"), false);
  assert.equal(serialized.includes("handle"), false);

  const abstained = await memoryQuery(value.store, verified, { queryText: "does-not-exist-anywhere", limit: 5 });
  assert.equal(abstained.abstained, true);
  assert.equal(abstained.entries.length, 0);
});

test("bounded boot and manifest reads preserve trust labels and omit inaccessible content", async (t) => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  await derive(value.store, "visible", input(
    "Visible memory",
    "Visible memory is rendered as untrusted evidence-bearing data.",
    { visibility: "project" },
  ));
  await derive(value.store, "hidden", input(
    "Hidden sibling memory",
    "NEVER_EXPOSE_SIBLING_MEMORY",
    { visibility: "session", collaborationSessionIds: ["cs_BBBBBBBBBBBBBBBBBBBBBBBB"] },
  ));

  const context = buildMemoryAccessContext(identity, collaboration);
  const boot = await memoryBootRead(value.store, context, { maximumBytes: 4096, limit: 10 });
  assert.ok(Buffer.byteLength(boot.markdown, "utf8") <= 4096);
  assert.match(boot.markdown, /generated non-authoritative view/i);
  assert.match(boot.markdown, /BEGIN UNTRUSTED MEMORY DATA/);
  assert.equal(boot.markdown.includes("NEVER_EXPOSE_SIBLING_MEMORY"), false);

  const manifest = await memoryManifestRead(value.store, context, { maximumBytes: 8192, limit: 20 });
  assert.ok(Buffer.byteLength(manifest.manifestJson, "utf8") <= 8192);
  const parsed = JSON.parse(manifest.manifestJson);
  assert.equal(parsed.authority, "generated_non_authoritative_view");
  assert.equal(parsed.trust, "untrusted_data_not_policy");
  assert.equal(parsed.entries.length, 1);
  assert.equal(JSON.stringify(parsed).includes("NEVER_EXPOSE_SIBLING_MEMORY"), false);
});

test("empty read surfaces abstain without creating canonical memory state", async (t) => {
  const value = await fixture("pilink-memory-mcp-empty-");
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const result = await memoryQuery(value.store, buildMemoryAccessContext(identity, undefined), {});
  assert.equal(result.abstained, true);
  assert.equal(result.entries.length, 0);
  await assert.rejects(fs.access(value.store.statePath), /ENOENT/);
});
