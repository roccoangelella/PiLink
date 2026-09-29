import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertNoPinnedReleaseVersionCollision } from "../scripts/release-version-guard.mjs";

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilink-release-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "release");
}

function writePinnedRelease(releaseDirectory, version = "2.2.0") {
  fs.mkdirSync(releaseDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(releaseDirectory, "SHA256SUMS"),
    `${"0".repeat(64)}  pilink-${version}.tgz\n${"1".repeat(64)}  vspilink-${version}.vsix\n`,
  );
}

function check(releaseDirectory, version) {
  assertNoPinnedReleaseVersionCollision({
    releaseDirectory,
    packageName: "pilink",
    extensionName: "vspilink",
    version,
  });
}

test("release guard rejects a checksum-pinned artifact with the same version", (t) => {
  const releaseDirectory = createFixture(t);
  writePinnedRelease(releaseDirectory);
  assert.throws(() => check(releaseDirectory, "2.2.0"), /existing release artifact/u);
});

test("release guard allows a missing release directory", (t) => {
  const releaseDirectory = createFixture(t);
  assert.doesNotThrow(() => check(releaseDirectory, "2.2.0"));
});

test("release guard refuses an existing versioned artifact even without SHA256SUMS", (t) => {
  const releaseDirectory = createFixture(t);
  fs.mkdirSync(releaseDirectory);
  fs.writeFileSync(path.join(releaseDirectory, "vspilink-2.2.0.vsix"), "incomplete stage");
  assert.throws(() => check(releaseDirectory, "2.2.0"), /existing release artifact/u);
});

test("release guard allows staging a different version beside an older pinned release", (t) => {
  const releaseDirectory = createFixture(t);
  writePinnedRelease(releaseDirectory, "2.2.0");
  assert.doesNotThrow(() => check(releaseDirectory, "2.3.0"));
});
