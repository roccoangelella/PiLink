import { randomUUID } from "node:crypto";
import type { CloudflareCredentialSummary, ExternalCredentialSummary } from "./credential-vault.js";
import type { HostingSelection } from "./hosting-model.js";
import { normalizeHostingSelection } from "./hosting-model.js";

export const WIZARD_STATE_KEY = "vspilink.onboarding.v1";

export const WIZARD_PHASES = [
  "idle",
  "workspace",
  "hosting",
  "provisioning",
  "starting",
  "callback",
  "credentials",
  "complete",
] as const;

export type WizardPhase = (typeof WIZARD_PHASES)[number];
export type WizardAccessMode = "workspace" | "full";

export interface WizardError {
  code: string;
  message: string;
  phase: WizardPhase;
  retryable: boolean;
}

export interface PersistedWizardState {
  schemaVersion: 1;
  runId: string;
  revision: number;
  seen: boolean;
  active: boolean;
  completed: boolean;
  phase: WizardPhase;
  workspace: string;
  accessMode: WizardAccessMode;
  hosting?: HostingSelection;
  configPath?: string;
  publicUrl?: string;
  mcpUrl?: string;
  callbackUrl?: string;
  chatGptPageOpened: boolean;
  developerModeConfirmed?: boolean;
  chatGptConnected: boolean;
  credential?: ExternalCredentialSummary;
  cloudflareCredential?: CloudflareCredentialSummary;
  /**
   * Last configuration that was successfully started. This is deliberately
   * separate from the in-progress wizard selection: opening a new setup must
   * never make an already installed persistent service unmanageable.
   */
  appliedHosting?: HostingSelection;
  appliedConfigPath?: string;
  error?: WizardError;
}

export interface WizardViewState {
  active: boolean;
  completed: boolean;
  phase: WizardPhase;
  revision: number;
  workspace: string;
  accessMode: WizardAccessMode;
  hosting?: HostingSelection;
  publicUrl?: string;
  mcpUrl?: string;
  callbackUrl?: string;
  chatGptPageOpened: boolean;
  developerModeConfirmed?: boolean;
  chatGptConnected: boolean;
  credential?: {
    clientId: string;
    clientName: string;
    grantTypes: string[];
    scope: string;
    tokenEndpointAuthMethod: string;
    hasSecret: boolean;
  };
  cloudflareCredential?: {
    kind: CloudflareCredentialSummary["kind"];
    label: string;
  };
  error?: WizardError;
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export class WizardStateStore {
  constructor(private readonly memento: MementoLike) {}

  load(defaultWorkspace = ""): PersistedWizardState {
    const parsed = normalizeWizardState(this.memento.get<unknown>(WIZARD_STATE_KEY));
    return parsed || createWizardState(defaultWorkspace);
  }

  async save(state: PersistedWizardState): Promise<void> {
    await this.memento.update(WIZARD_STATE_KEY, state);
  }
}

export function createWizardState(workspace = "", runId = randomUUID()): PersistedWizardState {
  return {
    schemaVersion: 1,
    runId,
    revision: 0,
    seen: false,
    active: false,
    completed: false,
    phase: "idle",
    workspace,
    accessMode: "workspace",
    chatGptPageOpened: false,
    developerModeConfirmed: false,
    chatGptConnected: false,
  };
}

export function beginWizard(previous: PersistedWizardState, workspace: string, runId = randomUUID()): PersistedWizardState {
  if (!previous.completed && previous.phase !== "idle") {
    return revise(previous, { seen: true, active: true, workspace: previous.workspace || workspace, error: undefined });
  }
  const appliedHosting = previous.appliedHosting || previous.hosting;
  const appliedConfigPath = previous.appliedConfigPath || previous.configPath;
  return {
    ...createWizardState(workspace, runId),
    revision: previous.revision + 1,
    seen: true,
    active: true,
    phase: "workspace",
    ...(appliedHosting ? { appliedHosting } : {}),
    ...(appliedConfigPath ? { appliedConfigPath } : {}),
  };
}

export function revise(
  state: PersistedWizardState,
  patch: Partial<Omit<PersistedWizardState, "schemaVersion" | "runId" | "revision">>,
): PersistedWizardState {
  return {
    ...state,
    ...patch,
    schemaVersion: 1,
    revision: state.revision + 1,
  };
}

export function failWizard(state: PersistedWizardState, error: unknown, retryable = true): PersistedWizardState {
  const message = error instanceof Error ? error.message : String(error || "The operation failed.");
  return revise(state, {
    error: {
      code: errorCode(error),
      message: message.replace(/[\r\n\0]+/g, " ").slice(0, 1_000),
      phase: state.phase,
      retryable,
    },
  });
}

export function wizardViewState(state: PersistedWizardState): WizardViewState {
  // Persisted named-tunnel selections may carry an opaque SecretStorage
  // reference. Re-normalize for the untrusted webview so neither that
  // reference nor any future host-only field crosses the boundary.
  const hosting = state.hosting ? normalizeHostingSelection(state.hosting) : undefined;
  return {
    active: state.active,
    completed: state.completed,
    phase: state.phase,
    revision: state.revision,
    workspace: state.workspace,
    accessMode: state.accessMode,
    ...(hosting ? { hosting } : {}),
    ...(state.publicUrl ? { publicUrl: state.publicUrl } : {}),
    ...(state.mcpUrl ? { mcpUrl: state.mcpUrl } : {}),
    ...(state.callbackUrl ? { callbackUrl: state.callbackUrl } : {}),
    chatGptPageOpened: state.chatGptPageOpened,
    developerModeConfirmed: state.developerModeConfirmed === true || state.chatGptConnected || Boolean(state.credential),
    chatGptConnected: state.chatGptConnected,
    ...(state.credential ? {
      credential: {
        clientId: state.credential.clientId,
        clientName: state.credential.clientName,
        grantTypes: [...state.credential.grantTypes],
        scope: state.credential.scope,
        tokenEndpointAuthMethod: state.credential.tokenEndpointAuthMethod,
        hasSecret: state.credential.hasSecret,
      },
    } : {}),
    ...(state.cloudflareCredential ? {
      cloudflareCredential: {
        kind: state.cloudflareCredential.kind,
        label: state.cloudflareCredential.label,
      },
    } : {}),
    ...(state.error ? { error: { ...state.error } } : {}),
  };
}

function normalizeWizardState(value: unknown): PersistedWizardState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (
    source.schemaVersion !== 1 || typeof source.runId !== "string" ||
    typeof source.revision !== "number" || !Number.isSafeInteger(source.revision) ||
    typeof source.seen !== "boolean" || typeof source.active !== "boolean" ||
    typeof source.completed !== "boolean" || typeof source.phase !== "string" ||
    !(WIZARD_PHASES as readonly string[]).includes(source.phase) || typeof source.workspace !== "string" ||
    (source.accessMode !== "workspace" && source.accessMode !== "full") ||
    typeof source.chatGptPageOpened !== "boolean" ||
    (source.developerModeConfirmed !== undefined && typeof source.developerModeConfirmed !== "boolean") ||
    (source.chatGptConnected !== undefined && typeof source.chatGptConnected !== "boolean")
  ) return undefined;

