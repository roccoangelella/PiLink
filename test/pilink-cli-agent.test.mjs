import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveGatewayApiKey } from "../dist/llm-gateway-api.js";
import { ensurePiGatewayModel, verifyLocalGateway } from "../dist/pilink-cli-agent.js";

const jwtSecret = "a".repeat(32);
const bootstrapSecret = "b".repeat(32);

function createConfig(root, port = 3200, apiPort) {
  const file = path.join(root, ".env");
  fs.writeFileSync(file, [
    `PORT=${port}`, `JWT_SECRET=${jwtSecret}`, `PI_BOOTSTRAP_SECRET=${bootstrapSecret}`,
    ...(apiPort ? [`PI_LLM_GATEWAY_PORT=${apiPort}`] : []), "",
  ].join("\n"), { mode: 0o600 });
  return file;
}

test("Pi model launcher verifies both authenticated gateway identity and model API", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilink-agent-verification-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = createConfig(root, 3200);
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push(url);
    if (url.includes("/health?challenge=")) {
      const challenge = new URL(url).searchParams.get("challenge");
      const proof = crypto.createHmac("sha256", bootstrapSecret)
        .update(["pilink-health-v1", challenge, "2.2.0", "3200"].join("\0")).digest("base64url");
      return Response.json({ auth_scheme: "pilink-health-hmac-v1", challenge, version: "2.2.0", proof });
    }
    assert.equal(options.headers.authorization, `Bearer ${deriveGatewayApiKey(jwtSecret)}`);
    return Response.json({ data: [{ id: "pilink" }] });
  };
  const result = await verifyLocalGateway(config, fetcher);
  assert.equal(result.baseUrl, "http://127.0.0.1:3210/v1");
  assert.equal(seen.length, 2);
  assert.match(seen[0], /^http:\/\/127\.0\.0\.1:3200\/health\?challenge=/u);
  assert.equal(seen[1], "http://127.0.0.1:3210/v1/models");
  await assert.rejects(verifyLocalGateway(config, async () => Response.json({
    auth_scheme: "pilink-health-hmac-v1", challenge: "wrong", version: "2.2.0", proof: "wrong",
  })), /identity check failed/u);
});

test("PiLink model registration preserves other providers, uses an env key, and updates its port", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilink-pi-model-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, ".pi", "agent");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "models.json");
  fs.writeFileSync(file, JSON.stringify({ providers: { other: { baseUrl: "https://example.org/v1", models: [] } } }));
  ensurePiGatewayModel("http://127.0.0.1:3210/v1", directory, home);
  let store = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(store.providers.other.baseUrl, "https://example.org/v1");
  assert.equal(store.providers.pilink.apiKey, "${PILINK_GATEWAY_API_KEY}");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  ensurePiGatewayModel("http://127.0.0.1:3211/v1", directory, home);
  store = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(store.providers.pilink.baseUrl, "http://127.0.0.1:3211/v1");
  store.providers.pilink.baseUrl = "https://someone-else.example/v1";
  fs.writeFileSync(file, JSON.stringify(store));
  assert.throws(() => ensurePiGatewayModel("http://127.0.0.1:3210/v1", directory, home), /unrelated Pi/u);
});

test("pilink-cli starts Pi Agent with the PiLink model from the caller's folder", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilink-cli-folder-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const workspace = path.join(home, "work");
  const bin = path.join(home, "bin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(bin);
  let mcpPort = 0;
  const mcp = http.createServer((request, response) => {
    const challenge = new URL(request.url, `http://127.0.0.1:${mcpPort}`).searchParams.get("challenge");
    const proof = crypto.createHmac("sha256", bootstrapSecret)
      .update(["pilink-health-v1", challenge, "2.2.0", String(mcpPort)].join("\0")).digest("base64url");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ auth_scheme: "pilink-health-hmac-v1", challenge, version: "2.2.0", proof }));
  });
  let apiPort = 0;
  const api = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${deriveGatewayApiKey(jwtSecret)}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "pilink" }] }));
  });
  mcpPort = await new Promise((resolve) => mcp.listen(0, "127.0.0.1", () => resolve(mcp.address().port)));
  apiPort = await new Promise((resolve) => api.listen(0, "127.0.0.1", () => resolve(api.address().port)));
  t.after(async () => { await Promise.all([new Promise((resolve) => mcp.close(resolve)), new Promise((resolve) => api.close(resolve))]); });
  const config = createConfig(home, mcpPort, apiPort);
  const capture = path.join(home, "launched.json");
  fs.writeFileSync(path.join(bin, "pi"), `#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(process.env.PILINK_TEST_CAPTURE,JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),hasKey:!!process.env.PILINK_GATEWAY_API_KEY}));\n`, { mode: 0o700 });
  const child = spawn(process.execPath, [path.resolve("dist/terminal-launcher-cli.js"), "--no-session"], {
    cwd: workspace, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"), PILINK_CONFIG: config,
      PILINK_TEST_CAPTURE: capture, PATH: bin + path.delimiter + process.env.PATH },
  });
  const output = [];
  child.stderr.on("data", (chunk) => output.push(chunk));
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, Buffer.concat(output).toString());
  const launched = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(launched.cwd, workspace);
  assert.deepEqual(launched.args, ["--provider", "pilink", "--model", "pilink", "--no-session"]);
  assert.equal(launched.hasKey, true);
  const models = JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "models.json"), "utf8"));
  assert.equal(models.providers.pilink.baseUrl, `http://127.0.0.1:${apiPort}/v1`);
});
