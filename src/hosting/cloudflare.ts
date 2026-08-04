import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { isRequiredNodeVersion, REQUIRED_NODE_VERSION } from "../runtime.js";
import { CloudflareApiClient } from "./cloudflare-api.js";
import { RedactedCommandError, runChecked, SpawnCommandRunner } from "./command.js";
import {
  inspectSecurePath,
  MANAGED_CONFIG_HEADER,
  normalizeHostingOptions,
  redactCommand,
  renderCloudflaredConfig,
  renderSystemdUserUnits,
  validateTunnelId,
  type NormalizedCloudflareHostingOptions,
} from "./security.js";
import type {
  CloudflareHostingDependencies,
  CloudflareHostingInspection,
  CloudflareHostingPlan,
  CloudflareNamedTunnelOptions,
  CloudflareProvisionResult,
  CommandRequest,
  CommandRunner,
  DnsRecordInspection,
  GeneratedSystemdUnits,
  HostingActionKind,
  HostingLifecycleResult,
  HostingPlanAction,
  SecurePathInspection,
  SystemdServiceState,
  TunnelInspection,
} from "./types.js";

interface CloudflaredTunnelRecord {
  id?: unknown;
  name?: unknown;
  connections?: unknown;
}

export class HostingProvisionBlockedError extends Error {
  readonly blockers: string[];

  constructor(blockers: string[]) {
    super(`Cloudflare hosting cannot continue: ${blockers.join("; ")}`);
    this.name = "HostingProvisionBlockedError";
    this.blockers = [...blockers];
  }
}

/**
 * Secure lifecycle for one Cloudflare named tunnel.
 *
 * All mutating methods default to dry-run. The account certificate or per-tunnel
 * token must be supplied by the caller; neither has a built-in project path or value.
 */
export class CloudflareNamedTunnelHosting {
  readonly options: Readonly<NormalizedCloudflareHostingOptions>;
  readonly #runner: CommandRunner;
  readonly #fetch: typeof globalThis.fetch;
  readonly #originIsOccupied: (origin: string) => Promise<boolean>;

  constructor(input: CloudflareNamedTunnelOptions, dependencies: CloudflareHostingDependencies = {}) {
    const normalized = normalizeHostingOptions(input);
    Object.freeze(normalized.auth);
    this.options = Object.freeze(normalized);
    this.#runner = dependencies.runner ?? new SpawnCommandRunner();
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#originIsOccupied = dependencies.originIsOccupied ?? isOriginOccupied;
  }

  generateSystemdUnits(): GeneratedSystemdUnits {
    return renderSystemdUserUnits(this.options);
  }

