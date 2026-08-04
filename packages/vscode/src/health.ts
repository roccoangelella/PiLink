import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { inspectAdminAgentRuntime } from "./chat-runtime.js";

export interface HealthResult {
  online: boolean;
  payload: Record<string, unknown> | null;
  error?: string;
}

export interface AdminStatusResult {
  online: boolean;
  chatGptConnected: boolean;
  activeSessions: number;
  payload: Record<string, unknown> | null;
  error?: string;
}

export interface PairingResult {
  pairingUrl: string;
  expiresAt: string;
}

export interface AdminAgentSummary {
  agentId: string;
  role: string;
  label?: string;
  status: string;
  hasError: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AdminAgentOutputEntry {
  cursor: number;
  channel: string;
  text: string;
  createdAt?: string;
}

export interface AdminCollaborationMessage {
  cursor: number;
  agentId: string;
  agentInstanceId: string;
  agentName: string;
  message: string;
}

export interface AdminCollaborationTask {
  taskId: string;
  title: string;
  details?: string;
  status: string;
  statusMessage?: string;
  artifact?: string;
  createdBy: string;
  owner?: string;
  leaseExpiresAt?: string;
  createdAt?: string;
  updatedAt?: string;
  revision: number;
}

export interface AdminCollaborationClient {
  clientId: string;
  activeMcpSessions: number;
  registeredAt?: string;
  authorizedAt?: string;
  tokenIssuedAt?: string;
  refreshedAt?: string;
  mcpInitializedAt?: string;
}

export interface AdminToolActivity {
  tool: string;
  startedAt: string;
  durationMs: number;
  outcome: "success" | "error";
  accessMode: "workspace" | "full-access";
  clientId?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface AdminCollaborationSnapshot {
  projectKey: string;
  latestCursor: number;
  messages: AdminCollaborationMessage[];
  tasks: AdminCollaborationTask[];
  activity: AdminToolActivity[];
  clients: AdminCollaborationClient[];
}

const HEALTH_AUTH_SCHEME = "pilink-health-hmac-v1";
const HEALTH_PROOF_DOMAIN = "pilink-health-v1\0";
const MAX_ADMIN_RESPONSE_BYTES = 2 * 1024 * 1024;
const ADMIN_OUTPUT_PAGE_SIZE = 100;
const MAX_CHAT_OUTPUT_ENTRIES = 300;

export async function readHealth(port: number, timeoutMs = 1_000): Promise<HealthResult> {
  return readHealthRequest(port, timeoutMs);
}

export async function readAuthenticatedHealth(
  port: number,
  bootstrapSecret: string,
  timeoutMs = 1_000,
): Promise<HealthResult> {
  if (bootstrapSecret.length < 32) {
    return { online: false, payload: null, error: "PI_BOOTSTRAP_SECRET is missing or invalid" };
  }
  const challenge = crypto.randomBytes(32).toString("base64url");
  return readHealthRequest(port, timeoutMs, { bootstrapSecret, challenge });
}

async function readHealthRequest(
  port: number,
  timeoutMs: number,
  authentication?: { bootstrapSecret: string; challenge: string },
): Promise<HealthResult> {
  return new Promise<HealthResult>((resolve) => {
    let settled = false;
    const finish = (result: HealthResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = http.get({
      host: "127.0.0.1",
      port,
      path: authentication ? `/health?challenge=${encodeURIComponent(authentication.challenge)}` : "/health",
      headers: { accept: "application/json" },
      timeout: timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 256 * 1024) chunks.push(chunk);
        else request.destroy(new Error("The health response is too large"));
      });
      response.once("end", () => {
        if (response.statusCode !== 200) {
          finish({ online: false, payload: null, error: `HTTP ${response.statusCode ?? "?"}` });
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid health response");
          const payload = parsed as Record<string, unknown>;
          if (payload.server !== "pilink") throw new Error("The configured port does not belong to PiLink");
          if (authentication) verifyAuthenticatedHealth(payload, port, authentication);
          finish({ online: true, payload });
        } catch (error) {
          finish({ online: false, payload: null, error: error instanceof Error ? error.message : "Invalid health response" });
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error("Timeout health")));
    request.once("error", (error) => finish({ online: false, payload: null, error: error.message }));
  });
}

export async function waitForHealth(port: number, timeoutMs = 15_000): Promise<HealthResult> {
  const deadline = Date.now() + timeoutMs;
  let last: HealthResult = { online: false, payload: null, error: "The server is unreachable" };
  while (Date.now() < deadline) {
    last = await readHealth(port);
    if (last.online) return last;
    await delay(250);
  }
  return last;
}

export async function waitForPublicHealth(
  baseUrl: string,
  timeoutMs = 30_000,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<HealthResult> {
  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    return { online: false, payload: null, error: "Invalid public URL" };
  }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash) {
    return { online: false, payload: null, error: "The public URL must use HTTPS and must not contain credentials" };
  }
  const healthUrl = new URL("/health", origin);
  const deadline = Date.now() + timeoutMs;
  let last: HealthResult = { online: false, payload: null, error: "The public HTTPS endpoint is unreachable" };
  while (Date.now() < deadline) {
    try {
      const response = await fetchImplementation(healthUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(3_000, Math.max(1, deadline - Date.now()))),
      });
      const body = await response.text();
      if (body.length > 256 * 1024) throw new Error("The public health response is too large");
      const payload = JSON.parse(body) as unknown;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || (payload as Record<string, unknown>).server !== "pilink") {
        throw new Error("The public host is not a PiLink server");
      }
      return { online: true, payload: payload as Record<string, unknown> };
    } catch (error) {
      last = { online: false, payload: null, error: error instanceof Error ? error.message : "The public HTTPS endpoint is unreachable" };
      await delay(250);
    }
  }
  return last;
}

