import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";

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
  verificationCode: string;
  expiresAt: string;
}

export interface AdminToolActivity {
  tool: string;
  startedAt: string;
  durationMs: number;
  outcome: "success" | "error";
}

export type CollaborationTaskStatus = "open" | "working" | "input_required" | "completed" | "failed" | "cancelled";
export type CollaborationTaskPriority = "P0" | "P1" | "P2" | "P3";

export interface CollaborationTaskDependency {
  taskId: string;
  condition: "completed" | "terminal";
}

export interface CollaborationTaskView {
  taskId: string;
  title: string;
  details?: string;
  status: CollaborationTaskStatus;
  statusMessage?: string;
  artifact?: string;
  priority: CollaborationTaskPriority;
  dependencies: CollaborationTaskDependency[];
  eligibleRoleIds: string[];
  requiredCapabilities: string[];
  risk: "low" | "medium" | "high";
  notBefore?: string;
  createdBy: string;
  createdBySessionId?: string;
  owner?: string;
  ownerSessionId?: string;
  ownerRoleId?: string;
  ownerRoleLabel?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  actions: {
    provideInput: boolean;
    cancel: boolean;
    release: boolean;
  };
}

export interface CollaborationParticipantView {
  collaborationSessionId: string;
  agentName: string;
  canonicalRoleId: string;
  occupancyLabel: string;
  lifecycle: "working" | "waiting_for_task" | "offline" | "released";
  updatedAt: string;
  revision: number;
}

export interface CollaborationBoardView {
  status: "ready" | "degraded";
  projectKey?: string;
  tasks: CollaborationTaskView[];
  participants: CollaborationParticipantView[];
  timestamp: string;
  error?: string;
}

export interface CollaborationBoardResult {
  online: boolean;
  board: CollaborationBoardView | null;
  error?: string;
}

