import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const AGENT_CHAT_URI = "pilink://agent-chat";
export const AGENT_CHAT_HISTORY_LIMIT = 20;
export const AGENT_CHAT_AGENT_NAME_MAX_BYTES = 100;
export const AGENT_CHAT_MESSAGE_MAX_BYTES = 8 * 1024;

export interface AgentChatMessage {
  cursor: number;
  agentId: string;
  agentInstanceId: string;
  agentName: string;
  agentMessage: string;
}

export interface AgentChatReadResult {
  messages: AgentChatMessage[];
  oldestCursor: number;
  latestCursor: number;
  nextCursor: number;
  gap: boolean;
}

export interface AgentChatNotification {
  uri: typeof AGENT_CHAT_URI;
  latestCursor: number;
}

export interface AgentChatStoreOptions {
  workspace: string;
  dataDir?: string;
}

export interface AgentChatPostInput {
  agentId: string;
  agentInstanceId?: string;
  agentName: string;
  agentMessage: string;
}

interface StoredAgentChatState {
  version: 2;
  projectKey: string;
  nextCursor: number;
  messages: AgentChatMessage[];
}

interface SharedAgentChatState {
  state?: StoredAgentChatState;
  stateLoad?: Promise<StoredAgentChatState>;
  mutationQueue: Promise<void>;
}

const sharedStates = new Map<string, SharedAgentChatState>();

export type AgentChatListener = (notification: AgentChatNotification) => void | Promise<void>;

/** Durable state for one canonical workspace. Share one instance per process. */
export class AgentChatStore {
  public readonly workspace: string;
  public readonly projectKey: string;
  public readonly statePath: string;

  private readonly dataDir: string;
  private readonly projectDir: string;
  private readonly sharedState: SharedAgentChatState;

  public constructor(options: AgentChatStoreOptions);
  public constructor(workspace: string, dataDir?: string);
  public constructor(optionsOrWorkspace: AgentChatStoreOptions | string, dataDir?: string) {
    const workspace = typeof optionsOrWorkspace === "string" ? optionsOrWorkspace : optionsOrWorkspace.workspace;
    const configuredDataDir = typeof optionsOrWorkspace === "string" ? dataDir : optionsOrWorkspace.dataDir;
    const selectedDataDir = configuredDataDir || process.env.PI_DATA_DIR;
    if (!selectedDataDir) {
      throw new Error("AgentChatStore requires dataDir or PI_DATA_DIR");
    }

    this.workspace = fs.realpathSync(workspace);
    this.dataDir = path.resolve(selectedDataDir);
    if (isWithin(this.workspace, this.dataDir)) {
      throw new Error("Agent chat data must not be stored under the workspace");
    }

    this.projectKey = createHash("sha256").update(this.workspace).digest("hex");
    this.projectDir = path.join(this.dataDir, "projects", this.projectKey);
    this.statePath = path.join(this.projectDir, "agent-chat.json");
    this.sharedState = sharedStates.get(this.statePath) || { mutationQueue: Promise.resolve() };
    sharedStates.set(this.statePath, this.sharedState);
  }

  public async post(input: AgentChatPostInput): Promise<AgentChatMessage> {
    const agentId = validateAgentId(input.agentId);
    const agentInstanceId = validateAgentInstanceId(input.agentInstanceId ?? legacyAgentInstanceId(agentId));
    const agentName = validateText(input.agentName, "agentName", AGENT_CHAT_AGENT_NAME_MAX_BYTES);
    const agentMessage = validateText(input.agentMessage, "agentMessage", AGENT_CHAT_MESSAGE_MAX_BYTES);

    return this.enqueueMutation(async () => {
      const current = await this.loadState();
      const message: AgentChatMessage = {
        cursor: current.nextCursor,
        agentId,
        agentInstanceId,
        agentName,
        agentMessage,
      };
      const next: StoredAgentChatState = {
        version: 2,
        projectKey: this.projectKey,
        nextCursor: current.nextCursor + 1,
        messages: [...current.messages, message].slice(-AGENT_CHAT_HISTORY_LIMIT),
      };
      await this.persistState(next);
      this.sharedState.state = next;
      return copyMessage(message);
    });
  }

