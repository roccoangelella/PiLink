import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enableGatewayBrowserWake, gatewayBrowserExtensionNeedsReload, loadedGatewayBrowserExtension, pauseGatewayBrowserWake, rememberGatewayBrowserExtensionSource, stageGatewayBrowserExtension } from "../dist/llm-gateway-browser-setup.js";

const source = fileURLToPath(new URL("../browser-extension/", import.meta.url));

test("setup stages only the narrowly scoped Chrome/Brave extension and is idempotent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-browser-stage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "data", "browser-extension");
  assert.equal(stageGatewayBrowserExtension({ source, destination }), destination);
  const manifest = JSON.parse(await fs.readFile(path.join(destination, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://chatgpt.com/*"]);
  assert.equal(await fs.readFile(path.join(destination, "wake.js"), "utf8"),
    await fs.readFile(path.join(source, "wake.js"), "utf8"));
  assert.equal(stageGatewayBrowserExtension({ source, destination }), destination);
  rememberGatewayBrowserExtensionSource(destination, fileURLToPath(new URL("../", import.meta.url)));
  const saved = JSON.parse(await fs.readFile(path.join(destination, ".pilink-source.json"), "utf8"));
  assert.equal(saved.source_root, await fs.realpath(fileURLToPath(new URL("../", import.meta.url))));
  assert.equal(stageGatewayBrowserExtension({ source, destination }), destination);
  await fs.writeFile(path.join(destination, ".pilink-source.json"), JSON.stringify({ source_root: root }));
  assert.throws(() => stageGatewayBrowserExtension({ source, destination }), /another PiLink checkout/);
  const stat = await fs.stat(destination);
  assert.equal(stat.mode & 0o777, 0o700);
});

test("staged extension pins the configured connection name rather than accepting other wake phrases", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-custom-wake-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "browser-extension");
  stageGatewayBrowserExtension({ source, destination, connectorName: "My Coding Connector" });
  const script = await fs.readFile(path.join(destination, "wake.js"), "utf8");
  assert.match(script, /const WAKE_TEXT = "@My Coding Connector wake up";/);
  assert.doesNotMatch(script, /const WAKE_TEXT = "@PiLink Gateway wake up";/);
  assert.equal(stageGatewayBrowserExtension({ source, destination, connectorName: "My Coding Connector" }), destination);
  assert.equal(await fs.readFile(path.join(destination, "wake.js"), "utf8"), script);
  assert.equal(gatewayBrowserExtensionNeedsReload(destination), false);
  rememberGatewayBrowserExtensionSource(destination);
  stageGatewayBrowserExtension({ source, destination, connectorName: "PiLink Gateway" });
  assert.match(await fs.readFile(path.join(destination, "wake.js"), "utf8"), /const WAKE_TEXT = "@PiLink Gateway wake up";/);
  assert.equal(gatewayBrowserExtensionNeedsReload(destination), true, "a changed approved content script must require a browser reload");
  stageGatewayBrowserExtension({ source, destination, connectorName: "PiLink Gateway" });
  assert.equal(gatewayBrowserExtensionNeedsReload(destination), true, "a later launch must not silently clear the reload requirement");
});

test("rebuilding an approved extension preserves its configured wake name", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-custom-wake-build-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "data", "pilink", "browser-extension");
  const config = path.join(root, "config", ".env");
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, "PI_LLM_GATEWAY_CONNECTOR_NAME=My Coding Connector\n", { mode: 0o600 });
  stageGatewayBrowserExtension({ source, destination, connectorName: "My Coding Connector" });
  rememberGatewayBrowserExtensionSource(destination);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/build-browser-extension.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8",
    env: { ...process.env, XDG_DATA_HOME: path.join(root, "data"), PILINK_CONFIG: config,
      PI_LLM_GATEWAY_CONNECTOR_NAME: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(await fs.readFile(path.join(destination, "wake.js"), "utf8"), /const WAKE_TEXT = "@My Coding Connector wake up";/);
});

test("an unpacked extension already loaded by Brave enables wake without a second yes", async (t) => {
  if (process.platform !== "linux") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-browser-already-loaded-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "staged");
  const profileRoot = path.join(root, "Brave-Browser");
  const profile = path.join(profileRoot, "Default");
  await fs.mkdir(profile, { recursive: true });
  stageGatewayBrowserExtension({ source, destination });
  const entry = { location: 4, path: destination, active_permissions: { scriptable_host: ["https://chatgpt.com/*"] }, withholding_permissions: false };
  const pref = path.join(profile, "Preferences");
  const save = (value) => fs.writeFile(pref, JSON.stringify({ extensions: { settings: { unrelated: { location: 4, path: "/nonexistent/extension" }, pilink: value } } }));
  assert.equal(loadedGatewayBrowserExtension({ destination, profileRoot }), false);
  await save(entry);
  assert.equal(loadedGatewayBrowserExtension({ destination, profileRoot }), true);
  await save({ ...entry, state: 0 });
  assert.equal(loadedGatewayBrowserExtension({ destination, profileRoot }), false);
  await save({ ...entry, path: path.join(root, "another-extension") });
  assert.equal(loadedGatewayBrowserExtension({ destination, profileRoot }), false);
  await save({ ...entry, active_permissions: { scriptable_host: ["https://example.com/*"] } });
  assert.equal(loadedGatewayBrowserExtension({ destination, profileRoot }), false);
});

test("setup refuses to overwrite a symlink destination", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-browser-symlink-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const link = path.join(root, "link");
  await fs.symlink(root, link);
  assert.throws(() => stageGatewayBrowserExtension({ source, destination: link }), /symlink/);
});

test("opt-in writes only to the selected private PiLink config after setup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-browser-enable-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, ".env");
  await fs.writeFile(config, "JWT_SECRET=placeholder\nPI_LLM_GATEWAY_AUTO_WAKE=false\n", { mode: 0o600 });
  enableGatewayBrowserWake(config);
  pauseGatewayBrowserWake(config);
  assert.match(await fs.readFile(config, "utf8"), /PI_LLM_GATEWAY_AUTO_WAKE=false/);
  enableGatewayBrowserWake(config);
  assert.match(await fs.readFile(config, "utf8"), /JWT_SECRET=placeholder/);
  assert.equal((await fs.readFile(config, "utf8")).match(/PI_LLM_GATEWAY_AUTO_WAKE=/g).length, 1);
  assert.match(await fs.readFile(config, "utf8"), /PI_LLM_GATEWAY_AUTO_WAKE=true/);
  assert.equal((await fs.stat(config)).mode & 0o777, 0o600);
  const link = path.join(root, "symlink");
  await fs.symlink(config, link);
  assert.throws(() => enableGatewayBrowserWake(link), /regular private file/);
});