const HEALTH_AUTH_SCHEME = "pilink-health-hmac-v1";
const HEALTH_PROOF_DOMAIN = "pilink-health-v1\0";
const MAX_HEALTH_RESPONSE_BYTES = 256 * 1024;
const MAX_ADMIN_RESPONSE_BYTES = 2 * 1024 * 1024;

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
        if (size <= MAX_HEALTH_RESPONSE_BYTES) chunks.push(chunk);
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
      if (body.length > MAX_HEALTH_RESPONSE_BYTES) throw new Error("The public health response is too large");
      const payload = JSON.parse(body) as unknown;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || (payload as Record<string, unknown>).server !== "pilink") {
        throw new Error("The public host is not a PiLink server");
      }
      return { online: true, payload: payload as Record<string, unknown> };
    } catch (error) {
      last = {
        online: false,
        payload: null,
        error: error instanceof Error ? error.message : "The public HTTPS endpoint is unreachable",
      };
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

/**
 * Conservative port probe used before starting an extension-owned process.
 * Timeouts and unexpected socket errors count as occupied: starting a second
 * process is less safe than asking the operator to resolve the listener.
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
  await requireLocalPiLinkIdentity(port, bootstrapSecret, timeoutMs);
  const payload = await loopbackJson(port, "/admin/oauth/pairing", "POST", bootstrapSecret, timeoutMs);
  if (
    typeof payload.pairing_url !== "string" ||
    typeof payload.verification_code !== "string" ||
    !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u.test(payload.verification_code) ||
    typeof payload.expires_at !== "string"
  ) {
    throw new Error("Invalid OAuth pairing response.");
  }
  return {
    pairingUrl: payload.pairing_url,
    verificationCode: payload.verification_code,
    expiresAt: payload.expires_at,
  };
}

export async function readAdminTaskBoard(
  port: number,
  bootstrapSecret: string,
  timeoutMs = 2_000,
): Promise<CollaborationBoardResult> {
  try {
    await requireLocalPiLinkIdentity(port, bootstrapSecret, timeoutMs);
    const payload = await loopbackJson(
      port,
      "/admin/collaboration/board?task_limit=200",
      "GET",
      bootstrapSecret,
      timeoutMs,
    );
    const board = parseCollaborationBoard(payload);
    return { online: true, board, ...(board.error ? { error: board.error } : {}) };
  } catch (error) {
    return {
      online: false,
      board: null,
      error: error instanceof Error ? error.message : "Collaboration task board is unavailable",
    };
  }
}

export async function createAdminTask(
  port: number,
  bootstrapSecret: string,
  input: { title: string; details?: string; priority: CollaborationTaskPriority },
  timeoutMs = 2_000,
): Promise<CollaborationTaskView> {
  await requireLocalPiLinkIdentity(port, bootstrapSecret, timeoutMs);
  const payload = await loopbackJson(
    port,
    "/admin/collaboration/tasks",
    "POST",
    bootstrapSecret,
    timeoutMs,
    {
      title: input.title,
      ...(input.details ? { details: input.details } : {}),
      priority: input.priority,
    },
  );
  return parseCollaborationTask(record(payload.task));
}

export async function provideAdminTaskInput(
  port: number,
  bootstrapSecret: string,
  input: { taskId: string; expectedRevision: number; statusMessage: string },
  timeoutMs = 2_000,
): Promise<CollaborationTaskView> {
  await requireLocalPiLinkIdentity(port, bootstrapSecret, timeoutMs);
  const payload = await loopbackJson(
    port,
    `/admin/collaboration/tasks/${encodeURIComponent(input.taskId)}/input`,
    "POST",
    bootstrapSecret,
    timeoutMs,
    { expected_revision: input.expectedRevision, status_message: input.statusMessage },
  );
  return parseCollaborationTask(record(payload.task));
}

export async function cancelAdminTask(
  port: number,
  bootstrapSecret: string,
  input: { taskId: string; expectedRevision: number; statusMessage?: string },
  timeoutMs = 2_000,
): Promise<CollaborationTaskView> {
  await requireLocalPiLinkIdentity(port, bootstrapSecret, timeoutMs);
  const payload = await loopbackJson(
    port,
    `/admin/collaboration/tasks/${encodeURIComponent(input.taskId)}/cancel`,
    "POST",
    bootstrapSecret,
    timeoutMs,
    {
      expected_revision: input.expectedRevision,
      ...(input.statusMessage ? { status_message: input.statusMessage } : {}),
    },
  );
  return parseCollaborationTask(record(payload.task));
}

/**
 * Return only the small activity projection used by the launcher. The server
 * endpoint also contains collaboration data in collaboration mode, but the VS
 * Code product deliberately does not ingest chat, tasks, agent identities, or
 * other coordination content.
 */
export async function readAdminActivity(
  port: number,
  bootstrapSecret: string,
  timeoutMs = 2_000,
): Promise<AdminToolActivity[]> {
  await requireLocalPiLinkIdentity(port, bootstrapSecret, timeoutMs);
  const payload = await loopbackJson(
    port,
    "/admin/collaboration?chat_limit=1&task_limit=1",
    "GET",
    bootstrapSecret,
    timeoutMs,
  );
  return parseToolActivity(payload.tool_activity).slice(-100);
}

/** @deprecated Internal bridge alias while the controller migration settles. */
export async function readAdminCollaboration(
  port: number,
  bootstrapSecret: string,
  timeoutMs = 2_000,
): Promise<{ activity: AdminToolActivity[] }> {
  return { activity: await readAdminActivity(port, bootstrapSecret, timeoutMs) };
}

async function requireLocalPiLinkIdentity(port: number, bootstrapSecret: string, timeoutMs: number): Promise<void> {
  const identity = await readAuthenticatedHealth(port, bootstrapSecret, timeoutMs);
  if (!identity.online) {
    throw new Error(`The local PiLink server identity could not be verified: ${identity.error || "health proof missing"}`);
  }
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
    const encodedBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers: {
        authorization: `Bearer ${bootstrapSecret}`,
        accept: "application/json",
        ...(encodedBody ? {
          "content-type": "application/json",
          "content-length": String(encodedBody.length),
        } : {}),
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
    request.once("timeout", () => request.destroy(new Error("Administrative endpoint timeout")));
    request.once("error", reject);
    request.end(encodedBody);
  });
}

function parseCollaborationBoard(value: Record<string, unknown>): CollaborationBoardView {
  const status = value.status === "ready" ? "ready" : "degraded";
  const projectKey = typeof value.project_key === "string" && /^[a-f0-9]{64}$/u.test(value.project_key)
    ? value.project_key
    : undefined;
  const timestamp = isoDate(value.timestamp) || new Date().toISOString();
  const tasks = Array.isArray(value.tasks)
    ? value.tasks.slice(0, 200).flatMap((candidate) => {
        try {
          return [parseCollaborationTask(record(candidate))];
        } catch {
          return [];
        }
      })
    : [];
  const participants = Array.isArray(value.participants)
    ? value.participants.slice(0, 100).flatMap((candidate) => {
        const participant = record(candidate);
        const collaborationSessionId = safeIdentifier(participant.collaboration_session_id, "");
        const agentName = safeDisplayText(participant.agent_name, 100);
        const canonicalRoleId = safeIdentifier(participant.canonical_role_id, "");
        const occupancyLabel = safeIdentifier(participant.occupancy_label, "");
        const lifecycle = participant.lifecycle;
        const updatedAt = isoDate(participant.updated_at);
        const revision = integerValue(participant.revision);
        if (!collaborationSessionId || !agentName || !canonicalRoleId || !occupancyLabel ||
            !["working", "waiting_for_task", "offline", "released"].includes(String(lifecycle)) ||
            !updatedAt || revision === undefined || revision < 1) return [];
        return [{
          collaborationSessionId,
          agentName,
          canonicalRoleId,
          occupancyLabel,
          lifecycle: lifecycle as CollaborationParticipantView["lifecycle"],
          updatedAt,
          revision,
        }];
      })
    : [];
  const error = status === "degraded" ? safeDisplayText(value.reason ?? value.error, 240) || "Collaboration data is degraded" : undefined;
  return {
    status,
    ...(projectKey ? { projectKey } : {}),
    tasks,
    participants,
    timestamp,
    ...(error ? { error } : {}),
  };
}

