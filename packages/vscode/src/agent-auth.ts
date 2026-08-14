import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const AGENT_AUTH_PROTOCOL = "vspilink-agent-auth-v1";

export interface AgentModelCatalogEntry {
  id: string;
  name: string;
  providerId: string;
  reasoning: boolean;
  contextWindow: number;
}

export interface AgentProviderCatalogEntry {
  id: string;
  name: string;
  authTypes: ("oauth" | "api_key")[];
  configuredAuthType?: "oauth" | "api_key";
  models: AgentModelCatalogEntry[];
}

export interface AgentAuthCatalog {
  providers: AgentProviderCatalogEntry[];
}

export interface AgentAuthPrompt {
  promptId: string;
  kind: "text" | "secret" | "manual_code" | "select";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

export type AgentAuthEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: "info" | "progress"; message: string };

export interface AgentAuthInteraction {
  prompt(prompt: AgentAuthPrompt): Promise<string | undefined>;
  notify(event: AgentAuthEvent): Promise<void>;
}

export interface AgentAuthSidecarOptions {
  nodeExecutable: string;
  cliPath: string;
  cwd: string;
  configPath: string;
}

export class AgentAuthSidecar {
  private active?: ChildProcessWithoutNullStreams;

  get busy(): boolean {
    return Boolean(this.active);
  }

  async catalog(options: AgentAuthSidecarOptions): Promise<AgentAuthCatalog> {
    const messages = await this.run(options, ["agent-auth", "catalog"]);
    const result = messages.find((message) => message.type === "result");
    return parseCatalog(result?.catalog);
  }

  async login(
    options: AgentAuthSidecarOptions,
    providerId: string,
    authType: "oauth" | "api_key",
    oauthMethod: "browser" | "device_code" | undefined,
    interaction: AgentAuthInteraction,
  ): Promise<void> {
    if (!safeIdentifier(providerId)) throw new Error("Invalid agent provider.");
    const args = [
      "agent-auth", "login",
      "--provider", providerId,
      "--auth-type", authType,
      ...(authType === "oauth" && oauthMethod ? ["--oauth-method", oauthMethod] : []),
    ];
    const messages = await this.run(options, args, interaction);
    if (!messages.some((message) => message.type === "complete")) throw new Error("Agent sign-in did not complete.");
  }

  async logout(options: AgentAuthSidecarOptions, providerId: string): Promise<void> {
    if (!safeIdentifier(providerId)) throw new Error("Invalid agent provider.");
    const messages = await this.run(options, ["agent-auth", "logout", "--provider", providerId]);
    if (!messages.some((message) => message.type === "complete")) throw new Error("Agent sign-out did not complete.");
  }

  dispose(): void {
    this.active?.kill("SIGTERM");
    this.active = undefined;
  }

  private async run(
    options: AgentAuthSidecarOptions,
    args: string[],
    interaction?: AgentAuthInteraction,
  ): Promise<Record<string, unknown>[]> {
    if (this.active) throw new Error("Agent authentication is already in progress.");
    validateSidecarOptions(options, args);
    const child = spawn(options.nodeExecutable, [options.cliPath, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        PILINK_CONFIG: options.configPath,
        ELECTRON_RUN_AS_NODE: "1",
      },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.active = child;
    const messages: Record<string, unknown>[] = [];
    const protocol = new ProtocolSequence(args);
    let buffer = "";
    let bytes = 0;
    let stderrBytes = 0;
    let processing = Promise.resolve();
    let protocolError: Error | undefined;
    const timeout = setTimeout(() => child.kill("SIGKILL"), interaction ? 10 * 60_000 : 60_000);
    timeout.unref();

    const handleLine = async (line: string) => {
      const message = parseProtocolLine(line);
      protocol.accept(message);
      messages.push(message);
      if (message.type === "error") {
        throw new Error(safeMessage(message.message, "Agent authentication failed."));
      }
      if (message.type === "auth_event" && interaction) {
        await interaction.notify(parseAuthEvent(message.event));
      }
      if (message.type === "prompt" && interaction) {
        const prompt = parsePrompt(message.prompt);
        const answer = await interaction.prompt(prompt);
        if (answer === undefined) {
          child.kill("SIGTERM");
          throw new Error("Agent authentication was canceled.");
        }
        if (/\0|\r|\n/.test(answer) || Buffer.byteLength(answer, "utf8") > 16 * 1024) {
          child.kill("SIGTERM");
          throw new Error("Invalid agent sign-in response.");
        }
        child.stdin.write(`${JSON.stringify({
          protocol: AGENT_AUTH_PROTOCOL,
          type: "prompt_response",
          promptId: prompt.promptId,
          value: answer,
        })}\n`);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        protocolError = new Error("The agent-auth response is too large.");
        child.kill("SIGKILL");
        return;
      }
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        processing = processing.then(() => handleLine(line)).catch((error) => {
          protocolError = error instanceof Error ? error : new Error("Invalid agent-auth protocol.");
          child.kill("SIGTERM");
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 1024 * 1024) child.kill("SIGKILL");
    });

    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once("error", () => reject(new Error("Could not start agent-auth.")));
        child.once("close", resolve);
      });
      await processing;
      if (protocolError) throw protocolError;
      if (buffer.trim()) await handleLine(buffer);
      if (exit !== 0) {
        const failure = messages.find((message) => message.type === "error");
        throw new Error(safeMessage(failure?.message, "Agent authentication failed."));
      }
      protocol.finish();
      return messages;
    } finally {
      clearTimeout(timeout);
      child.stdin.destroy();
      if (this.active === child) this.active = undefined;
    }
  }
}

