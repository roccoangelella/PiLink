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

test("source build migrates the previous PiLink cli symlink to the terminal launcher", {
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
    assert.equal(fs.realpathSync(linkPath), fs.realpathSync(launcher));
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
