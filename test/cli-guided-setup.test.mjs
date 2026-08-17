import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
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

test("serve --mode single persists the classic runtime mode and reports it in health", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-serve-single-"));
  const configPath = path.join(root, ".env");
  const port = await availablePort();
  await writeConfig(configPath, root, port);
  const cliProcess = spawnCli(["serve", "--mode", "single"], root, { PILINK_CONFIG: configPath });
  t.after(async () => {
    cliProcess.kill("SIGINT");
    await fs.rm(root, { recursive: true, force: true });
  });

  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  });
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.runtime_mode, "single");
  assert.match(await fs.readFile(configPath, "utf8"), /^PI_RUNTIME_MODE=single$/m);
});

test("launch mode flags reject invalid and incompatible choices clearly", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-mode-errors-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const invalid = await runCli(["start", "--mode", "unsupported"], root, {});
  assert.equal(invalid.code, 1);
  assert.match(invalid.output, /Unknown launch mode 'unsupported'/);

  const incompatible = await runCli(["serve", "--mode", "vscode"], root, {});
  assert.equal(incompatible.code, 1);
  assert.match(incompatible.output, /VS Code graphical experience is launched with 'pilink start --mode vscode'/);
});

test("serve honors the VS Code IPC shutdown bridge", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-ipc-stop-"));
  const configPath = path.join(root, ".env");
  const port = await availablePort();
  await writeConfig(configPath, root, port);
  const cliProcess = spawn(process.execPath, [cliPath, "serve"], {
    cwd: root,
    env: cliEnvironment({ PILINK_CONFIG: configPath }),
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  t.after(async () => {
    if (cliProcess.exitCode === null) cliProcess.kill("SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
  });

  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  });
  cliProcess.send({ type: "vspilink.shutdown" });
  let shutdownTimeout;
  const [code] = await Promise.race([
    once(cliProcess, "exit"),
    new Promise((_, reject) => {
      shutdownTimeout = setTimeout(() => reject(new Error("IPC shutdown timed out")), 5_000);
    }),
  ]);
  clearTimeout(shutdownTimeout);
  assert.equal(code, 0);
  await waitFor(async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      return false;
    } catch {
      return true;
    }
  });
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
  await waitFor(() => output.includes("Select hosting [1/2/3]:"));
  assert.match(output, /Its URL changes every restart, so ChatGPT requires a new connector and OAuth client each session/);
  cliProcess.stdin.write("1\n");
  await waitFor(() => output.includes("Paste callback URL here:")).catch((error) => {
    throw new Error(`${error.message}\nCLI output:\n${output}`);
  });
  const bannerIndex = output.indexOf("╚══════════════════════════════════════════════════╝");
  const promptIndex = output.indexOf("Paste callback URL here:");
  assert.match(output, /=== Cloudflare Quick Tunnel started ===/);
  assert.match(output, /Use this MCP server URL in ChatGPT: https:\/\/cli-test\.trycloudflare\.com\/sse/);
  assert.match(output, /Settings → Apps\/Connectors \(or your MCP connections page\) → Add connection/);
  assert.match(output, /Set the connection\/MCP server URL to: https:\/\/cli-test\.trycloudflare\.com\/sse/);
  assert.doesNotMatch(output, /Developer mode|Workspace settings|Enterprise|Business|Edu|Apps → Create/i);
  assert.ok(bannerIndex !== -1, "Server banner box should be printed");
  assert.ok(promptIndex !== -1, "Paste callback URL prompt should be printed");
  assert.ok(bannerIndex < promptIndex, "Server banner box must be printed before Paste callback URL prompt");
  cliProcess.stdin.write("https://chatgpt.example/callback\n");
  await waitFor(() => output.includes("Scope: mcp:tools"));
  assert.match(output, /Client ID: pi_[a-f0-9]{16}/);
  assert.match(output, /Client secret: [A-Za-z0-9_-]{40,}/);
  assert.match(output, /Token endpoint auth method: client_secret_post/);
  assert.doesNotMatch(output, /owner pairing page/i, "browser consent mode must preserve the legacy flow without pairing");
  assert.match(await fs.readFile(configPath, "utf8"), /PI_HOSTING_MODE=quick-tunnel/);
  const store = JSON.parse(await fs.readFile(path.join(root, "data", "clients.json"), "utf8"));
  assert.equal(store.clients.length, 1);
  assert.deepEqual(store.clients[0].redirect_uris, ["https://chatgpt.example/callback"]);
});