  public async read(after?: number): Promise<AgentChatReadResult> {
    await this.sharedState.mutationQueue;
    const state = await this.loadState();
    const messages = state.messages;
    const oldestCursor = messages.length > 0 ? messages[0].cursor : 0;
    const latestCursor = messages.length > 0 ? messages[messages.length - 1].cursor : 0;

    if (after !== undefined) {
      validateCursor(after);
      if (after > latestCursor) {
        throw new Error("Agent chat cursor is ahead of the latest cursor");
      }
    }

    const gap = after !== undefined && messages.length > 0 && after < oldestCursor - 1;
    return {
      messages: (after === undefined ? messages : messages.filter((message) => message.cursor > after)).map(copyMessage),
      oldestCursor,
      latestCursor,
      // The returned cursor is suitable for passing back as `after`.
      nextCursor: latestCursor,
      gap,
    };
  }

  private async enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const operation = this.sharedState.mutationQueue.then(mutation);
    this.sharedState.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async loadState(): Promise<StoredAgentChatState> {
    if (this.sharedState.state) return this.sharedState.state;

    const stateLoad = this.sharedState.stateLoad || this.readStateFile();
    this.sharedState.stateLoad = stateLoad;
    try {
      const state = await stateLoad;
      this.sharedState.state = state;
      return state;
    } finally {
      // A transient read or validation failure must not poison every future read.
      // Successful loads remain cached in `state`; failed loads may be retried.
      if (this.sharedState.stateLoad === stateLoad) this.sharedState.stateLoad = undefined;
    }
  }

