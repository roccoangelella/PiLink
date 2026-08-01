import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DirectNetworkError, discoverPublicIpv4, isPublicIpv4, mapPorts } from "../dist/network.js";

const cliPath = path.resolve("dist/cli.js");

test("init creates a private configuration for the current workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-init-"));
  const configPath = path.join(root, ".env");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await runCli(["init"], root, { PILINK_CONFIG: configPath });

  assert.equal(result.code, 0);
  assert.match(result.output, /Created private configuration/);
  const config = await fs.readFile(configPath, "utf8");
  assert.match(config, new RegExp(`PI_WORK_DIR=${escapeRegExp(root)}`));
  assert.match(config, /JWT_SECRET=.{32,}/);
  assert.match(config, /PI_BOOTSTRAP_SECRET=.{32,}/);
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
});

test("serve starts the local server without a tunnel", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-serve-"));
  const configPath = path.join(root, ".env");
  const port = await availablePort();
  await writeConfig(configPath, root, port);
  const cliProcess = spawnCli(["serve"], root, { PILINK_CONFIG: configPath });
  t.after(async () => {
    cliProcess.kill("SIGINT");
    await fs.rm(root, { recursive: true, force: true });
  });

  let output = "";
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  await waitFor(() => output.includes("PiLink Server"));
  const health = await fetch(`http://127.0.0.1:${port}/health`);

  assert.equal(health.status, 200);
  const status = await health.json();
  assert.equal(status.status, "ok");
  assert.equal(status.server, "pilink");
});

test("first start guides callback registration and persists a ChatGPT OAuth client", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-cli-"));
  const configPath = path.join(root, ".env");
  const fakeCloudflared = path.join(root, "cloudflared");
  const port = await availablePort();
  await fs.writeFile(configPath, [
    `PI_WORK_DIR=${root}`,
    `PI_DATA_DIR=${path.join(root, "data")}`,
    `PORT=${port}`,
    `JWT_SECRET=${"a".repeat(32)}`,
    `PI_BOOTSTRAP_SECRET=${"b".repeat(32)}`,
  ].join("\n"));
  await fs.writeFile(fakeCloudflared, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\necho https://cli-test.trycloudflare.com\nexec sleep 30\n", { mode: 0o700 });
  const cliProcess = spawnCli(["start"], root, { PILINK_CONFIG: configPath, PI_CLOUDFLARED_PATH: fakeCloudflared });
  t.after(async () => {
    cliProcess.kill("SIGINT");
    await fs.rm(root, { recursive: true, force: true });
  });
  let output = "";
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  await waitFor(() => output.includes("Select hosting [1/2]:"));
  assert.match(output, /Its URL changes every restart, so ChatGPT requires a new connector and OAuth client each session/);
  cliProcess.stdin.write("1\n");
  await waitFor(() => output.includes("Paste callback URL here:"));
  const bannerIndex = output.indexOf("╚══════════════════════════════════════════════════╝");
  const promptIndex = output.indexOf("Paste callback URL here:");
  assert.match(output, /=== Cloudflare Quick Tunnel started ===/);
  assert.match(output, /Use this MCP server URL in ChatGPT: https:\/\/cli-test\.trycloudflare\.com\/sse/);
  assert.ok(bannerIndex !== -1, "Server banner box should be printed");
  assert.ok(promptIndex !== -1, "Paste callback URL prompt should be printed");
  assert.ok(bannerIndex < promptIndex, "Server banner box must be printed before Paste callback URL prompt");
  cliProcess.stdin.write("https://chatgpt.example/callback\n");
  await waitFor(() => output.includes("Client ID: pi_"));
  assert.match(output, /Client ID: pi_[a-f0-9]{16}/);
  assert.match(output, /Client secret: [A-Za-z0-9_-]{40,}/);
  assert.match(output, /Token endpoint auth method: client_secret_post/);
  assert.match(await fs.readFile(configPath, "utf8"), /PI_HOSTING_MODE=quick-tunnel/);
  const store = JSON.parse(await fs.readFile(path.join(root, "data", "clients.json"), "utf8"));
  assert.equal(store.clients.length, 1);
  assert.deepEqual(store.clients[0].redirect_uris, ["https://chatgpt.example/callback"]);
});