  async inspect(): Promise<CloudflareHostingInspection> {
    const desiredConfig = renderCloudflaredConfig(this.options);
    const authenticationPath = this.options.auth.kind === "origin-certificate"
      ? this.options.auth.certificatePath
      : this.options.auth.tokenFile;

    const [
      authentication,
      stateDirectory,
      config,
      credentials,
      serverConfig,
      cloudflaredVersion,
      nodeVersion,
      serviceState,
      serverServiceState,
      pilinkCliAvailable,
    ] = await Promise.all([
      inspectSecurePath(authenticationPath, {
        kind: "file",
        expectedMode: 0o600,
        expectedUid: this.options.expectedOwnerUid,
        allowSymlink: this.options.auth.kind === "origin-certificate",
        requireNonEmpty: true,
      }),
      inspectSecurePath(this.options.stateDirectory, {
        kind: "directory",
        expectedMode: 0o700,
        expectedUid: this.options.expectedOwnerUid,
      }),
      inspectSecurePath(this.options.configPath, {
        kind: "file",
        expectedMode: 0o600,
        expectedUid: this.options.expectedOwnerUid,
        expectedContent: desiredConfig,
      }),
      this.options.auth.kind === "origin-certificate"
        ? inspectSecurePath(this.options.credentialsPath, {
            kind: "file",
            expectedMode: 0o600,
            expectedUid: this.options.expectedOwnerUid,
            requireNonEmpty: true,
          })
        : inspectSecurePath(this.options.auth.tokenFile, {
            kind: "file",
            expectedMode: 0o600,
            expectedUid: this.options.expectedOwnerUid,
            requireNonEmpty: true,
          }),
      inspectSecurePath(this.options.pilinkConfigPath, {
        kind: "file",
        expectedMode: 0o600,
        expectedUid: this.options.expectedOwnerUid,
        requireNonEmpty: true,
      }),
      this.#binaryVersion(this.options.cloudflaredPath, ["--version"]),
      this.#binaryVersion(this.options.nodePath, ["--version"]),
      this.#serviceState(this.options.systemdUnitName),
      this.#serviceState(this.options.serverSystemdUnitName),
      isRegularFile(this.options.pilinkCliPath),
    ]);

    const blockers: string[] = [];
    if (authentication.state !== "secure") {
      blockers.push(securityIssue(
        this.options.auth.kind === "origin-certificate" ? "Cloudflare origin certificate" : "Cloudflare tunnel token",
        authentication,
      ));
    }
    addManagedPathBlockers(blockers, "hosting state directory", stateDirectory, true);
    addManagedPathBlockers(blockers, "cloudflared config", config, true);
    if (config.state !== "missing" && config.contentMatches === false && !config.managedByVSPiLink) {
      blockers.push("cloudflared config exists but is not managed by VSPiLink");
    }
    addManagedPathBlockers(blockers, "tunnel credentials", credentials, true);
    if (serverConfig.state !== "secure") blockers.push(securityIssue("PiLink server config", serverConfig));
    if (!pilinkCliAvailable) blockers.push("PiLink CLI entrypoint is not a regular file");
    if (!cloudflaredVersion.available) blockers.push("cloudflared executable is unavailable");
    if (!nodeVersion.available) blockers.push("Node.js executable is unavailable");
    else if (!isRequiredNodeVersion(nodeVersion.version ?? "")) {
      blockers.push(`persistent server requires Node.js ${REQUIRED_NODE_VERSION} exactly`);
    }

    let tunnel: TunnelInspection = this.options.auth.kind === "tunnel-token-file"
      ? { state: "external", id: this.options.auth.tunnelId, name: this.options.tunnelName }
      : { state: "missing", name: this.options.tunnelName };
    let dns: DnsRecordInspection[] = [this.options.mcpHostname, this.options.landingHostname]
      .map((hostname) => ({
        hostname,
        state: this.options.auth.kind === "tunnel-token-file" ? "external" as const : "missing" as const,
      }));

    if (
      this.options.auth.kind === "origin-certificate"
      && authentication.state === "secure"
      && authentication.realPath
      && cloudflaredVersion.available
    ) {
      try {
        tunnel = await this.#inspectTunnel(authentication.realPath);
      } catch (error) {
        blockers.push(safeFailure("unable to inspect the named tunnel", error));
      }
      try {
        const api = await CloudflareApiClient.fromOriginCertificate(authentication.realPath, this.#fetch);
        await api.assertZone(this.options.zoneName);
        dns = await Promise.all(
          [this.options.mcpHostname, this.options.landingHostname]
            .map((hostname) => api.inspectDnsRecord(hostname, tunnel.id)),
        );
      } catch (error) {
        blockers.push(safeFailure("unable to inspect Cloudflare DNS", error));
        dns = [this.options.mcpHostname, this.options.landingHostname]
          .map((hostname) => ({ hostname, state: "external", reason: "remote inspection unavailable" }));
      }
    }

    for (const record of dns) {
      if (record.state === "conflict") blockers.push(`${record.hostname}: ${record.reason ?? "DNS record conflict"}`);
    }
    if (
      this.options.auth.kind === "origin-certificate"
      && tunnel.state === "missing"
      && credentials.state !== "missing"
    ) {
      blockers.push("tunnel credentials exist but the named tunnel does not; use a fresh state directory or recover manually");
    }

    return {
      zoneName: this.options.zoneName,
      origin: this.options.origin,
      publicUrls: {
        mcp: `https://${this.options.mcpHostname}/sse`,
        landing: `https://${this.options.landingHostname}/`,
      },
      cloudflared: cloudflaredVersion,
      nodeRuntime: {
        path: this.options.nodePath,
        available: nodeVersion.available,
        version: nodeVersion.version,
        compatible: nodeVersion.available && isRequiredNodeVersion(nodeVersion.version ?? ""),
      },
      serverConfig,
      authentication: {
        kind: this.options.auth.kind,
        secure: authentication.state === "secure",
        path: authentication,
      },
      stateDirectory,
      config,
      credentials,
      tunnel,
      dns,
      service: {
        unitName: this.options.systemdUnitName,
        state: serviceState,
        serverUnitName: this.options.serverSystemdUnitName,
        serverState: serverServiceState,
      },
      blockers: unique(blockers),
    };
  }

  async plan(): Promise<CloudflareHostingPlan> {
    const inspection = await this.inspect();
    const actions: HostingPlanAction[] = [];
    if (inspection.stateDirectory.state === "missing") {
      actions.push(action("create-state-directory", "Create private Cloudflare hosting state directory"));
    } else if (canRepairMode(inspection.stateDirectory, this.options.expectedOwnerUid)) {
      actions.push(action("secure-state-directory", "Set Cloudflare hosting state directory mode to 0700"));
    }

    if (this.options.auth.kind === "origin-certificate" && inspection.tunnel.state === "missing") {
      actions.push(action("create-tunnel", `Create dedicated named tunnel ${this.options.tunnelName}`, true));
    }
    if (
      this.options.auth.kind === "origin-certificate"
      && inspection.tunnel.state === "present"
      && inspection.credentials.state === "missing"
    ) {
      actions.push(action("recover-tunnel-credentials", "Recover scoped credentials for the existing named tunnel", true));
    } else if (
      this.options.auth.kind === "origin-certificate"
      && canRepairMode(inspection.credentials, this.options.expectedOwnerUid)
    ) {
      actions.push(action("secure-tunnel-credentials", "Set tunnel credentials mode to 0600"));
    }

    if (inspection.config.state === "missing" || inspection.config.contentMatches === false) {
      actions.push(action("write-config", "Write deterministic Cloudflare ingress configuration"));
    } else if (canRepairMode(inspection.config, this.options.expectedOwnerUid)) {
      actions.push(action("secure-config", "Set cloudflared config mode to 0600"));
    }

    for (const record of inspection.dns) {
      if (record.state === "missing") {
        actions.push(action("create-dns-record", `Create proxied DNS route for ${record.hostname}`, true, record.hostname));
      } else if (record.state === "needs-proxy") {
        actions.push(action("enable-dns-proxy", `Enable Cloudflare proxy for ${record.hostname}`, true, record.hostname));
      }
    }

    return {
      inspection,
      actions,
      blockers: inspection.blockers,
      systemdUnits: this.generateSystemdUnits(),
      dryRun: true,
    };
  }

  async provision(options: { dryRun?: boolean } = {}): Promise<CloudflareProvisionResult> {
    const dryRun = options.dryRun ?? true;
    const plan = await this.plan();
    if (dryRun) {
      return {
        changed: plan.actions.length > 0,
        dryRun: true,
        actions: plan.actions,
        inspection: plan.inspection,
        systemdUnits: plan.systemdUnits,
      };
    }
    if (plan.blockers.length > 0) throw new HostingProvisionBlockedError(plan.blockers);
    if (plan.actions.length === 0) {
      return {
        changed: false,
        dryRun: false,
        actions: [],
        inspection: plan.inspection,
        systemdUnits: plan.systemdUnits,
      };
    }

    await this.#ensureStateDirectory();

    let tunnel = plan.inspection.tunnel;
    let api: CloudflareApiClient | undefined;
    if (this.options.auth.kind === "origin-certificate") {
      const certificateRealPath = plan.inspection.authentication.path.realPath;
      if (!certificateRealPath) throw new HostingProvisionBlockedError(["Cloudflare certificate realpath is unavailable"]);
      api = await CloudflareApiClient.fromOriginCertificate(certificateRealPath, this.#fetch);
      await api.assertZone(this.options.zoneName);

      if (hasAction(plan.actions, "create-tunnel")) {
        await runChecked(this.#runner, {
          command: this.options.cloudflaredPath,
          args: [
            "tunnel",
            "--origincert",
            certificateRealPath,
            "create",
            "--credentials-file",
            this.options.credentialsPath,
            this.options.tunnelName,
          ],
          timeoutMs: 60_000,
          captureOutput: false,
        });
        tunnel = await this.#inspectTunnel(certificateRealPath);
      } else if (hasAction(plan.actions, "recover-tunnel-credentials")) {
        if (!tunnel.id) throw new HostingProvisionBlockedError(["existing tunnel has no valid ID"]);
        await runChecked(this.#runner, {
          command: this.options.cloudflaredPath,
          args: [
            "tunnel",
            "--origincert",
            certificateRealPath,
            "token",
            "--cred-file",
            this.options.credentialsPath,
            tunnel.id,
          ],
          timeoutMs: 60_000,
          captureOutput: false,
        });
      }
      await secureManagedFile(this.options.credentialsPath, this.options.expectedOwnerUid);
    }

    if (hasAction(plan.actions, "write-config")) {
      await atomicPrivateWrite(
        this.options.configPath,
        renderCloudflaredConfig(this.options),
        this.options.stateDirectory,
        this.options.expectedOwnerUid,
      );
    } else if (hasAction(plan.actions, "secure-config")) {
      await secureManagedFile(this.options.configPath, this.options.expectedOwnerUid);
    }

    if (this.options.auth.kind === "origin-certificate" && api) {
      if (!tunnel.id) throw new HostingProvisionBlockedError(["named tunnel was not created or discovered"]);
      for (const plannedAction of plan.actions) {
        if (!plannedAction.hostname) continue;
        if (plannedAction.kind === "create-dns-record") {
          await this.#createDnsIdempotently(api, plannedAction.hostname, tunnel.id);
        } else if (plannedAction.kind === "enable-dns-proxy") {
          const current = await api.inspectDnsRecord(plannedAction.hostname, tunnel.id);
          if (current.state === "matching") continue;
          if (current.state !== "needs-proxy" || !current.recordId) {
            throw new HostingProvisionBlockedError([`${plannedAction.hostname}: DNS record changed during provisioning`]);
          }
          await api.enableDnsProxy(current.recordId);
        }
      }
    }

    const inspection = await this.inspect();
    if (inspection.blockers.length > 0) throw new HostingProvisionBlockedError(inspection.blockers);
    return {
      changed: true,
      dryRun: false,
      actions: plan.actions,
      inspection,
      systemdUnits: this.generateSystemdUnits(),
    };
  }

