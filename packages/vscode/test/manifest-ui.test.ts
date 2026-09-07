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
    viewsContainers?: { activitybar?: Array<{ title?: string }> };
    views?: Record<string, Array<{ name?: string }>>;
    menus?: { commandPalette?: Array<{ command?: string; when?: string }> };
    mcpServerDefinitionProviders?: unknown[];
  };
};

const commands = manifest.contributes?.commands || [];
const commandIds = commands.map((entry) => entry.command);
const hiddenPaletteCommands = new Set(
  (manifest.contributes?.menus?.commandPalette || [])
    .filter((entry) => entry.when === "false")
    .map((entry) => entry.command),
);
const paletteCommandIds = commandIds.filter((command) => !hiddenPaletteCommands.has(command));

test("the extension presents itself as PiLink's MCP bridge", () => {
  assert.equal(manifest.displayName, "PiLink — MCP Bridge");
  assert.match(manifest.description || "", /Start, connect, and monitor the PiLink MCP bridge/);
  assert.equal(manifest.contributes?.viewsContainers?.activitybar?.[0]?.title, "PiLink");
  assert.equal(manifest.contributes?.views?.vspilinkSecondaryViewContainer?.[0]?.name, "PiLink");
  assert.equal(manifest.contributes?.configuration?.title, "PiLink");
  for (const command of commands) assert.equal(command.category, "PiLink");
});

test("the command palette exposes only ordinary recovery and navigation entry points", () => {
  assert.deepEqual(paletteCommandIds, [
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
    "vspilink.restart",
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
  for (const command of hidden) assert.ok(!paletteCommandIds.includes(command), `${command} must stay out of the ordinary palette`);
  assert.equal(hiddenPaletteCommands.has("vspilink.start"), true);
  assert.equal(hiddenPaletteCommands.has("vspilink.restart"), true);
});

test("specialist native-MCP integration is no longer a user-facing product", () => {
  const properties = manifest.contributes?.configuration?.properties || {};
  assert.ok(!("vspilink.nativeMcpScope" in properties));
  assert.ok(!(manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations || []).includes("vspilink.nativeMcpScope"));
  assert.equal(manifest.contributes?.mcpServerDefinitionProviders, undefined);
  assert.deepEqual(Object.keys(properties), [
    "vspilink.openOnStartup",
    "vspilink.configPath",
    "vspilink.nodeExecutable",
  ]);
});