class ProtocolSequence {
  private readonly operation: "catalog" | "login" | "logout";
  private readonly providerId?: string;
  private readonly authType?: "oauth" | "api_key";
  private readonly promptIds = new Set<string>();
  private ready = false;
  private terminal = false;

  constructor(args: readonly string[]) {
    const operation = args[1];
    if (operation !== "catalog" && operation !== "login" && operation !== "logout") {
      throw new Error("Invalid agent-auth operation.");
    }
    this.operation = operation;
    this.providerId = flagValue(args, "--provider");
    const authType = flagValue(args, "--auth-type");
    this.authType = authType === "oauth" || authType === "api_key" ? authType : undefined;
  }

  accept(message: Record<string, unknown>): void {
    if (this.terminal) throw new Error("Received an agent-auth message after completion.");
    if (message.type === "error") {
      if (typeof message.code !== "string" || typeof message.message !== "string") throw new Error("Invalid agent-auth error response.");
      this.terminal = true;
      return;
    }
    if (this.operation === "catalog") {
      if (message.type !== "result" || message.command !== "catalog" || !object(message.catalog).providers) {
        throw new Error("Invalid agent-auth provider-catalog sequence.");
      }
      this.terminal = true;
      return;
    }
    if (this.operation === "logout") {
      if (message.type !== "complete" || message.command !== "logout" || message.providerId !== this.providerId) {
        throw new Error("Invalid agent-auth sign-out sequence.");
      }
      this.terminal = true;
      return;
    }
    if (message.type === "ready") {
      if (this.ready || message.command !== "login" || message.providerId !== this.providerId || message.authType !== this.authType) {
        throw new Error("Invalid agent-auth sign-in start message.");
      }
      this.ready = true;
      return;
    }
    if (!this.ready) throw new Error("Received an agent-auth sign-in event before sign-in started.");
    if (message.type === "auth_event") return;
    if (message.type === "prompt") {
      const promptId = object(message.prompt).promptId;
      if (!safeIdentifier(promptId) || this.promptIds.has(promptId)) throw new Error("Duplicate or invalid agent-auth prompt.");
      this.promptIds.add(promptId);
      return;
    }
    if (message.type === "complete") {
      const result = object(message.result);
      if (
        message.command !== "login" || result.providerId !== this.providerId ||
        result.authType !== this.authType || result.configured !== true
      ) throw new Error("Invalid agent-auth sign-in completion message.");
      this.terminal = true;
      return;
    }
    throw new Error("This agent-auth message type is not allowed.");
  }

