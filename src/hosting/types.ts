export type CloudflareHostingAuth =
  | {
      kind: "origin-certificate";
      /** Supplied by the operator at runtime. It is never embedded in the package. */
      certificatePath: string;
    }
  | {
      kind: "tunnel-token-file";
      /** A token scoped to one pre-provisioned tunnel. The token value never enters argv. */
      tokenFile: string;
      tunnelId: string;
      /** Token customers do not receive account-wide DNS credentials. */
      dnsManagedExternally: true;
    };

export interface CloudflareNamedTunnelOptions {
  tunnelName: string;
  origin: string;
  mcpHostname: string;
  landingHostname: string;
  /** Customer-owned DNS zone. It must always be provided explicitly. */
  zoneName: string;
  auth: CloudflareHostingAuth;
  stateDirectory: string;
  configPath?: string;
  credentialsPath?: string;
  cloudflaredPath?: string;
  nodePath?: string;
  pilinkCliPath?: string;
  pilinkConfigPath?: string;
  systemctlPath?: string;
  systemdUnitName?: string;
  serverSystemdUnitName?: string;
  metricsAddress?: string;
  expectedOwnerUid?: number;
}

export interface CommandRequest {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Set false for commands whose output could contain credentials. */
  captureOutput?: boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

export interface CloudflareHostingDependencies {
  runner?: CommandRunner;
  fetch?: typeof globalThis.fetch;
  /** Returns true when another process already owns the configured origin endpoint. */
  originIsOccupied?: (origin: string) => Promise<boolean>;
}

export type SecurePathState = "missing" | "secure" | "insecure" | "invalid";

export interface SecurePathInspection {
  path: string;
  state: SecurePathState;
  realPath?: string;
  mode?: number;
  uid?: number;
  reason?: string;
  contentMatches?: boolean;
  managedByVSPiLink?: boolean;
}

export interface TunnelInspection {
  state: "missing" | "present" | "external";
  id?: string;
  name: string;
  activeConnections?: number;
}

export interface DnsRecordInspection {
  hostname: string;
  state: "missing" | "matching" | "needs-proxy" | "conflict" | "external";
  recordId?: string;
  target?: string;
  proxied?: boolean;
  reason?: string;
}

export type SystemdServiceState = "active" | "inactive" | "unknown";

export interface CloudflareHostingInspection {
  zoneName: string;
  origin: string;
  publicUrls: {
    mcp: string;
    landing: string;
  };
  cloudflared: {
    available: boolean;
    version?: string;
  };
  nodeRuntime: {
    path: string;
    available: boolean;
    version?: string;
    compatible: boolean;
  };
  serverConfig: SecurePathInspection;
  authentication: {
    kind: CloudflareHostingAuth["kind"];
    secure: boolean;
    path: SecurePathInspection;
  };
  stateDirectory: SecurePathInspection;
  config: SecurePathInspection;
  credentials: SecurePathInspection;
  tunnel: TunnelInspection;
  dns: DnsRecordInspection[];
  service: {
    unitName: string;
    state: SystemdServiceState;
    serverUnitName: string;
    serverState: SystemdServiceState;
  };
  blockers: string[];
}

export type HostingActionKind =
  | "create-state-directory"
  | "secure-state-directory"
  | "create-tunnel"
  | "recover-tunnel-credentials"
  | "secure-tunnel-credentials"
  | "write-config"
  | "secure-config"
  | "create-dns-record"
  | "enable-dns-proxy";

export interface HostingPlanAction {
  kind: HostingActionKind;
  description: string;
  mutatesRemote: boolean;
  hostname?: string;
}

export interface CloudflareHostingPlan {
  inspection: CloudflareHostingInspection;
  actions: HostingPlanAction[];
  blockers: string[];
  systemdUnits: GeneratedSystemdUnits;
  dryRun: true;
}

export interface CloudflareProvisionResult {
  changed: boolean;
  dryRun: boolean;
  actions: HostingPlanAction[];
  inspection: CloudflareHostingInspection;
  systemdUnits: GeneratedSystemdUnits;
}

export interface GeneratedSystemdUnits {
  server: { name: string; content: string };
  tunnel: { name: string; content: string };
}

export interface HostingLifecycleResult {
  changed: boolean;
  dryRun: boolean;
  state: SystemdServiceState;
  command: string;
}
