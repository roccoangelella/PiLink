import type { ChatGptDestination } from "./chatgpt-links.js";
import type { CloudflareCredentialSummary, ExternalCredentialSummary } from "./credential-vault.js";
import type { CloudflareAuthKind, HostingSelection } from "./hosting-model.js";
import { hostingStartPlan } from "./hosting-model.js";
import type { WizardCopyField, WizardWebviewMessage } from "./protocol.js";
import {
  beginWizard,
  failWizard,
  revise,
  wizardViewState,
  type PersistedWizardState,
  type WizardAccessMode,
  type WizardStateStore,
  type WizardViewState,
} from "./wizard-state.js";

export interface WizardRuntimeResult {
  configPath: string;
  publicUrl: string;
  mcpUrl: string;
}

export interface ResumableWizardRuntime extends WizardRuntimeResult {
  workspace: string;
  hosting?: HostingSelection;
  chatGptConnected?: boolean;
}

export interface WizardControllerDependencies {
  selectWorkspace(): Promise<string | undefined>;
  selectCloudflareCredential(kind: CloudflareAuthKind): Promise<CloudflareCredentialSummary | undefined>;
  confirmFullAccess(): Promise<boolean>;
  provision(workspace: string, hosting: HostingSelection, accessMode: WizardAccessMode): Promise<{ configPath: string }>;
  start(workspace: string, hosting: HostingSelection, accessMode: WizardAccessMode): Promise<WizardRuntimeResult>;
  /** Returns true when pairing already navigated to the requested ChatGPT page. */
  pairOwner(destination: ChatGptDestination): Promise<boolean>;
  openChatGpt(destination: ChatGptDestination): Promise<void>;
  copyText(value: string): Promise<void>;
  registerChatGpt(callbackUrl: string): Promise<ExternalCredentialSummary>;
  credentialValue(field: WizardCopyField, state: Readonly<PersistedWizardState>): Promise<string | undefined>;
  onDidChange(): void;
}

