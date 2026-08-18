import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureCliLink } from "../dist/ensure-cli-link.js";

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilink-cli-migration-"));
  const bin = path.join(home, "bin");
  const dist = path.join(home, "PiLink", "dist");
  const previousCli = path.join(dist, "cli.js");
  const launcher = path.join(dist, "terminal-launcher.js");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(previousCli, "#!/usr/bin/env node\n", { mode: 0o700 });
  fs.writeFileSync(launcher, "#!/usr/bin/env node\n", { mode: 0o700 });
  return { home, bin, previousCli, launcher };
}

function assertGeneratedPosixLauncher(linkPath, launcher) {
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), false);
  const content = fs.readFileSync(linkPath, "utf8");
  assert.match(content, /^#!\/bin\/sh\n# PILINK_GENERATED_SOURCE_LAUNCHER_V1\n/u);
  assert.match(content, new RegExp(launcher.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
}

test("source build migrates the previous PiLink cli symlink to a repairable launcher", {
  skip: process.platform === "win32",
}, () => {
  const { home, bin, previousCli, launcher } = fixture();
  const linkPath = path.join(bin, "pilink");
  fs.symlinkSync(previousCli, linkPath, "file");
  try {
    const result = ensureCliLink({
      cliTarget: launcher,
      homeDirectory: home,
      pathValue: bin,
      platform: process.platform,
      env: {},
      info: () => {},
      warn: () => {},
    });
    assert.equal(result.status, "linked");
    assertGeneratedPosixLauncher(linkPath, launcher);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("source build repairs a dangling previous PiLink cli symlink", {
  skip: process.platform === "win32",
}, () => {
  const { home, bin, previousCli, launcher } = fixture();
  const linkPath = path.join(bin, "pilink");
  fs.symlinkSync(previousCli, linkPath, "file");
  fs.unlinkSync(previousCli);
  try {
    const result = ensureCliLink({
      cliTarget: launcher,
      homeDirectory: home,
      pathValue: bin,
      platform: process.platform,
      env: {},
      info: () => {},
      warn: () => {},
    });
    assert.equal(result.status, "linked");
    assertGeneratedPosixLauncher(linkPath, launcher);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("source build rewrites a generated launcher after the checkout path changes", {
  skip: process.platform === "win32",
}, () => {
  const { home, bin, launcher } = fixture();
  const linkPath = path.join(bin, "pilink");
  fs.writeFileSync(
    linkPath,
    "#!/bin/sh\n# PILINK_GENERATED_SOURCE_LAUNCHER_V1\nexec '/old/PiLink/dist/terminal-launcher.js' \"$@\"\n",
    { mode: 0o700 },
  );
  try {
    const result = ensureCliLink({
      cliTarget: launcher,
      homeDirectory: home,
      pathValue: bin,
      platform: process.platform,
      env: {},
      info: () => {},
      warn: () => {},
    });
    assert.equal(result.status, "linked");
    assertGeneratedPosixLauncher(linkPath, launcher);
    assert.doesNotMatch(fs.readFileSync(linkPath, "utf8"), /\/old\/PiLink/u);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("source build still refuses an unrelated symlink", {
  skip: process.platform === "win32",
}, () => {
  const { home, bin, launcher } = fixture();
  const unrelated = path.join(home, "unrelated-command");
  const linkPath = path.join(bin, "pilink");
  fs.writeFileSync(unrelated, "#!/bin/sh\n", { mode: 0o700 });
  fs.symlinkSync(unrelated, linkPath, "file");
  try {
    const result = ensureCliLink({
      cliTarget: launcher,
      homeDirectory: home,
      pathValue: bin,
      platform: process.platform,
      env: {},
      info: () => {},
      warn: () => {},
    });
    assert.equal(result.status, "conflict");
    assert.equal(fs.realpathSync(linkPath), fs.realpathSync(unrelated));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
