// ─────────────────────────────────────────────────────────────
// PiLink: Main Entry Point
// Supports Streamable HTTP and legacy SSE MCP transports
// Exposes the native Pi Agent tool harness to MCP clients
// ─────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer, type McpServerHandle } from "./mcp.js";
import { createOAuthRouter } from "./oauth.js";
import { authenticateBearer, findClient } from "./auth.js";
import { createHarnessPolicy } from "./harness.js";
import { loadEnvironment, loadRuntimeConfig, VERSION } from "./config.js";
import { createRateLimiter } from "./security.js";
import { AgentChatBroker, AgentChatStore } from "./chat.js";
import { ToolAuditLog } from "./audit.js";

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
app.use(["/oauth/token", "/oauth/revoke", "/oauth/register", "/oauth/authorize"], createRateLimiter(20, 60_000));
app.use(oauthRouter);

// ── Health / status endpoint ─────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "pilink",
    version: VERSION,
    harness: "pi-agent",
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
  handle: McpServerHandle;
  clientId: string;
  scope: string;
  dispose: () => void;
}

const transports: Record<string, ManagedTransport> = {};
let agentChatBroker: AgentChatBroker | undefined;
let toolAuditLog: ToolAuditLog | undefined;

function getAgentChatBroker(): AgentChatBroker {
  if (!agentChatBroker) {
    agentChatBroker = new AgentChatBroker(new AgentChatStore({
      workspace: config.workspace,
      dataDir: config.dataDir,
    }));
  }
  return agentChatBroker;
}

function getToolAuditLog(): ToolAuditLog {
  if (!toolAuditLog) {
    toolAuditLog = new ToolAuditLog({
      workspace: config.workspace,
      dataDir: config.dataDir,
    });
  }
  return toolAuditLog;
}

function tokenFor(req: express.Request): { sub: string; scope: string } {
  return (req as express.Request & { tokenPayload: { sub: string; scope: string } }).tokenPayload;
}

function resolveNewSessionClient(req: express.Request, res: express.Response): {
  clientId: string;
  scope: string;
  identity: Readonly<{ agentId: string; agentName: string }>;
} | null {
  const token = tokenFor(req);
  const client = findClient(token.sub);
  if (!client) {
    res.status(403).json({ error: "forbidden", error_description: "Authenticated OAuth client no longer exists" });
    return null;
  }
  return {
    clientId: client.client_id,
    scope: token.scope,
    identity: Object.freeze({ agentId: client.client_id, agentName: client.client_name }),
  };
}

function effectiveCapabilities(scope: string): Set<"read" | "write"> {
  const granted = new Set(scope.split(" ").filter(Boolean));
  const capabilities = new Set<"read" | "write">();
  if (granted.has("mcp:tools") || granted.has("mcp:read")) capabilities.add("read");
  if (granted.has("mcp:tools") || granted.has("mcp:write")) capabilities.add("write");
  return capabilities;
}

