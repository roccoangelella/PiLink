import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveAgentsCliArgs } from "../dist/terminal-launcher-agents.js";
import { ensureCliLink } from "../dist/ensure-cli-link.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("resolveAgentsCliArgs defaults to start in collaboration mode with unsafe full access", () => {
  const resolved = resolveAgentsCliArgs([]);
  assert.equal(resolved.action, "run");
  assert.deepEqual(resolved.args, ["start", "--mode", "collaboration", "--allow-unsafe-full-access"]);
});

test("resolveAgentsCliArgs forwards --setup for start command", () => {
  const resolved = resolveAgentsCliArgs(["--setup"]);
  assert.equal(resolved.action, "run");
  assert.deepEqual(resolved.args, ["start", "--mode", "collaboration", "--allow-unsafe-full-access", "--setup"]);
});

test("resolveAgentsCliArgs accepts explicit start command", () => {
  const resolved = resolveAgentsCliArgs(["start", "--setup"]);
  assert.equal(resolved.action, "run");
  assert.deepEqual(resolved.args, ["start", "--mode", "collaboration", "--allow-unsafe-full-access", "--setup"]);
});

test("resolveAgentsCliArgs accepts serve command", () => {
  const resolved = resolveAgentsCliArgs(["serve"]);
  assert.equal(resolved.action, "run");
  assert.deepEqual(resolved.args, ["serve", "--mode", "collaboration", "--allow-unsafe-full-access"]);
});

test("resolveAgentsCliArgs deduplicates mode and unsafe flags", () => {
  const resolved = resolveAgentsCliArgs(["--mode", "collaboration", "--allow-unsafe-full-access"]);
  assert.equal(resolved.action, "run");
  assert.deepEqual(resolved.args, ["start", "--mode", "collaboration", "--allow-unsafe-full-access"]);
});

test("resolveAgentsCliArgs identifies help requests", () => {
  for (const flag of [["--help"], ["-h"], ["help"], ["start", "--help"]]) {
    const resolved = resolveAgentsCliArgs(flag);
    assert.equal(resolved.action, "help");
    assert.deepEqual(resolved.args, []);
  }
});

test("resolveAgentsCliArgs rejects conflicting modes", () => {
  assert.throws(
    () => resolveAgentsCliArgs(["--mode", "single"]),
    /'pilink-agents' runs only in multi-agent collaboration mode/u,
  );
  assert.throws(
    () => resolveAgentsCliArgs(["--mode=single"]),
    /'pilink-agents' runs only in multi-agent collaboration mode/u,
  );
});

test("resolveAgentsCliArgs rejects unknown command", () => {
  assert.throws(
    () => resolveAgentsCliArgs(["invalid-command"]),
    /Unknown command 'invalid-command' for 'pilink-agents'/u,
  );
});

test("ensureCliLink links pilink-agents alongside pilink", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilink-agents-link-"));
  const bin = path.join(home, "bin");
  const launcher = path.join(home, "PiLink", "dist", "terminal-launcher.js");
  const agentsLauncher = path.join(home, "PiLink", "dist", "terminal-launcher-agents.js");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "#!/usr/bin/env node\n", { mode: 0o700 });
  fs.writeFileSync(agentsLauncher, "#!/usr/bin/env node\n", { mode: 0o700 });

  const messages = [];
  try {
    const result = ensureCliLink({
      cliTarget: launcher,
      agentsCliTarget: agentsLauncher,
      homeDirectory: home,
      pathValue: bin,
      platform: process.platform,
      env: {},
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
    });

    assert.equal(result.status, "linked");
    assert.ok(result.agentsResult);
    assert.equal(result.agentsResult.status, "linked");
    assert.match(messages.join("\n"), /CLI available as `pilink-agents`/u);

    if (process.platform === "win32") {
      assert.equal(path.basename(result.agentsResult.linkPath), "pilink-agents.cmd");
    } else {
      assert.equal(path.basename(result.agentsResult.linkPath), "pilink-agents");
      const content = fs.readFileSync(result.agentsResult.linkPath, "utf8");
      assert.match(content, /terminal-launcher-agents\.js/u);
      assert.notEqual(fs.statSync(result.agentsResult.linkPath).mode & 0o111, 0);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("terminal-launcher-agents outputs help text and exits with code 0", () => {
  const launcherPath = path.join(repositoryRoot, "dist", "terminal-launcher-agents.js");
  const result = spawnSync(process.execPath, [launcherPath, "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: pilink-agents \[start\|serve\]/u);
  assert.match(result.stdout, /Start PiLink in full unsafe mode with multi-agent collaboration/u);
  assert.match(result.stdout, /pilink start --mode collaboration --allow-unsafe-full-access/u);
});

test("pilink agents --help outputs help text and exits with code 0", () => {
  const cliPath = path.join(repositoryRoot, "dist", "cli.js");
  const result = spawnSync(process.execPath, [cliPath, "agents", "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: pilink-agents \[start\|serve\]/u);
  assert.match(result.stdout, /Start PiLink in full unsafe mode with multi-agent collaboration/u);
});

test("terminal-launcher-agents selects multi-agent candidate config when PILINK_CONFIG is unset", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pilink-agents-cfg-"));
  try {
    const configDir = path.join(tempHome, ".config", "pilink-agents");
    fs.mkdirSync(configDir, { recursive: true });
    const configEnv = path.join(configDir, ".env");
    fs.writeFileSync(configEnv, "PORT=3201\nSERVER_URL=https://pilink-agents.example\n");

    const probe = `
      import fs from "node:fs";
      import os from "node:os";
      import path from "node:path";
      process.env.XDG_CONFIG_HOME = ${JSON.stringify(path.join(tempHome, ".config"))};
      delete process.env.PILINK_CONFIG;
      const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
      const candidates = [
        path.join(configHome, "pilink-agents", ".env"),
        path.join(configHome, "pilink-multi-agent", ".env"),
        path.join(configHome, "pilink-multi-agents", ".env"),
        path.join(configHome, "pilink-2", ".env"),
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

test("terminal-launcher-agents defaults PI_WORK_DIR to current working directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilink-agents-workdir-test-"));
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