for (const mode of ["single", "collaboration"]) {
  test(`Cloudflare fixed-domain hosting keeps one SSE URL in ${mode} mode`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `pilink-fixed-${mode}-`));
    const configPath = path.join(root, ".env");
    const tokenFile = path.join(root, "tunnel-token");
    const argsLog = path.join(root, "cloudflared-args.txt");
    const fakeCloudflared = path.join(root, "cloudflared");
    const port = await availablePort();
    const tunnelId = "11111111-2222-4333-8444-555555555555";
    const hostname = `mcp-${mode}.example.test`;
    await fs.writeFile(configPath, [
      `PI_WORK_DIR=${root}`,
      `PI_DATA_DIR=${path.join(root, "data")}`,
      `PORT=${port}`,
      `JWT_SECRET=${"a".repeat(32)}`,
      `PI_BOOTSTRAP_SECRET=${"b".repeat(32)}`,
      "PI_HOSTING_MODE=cloudflare-fixed",
      `SERVER_URL=https://${hostname}`,
      `PI_CLOUDFLARE_TUNNEL_ID=${tunnelId}`,
      `PI_CLOUDFLARE_TOKEN_FILE=${tokenFile}`,
      "TRUST_PROXY=true",
    ].join("\n"));
    await fs.writeFile(tokenFile, "test-tunnel-token-value\n", { mode: 0o600 });
    if (process.platform !== "win32") await fs.chmod(tokenFile, 0o600);
    await fs.writeFile(
      fakeCloudflared,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nprintf "%s\\n" "$*" > "$PI_CLOUDFLARED_ARGS_LOG"\nexec sleep 30\n',
      { mode: 0o700 },
    );
    const cliProcess = spawnCli(["start", "--mode", mode], root, {
      PILINK_CONFIG: configPath,
      PI_CLOUDFLARED_PATH: fakeCloudflared,
      PI_CLOUDFLARED_ARGS_LOG: argsLog,
    });
    t.after(async () => {
      cliProcess.kill("SIGINT");
      await fs.rm(root, { recursive: true, force: true });
    });
    let output = "";
    cliProcess.stdout.on("data", (chunk) => { output += chunk; });
    cliProcess.stderr.on("data", (chunk) => { output += chunk; });

    await waitFor(() => output.includes("Paste callback URL here:"));
    cliProcess.stdin.write("\n");
    await waitFor(() => output.includes("ChatGPT client registration skipped"));

    assert.doesNotMatch(output, /Select hosting \[1\/2\/3\]:/);
    assert.match(output, new RegExp(`Use this MCP server URL in ChatGPT: https://${hostname.replaceAll(".", "\\.")}\\/sse`));
    assert.match(output, /existing ChatGPT connector and OAuth client can be reused/);
    const config = await fs.readFile(configPath, "utf8");
    assert.match(config, /^PI_HOSTING_MODE=cloudflare-fixed$/m);
    assert.match(config, new RegExp(`^PI_RUNTIME_MODE=${mode}$`, "m"));
    assert.match(config, new RegExp(`^SERVER_URL=https://${hostname.replaceAll(".", "\\.")}$`, "m"));
    assert.match(config, new RegExp(`^PI_CLOUDFLARE_TUNNEL_ID=${tunnelId}$`, "m"));
    assert.match(config, new RegExp(`^PI_CLOUDFLARE_TOKEN_FILE=${escapeRegExp(tokenFile)}$`, "m"));
    const args = await fs.readFile(argsLog, "utf8");
    assert.match(args, new RegExp(`run --token-file ${escapeRegExp(tokenFile)} ${tunnelId}`));
    assert.doesNotMatch(args, /test-tunnel-token-value/);
  });
}

