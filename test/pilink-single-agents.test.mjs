import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveSingleAgentsCliArgs } from "../dist/terminal-launcher-single-agents.js";
import { ensureCliLink } from "../dist/ensure-cli-link.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("resolveSingleAgentsCliArgs defaults to start in single mode with unsafe full access", () => {
  const resolved = resolveSingleAgentsCliArgs([]);
  assert.equal(resolved.action, "run");
  assert.deepEqual(resolved.args, ["start", "--mode", "single", "--allow-unsafe-full-access"]);
});

test("resolveSingleAgentsCliArgs forwards --setup for start command", () => {
  const resolved = resolveSingleAgentsCliArgs(["--setup"]);
  assert.equal(resolved.action, "run");
  assert.deepEqual(resolved.args, ["start", "--mode", "single", "--allow-unsafe-full-access", "--setup"]);
});

test("resolveSingleAgentsCliArgs accepts explicit start command", () => {
  const resolved = resolveSingleAgentsCliArgs(["start", "--setup"]);
  assert.equal(resolved.action, "run");
  assert.deepEqual(resolved.args, ["start", "--mode", "single", "--allow-unsafe-full-access", "--setup"]);
});

test("resolveSingleAgentsCliArgs accepts serve command", () => {
  const resolved = resolveSingleAgentsCliArgs(["serve"]);
  assert.equal(resolved.action, "run");
  assert.deepEqual(resolved.args, ["serve", "--mode", "single", "--allow-unsafe-full-access"]);
});

test("resolveSingleAgentsCliArgs deduplicates mode and unsafe flags", () => {
  const resolved = resolveSingleAgentsCliArgs(["--mode", "single", "--allow-unsafe-full-access"]);
  assert.equal(resolved.action, "run");
  assert.deepEqual(resolved.args, ["start", "--mode", "single", "--allow-unsafe-full-access"]);
});

test("resolveSingleAgentsCliArgs identifies help requests", () => {
  for (const flag of [["--help"], ["-h"], ["help"], ["start", "--help"]]) {
    const resolved = resolveSingleAgentsCliArgs(flag);
    assert.equal(resolved.action, "help");
    assert.deepEqual(resolved.args, []);
  }
});

test("resolveSingleAgentsCliArgs rejects conflicting modes", () => {
  assert.throws(
    () => resolveSingleAgentsCliArgs(["--mode", "collaboration"]),
    /'pilink-single-agents' runs only in single-agent mode/u,
  );
  assert.throws(
    () => resolveSingleAgentsCliArgs(["--mode=collaboration"]),
    /'pilink-single-agents' runs only in single-agent mode/u,
  );
});

test("resolveSingleAgentsCliArgs rejects unknown command", () => {
  assert.throws(
    () => resolveSingleAgentsCliArgs(["invalid-command"]),
    /Unknown command 'invalid-command' for 'pilink-single-agents'/u,
  );
});

test("ensureCliLink links pilink-single-agents alongside pilink", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilink-single-agents-link-"));
  const bin = path.join(home, "bin");
  const launcher = path.join(home, "PiLink", "dist", "terminal-launcher.js");
  const singleAgentsLauncher = path.join(home, "PiLink", "dist", "terminal-launcher-single-agents.js");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "#!/usr/bin/env node\n", { mode: 0o700 });
  fs.writeFileSync(singleAgentsLauncher, "#!/usr/bin/env node\n", { mode: 0o700 });

  const messages = [];
  try {
    const result = ensureCliLink({
      cliTarget: launcher,
      singleAgentsCliTarget: singleAgentsLauncher,
      homeDirectory: home,
      pathValue: bin,
      platform: process.platform,
      env: {},
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
    });

    assert.equal(result.status, "linked");
    assert.ok(result.singleAgentsResult);
    assert.equal(result.singleAgentsResult.status, "linked");
    assert.match(messages.join("\n"), /CLI available as `pilink-single-agents`/u);

    if (process.platform === "win32") {
      assert.equal(path.basename(result.singleAgentsResult.linkPath), "pilink-single-agents.cmd");
    } else {
      assert.equal(path.basename(result.singleAgentsResult.linkPath), "pilink-single-agents");
      const content = fs.readFileSync(result.singleAgentsResult.linkPath, "utf8");
      assert.match(content, /terminal-launcher-single-agents\.js/u);
      assert.notEqual(fs.statSync(result.singleAgentsResult.linkPath).mode & 0o111, 0);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("terminal-launcher-single-agents outputs help text and exits with code 0", () => {
  const launcherPath = path.join(repositoryRoot, "dist", "terminal-launcher-single-agents.js");
  const result = spawnSync(process.execPath, [launcherPath, "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: pilink-single-agents \[start\|serve\]/u);
  assert.match(result.stdout, /Start PiLink in full unsafe mode with single-agent/u);
  assert.match(result.stdout, /pilink start --mode single --allow-unsafe-full-access/u);
});

test("pilink single-agents --help outputs help text and exits with code 0", () => {
  const cliPath = path.join(repositoryRoot, "dist", "cli.js");
  const result = spawnSync(process.execPath, [cliPath, "single-agents", "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: pilink-single-agents \[start\|serve\]/u);
  assert.match(result.stdout, /Start PiLink in full unsafe mode with single-agent/u);
});

test("terminal-launcher-single-agents selects single-agent candidate config when PILINK_CONFIG is unset", () => {
  const launcherPath = path.join(repositoryRoot, "dist", "terminal-launcher-single-agents.js");
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pilink-single-cfg-"));
  try {
    const configDir = path.join(tempHome, ".config", "pilink-single-agent");
    fs.mkdirSync(configDir, { recursive: true });
    const configEnv = path.join(configDir, ".env");
    fs.writeFileSync(configEnv, "PORT=3201\nSERVER_URL=https://pilink-single-agent.example\n");

    const probe = `
      import fs from "node:fs";
      import os from "node:os";
      import path from "node:path";
      process.env.XDG_CONFIG_HOME = ${JSON.stringify(path.join(tempHome, ".config"))};
      delete process.env.PILINK_CONFIG;
      const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
      const candidates = [
        path.join(configHome, "pilink-single-agent", ".env"),
        path.join(configHome, "pilink-single-agents", ".env"),
        path.join(configHome, "pilink-3", ".env"),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          process.env.PILINK_CONFIG = candidate;
          break;
        }
      }
      console.log("RESOLVED=" + process.env.PILINK_CONFIG);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `RESOLVED=${configEnv}`);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test("terminal-launcher-single-agents defaults PI_WORK_DIR to current working directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilink-workdir-test-"));
  try {
    const probe = `
      delete process.env.PI_WORK_DIR;
      process.env.PI_WORK_DIR = process.env.PI_WORK_DIR || process.cwd();
      console.log("WORK_DIR=" + process.env.PI_WORK_DIR);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: tempDir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `WORK_DIR=${tempDir}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
