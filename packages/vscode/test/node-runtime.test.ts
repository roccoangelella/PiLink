import assert from "node:assert/strict";
import test from "node:test";
import { resolveSidecarNodeRuntime } from "../src/node-runtime.js";

test("an explicitly configured exact Node runtime is authoritative", () => {
  const observed: string[] = [];
  const runtime = resolveSidecarNodeRuntime({
    configured: "/opt/node-24.18.0/bin/node",
    processExecutable: "/opt/vscode/node",
    processVersion: "v22.20.0",
    detectVersion: (executable) => {
      observed.push(executable);
      return "v24.18.0";
    },
  });

  assert.deepEqual(runtime, {
    ok: true,
    executable: "/opt/node-24.18.0/bin/node",
    version: "v24.18.0",
    source: "configured",
  });
  assert.deepEqual(observed, ["/opt/node-24.18.0/bin/node"]);
});

test("a configured incompatible runtime never silently falls back", () => {
  const runtime = resolveSidecarNodeRuntime({
    configured: "/opt/node/bin/node",
    processExecutable: "/opt/vscode/node",
    processVersion: "v24.18.0",
    detectVersion: () => "v24.18.1",
  });

  if (runtime.ok) assert.fail("expected the incompatible configured runtime to be rejected");
  assert.equal(runtime.version, "v24.18.1");
  assert.match(runtime.error, /requires exactly Node 24\.18\.0/);
});

test("automatic selection prefers an exact external Node from PATH", () => {
  const runtime = resolveSidecarNodeRuntime({
    processExecutable: "/opt/vscode/node",
    processVersion: "v22.20.0",
    detectVersion: (executable) => executable === "node" ? "v24.18.0" : "",
  });

  assert.deepEqual(runtime, {
    ok: true,
    executable: "node",
    version: "v24.18.0",
    source: "path",
  });
});

test("the extension-host executable is only a fallback when it is exact", () => {
  const runtime = resolveSidecarNodeRuntime({
    processExecutable: "/opt/vscode/node",
    processVersion: "v24.18.0",
    detectVersion: () => "v23.0.0",
  });

  assert.deepEqual(runtime, {
    ok: true,
    executable: "/opt/vscode/node",
    version: "v24.18.0",
    source: "extension-host",
  });
});

test("GUI runtime discovery validates the exact nvm installation when PATH is stale", () => {
  const home = "/home/operator";
  const expected = `${home}/.nvm/versions/node/v24.18.0/bin/node`;
  const observed: string[] = [];
  const runtime = resolveSidecarNodeRuntime({
    home,
    processExecutable: "/opt/vscode/node",
    processVersion: "v22.20.0",
    detectVersion: (executable) => {
      observed.push(executable);
      return executable === expected ? "v24.18.0" : executable === "node" ? "v22.20.0" : "";
    },
  });

  assert.deepEqual(runtime, {
    ok: true,
    executable: expected,
    version: "v24.18.0",
    source: "known-install",
  });
  assert.equal(observed[0], "node");
  assert.ok(observed.includes(expected));
});

test("GUI runtime discovery prefers the managed per-user VSPiLink runtime", () => {
  const home = "/home/operator";
  const expected = `${home}/.local/share/vspilink/node-v24.18.0/bin/node`;
  const runtime = resolveSidecarNodeRuntime({
    home,
    processExecutable: "/opt/vscode/node",
    processVersion: "v22.20.0",
    detectVersion: (executable) => executable === expected ? "v24.18.0" : "",
  });

  assert.deepEqual(runtime, {
    ok: true,
    executable: expected,
    version: "v24.18.0",
    source: "known-install",
  });
});

test("managed runtime discovery follows XDG_DATA_HOME", () => {
  const expected = "/srv/operator-data/vspilink/node-v24.18.0/bin/node";
  const runtime = resolveSidecarNodeRuntime({
    home: "/home/operator",
    xdgDataHome: "/srv/operator-data",
    processExecutable: "/opt/vscode/node",
    processVersion: "v22.20.0",
    detectVersion: (executable) => executable === expected ? "v24.18.0" : "",
  });

  assert.deepEqual(runtime, {
    ok: true,
    executable: expected,
    version: "v24.18.0",
    source: "known-install",
  });
});

test("GUI runtime discovery finds the managed Windows VSPiLink runtime", () => {
  const expected = "C:\\Users\\operator\\AppData\\Local/VSPiLink/node-v24.18.0/node.exe";
  const runtime = resolveSidecarNodeRuntime({
    home: "/home/operator",
    localAppData: "C:\\Users\\operator\\AppData\\Local",
    processExecutable: "/opt/vscode/node",
    processVersion: "v22.20.0",
    detectVersion: (executable) => executable === expected ? "v24.18.0" : "",
  });

  assert.deepEqual(runtime, {
    ok: true,
    executable: expected,
    version: "v24.18.0",
    source: "known-install",
  });
});

test("known install shims are never accepted without exact version validation", () => {
  const runtime = resolveSidecarNodeRuntime({
    home: "/home/operator",
    processExecutable: "/opt/vscode/node",
    processVersion: "v22.20.0",
    detectVersion: (executable) => executable.includes(".volta") ? "v24.18.1" : "v18.20.0",
  });

  if (runtime.ok) assert.fail("expected all non-exact candidates to be rejected");
  assert.match(runtime.error, /Exactly Node 24\.18\.0 is not available/);
});

test("selection reports a sidecar error without rejecting the extension-host runtime", () => {
  const runtime = resolveSidecarNodeRuntime({
    processExecutable: "/opt/vscode/node",
    processVersion: "v22.20.0",
    detectVersion: () => "v24.17.0",
  });

  if (runtime.ok) assert.fail("expected sidecar runtime selection to fail");
  assert.equal(runtime.version, "v24.17.0");
  assert.match(runtime.error, /Exactly Node 24\.18\.0 is not available for the VSPiLink helper process/);
  assert.match(runtime.error, /extension-host runtime \(v22\.20\.0\) remains independent/);
});
