import assert from "node:assert/strict";
import test from "node:test";

import { CLOUDFLARED_VERSION, resolveCloudflaredRelease } from "../dist/hosting/cloudflared-release.js";

test("cloudflared release metadata keeps Linux and Windows first-run downloads pinned", () => {
  assert.equal(CLOUDFLARED_VERSION, "2026.7.2");
  assert.deepEqual(resolveCloudflaredRelease("linux", "x64"), {
    asset: "cloudflared-linux-amd64",
    sha256: "ec905ea7b7e327ff8abdde8cb64697a2152de74dbcdbf6aec9db8364eb3886cd",
  });
  assert.deepEqual(resolveCloudflaredRelease("linux", "arm64"), {
    asset: "cloudflared-linux-arm64",
    sha256: "405df476437e027fc6d18729a5a77155c0a33a6082aeee60a799a688f3052e66",
  });
  assert.deepEqual(resolveCloudflaredRelease("win32", "x64"), {
    asset: "cloudflared-windows-amd64.exe",
    sha256: "cdb5d4432f6ae1595654a692a51308b69d2bf7af961f5578d9391837cf072df9",
  });
});

test("automatic cloudflared installation fails closed on unsupported targets", () => {
  assert.throws(
    () => resolveCloudflaredRelease("win32", "arm64"),
    /unsupported for Windows architecture 'arm64'/,
  );
  assert.throws(
    () => resolveCloudflaredRelease("darwin", "arm64"),
    /unsupported on platform 'darwin'/,
  );
});
