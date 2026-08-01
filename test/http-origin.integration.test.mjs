import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const allowedBrowserOrigin = "https://chatgpt.com";
const rejectedBrowserOrigin = "https://attacker.example";

test("MCP transport rejects every present unapproved browser origin", async (t) => {
  const fixture = await startServer(t);

  for (const target of ["/sse", "/messages?sessionId=missing"]) {
    const response = await fetch(`${fixture.serverUrl}${target}`, {
      method: "POST",
      headers: {
        Origin: rejectedBrowserOrigin,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 403, target);
    assert.deepEqual(await response.json(), {
      error: "invalid_origin",
      error_description: "Origin is not allowed for the MCP transport",
    });
    assert.equal(response.headers.get("vary"), "Origin");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }

  const malformed = await fetch(`${fixture.serverUrl}/sse`, {
    method: "GET",
    headers: { Origin: "null" },
  });
  assert.equal(malformed.status, 403);

  const rejectedPreflight = await fetch(`${fixture.serverUrl}/sse`, {
    method: "OPTIONS",
    headers: {
      Origin: rejectedBrowserOrigin,
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(rejectedPreflight.status, 403);
});

test("same-origin and configured browser origins receive exact CORS headers", async (t) => {
  const fixture = await startServer(t);

  for (const origin of [fixture.serverUrl, allowedBrowserOrigin]) {
    const response = await fetch(`${fixture.serverUrl}/sse`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.match(response.headers.get("vary") || "", /Origin/);
  }

  const preflight = await fetch(`${fixture.serverUrl}/sse`, {
    method: "OPTIONS",
    headers: {
      Origin: allowedBrowserOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,mcp-session-id,mcp-protocol-version",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), allowedBrowserOrigin);
  assert.match(preflight.headers.get("access-control-allow-methods") || "", /POST/);
  assert.match(preflight.headers.get("access-control-allow-headers") || "", /Mcp-Session-Id/);
  assert.match(preflight.headers.get("access-control-allow-headers") || "", /Mcp-Protocol-Version/);
  assert.match(preflight.headers.get("access-control-expose-headers") || "", /Mcp-Session-Id/);

  const serverClientWithoutOrigin = await fetch(`${fixture.serverUrl}/sse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(serverClientWithoutOrigin.status, 401);
  assert.equal(serverClientWithoutOrigin.headers.get("access-control-allow-origin"), null);
});

test("runtime configuration canonicalizes and validates allowed origins", async () => {
  const { loadRuntimeConfig } = await import("../dist/config.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-origin-config-"));
  try {
    const base = {
      PI_WORK_DIR: root,
      PILINK_CONFIG: path.join(root, "pilink.env"),
      JWT_SECRET: "j".repeat(32),
      PI_BOOTSTRAP_SECRET: "b".repeat(32),
      SERVER_URL: "https://pilink.example/base",
    };
    const config = loadRuntimeConfig({
      ...base,
      CORS_ORIGINS: "https://chatgpt.com/, https://CHATGPT.com, http://localhost:3000",
    });
    assert.deepEqual(config.corsOrigins, [
      "https://pilink.example",
      "https://chatgpt.com",
      "http://localhost:3000",
    ]);

    for (const configuredOrigin of [
      "*",
      "null",
      "file:///tmp/example",
      "https://user:pass@example.com",
      "https://example.com/path",
      "https://example.com?query=1",
    ]) {
      assert.throws(
        () => loadRuntimeConfig({ ...base, CORS_ORIGINS: configuredOrigin }),
        /CORS_ORIGINS entries/,
        configuredOrigin,
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function startServer(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-origin-http-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  const port = await availablePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.resolve("dist/index.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      SERVER_URL: serverUrl,
      CORS_ORIGINS: `${allowedBrowserOrigin}/, ${allowedBrowserOrigin}`,
      PI_WORK_DIR: workspace,
      PI_DATA_DIR: dataDir,
      JWT_SECRET: "a".repeat(32),
      PI_BOOTSTRAP_SECRET: "b".repeat(32),
    },
    stdio: "ignore",
  });

  t.after(async () => {
    if (!server.killed) server.kill("SIGINT");
    await onceExit(server);
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForHealth(`${serverUrl}/health`);
  return { serverUrl };
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate test port"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for PiLink server");
}

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}
