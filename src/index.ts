// ─────────────────────────────────────────────────────────────
// PiLink: Main Entry Point
// Supports Streamable HTTP and legacy SSE MCP transports
// Exposes the native Pi Agent tool harness to MCP clients
// ─────────────────────────────────────────────────────────────

import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer, type McpAgentServices } from "./mcp.js";
import { createOAuthRouter } from "./oauth.js";
import { authenticateBearer, findClient } from "./auth.js";
import { createHarnessPolicy } from "./harness.js";
import { loadEnvironment, loadRuntimeConfig, VERSION } from "./config.js";
import { createCorsAndOriginProtection, createRateLimiter } from "./security.js";
import { createHealthProof, HEALTH_AUTH_SCHEME, isHealthChallenge } from "./health-proof.js";
import { assertRequiredNodeVersion } from "./runtime.js";
import { hasBootstrapAccess, isLocalAdminRequest, requestHostname } from "./oauth-owner.js";
import { recordMcpInitialized, serviceActivitySnapshot, setActiveMcpSessions, type ClientActivity } from "./service-status.js";
import { AgentCoordinationStore } from "./agents/coordination.js";
import { AgentManager } from "./agents/manager.js";
import { PiSdkRuntimeAdapter } from "./agents/pi-sdk-adapter.js";
import { resolveAgentRole } from "./agents/roles.js";
import { AGENT_PERMISSIONS, AGENT_STATUSES, type AgentPermission, type AgentSnapshot } from "./agents/types.js";
import { asyncRoute, safeHttpErrorHandler } from "./http.js";
import { AgentChatBroker, AgentChatStore } from "./chat.js";
import { ToolAuditLog } from "./audit.js";
import { AgentTaskStore } from "./tasks.js";
import { CollaborationSessionStore } from "./collaboration-sessions.js";
import { CollaborationBootstrap } from "./collaboration-bootstrap.js";
import { CollaborationContextRegistry } from "./collaboration-context-registry.js";
import { AgentMemoryStore } from "./memory.js";
import { AgentWorkLoopStore } from "./work-loop.js";

assertRequiredNodeVersion();
loadEnvironment();
const config = loadRuntimeConfig();
const policy = createHarnessPolicy(config);
const { port: PORT, host: HOST, serverUrl: SERVER_URL } = config;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type AgentRuntimeState = "disabled" | "ready" | "degraded" | "unavailable";
type CoordinationUnavailableReason = "unsafe_data_location" | "initialization_failed";
type AdminCollaborationUnavailableReason = "private_store_unavailable";
const LOCAL_ADMIN_AGENT_CONTROLLER_ID = "local-admin";
const effectiveAgentConcurrency = config.runtimeMode === "single" ? 1 : config.maxConcurrentAgents;

interface AdminCollaborationDegradedResponse {
  status: "degraded";
  error: "collaboration_unavailable";
  reason: AdminCollaborationUnavailableReason;
  project_key: null;
  chat: {
    oldest_cursor: 0;
    latest_cursor: 0;
    next_cursor: 0;
    gap: false;
    messages: [];
  };
  tasks: [];
  tool_activity: [];
  clients: ClientActivity[];
  timestamp: string;
}

interface SharedAgentRuntime {
  state: AgentRuntimeState;
  manager?: AgentManager;
  coordination?: AgentCoordinationStore;
  coordinationReason?: CoordinationUnavailableReason;
}

const sharedAgentRuntime = initializeSharedAgentRuntime();
const launchEventFd = parseLaunchEventFd(process.env.PI_LAUNCH_EVENT_FD);
let launchConnectionEventSent = false;
let collaborationAdminFailureLogged = false;

function parseLaunchEventFd(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const descriptor = Number(value);
  return Number.isSafeInteger(descriptor) && descriptor >= 3 ? descriptor : undefined;
}

function notifyParentOfMcpConnection(): void {
  if (launchConnectionEventSent || launchEventFd === undefined) return;
  launchConnectionEventSent = true;
  try {
    fs.writeSync(launchEventFd, "mcp-connected\n", undefined, "utf8");
  } catch {
    // The optional launcher channel must never affect the MCP service.
  }
}

function initializeSharedAgentRuntime(): SharedAgentRuntime {
  if (!config.agentProvider || !config.agentModel) return { state: "disabled" };

  let coordination: AgentCoordinationStore | undefined;
  let coordinationReason: CoordinationUnavailableReason | undefined;
  if (config.runtimeMode === "collaboration") {
    try {
      coordination = new AgentCoordinationStore({
        workspace: config.workspace,
        dataDir: config.coordinationDataDir,
        namespace: "default",
      });
    } catch (error) {
      coordinationReason = error instanceof Error && /outside the workspace/u.test(error.message)
        ? "unsafe_data_location"
        : "initialization_failed";
      console.error(coordinationReason === "unsafe_data_location"
        ? "[Agents] Coordination unavailable: PI_COORDINATION_DATA_DIR must be outside PI_WORK_DIR. Agent runtime remains available."
        : "[Agents] Coordination unavailable because its private store could not be initialized. Agent runtime remains available.");
    }
  }

  try {
    const adapter = new PiSdkRuntimeAdapter({
      policy,
      providerId: config.agentProvider,
      modelId: config.agentModel,
      ...(config.agentApiKey ? { apiKey: config.agentApiKey } : {}),
      thinkingLevel: config.agentThinkingLevel,
      ...(coordination ? { coordination } : {}),
    });
    const allowedPermissions: AgentPermission[] = [
      ...(config.runtimeMode === "collaboration" ? [
        "coordination:read" as const,
        "coordination:write" as const,
      ] : []),
      "workspace:read",
      "workspace:write",
      "network:outbound",
      ...(policy.unsafeFullAccess ? ["process:execute" as const] : []),
    ];
    const manager = new AgentManager({
      adapters: [adapter],
      allowedWorkspaceRoots: [config.workspace],
      allowedPermissions,
      maxConcurrentAgents: effectiveAgentConcurrency,
    });
    return {
      state: config.runtimeMode === "single" || coordination ? "ready" : "degraded",
      manager,
      ...(coordination ? { coordination } : {}),
      ...(coordinationReason ? { coordinationReason } : {}),
    };
  } catch {
    console.error("[Agents] Agent runtime unavailable because its supervisor could not be initialized.");
    return {
      state: "unavailable",
      ...(coordination ? { coordination } : {}),
      ...(coordinationReason ? { coordinationReason } : {}),
    };
  }
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);