test("paired CLI setup uses secretless DCR plus a local verification code", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-cli-paired-"));
  const configPath = path.join(root, ".env");
  const fakeCloudflared = path.join(root, "cloudflared");
  const fakeBin = path.join(root, "bin");
  const browserLog = path.join(root, "browser-url.txt");
  const port = await availablePort();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(fakeBin);
  await fs.writeFile(configPath, [
    `PI_WORK_DIR=${root}`,
    `PI_DATA_DIR=${path.join(root, "data")}`,
    `PORT=${port}`,
    `JWT_SECRET=${"a".repeat(32)}`,
    `PI_BOOTSTRAP_SECRET=${"b".repeat(32)}`,
    "PI_OAUTH_CONSENT_MODE=paired",
  ].join("\n"));
  await fs.writeFile(fakeCloudflared, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\necho https://cli-test.trycloudflare.com\nexec sleep 30\n", { mode: 0o700 });
  await fs.writeFile(
    path.join(fakeBin, "xdg-open"),
    "#!/bin/sh\nprintf '%s\\n' \"$1\" > \"$PI_BROWSER_LOG\"\n",
    { mode: 0o700 },
  );
  const cliProcess = spawnCli(["start"], root, {
    PILINK_CONFIG: configPath,
    PI_CLOUDFLARED_PATH: fakeCloudflared,
    PI_BROWSER_LOG: browserLog,
    PI_BROWSER_OPEN: "always",
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
  });
  t.after(() => cliProcess.kill("SIGINT"));
  let output = "";
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });

  await waitFor(() => output.includes("Select hosting [1/2/3]:"));
  cliProcess.stdin.write("1\n");
  await waitFor(() => output.includes("Local verification code:"));
  assert.match(output, /First-time ChatGPT setup \(safe DCR\)/);
  assert.match(output, /Dynamic Client Registration \(DCR\)/);
  assert.doesNotMatch(output, /Paste callback URL here:|Client secret:/);

  const verificationCode = output.match(/Local verification code: ([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})/u)?.[1];
  assert.ok(verificationCode);
  const pairingUrl = (await fs.readFile(browserLog, "utf8")).trim();
  const parsedPairing = new URL(pairingUrl);
  assert.equal(parsedPairing.origin, "https://cli-test.trycloudflare.com");
  assert.equal(parsedPairing.pathname, "/oauth/pair");
  assert.match(parsedPairing.searchParams.get("code") || "", /^[A-Za-z0-9_-]{20,512}$/);

  const pairingPrompt = await localRequest(port, `${parsedPairing.pathname}${parsedPairing.search}`, {
    Host: parsedPairing.host,
  });
  assert.equal(pairingPrompt.status, 200);
  assert.equal(pairingPrompt.headers["set-cookie"], undefined, "the public pairing link alone must not authenticate the browser");
  assert.match(pairingPrompt.body, /verification code shown by PiLink in the local terminal/i);

  const paired = await localRequest(port, "/oauth/pair", {
    Host: parsedPairing.host,
    "Content-Type": "application/x-www-form-urlencoded",
  }, {
    method: "POST",
    body: new URLSearchParams({
      code: parsedPairing.searchParams.get("code") || "",
      verification_code: verificationCode,
    }).toString(),
  });
  assert.equal(paired.status, 200);
  const ownerCookie = String(paired.headers["set-cookie"] || "").split(";")[0];
  assert.match(ownerCookie, /^__Host-vspilink_owner=/);

  const redirectUri = "https://chatgpt.com/connector/oauth/CliPaired_123";
  const registration = await localRequest(port, "/oauth/register", {
    Host: parsedPairing.host,
    "Content-Type": "application/json",
  }, {
    method: "POST",
    body: JSON.stringify({
      client_name: "ChatGPT",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      scope: "mcp:tools offline_access",
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201);
  const registeredClient = JSON.parse(registration.body);
  assert.equal(registeredClient.token_endpoint_auth_method, "none");
  assert.equal("client_secret" in registeredClient, false);

  const store = JSON.parse(await fs.readFile(path.join(root, "data", "clients.json"), "utf8"));
  assert.equal(store.clients.length, 1);
  assert.equal(store.clients[0].client_id, registeredClient.client_id);
  const verifier = "v".repeat(64);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URL("/oauth/authorize", `http://127.0.0.1:${port}`);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", registeredClient.client_id);
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("scope", "mcp:tools offline_access");
  authorization.searchParams.set("state", "paired-cli-test");
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  const consent = await localRequest(port, `${authorization.pathname}${authorization.search}`, {
    Host: parsedPairing.host,
    Cookie: ownerCookie,
  });
  assert.equal(consent.status, 200);
  assert.match(consent.body, /Authorization Request/);
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
  await waitFor(() => output.includes("Select hosting [1/2/3]:"));
  cliProcess.stdin.write("1\n");
  await waitFor(() => output.includes("Local verification code:"));
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  await waitFor(() => output.includes("[HTTP] GET /health → 200"));
  assert.match(output, /First-time ChatGPT setup \(safe DCR\)/);
  assert.match(output, /Automatic browser opening is disabled for this non-interactive session/);
  assert.doesNotMatch(output, /Paste callback URL here:|Client secret:/);

  await assert.rejects(fs.stat(path.join(root, "clients.json")), { code: "ENOENT" });
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
  await waitFor(() => output.includes("Select hosting [1/2/3]:"));
  cliProcess.stdin.write("2\n");
  await waitFor(() => output.includes("Allow PiLink to request these temporary router mappings? [Y/n]:"));
  cliProcess.stdin.write("n\n");
  await waitFor(() => output.includes("Type DIRECT after completing the router configuration:"));
  cliProcess.stdin.write("DIRECT\n");
  await waitFor(() => output.includes("Detecting the public IPv4 address..."));
  await waitFor(() => output.includes("Local verification code:"));
  assert.ok(output.indexOf("certificate obtained successfully") < output.indexOf("First-time ChatGPT setup (safe DCR)"), "OAuth setup must wait for Caddy's certificate");
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
  assert.match(output, /Local verification code: [A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/u);
  assert.doesNotMatch(output, /Paste callback URL here:|Client secret:/);
});

test("a clean direct-hosting setup installs and extracts a checksum-verified Caddy archive", {
  skip: process.platform !== "linux",
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-caddy-download-"));
  const payloadDirectory = path.join(root, "payload");
  const toolsDirectory = path.join(root, "tools");
  const archivePath = path.join(root, "caddy.tar.gz");
  const configPath = path.join(root, ".env");
  const port = await availablePort();
  await fs.mkdir(payloadDirectory);
  await fs.mkdir(toolsDirectory);
  await fs.writeFile(path.join(payloadDirectory, "caddy"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\n(sleep 1; echo '{\"msg\":\"certificate obtained successfully\"}' >&2) &\nexec /bin/sleep 30\n", { mode: 0o700 });
  const packed = spawnSync("tar", ["-czf", archivePath, "-C", payloadDirectory, "caddy"]);
  assert.equal(packed.status, 0);
  await fs.symlink("/usr/bin/tar", path.join(toolsDirectory, "tar"));
  await fs.symlink("/usr/bin/gzip", path.join(toolsDirectory, "gzip"));
  const archive = await fs.readFile(archivePath);
  const archiveSha256 = crypto.createHash("sha256").update(archive).digest("hex");
  await fs.writeFile(configPath, [
    `PI_WORK_DIR=${root}`,
    `PI_DATA_DIR=${path.join(root, "data")}`,
    `PORT=${port}`,
    `JWT_SECRET=${"a".repeat(32)}`,
    `PI_BOOTSTRAP_SECRET=${"b".repeat(32)}`,
  ].join("\n"));

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/gzip" });
    res.end(archive);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverPort = server.address().port;
  const cliProcess = spawnCli(["start", "--setup"], root, {
    PILINK_CONFIG: configPath,
    PI_CADDY_URL: `http://127.0.0.1:${serverPort}/caddy.tar.gz`,
    PI_CADDY_SHA256: archiveSha256,
    PI_PUBLIC_IPV4: "203.0.113.20",
    PORT: String(port),
    PATH: toolsDirectory,
  });
  t.after(async () => {
    if (cliProcess.exitCode === null) cliProcess.kill("SIGINT");
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  let output = "";
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  await waitFor(() => output.includes("How should PiLink continue? [1/2]:"));
  cliProcess.stdin.write("2\n");
  await waitFor(() => output.includes("Select hosting [1/2/3]:"));
  cliProcess.stdin.write("2\n");
  await waitFor(() => output.includes("Allow PiLink to request these temporary router mappings? [Y/n]:"));
  cliProcess.stdin.write("n\n");
  await waitFor(() => output.includes("Type DIRECT after completing the router configuration:"));
  cliProcess.stdin.write("DIRECT\n");
  await waitFor(() => output.includes("Local verification code:")).catch((error) => {
    throw new Error(`${error.message}\nCLI output:\n${output}`);
  });

  assert.match(output, /downloading verified Caddy 2\.11\.4/);
  const installed = path.join(root, "bin", "caddy");
  assert.equal((await fs.stat(installed)).isFile(), true);
  assert.equal((await fs.stat(installed)).mode & 0o777, 0o700);
  assert.match(output, /Local verification code: [A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/u);
  assert.doesNotMatch(output, /Paste callback URL here:|Client secret:/);
  cliProcess.kill("SIGINT");
  await once(cliProcess, "exit");
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
  for (const name of Object.keys(env)) {
    if (name.startsWith("PI_") || name.startsWith("PILINK_") || name === "SERVER_URL") delete env[name];
  }
  return { ...env, PI_BROWSER_OPEN: "never", ...overrides };
}

test("first start downloads cloudflared from PI_CLOUDFLARED_URL when not preinstalled", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-dl-test-"));
  const configPath = path.join(root, ".env");
  const emptyPath = path.join(root, "empty-path");
  await fs.mkdir(emptyPath);
  const port = await availablePort();
  await writeConfig(configPath, root, port);

  const fakeCloudflaredBody = "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\necho https://cli-test.trycloudflare.com\nexec /bin/sleep 30\n";
  const fakeCloudflaredSha256 = crypto.createHash("sha256").update(fakeCloudflaredBody).digest("hex");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(fakeCloudflaredBody);
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
    PI_CLOUDFLARED_SHA256: fakeCloudflaredSha256,
    PORT: String(port),
    PATH: emptyPath,
  });

  let output = "";
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });

  await waitFor(() => output.includes("How should PiLink continue? [1/2]:"));
  cliProcess.stdin.write("2\n");
  await waitFor(() => output.includes("Select hosting [1/2/3]:"));
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

test("a custom cloudflared download URL is rejected without its SHA-256 digest", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-dl-no-hash-"));
  const configPath = path.join(root, ".env");
  const emptyPath = path.join(root, "empty-path");
  await fs.mkdir(emptyPath);
  const port = await availablePort();
  await writeConfig(configPath, root, port);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const cliProcess = spawnCli(["start", "--setup"], root, {
    PILINK_CONFIG: configPath,
    PI_CLOUDFLARED_URL: "https://downloads.example/cloudflared",
    PORT: String(port),
    PATH: emptyPath,
  });
  let output = "";
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });

  await waitFor(() => output.includes("How should PiLink continue? [1/2]:"));
  cliProcess.stdin.write("2\n");
  await waitFor(() => output.includes("Select hosting [1/2/3]:"));
  cliProcess.stdin.write("1\n");
  const [code] = await once(cliProcess, "exit");

  assert.equal(code, 1);
  assert.match(output, /cloudflared overrides require both the download URL and its SHA-256 digest/);
  await assert.rejects(fs.stat(path.join(root, "bin", "cloudflared")), { code: "ENOENT" });
});

test("a cloudflared checksum mismatch leaves no executable or temporary download", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-dl-bad-hash-"));
  const configPath = path.join(root, ".env");
  const emptyPath = path.join(root, "empty-path");
  await fs.mkdir(emptyPath);
  const port = await availablePort();
  await writeConfig(configPath, root, port);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end("not the expected executable");
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
    PI_CLOUDFLARED_SHA256: "0".repeat(64),
    PORT: String(port),
    PATH: emptyPath,
  });
  let output = "";
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  await waitFor(() => output.includes("How should PiLink continue? [1/2]:"));
  cliProcess.stdin.write("2\n");
  await waitFor(() => output.includes("Select hosting [1/2/3]:"));
  cliProcess.stdin.write("1\n");
  const [code] = await once(cliProcess, "exit");

  assert.equal(code, 1);
  assert.match(output, /failed SHA-256 verification/);
  const binDirectory = path.join(root, "bin");
  assert.deepEqual(await fs.readdir(binDirectory), []);
});

