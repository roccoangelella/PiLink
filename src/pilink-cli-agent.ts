import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { defaultConfigPath } from "./config.js";
import { deriveGatewayApiKey } from "./llm-gateway-api.js";
import { gatewayApiPortForMcp, isLoopbackPortAvailable } from "./llm-gateway-ports.js";
import { gatewayBrowserExtensionNeedsReload, loadedGatewayBrowserExtension, pauseGatewayBrowserWake, runGatewayBrowserSetup, stageGatewayBrowserExtension } from "./llm-gateway-browser-setup.js";

export interface VerifiedGatewayModel {
  baseUrl: string;
  apiKey: string;
}

const AUTOSTART_WAIT_MS = 30_000;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Launch at most one configured gateway, never repointing an occupied origin. */
export async function ensureLocalGateway(
  configPath = process.env.PILINK_CONFIG || defaultConfigPath(),
  options: { start?: (configPath: string) => void | Promise<void>; waitMs?: number; stage?: () => string } = {},
): Promise<VerifiedGatewayModel> {
  let verified: VerifiedGatewayModel | undefined;
  try {
    verified = await verifyLocalGateway(configPath);
  } catch (initialError) {
    if (!fs.existsSync(configPath)) throw initialError;
  }
  if (!fs.statSync(configPath).isFile() || fs.lstatSync(configPath).isSymbolicLink()) {
    throw new Error("Gateway configuration must be a regular private file before automatic startup.");
  }
  const values = dotenv.parse(fs.readFileSync(configPath));
  if (verified) {
    if (shouldOfferGatewayBrowserSetup(values.PI_LLM_GATEWAY_AUTO_WAKE, options.stage) ||
        (!options.stage && gatewayBrowserExtensionNeedsReload())) {
      try { await runGatewayBrowserSetup(false); }
      catch (error) { console.error(`[PiLink] Browser setup unavailable: ${error instanceof Error ? error.message : "unknown error"}`); }
    }
    return verified;
  }
  const port = parseGatewayPort(values.PORT || "3200", "PORT");
  const apiPort = values.PI_LLM_GATEWAY_PORT
    ? parseGatewayPort(values.PI_LLM_GATEWAY_PORT, "PI_LLM_GATEWAY_PORT")
    : gatewayApiPortForMcp(port);
  if (values.PI_HOSTING_MODE !== "cloudflare-fixed" || !values.PI_CLOUDFLARE_TOKEN_FILE ||
      !values.SERVER_URL?.startsWith("https://")) {
    throw new Error("Automatic startup requires a previously configured fixed-domain gateway. Run 'pilink gateway start' interactively first.");
  }
  const token = path.resolve(values.PI_CLOUDFLARE_TOKEN_FILE);
  if (!fs.existsSync(token) || fs.lstatSync(token).isSymbolicLink() || !fs.statSync(token).isFile()) {
    throw new Error("The configured Cloudflare tunnel token is missing; run 'pilink gateway start' interactively.");
  }
  const lock = path.join(path.dirname(configPath), ".pilink-gateway-autostart.lock");
  const waitMs = options.waitMs ?? AUTOSTART_WAIT_MS;
  const deadline = Date.now() + waitMs;
  let acquired = false;
  try {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (recoverStaleGatewayLock(lock)) {
        try {
          fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
          acquired = true;
        } catch (retryError) {
          if ((retryError as NodeJS.ErrnoException).code !== "EEXIST") throw retryError;
        }
      }
    }
    if (acquired) {
      try {
        return await verifyLocalGateway(configPath);
      } catch {
        // No verified owner yet. An unrelated listener is never a reason to
        // select a fallback port or rewrite a Cloudflare ingress rule.
      }
      if (!await isLoopbackPortAvailable(port) || !await isLoopbackPortAvailable(apiPort)) {
        throw new Error(`Port ${port} or ${apiPort} is occupied by an unverified process; refusing to start or repoint the gateway.`);
      }
      try {
        if (shouldOfferGatewayBrowserSetup(values.PI_LLM_GATEWAY_AUTO_WAKE, options.stage) ||
            (!options.stage && gatewayBrowserExtensionNeedsReload())) {
          // Set the opt-in before starting the server so wake works on the
          // very first launch after the browser's one-time manual approval.
          await runGatewayBrowserSetup(false);
        } else {
          const location = options.stage ? options.stage() :
            stageGatewayBrowserExtension({ connectorName: values.PI_LLM_GATEWAY_CONNECTOR_NAME });
          if (!options.stage && gatewayBrowserExtensionNeedsReload(location) && values.PI_LLM_GATEWAY_AUTO_WAKE === "true") {
            pauseGatewayBrowserWake(configPath);
            console.error("[PiLink] Auto-wake paused: reload the updated browser extension and run 'pilink gateway browser-extension' to confirm it.");
          }
          console.error(`[PiLink] Browser wake extension prepared at ${location}. In Brave open brave://extensions, or in Chrome/Chromium open chrome://extensions; turn on Developer mode, click Load unpacked and choose that directory once.`);
        }
      } catch (error) {
        console.error(`[PiLink] Browser extension could not be staged: ${error instanceof Error ? error.message : "unavailable"}. Run 'pilink gateway browser-extension' after building.`);
      }
      console.error("[PiLink] Starting the configured ChatGPT gateway in the background...");
      await (options.start ?? startDetachedGateway)(configPath);
    }
    while (Date.now() < deadline) {
      try { return await verifyLocalGateway(configPath); } catch { /* Still starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("PiLink gateway did not become ready. Run 'pilink gateway start' in a terminal to see setup or hosting errors.");
  } finally {
    if (acquired) fs.rmSync(lock, { force: true });
  }
}

export function recoverStaleGatewayLock(lock: string): boolean {
  try {
    const state = fs.lstatSync(lock);
    if (!state.isFile() || state.isSymbolicLink() || state.size > 32 ||
        (typeof process.getuid === "function" && state.uid !== process.getuid())) return false;
    const text = fs.readFileSync(lock, "utf8").trim();
    if (!/^[1-9]\d{0,9}$/u.test(text)) return false;
    const pid = Number(text);
    try { process.kill(pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
    const current = fs.lstatSync(lock);
    if (state.dev !== current.dev || state.ino !== current.ino || fs.readFileSync(lock, "utf8").trim() !== text) return false;
    fs.unlinkSync(lock);
    return true;
  } catch {
    return false;
  }
}

function shouldOfferGatewayBrowserSetup(wakeSetting: string | undefined, injectedStage?: () => string): boolean {
  if (injectedStage || process.platform !== "linux" || wakeSetting === "true") return false;
  // An interactive launch offers the one-time install. In a headless launch,
  // auto-enable only an extension already loaded in the default browser.
  return (process.stdin.isTTY === true && process.stderr.isTTY === true && process.env.CI !== "true") ||
    loadedGatewayBrowserExtension();
}

function startDetachedGateway(configPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(moduleDirectory, "cli.js"), "gateway", "start"], {
      cwd: path.resolve(moduleDirectory, ".."),
      env: { ...process.env, PILINK_CONFIG: configPath, PILINK_GATEWAY_NO_PORT_FALLBACK: "true", PI_BROWSER_OPEN: "never" },
      stdio: "ignore", detached: true, windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
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