test("start --setup resets generated state before the first-time flow", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-setup-"));
  const configPath = path.join(root, ".env");
  const dataPath = path.join(root, "data");
  const fakeCloudflared = path.join(root, "cloudflared");
  const port = await availablePort();
  await writeConfig(configPath, path.join(root, "previous-repository-name"), port, dataPath);
  await fs.mkdir(dataPath);
  await fs.writeFile(path.join(dataPath, "clients.json"), JSON.stringify({ clients: [{ client_id: "existing" }] }));
  await fs.writeFile(fakeCloudflared, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\necho https://cli-test.trycloudflare.com\nexec sleep 30\n", { mode: 0o700 });
  const cliProcess = spawnCli(["start", "--setup"], root, { PILINK_CONFIG: configPath, PI_CLOUDFLARED_PATH: fakeCloudflared, PORT: String(port) });
  t.after(async () => {
    cliProcess.kill("SIGINT");
    await fs.rm(root, { recursive: true, force: true });
  });

  let output = "";
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  await waitFor(() => output.includes("How should PiLink continue? [1/2]:"));
  cliProcess.stdin.write("2\n");
  await waitFor(() => output.includes("Select hosting [1/2]:"));
  cliProcess.stdin.write("1\n");
  await waitFor(() => output.includes("Paste callback URL here:"));
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(output.endsWith("> "), "The callback prompt must remain the final output while input is pending");
  assert.doesNotMatch(output, /\[HTTP\] GET \/health/);
  cliProcess.stdin.write("https://chatgpt.example/renamed-repository-callback\n");
  await waitFor(() => output.includes("ChatGPT OAuth client registered"));
  assert.match(output, /\[HTTP\] GET \/health → 200/);

  const store = JSON.parse(await fs.readFile(path.join(root, "clients.json"), "utf8"));
  assert.equal(store.clients.length, 1);
  assert.deepEqual(store.clients[0].redirect_uris, ["https://chatgpt.example/renamed-repository-callback"]);
  assert.match(await fs.readFile(configPath, "utf8"), new RegExp(`PI_WORK_DIR=${escapeRegExp(root)}`));
});

