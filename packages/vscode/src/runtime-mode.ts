/**
 * The server workflow selected from the VSPiLink dashboard.
 *
 * This is deliberately separate from the dashboard's execution surface
 * (ChatGPT MCP or Pi Local). A user can observe a runtime from either
 * surface, but the server must still be launched with one explicit workflow
 * policy.
 */
export const RUNTIME_MODES = ["single", "collaboration"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
/** Fail-closed default used when an installation has never chosen a workflow. */
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "single";

export const RUNTIME_MODE_STATE_KEY = "vspilink.runtimeMode.v1";
export const RUNTIME_MODE_SCHEMA_VERSION = 1 as const;

export interface PersistedRuntimeMode {
  schemaVersion: typeof RUNTIME_MODE_SCHEMA_VERSION;
  mode: RuntimeMode;
  updatedAt: string;
}

export interface RuntimeModeMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Return only the two server-supported values. */
export function normalizeRuntimeMode(value: unknown): RuntimeMode | undefined {
  if (value === "single" || value === "collaboration") return value;
  return undefined;
}

export function isRuntimeMode(value: unknown): value is RuntimeMode {
  return normalizeRuntimeMode(value) !== undefined;
}

/**
 * Normalize a persisted value without allowing arbitrary webview data to
 * become a launch policy. Unknown schemas and aliases fail closed.
 */
export function normalizePersistedRuntimeMode(value: unknown): PersistedRuntimeMode | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (
    source.schemaVersion !== RUNTIME_MODE_SCHEMA_VERSION ||
    !isRuntimeMode(source.mode) ||
    typeof source.updatedAt !== "string" ||
    !source.updatedAt ||
    source.updatedAt.length > 100 ||
    /[\r\n\0]/u.test(source.updatedAt)
  ) return undefined;
  return {
    schemaVersion: RUNTIME_MODE_SCHEMA_VERSION,
    mode: source.mode,
    updatedAt: source.updatedAt,
  };
}

/**
 * Supports the short-lived pre-release keys that used the same name but
 * stored either a raw mode string or an object. Surface values (`local` and
 * `remote`) are intentionally not accepted here: they describe where a
 * conversation is shown, not which server workflow is enabled.
 */
function normalizeLegacyRuntimeMode(value: unknown): RuntimeMode | undefined {
  if (isRuntimeMode(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  return normalizeRuntimeMode(source.mode) || normalizeRuntimeMode(source.runtimeMode);
}

const LEGACY_RUNTIME_MODE_KEYS = [
  "vspilink.runtimeMode",
  "vspilink.operationMode",
] as const;

export class RuntimeModeStore {
  constructor(private readonly memento: RuntimeModeMemento) {}

  load(): RuntimeMode | undefined {
    const persisted = normalizePersistedRuntimeMode(this.memento.get<unknown>(RUNTIME_MODE_STATE_KEY));
    if (persisted) return persisted.mode;
    for (const key of LEGACY_RUNTIME_MODE_KEYS) {
      const legacy = normalizeLegacyRuntimeMode(this.memento.get<unknown>(key));
      if (legacy) return legacy;
    }
    return undefined;
  }

  /**
   * Upgrade a compatible pre-release value once. This is called during
   * activation and is intentionally best-effort; the safe runtime fallback
   * remains `single` when storage is unavailable or malformed.
   */
  async migrate(): Promise<RuntimeMode | undefined> {
    const persisted = normalizePersistedRuntimeMode(this.memento.get<unknown>(RUNTIME_MODE_STATE_KEY));
    if (persisted) return persisted.mode;
    const mode = this.load();
    if (!mode) return undefined;
    await this.set(mode);
    return mode;
  }

  async set(mode: RuntimeMode): Promise<void> {
    if (!isRuntimeMode(mode)) throw new Error("Unknown PiLink runtime workflow.");
    await this.memento.update(RUNTIME_MODE_STATE_KEY, {
      schemaVersion: RUNTIME_MODE_SCHEMA_VERSION,
      mode,
      updatedAt: new Date().toISOString(),
    } satisfies PersistedRuntimeMode);
  }
}