  async start(options: { dryRun?: boolean } = {}): Promise<HostingLifecycleResult> {
    const dryRun = options.dryRun ?? true;
    const plan = await this.plan();
    if (plan.blockers.length > 0) throw new HostingProvisionBlockedError(plan.blockers);
    if (plan.actions.length > 0) {
      throw new HostingProvisionBlockedError(["hosting must be provisioned before the generated units can start"]);
    }
    if (plan.inspection.service.state === "active" && plan.inspection.service.serverState === "active") {
      return { changed: false, dryRun, state: "active", command: "already active" };
    }
    if (plan.inspection.service.serverState !== "active" && await this.#originIsOccupied(this.options.origin)) {
      throw new HostingProvisionBlockedError([
        "the loopback origin port is already in use; stop the previous VSPiLink sidecar before starting systemd hosting",
      ]);
    }
    const request: CommandRequest = {
      command: this.options.systemctlPath,
      args: ["--user", "start", this.options.systemdUnitName],
      timeoutMs: 30_000,
    };
    const command = redactCommand(request.command, request.args);
    if (dryRun) return { changed: true, dryRun: true, state: plan.inspection.service.state, command };
    await runChecked(this.#runner, request);
    const [tunnelState, serverState] = await Promise.all([
      this.#serviceState(this.options.systemdUnitName),
      this.#serviceState(this.options.serverSystemdUnitName),
    ]);
    if (tunnelState !== "active" || serverState !== "active") {
      throw new Error("systemd did not report both VSPiLink server and tunnel as active");
    }
    return { changed: true, dryRun: false, state: "active", command };
  }

  async stop(options: { dryRun?: boolean } = {}): Promise<HostingLifecycleResult> {
    const dryRun = options.dryRun ?? true;
    const [tunnelState, serverState] = await Promise.all([
      this.#serviceState(this.options.systemdUnitName),
      this.#serviceState(this.options.serverSystemdUnitName),
    ]);
    if (tunnelState === "inactive" && serverState === "inactive") {
      return { changed: false, dryRun, state: "inactive", command: "already inactive" };
    }
    const request: CommandRequest = {
      command: this.options.systemctlPath,
      args: ["--user", "stop", this.options.systemdUnitName, this.options.serverSystemdUnitName],
      timeoutMs: 30_000,
    };
    const command = redactCommand(request.command, request.args);
    if (dryRun) return { changed: true, dryRun: true, state: tunnelState, command };
    await runChecked(this.#runner, request);
    const [finalTunnelState, finalServerState] = await Promise.all([
      this.#serviceState(this.options.systemdUnitName),
      this.#serviceState(this.options.serverSystemdUnitName),
    ]);
    if (finalTunnelState === "active" || finalServerState === "active") {
      throw new Error("systemd still reports a VSPiLink hosting unit as active");
    }
    return { changed: true, dryRun: false, state: "inactive", command };
  }

  async #binaryVersion(command: string, args: string[]): Promise<{ available: boolean; version?: string }> {
    const result = await this.#runner.run({ command, args, timeoutMs: 10_000 });
    if (result.exitCode !== 0) return { available: false };
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const nodeVersion = output.match(/\bv?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/)?.[0];
    return { available: true, version: nodeVersion };
  }

  async #inspectTunnel(certificateRealPath: string): Promise<TunnelInspection> {
    const result = await runChecked(this.#runner, {
      command: this.options.cloudflaredPath,
      args: [
        "tunnel",
        "--origincert",
        certificateRealPath,
        "list",
        "--name",
        this.options.tunnelName,
        "--output",
        "json",
      ],
      timeoutMs: 30_000,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.trim() || "[]");
    } catch {
      throw new Error("cloudflared returned an invalid tunnel list");
    }
    const records = parsed === null ? [] : parsed;
    if (!Array.isArray(records)) throw new Error("cloudflared returned an invalid tunnel list");
    const matches = records.filter((record): record is CloudflaredTunnelRecord => (
      typeof record === "object"
      && record !== null
      && (record as CloudflaredTunnelRecord).name === this.options.tunnelName
    ));
    if (matches.length === 0) return { state: "missing", name: this.options.tunnelName };
    if (matches.length !== 1 || typeof matches[0].id !== "string") {
      throw new Error("Cloudflare returned an ambiguous named tunnel");
    }
    const id = validateTunnelId(matches[0].id);
    const connections = Array.isArray(matches[0].connections) ? matches[0].connections.length : 0;
    return { state: "present", id, name: this.options.tunnelName, activeConnections: connections };
  }

  async #serviceState(unitName: string): Promise<SystemdServiceState> {
    const result = await this.#runner.run({
      command: this.options.systemctlPath,
      args: ["--user", "is-active", unitName],
      timeoutMs: 10_000,
    });
    const status = result.stdout.trim();
    if (result.exitCode === 0 && status === "active") return "active";
    if (status === "inactive" || status === "failed" || result.exitCode === 3) return "inactive";
    return "unknown";
  }

  async #ensureStateDirectory(): Promise<void> {
    await fs.mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    const inspection = await inspectSecurePath(this.options.stateDirectory, {
      kind: "directory",
      expectedMode: 0o700,
      expectedUid: this.options.expectedOwnerUid,
    });
    if (inspection.state === "insecure" && inspection.uid === this.options.expectedOwnerUid) {
      await fs.chmod(this.options.stateDirectory, 0o700);
      return;
    }
    if (inspection.state !== "secure") throw new HostingProvisionBlockedError([securityIssue("state directory", inspection)]);
  }

  async #createDnsIdempotently(api: CloudflareApiClient, hostname: string, tunnelId: string): Promise<void> {
    const current = await api.inspectDnsRecord(hostname, tunnelId);
    if (current.state === "matching") return;
    if (current.state !== "missing") {
      throw new HostingProvisionBlockedError([`${hostname}: DNS record changed during provisioning`]);
    }
    try {
      await api.createDnsRecord(hostname, tunnelId);
    } catch (error) {
      const raced = await api.inspectDnsRecord(hostname, tunnelId);
      if (raced.state === "matching") return;
      throw error;
    }
  }
}

