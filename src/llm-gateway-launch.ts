import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { defaultConfigPath, loadEnvironment, loadRuntimeConfig } from "./config.js";
import {
  normalizeFixedDomainHostname,
  normalizeFixedDomainTunnelId,
  provisionFixedDomainTunnel,
} from "./hosting/fixed-domain.js";
import { selectGatewayPorts } from "./llm-gateway-ports.js";

export async function prepareGatewayLaunch(subcommand: "start" | "serve"): Promise<void> {
  const configPath = process.env.PILINK_CONFIG || defaultConfigPath();
  if (!fs.existsSync(configPath)) return;

  loadEnvironment();
  const config = loadRuntimeConfig();
  const explicitApiPort = optionalPort(process.env.PI_LLM_GATEWAY_PORT, "PI_LLM_GATEWAY_PORT");
  const selection = await selectGatewayPorts(config.port, explicitApiPort);

  process.env.PORT = String(selection.mcpPort);
  if (explicitApiPort === undefined) process.env.PI_LLM_GATEWAY_PORT = String(selection.apiPort);
  if (!selection.changed) return;

  const previousConfig = fs.readFileSync(configPath, "utf8");
  writeConfigValue(configPath, previousConfig, "PORT", String(selection.mcpPort));
  try {
    if (subcommand === "start" && process.env.PI_HOSTING_MODE?.trim() === "cloudflare-fixed") {
      await repointFixedDomainGateway(configPath, selection.mcpPort);
    }
  } catch (error) {
    writePrivateConfig(configPath, previousConfig);
    process.env.PORT = String(selection.requestedMcpPort);
    if (explicitApiPort === undefined) delete process.env.PI_LLM_GATEWAY_PORT;
    throw error;
  }

  console.error(
    `[Gateway] MCP port ${selection.requestedMcpPort} is unavailable; using ${selection.mcpPort}. ` +
    `OpenAI-compatible API: http://127.0.0.1:${selection.apiPort}/v1`,
  );
  console.error(`[Gateway] Saved PORT=${selection.mcpPort} in ${configPath} so subsequent PiLink launches use the same reachable origin.`);
}

async function repointFixedDomainGateway(configPath: string, mcpPort: number): Promise<void> {
  const rawServerUrl = process.env.SERVER_URL?.trim();
  if (!rawServerUrl) throw new Error("Cloudflare fixed-domain gateway fallback requires SERVER_URL in the PiLink configuration.");
  let hostname: string;
  try {
    hostname = normalizeFixedDomainHostname(new URL(rawServerUrl).hostname);
  } catch {
    throw new Error("Cloudflare fixed-domain SERVER_URL is invalid; PiLink cannot repoint the gateway origin safely.");
  }
  const expectedTunnelId = normalizeFixedDomainTunnelId(process.env.PI_CLOUDFLARE_TUNNEL_ID || "");
  const inheritedToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const apiToken = inheritedToken || await questionSecret(
    `Cloudflare API token required to repoint ${hostname} to 127.0.0.1:${mcpPort} (input hidden): `,
  );
  try {
    console.error(`[Gateway] Repointing the existing Cloudflare fixed-domain ingress to 127.0.0.1:${mcpPort}...`);
    const provisioned = await provisionFixedDomainTunnel({
      hostname,
      origin: `http://127.0.0.1:${mcpPort}`,
      apiToken,
      tokenDirectory: path.join(path.dirname(configPath), "cloudflare"),
      expectedTunnelId,
    });
    if (provisioned.tunnelId !== expectedTunnelId) {
      throw new Error("Cloudflare returned a different tunnel than the one configured for this PiLink instance.");
    }
    console.error(`[Gateway] Cloudflare fixed-domain ingress now targets 127.0.0.1:${mcpPort}.`);
  } finally {
    delete process.env.CLOUDFLARE_API_TOKEN;
  }
}

function optionalPort(value: string | undefined, name: string): number | undefined {
  if (value === undefined || !value.trim()) return undefined;
  if (!/^\d+$/u.test(value.trim())) throw new Error(`${name} must be an integer TCP port.`);
  const port = Number(value.trim());
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be from 1 through 65535.`);
  return port;
}

function writeConfigValue(configPath: string, current: string, name: string, value: string): void {
  if (/\r|\n/u.test(value)) throw new Error(`Invalid configuration value for ${name}.`);
  const lines = current.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));
  const entry = `${name}=${value}`;
  if (index === -1) lines.push(entry);
  else lines[index] = entry;
  writePrivateConfig(configPath, lines.join("\n"));
}

function writePrivateConfig(configPath: string, content: string): void {
  fs.writeFileSync(configPath, content, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(configPath, 0o600);
}

async function questionSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      "Set CLOUDFLARE_API_TOKEN in the process environment when a fixed-domain gateway port fallback must be applied non-interactively.",
    );
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  process.stderr.write(prompt);
  muted = true;
  try {
    const token = (await readline.question("")).trim();
    if (!token) throw new Error("Cloudflare API token is required to repoint the fixed-domain gateway origin.");
    return token;
  } finally {
    muted = false;
    readline.close();
    process.stderr.write("\n");
  }
}
