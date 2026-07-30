import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("first start guides callback registration and persists a ChatGPT OAuth client", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mcp-cli-"));
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
  const cliProcess = spawn(process.execPath, [path.resolve("dist/cli.js"), "start"], {
    cwd: root,
    env: { ...globalThis.process.env, PI_MCP_CONFIG: configPath, PI_CLOUDFLARED_PATH: fakeCloudflared },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    cliProcess.kill("SIGINT");
    await fs.rm(root, { recursive: true, force: true });
  });
  let output = "";
  cliProcess.stdout.on("data", (chunk) => { output += chunk; });
  cliProcess.stderr.on("data", (chunk) => { output += chunk; });
  await waitFor(() => output.includes("Paste the ChatGPT callback URL"));
  cliProcess.stdin.write("https://chatgpt.example/callback\n");
  await waitFor(() => output.includes("ChatGPT OAuth client registered"));
  assert.match(output, /Client ID: pi_[a-f0-9]{16}/);
  assert.match(output, /Client secret: [A-Za-z0-9_-]{40,}/);
  assert.match(output, /Token endpoint auth method: client_secret_post/);
  const store = JSON.parse(await fs.readFile(path.join(root, "data", "clients.json"), "utf8"));
  assert.equal(store.clients.length, 1);
  assert.deepEqual(store.clients[0].redirect_uris, ["https://chatgpt.example/callback"]);
});

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for CLI output");
}
