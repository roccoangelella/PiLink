import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CloudflareNamedTunnelOptions,
  SecurePathInspection,
} from "./types.js";

export const MANAGED_CONFIG_HEADER = "# Managed by PiLink Cloudflare hosting. Do not add secrets here.";
export const MANAGED_SYSTEMD_HEADER = "# Managed by PiLink hosting. Generated file; do not edit.";

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TUNNEL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;
const SYSTEMD_UNIT = /^[A-Za-z0-9](?:[A-Za-z0-9_.@-]{0,126}[A-Za-z0-9])?\.service$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface NormalizedOriginCertificateAuth {
  kind: "origin-certificate";
  certificatePath: string;
}

export interface NormalizedTunnelTokenAuth {
  kind: "tunnel-token-file";
  tokenFile: string;
  tunnelId: string;
  dnsManagedExternally: true;
}

export type NormalizedHostingAuth = NormalizedOriginCertificateAuth | NormalizedTunnelTokenAuth;

export interface NormalizedCloudflareHostingOptions {
  tunnelName: string;
  origin: string;
  mcpHostname: string;
  landingHostname: string;
  zoneName: string;
  auth: NormalizedHostingAuth;
  stateDirectory: string;
  configPath: string;
  credentialsPath: string;
  cloudflaredPath: string;
  nodePath: string;
  pilinkCliPath: string;
  pilinkConfigPath: string;
  systemctlPath: string;
  systemdUnitName: string;
  serverSystemdUnitName: string;
  metricsAddress: string;
  expectedOwnerUid: number;
}

export interface InspectSecurePathOptions {
  kind: "file" | "directory";
  expectedMode: number;
  expectedUid: number;
  allowSymlink?: boolean;
  expectedContent?: string;
  managedHeader?: string;
  requireNonEmpty?: boolean;
}

export function normalizeHostingOptions(input: CloudflareNamedTunnelOptions): NormalizedCloudflareHostingOptions {
  if (typeof input.zoneName !== "string" || input.zoneName.trim() === "") {
    throw new Error("zoneName is required; provide the customer-owned Cloudflare DNS zone explicitly");
  }
  const zoneName = validateHostname(input.zoneName, "zoneName");
  const mcpHostname = validateHostname(input.mcpHostname, "mcpHostname");
  const landingHostname = validateHostname(input.landingHostname, "landingHostname");
  if (mcpHostname === landingHostname) {
    throw new Error("MCP and landing hostnames must be distinct");
  }
  assertHostnameInZone(mcpHostname, zoneName, "mcpHostname");
  assertHostnameInZone(landingHostname, zoneName, "landingHostname");

  if (!TUNNEL_NAME.test(input.tunnelName)) {
    throw new Error("tunnelName must be 2-63 characters using only letters, numbers, dot, underscore, or hyphen");
  }

  const stateDirectory = requireAbsolutePath(input.stateDirectory, "stateDirectory");
  const configPath = requireChildPath(
    stateDirectory,
    input.configPath ?? path.join(stateDirectory, "config.yml"),
    "configPath",
  );
  const credentialsPath = requireChildPath(
    stateDirectory,
    input.credentialsPath ?? path.join(stateDirectory, "tunnel-credentials.json"),
    "credentialsPath",
  );
  const cloudflaredPath = requireAbsolutePath(input.cloudflaredPath ?? "/usr/bin/cloudflared", "cloudflaredPath");
  const nodePath = requireAbsolutePath(input.nodePath ?? process.execPath, "nodePath");
  const pilinkCliPath = requireAbsolutePath(
    input.pilinkCliPath ?? fileURLToPath(new URL("../cli.js", import.meta.url)),
    "pilinkCliPath",
  );
  const pilinkConfigPath = requireAbsolutePath(
    input.pilinkConfigPath
      ?? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "pilink", ".env"),
    "pilinkConfigPath",
  );
  const systemctlPath = requireAbsolutePath(input.systemctlPath ?? "/usr/bin/systemctl", "systemctlPath");
  const systemdUnitName = input.systemdUnitName ?? "vspilink-cloudflared.service";
  if (!SYSTEMD_UNIT.test(systemdUnitName) || systemdUnitName.includes("..")) {
    throw new Error("systemdUnitName must be a safe .service unit name");
  }
  const serverSystemdUnitName = input.serverSystemdUnitName ?? "vspilink-server.service";
  if (!SYSTEMD_UNIT.test(serverSystemdUnitName) || serverSystemdUnitName.includes("..")) {
    throw new Error("serverSystemdUnitName must be a safe .service unit name");
  }
  if (serverSystemdUnitName === systemdUnitName) throw new Error("server and tunnel systemd units must be distinct");

  const auth: NormalizedHostingAuth = input.auth.kind === "origin-certificate"
    ? {
        kind: "origin-certificate",
        certificatePath: requireAbsolutePath(input.auth.certificatePath, "certificatePath"),
      }
    : {
        kind: "tunnel-token-file",
        tokenFile: requireAbsolutePath(input.auth.tokenFile, "tokenFile"),
        tunnelId: validateTunnelId(input.auth.tunnelId),
        dnsManagedExternally: true,
      };

  assertDistinctPaths([
    ["configPath", configPath],
    ["credentialsPath", credentialsPath],
    ["pilinkConfigPath", pilinkConfigPath],
    [auth.kind === "origin-certificate" ? "certificatePath" : "tokenFile",
      auth.kind === "origin-certificate" ? auth.certificatePath : auth.tokenFile],
  ]);

  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const expectedOwnerUid = input.expectedOwnerUid ?? currentUid;
  if (!Number.isSafeInteger(expectedOwnerUid) || (expectedOwnerUid as number) < 0) {
    throw new Error("expectedOwnerUid is required on platforms without process.getuid()");
  }

  const origin = validateLoopbackOrigin(input.origin);
  const metricsAddress = validateLoopbackAddress(input.metricsAddress ?? "127.0.0.1:20246", "metricsAddress");
  if (new URL(origin).host === metricsAddress) throw new Error("metricsAddress must not reuse the PiLink origin port");

  return {
    tunnelName: input.tunnelName,
    origin,
    mcpHostname,
    landingHostname,
    zoneName,
    auth,
    stateDirectory,
    configPath,
    credentialsPath,
    cloudflaredPath,
    nodePath,
    pilinkCliPath,
    pilinkConfigPath,
    systemctlPath,
    systemdUnitName,
    serverSystemdUnitName,
    metricsAddress,
    expectedOwnerUid: expectedOwnerUid as number,
  };
}