const configuredHostname = new URL(SERVER_URL).hostname.toLowerCase();
const allowedHostnames = new Set([configuredHostname, config.landingHostname, "127.0.0.1", "localhost", "::1"].filter(Boolean));
app.use((req, res, next) => {
  const hostname = requestHostname(req);
  if (!allowedHostnames.has(hostname)) {
    res.status(421).json({ error: "misdirected_request" });
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("Cache-Control", "no-store");
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (req.secure || forwardedProto === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
  const landingOnlyHost = Boolean(
    config.landingHostname &&
    config.landingHostname !== configuredHostname &&
    hostname === config.landingHostname,
  );
  if (landingOnlyHost && !(["GET", "HEAD"].includes(req.method) && ["/", "/assets/logo.png"].includes(req.path))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
});

// ── Body parsing ─────────────────────────────────────────────
app.use(createCorsAndOriginProtection(config.corsOrigins));

// ── Browser-origin protection and CORS ────────────────────
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

// ── Request logging ──────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  const originalEnd = res.end;
  res.end = function (...args: any[]) {
    const duration = Date.now() - start;
    const hasSession = Boolean(req.headers["mcp-session-id"]);
    console.error(
      `[HTTP] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)` +
      (hasSession ? " session=present" : "")
    );
    return (originalEnd as Function).apply(res, args);
  } as any;
  next();
});

// ── Mount OAuth routes (public, no Bearer required) ──────────
const oauthRouter = createOAuthRouter();
app.use(["/oauth/token", "/oauth/register", "/oauth/authorize", "/oauth/pair", "/admin/oauth/pairing", "/admin/oauth/clients"], createRateLimiter(20, 60_000));
app.use(oauthRouter);
app.use(["/admin/status", "/admin/agents", "/admin/collaboration"], createRateLimiter(120, 60_000));

// ── Health / status endpoint ─────────────────────────────────
app.get("/health", (req, res) => {
  const challenge = req.query.challenge;
  const authenticated = isHealthChallenge(challenge)
    ? {
        auth_scheme: HEALTH_AUTH_SCHEME,
        challenge,
        proof: createHealthProof(config.bootstrapSecret, challenge, VERSION, PORT),
      }
    : {};
  res.json({
    status: "ok",
    server: "pilink",
    version: VERSION,
    runtime_mode: config.runtimeMode,
    harness: "pi-agent",
    // Keep the legacy health payload for existing browser-mode installs, while
    // new paired installs expose operational counters only on /admin/status.
    ...(config.oauthConsentMode === "browser" ? { sessions: publicSessionStatus() } : {}),
    timestamp: new Date().toISOString(),
    ...authenticated,
  });
});

// Private operational state is available only over the loopback host with the
// bootstrap credential. The public health endpoint intentionally stays small.
app.get("/admin/status", requireLocalAdmin, (_req, res) => {
  res.json({
    status: "ok",
    server: "pilink",
    version: VERSION,
    runtime_mode: config.runtimeMode,
    server_url: SERVER_URL,
    sessions: publicSessionStatus(),
    agents: publicAgentRuntimeStatus(),
    activity: serviceActivitySnapshot(),
    timestamp: new Date().toISOString(),
  });
});

// Read-only projection of the durable collaboration state introduced by the
// upstream feature/agent-public-chat branch.  The Textual client reads the
// same AgentChatStore and AgentTaskStore files directly; the VS Code
// extension uses this loopback-only endpoint so private paths and the
// bootstrap credential never cross into its untrusted webview.
app.get("/admin/collaboration", requireLocalAdmin, asyncRoute(async (req, res) => {
  if (config.runtimeMode === "single") {
    res.status(409).json({
      status: "disabled",
      error: "collaboration_disabled",
      reason: "runtime_mode_single",
      timestamp: new Date().toISOString(),
    });
    return;
  }
  const chatLimit = boundedAdminInteger(req.query.chat_limit, 20, 1, 20);
  const taskLimit = boundedAdminInteger(req.query.task_limit, 100, 1, 200);
  if (chatLimit === undefined || taskLimit === undefined) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const activity = serviceActivitySnapshot();
  try {
    const chatBroker = getAgentChatBroker();
    const [chat, tasks, toolActivity] = await Promise.all([
      chatBroker.read(),
      getAgentTaskStore().list({ limit: taskLimit }),
      getToolAuditLog().readRecent(50),
    ]);
    collaborationAdminFailureLogged = false;
    res.json({
      status: "ready",
      project_key: chatBroker.store.projectKey,
      chat: {
        oldest_cursor: chat.oldestCursor,
        latest_cursor: chat.latestCursor,
        next_cursor: chat.nextCursor,
        gap: chat.gap,
        messages: chat.messages.slice(-chatLimit).map((message) => ({
          cursor: message.cursor,
          agent_id: message.agentId,
          agent_instance_id: message.agentInstanceId,
          agent_name: message.agentName,
          message: message.agentMessage,
        })),
      },
      tasks: tasks.map((task) => ({
        task_id: task.taskId,
        title: task.title,
        ...(task.details ? { details: task.details } : {}),
        status: task.status,
        ...(task.statusMessage ? { status_message: task.statusMessage } : {}),
        ...(task.artifact ? { artifact: task.artifact } : {}),
        created_by: task.createdByAgentName,
        ...(task.ownerAgentName ? { owner: task.ownerAgentName } : {}),
        ...(task.leaseExpiresAt ? { lease_expires_at: task.leaseExpiresAt } : {}),
        created_at: task.createdAt,
        updated_at: task.updatedAt,
        revision: task.revision,
      })),
      tool_activity: toolActivity.map((event) => ({
        tool: event.tool,
        started_at: event.startedAt,
        duration_ms: event.durationMs,
        outcome: event.outcome,
        access_mode: event.accessMode,
        ...(event.agentId ? { client_id: event.agentId } : {}),
        ...(event.exitCode !== undefined ? { exit_code: event.exitCode } : {}),
        ...(event.timedOut !== undefined ? { timed_out: event.timedOut } : {}),
        ...(event.cancelled !== undefined ? { cancelled: event.cancelled } : {}),
      })),
      clients: activity.clients,
      timestamp: new Date().toISOString(),
    });
  } catch {
    if (!collaborationAdminFailureLogged) {
      collaborationAdminFailureLogged = true;
      console.error("[COLLABORATION] Administrative projection is degraded because its private store is unavailable.");
    }
    const degraded: AdminCollaborationDegradedResponse = {
      status: "degraded",
      error: "collaboration_unavailable",
      reason: "private_store_unavailable",
      project_key: null,
      chat: {
        oldest_cursor: 0,
        latest_cursor: 0,
        next_cursor: 0,
        gap: false,
        messages: [],
      },
      tasks: [],
      tool_activity: [],
      clients: activity.clients,
      timestamp: new Date().toISOString(),
    };
    res.json(degraded);
  }
}));

app.get("/admin/agents", requireLocalAdmin, (req, res) => {
  const manager = sharedAgentRuntime.manager;
  if (!manager) {
    res.json({ state: sharedAgentRuntime.state, agents: [] });
    return;
  }
  const limit = boundedAdminInteger(req.query.limit, 50, 1, 100);
  if (limit === undefined) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  res.json({
    state: sharedAgentRuntime.state,
    // AgentManager keeps its upstream-compatible chronological contract. The
    // local UI needs the opposite window so a newly opened chat cannot vanish
    // behind older retained sessions when a limit is applied.
    agents: manager.list().slice(-limit).reverse().map(publicAdminAgent),
  });
});

app.get("/admin/agents/:agentId", requireLocalAdmin, (req, res) => {
  const manager = requireAdminAgentManager(res);
  if (!manager) return;
  const agentId = singleAdminParam(req.params.agentId);
  if (!agentId) {
    res.status(404).json({ error: "agent_not_found" });
    return;
  }
  try {
    res.json({ agent: publicAdminAgent(manager.status(agentId)) });
  } catch {
    res.status(404).json({ error: "agent_not_found" });
  }
});

app.get("/admin/agents/:agentId/output", requireLocalAdmin, (req, res) => {
  const manager = requireAdminAgentManager(res);
  if (!manager) return;
  const agentId = singleAdminParam(req.params.agentId);
  const after = req.query.after === undefined
    ? undefined
    : boundedAdminInteger(req.query.after, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedAdminInteger(req.query.limit, 50, 1, 100);
  if (!agentId || (req.query.after !== undefined && after === undefined) || limit === undefined) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  try {
    const output = manager.outputRead(agentId, { ...(after === undefined ? {} : { after }), limit });
    res.json({
      oldest_cursor: output.oldestCursor,
      latest_cursor: output.latestCursor,
      next_cursor: output.nextCursor,
      gap: output.gap,
      entries: output.entries.map((entry) => ({
        cursor: entry.cursor,
        channel: entry.channel,
        text: entry.text,
        created_at: entry.createdAt,
      })),
    });
  } catch {
    res.status(404).json({ error: "agent_output_not_found" });
  }
});

app.post("/admin/agents/spawn", requireLocalAdmin, asyncRoute(async (req, res) => {
  const manager = requireAdminAgentManager(res);
  if (!manager) return;
  const input = parseAdminSpawnRequest(req.body);
  if (!input) {
    res.status(400).json({ error: "invalid_agent_spawn_request" });
    return;
  }
  try {
    const role = resolveAgentRole(input.role);
    const agent = await manager.spawn({
      controllerId: LOCAL_ADMIN_AGENT_CONTROLLER_ID,
      runtimeId: "pi-sdk",
      role: { canonicalRoleId: role.canonicalRoleId, occupancyLabel: role.occupancyLabel },
      workspace: policy.workspace,
      permissions: input.permissions,
      initialMessage: input.initialMessage,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.label ? { label: input.label } : {}),
    });
    res.status(201).json({ agent: publicAdminAgent(agent) });
  } catch {
    res.status(409).json({ error: "agent_spawn_rejected" });
  }
}));

app.post("/admin/agents/:agentId/send", requireLocalAdmin, (req, res) => {
  const manager = requireAdminAgentManager(res);
  if (!manager) return;
  const input = parseAdminSendRequest(req.body);
  if (!input) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const agentId = singleAdminParam(req.params.agentId);
  if (!agentId) {
    res.status(404).json({ error: "agent_not_found" });
    return;
  }
  try {
    // The Pi provider turn can take minutes, so acknowledge the queued
    // operation and let clients observe transcript/status through polling.
    const current = manager.status(agentId);
    if (current.status !== "running" && current.status !== "waiting") {
      res.status(409).json({ error: "agent_send_rejected" });
      return;
    }
    const pending = manager.send(agentId, input.message);
    const agent = manager.status(agentId);
    void pending.catch(() => undefined);
    res.status(202).json({ agent: publicAdminAgent(agent) });
  } catch {
    res.status(409).json({ error: "agent_send_rejected" });
  }
});

app.post("/admin/agents/:agentId/cancel", requireLocalAdmin, asyncRoute(async (req, res) => {
  const manager = requireAdminAgentManager(res);
  if (!manager) return;
  const input = parseAdminCancelRequest(req.body);
  if (!input) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const agentId = singleAdminParam(req.params.agentId);
  if (!agentId) {
    res.status(404).json({ error: "agent_not_found" });
    return;
  }
  try {
    const agent = await manager.cancel(agentId, input.reason);
    res.json({ agent: publicAdminAgent(agent) });
  } catch {
    res.status(409).json({ error: "agent_cancel_failed" });
  }
}));

app.post("/admin/agents/:agentId/stop", requireLocalAdmin, asyncRoute(async (req, res) => {
  const manager = requireAdminAgentManager(res);
  if (!manager) return;
  const reason = optionalAdminText(req.body?.reason, 4_096);
  if (reason === null || hasUnexpectedKeys(req.body, ["reason"])) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }
  const agentId = singleAdminParam(req.params.agentId);
  if (!agentId) {
    res.status(404).json({ error: "agent_not_found" });
    return;
  }
  try {
    const agent = await manager.stop(agentId, reason);
    res.json({ agent: publicAdminAgent(agent) });
  } catch {
    res.status(409).json({ error: "agent_stop_failed" });
  }
}));