  private async readStateFile(): Promise<StoredAgentChatState> {
    await this.ensureDirectories();
    let serialized: string;
    try {
      serialized = await fs.promises.readFile(this.statePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return emptyState(this.projectKey);
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("Malformed agent chat state: invalid JSON");
    }
    const state = validateState(parsed, this.projectKey);
    if (isRecord(parsed) && parsed.version === 1) await this.persistState(state);
    return state;
  }

  private async persistState(state: StoredAgentChatState): Promise<void> {
    await this.ensureDirectories();
    const temporaryPath = path.join(
      this.projectDir,
      `.agent-chat-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
    );
    try {
      const file = await fs.promises.open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.promises.rename(temporaryPath, this.statePath);
      await syncDirectory(this.projectDir);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async ensureDirectories(): Promise<void> {
    await fs.promises.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const canonicalDataDir = await fs.promises.realpath(this.dataDir);
    if (isWithin(this.workspace, canonicalDataDir)) {
      throw new Error("Agent chat data must not be stored under the workspace");
    }
    await fs.promises.chmod(this.dataDir, 0o700);
    const projectsDir = path.join(this.dataDir, "projects");
    await fs.promises.mkdir(projectsDir, { recursive: true, mode: 0o700 });
    const canonicalProjectsDir = await fs.promises.realpath(projectsDir);
    if (!isWithin(canonicalDataDir, canonicalProjectsDir)) {
      throw new Error("Agent chat projects directory escapes the configured data directory");
    }
    await fs.promises.chmod(projectsDir, 0o700);
    await fs.promises.mkdir(this.projectDir, { recursive: true, mode: 0o700 });
    const canonicalProjectDir = await fs.promises.realpath(this.projectDir);
    if (!isWithin(canonicalProjectsDir, canonicalProjectDir)) {
      throw new Error("Agent chat project directory escapes the configured data directory");
    }
    await fs.promises.chmod(this.projectDir, 0o700);
  }
}

/** In-process notification fan-out over a shared durable store. */
export class AgentChatBroker {
  private readonly listeners = new Map<string, Set<AgentChatListener>>();

  public constructor(public readonly store: AgentChatStore) {}

  public async post(input: AgentChatPostInput): Promise<AgentChatMessage> {
    const message = await this.store.post(input);
    this.dispatch(message.agentInstanceId, message.cursor);
    return message;
  }

  public read(after?: number): Promise<AgentChatReadResult> {
    return this.store.read(after);
  }

  public subscribe(agentInstanceId: string, notify: AgentChatListener): () => void {
    const normalizedAgentInstanceId = validateAgentInstanceId(agentInstanceId);
    if (typeof notify !== "function") throw new Error("notify must be a function");
    let agentListeners = this.listeners.get(normalizedAgentInstanceId);
    if (!agentListeners) {
      agentListeners = new Set();
      this.listeners.set(normalizedAgentInstanceId, agentListeners);
    }
    agentListeners.add(notify);
    return () => {
      agentListeners?.delete(notify);
      if (agentListeners?.size === 0) this.listeners.delete(normalizedAgentInstanceId);
    };
  }

  private dispatch(postingAgentInstanceId: string, latestCursor: number): void {
    const notification: AgentChatNotification = { uri: AGENT_CHAT_URI, latestCursor };
    for (const [agentInstanceId, agentListeners] of this.listeners) {
      if (agentInstanceId === postingAgentInstanceId) continue;
      for (const listener of [...agentListeners]) {
        queueMicrotask(() => {
          Promise.resolve().then(() => listener(notification)).catch(() => undefined);
        });
      }
    }
  }
}

function emptyState(projectKey: string): StoredAgentChatState {
  return { version: 2, projectKey, nextCursor: 1, messages: [] };
}

function validateState(value: unknown, expectedProjectKey: string): StoredAgentChatState {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || value.projectKey !== expectedProjectKey) {
    throw new Error("Malformed or mismatched agent chat state");
  }
  if (!Number.isSafeInteger(value.nextCursor) || value.nextCursor < 1 || !Array.isArray(value.messages)) {
    throw new Error("Malformed agent chat state");
  }
  if (value.messages.length > AGENT_CHAT_HISTORY_LIMIT) {
    throw new Error("Malformed agent chat state: history exceeds retention limit");
  }

  const messages: AgentChatMessage[] = [];
  let previousCursor = 0;
  for (const candidate of value.messages) {
    if (!isRecord(candidate) || !Number.isSafeInteger(candidate.cursor) || candidate.cursor <= previousCursor) {
      throw new Error("Malformed agent chat state: invalid cursors");
    }
    const message: AgentChatMessage = {
      cursor: candidate.cursor,
      agentId: validateAgentId(candidate.agentId),
      agentInstanceId: validateAgentInstanceId(
        value.version === 1 ? legacyAgentInstanceId(candidate.agentId) : candidate.agentInstanceId,
      ),
      agentName: validateText(candidate.agentName, "agentName", AGENT_CHAT_AGENT_NAME_MAX_BYTES),
      agentMessage: validateText(candidate.agentMessage, "agentMessage", AGENT_CHAT_MESSAGE_MAX_BYTES),
    };
    if (message.cursor >= value.nextCursor) {
      throw new Error("Malformed agent chat state: cursor exceeds counter");
    }
    messages.push(message);
    previousCursor = message.cursor;
  }
  if ((messages.length === 0 && value.nextCursor !== 1) ||
      (messages.length > 0 && value.nextCursor !== messages[messages.length - 1].cursor + 1)) {
    throw new Error("Malformed agent chat state: invalid cursor counter");
  }
  return { version: 2, projectKey: expectedProjectKey, nextCursor: value.nextCursor, messages };
}

function validateAgentId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("agentId must be non-empty");
  return value.trim();
}

function validateAgentInstanceId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("agentInstanceId must be non-empty");
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > 256) throw new Error("agentInstanceId exceeds 256 UTF-8 bytes");
  return normalized;
}

function legacyAgentInstanceId(agentId: unknown): string {
  return `legacy:${validateAgentId(agentId)}`;
}

function copyMessage(message: AgentChatMessage): AgentChatMessage {
  return { ...message };
}

function validateText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must be non-empty`);
  if (Buffer.byteLength(trimmed, "utf8") > maximumBytes) {
    throw new Error(`${field} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return trimmed;
}

function validateCursor(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("after must be a non-negative safe integer");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.promises.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
