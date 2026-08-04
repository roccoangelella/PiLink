import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RedactedCommandError, runChecked, SpawnCommandRunner } from "./command.js";
import { inspectSecurePath, MANAGED_SYSTEMD_HEADER, redactCommand } from "./security.js";
import type {
  CommandRunner,
  GeneratedSystemdUnits,
  SecurePathInspection,
} from "./types.js";

export type SystemdEnableState = "enabled" | "disabled" | "unknown";

export interface SystemdUserUnitManagerOptions {
  userDirectory: string;
  systemctlPath: string;
  systemdAnalyzePath: string;
  expectedOwnerUid?: number;
}

export interface SystemdUserUnitManagerDependencies {
  runner?: CommandRunner;
  /** Test seam. Production callers must use the actual XDG user unit directory. */
  expectedUserDirectory?: string;
}

export interface SystemdUnitFileStatus extends SecurePathInspection {
  name: string;
}

export interface SystemdUserUnitStatus {
  directory: SecurePathInspection;
  server: SystemdUnitFileStatus;
  tunnel: SystemdUnitFileStatus;
  tunnelEnableState: SystemdEnableState;
  blockers: string[];
}

export type SystemdInstallActionKind =
  | "create-directory"
  | "secure-directory"
  | "create-server-unit"
  | "update-server-unit"
  | "secure-server-unit"
  | "create-tunnel-unit"
  | "update-tunnel-unit"
  | "secure-tunnel-unit";

export interface SystemdInstallAction {
  kind: SystemdInstallActionKind;
  description: string;
}

export interface SystemdInstallPlan {
  dryRun: true;
  status: SystemdUserUnitStatus;
  actions: SystemdInstallAction[];
  blockers: string[];
}

export interface SystemdInstallResult {
  dryRun: boolean;
  changed: boolean;
  verified: boolean | null;
  actions: SystemdInstallAction[];
  status: SystemdUserUnitStatus;
}

export interface SystemdEnableResult {
  dryRun: boolean;
  changed: boolean;
  state: SystemdEnableState;
  command: string;
}

export class SystemdUnitInstallBlockedError extends Error {
  readonly blockers: string[];

  constructor(blockers: string[]) {
    super(`systemd unit installation cannot continue: ${blockers.join("; ")}`);
    this.name = "SystemdUnitInstallBlockedError";
    this.blockers = [...blockers];
  }
}

export function defaultSystemdUserDirectory(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "systemd", "user");
}

/** Installs generated units only; enabling and starting are deliberately separate. */
export class SystemdUserUnitManager {
  readonly #units: GeneratedSystemdUnits;
  readonly #directory: string;
  readonly #systemctlPath: string;
  readonly #systemdAnalyzePath: string;
  readonly #expectedUid: number;
  readonly #runner: CommandRunner;

