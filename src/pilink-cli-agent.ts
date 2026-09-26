import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { defaultConfigPath } from "./config.js";
import { deriveGatewayApiKey } from "./llm-gateway-api.js";
import { gatewayApiPortForMcp } from "./llm-gateway-ports.js";

export interface VerifiedGatewayModel {
  baseUrl: string;
  apiKey: string;
}

/** Only the local gateway that owns the private configuration may supply Pi's model. */
export async function verifyLocalGateway(
  configPath = process.env.PILINK_CONFIG || defaultConfigPath(),
  fetcher: typeof fetch = fetch,
): Promise<VerifiedGatewayModel> {
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile() || fs.lstatSync(configPath).isSymbolicLink()) {
    throw new Error(`PiLink gateway configuration is missing: ${configPath}. Start the gateway first with 'pilink gateway start'.`);
  }
  const env = dotenv.parse(fs.readFileSync(configPath));
  if (!env.JWT_SECRET || !env.PI_BOOTSTRAP_SECRET) throw new Error("PiLink gateway configuration is incomplete.");
  const mcpPort = parseGatewayPort(env.PORT || "3200", "PORT");
  const apiPort = env.PI_LLM_GATEWAY_PORT
    ? parseGatewayPort(env.PI_LLM_GATEWAY_PORT, "PI_LLM_GATEWAY_PORT")
    : gatewayApiPortForMcp(mcpPort);
  const apiKey = env.PI_LLM_GATEWAY_API_KEY || deriveGatewayApiKey(env.JWT_SECRET);
  const challenge = randomBytes(32).toString("base64url");
  try {
    const healthResponse = await fetcher(`http://127.0.0.1:${mcpPort}/health?challenge=${challenge}`, {
      redirect: "error", signal: AbortSignal.timeout(4_000),
    });
    if (!healthResponse.ok) throw new Error("MCP health check failed");
    const health = await boundedJson(healthResponse);
    if (!isObject(health) || health.auth_scheme !== "pilink-health-hmac-v1" || health.challenge !== challenge ||
        typeof health.version !== "string" || typeof health.proof !== "string") {
      throw new Error("MCP identity check failed");
    }
    const expected = createHmac("sha256", env.PI_BOOTSTRAP_SECRET)
      .update(`pilink-health-v1\0${challenge}\0${health.version}\0${mcpPort}`).digest("base64url");
    const actualBytes = Buffer.from(health.proof);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
      throw new Error("MCP identity check failed");
    }
    const modelsResponse = await fetcher(`http://127.0.0.1:${apiPort}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` }, redirect: "error", signal: AbortSignal.timeout(4_000),
    });
    if (!modelsResponse.ok) throw new Error("Gateway model API is unavailable");
    const models = await boundedJson(modelsResponse);
    if (!isObject(models) || !Array.isArray(models.data) || !models.data.some(
      (model: unknown) => isObject(model) && model.id === "pilink",
    )) throw new Error("PiLink model is not advertised by this gateway");
  } catch (error) {
    throw new Error(`PiLink gateway is not ready on ports ${mcpPort}/${apiPort}. Start or reconnect it with 'pilink gateway start'; no other local listener will be trusted. (${error instanceof Error ? error.message : "request failed"})`);
  }
  return { baseUrl: `http://127.0.0.1:${apiPort}/v1`, apiKey };
}

/** Register only PiLink's provider; leave all unrelated Pi configuration unchanged. */
export function ensurePiGatewayModel(
  baseUrl: string,
  agentDirectory = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
  homeDirectory = os.homedir(),
): void {
  const directory = path.resolve(agentDirectory);
  const relative = path.relative(path.resolve(homeDirectory), directory);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Refusing to store PiLink model configuration outside a private user agent directory.");
  }
  if (fs.existsSync(directory) && (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory())) {
    throw new Error("Pi agent directory must be a regular directory, not a symlink.");
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const actualHome = fs.realpathSync(homeDirectory);
  const actualDirectory = fs.realpathSync(directory);
  const actualRelative = path.relative(actualHome, actualDirectory);
  if (actualRelative === "" || actualRelative === ".." || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative)) {
    throw new Error("Refusing a Pi agent directory that resolves outside the user's home.");
  }
  const file = path.join(directory, "models.json");
  if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile())) {
    throw new Error("Refusing to overwrite a non-regular Pi models.json.");
  }
  const store: Record<string, unknown> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (!isObject(store) || (store.providers !== undefined && !isObject(store.providers))) {
    throw new Error("Invalid Pi models.json; refusing to overwrite it.");
  }
  const providers = (store.providers ?? {}) as Record<string, unknown>;
  const existing = providers.pilink;
  if (existing !== undefined && (!isObject(existing) || !Array.isArray(existing.models) ||
      !existing.models.some((model: unknown) => isObject(model) && model.id === "pilink") ||
      typeof existing.baseUrl !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/u.test(existing.baseUrl))) {
    throw new Error("An unrelated Pi 'pilink' provider already exists; refusing to overwrite it.");
  }
  const provider = {
    baseUrl, api: "openai-completions", apiKey: "${PILINK_GATEWAY_API_KEY}",
    models: [{ id: "pilink", name: "PiLink ChatGPT Gateway", input: ["text"], contextWindow: 128_000, maxTokens: 8_192 }],
  };
  if (JSON.stringify(existing) === JSON.stringify(provider)) return;
  providers.pilink = provider;
  store.providers = providers;
  const temporary = path.join(directory, `.pilink-models-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function parseGatewayPort(value: string, name: string): number {
  if (!/^\d+$/u.test(value.trim())) throw new Error(`${name} must be an integer TCP port.`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be from 1 through 65535.`);
  return port;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty gateway response");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > 32 * 1024) throw new Error("Oversized gateway response");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
