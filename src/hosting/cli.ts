import type { Writable } from "node:stream";

import { CloudflareNamedTunnelHosting, HostingProvisionBlockedError } from "./cloudflare.js";
import { RedactedCommandError } from "./command.js";
import {
  SystemdUnitInstallBlockedError,
  SystemdUserUnitManager,
  type SystemdInstallResult,
  type SystemdUserUnitStatus,
} from "./systemd.js";
import type {
  CloudflareHostingInspection,
  CloudflareHostingPlan,
  CloudflareNamedTunnelOptions,
  CloudflareProvisionResult,
  SecurePathInspection,
} from "./types.js";

const COMMANDS = new Set([
  "inspect",
  "plan",
  "provision",
  "install",
  "enable",
  "start",
  "stop",
  "disable",
  "status",
] as const);
const READ_ONLY_COMMANDS = new Set(["inspect", "plan", "status"]);

type HostingCommand = "inspect" | "plan" | "provision" | "install" | "enable" | "start" | "stop" | "disable" | "status";

interface ParsedHostingCli {
  command: HostingCommand;
  apply: boolean;
  hostingOptions: CloudflareNamedTunnelOptions;
  systemdUserDirectory: string;
  systemdAnalyzePath: string;
}

export interface HostingCliIo {
  stdout?: Pick<Writable, "write">;
  stderr?: Pick<Writable, "write">;
}

/** Executes one non-interactive JSON command. Returns a process-style exit code. */
export async function runHostingCli(argv: string[], io: HostingCliIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let parsed: ParsedHostingCli | undefined;
  try {
    parsed = parseHostingCli(argv);
    const hosting = new CloudflareNamedTunnelHosting(parsed.hostingOptions);
    const units = hosting.generateSystemdUnits();
    const systemd = new SystemdUserUnitManager(units, {
      userDirectory: parsed.systemdUserDirectory,
      systemctlPath: parsed.hostingOptions.systemctlPath as string,
      systemdAnalyzePath: parsed.systemdAnalyzePath,
      expectedOwnerUid: parsed.hostingOptions.expectedOwnerUid,
    });
    const dryRun = !parsed.apply;
    const result = await executeCommand(parsed.command, dryRun, hosting, systemd);
    writeJson(stdout, { ok: true, command: parsed.command, dryRun, result });
    return 0;
  } catch (error) {
    const normalized = normalizeCliError(error, argv);
    writeJson(stderr, {
      ok: false,
      command: parsed?.command ?? safeCommandName(argv[0]),
      dryRun: parsed ? !parsed.apply : true,
      error: normalized,
    });
    return 1;
  }
}

async function executeCommand(
  command: HostingCommand,
  dryRun: boolean,
  hosting: CloudflareNamedTunnelHosting,
  systemd: SystemdUserUnitManager,
): Promise<unknown> {
  switch (command) {
    case "inspect":
      return sanitizeInspection(await hosting.inspect());
    case "plan":
      return sanitizeHostingPlan(await hosting.plan());
    case "provision":
      return sanitizeProvision(await hosting.provision({ dryRun }));
    case "install": {
      const hostingPlan = await hosting.plan();
      const installPreview = await systemd.planInstall();
      const ready = hostingPlan.blockers.length === 0 && hostingPlan.actions.length === 0;
      if (!dryRun && !ready) {
        throw new HostingProvisionBlockedError(hostingPlan.blockers.length > 0
          ? hostingPlan.blockers
          : ["run hosting provision --apply before installing systemd units"]);
      }
      const installed = dryRun ? await systemd.install() : await systemd.install({ dryRun: false });
      return {
        readyForInstall: ready,
        pendingProvisionActions: hostingPlan.actions.map(sanitizeAction),
        hostingBlockers: redactMessages(hostingPlan.blockers, inspectionPrivatePaths(hostingPlan.inspection)),
        installPlan: sanitizeSystemdPlan(installPreview),
        installation: sanitizeInstallResult(installed),
      };
    }
    case "enable": {
      await assertHostingProvisioned(hosting);
      return await systemd.enable({ dryRun });
    }
    case "start": {
      await assertHostingProvisioned(hosting);
      const unitStatus = await systemd.status();
      assertUnitsInstalled(unitStatus);
      if (unitStatus.tunnelEnableState !== "enabled") {
        throw new SystemdUnitInstallBlockedError(["enable the tunnel unit before starting production hosting"]);
      }
      return await hosting.start({ dryRun });
    }
    case "stop": {
      const unitStatus = await systemd.status();
      assertManagedIfPresent(unitStatus);
      return await hosting.stop({ dryRun });
    }
    case "disable":
      return await systemd.disable({ dryRun });
    case "status": {
      const [inspection, unitStatus] = await Promise.all([hosting.inspect(), systemd.status()]);
      return {
        hosting: sanitizeInspection(inspection),
        systemd: sanitizeSystemdStatus(unitStatus),
        productionReady: (
          inspection.blockers.length === 0
          && inspection.config.contentMatches === true
          && inspection.credentials.state === "secure"
          && unitStatus.blockers.length === 0
          && unitStatus.server.contentMatches === true
          && unitStatus.tunnel.contentMatches === true
          && unitStatus.tunnelEnableState === "enabled"
          && inspection.service.state === "active"
          && inspection.service.serverState === "active"
        ),
      };
    }
  }
}

