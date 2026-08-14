import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const guidePath = path.join(root, "docs", "operations", "mode-selection.md");

test("mode guide states the three-entry contract and capability split", () => {
  const guide = fs.readFileSync(guidePath, "utf8");
  const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");

  for (const value of ["single", "collaboration", "vscode"]) {
    assert.match(guide, new RegExp(`\\b${value}\\b`), `mode guide must name ${value}`);
  }
  assert.match(guide, /PI_RUNTIME_MODE.*single.*collaboration/s);
  assert.match(guide, /vscode.*(?:not|should not).*PI_RUNTIME_MODE|PI_RUNTIME_MODE.*vscode/s);
  assert.match(guide, /pilink start --mode single/);
  assert.match(guide, /pilink start --mode collaboration/);
  assert.match(guide, /public chat.*tasks.*memory.*work-loop/s);
  assert.match(guide, /ChatGPT MCP.*Pi Local/s);
  assert.match(guide, /PI_CHAT_CLI=off/);
  assert.match(guide, /Migration from the pre-mode release/);
  assert.match(envExample, /^PI_RUNTIME_MODE=(?:single|collaboration)$/m);
});

test("CLI help exposes the three entries and rejects vscode as a server mode", () => {
  const cliPath = path.join(root, "dist", "cli.js");
  const help = spawnSync(process.execPath, [cliPath, "start", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stderr, /start --mode single/);
  assert.match(help.stderr, /start --mode collaboration/);
  assert.match(help.stderr, /start --mode vscode/);
  assert.match(help.stderr, /serve --mode <single\|collaboration>/);

  const invalid = spawnSync(process.execPath, [cliPath, "serve", "--mode", "vscode"], { encoding: "utf8" });
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.match(`${invalid.stdout}\n${invalid.stderr}`, /serve.*only single or collaboration/i);
});
