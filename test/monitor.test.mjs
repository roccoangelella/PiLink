import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HostingMonitor, formatMonitor, monitorPaths, readMonitorSnapshot } from "../dist/monitor.js";

test("monitor reads private metadata-only audit records and durable public chat without rendering terminal controls", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-monitor-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  const paths = monitorPaths(workspace, dataDir);
  await fs.mkdir(path.dirname(paths.toolAuditPath), { recursive: true });
  await fs.writeFile(paths.toolAuditPath, [
    JSON.stringify({ event: "tool_call", startedAt: "2026-08-02T12:00:00.000Z", agentId: "agent-a", tool: "read", outcome: "success", durationMs: 4 }),
    JSON.stringify({ event: "tool_call", startedAt: "2026-08-02T12:00:01.000Z", agentId: "agent-b", tool: "write", outcome: "error", durationMs: 9 }),
    "{incomplete",
  ].join("\n"));
  await fs.writeFile(paths.agentChatPath, JSON.stringify({
    version: 2,
    messages: [
      { cursor: 1, agentName: "Agent\u001b[2J", agentMessage: "first\nmessage" },
      { cursor: 2, agentName: "Agent B", agentMessage: "second message" },
      { cursor: "not-a-number", agentName: "ignored", agentMessage: "ignored" },
    ],
  }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const snapshot = await readMonitorSnapshot(paths);
  assert.deepEqual(snapshot.tools.map((event) => event.tool), ["read", "write"]);
  assert.deepEqual(snapshot.tools.map((event) => event.outcome), ["success", "error"]);
  assert.deepEqual(snapshot.chat.map((message) => message.cursor), [1, 2]);

  const rendered = formatMonitor(snapshot, "agent-swarm", "chat");
  assert.match(rendered, /PUBLIC CHAT/);
  assert.match(rendered, /Agent: first message/);
  assert.doesNotMatch(rendered, /\x1b/);
  assert.doesNotMatch(rendered, /first\nmessage/);
});

test("single-agent monitor exposes only tool-call controls and guidance", () => {
  const snapshot = { tools: [], chat: [] };
  const tools = formatMonitor(snapshot, "single-agent", "tools");
  const help = formatMonitor(snapshot, "single-agent", "help");

  assert.match(tools, /\[t\] tool calls/);
  assert.doesNotMatch(tools, /\[c\] public chat/);
  assert.doesNotMatch(help, /Public-chat messages/);
});

test("monitor degrades to a bounded one-shot plain status when hosting without a TTY", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-monitor-pipe-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk; });
  const monitor = new HostingMonitor({
    mode: "single-agent",
    workspace,
    dataDir,
    input,
    output,
    refreshIntervalMs: 10,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  monitor.start();
  await waitFor(() => rendered.includes("live monitor requires a TTY"));
  monitor.stop();
  assert.match(rendered, /TOOL CALLS/);
  assert.doesNotMatch(rendered, /\[c\] public chat/);
  assert.doesNotMatch(rendered, /\x1b\[2J/);
});

test("interactive monitor switches views with raw keys and restores the terminal on stop", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-monitor-tty-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  const rawMode = [];
  input.setRawMode = (enabled) => { rawMode.push(enabled); return input; };
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk; });
  const monitor = new HostingMonitor({
    mode: "agent-swarm",
    workspace,
    dataDir,
    input,
    output,
    refreshIntervalMs: 10_000,
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  monitor.start();
  await waitFor(() => rendered.includes("PUBLIC CHAT"));
  input.write("t");
  await waitFor(() => rendered.includes("TOOL CALLS"));
  monitor.stop();

  assert.deepEqual(rawMode, [true, false]);
  assert.match(rendered, /\x1b\[2J\x1b\[H/);
  assert.match(rendered, /\x1b\[\?25h/);
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for monitor output");
}