export async function readAdminStatus(
  port: number,
  bootstrapSecret: string,
  timeoutMs = 2_000,
): Promise<AdminStatusResult> {
  const identity = await readAuthenticatedHealth(port, bootstrapSecret, timeoutMs);
  if (!identity.online) {
    return { online: false, chatGptConnected: false, activeSessions: 0, payload: null, error: identity.error };
  }
  try {
    const payload = await loopbackJson(port, "/admin/status", "GET", bootstrapSecret, timeoutMs);
    const activity = record(payload.activity);
    const sessions = record(payload.sessions);
    const activeSessions = numberValue(sessions.active) ?? numberValue(sessions.total) ?? 0;
    return {
      online: true,
      chatGptConnected: activity.chatgptConnected === true,
      activeSessions,
      payload,
    };
  } catch (error) {
    return {
      online: false,
      chatGptConnected: false,
      activeSessions: 0,
      payload: null,
      error: error instanceof Error ? error.message : "Administrative status is unavailable",
    };
  }
}

/** Wait for both the authenticated local admin endpoint and the Pi SDK runtime. */
export async function waitForAdminRuntime(
  port: number,
  bootstrapSecret: string,
  timeoutMs = 15_000,
): Promise<AdminStatusResult> {
  const deadline = Date.now() + timeoutMs;
  let last: AdminStatusResult = {
    online: false,
    chatGptConnected: false,
    activeSessions: 0,
    payload: null,
    error: "The local agent runtime is unreachable",
  };
  while (Date.now() < deadline) {
    last = await readAdminStatus(port, bootstrapSecret, Math.min(2_000, Math.max(1, deadline - Date.now())));
    const inspection = inspectAdminAgentRuntime(last.payload);
    if (last.online && inspection.ready) return last;
    if (last.online) {
      last = {
        ...last,
        error: `Agent runtime: ${inspection.runtimeState}`,
      };
    }
    await delay(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  return last;
}

/**
 * A conservative port probe used before starting a supervised local server.
 * Timeouts and unexpected socket errors count as occupied: starting a second
 * process is less safe than asking the user to resolve the existing listener.
 */
export async function isLoopbackPortOccupied(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code !== "ECONNREFUSED"));
  });
}