export class WizardController {
  private state: PersistedWizardState;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: WizardStateStore,
    private readonly dependencies: WizardControllerDependencies,
    defaultWorkspace = "",
  ) {
    this.state = store.load(defaultWorkspace);
  }

  restore(defaultWorkspace: string): void {
    this.state = this.store.load(defaultWorkspace);
    if (!this.state.workspace && defaultWorkspace) this.state = revise(this.state, { workspace: defaultWorkspace });
  }

  get viewState(): WizardViewState {
    return wizardViewState(this.state);
  }

  get currentState(): Readonly<PersistedWizardState> {
    return this.state;
  }

  shouldAutoOpen(configured: boolean): boolean {
    return !configured && !this.state.seen;
  }

  open(defaultWorkspace: string): Promise<void> {
    return this.enqueue(async () => {
      await this.commit(beginWizard(this.state, defaultWorkspace));
    });
  }

  /**
   * Continue onboarding from an already running service. This is the normal
   * upgrade/recovery path: the customer must not repeat hosting setup merely
   * because extension state was lost while the managed runtime stayed valid.
   */
  resumeRuntime(runtime: ResumableWizardRuntime, openBrowser = false): Promise<void> {
    return this.enqueue(async () => {
      const normalized = validateResumableRuntime(runtime);
      const sameConfiguration = this.state.configPath === normalized.configPath;
      const sameRuntime = sameConfiguration && this.state.publicUrl === normalized.publicUrl;
      const credential = sameConfiguration ? this.state.credential : undefined;
      const appliedHosting = normalized.hosting || (sameRuntime ? this.state.appliedHosting || this.state.hosting : undefined);
      await this.commit(revise(this.state, {
        seen: true,
        active: true,
        completed: normalized.chatGptConnected,
        phase: normalized.chatGptConnected ? "complete" : credential ? "credentials" : "callback",
        workspace: normalized.workspace,
        configPath: normalized.configPath,
        publicUrl: normalized.publicUrl,
        mcpUrl: normalized.mcpUrl,
        chatGptConnected: normalized.chatGptConnected,
        chatGptPageOpened: false,
        developerModeConfirmed: normalized.chatGptConnected || (sameConfiguration && this.state.developerModeConfirmed === true),
        hosting: appliedHosting,
        appliedHosting,
        appliedConfigPath: normalized.configPath,
        ...(credential ? { credential } : { credential: undefined, callbackUrl: undefined }),
        error: undefined,
      }));
      if (!normalized.chatGptConnected && openBrowser) await this.openChatGpt("security");
    });
  }

  /** Persist a securely discovered runtime without opening onboarding. */
  adoptRuntime(runtime: ResumableWizardRuntime): Promise<void> {
    return this.enqueue(async () => {
      const normalized = validateResumableRuntime(runtime);
      const sameRuntime = this.state.configPath === normalized.configPath && this.state.publicUrl === normalized.publicUrl;
      const appliedHosting = normalized.hosting || (sameRuntime ? this.state.appliedHosting || this.state.hosting : undefined);
      await this.commit(revise(this.state, {
        seen: true,
        workspace: normalized.workspace,
        configPath: normalized.configPath,
        publicUrl: normalized.publicUrl,
        mcpUrl: normalized.mcpUrl,
        hosting: appliedHosting,
        appliedHosting,
        appliedConfigPath: normalized.configPath,
        ...(normalized.chatGptConnected ? { chatGptConnected: true, developerModeConfirmed: true } : {}),
        error: undefined,
      }));
    });
  }

  noteChatGptConnected(): Promise<void> {
    return this.enqueue(async () => {
      if (this.state.chatGptConnected && this.state.phase === "complete" && this.state.completed) return;
      await this.commit(revise(this.state, {
        chatGptConnected: true,
        developerModeConfirmed: true,
        phase: "complete",
        completed: true,
        error: undefined,
      }));
    });
  }

  handle(message: WizardWebviewMessage): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.handleAction(message);
      } catch (error) {
        await this.commit(failWizard(this.state, error));
      }
    });
  }

  private async handleAction(message: WizardWebviewMessage): Promise<void> {
    switch (message.action) {
      case "open":
        await this.commit(beginWizard(this.state, this.state.workspace));
        return;
      case "acceptWorkspace":
        if (!this.state.workspace) throw new Error("Select a project folder before continuing.");
        await this.commit(revise(this.state, { phase: "hosting", error: undefined }));
        return;
      case "chooseWorkspace": {
        const workspace = await this.dependencies.selectWorkspace();
        if (!workspace) return;
        await this.commit(revise(this.state, { workspace, phase: "hosting", error: undefined }));
        return;
      }
      case "chooseCloudflareCredential": {
        const selected = await this.dependencies.selectCloudflareCredential(message.credentialKind);
        if (!selected) return;
        await this.commit(revise(this.state, { cloudflareCredential: selected, error: undefined }));
        return;
      }
      case "configureAndStart":
        await this.configureAndStart(message.hosting, message.accessMode);
        return;
      case "openChatGpt":
        await this.openChatGpt(message.destination);
        return;
      case "confirmDeveloperMode":
        await this.openChatGpt("plugins");
        await this.commit(revise(this.state, { developerModeConfirmed: true, error: undefined }));
        return;
      case "submitCallback":
        await this.registerChatGpt(message.callbackUrl);
        return;
      case "copyCredential": {
        const value = await this.dependencies.credentialValue(message.field, this.state);
        if (!value) throw new Error("The required value is not available in secure storage.");
        await this.dependencies.copyText(value);
        return;
      }
      case "finish":
        if (this.state.phase !== "credentials" && this.state.phase !== "complete") {
          throw new Error("Complete ChatGPT OAuth registration first.");
        }
        await this.commit(revise(this.state, { phase: "complete", completed: true, error: undefined }));
        return;
      case "dismiss":
        await this.commit(revise(this.state, { active: false, error: undefined }));
        return;
      case "retry":
        await this.retry();
        return;
    }
  }

  private async configureAndStart(requestedHosting: HostingSelection, accessMode: WizardAccessMode): Promise<void> {
    if (!this.state.workspace) throw new Error("Select a project folder before starting VSPiLink.");
    let hosting = requestedHosting;
    if (hosting.kind === "cloudflare-named") {
      const credential = this.state.cloudflareCredential;
      if (!credential || credential.kind !== hosting.cloudflareAuthKind) {
        throw new Error("Select the required Cloudflare credential file first.");
      }
      hosting = {
        ...hosting,
        credentialReference: credential.reference,
        credentialLabel: credential.label,
      };
    }
    if (accessMode === "full" && !await this.dependencies.confirmFullAccess()) return;
    await this.commit(revise(this.state, {
      hosting,
      accessMode,
      phase: "provisioning",
      completed: false,
      credential: undefined,
      callbackUrl: undefined,
      publicUrl: undefined,
      mcpUrl: undefined,
      chatGptPageOpened: false,
      developerModeConfirmed: false,
      chatGptConnected: false,
      error: undefined,
    }));
    const provisioned = await this.dependencies.provision(this.state.workspace, hosting, accessMode);
    await this.commit(revise(this.state, { configPath: provisioned.configPath, phase: "starting", error: undefined }));
    const runtime = await this.dependencies.start(this.state.workspace, hosting, accessMode);
    const plan = hostingStartPlan(hosting);
    await this.commit(revise(this.state, {
      configPath: runtime.configPath,
      publicUrl: runtime.publicUrl,
      mcpUrl: runtime.mcpUrl,
      appliedHosting: hosting,
      appliedConfigPath: runtime.configPath,
      phase: plan.public ? "callback" : "complete",
      completed: !plan.public,
      error: undefined,
    }));
    // Public hosting is complete here. Connecting a particular MCP client is
    // an explicit advanced action and must never be opened as onboarding.
  }

  private async openChatGpt(destination: ChatGptDestination): Promise<void> {
    if (!this.state.mcpUrl) throw new Error("The public MCP endpoint is not available yet.");
    const destinationAlreadyOpened = await this.dependencies.pairOwner(destination);
    if (!destinationAlreadyOpened) await this.dependencies.openChatGpt(destination);
    await this.commit(revise(this.state, { chatGptPageOpened: true, error: undefined }));
  }

  private async registerChatGpt(rawCallbackUrl: string): Promise<void> {
    if (this.state.phase !== "callback" && this.state.phase !== "credentials") {
      throw new Error("Start the public VSPiLink endpoint first.");
    }
    const callbackUrl = validateCallbackUrl(rawCallbackUrl);
    const credential = await this.dependencies.registerChatGpt(callbackUrl);
    await this.commit(revise(this.state, {
      callbackUrl,
      credential,
      developerModeConfirmed: true,
      phase: "credentials",
      error: undefined,
    }));
  }

  private async retry(): Promise<void> {
    const failedPhase = this.state.error?.phase;
    if ((failedPhase === "provisioning" || failedPhase === "starting") && this.state.hosting) {
      await this.configureAndStart(this.state.hosting, this.state.accessMode);
      return;
    }
    if (failedPhase === "callback" || failedPhase === "credentials") {
      await this.commit(revise(this.state, { phase: this.state.credential ? "credentials" : "callback", error: undefined }));
      return;
    }
    await this.commit(revise(this.state, { error: undefined }));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.queue.then(operation, operation);
    this.queue = queued.catch(() => undefined);
    return queued;
  }

  private async commit(next: PersistedWizardState): Promise<void> {
    this.state = next;
    await this.store.save(next);
    this.dependencies.onDidChange();
  }
}