function parseHostingCli(argv: string[]): ParsedHostingCli {
  const [rawCommand, ...rawOptions] = argv;
  if (!rawCommand || !COMMANDS.has(rawCommand as HostingCommand)) {
    throw new HostingCliInputError(
      "HOSTING_COMMAND_INVALID",
      "hosting command must be one of inspect, plan, provision, install, enable, start, stop, disable, status",
    );
  }
  const command = rawCommand as HostingCommand;
  const { values, apply } = parseOptions(rawOptions);
  if (apply && READ_ONLY_COMMANDS.has(command)) {
    throw new HostingCliInputError("HOSTING_APPLY_NOT_ALLOWED", `--apply is not valid for read-only hosting ${command}`);
  }

  const authMode = required(values, "--auth-mode");
  let auth: CloudflareNamedTunnelOptions["auth"];
  if (authMode === "certificate") {
    rejectPresent(values, ["--token-file", "--tunnel-id"], "certificate authentication");
    auth = { kind: "origin-certificate", certificatePath: required(values, "--certificate-path") };
  } else if (authMode === "token-file") {
    rejectPresent(values, ["--certificate-path"], "token-file authentication");
    auth = {
      kind: "tunnel-token-file",
      tokenFile: required(values, "--token-file"),
      tunnelId: required(values, "--tunnel-id"),
      dnsManagedExternally: true,
    };
  } else {
    throw new HostingCliInputError("HOSTING_AUTH_INVALID", "--auth-mode must be certificate or token-file");
  }

  const optional = (name: string): string | undefined => values.get(name);
  const ownerUid = optional("--expected-owner-uid");
  const expectedOwnerUid = ownerUid === undefined ? undefined : parseUid(ownerUid);
  const hostingOptions: CloudflareNamedTunnelOptions = {
    tunnelName: required(values, "--tunnel-name"),
    origin: required(values, "--origin"),
    zoneName: required(values, "--zone"),
    mcpHostname: required(values, "--mcp-hostname"),
    landingHostname: required(values, "--landing-hostname"),
    auth,
    stateDirectory: required(values, "--state-dir"),
    cloudflaredPath: required(values, "--cloudflared-path"),
    nodePath: required(values, "--node-path"),
    pilinkCliPath: required(values, "--pilink-cli-path"),
    pilinkConfigPath: required(values, "--pilink-config-path"),
    systemctlPath: required(values, "--systemctl-path"),
    ...(optional("--config-path") ? { configPath: optional("--config-path") } : {}),
    ...(optional("--credentials-path") ? { credentialsPath: optional("--credentials-path") } : {}),
    ...(optional("--metrics-address") ? { metricsAddress: optional("--metrics-address") } : {}),
    ...(optional("--tunnel-unit-name") ? { systemdUnitName: optional("--tunnel-unit-name") } : {}),
    ...(optional("--server-unit-name") ? { serverSystemdUnitName: optional("--server-unit-name") } : {}),
    ...(expectedOwnerUid === undefined ? {} : { expectedOwnerUid }),
  };

  return {
    command,
    apply,
    hostingOptions,
    systemdUserDirectory: required(values, "--systemd-user-dir"),
    systemdAnalyzePath: required(values, "--systemd-analyze-path"),
  };
}