test("an oversized managed binary download is rejected before it is written", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-dl-oversized-"));
  const configPath = path.join(root, ".env");
  const emptyPath = path.join(root, "empty-path");
  await fs.mkdir(emptyPath);
  const port = await availablePort();
  await writeConfig(configPath, root, port);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(129 * 1024 * 1024),
    });
    res.end();
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
    PI_CLOUDFLARED_SHA256: "0".repeat(64),
    PORT: String(port),
    PATH: emptyPath,
  });
  let output = "";
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  await waitFor(() => output.includes("How should PiLink continue? [1/2]:"));
  cliProcess.stdin.write("2\n");
  await waitFor(() => output.includes("Select hosting [1/2/3]:"));
  cliProcess.stdin.write("1\n");
  const [code] = await once(cliProcess, "exit");

  assert.equal(code, 1);
  assert.match(output, /128 MiB safety limit/);
  assert.deepEqual(await fs.readdir(path.join(root, "bin")), []);
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
  await waitFor(() => output.includes("Select hosting [1/2/3]:"));
  cliProcess.stdin.write("1\n");
  await waitFor(() => output.includes("Local verification code:"));
  const health = await fetch(`http://127.0.0.1:${newPort}/health`);
  assert.equal(health.status, 200);
  assert.match(output, /Local verification code: [A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/u);
  assert.doesNotMatch(output, /Paste callback URL here:|Client secret:/);

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

async function localRequest(port, requestPath, headers = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method: options.method || "GET",
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(options.body);
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for CLI output");
}