test("first start configures direct nip.io hosting through Caddy", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-nip-io-"));
  const configPath = path.join(root, ".env");
  const dataPath = path.join(root, "data");
  const fakeCaddy = path.join(root, "tools", "caddy");
  const port = await availablePort();
  const hostname = "pilink-203-0-113-20.nip.io";
  await fs.writeFile(configPath, [
    `PI_WORK_DIR=${root}`,
    `PI_DATA_DIR=${dataPath}`,
    `PORT=${port}`,
    `JWT_SECRET=${"a".repeat(32)}`,
    `PI_BOOTSTRAP_SECRET=${"b".repeat(32)}`,
  ].join("\n"));
  await fs.mkdir(path.dirname(fakeCaddy));
  await fs.writeFile(fakeCaddy, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\n(sleep 1; echo '{\"msg\":\"certificate obtained successfully\"}' >&2) &\nexec sleep 30\n", { mode: 0o700 });
  const cliProcess = spawnCli(["start", "--setup"], root, { PILINK_CONFIG: configPath, PI_CADDY_PATH: fakeCaddy, PI_PUBLIC_IPV4: "203.0.113.20", PORT: String(port) });
  t.after(async () => {
    cliProcess.kill("SIGINT");
    await fs.rm(root, { recursive: true, force: true });
  });

  let output = "";
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  await waitFor(() => output.includes("How should PiLink continue? [1/2]:"));
  cliProcess.stdin.write("2\n");
  await waitFor(() => output.includes("Select hosting [1/2]:"));
  cliProcess.stdin.write("2\n");
  await waitFor(() => output.includes("Allow PiLink to request these temporary router mappings? [Y/n]:"));
  cliProcess.stdin.write("n\n");
  await waitFor(() => output.includes("Type DIRECT after completing the router configuration:"));
  cliProcess.stdin.write("DIRECT\n");
  await waitFor(() => output.includes("Detecting the public IPv4 address..."));
  await waitFor(() => output.includes("Paste callback URL here:"));
  assert.ok(output.indexOf("certificate obtained successfully") < output.indexOf("Paste callback URL here:"), "OAuth setup must wait for Caddy's certificate");
  assert.match(output, /forward public TCP port 80 to this computer's TCP port 8080/);
  assert.match(output, /=== Direct nip\.io hosting started ===/);
  assert.match(output, /Wait for Caddy to report that it obtained a public TLS certificate before connecting ChatGPT/);
  assert.match(output, new RegExp(`persistent public address is: https://${escapeRegExp(hostname)}`));
  const caddyfile = await fs.readFile(path.join(root, "Caddyfile"), "utf8");
  assert.match(caddyfile, new RegExp(`https://${escapeRegExp(hostname)} \\{`));
  assert.match(caddyfile, new RegExp(`reverse_proxy 127\\.0\\.0\\.1:${port}`));
  assert.match(caddyfile, /http_port 8080/);
  assert.match(caddyfile, /https_port 8443/);
  assert.match(await fs.readFile(configPath, "utf8"), /PI_HOSTING_MODE=nip-io/);
  assert.match(await fs.readFile(configPath, "utf8"), new RegExp(`PI_NIP_IO_HOSTNAME=${escapeRegExp(hostname)}`));
  cliProcess.stdin.write("https://chatgpt.example/nip-io-callback\n");
  await waitFor(() => output.includes("ChatGPT OAuth client registered"));
});

test("start reports an occupied local port without starting OAuth setup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-port-conflict-"));
  const configPath = path.join(root, ".env");
  const fakeCaddy = path.join(root, "caddy");
  const port = await availablePort();
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(port, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => occupied.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(configPath, [
    `PI_WORK_DIR=${root}`,
    `PI_DATA_DIR=${path.join(root, "data")}`,
    `PORT=${port}`,
    `JWT_SECRET=${"a".repeat(32)}`,
    `PI_BOOTSTRAP_SECRET=${"b".repeat(32)}`,
    "PI_HOSTING_MODE=nip-io",
    "PI_NIP_IO_NETWORK=manual",
    "PI_NIP_IO_HOSTNAME=pilink-203-0-113-20.nip.io",
  ].join("\n"));
  await fs.writeFile(fakeCaddy, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\nexec sleep 30\n", { mode: 0o700 });

  const result = await runCli(["start"], root, { PILINK_CONFIG: configPath, PI_CADDY_PATH: fakeCaddy });

  assert.equal(result.code, 1);
  assert.match(result.output, new RegExp(`PiLink could not listen on 127\\.0\\.0\\.1:${port}: the address is already in use`));
  assert.doesNotMatch(result.output, /Paste callback URL here:/);
});

test("automatic router mappings target only PiLink's HTTPS ports and are released", async () => {
  const mapped = [];
  let stops = 0;
  const gateway = {
    host: "192.168.1.1",
    async map(internalPort, internalHost, options) {
      mapped.push({ internalPort, internalHost, options });
      return { internalPort, internalHost, externalPort: options.externalPort, externalHost: "198.51.100.4", protocol: "TCP" };
    },
    async externalIp() { return "8.8.8.8"; },
    async stop() { stops += 1; },
  };

  const mappings = await mapPorts(gateway, "192.168.1.20");

  assert.equal(mappings.publicIp, "8.8.8.8");
  assert.deepEqual(mapped, [
    { internalPort: 8080, internalHost: "192.168.1.20", options: { externalPort: 80, protocol: "TCP", ttl: 3_600_000, autoRefresh: true, description: "PiLink direct HTTPS" } },
    { internalPort: 8443, internalHost: "192.168.1.20", options: { externalPort: 443, protocol: "TCP", ttl: 3_600_000, autoRefresh: true, description: "PiLink direct HTTPS" } },
  ]);
  await mappings.release();
  await mappings.release();
  assert.equal(stops, 1);
});

