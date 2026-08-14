import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadRuntimeConfig, RUNTIME_MODES } from "../dist/config.js";

test("runtime mode defaults compatibly and accepts only explicit product modes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-runtime-mode-"));
  try {
    const base = {
      PI_WORK_DIR: root,
      PILINK_CONFIG: path.join(root, "pilink.env"),
      JWT_SECRET: "j".repeat(32),
      PI_BOOTSTRAP_SECRET: "b".repeat(32),
    };

    assert.deepEqual(RUNTIME_MODES, ["single", "collaboration"]);
    assert.equal(loadRuntimeConfig(base).runtimeMode, "collaboration");
    assert.equal(loadRuntimeConfig({ ...base, PI_RUNTIME_MODE: "single" }).runtimeMode, "single");
    assert.equal(loadRuntimeConfig({ ...base, PI_RUNTIME_MODE: "collaboration" }).runtimeMode, "collaboration");
    assert.throws(
      () => loadRuntimeConfig({ ...base, PI_RUNTIME_MODE: "vscode" }),
      /PI_RUNTIME_MODE must be 'single' or 'collaboration'/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
