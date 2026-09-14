import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createSystemComputerBackend, parsePngSize } from "../dist/computer.js";
import { createPiLinkComputerBackend, isWaylandSession } from "../dist/computer-wayland.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1xkAAAAASUVORK5CYII=",
  "base64",
);

test("PNG geometry is parsed without external image tooling", () => {
  assert.deepEqual(parsePngSize(PNG_1X1), { width: 1, height: 1 });
  assert.throws(() => parsePngSize(Buffer.from("not a png")), /valid PNG/);
});

test("PiLink selects the portal backend for Wayland sessions", async () => {
  const env = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland", PATH: "" };
  assert.equal(isWaylandSession(env), true);
  const wayland = createPiLinkComputerBackend(env, "linux");
  assert.equal(wayland.name, "linux-wayland-portal");
  await assert.rejects(() => wayland.observe(), /requires python3/);
});

test("the legacy system backend remains fail-closed on Wayland", async () => {
  const wayland = createSystemComputerBackend(
    { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland" },
    "linux",
  );
  await assert.rejects(() => wayland.observe(), /does not inject input into Wayland/);
});

test("unsupported platforms remain fail-closed", async () => {
  const macos = createPiLinkComputerBackend({}, "darwin");
  await assert.rejects(() => macos.observe(), /not implemented/);
});

test("the packaged Wayland portal helper has valid Python syntax", (t) => {
  const result = spawnSync("python3", ["-m", "py_compile", "src/computer-wayland-helper.py"], {
    encoding: "utf8",
  });
  if (result.error?.code === "ENOENT") {
    t.skip("python3 is unavailable in this test environment");
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