function action(
  kind: HostingActionKind,
  description: string,
  mutatesRemote = false,
  hostname?: string,
): HostingPlanAction {
  return { kind, description, mutatesRemote, ...(hostname ? { hostname } : {}) };
}

function hasAction(actions: readonly HostingPlanAction[], kind: HostingActionKind): boolean {
  return actions.some((plannedAction) => plannedAction.kind === kind);
}

function canRepairMode(inspection: SecurePathInspection, expectedUid: number): boolean {
  return inspection.state === "insecure" && inspection.uid === expectedUid;
}

function addManagedPathBlockers(
  blockers: string[],
  label: string,
  inspection: SecurePathInspection,
  allowMissing: boolean,
): void {
  if (inspection.state === "missing" && allowMissing) return;
  if (inspection.state === "invalid" || (inspection.state === "insecure" && inspection.uid === undefined)) {
    blockers.push(securityIssue(label, inspection));
  } else if (inspection.state === "insecure" && inspection.reason?.startsWith("owner uid")) {
    blockers.push(securityIssue(label, inspection));
  }
}

function securityIssue(label: string, inspection: SecurePathInspection): string {
  if (inspection.state === "missing") return `${label} is missing`;
  return `${label} is not secure${inspection.reason ? `: ${inspection.reason}` : ""}`;
}

