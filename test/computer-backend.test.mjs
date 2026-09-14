import assert from "node:assert/strict";
import test from "node:test";
import { createSystemComputerBackend, parsePngSize } from "../dist/computer.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1xkAAAAASUVORK5CYII=",
  "base64",
);

test("PNG geometry is parsed without external image tooling", () => {
  assert.deepEqual(parsePngSize(PNG_1X1), { width: 1, height: 1 });
  assert.throws(() => parsePngSize(Buffer.from("not a png")), /valid PNG/);
});

test("Computer Use v1 fails closed on Wayland and unsupported platforms", async () => {
  const wayland = createSystemComputerBackend(
    { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland" },
    "linux",
  );
  await assert.rejects(() => wayland.observe(), /does not inject input into Wayland/);

  const macos = createSystemComputerBackend({}, "darwin");
  await assert.rejects(() => macos.observe(), /not implemented/);
});
