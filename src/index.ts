// ─────────────────────────────────────────────────────────────
// PiLink: Main Entry Point
// Supports Streamable HTTP and legacy SSE MCP transports
// Exposes the native Pi Agent tool harness to MCP clients
// ─────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./mcp.js";
import { createOAuthRouter } from "./oauth.js";
import { authenticateBearer } from "./auth.js";
import { createHarnessPolicy } from "./harness.js";
import { loadEnvironment, loadRuntimeConfig, VERSION } from "./config.js";
import { createRateLimiter } from "./security.js";

loadEnvironment();
const config = loadRuntimeConfig();
const policy = createHarnessPolicy(config);
const { port: PORT, host: HOST, serverUrl: SERVER_URL } = config;

const app = express();
app.set("trust proxy", config.trustProxy);

// ── Body parsing ─────────────────────────────────────────────
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

// ── CORS (opt-in: browser clients only) ───────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// ── Request logging ──────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  const originalEnd = res.end;
  res.end = function (...args: any[]) {
    const duration = Date.now() - start;
    const sessionId = req.headers["mcp-session-id"] || "";
    console.error(
      `[HTTP] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)` +
      (sessionId ? ` session=${sessionId}` : "")
    );
    return (originalEnd as Function).apply(res, args);
  } as any;
  next();
});

// ── Mount OAuth routes (public, no Bearer required) ──────────
const oauthRouter = createOAuthRouter();
app.use(["/oauth/token", "/oauth/register", "/oauth/authorize"], createRateLimiter(20, 60_000));
app.use(oauthRouter);

// ── Health / status endpoint ─────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "pilink",
    version: VERSION,
    harness: "pi-agent",
    sessions: publicSessionStatus(),
    timestamp: new Date().toISOString(),
  });
});

// ── Landing page ─────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.type("html").send(renderLandingPage());
});

// ══════════════════════════════════════════════════════════════
// MCP Transport Layer (protected by OAuth Bearer token)
// ══════════════════════════════════════════════════════════════

interface ManagedTransport {
  transport: StreamableHTTPServerTransport | SSEServerTransport;
  server: ReturnType<typeof createMcpServer>;
  clientId: string;
  createdAtMs: number;
  lastActivityAtMs: number;
  inFlightRequests: number;
  openStreams: number;
  established: boolean;
}

const transports: Record<string, ManagedTransport> = {};
let pendingMcpSessionsTotal = 0;
const pendingMcpSessionsByClient = new Map<string, number>();
const idleSessionTimeoutMs = config.mcpSessionIdleTimeoutSeconds * 1_000;
const sessionReclaimGraceMs = config.mcpSessionReclaimGraceSeconds * 1_000;

