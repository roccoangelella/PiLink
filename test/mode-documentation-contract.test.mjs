import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const guidePath = path.join(root, "docs", "operations", "mode-selection.md");

test("mode guide distinguishes two runtime modes from four launch experiences", () => {
  const guide = fs.readFileSync(guidePath, "utf8");
  const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");

  for (const value of ["single", "vscode", "collaboration", "cli"]) {
    assert.match(guide, new RegExp(`\\b${value}\\b`), `mode guide must name ${value}`);
  }
  assert.match(guide, /PI_RUNTIME_MODE.*single.*collaboration/s);
  assert.match(guide, /Only `single` and `collaboration` are valid runtime capability modes/s);
  assert.match(guide, /pilink start --mode single/);
  assert.match(guide, /pilink start --mode vscode/);
  assert.match(guide, /pilink start --mode collaboration/);
  assert.match(guide, /pilink start --mode cli/);
  assert.match(guide, /1\. \*\*Single agent\*\*[\s\S]*2\. \*\*VS Code\*\*[\s\S]*3\. \*\*Agents chat\*\*[\s\S]*4\. \*\*CLI pilink-endpoint\*\*/);
  assert.match(guide, /fresh VSPiLink installation.*Single agent/s);
  assert.match(guide, /optional local Pi provider\/runtime.*separate/s);
  assert.match(guide, /PI_CHAT_CLI=off/);
  assert.match(guide, /## Migration/);
  assert.match(envExample, /^PI_RUNTIME_MODE=(?:single|collaboration)$/m);
});

test("CLI help exposes four ordered experiences and keeps VS Code out of serve", () => {
  const cliPath = path.join(root, "dist", "cli.js");
  const help = spawnSync(process.execPath, [cliPath, "start", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stderr, /start --mode single[\s\S]*start --mode vscode[\s\S]*start --mode collaboration[\s\S]*start --mode cli/);
  assert.match(help.stderr, /serve --mode <single\|collaboration\|cli>/);

  const invalid = spawnSync(process.execPath, [cliPath, "serve", "--mode", "vscode"], { encoding: "utf8" });
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.match(`${invalid.stdout}\n${invalid.stderr}`, /serve.*accepts single, collaboration, or cli/i);
});