function parseOptions(args: string[]): { values: Map<string, string>; apply: boolean } {
  const valueOptions = new Set([
    "--tunnel-name",
    "--origin",
    "--zone",
    "--mcp-hostname",
    "--landing-hostname",
    "--auth-mode",
    "--certificate-path",
    "--token-file",
    "--tunnel-id",
    "--state-dir",
    "--config-path",
    "--credentials-path",
    "--cloudflared-path",
    "--node-path",
    "--pilink-cli-path",
    "--pilink-config-path",
    "--systemctl-path",
    "--systemd-analyze-path",
    "--systemd-user-dir",
    "--metrics-address",
    "--tunnel-unit-name",
    "--server-unit-name",
    "--expected-owner-uid",
  ]);
  const forbiddenSecretOptions = new Set([
    "--token",
    "--secret",
    "--client-secret",
    "--certificate-contents",
    "--credentials-contents",
  ]);
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--apply") {
      if (apply) throw new HostingCliInputError("HOSTING_OPTION_DUPLICATE", "--apply may be specified only once");
      apply = true;
      continue;
    }
    if (forbiddenSecretOptions.has(option) || [...forbiddenSecretOptions].some((name) => option.startsWith(`${name}=`))) {
      throw new HostingCliInputError("HOSTING_SECRET_IN_ARGV", "secret values are forbidden in argv; use a private token file or certificate file");
    }
    if (!valueOptions.has(option)) {
      throw new HostingCliInputError("HOSTING_OPTION_UNKNOWN", "unknown or malformed hosting option");
    }
    if (values.has(option)) throw new HostingCliInputError("HOSTING_OPTION_DUPLICATE", `${option} may be specified only once`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || /[\0\r\n]/.test(value)) {
      throw new HostingCliInputError("HOSTING_OPTION_VALUE_MISSING", `${option} requires one value`);
    }
    values.set(option, value);
    index += 1;
  }
  return { values, apply };
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new HostingCliInputError("HOSTING_OPTION_REQUIRED", `${name} is required`);
  return value;
}

function rejectPresent(values: Map<string, string>, names: string[], mode: string): void {
  if (names.some((name) => values.has(name))) {
    throw new HostingCliInputError("HOSTING_AUTH_CONFLICT", `incompatible authentication options were supplied for ${mode}`);
  }
}

function parseUid(value: string): number {
  if (!/^\d+$/.test(value)) throw new HostingCliInputError("HOSTING_UID_INVALID", "--expected-owner-uid must be an integer");
  const uid = Number(value);
  if (!Number.isSafeInteger(uid) || uid < 0) throw new HostingCliInputError("HOSTING_UID_INVALID", "--expected-owner-uid must be an integer");
  return uid;
}

async function assertHostingProvisioned(hosting: CloudflareNamedTunnelHosting): Promise<void> {
  const plan = await hosting.plan();
  if (plan.blockers.length > 0) throw new HostingProvisionBlockedError(plan.blockers);
  if (plan.actions.length > 0) {
    throw new HostingProvisionBlockedError(["run hosting provision --apply before continuing"]);
  }
}

function assertUnitsInstalled(status: SystemdUserUnitStatus): void {
  if (status.blockers.length > 0) throw new SystemdUnitInstallBlockedError(status.blockers);
  if (status.server.contentMatches !== true || status.tunnel.contentMatches !== true) {
    throw new SystemdUnitInstallBlockedError(["install the generated systemd units before starting hosting"]);
  }
}

function assertManagedIfPresent(status: SystemdUserUnitStatus): void {
  if (status.blockers.length > 0) throw new SystemdUnitInstallBlockedError(status.blockers);
  for (const unit of [status.server, status.tunnel]) {
    if (unit.state !== "missing" && !unit.managedByPiLink) {
      throw new SystemdUnitInstallBlockedError(["refusing to operate an unmanaged systemd unit"]);
    }
  }
}

function sanitizeHostingPlan(plan: CloudflareHostingPlan): unknown {
  const privatePaths = inspectionPrivatePaths(plan.inspection);
  return {
    inspection: sanitizeInspection(plan.inspection),
    actions: plan.actions.map(sanitizeAction),
    blockers: redactMessages(plan.blockers, privatePaths),
    units: sanitizeGeneratedUnits(plan.systemdUnits),
  };
}

function sanitizeProvision(result: CloudflareProvisionResult): unknown {
  return {
    changed: result.changed,
    dryRun: result.dryRun,
    actions: result.actions.map(sanitizeAction),
    inspection: sanitizeInspection(result.inspection),
    units: sanitizeGeneratedUnits(result.systemdUnits),
  };
}

function sanitizeInspection(inspection: CloudflareHostingInspection): unknown {
  const privatePaths = inspectionPrivatePaths(inspection);
  return {
    zoneName: inspection.zoneName,
    origin: inspection.origin,
    publicUrls: inspection.publicUrls,
    cloudflared: inspection.cloudflared,
    nodeRuntime: {
      available: inspection.nodeRuntime.available,
      version: inspection.nodeRuntime.version,
      compatible: inspection.nodeRuntime.compatible,
    },
    serverConfig: sanitizePathState(inspection.serverConfig, privatePaths),
    authentication: {
      kind: inspection.authentication.kind,
      secure: inspection.authentication.secure,
      file: {
        ...sanitizePathState(inspection.authentication.path, privatePaths),
        realpathVerified: Boolean(inspection.authentication.path.realPath),
      },
    },
    stateDirectory: sanitizePathState(inspection.stateDirectory, privatePaths),
    config: sanitizePathState(inspection.config, privatePaths),
    credentials: sanitizePathState(inspection.credentials, privatePaths),
    tunnel: inspection.tunnel,
    dns: inspection.dns.map((record) => ({
      hostname: record.hostname,
      state: record.state,
      proxied: record.proxied,
      reason: redactPrivateText(record.reason, privatePaths),
    })),
    service: inspection.service,
    blockers: redactMessages(inspection.blockers, privatePaths),
  };
}