export async function createOwnerPairing(
  port: number,
  bootstrapSecret: string,
  timeoutMs = 2_000,
): Promise<PairingResult> {
  const identity = await readAuthenticatedHealth(port, bootstrapSecret, timeoutMs);
  if (!identity.online) throw new Error(`The local PiLink server identity could not be verified: ${identity.error || "health proof missing"}`);
  const payload = await loopbackJson(port, "/admin/oauth/pairing", "POST", bootstrapSecret, timeoutMs);
  if (typeof payload.pairing_url !== "string" || typeof payload.expires_at !== "string") {
    throw new Error("Invalid OAuth pairing response.");
  }
  return { pairingUrl: payload.pairing_url, expiresAt: payload.expires_at };
}

export async function readAdminAgents(
  port: number,
  bootstrapSecret: string,
  limit = 50,
  timeoutMs = 2_000,
): Promise<{ state: string; agents: AdminAgentSummary[] }> {
  await requireLocalPiLinkIdentity(port, bootstrapSecret, timeoutMs);
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 50;
  const payload = await loopbackJson(port, `/admin/agents?limit=${boundedLimit}`, "GET", bootstrapSecret, timeoutMs);
  return {
    state: safeIdentifier(payload.state, "unavailable"),
    agents: Array.isArray(payload.agents) ? payload.agents.flatMap(parseAdminAgent).slice(0, boundedLimit) : [],
  };
}

export async function readAdminCollaboration(
  port: number,
  bootstrapSecret: string,
  timeoutMs = 2_000,
): Promise<AdminCollaborationSnapshot> {
  await requireLocalPiLinkIdentity(port, bootstrapSecret, timeoutMs);
  const payload = await loopbackJson(
    port,
    "/admin/collaboration?chat_limit=20&task_limit=200",
    "GET",
    bootstrapSecret,
    timeoutMs,
  );
  const chat = record(payload.chat);
  return {
    projectKey: typeof payload.project_key === "string" && /^[a-f0-9]{64}$/u.test(payload.project_key)
      ? payload.project_key
      : "",
    latestCursor: safeCursor(chat.latest_cursor) ?? 0,
    messages: parseCollaborationMessages(chat.messages),
    tasks: parseCollaborationTasks(payload.tasks),
    activity: parseToolActivity(payload.tool_activity),
    clients: parseCollaborationClients(payload.clients),
  };
}

export async function spawnAdminAgent(
  port: number,
  bootstrapSecret: string,
  input: { role: string; initialMessage: string; label?: string; permissions?: string[] },
  timeoutMs = 5_000,
): Promise<AdminAgentSummary> {
  await requireLocalPiLinkIdentity(port, bootstrapSecret, timeoutMs);
  const role = safeInputText(input.role, 128, false);
  const initialMessage = safeInputText(input.initialMessage, 64 * 1024, true);
  const label = input.label ? safeInputText(input.label, 100, false) : undefined;
  const payload = await loopbackJson(port, "/admin/agents/spawn", "POST", bootstrapSecret, timeoutMs, {
    role,
    initial_message: initialMessage,
    ...(label ? { label } : {}),
    ...(input.permissions ? { permissions: validateAgentPermissions(input.permissions) } : {}),
  });
  const parsed = parseAdminAgent(payload.agent);
  if (!parsed.length) throw new Error("Invalid agent creation response.");
  return parsed[0];
}

export async function sendAdminAgentMessage(
  port: number,
  bootstrapSecret: string,
  agentId: string,
  message: string,
  timeoutMs = 120_000,
): Promise<AdminAgentSummary> {
  await requireLocalPiLinkIdentity(port, bootstrapSecret, Math.min(timeoutMs, 3_000));
  const safeId = safeAgentId(agentId);
  const safeMessage = safeInputText(message, 64 * 1024, true);
  const payload = await loopbackJson(
    port,
    `/admin/agents/${encodeURIComponent(safeId)}/send`,
    "POST",
    bootstrapSecret,
    timeoutMs,
    { message: safeMessage },
  );
  const parsed = parseAdminAgent(payload.agent);
  if (!parsed.length) throw new Error("Invalid send-message response.");
  return parsed[0];
}