function parseCollaborationTask(value: Record<string, unknown>): CollaborationTaskView {
  const taskId = safeIdentifier(value.task_id, "");
  const title = safeDisplayText(value.title, 256);
  const status = value.status;
  const priority = value.priority;
  const risk = value.risk;
  const createdBy = safeDisplayText(value.created_by, 100);
  const createdAt = isoDate(value.created_at);
  const updatedAt = isoDate(value.updated_at);
  const revision = integerValue(value.revision);
  if (!taskId || !title || !["open", "working", "input_required", "completed", "failed", "cancelled"].includes(String(status)) ||
      !["P0", "P1", "P2", "P3"].includes(String(priority)) ||
      !["low", "medium", "high"].includes(String(risk)) || !createdBy || !createdAt || !updatedAt || revision === undefined || revision < 1) {
    throw new Error("Invalid collaboration task response");
  }
  const dependencies = Array.isArray(value.dependencies)
    ? value.dependencies.slice(0, 50).flatMap((candidate) => {
        const dependency = record(candidate);
        const dependencyTaskId = safeIdentifier(dependency.task_id, "");
        const condition = dependency.condition;
        return dependencyTaskId && (condition === "completed" || condition === "terminal")
          ? [{ taskId: dependencyTaskId, condition }]
          : [];
      })
    : [];
  const actions = record(value.actions);
  return {
    taskId,
    title,
    ...(safeDisplayText(value.details, 8 * 1024) ? { details: safeDisplayText(value.details, 8 * 1024) } : {}),
    status: status as CollaborationTaskStatus,
    ...(safeDisplayText(value.status_message, 8 * 1024) ? { statusMessage: safeDisplayText(value.status_message, 8 * 1024) } : {}),
    ...(safeDisplayText(value.artifact, 16 * 1024) ? { artifact: safeDisplayText(value.artifact, 16 * 1024) } : {}),
    priority: priority as CollaborationTaskPriority,
    dependencies,
    eligibleRoleIds: parseIdentifierList(value.eligible_role_ids, 20),
    requiredCapabilities: parseIdentifierList(value.required_capabilities, 20),
    risk: risk as CollaborationTaskView["risk"],
    ...(isoDate(value.not_before) ? { notBefore: isoDate(value.not_before) } : {}),
    createdBy,
    ...(safeIdentifier(value.created_by_session_id, "") ? { createdBySessionId: safeIdentifier(value.created_by_session_id, "") } : {}),
    ...(safeDisplayText(value.owner, 100) ? { owner: safeDisplayText(value.owner, 100) } : {}),
    ...(safeIdentifier(value.owner_session_id, "") ? { ownerSessionId: safeIdentifier(value.owner_session_id, "") } : {}),
    ...(safeIdentifier(value.owner_role_id, "") ? { ownerRoleId: safeIdentifier(value.owner_role_id, "") } : {}),
    ...(safeIdentifier(value.owner_role_label, "") ? { ownerRoleLabel: safeIdentifier(value.owner_role_label, "") } : {}),
    ...(isoDate(value.lease_expires_at) ? { leaseExpiresAt: isoDate(value.lease_expires_at) } : {}),
    createdAt,
    updatedAt,
    revision,
    actions: {
      provideInput: actions.provide_input === true,
      cancel: actions.cancel === true,
      release: actions.release === true,
    },
  };
}

function parseIdentifierList(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximum).flatMap((candidate) => {
    const selected = safeIdentifier(candidate, "");
    return selected ? [selected] : [];
  });
}

function safeDisplayText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
  const normalized = String(value)
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu, " ")
    .trim();
  if (!normalized) return "";
  let end = normalized.length;
  while (end > 0 && Buffer.byteLength(normalized.slice(0, end), "utf8") > maximumBytes) end -= 1;
  return normalized.slice(0, end).trim();
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseToolActivity(value: unknown): AdminToolActivity[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-100).flatMap((candidate) => {
    const entry = record(candidate);
    if (
      typeof entry.tool !== "string" ||
      typeof entry.started_at !== "string" ||
      !Number.isFinite(Date.parse(entry.started_at)) ||
      (entry.outcome !== "success" && entry.outcome !== "error")
    ) return [];
    const durationMs = numberValue(entry.duration_ms);
    if (durationMs === undefined || !Number.isSafeInteger(durationMs)) return [];
    return [{
      tool: safeIdentifier(entry.tool, "tool"),
      startedAt: new Date(entry.started_at).toISOString(),
      durationMs,
      outcome: entry.outcome,
    }];
  });
}

function safeIdentifier(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9._:@/-]{1,256}$/u.test(value) ? value : fallback;
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
