import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { kwinWakeFocusScript, prepareKwinWakeFocusGuard } from "../dist/llm-gateway-kwin-focus.js";

function fixture(initialWindow) {
  const previous = initialWindow === undefined ? { resourceClass: "terminal" } : initialWindow;
  const brave = { resourceClass: "brave-browser" };
  const unrelated = { resourceClass: "unrelated" };
  let now = 1000;
  const added = [];
  const activated = [];
  const desktop = {};
  const workspace = {
    activeWindow: previous, currentDesktop: desktop, stackingOrder: [previous, brave, unrelated],
    windowAdded: { connect: (fn) => added.push(fn) },
    windowActivated: { connect: (fn) => activated.push(fn) },
  };
  vm.runInNewContext(kwinWakeFocusScript(), { workspace, Date: { now: () => now } });
  return {
    workspace, previous, brave, unrelated,
    add(window) { for (const fn of added) fn(window); },
    activate(window) { workspace.activeWindow = window; for (const fn of activated) fn(window); },
    emitActivated(window) { for (const fn of activated) fn(window); },
    expire() { now += 6_000; },
  };
}

test("only a newly added Brave window returns focus to the prior window", () => {
  const f = fixture();
  f.add(f.unrelated);
  f.activate(f.unrelated);
  assert.equal(f.workspace.activeWindow, f.unrelated);
  f.add(f.brave);
  f.activate(f.brave);
  assert.equal(f.workspace.activeWindow, f.previous);
  f.activate(f.brave);
  assert.equal(f.workspace.activeWindow, f.brave, "a one-shot guard does not repeatedly steal focus");
});

test("already-active Brave window is restored even if activation preceded windowAdded", () => {
  const f = fixture();
  f.workspace.activeWindow = f.brave;
  f.add(f.brave);
  assert.equal(f.workspace.activeWindow, f.previous);
});

test("user focus changes, desktop changes and destroyed previous window fail closed", () => {
  const switched = fixture();
  switched.add(switched.brave);
  switched.workspace.activeWindow = switched.unrelated;
  switched.emitActivated(switched.brave);
  // A delayed notification for Brave must not override the user's switch.
  assert.equal(switched.workspace.activeWindow, switched.unrelated);

  const desktop = fixture();
  desktop.add(desktop.brave);
  desktop.workspace.currentDesktop = {};
  desktop.activate(desktop.brave);
  assert.equal(desktop.workspace.activeWindow, desktop.brave);

  const destroyed = fixture();
  destroyed.add(destroyed.brave);
  destroyed.workspace.stackingOrder = [destroyed.brave];
  destroyed.activate(destroyed.brave);
  assert.equal(destroyed.workspace.activeWindow, destroyed.brave);
});

test("expired or unowned focus guard does not restore focus", () => {
  for (const f of [fixture(), fixture(null)]) {
    f.expire();
    f.add(f.brave);
    f.activate(f.brave);
    assert.equal(f.workspace.activeWindow, f.brave);
  }
  const noPrevious = fixture(null);
  noPrevious.add(noPrevious.brave);
  noPrevious.activate(noPrevious.brave);
  assert.equal(noPrevious.workspace.activeWindow, noPrevious.brave);
});

test("KWin guard loads and unloads a temporary script via a fake DBus executable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-kwin-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = path.join(root, "calls");
  const fake = path.join(root, "qdbus6");
  await fs.writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$QDBUS_LOG"\ncase "$*" in *loadScript*) printf '0\\n';; esac\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${root}:/usr/bin:/bin`, QDBUS_LOG: log,
    XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE" };
  assert.equal(await prepareKwinWakeFocusGuard({ ...env, XDG_CURRENT_DESKTOP: "GNOME" }), undefined);
  const guard = await prepareKwinWakeFocusGuard(env);
  assert.ok(guard);
  const before = (await fs.readFile(log, "utf8")).trim().split("\n");
  assert.match(before[0], /Scripting\.loadScript .*restore\.js pilink_wake_focus_/);
  assert.match(before[1], /Scripting\/Script0 org\.kde\.kwin\.Script\.run/);
  const script = before[0].split(" ").find((entry) => entry.endsWith("restore.js"));
  await fs.stat(script);
  await guard.close();
  await guard.close();
  assert.match(await fs.readFile(log, "utf8"), /Scripting\.unloadScript pilink_wake_focus_/);
  await assert.rejects(fs.stat(script), { code: "ENOENT" });
});

test("a failed KWin load cleans up and falls back without touching focus", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-kwin-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = path.join(root, "calls");
  await fs.writeFile(path.join(root, "qdbus6"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$QDBUS_LOG"\ncase "$*" in *loadScript*) echo invalid-id;; esac\n',
    { mode: 0o700 });
  const env = { ...process.env, PATH: `${root}:/usr/bin:/bin`, QDBUS_LOG: log,
    XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE" };
  assert.equal(await prepareKwinWakeFocusGuard(env), undefined);
  const calls = await fs.readFile(log, "utf8");
  assert.match(calls, /Scripting\.unloadScript/);
  const script = calls.split("\n")[0].split(" ").find((entry) => entry.endsWith("restore.js"));
  await assert.rejects(fs.stat(script), { code: "ENOENT" });
});
