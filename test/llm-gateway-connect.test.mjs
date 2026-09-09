import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openGatewayConnectorWindow, runGatewayConnect } from "../dist/llm-gateway-connect.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function setupTestEnv(port) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilink-gateway-connect-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const bootstrap = "b".repeat(43);
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

  const teardown = () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, previousEnvironment);
    fs.rmSync(root, { recursive: true, force: true });
  };

  return { root, bootstrap, configPath, teardown };
}

test("gateway connector setup opens the loopback owner DCR window even with an existing configured instance", async () => {
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
  const { bootstrap, teardown } = setupTestEnv(address.port);

  try {
    const info = await openGatewayConnectorWindow(1_000);
    assert.equal(seenAuthorization, `Bearer ${bootstrap}`);
    assert.equal(info.mcpUrl, "https://mcp.example.com/sse");
    assert.equal(info.apiBaseUrl, "http://127.0.0.1:45678/v1");
    assert.equal(info.verificationCode, "ABCD-EFGH");
    assert.match(info.apiKey, /^plg_[A-Za-z0-9_-]+$/u);
  } finally {
    teardown();
    await close(server);
  }
});

test("gateway connector setup waits and retries when pairing endpoint is temporarily not ready", async () => {
  let attempts = 0;
  const server = http.createServer((req, res) => {
    attempts++;
    if (attempts < 3) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "PiLink not ready yet" }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/admin/oauth/pairing") {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      pairing_url: "https://mcp.example.com/oauth/pair?code=abcdefghijklmnopqrstuvwxyz0123456789",
      verification_code: "RETR-Y234",
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    }));
  });

  const address = await listen(server);
  const { teardown } = setupTestEnv(address.port);

  try {
    const info = await openGatewayConnectorWindow(2_000);
    assert.ok(attempts >= 3, `Expected at least 3 attempts, got ${attempts}`);
    assert.equal(info.verificationCode, "RETR-Y234");
  } finally {
    teardown();
    await close(server);
  }
});

test("gateway connector setup times out when endpoint does not become ready within deadline", async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 503;
    res.end("Server warming up");
  });

  const address = await listen(server);
  const { teardown } = setupTestEnv(address.port);

  try {
    await assert.rejects(
      () => openGatewayConnectorWindow(250),
      /PiLink gateway started but its local OAuth setup endpoint did not become ready/u,
    );
  } finally {
    teardown();
    await close(server);
  }
});

test("gateway connector setup fails fast without retrying on 404 or 403", async () => {
  let attempts = 0;
  const server = http.createServer((_req, res) => {
    attempts++;
    res.statusCode = 404;
    res.end("Not Found");
  });

  const address = await listen(server);
  const { teardown } = setupTestEnv(address.port);

  try {
    await assert.rejects(
      () => openGatewayConnectorWindow(2_000),
      /PiLink could not open the ChatGPT registration window \(HTTP 404\)/u,
    );
    assert.equal(attempts, 1, `Expected 1 attempt on 404, got ${attempts}`);
  } finally {
    teardown();
    await close(server);
  }
});

test("gateway connector setup rejects oversized or invalid pairing responses", async () => {
  let mode = "oversized";
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    if (mode === "oversized") {
      res.end("x".repeat(17 * 1024));
    } else if (mode === "invalid-json") {
      res.end("not json");
    } else if (mode === "invalid-fields") {
      res.end(JSON.stringify({ pairing_url: "bad-url", verification_code: "123" }));
    }
  });

  const address = await listen(server);
  const { teardown } = setupTestEnv(address.port);

  try {
    mode = "oversized";
    await assert.rejects(
      () => openGatewayConnectorWindow(500),
      /PiLink returned an oversized connector setup response/u,
    );

    mode = "invalid-json";
    await assert.rejects(
      () => openGatewayConnectorWindow(500),
      /PiLink returned an invalid connector setup response/u,
    );

    mode = "invalid-fields";
    await assert.rejects(
      () => openGatewayConnectorWindow(500),
      /PiLink returned an invalid connector setup response/u,
    );
  } finally {
    teardown();
    await close(server);
  }
});

test("openGatewayConnectorWindow works with default wait timeout when server is immediately ready", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      pairing_url: "https://mcp.example.com/oauth/pair?code=abcdefghijklmnopqrstuvwxyz0123456789",
      verification_code: "DEFA-2345",
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    }));
  });

  const address = await listen(server);
  const { teardown } = setupTestEnv(address.port);

  try {
    const info = await openGatewayConnectorWindow();
    assert.equal(info.verificationCode, "DEFA-2345");
  } finally {
    teardown();
    await close(server);
  }
});

test("runGatewayConnect returns 0 on success and 1 on failure", async () => {
  let statusCode = 200;
  const server = http.createServer((_req, res) => {
    if (statusCode !== 200) {
      res.statusCode = statusCode;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      pairing_url: "https://mcp.example.com/oauth/pair?code=abcdefghijklmnopqrstuvwxyz0123456789",
      verification_code: "RUN2-PASS",
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    }));
  });

  const address = await listen(server);
  const { teardown } = setupTestEnv(address.port);

  const originalStderrWrite = process.stderr.write;
  try {
    process.stderr.write = () => true;
    const successCode = await runGatewayConnect();
    assert.equal(successCode, 0);

    statusCode = 404; // Non-retryable failure triggers immediate rejection in runGatewayConnect
    const failureCode = await runGatewayConnect();
    assert.equal(failureCode, 1);
  } finally {
    process.stderr.write = originalStderrWrite;
    teardown();
    await close(server);
  }
});