export async function cancelAdminAgentTurn(
  port: number,
  bootstrapSecret: string,
  agentId: string,
  reason = "Turn cancelled from the VSPiLink local chat",
  timeoutMs = 10_000,
): Promise<AdminAgentSummary> {
  await requireLocalPiLinkIdentity(port, bootstrapSecret, Math.min(timeoutMs, 3_000));
  const safeId = safeAgentId(agentId);
  const safeReason = safeInputText(reason, 4_096, false);
  const payload = await loopbackJson(
    port,
    `/admin/agents/${encodeURIComponent(safeId)}/cancel`,
    "POST",
    bootstrapSecret,
    timeoutMs,
    { reason: safeReason },
  );
  const parsed = parseAdminAgent(payload.agent);
  if (!parsed.length) throw new Error("Invalid interrupt-turn response.");
  return parsed[0];
}

export async function stopAdminAgent(
  port: number,
  bootstrapSecret: string,
  agentId: string,
  timeoutMs = 5_000,
): Promise<AdminAgentSummary> {
  await requireLocalPiLinkIdentity(port, bootstrapSecret, timeoutMs);
  const safeId = safeAgentId(agentId);
  const payload = await loopbackJson(
    port,
    `/admin/agents/${encodeURIComponent(safeId)}/stop`,
    "POST",
    bootstrapSecret,
    timeoutMs,
    { reason: "Stopped from the local VSPiLink VS Code dashboard" },
  );
  const parsed = parseAdminAgent(payload.agent);
  if (!parsed.length) throw new Error("Invalid stop-agent response.");
  return parsed[0];
}

export async function readAdminAgentOutput(
  port: number,
  bootstrapSecret: string,
  agentId: string,
  timeoutMs = 3_000,
): Promise<AdminAgentOutputEntry[]> {
  const safeId = safeAgentId(agentId);
  const entries: AdminAgentOutputEntry[] = [];
  let after = 0;

  while (entries.length < MAX_CHAT_OUTPUT_ENTRIES) {
    // Re-prove the local server identity before every page. This prevents a
    // process that replaces the listener between polls from receiving the
    // private admin credential without first answering the HMAC challenge.
    await requireLocalPiLinkIdentity(port, bootstrapSecret, timeoutMs);
    const payload = await loopbackJson(
      port,
      `/admin/agents/${encodeURIComponent(safeId)}/output?after=${after}&limit=${ADMIN_OUTPUT_PAGE_SIZE}`,
      "GET",
      bootstrapSecret,
      timeoutMs,
    );
    const page = parseAdminAgentOutputEntries(payload.entries);
    for (const entry of page) {
      if (entry.cursor <= after || entries.some((current) => current.cursor === entry.cursor)) continue;
      entries.push(entry);
      if (entries.length >= MAX_CHAT_OUTPUT_ENTRIES) break;
    }

    const nextCursor = safeCursor(payload.next_cursor);
    const latestCursor = safeCursor(payload.latest_cursor);
    if (
      page.length === 0 ||
      nextCursor === undefined ||
      latestCursor === undefined ||
      nextCursor <= after ||
      nextCursor >= latestCursor
    ) break;
    after = nextCursor;
  }

  return entries.sort((left, right) => left.cursor - right.cursor);
}

async function loopbackJson(
  port: number,
  requestPath: string,
  method: "GET" | "POST",
  bootstrapSecret: string,
  timeoutMs: number,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers: {
        authorization: `Bearer ${bootstrapSecret}`,
        accept: "application/json",
        ...(serialized === undefined ? {} : {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(serialized)),
        }),
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_ADMIN_RESPONSE_BYTES) chunks.push(chunk);
        else request.destroy(new Error("The administrative response is too large"));
      });
      response.once("end", () => {
        if (response.statusCode !== 200 && response.statusCode !== 201 && response.statusCode !== 202) {
          reject(new Error(`The administrative endpoint is unavailable (HTTP ${response.statusCode ?? "?"})`));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid administrative response");
          resolve(parsed as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error("Timeout endpoint amministrativo")));
    request.once("error", reject);
    request.end(serialized);
  });
}

function parseAdminAgentOutputEntries(value: unknown): AdminAgentOutputEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const entry = record(candidate);
    const cursor = safeCursor(entry.cursor);
    if (cursor === undefined || typeof entry.text !== "string") return [];
    return [{
      cursor,
      channel: safeIdentifier(entry.channel, "output"),
      text: entry.text.replace(/\0/g, "").slice(0, 256 * 1024),
      ...(typeof entry.created_at === "string" ? { createdAt: entry.created_at } : {}),
    }];
  });
}

