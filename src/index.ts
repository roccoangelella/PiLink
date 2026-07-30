// ─────────────────────────────────────────────────────────────
// PI-MCP: Main Entry Point
// Supports Streamable HTTP and legacy SSE MCP transports
// Exposes the native Pi Agent tool harness to MCP clients
// ─────────────────────────────────────────────────────────────

import "dotenv/config";
import { randomUUID } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./mcp.js";
import { createOAuthRouter } from "./oauth.js";
import { authenticateBearer } from "./auth.js";

const PORT = parseInt(process.env.PORT || "3200", 10);
const HOST = process.env.HOST || "0.0.0.0";
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

const app = express();

// ── Body parsing ─────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CORS (allow any origin for MCP clients) ──────────────────
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (_req.method === "OPTIONS") {
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
      (sessionId ? ` session=${sessionId}` : "") +
      (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0
        ? ` body=${JSON.stringify(req.body, (key, val) => key === "client_secret" ? "***" : val).slice(0, 200)}`
        : "")
    );
    return (originalEnd as Function).apply(res, args);
  } as any;
  next();
});

// ── Mount OAuth routes (public, no Bearer required) ──────────
const oauthRouter = createOAuthRouter();
app.use(oauthRouter);

// ── Health / status endpoint ─────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "pi-mcp",
    version: "1.0.0",
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

const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};

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
      const transport = transports[sessionId];
      if (transport instanceof StreamableHTTPServerTransport) {
        await transport.handleRequest(req, res, req.body);
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
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        console.error(`[MCP] Streamable HTTP session created: ${sid}`);
        transports[sid] = transport;
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && transports[sid]) {
        console.error(`[MCP] Streamable HTTP session closed: ${sid}`);
        delete transports[sid];
      }
    };

    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
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
    const transport = transports[sessionId];
    if (transport instanceof StreamableHTTPServerTransport) {
      console.error(`[MCP] Streamable HTTP SSE stream opened for session: ${sessionId}`);
      await transport.handleRequest(req, res);
      return;
    }
  }

  console.error("[MCP] Legacy SSE session starting...");
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  console.error(`[MCP] Legacy SSE session created: ${transport.sessionId}`);

  res.on("close", () => {
    console.error(`[MCP] Legacy SSE session closed: ${transport.sessionId}`);
    delete transports[transport.sessionId];
  });

  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);
});

// ── Streamable HTTP: DELETE /sse (session teardown) ──────────
app.delete("/sse", authenticateBearer, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports[sessionId]) {
    const transport = transports[sessionId];
    if (transport instanceof StreamableHTTPServerTransport) {
      console.error(`[MCP] Streamable HTTP session deleted: ${sessionId}`);
      await transport.handleRequest(req, res);
      delete transports[sessionId];
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

  const transport = transports[sessionId];
  if (!transport || !(transport instanceof SSEServerTransport)) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  await transport.handlePostMessage(req, res);
});

// ── Start server ─────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.error(`
╔══════════════════════════════════════════════════╗
║              PI-MCP Server v1.0.0               ║
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

// ── Graceful shutdown ────────────────────────────────────────
process.on("SIGINT", async () => {
  console.error("Shutting down...");
  for (const sessionId in transports) {
    try {
      await transports[sessionId].close?.();
      delete transports[sessionId];
    } catch { /* ignore */ }
  }
  process.exit(0);
});

function renderLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PI-MCP Server</title>
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
    <div class="logo">PI<span>-MCP</span></div>
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
    <p class="footer">PI-MCP v1.0.0 &bull; Pi Agent Tool Harness &bull; Streamable HTTP + SSE</p>
  </div>
</body>
</html>`;
}