export function validateCallbackUrl(value: string): string {
  if (!value || value.length > 2_048 || /[\r\n\0]/.test(value)) throw new Error("Invalid OAuth callback URL.");
  try {
    const url = new URL(value.trim());
    const loopbackHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname);
    if ((url.protocol !== "https:" && !loopbackHttp) || url.username || url.password || !url.hostname) throw new Error();
    return url.toString();
  } catch {
    throw new Error("The OAuth callback URL must use HTTPS. HTTP is allowed only on localhost or another loopback address.");
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}

function validateResumableRuntime(runtime: ResumableWizardRuntime): ResumableWizardRuntime {
  if (!runtime.workspace || !runtime.configPath) throw new Error("The existing VSPiLink configuration is invalid.");
  let publicUrl: URL;
  let mcpUrl: URL;
  try {
    publicUrl = new URL(runtime.publicUrl);
    mcpUrl = new URL(runtime.mcpUrl);
  } catch {
    throw new Error("The existing VSPiLink endpoint is invalid.");
  }
  if (
    publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash ||
    (publicUrl.pathname !== "/" && publicUrl.pathname !== "") ||
    mcpUrl.origin !== publicUrl.origin || mcpUrl.pathname !== "/sse" || mcpUrl.search || mcpUrl.hash
  ) {
    throw new Error("The public VSPiLink endpoint must use HTTPS and end with /sse.");
  }
  return {
    ...runtime,
    workspace: runtime.workspace,
    configPath: runtime.configPath,
    publicUrl: publicUrl.origin,
    mcpUrl: `${publicUrl.origin}/sse`,
    chatGptConnected: runtime.chatGptConnected === true,
  };
}