function parseCollaborationMessages(value: unknown): AdminCollaborationMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-20).flatMap((candidate) => {
    const entry = record(candidate);
    const cursor = safeCursor(entry.cursor);
    if (
      cursor === undefined ||
      typeof entry.agent_id !== "string" ||
      typeof entry.agent_instance_id !== "string" ||
      typeof entry.agent_name !== "string" ||
      typeof entry.message !== "string"
    ) return [];
    return [{
      cursor,
      agentId: cleanBoundedText(entry.agent_id, 256, false),
      agentInstanceId: cleanBoundedText(entry.agent_instance_id, 256, false),
      agentName: cleanBoundedText(entry.agent_name, 100, false),
      message: cleanBoundedText(entry.message, 8 * 1024, true),
    }];
  });
}

function parseCollaborationTasks(value: unknown): AdminCollaborationTask[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).flatMap((candidate) => {
    const entry = record(candidate);
    if (typeof entry.task_id !== "string" || typeof entry.title !== "string" || typeof entry.status !== "string") return [];
    return [{
      taskId: cleanBoundedText(entry.task_id, 128, false),
      title: cleanBoundedText(entry.title, 256, false),
      ...(typeof entry.details === "string" ? { details: cleanBoundedText(entry.details, 8 * 1024, true) } : {}),
      status: safeIdentifier(entry.status, "unknown"),
      ...(typeof entry.status_message === "string" ? { statusMessage: cleanBoundedText(entry.status_message, 8 * 1024, true) } : {}),
      ...(typeof entry.artifact === "string" ? { artifact: cleanBoundedText(entry.artifact, 16 * 1024, true) } : {}),
      createdBy: typeof entry.created_by === "string" ? cleanBoundedText(entry.created_by, 100, false) : "Agent",
      ...(typeof entry.owner === "string" ? { owner: cleanBoundedText(entry.owner, 100, false) } : {}),
      ...(typeof entry.lease_expires_at === "string" ? { leaseExpiresAt: cleanBoundedText(entry.lease_expires_at, 100, false) } : {}),
      ...(typeof entry.created_at === "string" ? { createdAt: cleanBoundedText(entry.created_at, 100, false) } : {}),
      ...(typeof entry.updated_at === "string" ? { updatedAt: cleanBoundedText(entry.updated_at, 100, false) } : {}),
      revision: safeCursor(entry.revision) ?? 0,
    }];
  });
}

function parseCollaborationClients(value: unknown): AdminCollaborationClient[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 128).flatMap((candidate) => {
    const entry = record(candidate);
    if (typeof entry.clientId !== "string") return [];
    const timestamp = (field: string): string | undefined => typeof entry[field] === "string"
      ? cleanBoundedText(entry[field] as string, 100, false)
      : undefined;
    return [{
      clientId: cleanBoundedText(entry.clientId, 128, false),
      activeMcpSessions: Math.floor(numberValue(entry.activeMcpSessions) ?? 0),
      ...(timestamp("registeredAt") ? { registeredAt: timestamp("registeredAt") } : {}),
      ...(timestamp("authorizedAt") ? { authorizedAt: timestamp("authorizedAt") } : {}),
      ...(timestamp("tokenIssuedAt") ? { tokenIssuedAt: timestamp("tokenIssuedAt") } : {}),
      ...(timestamp("refreshedAt") ? { refreshedAt: timestamp("refreshedAt") } : {}),
      ...(timestamp("mcpInitializedAt") ? { mcpInitializedAt: timestamp("mcpInitializedAt") } : {}),
    }];
  });
}