function sanitizePathState(
  inspection: SecurePathInspection,
  privatePaths: readonly string[] = [],
): Record<string, unknown> {
  return {
    state: inspection.state,
    mode: inspection.mode === undefined ? undefined : `0${inspection.mode.toString(8)}`,
    contentMatches: inspection.contentMatches,
    managedByPiLink: inspection.managedByPiLink,
    reason: redactPrivateText(inspection.reason, privatePaths),
  };
}

function sanitizeGeneratedUnits(units: CloudflareHostingPlan["systemdUnits"]): unknown {
  return {
    server: { name: units.server.name },
    tunnel: { name: units.tunnel.name, requires: units.server.name },
  };
}

function sanitizeAction(action: CloudflareHostingPlan["actions"][number]): unknown {
  return {
    kind: action.kind,
    description: action.description,
    mutatesRemote: action.mutatesRemote,
    hostname: action.hostname,
  };
}

function sanitizeSystemdPlan(plan: Awaited<ReturnType<SystemdUserUnitManager["planInstall"]>>): unknown {
  const privatePaths = [plan.status.directory.path, plan.status.server.path, plan.status.tunnel.path];
  return {
    actions: plan.actions,
    blockers: redactMessages(plan.blockers, privatePaths),
    status: sanitizeSystemdStatus(plan.status),
  };
}

function sanitizeInstallResult(result: SystemdInstallResult): unknown {
  return {
    dryRun: result.dryRun,
    changed: result.changed,
    verified: result.verified,
    actions: result.actions,
    status: sanitizeSystemdStatus(result.status),
  };
}

function sanitizeSystemdStatus(status: SystemdUserUnitStatus): unknown {
  const privatePaths = [status.directory.path, status.server.path, status.tunnel.path];
  return {
    directory: sanitizePathState(status.directory, privatePaths),
    server: { name: status.server.name, ...sanitizePathState(status.server, privatePaths) },
    tunnel: { name: status.tunnel.name, ...sanitizePathState(status.tunnel, privatePaths) },
    tunnelEnableState: status.tunnelEnableState,
    blockers: redactMessages(status.blockers, privatePaths),
  };
}

function writeJson(stream: Pick<Writable, "write">, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

class HostingCliInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HostingCliInputError";
    this.code = code;
  }
}

function normalizeCliError(error: unknown, argv: string[]): { code: string; message: string; blockers?: string[] } {
  const message = redactAuthPaths(error instanceof Error ? error.message : "hosting command failed", argv);
  if (error instanceof HostingCliInputError) return { code: error.code, message };
  if (error instanceof HostingProvisionBlockedError) {
    return { code: "HOSTING_BLOCKED", message, blockers: error.blockers.map((entry) => redactAuthPaths(entry, argv)) };
  }
  if (error instanceof SystemdUnitInstallBlockedError) {
    return { code: "HOSTING_SYSTEMD_BLOCKED", message, blockers: error.blockers.map((entry) => redactAuthPaths(entry, argv)) };
  }
  if (error instanceof RedactedCommandError) return { code: "HOSTING_COMMAND_FAILED", message };
  return { code: "HOSTING_FAILED", message };
}

function redactAuthPaths(message: string, argv: string[]): string {
  let redacted = message;
  for (const option of ["--certificate-path", "--token-file"]) {
    const index = argv.indexOf(option);
    if (index >= 0 && argv[index + 1]) redacted = redacted.split(argv[index + 1]).join("[REDACTED]");
  }
  return redacted;
}

function inspectionPrivatePaths(inspection: CloudflareHostingInspection): string[] {
  return [
    inspection.authentication.path.path,
    inspection.authentication.path.realPath,
    inspection.serverConfig.path,
    inspection.serverConfig.realPath,
    inspection.stateDirectory.path,
    inspection.stateDirectory.realPath,
    inspection.config.path,
    inspection.config.realPath,
    inspection.credentials.path,
    inspection.credentials.realPath,
  ].filter((value): value is string => Boolean(value));
}

function redactMessages(messages: readonly string[], privatePaths: readonly string[]): string[] {
  return messages.map((message) => redactPrivateText(message, privatePaths) as string);
}

function redactPrivateText(value: string | undefined, privatePaths: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  let redacted = value;
  for (const privatePath of privatePaths) {
    if (privatePath) redacted = redacted.split(privatePath).join("[PRIVATE_PATH]");
  }
  return redacted;
}

function safeCommandName(value: string | undefined): string | null {
  return value && /^[a-z-]+$/.test(value) ? value : null;
}