function canReuseSession(managed: ManagedTransport, token: { sub: string; scope: string }): boolean {
  if (managed.clientId !== token.sub) return false;
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

function disposeTransport(sessionId: string, expected?: ManagedTransport["transport"]): void {
  const managed = transports[sessionId];
  if (!managed || (expected && managed.transport !== expected)) return;
  delete transports[sessionId];
  managed.dispose();
}

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
    if (sessionId && transports[sessionId]) {
      const managed = transports[sessionId];
      if (!canReuseSession(managed, tokenFor(req))) {
        rejectSessionReuse(res);
        return;
      }
      const transport = managed.transport;
      if (transport instanceof StreamableHTTPServerTransport) {
        try {
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          disposeTransport(sessionId, transport);
          throw error;
        }
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
    const sessionClient = resolveNewSessionClient(req, res);
    if (!sessionClient) return;
    const handle = createMcpServer(
      policy,
      sessionClient.scope,
      sessionClient.identity,
      getAgentChatBroker(),
      getToolAuditLog(),
    );
    const dispose = once(handle.dispose);
    let managed: ManagedTransport | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        console.error(`[MCP] Streamable HTTP session created: ${sid}`);
        if (managed) transports[sid] = managed;
      },
    });

    managed = {
      transport,
      handle,
      clientId: sessionClient.clientId,
      scope: sessionClient.scope,
      dispose,
    };
    const cleanup = () => {
      const sid = transport.sessionId;
      if (sid && transports[sid]) {
        console.error(`[MCP] Streamable HTTP session closed: ${sid}`);
        disposeTransport(sid, transport);
      } else {
        dispose();
      }
    };
    transport.onclose = cleanup;
    transport.onerror = cleanup;

    try {
      await handle.server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      cleanup();
      throw error;
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

  if (sessionId && transports[sessionId]) {
    const managed = transports[sessionId];
    if (!canReuseSession(managed, tokenFor(req))) {
      rejectSessionReuse(res);
      return;
    }
    const transport = managed.transport;
    if (transport instanceof StreamableHTTPServerTransport) {
      console.error(`[MCP] Streamable HTTP SSE stream opened for session: ${sessionId}`);
      try {
        await transport.handleRequest(req, res);
      } catch (error) {
        disposeTransport(sessionId, transport);
        console.error("[MCP] Error handling Streamable HTTP SSE stream:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "internal_error", error_description: "Unable to handle MCP session" });
        }
      }
      return;
    }
  }

  console.error("[MCP] Legacy SSE session starting...");
  const sessionClient = resolveNewSessionClient(req, res);
  if (!sessionClient) return;
  const transport = new SSEServerTransport("/messages", res);
  const handle = createMcpServer(
    policy,
    sessionClient.scope,
    sessionClient.identity,
    getAgentChatBroker(),
    getToolAuditLog(),
  );
  const dispose = once(handle.dispose);
  transports[transport.sessionId] = {
    transport,
    handle,
    clientId: sessionClient.clientId,
    scope: sessionClient.scope,
    dispose,
  };
  console.error(`[MCP] Legacy SSE session created: ${transport.sessionId}`);

  res.on("close", () => {
    console.error(`[MCP] Legacy SSE session closed: ${transport.sessionId}`);
    disposeTransport(transport.sessionId, transport);
  });
  transport.onerror = () => disposeTransport(transport.sessionId, transport);

  try {
    await handle.server.connect(transport);
  } catch (error) {
    disposeTransport(transport.sessionId, transport);
    console.error("[MCP] Error starting legacy SSE session:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error", error_description: "Unable to start MCP session" });
    }
  }
});

// ── Streamable HTTP: DELETE /sse (session teardown) ──────────
app.delete("/sse", authenticateBearer, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports[sessionId]) {
    const managed = transports[sessionId];
    if (!canReuseSession(managed, tokenFor(req))) {
      rejectSessionReuse(res);
      return;
    }
    const transport = managed.transport;
    if (transport instanceof StreamableHTTPServerTransport) {
      console.error(`[MCP] Streamable HTTP session deleted: ${sessionId}`);
      try {
        await transport.handleRequest(req, res);
      } finally {
        disposeTransport(sessionId, transport);
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
  if (!managed || !(managed.transport instanceof SSEServerTransport)) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }
  const token = tokenFor(req);
  if (managed.clientId !== token.sub) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }
  if (!canReuseSession(managed, token)) {
    rejectSessionReuse(res);
    return;
  }

  try {
    await managed.transport.handlePostMessage(req, res);
  } catch (error) {
    disposeTransport(sessionId, managed.transport);
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
process.on("SIGINT", async () => {
  console.error("Shutting down...");
  for (const sessionId in transports) {
    const managed = transports[sessionId];
    try {
      await managed.transport.close?.();
    } catch { /* ignore */ }
    disposeTransport(sessionId, managed.transport);
  }
  try {
    await toolAuditLog?.flush();
  } catch { /* audit writes are best effort */ }
  process.exit(0);
});

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