  constructor(
    units: GeneratedSystemdUnits,
    options: SystemdUserUnitManagerOptions,
    dependencies: SystemdUserUnitManagerDependencies = {},
  ) {
    assertGeneratedUnit(units.server.name, units.server.content);
    assertGeneratedUnit(units.tunnel.name, units.tunnel.content);
    if (units.server.name === units.tunnel.name) throw new Error("server and tunnel unit names must be distinct");

    const expectedDirectory = path.resolve(dependencies.expectedUserDirectory ?? defaultSystemdUserDirectory());
    const requestedDirectory = safeAbsolutePath(options.userDirectory, "systemd user directory");
    if (requestedDirectory !== expectedDirectory) {
      throw new Error("systemd user directory must be the current user's XDG systemd/user directory");
    }
    this.#units = Object.freeze({
      server: Object.freeze({ ...units.server }),
      tunnel: Object.freeze({ ...units.tunnel }),
    });
    this.#directory = requestedDirectory;
    this.#systemctlPath = safeAbsolutePath(options.systemctlPath, "systemctlPath");
    this.#systemdAnalyzePath = safeAbsolutePath(options.systemdAnalyzePath, "systemdAnalyzePath");
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const expectedUid = options.expectedOwnerUid ?? currentUid;
    if (!Number.isSafeInteger(expectedUid) || (expectedUid as number) < 0) throw new Error("expectedOwnerUid is required");
    this.#expectedUid = expectedUid as number;
    this.#runner = dependencies.runner ?? new SpawnCommandRunner();
  }

  async status(): Promise<SystemdUserUnitStatus> {
    const [directory, server, tunnel, tunnelEnableState] = await Promise.all([
      inspectSecurePath(this.#directory, {
        kind: "directory",
        expectedMode: 0o700,
        expectedUid: this.#expectedUid,
      }),
      this.#inspectUnit(this.#units.server),
      this.#inspectUnit(this.#units.tunnel),
      this.#enableState(),
    ]);
    const blockers: string[] = [];
    addPathBlocker(blockers, "systemd user directory", directory, true, this.#expectedUid);
    addUnitBlocker(blockers, "server unit", server, this.#expectedUid);
    addUnitBlocker(blockers, "tunnel unit", tunnel, this.#expectedUid);
    return { directory, server, tunnel, tunnelEnableState, blockers };
  }

  async planInstall(): Promise<SystemdInstallPlan> {
    const status = await this.status();
    const actions: SystemdInstallAction[] = [];
    if (status.directory.state === "missing") {
      actions.push({ kind: "create-directory", description: "Create private systemd user unit directory" });
    } else if (canRepairMode(status.directory, this.#expectedUid)) {
      actions.push({ kind: "secure-directory", description: "Set systemd user unit directory mode to 0700" });
    }
    addUnitActions(actions, "server", status.server, this.#expectedUid);
    addUnitActions(actions, "tunnel", status.tunnel, this.#expectedUid);
    return { dryRun: true, status, actions, blockers: status.blockers };
  }

  async install(options: { dryRun?: boolean } = {}): Promise<SystemdInstallResult> {
    const dryRun = options.dryRun ?? true;
    const plan = await this.planInstall();
    if (dryRun) {
      return {
        dryRun: true,
        changed: plan.actions.length > 0,
        verified: null,
        actions: plan.actions,
        status: plan.status,
      };
    }
    if (plan.blockers.length > 0) throw new SystemdUnitInstallBlockedError(plan.blockers);
    if (plan.actions.length === 0) {
      return { dryRun: false, changed: false, verified: null, actions: [], status: plan.status };
    }

    await this.#ensureDirectory();
    const writesContent = plan.actions.some((entry) => /^(create|update)-(server|tunnel)-unit$/.test(entry.kind));
    const verified = writesContent ? await this.#verifyGeneratedUnits() : null;
    await this.#applyUnitChanges(plan.actions);
    if (writesContent) {
      await runChecked(this.#runner, {
        command: this.#systemctlPath,
        args: ["--user", "daemon-reload"],
        timeoutMs: 30_000,
      });
    }
    const status = await this.status();
    if (status.blockers.length > 0 || status.server.contentMatches !== true || status.tunnel.contentMatches !== true) {
      throw new SystemdUnitInstallBlockedError(status.blockers.length > 0
        ? status.blockers
        : ["installed systemd units do not match the generated definitions"]);
    }
    return { dryRun: false, changed: true, verified, actions: plan.actions, status };
  }

  async enable(options: { dryRun?: boolean } = {}): Promise<SystemdEnableResult> {
    const dryRun = options.dryRun ?? true;
    const installPlan = await this.planInstall();
    if (installPlan.blockers.length > 0) throw new SystemdUnitInstallBlockedError(installPlan.blockers);
    if (installPlan.actions.length > 0) {
      throw new SystemdUnitInstallBlockedError(["install the generated systemd units before enabling hosting"]);
    }
    const state = installPlan.status.tunnelEnableState;
    if (state === "enabled") return { dryRun, changed: false, state, command: "already enabled" };
    const args = ["--user", "enable", this.#units.tunnel.name];
    const command = redactCommand(this.#systemctlPath, args);
    if (dryRun) return { dryRun: true, changed: true, state, command };
    await runChecked(this.#runner, { command: this.#systemctlPath, args, timeoutMs: 30_000 });
    const finalState = await this.#enableState();
    if (finalState !== "enabled") throw new Error("systemd did not enable the VSPiLink tunnel unit");
    return { dryRun: false, changed: true, state: finalState, command };
  }

  async disable(options: { dryRun?: boolean } = {}): Promise<SystemdEnableResult> {
    const dryRun = options.dryRun ?? true;
    const status = await this.status();
    if (status.blockers.length > 0) throw new SystemdUnitInstallBlockedError(status.blockers);
    if (status.tunnelEnableState === "disabled") {
      return { dryRun, changed: false, state: "disabled", command: "already disabled" };
    }
    const args = ["--user", "disable", this.#units.tunnel.name];
    const command = redactCommand(this.#systemctlPath, args);
    if (dryRun) return { dryRun: true, changed: true, state: status.tunnelEnableState, command };
    await runChecked(this.#runner, { command: this.#systemctlPath, args, timeoutMs: 30_000 });
    const finalState = await this.#enableState();
    if (finalState !== "disabled") throw new Error("systemd did not disable the VSPiLink tunnel unit");
    return { dryRun: false, changed: true, state: finalState, command };
  }

  async #inspectUnit(unit: { name: string; content: string }): Promise<SystemdUnitFileStatus> {
    const inspection = await inspectSecurePath(path.join(this.#directory, unit.name), {
      kind: "file",
      expectedMode: 0o600,
      expectedUid: this.#expectedUid,
      expectedContent: unit.content,
      managedHeader: MANAGED_SYSTEMD_HEADER,
    });
    return { ...inspection, name: unit.name };
  }

  async #enableState(): Promise<SystemdEnableState> {
    const result = await this.#runner.run({
      command: this.#systemctlPath,
      args: ["--user", "is-enabled", this.#units.tunnel.name],
      timeoutMs: 10_000,
    });
    const state = result.stdout.trim();
    if (result.exitCode === 0 && ["enabled", "enabled-runtime", "linked", "linked-runtime"].includes(state)) {
      return "enabled";
    }
    if (["disabled", "indirect", "static", "not-found"].includes(state) || [1, 4].includes(result.exitCode)) {
      return "disabled";
    }
    return "unknown";
  }

  async #ensureDirectory(): Promise<void> {
    await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const inspection = await inspectSecurePath(this.#directory, {
      kind: "directory",
      expectedMode: 0o700,
      expectedUid: this.#expectedUid,
    });
    if (canRepairMode(inspection, this.#expectedUid)) await fs.chmod(this.#directory, 0o700);
    else if (inspection.state !== "secure") throw new SystemdUnitInstallBlockedError([pathIssue("systemd user directory", inspection)]);
  }

  async #verifyGeneratedUnits(): Promise<boolean> {
    const available = await this.#runner.run({
      command: this.#systemdAnalyzePath,
      args: ["--version"],
      timeoutMs: 10_000,
    });
    if (available.exitCode === 127) return false;
    if (available.exitCode !== 0) {
      throw new RedactedCommandError(
        { command: this.#systemdAnalyzePath, args: ["--version"] },
        available.exitCode,
      );
    }

    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-systemd-"));
    await fs.chmod(temporaryDirectory, 0o700);
    try {
      const serverPath = path.join(temporaryDirectory, this.#units.server.name);
      const tunnelPath = path.join(temporaryDirectory, this.#units.tunnel.name);
      await Promise.all([
        fs.writeFile(serverPath, this.#units.server.content, { mode: 0o600, flag: "wx" }),
        fs.writeFile(tunnelPath, this.#units.tunnel.content, { mode: 0o600, flag: "wx" }),
      ]);
      await runChecked(this.#runner, {
        command: this.#systemdAnalyzePath,
        args: ["--user", "verify", serverPath, tunnelPath],
        timeoutMs: 30_000,
      });
      return true;
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async #applyUnitChanges(actions: readonly SystemdInstallAction[]): Promise<void> {
    const staged: Array<{ temporaryPath: string; targetPath: string }> = [];
    try {
      for (const unit of [this.#units.server, this.#units.tunnel]) {
        const role = unit === this.#units.server ? "server" : "tunnel";
        const mustWrite = actions.some((entry) => entry.kind === `create-${role}-unit` || entry.kind === `update-${role}-unit`);
        if (!mustWrite) continue;
        const targetPath = path.join(this.#directory, unit.name);
        const temporaryPath = path.join(this.#directory, `.${unit.name}.${randomUUID()}.tmp`);
        const handle = await fs.open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(unit.content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        staged.push({ temporaryPath, targetPath });
      }
      for (const entry of staged) {
        await assertReplaceableManagedUnit(entry.targetPath, this.#expectedUid);
        await fs.rename(entry.temporaryPath, entry.targetPath);
        await fs.chmod(entry.targetPath, 0o600);
      }
      for (const unit of [this.#units.server, this.#units.tunnel]) {
        const role = unit === this.#units.server ? "server" : "tunnel";
        if (actions.some((entry) => entry.kind === `secure-${role}-unit`)) {
          await fs.chmod(path.join(this.#directory, unit.name), 0o600);
        }
      }
      const directoryHandle = await fs.open(this.#directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await Promise.all(staged.map((entry) => fs.rm(entry.temporaryPath, { force: true })));
    }
  }
}

function addUnitActions(
  actions: SystemdInstallAction[],
  role: "server" | "tunnel",
  inspection: SystemdUnitFileStatus,
  expectedUid: number,
): void {
  const title = role === "server" ? "persistent PiLink server" : "Cloudflare tunnel";
  if (inspection.state === "missing") {
    actions.push({ kind: `create-${role}-unit`, description: `Install managed ${title} user unit` });
  } else if (inspection.contentMatches === false && inspection.managedByVSPiLink) {
    actions.push({ kind: `update-${role}-unit`, description: `Update managed ${title} user unit` });
  } else if (canRepairMode(inspection, expectedUid)) {
    actions.push({ kind: `secure-${role}-unit`, description: `Set managed ${title} unit mode to 0600` });
  }
}

function addUnitBlocker(
  blockers: string[],
  label: string,
  inspection: SystemdUnitFileStatus,
  expectedUid: number,
): void {
  if (inspection.state === "missing") return;
  if (inspection.state === "invalid" || (inspection.state === "insecure" && inspection.uid !== expectedUid)) {
    blockers.push(pathIssue(label, inspection));
  }
  if (inspection.contentMatches === false && !inspection.managedByVSPiLink) {
    blockers.push(`${label} exists but is not managed by VSPiLink`);
  }
}

function addPathBlocker(
  blockers: string[],
  label: string,
  inspection: SecurePathInspection,
  allowMissing: boolean,
  expectedUid: number,
): void {
  if (allowMissing && inspection.state === "missing") return;
  if (inspection.state === "invalid" || (inspection.state === "insecure" && inspection.uid !== expectedUid)) {
    blockers.push(pathIssue(label, inspection));
  }
}

function canRepairMode(inspection: SecurePathInspection, expectedUid: number): boolean {
  return inspection.state === "insecure" && inspection.uid === expectedUid;
}

function pathIssue(label: string, inspection: SecurePathInspection): string {
  if (inspection.state === "missing") return `${label} is missing`;
  return `${label} is unsafe${inspection.reason ? `: ${inspection.reason}` : ""}`;
}

async function assertReplaceableManagedUnit(targetPath: string, expectedUid: number): Promise<void> {
  const inspection = await inspectSecurePath(targetPath, {
    kind: "file",
    expectedMode: 0o600,
    expectedUid,
    expectedContent: "",
    managedHeader: MANAGED_SYSTEMD_HEADER,
  });
  if (inspection.state === "missing") return;
  if (inspection.state === "invalid" || inspection.uid !== expectedUid || !inspection.managedByVSPiLink) {
    throw new SystemdUnitInstallBlockedError(["refusing to replace an unmanaged or unsafe systemd unit"]);
  }
}

function assertGeneratedUnit(name: string, content: string): void {
  if (path.basename(name) !== name || !/^[A-Za-z0-9_.@-]+\.service$/.test(name)) {
    throw new Error("generated systemd unit has an unsafe name");
  }
  if (!content.startsWith(`${MANAGED_SYSTEMD_HEADER}\n`) || /[\0\r]/.test(content)) {
    throw new Error("generated systemd unit is missing the VSPiLink management marker");
  }
}

function safeAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(value);
}
