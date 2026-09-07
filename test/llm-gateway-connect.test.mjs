import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openGatewayConnectorWindow } from "../dist/llm-gateway-connect.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("gateway connector setup opens the loopback owner DCR window even with an existing configured instance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilink-gateway-connect-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const bootstrap = "b".repeat(43);
  let seenAuthorization = "";

  const server = http.createServer((req, res) => {
    seenAuthorization = req.headers.authorization || "";
    if (req.method !== "POST" || req.url !== "/admin/oauth/pairing") {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      pairing_url: "https://mcp.example.com/oauth/pair?code=abcdefghijklmnopqrstuvwxyz0123456789",
      verification_code: "ABCD-EFGH",
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    }));
  });

  const address = await listen(server);
  const port = address.port;
  const configPath = path.join(root, ".env");
  fs.writeFileSync(configPath, [
    `PI_WORK_DIR=${workspace}`,
    `PI_DATA_DIR=${dataDir}`,
    `PI_COORDINATION_DATA_DIR=${path.join(dataDir, "coordination")}`,
    "PI_RUNTIME_MODE=single",
    `PORT=${port}`,
    `JWT_SECRET=${"j".repeat(43)}`,
    `PI_BOOTSTRAP_SECRET=${bootstrap}`,
    "TOKEN_EXPIRY=3600",
    "PI_REFRESH_TOKEN_EXPIRY=2592000",
    "PI_OAUTH_CONSENT_MODE=paired",
    "PI_OAUTH_PUBLIC_CHATGPT_DCR=true",
    "SERVER_URL=https://mcp.example.com",
    "HOST=127.0.0.1",
    "",
  ].join("\n"), { mode: 0o600 });

  const previousEnvironment = { ...process.env };
  process.env.PILINK_CONFIG = configPath;
  process.env.PI_LLM_GATEWAY_PORT = "45678";
  try {
    const info = await openGatewayConnectorWindow(1_000);
    assert.equal(seenAuthorization, `Bearer ${bootstrap}`);
    assert.equal(info.mcpUrl, "https://mcp.example.com/sse");
    assert.equal(info.apiBaseUrl, "http://127.0.0.1:45678/v1");
    assert.equal(info.verificationCode, "ABCD-EFGH");
    assert.match(info.apiKey, /^plg_[A-Za-z0-9_-]+$/u);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, previousEnvironment);
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
