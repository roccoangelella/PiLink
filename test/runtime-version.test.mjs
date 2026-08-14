import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  REQUIRED_NODE_VERSION,
  assertRequiredNodeVersion,
  isRequiredNodeVersion,
} from "../dist/runtime.js";

test("PiLink requires Node.js 24.18.0 exactly", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.engines.node, REQUIRED_NODE_VERSION);
  assert.equal(REQUIRED_NODE_VERSION, "24.18.0");
  assert.equal(isRequiredNodeVersion("24.18.0"), true);
  assert.equal(isRequiredNodeVersion("v24.18.0"), true);

  for (const version of [
    "v24.17.9",
    "v24.18.1",
    "v24.19.0",
    "v25.0.0",
    "v24.18.0-nightly",
    "24.18",
    "",
  ]) {
    assert.equal(isRequiredNodeVersion(version), false, version);
    assert.throws(() => assertRequiredNodeVersion(version), /requires Node\.js 24\.18\.0 exactly/);
  }

  assert.doesNotThrow(() => assertRequiredNodeVersion("v24.18.0"));
});
