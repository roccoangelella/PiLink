import assert from "node:assert/strict";
import { createServer } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { startGatewayApi } from "../dist/llm-gateway-api.js";
import { probeGatewayReadiness } from "../dist/llm-gateway-runtime.js";
import { LlmGatewayJobStore } from "../dist/llm-gateway-store.js";

async function storeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-gateway-startup-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private");
  await fs.mkdir(workspace);
  const store = new LlmGatewayJobStore({ workspace, dataDir });
  await store.activate();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return store;
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => resolve(server.address().port));
  });
}

test("closing a port-0 gateway before listen cancels the pending bind", async (t) => {
  const messages = [];
  const api = startGatewayApi({
    store: {},
    apiKey: "startup-test-key",
    port: 0,
    log: (message) => messages.push(message),
  });
  t.after(() => api.close().catch(() => undefined));

  await api.close();
  await assert.rejects(api.ready, (error) => error?.code === "ERR_GATEWAY_CLOSED");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.server.listening, false);
  assert.equal(messages.some((message) => message.includes("OpenAI-compatible endpoint")), false);
});

test("gateway close is idempotent for concurrent callers", async () => {
  const api = startGatewayApi({ store: {}, apiKey: "startup-test-key", port: 0, log: () => undefined });
  const first = api.close();
  const second = api.close();
  assert.strictEqual(second, first);
  await Promise.all([first, second]);
  await assert.rejects(api.ready, (error) => error?.code === "ERR_GATEWAY_CLOSED");
  assert.equal(api.server.listening, false);
});

test("gateway startup model probe aborts a hung response body", async () => {
  let requestedUrl;
  let requestedOptions;
  let bodyAborted = false;
  const request = async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    const signal = options.signal;
    return {
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          bodyAborted = true;
          reject(signal.reason ?? new Error("aborted"));
        }, { once: true });
      }),
    };
  };

  await assert.rejects(
    probeGatewayReadiness("http://127.0.0.1:3210/v1", "probe-secret", request, 20),
    /timed out after 20ms/iu,
  );
  assert.equal(requestedUrl, "http://127.0.0.1:3210/v1/models");
  assert.equal(requestedOptions.headers.authorization, "Bearer probe-secret");
  assert.equal(bodyAborted, true);
});