export function validateHostname(value: string, field: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (hostname !== value.trim() || hostname.length > 253 || hostname.length < 3 || hostname.includes("..")) {
    throw new Error(`${field} must be a lowercase ASCII hostname without a trailing dot`);
  }
  const labels = hostname.split(".");
  if (labels.length < 2 || labels.some((label) => !HOST_LABEL.test(label))) {
    throw new Error(`${field} is not a valid DNS hostname`);
  }
  return hostname;
}

export function validateTunnelId(value: string): string {
  if (!UUID.test(value)) throw new Error("tunnelId must be a valid Cloudflare tunnel UUID");
  return value.toLowerCase();
}

export function validateLoopbackOrigin(value: string): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("origin must be an absolute loopback HTTP URL");
  }
  if (
    origin.protocol !== "http:"
    || !["127.0.0.1", "[::1]"].includes(origin.hostname)
    || !origin.port
    || Number(origin.port) < 1
    || origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
  ) {
    throw new Error("origin must be http://127.0.0.1:PORT or http://[::1]:PORT with no credentials or path");
  }
  return origin.origin;
}

export function renderCloudflaredConfig(options: NormalizedCloudflareHostingOptions): string {
  const credentials = options.auth.kind === "origin-certificate"
    ? `credentials-file: ${yamlScalar(options.credentialsPath)}\n`
    : "";
  return [
    MANAGED_CONFIG_HEADER,
    `tunnel: ${yamlScalar(options.auth.kind === "tunnel-token-file" ? options.auth.tunnelId : options.tunnelName)}`,
    credentials.trimEnd(),
    `metrics: ${yamlScalar(options.metricsAddress)}`,
    "loglevel: info",
    "ingress:",
    `  - hostname: ${yamlScalar(options.mcpHostname)}`,
    `    service: ${yamlScalar(options.origin)}`,
    "    originRequest:",
    "      connectTimeout: 10s",
    `  - hostname: ${yamlScalar(options.landingHostname)}`,
    `    service: ${yamlScalar(options.origin)}`,
    "    originRequest:",
    "      connectTimeout: 10s",
    "  - service: http_status:404",
    "",
  ].filter((line) => line !== "").join("\n") + "\n";
}