// ── Landing page ─────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.type("html").send(renderLandingPage());
});
app.get("/assets/logo.png", (_req, res) => {
  res.type("png").sendFile(path.join(packageRoot, "docs", "assets", "logo.png"));
});

// ══════════════════════════════════════════════════════════════
// MCP Transport Layer (protected by OAuth Bearer token)
// ══════════════════════════════════════════════════════════════

interface ManagedTransport {
  transport: StreamableHTTPServerTransport | SSEServerTransport;
  server: ReturnType<typeof createMcpServer>;
  clientId: string;
  clientVersion: number;
  scope: string;
  createdAtMs: number;
  lastActivityAtMs: number;
  inFlightRequests: number;
  openStreams: number;
  established: boolean;
  closing?: Promise<void>;
}

const transports: Record<string, ManagedTransport> = {};
let pendingMcpSessionsTotal = 0;
const pendingMcpSessionsByClient = new Map<string, number>();
const idleSessionTimeoutMs = config.mcpSessionIdleTimeoutSeconds * 1_000;
const sessionReclaimGraceMs = config.mcpSessionReclaimGraceSeconds * 1_000;
let agentChatBroker: AgentChatBroker | undefined;
let toolAuditLog: ToolAuditLog | undefined;
let agentTaskStore: AgentTaskStore | undefined;
let collaborationSessionStore: CollaborationSessionStore | undefined;
let collaborationContextRegistry: CollaborationContextRegistry | undefined;
let agentMemoryStore: AgentMemoryStore | undefined;
let agentWorkLoopStore: AgentWorkLoopStore | undefined;

function getAgentChatBroker(): AgentChatBroker {
  if (!agentChatBroker) {
    agentChatBroker = new AgentChatBroker(new AgentChatStore({
      workspace: config.workspace,
      dataDir: config.coordinationDataDir,
    }));
  }
  return agentChatBroker;
}

function getToolAuditLog(): ToolAuditLog {
  if (!toolAuditLog) {
    toolAuditLog = new ToolAuditLog({
      workspace: config.workspace,
      dataDir: config.coordinationDataDir,
    });
  }
  return toolAuditLog;
}

function getAgentTaskStore(): AgentTaskStore {
  if (!agentTaskStore) {
    agentTaskStore = new AgentTaskStore({
      workspace: config.workspace,
      dataDir: config.coordinationDataDir,
    });
  }
  return agentTaskStore;
}

function getAgentMemoryStore(): AgentMemoryStore {
  if (!agentMemoryStore) {
    agentMemoryStore = new AgentMemoryStore({
      workspace: config.workspace,
      dataDir: config.coordinationDataDir,
    });
  }
  return agentMemoryStore;
}