function parseToolActivity(value: unknown): AdminToolActivity[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-100).flatMap((candidate) => {
    const entry = record(candidate);
    if (
      typeof entry.tool !== "string" ||
      typeof entry.started_at !== "string" ||
      !Number.isFinite(Date.parse(entry.started_at)) ||
      (entry.outcome !== "success" && entry.outcome !== "error") ||
      (entry.access_mode !== "workspace" && entry.access_mode !== "full-access")
    ) return [];
    const durationMs = numberValue(entry.duration_ms);
    if (durationMs === undefined || !Number.isSafeInteger(durationMs) || durationMs < 0) return [];
    const exitCode = entry.exit_code === null || (typeof entry.exit_code === "number" && Number.isSafeInteger(entry.exit_code))
      ? entry.exit_code as number | null
      : undefined;
    return [{
      tool: safeIdentifier(entry.tool, "tool"),
      startedAt: new Date(entry.started_at).toISOString(),
      durationMs,
      outcome: entry.outcome,
      accessMode: entry.access_mode,
      ...(typeof entry.client_id === "string" ? { clientId: cleanBoundedText(entry.client_id, 128, false) } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(typeof entry.timed_out === "boolean" ? { timedOut: entry.timed_out } : {}),
      ...(typeof entry.cancelled === "boolean" ? { cancelled: entry.cancelled } : {}),
    }];
  });
}

function cleanBoundedText(value: string, maximum: number, multiline: boolean): string {
  const cleaned = value.replace(/\0/g, "");
  return (multiline ? cleaned : cleaned.replace(/[\r\n]+/g, " ")).slice(0, maximum);
}

function safeCursor(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function requireLocalPiLinkIdentity(port: number, bootstrapSecret: string, timeoutMs: number): Promise<void> {
  const identity = await readAuthenticatedHealth(port, bootstrapSecret, timeoutMs);
  if (!identity.online) throw new Error(`The local PiLink server identity could not be verified: ${identity.error || "health proof missing"}`);
}

function parseAdminAgent(value: unknown): AdminAgentSummary[] {
  const source = record(value);
  const role = record(source.role);
  if (typeof source.agent_id !== "string" || !source.agent_id || typeof source.status !== "string") return [];
  return [{
    agentId: source.agent_id.slice(0, 256),
    role: safeIdentifier(role.occupancy_label ?? role.canonical_role_id, "collaborator"),
    ...(typeof source.label === "string" && source.label ? { label: source.label.replace(/[\r\n\0]+/g, " ").slice(0, 100) } : {}),
    status: safeIdentifier(source.status, "unknown"),
    hasError: source.has_error === true,
    ...(typeof source.created_at === "string" ? { createdAt: source.created_at } : {}),
    ...(typeof source.updated_at === "string" ? { updatedAt: source.updated_at } : {}),
  }];
}

function safeInputText(value: string, maxBytes: number, multiline: boolean): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes || /\0/.test(value)) {
    throw new Error("Invalid agent data.");
  }
  if (!multiline && /[\r\n]/.test(value)) throw new Error("Invalid agent data.");
  return value.trim();
}

function safeAgentId(value: string): string {
  if (!/^[A-Za-z0-9._:@-]{1,256}$/.test(value)) throw new Error("Invalid agent identifier.");
  return value;
}

function validateAgentPermissions(value: string[]): string[] {
  const allowed = new Set([
    "coordination:read",
    "coordination:write",
    "workspace:read",
    "workspace:write",
    "process:execute",
    "network:outbound",
  ]);
  if (!Array.isArray(value) || !value.length || value.length > allowed.size || new Set(value).size !== value.length || value.some((entry) => !allowed.has(entry))) {
    throw new Error("Invalid agent permissions.");
  }
  return [...value];
}

function safeIdentifier(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9._:@/-]{1,256}$/.test(value) ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function verifyAuthenticatedHealth(
  payload: Record<string, unknown>,
  port: number,
  authentication: { bootstrapSecret: string; challenge: string },
): void {
  if (
    payload.auth_scheme !== HEALTH_AUTH_SCHEME ||
    payload.challenge !== authentication.challenge ||
    typeof payload.version !== "string" ||
    typeof payload.proof !== "string"
  ) {
    throw new Error("The local PiLink server did not provide an authenticated health proof");
  }
  const expected = crypto
    .createHmac("sha256", authentication.bootstrapSecret)
    .update(`${HEALTH_PROOF_DOMAIN}${authentication.challenge}\0${payload.version}\0${port}`)
    .digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(payload.proof, "base64url");
  } catch {
    throw new Error("The authenticated health proof is invalid");
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error("The authenticated health proof does not match the private configuration");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