test("gateway readiness reports the actual port and authenticated local reachability", async (t) => {
  const store = await storeFixture(t);
  const api = startGatewayApi({
    store,
    apiKey: "startup-test-key",
    port: 0,
    log: () => undefined,
  });
  t.after(() => api.close().catch(() => undefined));

  await api.ready;
  assert.ok(api.server.listening);
  assert.ok(api.port > 0);
  assert.equal(new URL(api.baseUrl).port, String(api.port));
  const response = await fetch(`${api.baseUrl}/models`, {
    headers: { authorization: "Bearer startup-test-key" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map((model) => model.id), ["pilink"]);
});

test("gateway readiness rejects an occupied port without publishing an endpoint", async (t) => {
  const store = await storeFixture(t);
  const occupied = createServer();
  const port = await listen(occupied);
  t.after(() => new Promise((resolve) => occupied.close(() => resolve())));

  const messages = [];
  const api = startGatewayApi({
    store,
    apiKey: "startup-test-key",
    port,
    log: (message) => messages.push(message),
  });
  t.after(() => api.close().catch(() => undefined));

  await assert.rejects(api.ready, (error) => error?.code === "EADDRINUSE");
  assert.equal(api.server.listening, false);
  assert.equal(messages.some((message) => message.includes("OpenAI-compatible endpoint")), false);
  const first = api.close();
  const second = api.close();
  assert.strictEqual(second, first);
  await Promise.all([first, second]);
  assert.equal(api.server.listening, false);
});

test("store activation failure reaches the real index ready gate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-gateway-store-startup-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private");
  await fs.mkdir(workspace);
  await fs.mkdir(dataDir);
  const malformedStore = new LlmGatewayJobStore({ workspace, dataDir });
  await fs.mkdir(path.dirname(malformedStore.statePath), { recursive: true });
  await fs.writeFile(malformedStore.statePath, "{}", { mode: 0o600 });

  const apiProbe = createServer();
  const apiPort = await listen(apiProbe);
  await new Promise((resolve) => apiProbe.close(() => resolve()));
  const coreProbe = createServer();
  const corePort = await listen(coreProbe);
  await new Promise((resolve) => coreProbe.close(() => resolve()));

  const events = [];
  let stderr = "";
  const child = spawn(process.execPath, [path.resolve("dist/index.js")], {
    env: {
      ...process.env,
      PILINK_CONFIG: path.join(root, ".env"),
      PI_WORK_DIR: workspace,
      PI_DATA_DIR: dataDir,
      PI_COORDINATION_DATA_DIR: path.join(root, "coordination"),
      PI_RUNTIME_MODE: "single",
      PORT: String(corePort),
      HOST: "127.0.0.1",
      SERVER_URL: `http://127.0.0.1:${corePort}`,
      JWT_SECRET: "a".repeat(32),
      PI_BOOTSTRAP_SECRET: "b".repeat(32),
      PI_LLM_GATEWAY_ENABLED: "true",
      PI_LLM_GATEWAY_PORT: String(apiPort),
      PI_LLM_GATEWAY_API_KEY: "c".repeat(32),
      PI_LLM_GATEWAY_STALE_SECONDS: "60",
    },
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return fs.rm(root, { recursive: true, force: true });
  });
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.stdio[3]?.on("data", (chunk) => {
    events.push(...chunk.toString("utf8").split("\\n").map((line) => line.trim()).filter(Boolean));
  });

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("gateway index did not fail its store startup gate"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(result.code, 1);
  assert.deepEqual(events, []);
  assert.match(stderr, /Startup readiness failed/iu);
  assert.doesNotMatch(stderr, /Listening:/u);
  assert.doesNotMatch(stderr, /node:net/iu);
});

test("an asynchronous gateway bind failure reaches the real index ready gate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-gateway-index-startup-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "private");
  await fs.mkdir(workspace);
  await fs.mkdir(dataDir);

  const occupied = createServer();
  const apiPort = await listen(occupied);
  t.after(() => new Promise((resolve) => occupied.close(() => resolve())));
  const coreProbe = createServer();
  const corePort = await listen(coreProbe);
  await new Promise((resolve) => coreProbe.close(() => resolve()));

  const events = [];
  let stderr = "";
  const child = spawn(process.execPath, [path.resolve("dist/index.js")], {
    env: {
      ...process.env,
      PILINK_CONFIG: path.join(root, ".env"),
      PI_WORK_DIR: workspace,
      PI_DATA_DIR: dataDir,
      PI_COORDINATION_DATA_DIR: path.join(root, "coordination"),
      PI_RUNTIME_MODE: "single",
      PORT: String(corePort),
      HOST: "127.0.0.1",
      SERVER_URL: `http://127.0.0.1:${corePort}`,
      JWT_SECRET: "a".repeat(32),
      PI_BOOTSTRAP_SECRET: "b".repeat(32),
      PI_LLM_GATEWAY_ENABLED: "true",
      PI_LLM_GATEWAY_PORT: String(apiPort),
      PI_LLM_GATEWAY_API_KEY: "c".repeat(32),
      PI_LLM_GATEWAY_STALE_SECONDS: "60",
    },
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return fs.rm(root, { recursive: true, force: true });
  });
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.stdio[3]?.on("data", (chunk) => {
    events.push(...chunk.toString("utf8").split("\\n").map((line) => line.trim()).filter(Boolean));
  });

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("gateway index did not fail its startup gate"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(result.code, 1);
  assert.deepEqual(events, []);
  assert.match(stderr, /Startup readiness failed/iu);
  assert.doesNotMatch(stderr, /Listening:/u);
  assert.doesNotMatch(stderr, /node:net/iu);
});