function getCollaborationSessionStore(): CollaborationSessionStore {
  if (!collaborationSessionStore) {
    const keyMaterial = createHmac("sha256", config.jwtSecret)
      .update("pilink/collaboration-session/credential-key/v1", "utf8")
      .digest("base64url");
    collaborationSessionStore = new CollaborationSessionStore({
      workspace: config.workspace,
      dataDir: config.coordinationDataDir,
      credentialKey: {
        keyId: "jwt-hmac-v1",
        keyMaterial,
      },
    });
  }
  return collaborationSessionStore;
}

function getAgentWorkLoopStore(): AgentWorkLoopStore {
  if (!agentWorkLoopStore) {
    agentWorkLoopStore = new AgentWorkLoopStore({
      workspace: config.workspace,
      dataDir: config.coordinationDataDir,
      collaborationSessionStore: getCollaborationSessionStore(),
    });
  }
  return agentWorkLoopStore;
}

function createRawCollaborationBootstrap(
  identity: Readonly<{ agentId: string; agentName: string }>,
): CollaborationBootstrap {
  return new CollaborationBootstrap({
    sessionStore: getCollaborationSessionStore(),
    identity,
  });
}

function getCollaborationContextRegistry(): CollaborationContextRegistry {
  if (!collaborationContextRegistry) {
    const bindingKeyMaterial = createHmac("sha256", config.jwtSecret)
      .update("pilink/collaboration-context-binding-key/v1", "utf8")
      .digest();
    collaborationContextRegistry = new CollaborationContextRegistry({
      bindingKeyMaterial,
      detachGraceSeconds: config.collaborationBindingDetachGraceSeconds,
      createBootstrap: createRawCollaborationBootstrap,
      onLogicalSessionDispose: async (context) => {
        await getAgentWorkLoopStore().disconnect(context.collaborationSessionId);
      },
      onDisposeError: () => console.error("[COLLABORATION] Failed to dispose a detached logical session"),
    });
  }
  return collaborationContextRegistry;
}

function trustedCollaborationBinding(req: express.Request): string | undefined {
  const headerName = config.collaborationBindingHeader;
  if (!headerName) return undefined;
  const raw = req.headers[headerName];
  if (raw === undefined) return undefined;
  let occurrences = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === headerName) occurrences += 1;
  }
  if (occurrences > 1 || Array.isArray(raw)) {
    throw new Error(`Trusted collaboration binding header '${headerName}' must occur once`);
  }
  const normalized = raw.trim();
  if (!normalized) throw new Error(`Trusted collaboration binding header '${headerName}' must be non-empty`);
  if (Buffer.byteLength(normalized, "utf8") > 512) {
    throw new Error(`Trusted collaboration binding header '${headerName}' exceeds 512 UTF-8 bytes`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`Trusted collaboration binding header '${headerName}' contains control characters`);
  }
  return normalized;
}

function createConnectionMcpServer(
  clientId: string,
  clientVersion: number,
  scopes: string,
  logicalCollaborationBinding?: string,
) {
  const connectionPolicy = createHarnessPolicy(config, clientId);
  const identity = {
    agentId: clientId,
    agentName: coordinationActorName(clientId),
  };
  const granted = new Set(scopes.split(/\s+/u).filter(Boolean));
  const canRead = granted.has("mcp:read") || granted.has("mcp:tools");
  const canBootstrap = granted.has("mcp:write") || granted.has("mcp:tools");
  try {
    if (config.runtimeMode === "single") {
      return createMcpServer(
        connectionPolicy,
        scopes,
        undefined,
        undefined,
        getToolAuditLog(),
      );
    }
    const bootstrap = canBootstrap
      ? logicalCollaborationBinding
        ? getCollaborationContextRegistry().attach({
          identity,
          clientVersion,
          logicalBinding: logicalCollaborationBinding,
        })
        : createRawCollaborationBootstrap(identity)
      : undefined;
    return createMcpServer(
      connectionPolicy,
      scopes,
      identity,
      getAgentChatBroker(),
      getToolAuditLog(),
      undefined,
      getAgentTaskStore(),
      bootstrap,
      canRead ? getAgentMemoryStore() : undefined,
      bootstrap ? getAgentWorkLoopStore() : undefined,
      mcpAgentServices(clientId, connectionPolicy),
    );
  } catch {
    // A deliberately unsafe or unavailable private data directory must not
    // disable the supervised runtime or the basic workspace harness.
    console.error("[COLLABORATION] Durable upstream services are unavailable; continuing with the supervised runtime only.");
    return createMcpServer(connectionPolicy, scopes, mcpAgentServices(clientId, connectionPolicy));
  }
}

function tokenFor(req: express.Request): { sub: string; scope: string; client_version?: number } {
  return (req as express.Request & {
    tokenPayload: { sub: string; scope: string; client_version?: number };
  }).tokenPayload;
}

function effectiveCapabilities(scope: string): Set<"read" | "write"> {
  const granted = new Set(scope.split(/\s+/u).filter(Boolean));
  const capabilities = new Set<"read" | "write">();
  if (granted.has("mcp:tools") || granted.has("mcp:read")) capabilities.add("read");
  if (granted.has("mcp:tools") || granted.has("mcp:write")) capabilities.add("write");
  return capabilities;
}

function canReuseSession(
  managed: ManagedTransport,
  token: { sub: string; scope: string; client_version?: number },
): boolean {
  if (managed.clientId !== token.sub || managed.clientVersion !== (token.client_version ?? 1)) return false;
  const granted = effectiveCapabilities(token.scope);
  return [...effectiveCapabilities(managed.scope)].every((capability) => granted.has(capability));
}

function rejectSessionReuse(res: express.Response): void {
  res.status(403).json({ error: "forbidden", error_description: "Session belongs to another client" });
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}

function activeSessionsForClient(clientId: string): number {
  return Object.values(transports).filter((managed) => managed.clientId === clientId).length;
}

function publicSessionStatus() {
  const active = Object.values(transports);
  return {
    active: active.length,
    busy: active.filter((managed) => managed.inFlightRequests > 0 || managed.openStreams > 0).length,
    pending: pendingMcpSessionsTotal,
    max_total: config.maxMcpSessionsTotal,
    max_per_client: config.maxMcpSessionsPerClient,
    idle_timeout_seconds: config.mcpSessionIdleTimeoutSeconds,
    reclaim_grace_seconds: config.mcpSessionReclaimGraceSeconds,
  };
}

function publicAgentRuntimeStatus() {
  if (sharedAgentRuntime.state === "disabled") {
    return {
      state: "disabled",
      reason: "provider_and_model_not_configured",
      runtime: { state: "disabled" },
      coordination: { state: "disabled" },
      agents: { active: 0, retained: 0, max_concurrent: effectiveAgentConcurrency, by_status: emptyAgentStatusCounts() },
    };
  }
  if (!sharedAgentRuntime.manager) {
    return {
      state: "unavailable",
      reason: "initialization_failed",
      runtime: { state: "unavailable" },
      coordination: sharedAgentRuntime.coordination
        ? { state: "ready" }
        : { state: "unavailable", reason: sharedAgentRuntime.coordinationReason ?? "initialization_failed" },
      agents: { active: 0, retained: 0, max_concurrent: effectiveAgentConcurrency, by_status: emptyAgentStatusCounts() },
    };
  }
  const agents = sharedAgentRuntime.manager.list();
  const byStatus = Object.fromEntries(AGENT_STATUSES.map((status) => [
    status,
    agents.filter((agent) => agent.status === status).length,
  ]));
  const active = agents.filter((agent) => !["completed", "failed", "stopped"].includes(agent.status)).length;
  return {
    state: sharedAgentRuntime.state,
    runtime: { state: "ready", id: "pi-sdk" },
    coordination: config.runtimeMode === "single"
      ? { state: "disabled", reason: "runtime_mode_single" }
      : sharedAgentRuntime.coordination
        ? { state: "ready" }
        : { state: "unavailable", reason: sharedAgentRuntime.coordinationReason ?? "initialization_failed" },
    agents: {
      active,
      retained: agents.length,
      max_concurrent: effectiveAgentConcurrency,
      by_status: byStatus,
    },
  };
}