async function secureManagedFile(targetPath: string, expectedUid: number): Promise<void> {
  const before = await inspectSecurePath(targetPath, {
    kind: "file",
    expectedMode: 0o600,
    expectedUid,
    requireNonEmpty: true,
  });
  if (before.state === "insecure" && before.uid === expectedUid) {
    await fs.chmod(targetPath, 0o600);
  } else if (before.state !== "secure") {
    throw new HostingProvisionBlockedError([securityIssue("managed secret file", before)]);
  }
  const after = await inspectSecurePath(targetPath, {
    kind: "file",
    expectedMode: 0o600,
    expectedUid,
    requireNonEmpty: true,
  });
  if (after.state !== "secure") throw new HostingProvisionBlockedError([securityIssue("managed secret file", after)]);
}

async function atomicPrivateWrite(
  targetPath: string,
  content: string,
  stateDirectory: string,
  expectedUid: number,
): Promise<void> {
  const existing = await inspectSecurePath(targetPath, {
    kind: "file",
    expectedMode: 0o600,
    expectedUid,
    expectedContent: content,
  });
  if (
    existing.state !== "missing"
    && (existing.state === "invalid" || existing.uid !== expectedUid || !existing.managedByVSPiLink)
  ) {
    throw new HostingProvisionBlockedError(["refusing to replace an unmanaged or unsafe cloudflared config"]);
  }
  const temporaryPath = path.join(stateDirectory, `.config-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, targetPath);
    await fs.chmod(targetPath, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function isRegularFile(targetPath: string): Promise<boolean> {
  try {
    const status = await fs.stat(targetPath);
    return status.isFile();
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function safeFailure(prefix: string, error: unknown): string {
  if (error instanceof RedactedCommandError) return `${prefix}: ${error.message}`;
  if (error instanceof Error && /different DNS zone|not active|HTTP \d{3}/.test(error.message)) {
    return `${prefix}: ${error.message}`;
  }
  return prefix;
}

async function isOriginOccupied(originValue: string): Promise<boolean> {
  const origin = new URL(originValue);
  const hostname = origin.hostname === "[::1]" ? "::1" : origin.hostname;
  const port = Number(origin.port);
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: hostname, port });
    const finish = (occupied: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