export function renderSystemdUserUnits(options: NormalizedCloudflareHostingOptions): {
  server: { name: string; content: string };
  tunnel: { name: string; content: string };
} {
  const origin = new URL(options.origin);
  const serverEnvironment = [
    "NODE_ENV=production",
    `PILINK_CONFIG=${options.pilinkConfigPath}`,
    `HOST=${origin.hostname === "[::1]" ? "::1" : origin.hostname}`,
    `PORT=${origin.port}`,
    `SERVER_URL=https://${options.mcpHostname}`,
    "TRUST_PROXY=true",
  ];
  const serverContent = [
    MANAGED_SYSTEMD_HEADER,
    "[Unit]",
    "Description=PiLink persistent MCP server",
    "Wants=network-online.target",
    "After=network-online.target",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${[options.nodePath, options.pilinkCliPath, "serve"].map(systemdArgument).join(" ")}`,
    ...serverEnvironment.map((entry) => `Environment=${systemdArgument(entry)}`),
    "Restart=on-failure",
    "RestartSec=5s",
    "TimeoutStopSec=30s",
    "UMask=0077",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=full",
    "ProtectKernelTunables=true",
    "ProtectKernelModules=true",
    "ProtectKernelLogs=true",
    "ProtectControlGroups=true",
    "ProtectClock=true",
    "ProtectHostname=true",
    "RestrictSUIDSGID=true",
    "LockPersonality=true",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "StandardOutput=journal",
    "StandardError=journal",
    "SyslogIdentifier=vspilink-server",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

  const runArguments = options.auth.kind === "tunnel-token-file"
    ? ["run", "--token-file", options.auth.tokenFile, options.auth.tunnelId]
    : ["run", options.tunnelName];
  const execArguments = [
    options.cloudflaredPath,
    "tunnel",
    "--config",
    options.configPath,
    "--no-autoupdate",
    "--loglevel",
    "info",
    "--metrics",
    options.metricsAddress,
    ...runArguments,
  ];
  const tunnelContent = [
    MANAGED_SYSTEMD_HEADER,
    "[Unit]",
    "Description=PiLink dedicated Cloudflare named tunnel",
    "Documentation=https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/",
    `Requires=${options.serverSystemdUnitName}`,
    `After=network-online.target ${options.serverSystemdUnitName}`,
    "Wants=network-online.target",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execArguments.map(systemdArgument).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "TimeoutStopSec=30s",
    "UMask=0077",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "PrivateDevices=true",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    "ProtectKernelTunables=true",
    "ProtectKernelModules=true",
    "ProtectKernelLogs=true",
    "ProtectControlGroups=true",
    "ProtectClock=true",
    "ProtectHostname=true",
    "RestrictSUIDSGID=true",
    "RestrictRealtime=true",
    "RestrictNamespaces=true",
    "LockPersonality=true",
    "MemoryDenyWriteExecute=true",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    `ReadOnlyPaths=${systemdArgument(options.stateDirectory)}`,
    "StandardOutput=journal",
    "StandardError=journal",
    "SyslogIdentifier=vspilink-cloudflared",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return {
    server: { name: options.serverSystemdUnitName, content: serverContent },
    tunnel: { name: options.systemdUnitName, content: tunnelContent },
  };
}

/** Backward-compatible convenience for callers that only need the tunnel unit text. */
export function renderSystemdUserUnit(options: NormalizedCloudflareHostingOptions): string {
  return renderSystemdUserUnits(options).tunnel.content;
}

export async function inspectSecurePath(
  targetPath: string,
  options: InspectSecurePathOptions,
): Promise<SecurePathInspection> {
  let entry;
  try {
    entry = await fs.lstat(targetPath);
  } catch (error) {
    if (isNotFound(error)) return { path: targetPath, state: "missing" };
    return { path: targetPath, state: "invalid", reason: errorMessage(error) };
  }

  if (entry.isSymbolicLink() && !options.allowSymlink) {
    return { path: targetPath, state: "invalid", reason: "symbolic links are not accepted for managed secret paths" };
  }

  let realPath: string;
  let status;
  try {
    realPath = await fs.realpath(targetPath);
    status = await fs.stat(realPath);
  } catch (error) {
    return { path: targetPath, state: "invalid", reason: errorMessage(error) };
  }
  if (options.kind === "file" ? !status.isFile() : !status.isDirectory()) {
    return {
      path: targetPath,
      realPath,
      state: "invalid",
      reason: `expected a regular ${options.kind}`,
    };
  }

  const mode = status.mode & 0o777;
  const inspection: SecurePathInspection = {
    path: targetPath,
    realPath,
    mode,
    uid: status.uid,
    state: mode === options.expectedMode && status.uid === options.expectedUid ? "secure" : "insecure",
  };
  if (status.uid !== options.expectedUid) inspection.reason = `owner uid must be ${options.expectedUid}`;
  else if (mode !== options.expectedMode) inspection.reason = `mode must be ${octal(options.expectedMode)}`;

  if (options.kind === "file" && (options.expectedContent !== undefined || options.requireNonEmpty)) {
    if (status.size > 1024 * 1024) {
      return { ...inspection, state: "invalid", reason: "managed file is unexpectedly large" };
    }
    try {
      const content = await fs.readFile(realPath, "utf8");
      if (options.requireNonEmpty && content.trim().length === 0) {
        return { ...inspection, state: "invalid", reason: "secret file is empty" };
      }
      if (options.expectedContent !== undefined) {
        inspection.contentMatches = content === options.expectedContent;
        inspection.managedByPiLink = content.startsWith(options.managedHeader ?? MANAGED_CONFIG_HEADER);
      }
    } catch (error) {
      return { ...inspection, state: "invalid", reason: errorMessage(error) };
    }
  }
  return inspection;
}

export function redactCommand(command: string, args: readonly string[]): string {
  const privateFlags = new Set([
    "--origincert",
    "--credentials-file",
    "--cred-file",
    "--credentials-contents",
    "--token",
    "--token-file",
    "--secret",
    "--config",
  ]);
  const rendered = [path.basename(command)];
  let redactNext = false;
  for (const argument of args) {
    if (redactNext) {
      rendered.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    const inlinePrivateFlag = [...privateFlags].find((flag) => argument.startsWith(`${flag}=`));
    if (inlinePrivateFlag) {
      rendered.push(`${inlinePrivateFlag}=[REDACTED]`);
      continue;
    }
    rendered.push(shellDisplay(argument));
    if (privateFlags.has(argument)) redactNext = true;
  }
  return rendered.join(" ");
}

function assertHostnameInZone(hostname: string, zoneName: string, field: string): void {
  if (hostname === zoneName || !hostname.endsWith(`.${zoneName}`)) {
    throw new Error(`${field} must be a subdomain of ${zoneName}`);
  }
}

function requireAbsolutePath(value: string, field: string): string {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`${field} must be an absolute path`);
  return path.resolve(value);
}

function requireChildPath(parent: string, value: string, field: string): string {
  const child = requireAbsolutePath(value, field);
  const relative = path.relative(parent, child);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${field} must be a file inside stateDirectory`);
  }
  return child;
}

function validateLoopbackAddress(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new Error(`${field} must be a loopback HOST:PORT address`);
  }
  if (
    !["127.0.0.1", "[::1]"].includes(parsed.hostname)
    || !parsed.port
    || Number(parsed.port) < 1
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`${field} must bind to 127.0.0.1 or ::1 with an explicit port`);
  }
  return parsed.host;
}

function assertDistinctPaths(entries: Array<[string, string]>): void {
  for (let index = 0; index < entries.length; index += 1) {
    for (let other = index + 1; other < entries.length; other += 1) {
      if (entries[index][1] === entries[other][1]) {
        throw new Error(`${entries[index][0]} and ${entries[other][0]} must be different files`);
      }
    }
  }
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function systemdArgument(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("systemd arguments cannot contain control characters");
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, () => "$$")}"`;
}

function shellDisplay(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value);
}

function octal(mode: number): string {
  return `0${mode.toString(8)}`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "filesystem inspection failed";
}