function emptyAgentStatusCounts(): Record<string, number> {
  return Object.fromEntries(AGENT_STATUSES.map((status) => [status, 0]));
}

function mcpAgentServices(clientId: string, connectionPolicy = policy): McpAgentServices | undefined {
  if (!sharedAgentRuntime.manager) return undefined;
  return {
    manager: sharedAgentRuntime.manager,
    ...(sharedAgentRuntime.coordination ? { coordination: sharedAgentRuntime.coordination } : {}),
    coordinationStatus: sharedAgentRuntime.coordination
      ? { state: "ready" }
      : {
          state: "unavailable",
          reason: sharedAgentRuntime.coordinationReason ?? "initialization_failed",
        },
    identity: {
      actorId: clientId,
      actorName: coordinationActorName(clientId),
      authority: "controller",
    },
    allowedPermissions: [
      "coordination:read",
      "coordination:write",
      "workspace:read",
      "workspace:write",
      "network:outbound",
      ...(connectionPolicy.unsafeFullAccess ? ["process:execute" as const] : []),
    ],
    defaultRuntimeId: "pi-sdk",
  };
}

function coordinationActorName(clientId: string): string {
  let candidate = "MCP client";
  try {
    candidate = findClient(clientId)?.client_name ?? candidate;
  } catch {
    return candidate;
  }
  const normalized = candidate
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return "MCP client";
  let end = normalized.length;
  while (end > 0 && Buffer.byteLength(normalized.slice(0, end), "utf8") > 100) end -= 1;
  return normalized.slice(0, end).trim() || "MCP client";
}

function requireLocalAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!isLocalAdminRequest(req) || !hasBootstrapAccess(req, config.bootstrapSecret)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}

function requireAdminAgentManager(res: express.Response): AgentManager | undefined {
  if (sharedAgentRuntime.manager) return sharedAgentRuntime.manager;
  res.status(503).json({ error: "agent_runtime_unavailable", state: sharedAgentRuntime.state });
  return undefined;
}

interface AdminAgentSpawnInput {
  role: string;
  initialMessage: string;
  permissions: readonly AgentPermission[];
  taskId?: string;
  label?: string;
}

interface AdminAgentSendInput {
  message: string;
}

interface AdminAgentCancelInput {
  reason?: string;
}

const DEFAULT_SINGLE_AGENT_PERMISSIONS: readonly AgentPermission[] = Object.freeze([
  "workspace:read",
  "network:outbound",
]);
const DEFAULT_COLLABORATION_AGENT_PERMISSIONS: readonly AgentPermission[] = Object.freeze([
  "coordination:read",
  "coordination:write",
  "workspace:read",
  "network:outbound",
]);
const AGENT_PERMISSION_SET = new Set<string>(AGENT_PERMISSIONS);
const ADMIN_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const UNSAFE_ADMIN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function parseAdminSpawnRequest(value: unknown): AdminAgentSpawnInput | undefined {
  if (!isRecord(value) || hasUnexpectedKeys(value, ["role", "initial_message", "permissions", "task_id", "label"])) {
    return undefined;
  }
  if (typeof value.role !== "string" || !value.role.trim() || Buffer.byteLength(value.role, "utf8") > 128) {
    return undefined;
  }
  if (
    typeof value.initial_message !== "string" ||
    !value.initial_message.trim() ||
    Buffer.byteLength(value.initial_message, "utf8") > 64 * 1024 ||
    UNSAFE_ADMIN_TEXT.test(value.initial_message)
  ) return undefined;
  const permissions = value.permissions === undefined
    ? config.runtimeMode === "single"
      ? DEFAULT_SINGLE_AGENT_PERMISSIONS
      : DEFAULT_COLLABORATION_AGENT_PERMISSIONS
    : parseAdminPermissions(value.permissions);
  if (!permissions) return undefined;
  const taskId = value.task_id === undefined ? undefined : optionalAdminSingleLine(value.task_id, 256);
  const label = value.label === undefined ? undefined : optionalAdminSingleLine(value.label, 100);
  if ((value.task_id !== undefined && (!taskId || !ADMIN_TASK_ID_PATTERN.test(taskId))) ||
      (value.label !== undefined && !label)) return undefined;
  return {
    role: value.role,
    initialMessage: value.initial_message,
    permissions,
    ...(taskId ? { taskId } : {}),
    ...(label ? { label } : {}),
  };
}

function parseAdminSendRequest(value: unknown): AdminAgentSendInput | undefined {
  if (!isRecord(value) || hasUnexpectedKeys(value, ["message"])) return undefined;
  const message = optionalAdminText(value.message, 64 * 1024);
  return message ? { message } : undefined;
}

function parseAdminCancelRequest(value: unknown): AdminAgentCancelInput | undefined {
  if (!isRecord(value) || hasUnexpectedKeys(value, ["reason"])) return undefined;
  const reason = optionalAdminText(value.reason, 4_096);
  if (reason === null) return undefined;
  return reason === undefined ? {} : { reason };
}

function parseAdminPermissions(value: unknown): readonly AgentPermission[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > AGENT_PERMISSIONS.length) return undefined;
  const permissions: AgentPermission[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string" || !AGENT_PERMISSION_SET.has(candidate) || seen.has(candidate)) return undefined;
    seen.add(candidate);
    permissions.push(candidate as AgentPermission);
  }
  return permissions;
}

function publicAdminAgent(agent: AgentSnapshot) {
  return {
    agent_id: agent.agentId,
    runtime_id: agent.runtimeId,
    role: {
      canonical_role_id: agent.role.canonicalRoleId,
      occupancy_label: agent.role.occupancyLabel,
    },
    permissions: [...agent.permissions],
    task_id: agent.taskId,
    label: agent.label,
    status: agent.status,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
    started_at: agent.startedAt,
    finished_at: agent.finishedAt,
    has_error: agent.lastError !== undefined,
    revision: agent.revision,
  };
}

function boundedAdminInteger(value: unknown, fallback: number, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function singleAdminParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length <= 256 ? value : undefined;
}

function optionalAdminText(value: unknown, maximumBytes: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const selected = value.trim();
  if (!selected || Buffer.byteLength(selected, "utf8") > maximumBytes || UNSAFE_ADMIN_TEXT.test(selected)) return null;
  return selected;
}