test("public IPv4 detection falls back to another service", async () => {
  const requested = [];
  const publicIp = await discoverPublicIpv4(async (url) => {
    requested.push(url);
    return requested.length === 1 ? new Response("not an IP") : new Response("203.0.113.10\n");
  });

  assert.equal(publicIp, "203.0.113.10");
  assert.equal(requested.length, 2);
});

test("automatic router mappings reject CGNAT addresses and release partial mappings", async () => {
  let stops = 0;
  const gateway = {
    host: "192.168.1.1",
    async map(internalPort) { return { externalPort: internalPort === 8080 ? 80 : 443 }; },
    async externalIp() { return "100.64.1.2"; },
    async stop() { stops += 1; },
  };

  await assert.rejects(
    mapPorts(gateway, "192.168.1.20"),
    (error) => error instanceof DirectNetworkError && !error.canUseManualFallback,
  );
  assert.equal(stops, 1);
  assert.equal(isPublicIpv4("8.8.8.8"), true);
  assert.equal(isPublicIpv4("100.64.1.2"), false);
});

test("automatic router mappings reject substituted public ports", async () => {
  let stops = 0;
  const gateway = {
    host: "192.168.1.1",
    async map(internalPort) {
      return { externalPort: internalPort === 8080 ? 8081 : 443 };
    },
    async externalIp() { return "8.8.8.8"; },
    async stop() { stops += 1; },
  };

  await assert.rejects(
    mapPorts(gateway, "192.168.1.20"),
    (error) => error instanceof DirectNetworkError && error.canUseManualFallback,
  );
  assert.equal(stops, 1);
});

test("automatic router mappings pass cancellation to router operations", async () => {
  const signals = [];
  const gateway = {
    host: "192.168.1.1",
    async map(internalPort, _internalHost, options) {
      signals.push(options.signal);
      return { externalPort: internalPort === 8080 ? 80 : 443 };
    },
    async externalIp(options) {
      signals.push(options.signal);
      return "8.8.8.8";
    },
    async stop() {},
  };
  const controller = new AbortController();

  const mappings = await mapPorts(gateway, "192.168.1.20", controller.signal);

  assert.deepEqual(signals, [controller.signal, controller.signal, controller.signal]);
  await mappings.release();
});

test("reset --yes removes generated files without removing unrelated data", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-reset-"));
  const configPath = path.join(root, ".env");
  const dataPath = path.join(root, "data");
  await writeConfig(configPath, root, await availablePort(), dataPath);
  await fs.mkdir(path.join(root, "bin"));
  await fs.mkdir(dataPath);
  await fs.writeFile(path.join(dataPath, "clients.json"), "{}");
  await fs.writeFile(path.join(dataPath, "clients.json.lock"), "stale lock");
  await fs.writeFile(path.join(dataPath, "revoked-tokens.json"), "{}");
  await fs.writeFile(path.join(dataPath, "oauth-client-audit.jsonl"), "{}\n");
  await fs.writeFile(path.join(dataPath, "keep.txt"), "unrelated data");
  await fs.writeFile(path.join(root, "bin", "cloudflared"), "managed binary");
  await fs.writeFile(path.join(root, "bin", "caddy"), "managed binary");
  await fs.writeFile(path.join(root, "bin", "keep.txt"), "unrelated binary");
  await fs.mkdir(path.join(root, "caddy"));
  await fs.writeFile(path.join(root, "Caddyfile"), "managed configuration");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await runCli(["reset", "--yes"], root, { PILINK_CONFIG: configPath });

  assert.equal(result.code, 0);
  assert.match(result.output, /PiLink state was reset/);
  await assert.rejects(fs.stat(configPath));
  await assert.rejects(fs.stat(path.join(dataPath, "clients.json")));
  await assert.rejects(fs.stat(path.join(dataPath, "clients.json.lock")));
  await assert.rejects(fs.stat(path.join(dataPath, "revoked-tokens.json")));
  await assert.rejects(fs.stat(path.join(dataPath, "oauth-client-audit.jsonl")));
  await assert.rejects(fs.stat(path.join(root, "bin", "cloudflared")));
  await assert.rejects(fs.stat(path.join(root, "bin", "caddy")));
  await assert.rejects(fs.stat(path.join(root, "Caddyfile")));
  await assert.rejects(fs.stat(path.join(root, "caddy")));
  assert.equal(await fs.readFile(path.join(dataPath, "keep.txt"), "utf8"), "unrelated data");
  assert.equal(await fs.readFile(path.join(root, "bin", "keep.txt"), "utf8"), "unrelated binary");
});

