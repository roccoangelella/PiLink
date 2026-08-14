import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MANAGED_SYSTEMD_HEADER,
  SystemdUnitInstallBlockedError,
  SystemdUserUnitManager,
  normalizeHostingOptions,
  renderSystemdUserUnits,
} from "../dist/hosting/index.js";

test("systemd install is dry-run by default, atomic, verified, and idempotent", async (t) => {
  const fixture = await createFixture(t);
  const runner = new SystemdRunner();
  const manager = createManager(fixture, runner);

  const preview = await manager.install();
  assert.equal(preview.dryRun, true);
  assert.equal(preview.changed, true);
  assert.deepEqual(preview.actions.map((entry) => entry.kind), [
    "create-directory",
    "create-server-unit",
    "create-tunnel-unit",
  ]);
  assert.equal(await exists(fixture.userDirectory), false);
  assert.equal(runner.mutations, 0);

  const installed = await manager.install({ dryRun: false });
  assert.equal(installed.changed, true);
  assert.equal(installed.verified, true);
  assert.equal((await fs.stat(fixture.userDirectory)).mode & 0o777, 0o700);
  for (const unit of [fixture.units.server, fixture.units.tunnel]) {
    const unitPath = path.join(fixture.userDirectory, unit.name);
    assert.equal((await fs.stat(unitPath)).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(unitPath, "utf8"), unit.content);
    assert.match(unit.content, new RegExp(`^${escapeRegExp(MANAGED_SYSTEMD_HEADER)}`));
  }
  const verifyIndex = runner.calls.findIndex((call) => call.args.includes("verify"));
  const reloadIndex = runner.calls.findIndex((call) => call.args.includes("daemon-reload"));
  assert.ok(verifyIndex >= 0 && reloadIndex > verifyIndex);
  assert.equal(runner.calls.some((call) => call.args.includes("start") || call.args.includes("enable")), false);

  const repeated = await manager.install({ dryRun: false });
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.actions, []);
});

test("install refuses unmanaged unit files and never overwrites them", async (t) => {
  const fixture = await createFixture(t);
  await fs.mkdir(fixture.userDirectory, { recursive: true, mode: 0o700 });
  const serverPath = path.join(fixture.userDirectory, fixture.units.server.name);
  await fs.writeFile(serverPath, "[Unit]\nDescription=belongs to customer\n", { mode: 0o600 });
  const runner = new SystemdRunner();
  const manager = createManager(fixture, runner);

  const plan = await manager.planInstall();
  assert.match(plan.blockers.join("\n"), /not managed by PiLink/);
  await assert.rejects(
    manager.install({ dryRun: false }),
    (error) => error instanceof SystemdUnitInstallBlockedError,
  );
  assert.equal(await fs.readFile(serverPath, "utf8"), "[Unit]\nDescription=belongs to customer\n");
  assert.equal(runner.mutations, 0);
});

test("enable and disable are explicit, idempotent, and never start a unit", async (t) => {
  const fixture = await createFixture(t);
  const runner = new SystemdRunner();
  const manager = createManager(fixture, runner);
  await manager.install({ dryRun: false });

  const enablePreview = await manager.enable();
  assert.equal(enablePreview.dryRun, true);
  assert.equal(enablePreview.changed, true);
  assert.equal(runner.enabled, false);

  const enabled = await manager.enable({ dryRun: false });
  assert.equal(enabled.state, "enabled");
  assert.equal(runner.enabled, true);
  assert.equal(runner.calls.some((call) => call.args.includes("start") || call.args.includes("--now")), false);
  const repeatedEnable = await manager.enable({ dryRun: false });
  assert.equal(repeatedEnable.changed, false);

  const disablePreview = await manager.disable();
  assert.equal(disablePreview.dryRun, true);
  assert.equal(runner.enabled, true);
  const disabled = await manager.disable({ dryRun: false });
  assert.equal(disabled.state, "disabled");
  assert.equal(runner.enabled, false);
});

test("install skips systemd-analyze only when it is unavailable", async (t) => {
  const fixture = await createFixture(t);
  const runner = new SystemdRunner({ analyzeAvailable: false });
  const manager = createManager(fixture, runner);

  const installed = await manager.install({ dryRun: false });
  assert.equal(installed.changed, true);
  assert.equal(installed.verified, false);
  assert.ok(runner.calls.some((call) => call.args.includes("daemon-reload")));
});

test("manager cannot be redirected outside the current user's expected systemd directory", async (t) => {
  const fixture = await createFixture(t);
  assert.throws(
    () => new SystemdUserUnitManager(fixture.units, {
      userDirectory: path.join(fixture.root, "somewhere-else"),
      systemctlPath: "/usr/bin/systemctl",
      systemdAnalyzePath: "/usr/bin/systemd-analyze",
    }, {
      expectedUserDirectory: fixture.userDirectory,
      runner: new SystemdRunner(),
    }),
    /must be the current user's XDG/,
  );
});

class SystemdRunner {
  constructor({ analyzeAvailable = true } = {}) {
    this.analyzeAvailable = analyzeAvailable;
    this.calls = [];
    this.mutations = 0;
    this.enabled = false;
  }

  async run(request) {
    this.calls.push({ ...request, args: [...request.args] });
    if (request.command.endsWith("systemd-analyze")) {
      if (request.args[0] === "--version") {
        return this.analyzeAvailable
          ? { exitCode: 0, stdout: "systemd 257\n", stderr: "" }
          : { exitCode: 127, stdout: "", stderr: "ENOENT" };
      }
      assert.equal(request.args[0], "--user");
      assert.equal(request.args[1], "verify");
      for (const unitPath of request.args.slice(2)) {
        assert.match(await fs.readFile(unitPath, "utf8"), new RegExp(`^${escapeRegExp(MANAGED_SYSTEMD_HEADER)}`));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const operation = request.args[1];
    if (operation === "is-enabled") {
      return this.enabled
        ? { exitCode: 0, stdout: "enabled\n", stderr: "" }
        : { exitCode: 1, stdout: "disabled\n", stderr: "" };
    }
    if (operation === "daemon-reload") {
      this.mutations += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (operation === "enable") {
      this.mutations += 1;
      this.enabled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (operation === "disable") {
      this.mutations += 1;
      this.enabled = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 4, stdout: "unknown\n", stderr: "" };
  }
}

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-systemd-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userDirectory = path.join(root, "xdg", "systemd", "user");
  const normalized = normalizeHostingOptions({
    tunnelName: "vspilink-example",
    origin: "http://127.0.0.1:3200",
    zoneName: "example.com",
    mcpHostname: "mcp.example.com",
    landingHostname: "vspilink.example.com",
    auth: { kind: "origin-certificate", certificatePath: path.join(root, "origin.pem") },
    stateDirectory: path.join(root, "state"),
    cloudflaredPath: "/usr/bin/cloudflared",
    nodePath: "/opt/node-v24.18.0/bin/node",
    pilinkCliPath: "/opt/pilink/dist/cli.js",
    pilinkConfigPath: path.join(root, "pilink.env"),
    systemctlPath: "/usr/bin/systemctl",
  });
  return { root, userDirectory, units: renderSystemdUserUnits(normalized) };
}

function createManager(fixture, runner) {
  return new SystemdUserUnitManager(fixture.units, {
    userDirectory: fixture.userDirectory,
    systemctlPath: "/usr/bin/systemctl",
    systemdAnalyzePath: "/usr/bin/systemd-analyze",
  }, {
    expectedUserDirectory: fixture.userDirectory,
    runner,
  });
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