function optionalAdminSingleLine(value: unknown, maximumBytes: number): string | undefined {
  const selected = optionalAdminText(value, maximumBytes);
  if (!selected || /[\r\n]/u.test(selected)) return undefined;
  return selected;
}

function hasUnexpectedKeys(value: unknown, allowed: readonly string[]): boolean {
  if (value === undefined) return false;
  if (!isRecord(value)) return true;
  const selected = new Set(allowed);
  return Object.keys(value).some((key) => !selected.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createManagedTransport(
  transport: ManagedTransport["transport"],
  server: ManagedTransport["server"],
  clientId: string,
  clientVersion: number,
  scope: string,
): ManagedTransport {
  const now = Date.now();
  return {
    transport,
    server,
    clientId,
    clientVersion,
    scope,
    createdAtMs: now,
    lastActivityAtMs: now,
    inFlightRequests: 0,
    openStreams: 0,
    established: false,
  };
}

function touchTransport(managed: ManagedTransport): void {
  managed.lastActivityAtMs = Date.now();
}

async function withManagedRequest<T>(managed: ManagedTransport, operation: () => Promise<T>): Promise<T> {
  touchTransport(managed);
  managed.inFlightRequests += 1;
  try {
    return await operation();
  } finally {
    managed.inFlightRequests = Math.max(0, managed.inFlightRequests - 1);
    touchTransport(managed);
  }
}

async function withManagedStream<T>(managed: ManagedTransport, operation: () => Promise<T>): Promise<T> {
  touchTransport(managed);
  managed.openStreams += 1;
  try {
    return await operation();
  } finally {
    managed.openStreams = Math.max(0, managed.openStreams - 1);
    touchTransport(managed);
  }
}

function removeManagedTransport(
  sessionId: string,
  expected?: ManagedTransport["transport"],
): ManagedTransport | undefined {
  const managed = transports[sessionId];
  if (!managed || (expected && managed.transport !== expected)) return undefined;
  delete transports[sessionId];
  setActiveMcpSessions(managed.clientId, activeSessionsForClient(managed.clientId));
  return managed;
}

async function closeDetachedTransport(sessionId: string, managed: ManagedTransport, context: string): Promise<void> {
  managed.closing ??= managed.server.close();
  try {
    await managed.closing;
  } catch (error) {
    console.error(`[${context}] Unable to close an MCP session:`, error);
  }
}

async function closeManagedTransport(sessionId: string, managed: ManagedTransport, context: string): Promise<void> {
  const detached = removeManagedTransport(sessionId, managed.transport);
  if (!detached) return;
  await closeDetachedTransport(sessionId, detached, context);
}

function isReclaimable(managed: ManagedTransport, now: number): boolean {
  return managed.inFlightRequests === 0 &&
    managed.openStreams === 0 &&
    (managed.established || now - managed.lastActivityAtMs >= sessionReclaimGraceMs);
}

function oldestReclaimableSession(clientId?: string): [string, ManagedTransport] | undefined {
  const now = Date.now();
  return Object.entries(transports)
    .filter(([, managed]) => (!clientId || managed.clientId === clientId) && isReclaimable(managed, now))
    .sort(([, left], [, right]) =>
      left.lastActivityAtMs - right.lastActivityAtMs || left.createdAtMs - right.createdAtMs,
    )[0];
}

function recycleOldestQuiescentSession(clientId: string | undefined, reason: string): boolean {
  const candidate = oldestReclaimableSession(clientId);
  if (!candidate) return false;
  const [sessionId, managed] = candidate;
  const detached = removeManagedTransport(sessionId, managed.transport);
  if (!detached) return false;
  console.error(`[MCP] Recycling a quiescent session under ${reason}.`);
  void closeDetachedTransport(sessionId, detached, "MCP");
  return true;
}

function reclaimCapacity(clientId: string): void {
  while (
    activeSessionsForClient(clientId) + (pendingMcpSessionsByClient.get(clientId) || 0) >=
    config.maxMcpSessionsPerClient
  ) {
    if (!recycleOldestQuiescentSession(clientId, "per-client quota pressure")) break;
  }
  while (Object.keys(transports).length + pendingMcpSessionsTotal >= config.maxMcpSessionsTotal) {
    if (!recycleOldestQuiescentSession(undefined, "total quota pressure")) break;
  }
}

function reserveSessionSlot(clientId: string, res: express.Response): (() => void) | null {
  reclaimCapacity(clientId);
  const totalInUse = Object.keys(transports).length + pendingMcpSessionsTotal;
  const clientInUse = activeSessionsForClient(clientId) + (pendingMcpSessionsByClient.get(clientId) || 0);
  const totalExceeded = totalInUse >= config.maxMcpSessionsTotal;
  const clientExceeded = clientInUse >= config.maxMcpSessionsPerClient;
  if (totalExceeded || clientExceeded) {
    res.setHeader("Retry-After", "1");
    res.status(429).json({
      error: "too_many_sessions",
      error_description: clientExceeded
        ? "OAuth client has reached its active MCP session limit"
        : "PiLink has reached its active MCP session limit",
      limits: {
        total: config.maxMcpSessionsTotal,
        per_client: config.maxMcpSessionsPerClient,
      },
      active: {
        total: Object.keys(transports).length,
        client: activeSessionsForClient(clientId),
      },
    });
    return null;
  }

  pendingMcpSessionsTotal += 1;
  pendingMcpSessionsByClient.set(clientId, (pendingMcpSessionsByClient.get(clientId) || 0) + 1);
  return once(() => {
    pendingMcpSessionsTotal = Math.max(0, pendingMcpSessionsTotal - 1);
    const remaining = Math.max(0, (pendingMcpSessionsByClient.get(clientId) || 1) - 1);
    if (remaining === 0) pendingMcpSessionsByClient.delete(clientId);
    else pendingMcpSessionsByClient.set(clientId, remaining);
  });
}

function rejectExpiredOrUnknownSession(res: express.Response): void {
  res.status(404).json({ error: "Session not found or expired" });
}

let idleSessionSweepRunning = false;
const idleSessionSweepIntervalMs = Math.min(30_000, Math.max(250, Math.floor(idleSessionTimeoutMs / 4)));
async function sweepIdleMcpSessions(): Promise<void> {
  const now = Date.now();
  await Promise.all(Object.entries(transports).map(async ([sessionId, managed]) => {
    if (managed.inFlightRequests > 0 || managed.openStreams > 0) return;
    if (now - managed.lastActivityAtMs < idleSessionTimeoutMs) return;
    console.error(
      `[MCP] Expiring a quiescent session ` +
      `after ${config.mcpSessionIdleTimeoutSeconds}s without an active request or stream.`,
    );
    await closeManagedTransport(sessionId, managed, "MCP");
  }));
}
const idleSessionSweep = setInterval(() => {
  if (idleSessionSweepRunning) return;
  idleSessionSweepRunning = true;
  void sweepIdleMcpSessions().finally(() => {
    idleSessionSweepRunning = false;
  });
}, idleSessionSweepIntervalMs);
idleSessionSweep.unref();

function ensureAcceptHeader(req: express.Request): void {
  const currentAccept = req.headers["accept"] || "";
  if (!currentAccept.includes("application/json") || !currentAccept.includes("text/event-stream")) {
    const newAccept = "application/json, text/event-stream";
    req.headers["accept"] = newAccept;
    if (req.rawHeaders) {
      const idx = req.rawHeaders.findIndex((h) => h.toLowerCase() === "accept");
      if (idx !== -1) {
        req.rawHeaders[idx + 1] = newAccept;
      } else {
        req.rawHeaders.push("accept", newAccept);
      }
    }
  }
}

// ── Streamable HTTP: POST /sse (JSON-RPC over HTTP) ──────────
app.post("/sse", authenticateBearer, asyncRoute(async (req, res) => {
  ensureAcceptHeader(req);
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    if (sessionId) {
      const managed = transports[sessionId];
      if (!managed) {
        rejectExpiredOrUnknownSession(res);
        return;
      }
      if (!canReuseSession(managed, tokenFor(req))) {
        rejectSessionReuse(res);
        return;
      }
      const transport = managed.transport;
      if (transport instanceof StreamableHTTPServerTransport) {
        await withManagedRequest(managed, () => transport.handleRequest(req, res, req.body));
        managed.established = true;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session uses SSE transport, not Streamable HTTP" },
          id: null,
        });
      }
      return;
    }

    console.error("[MCP] New Streamable HTTP session initializing...");
    const client = tokenFor(req);
    let logicalCollaborationBinding: string | undefined;
    try {
      logicalCollaborationBinding = trustedCollaborationBinding(req);
    } catch (error) {
      res.status(400).json({
        error: "invalid_request",
        error_description: error instanceof Error ? error.message : "Invalid trusted collaboration binding",
      });
      return;
    }
    const releaseReservation = reserveSessionSlot(client.sub, res);
    if (!releaseReservation) return;
    let managed: ManagedTransport;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        console.error("[MCP] Streamable HTTP session created.");
        if (managed) {
          transports[sid] = managed;
          setActiveMcpSessions(client.sub, activeSessionsForClient(client.sub));
          releaseReservation();
        }
      },
    });
    const mcpServer = createConnectionMcpServer(
      client.sub,
      client.client_version ?? 1,
      client.scope,
      logicalCollaborationBinding,
    );
    managed = createManagedTransport(
      transport,
      mcpServer,
      client.sub,
      client.client_version ?? 1,
      client.scope,
    );
    const cleanup = once(() => {
      const sid = transport.sessionId;
      if (sid) {
        const detached = removeManagedTransport(sid, transport);
        if (detached) {
          console.error("[MCP] Streamable HTTP session closed.");
          void closeDetachedTransport(sid, detached, "MCP");
        }
      } else {
        void mcpServer.close().catch(() => undefined);
      }
      releaseReservation();
    });
    transport.onclose = cleanup;
    transport.onerror = cleanup;

    try {
      await mcpServer.connect(transport);
      await withManagedRequest(managed, () => transport.handleRequest(req, res, req.body));
      recordMcpInitialized(client.sub);
      notifyParentOfMcpConnection();
    } catch (error) {
      cleanup();
      throw error;
    } finally {
      releaseReservation();
      if (!transport.sessionId) cleanup();
    }
  } catch (error) {
    console.error("[MCP] Error handling Streamable HTTP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}));

// ── Streamable HTTP: GET /sse (SSE stream for notifications) ─
app.get("/sse", authenticateBearer, asyncRoute(async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId) {
    const managed = transports[sessionId];
    if (!managed) {
      rejectExpiredOrUnknownSession(res);
      return;
    }
    if (!canReuseSession(managed, tokenFor(req))) {
      rejectSessionReuse(res);
      return;
    }
    const transport = managed.transport;
    if (transport instanceof StreamableHTTPServerTransport) {
      managed.established = true;
      console.error("[MCP] Streamable HTTP SSE stream opened.");
      try {
        await withManagedStream(managed, () => transport.handleRequest(req, res));
      } catch (error) {
        console.error("[MCP] Error handling Streamable HTTP SSE stream:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "internal_error", error_description: "Unable to handle MCP session" });
        }
      }
      return;
    }
    res.status(400).json({ error: "Session uses legacy SSE transport, not Streamable HTTP" });
    return;
  }

  console.error("[MCP] Legacy SSE session starting...");
  const client = tokenFor(req);
  let logicalCollaborationBinding: string | undefined;
  try {
    logicalCollaborationBinding = trustedCollaborationBinding(req);
  } catch (error) {
    res.status(400).json({
      error: "invalid_request",
      error_description: error instanceof Error ? error.message : "Invalid trusted collaboration binding",
    });
    return;
  }
  const releaseReservation = reserveSessionSlot(client.sub, res);
  if (!releaseReservation) return;
  const transport = new SSEServerTransport("/messages", res);
  const mcpServer = createConnectionMcpServer(
    client.sub,
    client.client_version ?? 1,
    client.scope,
    logicalCollaborationBinding,
  );
  const managed = createManagedTransport(
    transport,
    mcpServer,
    client.sub,
    client.client_version ?? 1,
    client.scope,
  );
  managed.openStreams = 1;
  transports[transport.sessionId] = managed;
  setActiveMcpSessions(client.sub, activeSessionsForClient(client.sub));
  releaseReservation();
  console.error("[MCP] Legacy SSE session created.");

  const cleanup = once(() => {
    managed.openStreams = 0;
    touchTransport(managed);
    const detached = removeManagedTransport(transport.sessionId, transport);
    if (detached) {
      console.error("[MCP] Legacy SSE session closed.");
      void closeDetachedTransport(transport.sessionId, detached, "MCP");
    }
    releaseReservation();
  });
  res.once("close", cleanup);
  transport.onerror = cleanup;

  try {
    await mcpServer.connect(transport);
    notifyParentOfMcpConnection();
  } catch (error) {
    cleanup();
    console.error("[MCP] Error starting legacy SSE session:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error", error_description: "Unable to start MCP session" });
    }
  } finally {
    releaseReservation();
  }
}));

