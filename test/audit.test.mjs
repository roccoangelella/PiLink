import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolAuditLog } from "../dist/audit.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-audit-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  return { root, workspace, dataDir };
}

test("writes private project-scoped metadata-only JSONL events", async () => {
  const { root, workspace, dataDir } = await fixture();
  try {
    const audit = new ToolAuditLog({ workspace, dataDir });
    await audit.record({
      callId: "call-1",
      agentId: "agent-1",
      sessionId: "session-1",
      tool: "read",
      startedAt: "2026-08-01T10:00:00.000Z",
      durationMs: 12,
      outcome: "success",
      accessMode: "workspace",
      input: { path: "secret.txt" },
      result: "sensitive output",
      error: "sensitive error",
    });

    const events = (await fs.readFile(audit.logPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(events, [{
      version: 1,
      event: "tool_call",
      callId: "call-1",
      agentId: "agent-1",
      sessionId: "session-1",
      tool: "read",
      startedAt: "2026-08-01T10:00:00.000Z",
      durationMs: 12,
      outcome: "success",
      accessMode: "workspace",
    }]);
    assert.equal((await fs.stat(path.dirname(audit.logPath))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(audit.logPath)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rotates the active log before it exceeds the configured size", async () => {
  const { root, workspace, dataDir } = await fixture();
  try {
    const audit = new ToolAuditLog({ workspace, dataDir, maximumBytes: 420 });
    for (let index = 0; index < 6; index += 1) {
      await audit.record({
        callId: `rotation-${index}`,
        tool: "read",
        startedAt: new Date(1_700_000_000_000 + index).toISOString(),
        durationMs: index,
        outcome: "success",
        accessMode: "workspace",
      });
    }

    const active = (await fs.readFile(audit.logPath, "utf8")).trim().split("\n").map(JSON.parse);
    const rotated = (await fs.readFile(audit.rotatedLogPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(active.length > 0);
    assert.ok(rotated.length > 0);
    assert.equal(active.at(-1).callId, "rotation-5");
    assert.ok((await fs.stat(audit.logPath)).size <= 420);
    assert.ok((await fs.stat(audit.rotatedLogPath)).size <= 420);
    const expectedRecent = [...rotated, ...active].slice(-3).map((event) => event.callId);
    assert.deepEqual((await audit.readRecent(3)).map((event) => event.callId), expectedRecent);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reads only validated metadata and silently skips malformed or enriched rows", async () => {
  const { root, workspace, dataDir } = await fixture();
  try {
    const audit = new ToolAuditLog({ workspace, dataDir });
    await audit.record({
      callId: "safe-1",
      tool: "read",
      startedAt: "2026-08-01T10:00:00.000Z",
      durationMs: 12,
      outcome: "success",
      accessMode: "workspace",
    });
    const base = {
      version: 1,
      event: "tool_call",
      tool: "run",
      startedAt: "2026-08-01T10:00:01.000Z",
      durationMs: 7,
      outcome: "success",
      accessMode: "full-access",
    };
    await fs.appendFile(audit.logPath, [
      JSON.stringify({
        ...base,
        callId: "enriched",
        args: "--password super-secret",
        output: "super-secret output",
        path: "/private/super-secret",
        prompt: "super-secret prompt",
      }),
      '{"prompt":"super-secret malformed",not-json}',
      JSON.stringify({ ...base, callId: "safe-2", exitCode: 0, truncated: false }),
      '{"version":1,"event":"tool_call","callId":"unfinished","prompt":"super-secret"',
    ].join("\n"), "utf8");

    const events = await audit.readRecent(20);
    assert.deepEqual(events.map((event) => event.callId), ["safe-1", "safe-2"]);
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /super-secret|args|output|path|prompt/u);
    assert.ok(events.every((event) => Object.keys(event).every((key) => [
      "version", "event", "callId", "agentId", "sessionId", "tool", "startedAt", "durationMs",
      "outcome", "accessMode", "exitCode", "timedOut", "cancelled", "truncated",
    ].includes(key))));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bounds recent audit reads and returns an empty list before the first event", async () => {
  const { root, workspace, dataDir } = await fixture();
  try {
    const audit = new ToolAuditLog({ workspace, dataDir });
    assert.deepEqual(await audit.readRecent(1), []);
    assert.throws(() => audit.readRecent(0), /between 1 and 200/u);
    assert.throws(() => audit.readRecent(201), /between 1 and 200/u);
    assert.throws(() => audit.readRecent(1.5), /between 1 and 200/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent events across audit instances", async () => {
  const { root, workspace, dataDir } = await fixture();
  try {
    const first = new ToolAuditLog({ workspace, dataDir });
    const second = new ToolAuditLog({ workspace, dataDir });
    await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? first : second).record({
      callId: `call-${index}`,
      tool: index % 2 ? "grep" : "read",
      startedAt: new Date(1_700_000_000_000 + index).toISOString(),
      durationMs: index,
      outcome: index % 3 ? "success" : "error",
      accessMode: "workspace",
      exitCode: index % 3 ? 0 : 1,
      timedOut: false,
      truncated: index % 5 === 0,
    })));

    const events = (await fs.readFile(first.logPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.length, 40);
    assert.deepEqual(new Set(events.map((event) => event.callId)), new Set(Array.from({ length: 40 }, (_, index) => `call-${index}`)));
    assert.ok(events.every((event) => event.version === 1 && event.event === "tool_call"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe storage and malformed event metadata", async () => {
  const { root, workspace, dataDir } = await fixture();
  try {
    assert.throws(() => new ToolAuditLog({ workspace, dataDir: path.join(workspace, ".pilink") }), /must not be stored/);
    assert.throws(() => new ToolAuditLog({ workspace, dataDir, maximumBytes: 0 }), /positive safe integer/);
    const audit = new ToolAuditLog({ workspace, dataDir });
    for (const event of [
      { callId: "", tool: "read", startedAt: new Date().toISOString(), durationMs: 1, outcome: "success", accessMode: "workspace" },
      { callId: "c", tool: "", startedAt: new Date().toISOString(), durationMs: 1, outcome: "success", accessMode: "workspace" },
      { callId: "c", tool: "read", startedAt: "not-a-date", durationMs: 1, outcome: "success", accessMode: "workspace" },
      { callId: "c", tool: "read", startedAt: new Date().toISOString(), durationMs: -1, outcome: "success", accessMode: "workspace" },
      { callId: "c", tool: "read", startedAt: new Date().toISOString(), durationMs: 1, outcome: "unknown", accessMode: "workspace" },
      { callId: "c", tool: "read", startedAt: new Date().toISOString(), durationMs: 1, outcome: "success", accessMode: "unsafe" },
    ]) assert.throws(() => audit.record(event));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
