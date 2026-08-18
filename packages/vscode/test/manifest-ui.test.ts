import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  displayName?: string;
  description?: string;
  capabilities?: { untrustedWorkspaces?: { restrictedConfigurations?: string[] } };
  contributes?: {
    commands?: Array<{ command?: string; title?: string; category?: string }>;
    configuration?: { title?: string; properties?: Record<string, unknown> };
    viewsContainers?: { secondarySidebar?: Array<{ title?: string }> };
    views?: Record<string, Array<{ name?: string }>>;
  };
};

const commands = manifest.contributes?.commands || [];
const commandIds = commands.map((entry) => entry.command);

test("the extension presents itself as PiLink's MCP bridge", () => {
  assert.equal(manifest.displayName, "PiLink — MCP Bridge");
  assert.match(manifest.description || "", /Start, connect, and monitor the PiLink MCP bridge/);
  assert.equal(manifest.contributes?.viewsContainers?.secondarySidebar?.[0]?.title, "PiLink");
  assert.equal(manifest.contributes?.views?.vspilinkSecondaryViewContainer?.[0]?.name, "PiLink");
  assert.equal(manifest.contributes?.configuration?.title, "PiLink");
  for (const command of commands) assert.equal(command.category, "PiLink");
});

test("the command palette exposes only ordinary recovery and navigation entry points", () => {
  assert.deepEqual(commandIds, [
    "vspilink.openSidebar",
    "vspilink.openPanel",
    "vspilink.connectChatGpt",
    "vspilink.stop",
    "vspilink.guidedSetup",
    "vspilink.openConfig",
    "vspilink.refresh",
    "vspilink.useWorkspace",
    "vspilink.openDocs",
  ]);
});

test("state-sensitive, dangerous and specialist commands are not promoted into the palette", () => {
  const hidden = [
    "vspilink.start",
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
  for (const command of hidden) assert.ok(!commandIds.includes(command), `${command} must stay out of the ordinary palette`);
});

test("specialist native-MCP scope is no longer a user-facing setting", () => {
  const properties = manifest.contributes?.configuration?.properties || {};
  assert.ok(!("vspilink.nativeMcpScope" in properties));
  assert.ok(!(manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations || []).includes("vspilink.nativeMcpScope"));
  assert.deepEqual(Object.keys(properties), [
    "vspilink.openOnStartup",
    "vspilink.configPath",
    "vspilink.nodeExecutable",
  ]);
});