// ── Streamable HTTP: DELETE /sse (session teardown) ──────────
app.delete("/sse", authenticateBearer, asyncRoute(async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports[sessionId]) {
    const managed = transports[sessionId];
    if (!canReuseSession(managed, tokenFor(req))) {
      rejectSessionReuse(res);
      return;
    }
    const transport = managed.transport;
    if (transport instanceof StreamableHTTPServerTransport) {
      console.error("[MCP] Streamable HTTP session deleted.");
      const detached = removeManagedTransport(sessionId, transport);
      await closeDetachedTransport(sessionId, detached ?? managed, "MCP");
      if (!res.headersSent) res.status(200).end();
      return;
    }
  }

  res.status(404).json({ error: "Session not found" });
}));

// ── Legacy SSE: POST /messages ───────────────────────────────
app.post("/messages", authenticateBearer, asyncRoute(async (req, res) => {
  const sessionId = req.query.sessionId as string;

  if (!sessionId) {
    res.status(400).json({ error: "Missing sessionId query parameter" });
    return;
  }

  const managed = transports[sessionId];
  if (!managed || managed.clientId !== tokenFor(req).sub || !(managed.transport instanceof SSEServerTransport)) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }
  if (!canReuseSession(managed, tokenFor(req))) {
    rejectSessionReuse(res);
    return;
  }
  const transport = managed.transport;

  try {
    await withManagedRequest(managed, () => transport.handlePostMessage(req, res, req.body));
    managed.established = true;
    recordMcpInitialized(managed.clientId);
    notifyParentOfMcpConnection();
  } catch (error) {
    console.error("[MCP] Error handling legacy SSE message:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error", error_description: "Unable to handle MCP session" });
    }
  }
}));

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});
app.use(safeHttpErrorHandler);

