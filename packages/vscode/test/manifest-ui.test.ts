import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  description?: string;
  contributes?: {
    commands?: Array<{ command?: string; title?: string }>;
    viewsContainers?: { secondarySidebar?: Array<{ title?: string }> };
    views?: Record<string, Array<{ name?: string }>>;
  };
};

const commands = manifest.contributes?.commands || [];
const commandIds = commands.map((entry) => entry.command);

test("the extension describes itself as a PiLink bridge control surface", () => {
  assert.match(manifest.description || "", /Start, connect, and manage the PiLink MCP bridge/);
  assert.equal(manifest.contributes?.viewsContainers?.secondarySidebar?.[0]?.title, "PiLink");
  assert.equal(manifest.contributes?.views?.vspilinkSecondaryViewContainer?.[0]?.name, "PiLink");
});

test("the command palette exposes only ordinary lifecycle and recovery entry points", () => {
  assert.deepEqual(commandIds, [
    "vspilink.openSidebar",
    "vspilink.openPanel",
    "vspilink.connectChatGpt",
    "vspilink.start",
    "vspilink.stop",
    "vspilink.guidedSetup",
    "vspilink.openConfig",
    "vspilink.refresh",
    "vspilink.useWorkspace",
    "vspilink.openDocs",
  ]);
});

test("dangerous and specialist commands are not promoted into the palette", () => {
  const hidden = [
    "vspilink.startUnsafe",
    "vspilink.selectRuntimeMode",
    "vspilink.registerClient",
    "vspilink.connectNativeMcp",
    "vspilink.openCollaborationMonitor",
    "vspilink.configureAgents",
    "vspilink.spawnAgent",
    "vspilink.reset",
    "vspilink.legacySetup",
  ];
  for (const command of hidden) assert.ok(!commandIds.includes(command), `${command} must stay behind the dashboard's Advanced UI`);
});