test("reset --yes does not delete the workspace when configuration is stored in it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-reset-workspace-"));
  const configPath = path.join(root, ".env");
  await fs.writeFile(configPath, [
    `PI_WORK_DIR=${root}`,
    `PORT=${await availablePort()}`,
    `JWT_SECRET=${"a".repeat(32)}`,
    `PI_BOOTSTRAP_SECRET=${"b".repeat(32)}`,
    "PI_HOSTING_MODE=quick-tunnel",
  ].join("\n"));
  await fs.writeFile(path.join(root, "clients.json"), "{}");
  await fs.writeFile(path.join(root, "repository-file.txt"), "must remain");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = await runCli(["reset", "--yes"], root, { PILINK_CONFIG: configPath });

  assert.equal(result.code, 0);
  await assert.rejects(fs.stat(configPath));
  await assert.rejects(fs.stat(path.join(root, "clients.json")));
  assert.equal(await fs.readFile(path.join(root, "repository-file.txt"), "utf8"), "must remain");
});

function spawnCli(args, cwd, overrides) {
  return spawn(process.execPath, [cliPath, ...args], {
    cwd,
    env: cliEnvironment(overrides),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function runCli(args, cwd, overrides) {
  const cliProcess = spawnCli(args, cwd, overrides);
  let output = "";
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(cliProcess, "exit");
  return { code, output };
}

function cliEnvironment(overrides) {
  const env = { ...process.env };
  for (const name of ["PI_WORK_DIR", "PI_DATA_DIR", "PORT", "JWT_SECRET", "PI_BOOTSTRAP_SECRET", "SERVER_URL", "PILINK_CONFIG", "PI_HOSTING_MODE", "PI_NIP_IO_HOSTNAME", "PI_NIP_IO_NETWORK", "PI_PUBLIC_IPV4", "PI_CADDY_PATH", "PI_CLOUDFLARED_PATH", "PI_CLOUDFLARED_URL", "PI_CADDY_URL"]) {
    delete env[name];
  }
  return { ...env, ...overrides };
}

test("first start downloads cloudflared from PI_CLOUDFLARED_URL when not preinstalled", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-dl-test-"));
  const configPath = path.join(root, ".env");
  const port = await availablePort();
  await writeConfig(configPath, root, port);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\necho https://cli-test.trycloudflare.com\nexec sleep 30\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverPort = server.address().port;
  t.after(async () => {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const cliProcess = spawnCli(["start", "--setup"], root, {
    PILINK_CONFIG: configPath,
    PI_CLOUDFLARED_URL: `http://127.0.0.1:${serverPort}/cloudflared`,
    PORT: String(port),
  });

  let output = "";
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });

  await waitFor(() => output.includes("How should PiLink continue? [1/2]:"));
  cliProcess.stdin.write("2\n");
  await waitFor(() => output.includes("Select hosting [1/2]:"));
  cliProcess.stdin.write("1\n");
  await waitFor(() => output.includes("cloudflared is not installed; downloading"));
  const downloadedPath = path.join(root, "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  await waitFor(async () => {
    try {
      const s = await fs.stat(downloadedPath);
      return s.size > 0;
    } catch {
      return false;
    }
  });
  cliProcess.kill("SIGTERM");
  await once(cliProcess, "exit");

  const stat = await fs.stat(downloadedPath);
  assert.ok(stat.size > 0);
});

test("start --setup rejects an invalid setup choice without deleting the existing instance", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-setup-invalid-"));
  const configPath = path.join(root, ".env");
  const dataPath = path.join(root, "data");
  const port = await availablePort();
  await writeConfig(configPath, root, port, dataPath);
  await fs.mkdir(dataPath);
  await fs.writeFile(path.join(dataPath, "clients.json"), JSON.stringify({ clients: [{ client_id: "original-client" }] }));

  const cliProcess = spawnCli(["start", "--setup"], root, { PILINK_CONFIG: configPath });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let output = "";
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  await waitFor(() => output.includes("How should PiLink continue? [1/2]:"));
  cliProcess.stdin.write("unexpected\n");
  const [code] = await once(cliProcess, "exit");

  assert.notEqual(code, 0);
  assert.match(output, /Setup cancelled: choose 1 for a separate instance or 2 to overwrite/);
  assert.match(await fs.readFile(configPath, "utf8"), new RegExp(`PORT=${port}`));
  const originalStore = JSON.parse(await fs.readFile(path.join(dataPath, "clients.json"), "utf8"));
  assert.equal(originalStore.clients[0].client_id, "original-client");
});