  const hosting = source.hosting === undefined ? undefined : normalizeHostingSelection(source.hosting, true);
  if (source.hosting !== undefined && !hosting) return undefined;
  const appliedHosting = source.appliedHosting === undefined
    ? undefined
    : normalizeHostingSelection(source.appliedHosting, true);
  if (source.appliedHosting !== undefined && !appliedHosting) return undefined;
  const result: PersistedWizardState = {
    schemaVersion: 1,
    runId: source.runId,
    revision: source.revision,
    seen: source.seen,
    active: source.active,
    completed: source.completed,
    phase: source.phase as WizardPhase,
    workspace: source.workspace,
    accessMode: source.accessMode,
    chatGptPageOpened: source.chatGptPageOpened,
    developerModeConfirmed: source.developerModeConfirmed === true || source.chatGptConnected === true,
    chatGptConnected: source.chatGptConnected === true,
    ...(hosting ? { hosting } : {}),
    ...(appliedHosting ? { appliedHosting } : {}),
  };
  if (typeof source.configPath === "string") result.configPath = source.configPath;
  if (typeof source.appliedConfigPath === "string") result.appliedConfigPath = source.appliedConfigPath;
  if (typeof source.publicUrl === "string") result.publicUrl = source.publicUrl;
  if (typeof source.mcpUrl === "string") result.mcpUrl = source.mcpUrl;
  if (typeof source.callbackUrl === "string") result.callbackUrl = source.callbackUrl;
  const credential = normalizeCredentialSummary(source.credential);
  if (credential) {
    result.credential = credential;
    result.developerModeConfirmed = true;
  }
  const cloudflareCredential = normalizeCloudflareCredentialSummary(source.cloudflareCredential);
  if (cloudflareCredential) result.cloudflareCredential = cloudflareCredential;
  const error = normalizeWizardError(source.error);
  if (error) result.error = error;
  return result;
}

function normalizeCloudflareCredentialSummary(value: unknown): CloudflareCredentialSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (
    typeof source.reference !== "string" || !/^[0-9a-f-]{36}$/i.test(source.reference) ||
    (source.kind !== "origin-certificate" && source.kind !== "tunnel-token-file") ||
    typeof source.label !== "string" || !source.label || source.label.length > 160 || /[\r\n\0]/.test(source.label)
  ) return undefined;
  return { reference: source.reference, kind: source.kind, label: source.label };
}

function normalizeCredentialSummary(value: unknown): ExternalCredentialSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (
    typeof source.clientId !== "string" || typeof source.clientName !== "string" ||
    !Array.isArray(source.redirectUris) || !source.redirectUris.every((entry) => typeof entry === "string") ||
    !Array.isArray(source.grantTypes) || !source.grantTypes.every((entry) => typeof entry === "string") ||
    typeof source.scope !== "string" || typeof source.createdAt !== "string" || source.hasSecret !== true ||
    !["client_secret_post", "client_secret_basic", "none"].includes(String(source.tokenEndpointAuthMethod))
  ) return undefined;
  return {
    clientId: source.clientId,
    clientName: source.clientName,
    redirectUris: [...source.redirectUris] as string[],
    grantTypes: [...source.grantTypes] as string[],
    scope: source.scope,
    createdAt: source.createdAt,
    hasSecret: true,
    tokenEndpointAuthMethod: source.tokenEndpointAuthMethod as ExternalCredentialSummary["tokenEndpointAuthMethod"],
  };
}

function normalizeWizardError(value: unknown): WizardError | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (
    typeof source.code !== "string" || typeof source.message !== "string" ||
    typeof source.phase !== "string" || !(WIZARD_PHASES as readonly string[]).includes(source.phase) ||
    typeof source.retryable !== "boolean"
  ) return undefined;
  return { code: source.code, message: source.message, phase: source.phase as WizardPhase, retryable: source.retryable };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code.slice(0, 80);
  }
  return "wizard_failed";
}