// ── Start server ─────────────────────────────────────────────
const server = app.listen(PORT, HOST, () => {
  console.error(`
╔══════════════════════════════════════════════════╗
║              PiLink Server v${VERSION.padEnd(21)}║
║             (Pi Agent Tool Harness)              ║
╠══════════════════════════════════════════════════╣
║  Listening:  ${(HOST + ":" + PORT).padEnd(35)}║
║  Server URL: ${SERVER_URL.padEnd(35)}║
║                                                  ║
║  Transports:                                     ║
║    Streamable HTTP: POST/GET/DELETE /sse          ║
║    Legacy SSE:      GET /sse + POST /messages     ║
║                                                  ║
║  OAuth:                                          ║
║    Token:    ${(SERVER_URL + "/oauth/token").padEnd(35)}║
║    Register: ${(SERVER_URL + "/oauth/register").padEnd(35)}║
╚══════════════════════════════════════════════════╝
  `);
});
server.once("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`PiLink could not listen on ${HOST}:${PORT}: the address is already in use. Stop the existing PiLink server before starting another one.`);
  } else {
    console.error(`PiLink could not listen on ${HOST}:${PORT}: ${error.message}`);
  }
  process.exit(1);
});

// ── Graceful shutdown ────────────────────────────────────────
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error("Shutting down...");
  clearInterval(idleSessionSweep);
  await Promise.all(Object.entries(transports).map(([sessionId, managed]) =>
    closeManagedTransport(sessionId, managed, "shutdown"),
  ));
  await collaborationContextRegistry?.disposeAll();
  if (sharedAgentRuntime.manager) {
    try {
      await sharedAgentRuntime.manager.dispose("PiLink server shutdown");
    } catch {
      console.error("[Agents] One or more child runtimes could not be released cleanly during shutdown.");
    }
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function renderLandingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>PiLink · Local-first MCP bridge</title>
  <style>
    :root { color-scheme: dark; --bg:#090a0d; --panel:#121419; --line:#272b33; --text:#f4f6f8; --muted:#9aa3ad; --accent:#77e0c1; --accent2:#8ea8ff; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; color:var(--text); background:radial-gradient(circle at 14% 0%,#17332e 0,transparent 34rem),radial-gradient(circle at 90% 18%,#182343 0,transparent 30rem),var(--bg); font:15px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(1040px,calc(100% - 40px)); margin:0 auto; padding:68px 0 36px; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:20px; margin-bottom:76px; }
    .brand { display:flex; align-items:center; color:var(--text); font-weight:760; letter-spacing:-.02em; }
    .brand img { display:block; width:180px; max-width:42vw; height:auto; border-radius:6px; background:#fff; }
    .status { display:flex; align-items:center; gap:8px; padding:7px 11px; border:1px solid #5fe0ba38; border-radius:999px; background:#50d5ae12; color:#a1f2da; font-size:12px; font-weight:650; }
    .dot { width:7px; height:7px; border-radius:50%; background:var(--accent); box-shadow:0 0 16px #77e0c1; }
    .hero { max-width:780px; margin-bottom:56px; }
    .eyebrow { margin:0 0 15px; color:var(--accent); font:700 12px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.12em; text-transform:uppercase; }
    h1 { margin:0; max-width:760px; font-size:clamp(42px,7vw,76px); line-height:.99; letter-spacing:-.055em; font-weight:760; }
    h1 span { color:transparent; background:linear-gradient(105deg,var(--accent),var(--accent2)); background-clip:text; -webkit-background-clip:text; }
    .lead { max-width:690px; margin:25px 0 0; color:#bbc2ca; font-size:clamp(17px,2.2vw,21px); line-height:1.55; }
    .actions { display:flex; flex-wrap:wrap; gap:11px; margin-top:31px; }
    a.button { display:inline-flex; align-items:center; justify-content:center; min-height:43px; padding:0 17px; border:1px solid var(--line); border-radius:10px; color:var(--text); background:#ffffff08; text-decoration:none; font-weight:650; }
    a.button.primary { border-color:#78e2c35c; color:#07110e; background:var(--accent); }
    a.button:focus-visible { outline:2px solid var(--accent2); outline-offset:3px; }
    .grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; }
    .card { min-height:184px; padding:23px; border:1px solid var(--line); border-radius:15px; background:linear-gradient(145deg,#171a20e8,#0f1116e8); box-shadow:0 22px 70px #0000002b; }
    .card .num { color:#77818c; font:600 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace; }
    h2 { margin:34px 0 9px; font-size:18px; letter-spacing:-.02em; }
    .card p { margin:0; color:var(--muted); }
    footer { display:flex; justify-content:space-between; gap:20px; margin-top:54px; padding-top:20px; border-top:1px solid #ffffff12; color:#747e89; font-size:12px; }
    footer a { color:#aeb6bf; text-decoration:none; }
    @media (max-width:760px) { main{padding-top:32px}.top{margin-bottom:52px}.grid{grid-template-columns:1fr}.card{min-height:0}footer{flex-direction:column}.status{display:none} }
  </style>
</head>
<body>
  <main>
    <header class="top">
      <div class="brand"><img src="/assets/logo.png" width="180" height="101" alt="PiLink"></div>
      <div class="status"><span class="dot"></span>Service online</div>
    </header>
    <section class="hero">
      <p class="eyebrow">Local-first agent infrastructure</p>
      <h1>Your workspace, connected <span>on your terms.</span></h1>
      <p class="lead">A secure bridge from ChatGPT to the Pi coding-tool harness in your local workspace, with explicit OAuth consent and collaborative agent monitoring.</p>
      <div class="actions">
        <a class="button primary" href="https://github.com/roccoangelella/PiLink" rel="noreferrer">View source on GitHub</a>
        <a class="button" href="https://github.com/roccoangelella/PiLink#readme" rel="noreferrer">Read documentation</a>
      </div>
    </section>
    <section class="grid" aria-label="PiLink capabilities">
      <article class="card"><span class="num">01</span><h2>ChatGPT via MCP</h2><p>Use the real ChatGPT frontend while PiLink exposes the Pi tools and guides endpoint, OAuth and connection health.</p></article>
      <article class="card"><span class="num">02</span><h2>Secure by default</h2><p>Loopback origin, PKCE, rotating refresh tokens, paired owner consent and workspace-scoped tools.</p></article>
      <article class="card"><span class="num">03</span><h2>Collaborative monitor</h2><p>Watch remote ChatGPT conversations, durable agent chat and the shared task board beside the files they change.</p></article>
    </section>
    <footer><span>PiLink ${VERSION} · Streamable HTTP + legacy SSE</span><span>Independent open-source project · Not affiliated with OpenAI</span></footer>
  </main>
</body>
</html>`;
}