  finish(): void {
    if (!this.terminal) throw new Error("The agent-auth helper process exited without a valid result.");
  }
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function validateSidecarOptions(options: AgentAuthSidecarOptions, args: readonly string[]): void {
  for (const value of [options.nodeExecutable, options.cliPath, options.cwd, options.configPath, ...args]) {
    if (!value || value.length > 8_192 || /[\0\r\n]/.test(value)) throw new Error("Invalid agent-auth argument.");
  }
}

function parseProtocolLine(line: string): Record<string, unknown> {
  if (!line || Buffer.byteLength(line, "utf8") > 256 * 1024) throw new Error("Invalid agent-auth message.");
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error("Invalid agent-auth message."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent-auth message.");
  const message = value as Record<string, unknown>;
  if (message.protocol !== AGENT_AUTH_PROTOCOL || typeof message.type !== "string") throw new Error("Invalid agent-auth protocol.");
  return message;
}

function parseCatalog(value: unknown): AgentAuthCatalog {
  const source = object(value);
  if (!Array.isArray(source.providers)) throw new Error("Invalid agent provider catalog.");
  const providers = source.providers.slice(0, 256).flatMap((value) => {
    const provider = object(value);
    if (!safeIdentifier(provider.id) || typeof provider.name !== "string" || !Array.isArray(provider.authTypes)) return [];
    const authTypes = provider.authTypes.filter((entry): entry is "oauth" | "api_key" => entry === "oauth" || entry === "api_key");
    if (!authTypes.length) return [];
    const configured: "oauth" | "api_key" | undefined = provider.configuredAuthType === "oauth" || provider.configuredAuthType === "api_key"
      ? provider.configuredAuthType as "oauth" | "api_key"
      : undefined;
    const models = Array.isArray(provider.models) ? provider.models.slice(0, 5_000).flatMap((value) => {
      const model = object(value);
      if (!safeIdentifier(model.id) || !safeIdentifier(model.providerId) || typeof model.name !== "string") return [];
      return [{
        id: model.id,
        name: cleanText(model.name, 200),
        providerId: model.providerId,
        reasoning: model.reasoning === true,
        contextWindow: typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) ? model.contextWindow : 0,
      }];
    }) : [];
    return [{
      id: provider.id,
      name: cleanText(provider.name, 200),
      authTypes,
      ...(configured ? { configuredAuthType: configured } : {}),
      models,
    }];
  });
  return { providers };
}

function parsePrompt(value: unknown): AgentAuthPrompt {
  const prompt = object(value);
  if (!safeIdentifier(prompt.promptId) || !["text", "secret", "manual_code", "select"].includes(String(prompt.kind))) {
    throw new Error("Invalid agent-auth prompt.");
  }
  const options = prompt.kind === "select" && Array.isArray(prompt.options)
    ? prompt.options.slice(0, 100).flatMap((value) => {
        const option = object(value);
        if (!safeIdentifier(option.id) || typeof option.label !== "string") return [];
        return [{
          id: option.id,
          label: cleanText(option.label, 300),
          ...(typeof option.description === "string" ? { description: cleanText(option.description, 500) } : {}),
        }];
      })
    : undefined;
  return {
    promptId: prompt.promptId,
    kind: prompt.kind as AgentAuthPrompt["kind"],
    message: safeMessage(prompt.message, "Complete agent authentication."),
    ...(typeof prompt.placeholder === "string" ? { placeholder: cleanText(prompt.placeholder, 1_000) } : {}),
    ...(options ? { options } : {}),
  };
}

function parseAuthEvent(value: unknown): AgentAuthEvent {
  const event = object(value);
  if (event.type === "auth_url" && typeof event.url === "string") {
    return { type: "auth_url", url: safeExternalUrl(event.url), ...(typeof event.instructions === "string" ? { instructions: cleanText(event.instructions, 1_000) } : {}) };
  }
  if (event.type === "device_code" && typeof event.userCode === "string" && typeof event.verificationUri === "string") {
    return {
      type: "device_code",
      userCode: cleanText(event.userCode, 200),
      verificationUri: safeExternalUrl(event.verificationUri),
      ...(typeof event.expiresInSeconds === "number" ? { expiresInSeconds: event.expiresInSeconds } : {}),
    };
  }
  if ((event.type === "info" || event.type === "progress") && typeof event.message === "string") {
    return { type: event.type, message: cleanText(event.message, 1_000) };
  }
  throw new Error("Invalid agent-auth event.");
}

function safeExternalUrl(value: string): string {
  if (value.length > 4_096 || /[\0\r\n]/.test(value)) throw new Error("Invalid agent sign-in URL.");
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password) {
    throw new Error("This agent sign-in URL is not allowed.");
  }
  return url.toString();
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
}

function safeMessage(value: unknown, fallback: string): string {
  return typeof value === "string" ? cleanText(value, 1_000) || fallback : fallback;
}

function cleanText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu, " ").trim().slice(0, max);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
