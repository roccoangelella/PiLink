import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));

test("development scripts separate compilation from raw server startup", () => {
  assert.equal(packageJson.scripts.dev, "tsc --watch --preserveWatchOutput");
  assert.equal(packageJson.scripts["dev:server"], "tsx watch src/index.ts");
});

test("source checkout exposes an explicit CLI fallback through the terminal launcher", () => {
  assert.equal(packageJson.scripts.cli, "node dist/terminal-launcher.js");
});