function tokenFor(req: express.Request): { sub: string; scope: string } {
  return (req as express.Request & { tokenPayload: { sub: string; scope: string } }).tokenPayload;
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

function createManagedTransport(
  transport: ManagedTransport["transport"],
  server: ManagedTransport["server"],
  clientId: string,
): ManagedTransport {
  const now = Date.now();
  return {
    transport,
    server,
    clientId,
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
  return managed;
}

async function closeDetachedTransport(sessionId: string, managed: ManagedTransport, context: string): Promise<void> {
  try {
    await managed.server.close();
  } catch (error) {
    console.error(`[${context}] Unable to close MCP session ${sessionId}:`, error);
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
  console.error(`[MCP] Recycling quiescent session ${sessionId} for client ${managed.clientId} under ${reason}.`);
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
      `[MCP] Expiring quiescent session ${sessionId} for client ${managed.clientId} ` +
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
app.post("/sse", authenticateBearer, async (req, res) => {
  ensureAcceptHeader(req);
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    if (sessionId) {
      const managed = transports[sessionId];
      if (!managed) {
        rejectExpiredOrUnknownSession(res);
        return;
      }
      if (managed.clientId !== tokenFor(req).sub) {
        res.status(403).json({ error: "forbidden", error_description: "Session belongs to another client" });
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
    const releaseReservation = reserveSessionSlot(client.sub, res);
    if (!releaseReservation) return;
    let managed: ManagedTransport;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        console.error(`[MCP] Streamable HTTP session created: ${sid}`);
        if (managed) {
          transports[sid] = managed;
          releaseReservation();
        }
      },
    });
    const mcpServer = createMcpServer(policy, client.scope);
    managed = createManagedTransport(transport, mcpServer, client.sub);
    const cleanup = once(() => {
      const sid = transport.sessionId;
      if (sid) {
        const detached = removeManagedTransport(sid, transport);
        if (detached) {
          console.error(`[MCP] Streamable HTTP session closed: ${sid}`);
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
});

// ── Streamable HTTP: GET /sse (SSE stream for notifications) ─
app.get("/sse", authenticateBearer, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId) {
    const managed = transports[sessionId];
    if (!managed) {
      rejectExpiredOrUnknownSession(res);
      return;
    }
    if (managed.clientId !== tokenFor(req).sub) {
      res.status(403).json({ error: "forbidden", error_description: "Session belongs to another client" });
      return;
    }
    const transport = managed.transport;
    if (transport instanceof StreamableHTTPServerTransport) {
      managed.established = true;
      console.error(`[MCP] Streamable HTTP SSE stream opened for session: ${sessionId}`);
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
  const releaseReservation = reserveSessionSlot(client.sub, res);
  if (!releaseReservation) return;
  const transport = new SSEServerTransport("/messages", res);
  const mcpServer = createMcpServer(policy, client.scope);
  const managed = createManagedTransport(transport, mcpServer, client.sub);
  managed.openStreams = 1;
  transports[transport.sessionId] = managed;
  releaseReservation();
  console.error(`[MCP] Legacy SSE session created: ${transport.sessionId}`);

  const cleanup = once(() => {
    managed.openStreams = 0;
    touchTransport(managed);
    const detached = removeManagedTransport(transport.sessionId, transport);
    if (detached) {
      console.error(`[MCP] Legacy SSE session closed: ${transport.sessionId}`);
      void closeDetachedTransport(transport.sessionId, detached, "MCP");
    }
    releaseReservation();
  });
  res.once("close", cleanup);
  transport.onerror = cleanup;

  try {
    await mcpServer.connect(transport);
  } catch (error) {
    cleanup();
    console.error("[MCP] Error starting legacy SSE session:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error", error_description: "Unable to start MCP session" });
    }
  } finally {
    releaseReservation();
  }
});

// ── Streamable HTTP: DELETE /sse (session teardown) ──────────
app.delete("/sse", authenticateBearer, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports[sessionId]) {
    const managed = transports[sessionId];
    if (managed.clientId !== tokenFor(req).sub) {
      res.status(403).json({ error: "forbidden", error_description: "Session belongs to another client" });
      return;
    }
    const transport = managed.transport;
    if (transport instanceof StreamableHTTPServerTransport) {
      console.error(`[MCP] Streamable HTTP session deleted: ${sessionId}`);
      try {
        await withManagedRequest(managed, () => transport.handleRequest(req, res));
      } finally {
        const detached = removeManagedTransport(sessionId, transport);
        if (detached) await closeDetachedTransport(sessionId, detached, "MCP");
      }
      return;
    }
  }

  res.status(404).json({ error: "Session not found" });
});

// ── Legacy SSE: POST /messages ───────────────────────────────
app.post("/messages", authenticateBearer, async (req, res) => {
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
  const transport = managed.transport;

  try {
    await withManagedRequest(managed, () => transport.handlePostMessage(req, res));
    managed.established = true;
  } catch (error) {
    console.error("[MCP] Error handling legacy SSE message:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error", error_description: "Unable to handle MCP session" });
    }
  }
});

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
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function renderLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PiLink Server</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0f0f14; color: #e2e2e8;
      min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 2rem;
    }
    .container { max-width: 600px; width: 100%; }
    .logo { font-size: 3rem; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 0.4rem; }
    .logo span { background: linear-gradient(135deg, #10b981, #059669); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .tag { color: #10b981; font-size: 0.85rem; font-weight: 500; margin-bottom: 2rem; display: block; }
    .status {
      display: inline-flex; align-items: center; gap: 0.5rem;
      background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.25);
      border-radius: 20px; padding: 0.4rem 1rem; margin-bottom: 2rem; font-size: 0.85rem; color: #10b981;
    }
    .pulse { width: 8px; height: 8px; border-radius: 50%; background: #10b981; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .endpoints {
      background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem;
    }
    .endpoints h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #8888a0; margin-bottom: 1rem; }
    .endpoint { display: flex; justify-content: space-between; padding: 0.6rem 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .endpoint:last-child { border-bottom: none; }
    .endpoint .method { color: #10b981; font-family: monospace; font-weight: 600; font-size: 0.8rem; }
    .endpoint .path { font-family: monospace; font-size: 0.85rem; color: #b4b4cc; }
    .footer { text-align: center; color: #555; font-size: 0.75rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">Pi<span>Link</span></div>
    <span class="tag">Pi Agent Tool Harness • Streamable HTTP & SSE • OAuth 2.0</span>
    <div class="status"><span class="pulse"></span> Server Online</div>
    <div class="endpoints">
      <h3>Native Pi Agent Harness Tools</h3>
      <div class="endpoint"><span class="method">TOOL</span><span class="path">read (file contents & images)</span></div>
      <div class="endpoint"><span class="method">TOOL</span><span class="path">bash (bash commands)</span></div>
      <div class="endpoint"><span class="method">TOOL</span><span class="path">edit (exact text replacement)</span></div>
      <div class="endpoint"><span class="method">TOOL</span><span class="path">write (file creation/overwrite)</span></div>
      <div class="endpoint"><span class="method">TOOL</span><span class="path">grep (content pattern search)</span></div>
      <div class="endpoint"><span class="method">TOOL</span><span class="path">find (glob file search)</span></div>
      <div class="endpoint"><span class="method">TOOL</span><span class="path">ls (list directory contents)</span></div>
    </div>
    <div class="endpoints">
      <h3>MCP Transports & OAuth</h3>
      <div class="endpoint"><span class="method">POST/GET/DELETE</span><span class="path">/sse (Streamable HTTP)</span></div>
      <div class="endpoint"><span class="method">POST</span><span class="path">/oauth/token</span></div>
      <div class="endpoint"><span class="method">POST</span><span class="path">/oauth/register</span></div>
    </div>
    <p class="footer">PiLink v${VERSION} &bull; Powered by Pi Agent Tool Harness &bull; Streamable HTTP + SSE</p>
  </div>
</body>
</html>`;
}
