import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("malformed and oversized JSON on async routes stays generic and does not kill the server", async (t) => {
  const fixture = await startServer(t);
  const malformedMarker = "MALFORMED_PRIVATE_REQUEST_MARKER";
  const oversizedMarker = "OVERSIZED_PRIVATE_REQUEST_MARKER";
  const privatePath = path.join(fixture.root, "private", "credentials.json");

  const malformed = await fetch(`${fixture.serverUrl}/oauth/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fixture.bootstrapSecret}`,
      "Content-Type": "application/json",
    },
    body: `{"client_name":"${malformedMarker}","path":"${privatePath}","secret":"${fixture.jwtSecret}"`,
  });
  await assertGenericError(malformed, 400, "invalid_request", [
    malformedMarker,
    privatePath,
    fixture.jwtSecret,
    fixture.bootstrapSecret,
  ]);
  await assertServerAlive(fixture);

  const oversizedBody = JSON.stringify({
    client_name: "oversized",
    private_marker: oversizedMarker,
    private_path: privatePath,
    private_secret: fixture.jwtSecret,
    padding: "x".repeat(300 * 1024),
  });
  assert.ok(Buffer.byteLength(oversizedBody, "utf8") > 256 * 1024);
  const oversized = await fetch(`${fixture.serverUrl}/oauth/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fixture.bootstrapSecret}`,
      "Content-Type": "application/json",
    },
    body: oversizedBody,
  });
  await assertGenericError(oversized, 413, "payload_too_large", [
    oversizedMarker,
    privatePath,
    fixture.jwtSecret,
    fixture.bootstrapSecret,
  ]);
  await assertServerAlive(fixture);

  // Exercise the same async route successfully after both parser failures.
  const valid = await fetch(`${fixture.serverUrl}/oauth/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fixture.bootstrapSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_name: "post-error-liveness",
      grant_types: ["client_credentials"],
      scope: "mcp:read",
    }),
  });
  assert.equal(valid.status, 201);
  const registered = await valid.json();
  assert.equal(registered.client_name, "post-error-liveness");
  assert.equal(registered.scope, "mcp:read");
  assert.equal(fixture.server.exitCode, null);
});

async function assertGenericError(response, expectedStatus, expectedCode, forbiddenValues) {
  assert.equal(response.status, expectedStatus);
  assert.match(response.headers.get("content-type") || "", /^application\/json\b/u);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: expectedCode });
  for (const value of forbiddenValues) assert.equal(text.includes(value), false);
  assert.doesNotMatch(text, /SyntaxError|PayloadTooLargeError|node_modules|dist\/index\.js|src\/index\.ts|\bat\s+\S+\s+\(/u);
}

async function assertServerAlive(fixture) {
  assert.equal(fixture.server.exitCode, null, fixture.stderr.join(""));
  const health = await fetch(`${fixture.serverUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  assert.equal(fixture.server.exitCode, null, fixture.stderr.join(""));
}

async function startServer(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vspilink-http-errors-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspace);
  await fs.mkdir(dataDir);
  const port = await availablePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const jwtSecret = "jwt-private-marker-".padEnd(48, "j");
  const bootstrapSecret = "bootstrap-private-marker-".padEnd(48, "b");
  const server = spawn(process.execPath, [path.resolve("dist/index.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      SERVER_URL: serverUrl,
      PILINK_CONFIG: path.join(root, "test.env"),
      PI_WORK_DIR: workspace,
      PI_DATA_DIR: dataDir,
      JWT_SECRET: jwtSecret,
      PI_BOOTSTRAP_SECRET: bootstrapSecret,
      PI_OAUTH_CONSENT_MODE: "browser",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = [];
  server.stderr.on("data", (chunk) => {
    if (stderr.reduce((total, entry) => total + entry.length, 0) < 64 * 1024) stderr.push(chunk.toString("utf8"));
  });
  t.after(async () => {
    if (server.exitCode === null) server.kill("SIGINT");
    await onceExit(server);
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitForHealth(serverUrl, server, stderr);
  return { root, serverUrl, server, stderr, jwtSecret, bootstrapSecret };
}

async function waitForHealth(serverUrl, server, stderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited during startup (${server.exitCode}): ${stderr.join("")}`);
    try {
      const response = await fetch(`${serverUrl}/health`);
      if (response.ok) return;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become healthy: ${stderr.join("")}`);
}

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function onceExit(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
}