test("start --setup option 1 creates a separate instance without deleting existing config", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-setup-sep-"));
  const configPath = path.join(root, ".env");
  const newConfigDirectory = path.join(root, "instance2");
  const newConfigPath = path.join(newConfigDirectory, ".env");
  const dataPath = path.join(root, "data");
  const fakeCloudflared = path.join(root, "cloudflared");
  const port = await availablePort();
  const newPort = port + 10;
  await writeConfig(configPath, path.join(root, "original-repo"), port, dataPath);
  await fs.mkdir(dataPath);
  await fs.writeFile(path.join(dataPath, "clients.json"), JSON.stringify({ clients: [{ client_id: "original-client" }] }));
  await fs.writeFile(fakeCloudflared, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\necho https://cli-test.trycloudflare.com\nexec sleep 30\n", { mode: 0o700 });

  const cliProcess = spawnCli(["start", "--setup"], root, { PILINK_CONFIG: configPath, PI_CLOUDFLARED_PATH: fakeCloudflared, PORT: String(port) });
  t.after(async () => {
    cliProcess.kill("SIGINT");
    await fs.rm(root, { recursive: true, force: true });
  });

  let output = "";
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });

  await waitFor(() => output.includes("How should PiLink continue? [1/2]:"));
  cliProcess.stdin.write("1\n");
  await waitFor(() => output.includes("Enter new configuration directory"));
  cliProcess.stdin.write(`${newConfigDirectory}\n`);
  await waitFor(() => output.includes("Enter new server port"));
  cliProcess.stdin.write(`${newPort}\n`);
  await waitFor(() => output.includes("Select hosting [1/2]:"));
  cliProcess.stdin.write("1\n");
  await waitFor(() => output.includes("Paste callback URL here:"));
  const health = await fetch(`http://127.0.0.1:${newPort}/health`);
  assert.equal(health.status, 200);
  cliProcess.stdin.write("https://chatgpt.example/sep-callback\n");
  await waitFor(() => output.includes("ChatGPT OAuth client registered"));

  const originalStore = JSON.parse(await fs.readFile(path.join(dataPath, "clients.json"), "utf8"));
  assert.equal(originalStore.clients[0].client_id, "original-client");

  const newConfigContent = await fs.readFile(newConfigPath, "utf8");
  assert.match(newConfigContent, new RegExp(`PORT=${newPort}`));
});

async function writeConfig(configPath, workspace, port, dataPath = path.join(path.dirname(configPath), "data")) {
  await fs.writeFile(configPath, [
    `PI_WORK_DIR=${workspace}`,
    `PI_DATA_DIR=${dataPath}`,
    `PORT=${port}`,
    `JWT_SECRET=${"a".repeat(32)}`,
    `PI_BOOTSTRAP_SECRET=${"b".repeat(32)}`,
    "PI_HOSTING_MODE=quick-tunnel",
  ].join("\n"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for CLI output");
}
