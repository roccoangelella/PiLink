import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { AgentAuthSidecar, type AgentAuthCatalog, type AgentAuthEvent, type AgentAuthPrompt, type AgentProviderCatalogEntry } from "./agent-auth.js";
import { agentOAuthMethodChoices, hasConfiguredAgentAuth, inspectAdminAgentRuntime, stableDashboardHealth } from "./chat-runtime.js";
import { chatGptNavigation, type ChatGptDestination } from "./chatgpt-links.js";
import { readConfigSnapshot, resolveConfigPath, localServerUrl, provisionWizardConfiguration, removeEnvValue, updateEnvValue, writePrivateFile, type ConfigSnapshot } from "./configuration.js";
import { CloudflareCredentialVault, type CloudflareCredentialSummary } from "./credential-vault.js";
import { DashboardProvider } from "./dashboard.js";
import { effectiveProcessState } from "./dashboard-model.js";
import { cancelAdminAgentTurn, createOwnerPairing, isLoopbackPortOccupied, readAdminAgentOutput, readAdminAgents, readAdminCollaboration, readAdminStatus, readHealth, sendAdminAgentMessage, spawnAdminAgent, stopAdminAgent, waitForAdminRuntime, waitForHealth, waitForPublicHealth } from "./health.js";
import { hostingStartPlan, normalizeHostingSelection, normalizeMcpEndpointOrigin, type CloudflareAuthKind, type HostingSelection } from "./hosting-model.js";
import { inspectManagedNamedHosting, readManagedUnitRuntimeState, restartManagedServerUnit, validateManagedServerUnit } from "./named-hosting-recovery.js";
import { OAuthClientService, isMcpScope, type McpScope } from "./oauth-client.js";
import { resolveSidecarNodeRuntime, type SidecarNodeRuntime } from "./node-runtime.js";
import { ProcessSupervisor, resolveCliPath, runJsonCli } from "./process-supervisor.js";
import type { DashboardState, WebviewCommand, WebviewCommandMessage, WizardCopyField } from "./protocol.js";
import { DEFAULT_RUNTIME_MODE, isRuntimeMode, RuntimeModeStore, type RuntimeMode } from "./runtime-mode.js";
import { WizardController } from "./wizard-controller.js";
import { WizardStateStore, type PersistedWizardState, type WizardAccessMode } from "./wizard-state.js";

let activeController: ExtensionController | undefined;
const CHAT_AGENT_STATE_KEY = "vspilink.localChat.agentId";
const CHAT_AGENT_LABEL = "VSPiLink Chat";
const ACTIVE_CHAT_STATUSES = new Set(["starting", "running", "waiting", "cancelling", "stopping", "stop_failed"]);

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  activeController = new ExtensionController(context);
  await activeController.activate();
}

export async function deactivate(): Promise<void> {
  await activeController?.dispose();
  activeController = undefined;
}

class ExtensionController {
  private readonly supervisor = new ProcessSupervisor();
  private readonly agentAuth = new AgentAuthSidecar();
  private readonly oauth: OAuthClientService;
  private readonly cloudflareCredentials: CloudflareCredentialVault;
  private readonly mcpChanged = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly dashboard: DashboardProvider;
  private readonly wizard: WizardController;
  private readonly runtimeModeStore: RuntimeModeStore;
  private sidecarNodeCache?: { key: string; runtime: SidecarNodeRuntime };
  private managedHostingCache?: { key: string; expiresAt: number; state: DashboardState["managedHosting"] };
  private namedRecoveryInFlight?: { key: string; promise: Promise<HostingSelection & { kind: "cloudflare-named" }> };
  private agentCatalogCache?: { key: string; expiresAt: number; catalog: AgentAuthCatalog };
  private activeChatAgentId?: string;
  private selectedWorkspacePath?: string;
  private chatSelectionGeneration = 0;
  private readonly dismissedChatAgentIds = new Set<string>();
  private chatSetupInFlight?: Promise<boolean>;
  private chatCommandBusy = false;
  private collaborationMonitor?: { terminal: vscode.Terminal; configPath: string; workspace: string };
  private disposing = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.activeChatAgentId = context.workspaceState.get<string>(CHAT_AGENT_STATE_KEY);
    this.runtimeModeStore = new RuntimeModeStore(context.workspaceState);
    this.oauth = new OAuthClientService(context.secrets);
    this.cloudflareCredentials = new CloudflareCredentialVault(context.secrets);
    this.wizard = new WizardController(
      new WizardStateStore(context.workspaceState),
      {
        selectWorkspace: () => this.selectWorkspace(undefined, true),
        selectCloudflareCredential: (kind) => this.selectCloudflareCredential(kind),
        confirmFullAccess: () => this.confirmWizardFullAccess(),
        provision: (workspace, hosting, accessMode) => this.provisionWizard(workspace, hosting, accessMode),
        start: (workspace, hosting, accessMode) => this.startWizardRuntime(workspace, hosting, accessMode),
        pairOwner: (destination) => this.pairWizardOwner(destination),
        openChatGpt: (destination) => this.openChatGpt(destination),
        copyText: async (value) => { await vscode.env.clipboard.writeText(value); },
        registerChatGpt: (callbackUrl) => this.registerChatGpt(callbackUrl),
        credentialValue: (field, state) => this.wizardCredentialValue(field, state),
        onDidChange: () => void this.dashboard?.refresh(),
      },
      this.defaultWorkspacePath() || "",
    );
    this.dashboard = new DashboardProvider(
      context.extensionUri,
      () => this.dashboardState(),
      (message) => this.handleWebviewCommand(message),
    );
  }

  async activate(): Promise<void> {
    await this.runtimeModeStore.migrate();
    this.registerViews();
    this.registerCommands();
    this.registerNativeMcpProvider();

    this.disposables.push(
      this.supervisor.onDidChange(() => {
        this.mcpChanged.fire();
        void this.dashboard.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("vspilink")) return;
        if (event.affectsConfiguration("vspilink.nodeExecutable")) this.sidecarNodeCache = undefined;
        this.mcpChanged.fire();
        void this.dashboard.refresh();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.dashboard.refresh()),
      vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal === this.collaborationMonitor?.terminal) this.collaborationMonitor = undefined;
      }),
    );

    this.wizard.restore(this.defaultWorkspacePath() || "");
    const installedVersion = String(this.context.extension.packageJSON.version || "0");
    const lastOpenedVersion = this.context.globalState.get<string>("vspilink.lastOpenedVersion");
    const firstOpenForVersion = lastOpenedVersion !== installedVersion;
    if (firstOpenForVersion) await this.context.globalState.update("vspilink.lastOpenedVersion", installedVersion);
    if (!this.snapshot().configured || firstOpenForVersion) {
      await this.openSidebar();
    } else if (vscode.workspace.getConfiguration("vspilink").get<boolean>("openOnStartup", false)) {
      await this.openSidebar();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    this.dashboard.dispose();
    this.agentAuth.dispose();
    this.mcpChanged.dispose();
    this.collaborationMonitor?.terminal.dispose();
    this.collaborationMonitor = undefined;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    await this.supervisor.disposeAsync();
  }

  private registerViews(): void {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider("vspilink.sidebarSecondaryView", this.dashboard, { webviewOptions: { retainContextWhenHidden: false } }),
    );
  }

  private registerCommands(): void {
    const register = (name: string, callback: (...args: unknown[]) => unknown) => {
      this.disposables.push(vscode.commands.registerCommand(`vspilink.${name}`, callback));
    };
    register("openSidebar", () => this.openSidebar());
    register("openPanel", () => this.dashboard.openPanel());
    register("initialize", (resource) => this.initialize(resource instanceof vscode.Uri ? resource : undefined));
    register("start", () => this.startConfigured());
    register("startUnsafe", () => this.startUnsafe());
    register("guidedSetup", () => this.guidedSetup());
    register("legacySetup", () => this.legacySetup());
    register("serve", () => this.serveConfigured());
    register("stop", () => this.stopConfigured());
    register("restart", () => this.restartConfigured());
    register("openConfig", () => this.openConfig());
    register("copyMcpUrl", () => this.copyMcpUrl());
    register("registerClient", () => this.registerClient());
    register("connectNativeMcp", () => this.connectNativeMcp());
    register("disconnectNativeMcp", () => this.disconnectNativeMcp());
    register("showTerminal", () => this.showTerminal());
    register("openCollaborationMonitor", () => this.openCollaborationMonitor());
    register("reset", () => this.reset());
    register("refresh", () => this.dashboard.refresh());
    register("manageTrust", () => vscode.commands.executeCommand("workbench.trust.manage"));
    register("connectChatGpt", () => this.connectChatGpt());
    register("openChatGpt", () => this.openChatGptInVsCode());
    register("setupChat", () => this.setupChat());
    register("sendChat", (value) => this.sendChat(typeof value === "string" ? value : ""));
    register("cancelChat", () => this.cancelChat());
    register("newChat", () => this.newChat());
    register("useWorkspace", (resource) => this.useWorkspace(resource instanceof vscode.Uri ? resource : undefined));
    register("openDocs", () => this.openDocs());
    register("configureAgents", () => this.configureAgents());
    register("logoutAgent", () => this.logoutAgent());
    register("spawnAgent", () => this.spawnAgent());
    register("stopAgent", (agentId) => this.stopAgent(typeof agentId === "string" ? agentId : ""));
    register("viewAgentOutput", (agentId) => this.viewAgentOutput(typeof agentId === "string" ? agentId : ""));
    register("selectRuntimeMode", (mode) => this.selectRuntimeMode(typeof mode === "string" ? mode : ""));
  }

  private registerNativeMcpProvider(): void {
    const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
      onDidChangeMcpServerDefinitions: this.mcpChanged.event,
      provideMcpServerDefinitions: async () => {
        const snapshot = this.snapshot();
        if (!snapshot.configured || !vscode.workspace.isTrusted) return [];
        const scope = this.nativeScope();
        const approvedScope = await this.oauth.approvedNativeScope(snapshot.configPath);
        if (approvedScope !== scope) return [];
        const token = await this.oauth.storedNativeToken(snapshot.configPath, scope);
        if (!token) return [];
        return [new vscode.McpHttpServerDefinition(
          "VSPiLink",
          vscode.Uri.parse(`${localServerUrl(snapshot)}/sse`),
          { Authorization: `Bearer ${token}` },
          this.mcpVersion(snapshot, scope),
        )];
      },
      resolveMcpServerDefinition: async (server) => {
        this.requireTrustedWorkspace();
        const snapshot = this.snapshot();
        const health = await readHealth(snapshot.port);
        if (!health.online) throw new Error("VSPiLink is unreachable. Start it from the sidebar before using MCP tools.");
        const scope = this.nativeScope();
        const approvedScope = await this.oauth.approvedNativeScope(snapshot.configPath);
        if (approvedScope !== scope) {
          throw new Error(`The ${scope} scope requires explicit approval. Run “Connect to VS Code Agents” from the VSPiLink sidebar.`);
        }
        const token = await this.oauth.refreshNative(snapshot, scope);
        server.uri = vscode.Uri.parse(`${localServerUrl(snapshot)}/sse`);
        server.headers = { Authorization: `Bearer ${token}` };
        server.version = this.mcpVersion(snapshot, scope);
        return server;
      },
    };
    this.disposables.push(vscode.lm.registerMcpServerDefinitionProvider("vspilink.mcp", provider));
  }

  private async dashboardState(): Promise<DashboardState> {
    const snapshot = this.snapshot();
    const [health, managedHosting] = await Promise.all([
      readHealth(snapshot.port),
      this.managedHostingState(snapshot),
    ]);
    const nativeScope = this.nativeScope();
    const approvedNativeScope = await this.oauth.approvedNativeScope(snapshot.configPath);
    const nativeConnected = approvedNativeScope === nativeScope && Boolean(await this.oauth.storedNativeToken(snapshot.configPath, nativeScope));
    const mayUseTransientPublicUrl = snapshot.hostingMode === "quick-tunnel" || snapshot.hostingMode === "nip-io";
    const publicUrl = (
      (managedHosting.configured ? managedHosting.publicUrl : undefined) ||
      (mayUseTransientPublicUrl ? this.supervisor.capturedPublicUrl : undefined) ||
      snapshot.serverUrl ||
      localServerUrl(snapshot)
    ).replace(/\/$/, "");
    const unsafeRunning = this.supervisor.viewState.mode?.toLocaleLowerCase().includes("full access") ?? false;
    const sidecarNode = this.sidecarNodeRuntime();
    const adminStatus = health.online && snapshot.bootstrapSecret
      ? await readAdminStatus(snapshot.port, snapshot.bootstrapSecret)
      : { online: false, chatGptConnected: false, activeSessions: 0, payload: null };
    const persistedChatGptClients = snapshot.clients.filter((client) => client.chatGpt);
    const chatGptActive = adminStatus.chatGptConnected;
    const chatGptConfigured = persistedChatGptClients.length > 0 || chatGptActive;
    const chatGptAuthorized = persistedChatGptClients.some((client) => client.authorized);
    const chatGptConnected = chatGptAuthorized || chatGptActive;
    const collaborationPromise = adminStatus.online && snapshot.bootstrapSecret
      ? readAdminCollaboration(snapshot.port, snapshot.bootstrapSecret).then(
          (value) => ({ available: true as const, ...value }),
          (error: unknown) => ({
            available: false as const,
            latestCursor: 0,
            messages: [],
            tasks: [],
            activity: [],
            clients: [],
            error: error instanceof Error ? error.message : "The collaboration monitor is unavailable",
          }),
        )
      : Promise.resolve({
          available: false as const,
          latestCursor: 0,
          messages: [],
          tasks: [],
          activity: [],
          clients: [],
        });
    const agentRuntime = await this.agentRuntimeState(snapshot, adminStatus.payload, adminStatus.online);
    const [chat, collaboration] = await Promise.all([
      this.localChatState(snapshot, agentRuntime.agents, adminStatus.online),
      collaborationPromise,
    ]);
    if (chatGptConnected) await this.wizard.noteChatGptConnected();
    const processState = effectiveProcessState(
      this.supervisor.viewState,
      adminStatus.online,
      managedHosting.serverState,
      managedHosting.tunnelState,
    );
    const configuredRuntimeMode = this.runtimeModeStore.load() || runtimeModeFromConfig(snapshot.values.PI_RUNTIME_MODE);
    const runtimeMode = configuredRuntimeMode || DEFAULT_RUNTIME_MODE;
    return {
      runtimeMode: {
        mode: runtimeMode,
        configured: configuredRuntimeMode !== undefined,
      },
      configured: snapshot.configured,
      trusted: vscode.workspace.isTrusted,
      workspace: snapshot.workspace,
      configPath: snapshot.configPath,
      process: processState,
      health: health.online
        ? { online: true, ...stableDashboardHealth(health.payload) }
        : { online: false, ...(health.error ? { error: health.error } : {}) },
      hostingMode: snapshot.hostingMode,
      unsafeFullAccess: unsafeRunning || snapshot.unsafeFullAccess,
      fullAccessClientCount: snapshot.fullAccessClientIds.includes("*")
        ? snapshot.clients.length
        : snapshot.fullAccessClientIds.length,
      mcpUrl: `${publicUrl}/sse`,
      publicUrl,
      oauthEndpoints: {
        authorization: `${publicUrl}/oauth/authorize`,
        token: `${publicUrl}/oauth/token`,
        registration: `${publicUrl}/oauth/register`,
      },
      clients: snapshot.clients,
      logs: this.supervisor.logs,
      nativeMcp: { connected: nativeConnected, scope: nativeScope },
      externalMcp: {
        configured: chatGptConfigured,
        authorized: chatGptAuthorized,
        active: chatGptActive,
        connected: chatGptConnected,
        activeSessions: adminStatus.activeSessions,
      },
      collaboration,
      managedHosting,
      agentRuntime,
      chat,
      wizard: this.wizard.viewState,
      version: String(this.context.extension.packageJSON.version || "1.1.0"),
      nodeVersion: sidecarNode.version || "not detected",
      ...(!sidecarNode.ok ? { error: sidecarNode.error } : {}),
    };
  }

  private async handleWebviewCommand(message: WebviewCommandMessage): Promise<void> {
    if (message.type === "wizard") {
      await this.wizard.handle(message);
      return;
    }
    if (message.type !== "command") return;
    if (message.command === "sendInput") {
      this.supervisor.sendLine(message.value || "");
      return;
    }
    const commandMap: Record<Exclude<WebviewCommand, "sendInput">, string> = {
      refresh: "vspilink.refresh",
      selectRuntimeMode: "vspilink.selectRuntimeMode",
      manageTrust: "vspilink.manageTrust",
      connectChatGpt: "vspilink.connectChatGpt",
      openChatGpt: "vspilink.openChatGpt",
      setupChat: "vspilink.setupChat",
      sendChat: "vspilink.sendChat",
      cancelChat: "vspilink.cancelChat",
      newChat: "vspilink.newChat",
      initialize: "vspilink.initialize",
      start: "vspilink.start",
      startUnsafe: "vspilink.startUnsafe",
      guidedSetup: "vspilink.guidedSetup",
      legacySetup: "vspilink.legacySetup",
      serve: "vspilink.serve",
      stop: "vspilink.stop",
      restart: "vspilink.restart",
      openConfig: "vspilink.openConfig",
      copyMcpUrl: "vspilink.copyMcpUrl",
      registerClient: "vspilink.registerClient",
      connectNativeMcp: "vspilink.connectNativeMcp",
      disconnectNativeMcp: "vspilink.disconnectNativeMcp",
      openTerminal: "vspilink.showTerminal",
      openCollaborationMonitor: "vspilink.openCollaborationMonitor",
      openPanel: "vspilink.openPanel",
      reset: "vspilink.reset",
      useWorkspace: "vspilink.useWorkspace",
      openDocs: "vspilink.openDocs",
      configureAgents: "vspilink.configureAgents",
      logoutAgent: "vspilink.logoutAgent",
      spawnAgent: "vspilink.spawnAgent",
      stopAgent: "vspilink.stopAgent",
      viewAgentOutput: "vspilink.viewAgentOutput",
    };
    await vscode.commands.executeCommand(commandMap[message.command], message.value);
  }

  /**
   * Persist the server workflow independently from the ChatGPT MCP/Pi Local
   * presentation toggle. Selecting collaboration is an explicit consent
   * point; it never publishes an endpoint or changes OAuth credentials by
   * itself.
   */
  private async selectRuntimeMode(value: string): Promise<void> {
    this.requireTrustedWorkspace();
    let mode: RuntimeMode;
    if (isRuntimeMode(value)) {
      mode = value;
    } else {
      const selected = await vscode.window.showQuickPick([
        {
          label: "Single-agent",
          description: "Classic Pi chat · safe local default",
          detail: "One supervised Pi agent works in the selected workspace; shared orchestration is disabled.",
          value: "single" as const,
        },
        {
          label: "Public chat & orchestration",
          description: "ChatGPT MCP coordination",
          detail: "Authenticated MCP clients may use shared chat, tasks, and agent supervision; hosting and OAuth remain separate.",
          value: "collaboration" as const,
        },
      ], { title: "Choose the PiLink workflow", placeHolder: "Select the server capability boundary" });
      if (!selected) return;
      mode = selected.value;
    }

    const snapshot = this.snapshot();
    const current = this.runtimeModeStore.load() || runtimeModeFromConfig(snapshot.values.PI_RUNTIME_MODE);
    if (current === mode && this.runtimeModeStore.load() !== undefined) {
      await this.dashboard.refresh();
      return;
    }

    if (mode === "collaboration" && current !== "collaboration") {
      const confirmation = await vscode.window.showWarningMessage(
        "Enable the Public chat & orchestration workflow?",
        {
          modal: true,
          detail: "This enables collaboration tools for authenticated MCP clients and stores shared coordination state outside the workspace. It does not create a public endpoint, grant Full access, or connect ChatGPT automatically. Hosting and OAuth remain separate steps.",
        },
        "Enable collaboration",
      );
      if (confirmation !== "Enable collaboration") return;
    }

    const health = snapshot.configured ? await readHealth(snapshot.port, 2_000) : { online: false };
    const supervised = this.supervisor.isActive;
    const managed = snapshot.hostingMode === "cloudflare-named" && health.online;
    const externallyRunning = health.online && !supervised && !managed;
    const running = supervised || managed || externallyRunning;
    const needsRestart = running && current !== mode;
    if (externallyRunning && needsRestart) {
      void vscode.window.showWarningMessage(
        "VSPiLink is running outside this VS Code session. Stop that instance before changing its runtime workflow.",
        { modal: true, detail: "The configuration was not changed, so the active service keeps its current PI_RUNTIME_MODE." },
      );
      return;
    }
    if (needsRestart) {
      const confirmation = await vscode.window.showWarningMessage(
        `Apply the VSPiLink ${runtimeModeLabel(mode)} workflow to the active service?`,
        {
          modal: true,
          detail: "The active service must restart to apply PI_RUNTIME_MODE. Existing local chat turns and MCP sessions will be interrupted; OAuth client records and secrets remain unchanged.",
        },
        "Switch and restart",
      );
      if (confirmation !== "Switch and restart") return;
    }

    this.updateRuntimeModeConfig(snapshot, mode);
    await this.runtimeModeStore.set(mode);

    if (needsRestart) {
      if (snapshot.hostingMode === "cloudflare-named") {
        await this.restartConfigured();
      } else {
        await this.supervisor.stop();
        await this.startConfigured();
      }
    }
    this.mcpChanged.fire();
    await this.dashboard.refresh();
    void vscode.window.showInformationMessage(`PiLink workflow: ${runtimeModeLabel(mode)}.`);
  }

  private updateRuntimeModeConfig(snapshot: ConfigSnapshot, mode: RuntimeMode): void {
    if (!snapshot.configured) return;
    const contents = fs.readFileSync(snapshot.configPath, "utf8");
    writePrivateFile(snapshot.configPath, updateEnvValue(contents, "PI_RUNTIME_MODE", mode));
  }

  private async openSidebar(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.view.extension.vspilinkSecondaryViewContainer");
    } catch {
      this.dashboard.openPanel();
    }
  }

  private async initialize(resource?: vscode.Uri): Promise<void> {
    this.requireTrustedWorkspace();
    const target = await this.selectWorkspace(resource);
    if (!target) return;
    const snapshot = this.snapshot(target);
    if (snapshot.configured) {
      const action = await vscode.window.showInformationMessage(
        `A PiLink configuration already exists at ${snapshot.configPath}.`,
        "Open configuration",
        "Separate setup or reset",
      );
      if (action === "Open configuration") await this.openConfig();
      if (action === "Separate setup or reset") await this.guidedSetup();
      return;
    }
    await this.runCli(["init"], "Initialization", true, target);
  }

  private async startUnsafe(): Promise<void> {
    this.requireTrustedWorkspace();
    if (!await this.ensureRuntimeModeSelection()) return;
    const snapshot = this.snapshot();
    if (!snapshot.configured) throw new Error("Configure VSPiLink before enabling Full access.");
    const eligibleClients = snapshot.clients.filter((client) => (
      client.grantTypes.includes("authorization_code") && client.scope.split(/\s+/u).includes("mcp:tools")
    ));
    if (eligibleClients.length === 0) {
      throw new Error("Connect ChatGPT to VSPiLink first. Full access is assigned to one specific OAuth client, never to every client.");
    }
    const selected = eligibleClients.length === 1
      ? eligibleClients[0]
      : await vscode.window.showQuickPick(eligibleClients.map((client) => ({
          label: client.name,
          description: client.id,
          detail: "Only this client will be allowed to use the global file system and shell.",
          value: client,
          picked: /chatgpt/iu.test(client.name),
        })), {
          title: "Full access · choose the ChatGPT client",
          placeHolder: "Select exactly which connection may control VSPiLink",
        }).then((choice) => choice?.value);
    if (!selected) return;
    const confirmation = await vscode.window.showWarningMessage(
      `Grant Full access to “${selected.name}” (${selected.id})?`,
      {
        modal: true,
        detail: "This is equivalent to a coding agent's Full access mode. The client can read and change files outside the workspace and run commands as the service user. It does not grant root privileges or authorize any other OAuth client.",
      },
      "Authorize this client",
    );
    if (confirmation !== "Authorize this client") return;

    this.writeFullAccessConfiguration(snapshot, selected.id, false);
    if (snapshot.hostingMode === "cloudflare-named") {
      await this.restartManagedChatServer(this.snapshot(snapshot.workspace));
      const health = await waitForHealth(snapshot.port, 120_000);
      if (!health.online) throw new Error(`PiLink did not restart with Full access: ${health.error || "timeout"}`);
    } else {
      if (this.supervisor.isActive) await this.supervisor.stop();
      await this.runCli(
        ["start", "--allow-unsafe-full-access"],
        `Tunnel · Full access · ${selected.name}`,
        false,
        snapshot.workspace,
        { PI_FULL_ACCESS_CLIENT_IDS: selected.id },
      );
    }
    this.mcpChanged.fire();
    await this.dashboard.refresh();
    void vscode.window.showInformationMessage(`Full access is active only for ${selected.name}.`);
  }

  private writeFullAccessConfiguration(snapshot: ConfigSnapshot, clientId: string, requireApproval: boolean): void {
    if (!/^pi_[a-f0-9]{16}$/iu.test(clientId)) throw new Error("Invalid OAuth client identifier.");
    let contents = fs.readFileSync(snapshot.configPath, "utf8");
    const ids = [...new Set([...snapshot.fullAccessClientIds.filter((id) => id !== "*"), clientId])];
    contents = updateEnvValue(contents, "PI_UNSAFE_FULL_ACCESS", "true");
    contents = updateEnvValue(contents, "PI_FULL_ACCESS_CLIENT_IDS", ids.join(","));
    contents = updateEnvValue(contents, "PI_REQUIRE_EXECUTION_APPROVAL", requireApproval ? "true" : "false");
    writePrivateFile(snapshot.configPath, contents.endsWith("\n") ? contents : `${contents}\n`);
  }

  private async guidedSetup(): Promise<void> {
    this.requireTrustedWorkspace();
    if (!await this.ensureRuntimeModeSelection()) return;
    const workspace = await this.selectWorkspace();
    if (!workspace) return;
    const selected = await vscode.window.showQuickPick([
      {
        label: "Cloudflare fixed domain (Named Tunnel)",
        description: "Stable SSE/OAuth URL · PiLink provisions the tunnel and DNS from a scoped API token",
        value: "cloudflare-fixed" as const,
      },
      {
        label: "Managed Cloudflare Named Tunnel",
        description: "Advanced Linux deployment · managed DNS and persistent systemd services",
        value: "cloudflare-named" as const,
      },
      {
        label: "Existing HTTPS domain",
        description: "Stable endpoint through an existing managed reverse proxy",
        value: "custom-domain" as const,
      },
      {
        label: "Cloudflare Quick Tunnel",
        description: "Quick trial · the address and connection change after restart",
        value: "quick-tunnel" as const,
      },
      {
        label: "Local only · optional Pi chat",
        description: "No remote ChatGPT connection; use only the local Pi chat",
        value: "local" as const,
      },
      {
        label: "HTTPS nip.io legacy",
        description: "Router and IPv4 configuration in the managed terminal",
        value: "nip-io" as const,
      },
    ], {
      title: "Connect ChatGPT · 1 of 2 · MCP endpoint",
      placeHolder: "Choose a public HTTPS endpoint for ChatGPT. Local only is an alternative mode.",
    });
    if (!selected) return;
    if (selected.value === "nip-io") {
      await this.legacySetup();
      return;
    }

    const access = await vscode.window.showQuickPick([
      {
        label: "Project folder only",
        description: "Recommended · files are confined and shell access is disabled",
        value: "workspace" as const,
      },
      {
        label: "Full access",
        description: "High risk · global file system and process execution",
        value: "full" as const,
      },
    ], {
      title: "Advanced VSPiLink · 2 of 2 · Permissions",
      placeHolder: "Choose the boundary enforced for MCP clients",
    });
    if (!access) return;
    if (access.value === "full" && !await this.confirmWizardFullAccess()) return;
    const hosting = await this.collectHostingSelection(selected.value, workspace);
    if (!hosting) return;

    const runtime = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Configure the PiLink MCP server",
      cancellable: false,
    }, async (progress) => {
      progress.report({ message: "Preparing the private configuration…" });
      await this.provisionWizard(workspace, hosting, access.value);
      progress.report({ message: "Starting and checking the service…" });
      return this.startWizardRuntime(workspace, hosting, access.value);
    });

    if (/^https:\/\//iu.test(runtime.publicUrl)) {
      await this.wizard.adoptRuntime({
        workspace,
        configPath: runtime.configPath,
        publicUrl: runtime.publicUrl,
        mcpUrl: runtime.mcpUrl,
        hosting,
      });
      this.mcpChanged.fire();
      await this.dashboard.refresh();
      await this.connectChatGpt();
      return;
    }
    this.mcpChanged.fire();
    await this.dashboard.refresh();
    const action = await vscode.window.showInformationMessage(
      `MCP server ready: ${runtime.mcpUrl}`,
      "Copy endpoint",
    );
    if (action === "Copy endpoint") await vscode.env.clipboard.writeText(runtime.mcpUrl);
  }

  private async provisionFixedDomainViaCli(
    workspace: string,
    publicUrl: string,
    apiToken: string,
  ): Promise<{ tunnelId: string; credential: CloudflareCredentialSummary }> {
    const snapshot = this.snapshot(workspace);
    const cliPath = resolveCliPath(this.context.extensionPath);
    if (!fs.existsSync(cliPath)) throw new Error(`PiLink runtime not found at ${cliPath}. Run npm run build.`);
    const sidecarNode = this.sidecarNodeRuntime();
    if (!sidecarNode.ok) throw new Error(sidecarNode.error);
    const origin = `http://127.0.0.1:${snapshot.port}`;
    const tokenDirectory = path.join(path.dirname(snapshot.configPath), "cloudflare");
    const envelope = await runJsonCli({
      nodeExecutable: sidecarNode.executable,
      cliPath,
      args: [
        "hosting",
        "fixed-domain-provision",
        "--hostname",
        new URL(publicUrl).hostname,
        "--origin",
        origin,
        "--token-dir",
        tokenDirectory,
      ],
      cwd: workspace,
      configPath: snapshot.configPath,
      environment: { CLOUDFLARE_API_TOKEN: apiToken },
      timeoutMs: 120_000,
    });
    const result = jsonObject(envelope.result);
    const tunnelId = typeof result?.tunnelId === "string" ? result.tunnelId : "";
    if (validateTunnelId(tunnelId)) throw new Error("Cloudflare provisioning returned an invalid tunnel UUID.");
    const tokenFile = typeof result?.tokenFile === "string" ? result.tokenFile : "";
    if (!tokenFile || !path.isAbsolute(tokenFile) || /[\r\n\0]/u.test(tokenFile)) {
      throw new Error("Cloudflare provisioning returned an invalid tunnel-token file path.");
    }
    const credential = await this.cloudflareCredentials.store("tunnel-token-file", tokenFile);
    return { tunnelId, credential };
  }

  private async collectHostingSelection(
    kind: Exclude<HostingSelection["kind"], "nip-io">,
    workspace: string,
  ): Promise<HostingSelection | undefined> {
    if (kind === "local" || kind === "quick-tunnel") return { kind };
    if (kind === "cloudflare-fixed") {
      const publicUrl = await vscode.window.showInputBox({
        title: "Fixed Cloudflare HTTPS origin",
        prompt: "Enter a hostname in a DNS zone already managed by your Cloudflare account. Do not include /sse.",
        placeHolder: "https://mcp.example.com",
        ignoreFocusOut: true,
        validateInput: validatePublicHttpsOrigin,
      });
      if (!publicUrl) return undefined;
      const apiToken = await vscode.window.showInputBox({
        title: "Cloudflare API token",
        prompt: "Use a scoped token with Account · Cloudflare Tunnel · Edit, Zone · DNS · Edit, and Zone · Zone · Read. PiLink uses it once for provisioning and does not save it.",
        placeHolder: "Paste the scoped Cloudflare API token",
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => value.trim().length >= 20 && value.trim().length <= 512 && !/\\s/u.test(value.trim())
          ? undefined
          : "Enter the scoped Cloudflare API token.",
      });
      if (!apiToken) return undefined;
      const provisioned = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Provision Cloudflare fixed domain",
        cancellable: false,
      }, () => this.provisionFixedDomainViaCli(workspace, publicUrl, apiToken));
      const normalized = normalizeHostingSelection({
        kind,
        publicUrl,
        tunnelId: provisioned.tunnelId,
        cloudflareAuthKind: "tunnel-token-file",
        credentialReference: provisioned.credential.reference,
        credentialLabel: provisioned.credential.label,
      }, true);
      if (!normalized) throw new Error("Invalid Cloudflare fixed-domain configuration.");
      return normalized;
    }
    if (kind === "custom-domain") {
      const publicUrl = await vscode.window.showInputBox({
        title: "Public HTTPS origin",
        prompt: "Enter only the scheme and hostname, without /sse, a query, or a port.",
        placeHolder: "https://mcp.example.com",
        ignoreFocusOut: true,
        validateInput: validatePublicHttpsOrigin,
      });
      if (!publicUrl) return undefined;
      const landingHostname = await vscode.window.showInputBox({
        title: "Public page hostname (optional)",
        prompt: "Leave this empty if you do not use a separate landing page.",
        placeHolder: "vspilink.example.com",
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? validateDnsHostname(value) : undefined,
      });
      if (landingHostname === undefined) return undefined;
      const normalized = normalizeHostingSelection({
        kind,
        publicUrl,
        ...(landingHostname.trim() ? { landingHostname: landingHostname.trim() } : {}),
      });
      if (!normalized) throw new Error("Invalid HTTPS domain or landing-page hostname.");
      return normalized;
    }

    const tunnelName = await vscode.window.showInputBox({
      title: "Cloudflare tunnel name",
      value: "vspilink",
      placeHolder: "vspilink-client",
      ignoreFocusOut: true,
      validateInput: validateTunnelName,
    });
    if (!tunnelName) return undefined;
    const zoneName = await vscode.window.showInputBox({
      title: "Cloudflare DNS zone",
      placeHolder: "example.com",
      ignoreFocusOut: true,
      validateInput: validateDnsHostname,
    });
    if (!zoneName) return undefined;
    const mcpHostname = await vscode.window.showInputBox({
      title: "MCP server hostname",
      value: `mcp.${zoneName.trim().toLowerCase()}`,
      placeHolder: "mcp.example.com",
      ignoreFocusOut: true,
      validateInput: (value) => validateHostnameInZone(value, zoneName),
    });
    if (!mcpHostname) return undefined;
    const landingHostname = await vscode.window.showInputBox({
      title: "PiLink page hostname",
      value: `vspilink.${zoneName.trim().toLowerCase()}`,
      placeHolder: "vspilink.example.com",
      ignoreFocusOut: true,
      validateInput: (value) => {
        const invalid = validateHostnameInZone(value, zoneName);
        if (invalid) return invalid;
        return value.trim().toLowerCase() === mcpHostname.trim().toLowerCase()
          ? "Use a different hostname from the MCP server hostname."
          : undefined;
      },
    });
    if (!landingHostname) return undefined;
    const auth = await vscode.window.showQuickPick([
      {
        label: "Cloudflare account certificate",
        description: "VSPiLink creates the tunnel and DNS records",
        value: "origin-certificate" as const,
      },
      {
        label: "Token file for an existing tunnel",
        description: "Also requires the tunnel UUID",
        value: "tunnel-token-file" as const,
      },
    ], { title: "Cloudflare credential", placeHolder: "The credential remains local" });
    if (!auth) return undefined;
    const credential = await this.selectCloudflareCredential(auth.value);
    if (!credential) return undefined;
    let tunnelId: string | undefined;
    if (auth.value === "tunnel-token-file") {
      tunnelId = await vscode.window.showInputBox({
        title: "Existing tunnel UUID",
        placeHolder: "00000000-0000-4000-8000-000000000000",
        ignoreFocusOut: true,
        validateInput: validateTunnelId,
      });
      if (!tunnelId) return undefined;
    }
    const normalized = normalizeHostingSelection({
      kind,
      tunnelName,
      zoneName,
      mcpHostname,
      landingHostname,
      cloudflareAuthKind: auth.value,
      ...(tunnelId ? { tunnelId } : {}),
      credentialReference: credential.reference,
      credentialLabel: credential.label,
    }, true);
    if (!normalized) throw new Error("Invalid Cloudflare Named Tunnel configuration.");
    return normalized;
  }

  private async legacySetup(): Promise<void> {
    this.requireTrustedWorkspace();
    if (!await this.ensureRuntimeModeSelection()) return;
    const action = await vscode.window.showWarningMessage(
      "Legacy setup may create a separate instance or reset existing generated state. Your answers will be entered in the VSPiLink terminal.",
      { modal: true },
      "Continue in terminal",
    );
    if (action !== "Continue in terminal") return;
    await this.runCli(["start", "--setup"], "Guided setup");
  }

  private async reset(): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    if (this.supervisor.isActive || snapshot.hostingMode === "cloudflare-named") {
      const action = await vscode.window.showWarningMessage(
        snapshot.hostingMode === "cloudflare-named"
          ? "Stop the persistent VSPiLink and Cloudflare services before resetting?"
          : "Stop the PiLink process before resetting?",
        { modal: true },
        "Stop and continue",
      );
      if (action !== "Stop and continue") return;
      await this.stopConfigured();
      if (snapshot.hostingMode === "cloudflare-named") {
        await this.runNamedHostingCli("disable", await this.ensureNamedHostingSelection(snapshot), snapshot, true);
        this.invalidateManagedHosting();
      }
    }
    await this.runCli(["reset"], "Interactive reset");
  }

  private async openConfig(): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    if (!snapshot.configured) {
      const action = await vscode.window.showInformationMessage("VSPiLink is not configured yet.", "Initialize");
      if (action === "Initialize") await this.initialize();
      return;
    }
    const document = await vscode.workspace.openTextDocument(snapshot.configPath);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async copyMcpUrl(): Promise<void> {
    const state = await this.dashboardState();
    await vscode.env.clipboard.writeText(state.mcpUrl);
    void vscode.window.showInformationMessage(`MCP URL copied: ${state.mcpUrl}`);
  }

  private async registerClient(): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    if (!snapshot.configured) throw new Error("Initialize VSPiLink before registering an OAuth client.");
    const health = await readHealth(snapshot.port);
    if (!health.online) throw new Error("Start PiLink before registering an OAuth client.");

    const grant = await vscode.window.showQuickPick([
      { label: "Authorization Code + PKCE", description: "Browser sign-in with consent; a redirect URI is required", value: "authorization_code" },
      { label: "Client Credentials", description: "Machine-to-machine authentication", value: "client_credentials" },
    ], { title: "OAuth flow", placeHolder: "Choose the grant type to store for this client" });
    if (!grant) return;
    const name = await vscode.window.showInputBox({
      title: "OAuth client name",
      prompt: "This name will appear on the consent page.",
      value: "MCP client",
      validateInput: (value) => value.trim() ? undefined : "Enter a name.",
    });
    if (!name) return;
    const scope = await vscode.window.showQuickPick([
      { label: "mcp:read", description: "Read and search", value: "mcp:read" },
      { label: "mcp:write", description: "Mutation tools only", value: "mcp:write" },
      { label: "mcp:tools", description: "All tools allowed by the server", value: "mcp:tools" },
    ], { title: "Scope OAuth" });
    if (!scope) return;

    let redirectUris: string[] = [];
    if (grant.value === "authorization_code") {
      const input = await vscode.window.showInputBox({
        title: "Redirect URI OAuth",
        prompt: "Separate multiple URIs with commas. Only absolute HTTP(S) URLs are accepted.",
        validateInput: validateRedirectUris,
      });
      if (!input) return;
      redirectUris = input.split(",").map((value) => value.trim()).filter(Boolean);
    }

    if (scope.value !== "mcp:read") {
      const approval = await vscode.window.showWarningMessage(
        `This client will receive ${scope.value}. Register it only if you trust it.`,
        { modal: true },
        "Register client",
      );
      if (approval !== "Register client") return;
    }
    const authorizationCode = grant.value === "authorization_code";
    const client = await this.oauth.registerExternalClient(snapshot, {
      clientName: name.trim(),
      grantTypes: authorizationCode ? ["authorization_code", "refresh_token"] : ["client_credentials"],
      redirectUris,
      allowedScope: authorizationCode ? `${scope.value} offline_access` : scope.value,
      tokenEndpointAuthMethod: "client_secret_post",
    });
    const copy = await vscode.window.showInformationMessage(
      `Client ${client.clientId} was registered and stored in SecretStorage.`,
      { modal: true },
      "Copy JSON credentials",
    );
    if (copy === "Copy JSON credentials") {
      const clientSecret = await this.oauth.externalCredentialValue(snapshot.configPath, client.clientId, "clientSecret");
      if (!clientSecret) throw new Error("The OAuth client secret is not available in SecretStorage.");
      const credentials = JSON.stringify({
      client_id: client.clientId,
      client_secret: clientSecret,
      grant_types: client.grantTypes,
      redirect_uris: client.redirectUris,
      scope: client.scope,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      }, null, 2);
      await vscode.env.clipboard.writeText(credentials);
      void vscode.window.showInformationMessage("OAuth credentials copied to the clipboard. Treat them like a password.");
    }
    await this.dashboard.refresh();
  }

  private async connectNativeMcp(): Promise<void> {
    this.requireTrustedWorkspace();
    if (!await this.ensureRuntimeModeSelection()) return;
    const snapshot = this.snapshot();
    if (!snapshot.configured) throw new Error("Initialize VSPiLink before connecting it to VS Code agents.");
    const scope = this.nativeScope();
    if (scope !== "mcp:read") {
      const approval = await vscode.window.showWarningMessage(
        `The native provider will use ${scope}. VS Code agents may change files${scope === "mcp:tools" ? " and use every tool allowed by the server" : ""}.`,
        { modal: true },
        "Connect",
      );
      if (approval !== "Connect") return;
    }

    let health = await readHealth(snapshot.port);
    if (!health.online) {
      if (this.supervisor.isActive) {
        health = await waitForHealth(snapshot.port);
      } else {
        const start = await vscode.window.showInformationMessage(
          (snapshot.hostingMode === "cloudflare-named" || snapshot.hostingMode === "cloudflare-fixed")
            ? "The configured PiLink service is not running. Start PiLink and its Cloudflare tunnel?"
            : "The server is not running. Start it locally with workspace-only access?",
          { modal: true },
          "Start and connect",
        );
        if (start !== "Start and connect") return;
        if (snapshot.hostingMode === "cloudflare-named" || snapshot.hostingMode === "cloudflare-fixed") await this.startConfigured();
        else await this.runCli(["serve"], "Local · workspace access", false, snapshot.workspace);
        health = await waitForHealth(snapshot.port);
      }
    }
    if (!health.online) throw new Error(`PiLink did not become reachable: ${health.error || "timeout"}`);
    await this.oauth.connectNative(snapshot, scope);
    this.mcpChanged.fire();
    await this.dashboard.refresh();
    void vscode.window.showInformationMessage(`VSPiLink is available to VS Code agents with the ${scope} scope.`);
  }

  private async disconnectNativeMcp(): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    const action = await vscode.window.showWarningMessage(
      "Remove VSPiLink tokens and credentials from VS Code SecretStorage? The bcrypt client record in the core service will remain for compatibility.",
      { modal: true },
      "Disconnect",
    );
    if (action !== "Disconnect") return;
    await this.oauth.disconnectNative(snapshot.configPath);
    this.mcpChanged.fire();
    await this.dashboard.refresh();
  }

  private showTerminal(): void {
    try {
      this.supervisor.showTerminal();
    } catch {
      this.supervisor.showOutput();
    }
  }

  private async openCollaborationMonitor(): Promise<void> {
    this.requireTrustedWorkspace();
    const workspacePath = await this.selectWorkspace();
    if (!workspacePath) return;
    const snapshot = this.snapshot(workspacePath);
    if (!snapshot.configured) throw new Error("Configure VSPiLink for this workspace first.");
    if (this.effectiveRuntimeMode(snapshot) !== "collaboration") {
      throw new Error("The Agent and Task Monitor is available only in the Public chat & orchestration workflow. Choose that workflow in the VSPiLink dashboard first.");
    }
    if (!samePath(snapshot.workspace, workspacePath)) {
      throw new Error(`The monitor is configured for ${snapshot.workspace}. First run “VSPiLink: Use the Current Folder as the VSPiLink Workspace” on the open folder.`);
    }
    if (samePath(snapshot.workspace, snapshot.dataDir) || isPathInside(snapshot.workspace, snapshot.dataDir)) {
      throw new Error("Private collaboration data must remain outside the workspace. Open the specific project folder instead of your entire home folder, then run “Use the Current Folder as the VSPiLink Workspace”.");
    }
    if (
      this.collaborationMonitor &&
      !this.collaborationMonitor.terminal.exitStatus &&
      samePath(this.collaborationMonitor.configPath, snapshot.configPath) &&
      samePath(this.collaborationMonitor.workspace, snapshot.workspace)
    ) {
      this.collaborationMonitor.terminal.show();
      return;
    }
    const cliPath = resolveCliPath(this.context.extensionPath);
    if (!fs.existsSync(cliPath)) throw new Error(`PiLink runtime not found at ${cliPath}. Run npm run build.`);
    const sidecarNode = this.sidecarNodeRuntime();
    if (!sidecarNode.ok) throw new Error(sidecarNode.error);
    this.collaborationMonitor?.terminal.dispose();
    const terminal = vscode.window.createTerminal({
      name: "VSPiLink · Agent monitor",
      cwd: snapshot.workspace,
      shellPath: sidecarNode.executable,
      shellArgs: [cliPath, "chat"],
      env: { PILINK_CONFIG: snapshot.configPath },
      iconPath: new vscode.ThemeIcon("organization"),
    });
    this.collaborationMonitor = { terminal, configPath: snapshot.configPath, workspace: snapshot.workspace };
    terminal.show();
  }

  private async useWorkspace(resource?: vscode.Uri): Promise<void> {
    this.requireTrustedWorkspace();
    const target = await this.selectWorkspace(resource);
    if (!target) return;
    const snapshot = this.snapshot(target);
    if (!snapshot.configured) {
      await this.runCli(["init"], "Initialization", true, target);
      return;
    }
    if (path.resolve(snapshot.workspace) === path.resolve(target)) {
      void vscode.window.showInformationMessage(`${target} is already the active VSPiLink workspace.`);
      return;
    }
    const approval = await vscode.window.showWarningMessage(
      `Change PI_WORK_DIR from ${snapshot.workspace} to ${target}?`,
      { modal: true, detail: "Authorized MCP clients will see the new workspace. Secrets and OAuth clients remain unchanged." },
      "Change workspace",
    );
    if (approval !== "Change workspace") return;
    const contents = fs.readFileSync(snapshot.configPath, "utf8");
    writePrivateFile(snapshot.configPath, updateEnvValue(contents, "PI_WORK_DIR", target));
    if (this.supervisor.isActive || snapshot.hostingMode === "cloudflare-named") {
      const restart = await vscode.window.showInformationMessage("Workspace updated. Restart VSPiLink now?", "Restart");
      if (restart === "Restart") await this.restartConfigured();
    }
    this.mcpChanged.fire();
    await this.dashboard.refresh();
  }

  private async confirmWizardFullAccess(): Promise<boolean> {
    this.requireTrustedWorkspace();
    const confirmation = await vscode.window.showWarningMessage(
      "Full access lets authorized OAuth clients run shell commands and read or change files outside the workspace.",
      {
        modal: true,
        detail: "Confirm only for a fully trusted computer and client. Keep Project folder only mode for a safer deployment.",
      },
      "Confirm Full access",
    );
    return confirmation === "Confirm Full access";
  }

  private async selectCloudflareCredential(
    kind: CloudflareAuthKind,
  ): Promise<CloudflareCredentialSummary | undefined> {
    this.requireTrustedWorkspace();
    const selected = await vscode.window.showOpenDialog({
      canSelectFolders: false,
      canSelectFiles: true,
      canSelectMany: false,
      title: kind === "origin-certificate"
        ? "Select the Cloudflare account certificate"
        : "Select the Cloudflare tunnel token file",
      openLabel: "Use this credential",
    });
    const selectedPath = selected?.[0]?.fsPath;
    if (!selectedPath) return undefined;
    let valid = false;
    try {
      const status = fs.statSync(selectedPath);
      valid = status.isFile() && status.size > 0 && status.size <= 64 * 1024;
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new Error("The Cloudflare credential must be a non-empty file no larger than 64 KiB.");
    }
    return this.cloudflareCredentials.store(kind, selectedPath);
  }

  private async provisionWizard(
    workspace: string,
    hosting: HostingSelection,
    accessMode: WizardAccessMode,
  ): Promise<{ configPath: string }> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot(workspace);
    provisionWizardConfiguration({
      configPath: snapshot.configPath,
      workspace,
      hosting,
      port: snapshot.port,
      runtimeMode: this.effectiveRuntimeMode(snapshot),
    });
    if (hosting.kind === "cloudflare-fixed") {
      if (!hosting.credentialReference || !hosting.credentialLabel) {
        throw new Error("Cloudflare fixed-domain token-file reference is missing.");
      }
      const stored = await this.cloudflareCredentials.get({
        reference: hosting.credentialReference,
        kind: "tunnel-token-file",
        label: hosting.credentialLabel,
      });
      if (!stored || stored.kind !== "tunnel-token-file") {
        throw new Error("The selected Cloudflare tunnel token file is no longer available.");
      }
      let contents = fs.readFileSync(snapshot.configPath, "utf8");
      contents = updateEnvValue(contents, "PI_CLOUDFLARE_TOKEN_FILE", stored.filePath);
      writePrivateFile(snapshot.configPath, contents.endsWith("\n") ? contents : `${contents}\n`);
    }
    if (accessMode === "full") {
      let contents = fs.readFileSync(snapshot.configPath, "utf8");
      contents = updateEnvValue(contents, "PI_UNSAFE_FULL_ACCESS", "true");
      contents = updateEnvValue(contents, "PI_REQUIRE_EXECUTION_APPROVAL", "false");
      writePrivateFile(snapshot.configPath, contents.endsWith("\n") ? contents : `${contents}\n`);
    }
    if (hosting.kind === "cloudflare-named") {
      const namedHosting = hosting as HostingSelection & { kind: "cloudflare-named" };
      const configured = this.snapshot(workspace);
      const preview = await this.runNamedHostingCli("plan", namedHosting, configured, false);
      const result = jsonObject(preview.result);
      const blockers = stringArray(result?.blockers);
      if (blockers.length) throw new Error(`Cloudflare is not ready to configure: ${blockers.join("; ")}`);
      const actions = Array.isArray(result?.actions) ? result.actions : [];
      const remoteChanges = actions.filter((entry) => jsonObject(entry)?.mutatesRemote === true).length;
      const confirmation = await vscode.window.showInformationMessage(
        "PiLink will configure the Cloudflare Named Tunnel, both HTTPS hostnames, and persistent user services.",
        {
          modal: true,
          detail: remoteChanges
            ? `${remoteChanges} changes will be made to the Cloudflare account. The certificate remains local and is not included in the extension.`
            : "The configuration will use the credential stored by VS Code. No secret will be shown in the dashboard.",
        },
        "Apply and continue",
      );
      if (confirmation !== "Apply and continue") throw new Error("Cloudflare configuration was canceled.");
      await this.runNamedHostingCli("provision", namedHosting, configured, true);
      await this.runNamedHostingCli("install", namedHosting, configured, true);
      await this.runNamedHostingCli("enable", namedHosting, configured, true);
      this.invalidateManagedHosting();
    }
    this.mcpChanged.fire();
    return { configPath: snapshot.configPath };
  }

  private async startWizardRuntime(
    workspace: string,
    hosting: HostingSelection,
    accessMode: WizardAccessMode,
  ): Promise<{ configPath: string; publicUrl: string; mcpUrl: string }> {
    this.requireTrustedWorkspace();
    if (hosting.kind === "nip-io") {
      throw new Error("nip.io mode requires advanced network configuration. Use “Run Legacy Setup in the Terminal”, or choose Cloudflare or a stable HTTPS domain.");
    }
    if (hosting.kind === "cloudflare-named") {
      const namedHosting = hosting as HostingSelection & { kind: "cloudflare-named" };
      if (this.supervisor.isActive) await this.supervisor.stop();
      const snapshot = this.snapshot(workspace);
      await this.runNamedHostingCli("start", namedHosting, snapshot, true);
      this.invalidateManagedHosting();
      const health = await waitForHealth(snapshot.port, 120_000);
      if (!health.online) throw new Error(`The PiLink service did not become reachable: ${health.error || "timeout"}`);
      const publicUrl = (hosting.publicUrl as string).replace(/\/$/, "");
      const publicHealth = await waitForPublicHealth(publicUrl, 60_000);
      if (!publicHealth.online) throw new Error(`The Cloudflare endpoint is not ready: ${publicHealth.error || "timeout"}`);
      const status = await this.runNamedHostingCli("status", namedHosting, snapshot, false);
      if (jsonObject(status.result)?.productionReady !== true) {
        throw new Error("The Cloudflare services are running, but production readiness has not been reached yet.");
      }
      return { configPath: snapshot.configPath, publicUrl, mcpUrl: `${publicUrl}/sse` };
    }
    if (this.supervisor.isActive) await this.supervisor.stop();
    const snapshot = this.snapshot(workspace);
    const plan = hostingStartPlan(hosting);
    const args = [plan.command, ...(accessMode === "full" ? ["--allow-unsafe-full-access"] : [])];
    await this.runCli(
      args,
      `${plan.public ? "Public" : "Local"} · ${accessMode === "full" ? "Full access" : "Project folder only"}`,
      false,
      workspace,
      { PI_OAUTH_CONSENT_MODE: "paired", PILINK_OAUTH_SETUP_DRIVER: "vscode" },
    );
    const health = await waitForHealth(snapshot.port, 120_000);
    if (!health.online) throw new Error(`PiLink did not become reachable: ${health.error || "timeout"}`);

    const publicUrl = hosting.kind === "custom-domain" || hosting.kind === "cloudflare-fixed"
      ? hosting.publicUrl as string
      : hosting.kind === "quick-tunnel"
        ? await this.supervisor.waitForPublicUrl(120_000)
        : localServerUrl(snapshot);
    if (plan.public) {
      const publicHealth = await waitForPublicHealth(publicUrl, 45_000);
      if (!publicHealth.online) throw new Error(`The public HTTPS endpoint is not ready: ${publicHealth.error || "timeout"}`);
    }
    const normalized = publicUrl.replace(/\/$/, "");
    return { configPath: snapshot.configPath, publicUrl: normalized, mcpUrl: `${normalized}/sse` };
  }

  private async pairWizardOwner(destination: ChatGptDestination): Promise<boolean> {
    await this.requirePersistentBrowserStorage();
    const state = this.wizard.currentState;
    if (!state.publicUrl) throw new Error("The public PiLink host is unavailable for OAuth pairing.");
    const snapshot = this.wizardSnapshot(state);
    if (!snapshot.bootstrapSecret) throw new Error("PI_BOOTSTRAP_SECRET is missing from the private configuration.");
    const pairing = await createOwnerPairing(snapshot.port, snapshot.bootstrapSecret);
    const pairingUrl = validatePairingUrl(pairing.pairingUrl, state.publicUrl, pairing.expiresAt);
    const action = await vscode.window.showInformationMessage(
      "Verify this computer before connecting ChatGPT.",
      {
        modal: true,
        detail: `Local verification code: ${pairing.verificationCode}\n\nThe pairing URL alone cannot authorize access. Copy this short-lived code only into the PiLink pairing page opened by VSPiLink.`,
      },
      "Copy code and open pairing",
    );
    if (action !== "Copy code and open pairing") return false;
    await vscode.env.clipboard.writeText(pairing.verificationCode);
    const navigation = chatGptNavigation(destination);
    const pairedNavigation = new URL(pairingUrl);
    pairedNavigation.searchParams.set("continue", navigation.url);
    const opened = await this.openIntegratedBrowser(
      pairedNavigation.toString(),
      `${state.publicUrl.replace(/\/$/u, "")}/oauth/pair*`,
    );
    if (!opened) throw new Error("The browser did not open the VSPiLink pairing page.");
    return true;
  }

  private async openChatGpt(destination: ChatGptDestination): Promise<void> {
    const navigation = chatGptNavigation(destination);
    const opened = await this.openIntegratedBrowser(navigation.url, navigation.reuseUrlFilter);
    if (!opened) throw new Error("The browser did not open the official ChatGPT page.");
  }

  /**
   * Open a real top-level browser editor, not an iframe-backed webview.  This
   * keeps ChatGPT's login and the one-use PiLink owner cookie in the same VS
   * Code browser profile.  Older VS Code builds fall back to the system
   * browser without ever attempting the blocked Simple Browser embedding.
   */
  private async openIntegratedBrowser(url: string, reuseUrlFilter?: string): Promise<boolean> {
    const parsed = vscode.Uri.parse(url, true);
    const commands = await vscode.commands.getCommands(true);
    let integratedBrowserFailed = false;
    if (commands.includes("workbench.action.browser.open")) {
      try {
        await vscode.commands.executeCommand("workbench.action.browser.open", {
          url: parsed.toString(true),
          openToSide: true,
          ...(reuseUrlFilter ? { reuseUrlFilter } : {}),
        });
        return true;
      } catch {
        integratedBrowserFailed = true;
      }
    }
    const action = await vscode.window.showWarningMessage(
      integratedBrowserFailed
        ? "VS Code's integrated browser could not open this page."
        : "This version of VS Code does not provide the integrated browser required by VSPiLink.",
      {
        modal: true,
        detail: "The system browser will open only if you choose it explicitly. During an SSH session, it may be on a different computer.",
      },
      "Open in system browser",
    );
    if (action !== "Open in system browser") return false;
    return vscode.env.openExternal(parsed);
  }

  private async requirePersistentBrowserStorage(): Promise<void> {
    const storage = vscode.workspace.getConfiguration("workbench.browser").get<string>("dataStorage", "global");
    if (storage !== "ephemeral") return;
    const action = await vscode.window.showWarningMessage(
      "The integrated browser uses ephemeral storage, so the PiLink consent page and ChatGPT cannot share the OAuth session.",
      { modal: true, detail: "Open Workbench › Browser: Data Storage, select Global or Workspace, then run “Connect ChatGPT via MCP” again." },
      "Open setting",
    );
    if (action === "Open setting") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "workbench.browser.dataStorage");
    }
    throw new Error("Set Workbench › Browser: Data Storage to Global or Workspace before connecting ChatGPT.");
  }

  private async connectChatGpt(): Promise<void> {
    this.requireTrustedWorkspace();
    let snapshot = this.snapshot();
    if (!snapshot.configured) {
      await this.guidedSetup();
      return;
    }

    let health = await readHealth(snapshot.port);
    if (!health.online) {
      await this.startConfigured();
      health = await waitForHealth(snapshot.port, 120_000);
      if (!health.online) throw new Error(`The MCP server is unreachable: ${health.error || "timeout"}.`);
      snapshot = this.snapshot();
    }

    const state = await this.dashboardState();
    let origin: URL;
    try {
      origin = new URL(state.publicUrl);
    } catch {
      throw new Error("The public PiLink endpoint is invalid.");
    }
    if (origin.protocol !== "https:" || isLoopbackBrowserHost(origin.hostname)) {
      await this.guidedSetup();
      return;
    }

    const existing = this.wizard.currentState;
    const hosting = existing.appliedHosting || existing.hosting;
    if (state.externalMcp.configured) {
      await this.wizard.adoptRuntime({
        workspace: snapshot.workspace,
        configPath: snapshot.configPath,
        publicUrl: state.publicUrl,
        mcpUrl: state.mcpUrl,
        chatGptConnected: state.externalMcp.connected,
        ...(hosting ? { hosting } : {}),
      });
      if (state.externalMcp.connected) {
        await this.wizard.noteChatGptConnected();
        await this.openChatGpt("work");
        return;
      }
      await this.pairWizardOwner("plugins");
      return;
    }
    await this.wizard.resumeRuntime({
      workspace: snapshot.workspace,
      configPath: snapshot.configPath,
      publicUrl: state.publicUrl,
      mcpUrl: state.mcpUrl,
      chatGptConnected: state.externalMcp.connected,
      ...(hosting ? { hosting } : {}),
    });
    await vscode.env.clipboard.writeText(state.mcpUrl);
    await this.wizard.handle({
      type: "wizard",
      action: "openChatGpt",
      requestId: `connect-${Date.now()}`,
      destination: "work",
    });
    await this.dashboard.refresh();
  }

  private async openChatGptInVsCode(): Promise<void> {
    this.requireTrustedWorkspace();
    const state = await this.dashboardState();
    if (!state.externalMcp.configured || !state.externalMcp.connected) {
      await this.connectChatGpt();
      return;
    }
    await this.openChatGpt("work");
  }

  private async registerChatGpt(callbackUrl: string) {
    this.requireTrustedWorkspace();
    const snapshot = this.wizardSnapshot(this.wizard.currentState);
    const health = await readHealth(snapshot.port);
    if (!health.online) throw new Error("Start PiLink before registering ChatGPT.");
    const registered = await this.oauth.registerExternalClient(snapshot, {
      clientName: "ChatGPT VSPiLink",
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: [callbackUrl],
      allowedScope: "mcp:tools offline_access",
      tokenEndpointAuthMethod: "client_secret_post",
    });
    if (this.wizard.currentState.accessMode === "full") {
      this.writeFullAccessConfiguration(this.snapshot(snapshot.workspace), registered.clientId, false);
      if (snapshot.hostingMode === "cloudflare-named") {
        await this.restartManagedChatServer(this.snapshot(snapshot.workspace));
        const restarted = await waitForHealth(snapshot.port, 120_000);
        if (!restarted.online) throw new Error(`PiLink did not restart after the client was authorized: ${restarted.error || "timeout"}`);
      }
    }
    return registered;
  }

  private async wizardCredentialValue(
    field: WizardCopyField,
    state: Readonly<PersistedWizardState>,
  ): Promise<string | undefined> {
    if (field === "mcpUrl") return state.mcpUrl;
    if (field === "authorizationUrl") return state.publicUrl ? `${state.publicUrl.replace(/\/$/, "")}/oauth/authorize` : undefined;
    if (field === "tokenUrl") return state.publicUrl ? `${state.publicUrl.replace(/\/$/, "")}/oauth/token` : undefined;
    if (!state.configPath || !state.credential) return undefined;
    return this.oauth.externalCredentialValue(state.configPath, state.credential.clientId, field);
  }

  /** Prepare the local Pi chat only. Public hosting and MCP OAuth are optional. */
  private setupChat(): Promise<boolean> {
    if (this.chatSetupInFlight) return this.chatSetupInFlight;
    const operation = this.setupChatOnce().finally(() => {
      if (this.chatSetupInFlight === operation) this.chatSetupInFlight = undefined;
    });
    this.chatSetupInFlight = operation;
    return operation;
  }

  private async setupChatOnce(): Promise<boolean> {
    this.requireTrustedWorkspace();
    if (!await this.ensureRuntimeModeSelection()) return false;
    const currentWorkspace = this.defaultWorkspacePath();
    const workspace = currentWorkspace || await this.selectWorkspace(undefined, true);
    if (!workspace) return false;
    if (!currentWorkspace) this.selectedWorkspacePath = path.resolve(workspace);
    let snapshot = this.snapshot(workspace);
    if (!snapshot.configured) {
      provisionWizardConfiguration({
        configPath: snapshot.configPath,
        workspace,
        hosting: { kind: "local" },
        port: snapshot.port,
        runtimeMode: this.effectiveRuntimeMode(snapshot),
      });
      this.mcpChanged.fire();
      snapshot = this.snapshot(workspace);
    }

    if (path.resolve(snapshot.workspace) !== path.resolve(workspace)) {
      if (!await this.switchChatWorkspace(snapshot, workspace)) return false;
      snapshot = this.snapshot(workspace);
      if (path.resolve(snapshot.workspace) !== path.resolve(workspace)) {
        throw new Error("PI_WORK_DIR is forced by the process environment. Remove the override or open the configured folder.");
      }
    }

    if (!snapshot.values.PI_AGENT_PROVIDER || !snapshot.values.PI_AGENT_MODEL) {
      const configured = await this.configureAgents();
      if (!configured) return false;
      snapshot = this.snapshot(workspace);
    }

    await this.ensureLocalChatRuntime(snapshot);

    await this.dashboard.refresh();
    return true;
  }

  private async ensureLocalChatRuntime(snapshot: ConfigSnapshot): Promise<void> {
    if (!snapshot.bootstrapSecret) throw new Error("PI_BOOTSTRAP_SECRET is unavailable.");
    let admin = await readAdminStatus(snapshot.port, snapshot.bootstrapSecret, 3_000);
    if (admin.online && inspectAdminAgentRuntime(admin.payload).ready) return;

    if (this.supervisor.isActive) {
      await this.supervisor.restart();
    } else if (snapshot.hostingMode === "cloudflare-named" && admin.online) {
      await this.restartManagedChatServer(snapshot);
    } else {
      const publicHealth = await readHealth(snapshot.port, 1_500);
      if (admin.online || publicHealth.online) {
        const runtime = inspectAdminAgentRuntime(admin.payload);
        throw new Error(
          `A verified PiLink service is already active on port ${snapshot.port}, but the agent runtime is ${runtime.runtimeState}. ` +
          "VSPiLink will not automatically restart a public service. Restart it from Advanced settings, or stop it and try again.",
        );
      }
      if (await isLoopbackPortOccupied(snapshot.port)) {
        throw new Error(
          `Local port ${snapshot.port} is already used by a process that VSPiLink cannot authenticate. ` +
          "Stop that process or choose another port before starting the local chat.",
        );
      }
      await this.runCli(
        ["serve"],
        "Local Pi chat · Project folder only",
        false,
        snapshot.workspace,
        { PI_OAUTH_CONSENT_MODE: "paired" },
        { allowNamedLocalServe: true },
      );
    }

    admin = await waitForAdminRuntime(snapshot.port, snapshot.bootstrapSecret, 120_000);
    const runtime = inspectAdminAgentRuntime(admin.payload);
    if (!admin.online || !runtime.ready) {
      throw new Error(`The local Pi chat is not ready: ${admin.error || `agent runtime ${runtime.runtimeState}`}.`);
    }
  }

  private async restartManagedChatServer(snapshot: ConfigSnapshot): Promise<void> {
    await restartManagedServerUnit(snapshot, this.managedServerControlOptions());
  }

  private managedServerControlOptions(): { systemctlPath: string; systemdUserDirectory: string; expectedUid?: number } {
    const systemctlPath = absoluteExecutable("systemctl", ["/usr/bin/systemctl", "/bin/systemctl"]);
    const systemdUserDirectory = path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "systemd",
      "user",
    );
    return {
      systemctlPath,
      systemdUserDirectory,
      ...(typeof process.getuid === "function" ? { expectedUid: process.getuid() } : {}),
    };
  }

  private async switchChatWorkspace(previous: ConfigSnapshot, workspace: string): Promise<boolean> {
    const health = await readHealth(previous.port);
    let managedNamedServer = false;
    if (health.online && !this.supervisor.isActive && previous.hostingMode === "cloudflare-named" && previous.bootstrapSecret) {
      const admin = await readAdminStatus(previous.port, previous.bootstrapSecret, 2_000);
      if (admin.online) {
        try {
          validateManagedServerUnit(previous, this.managedServerControlOptions());
          managedNamedServer = true;
        } catch {
          managedNamedServer = false;
        }
      }
    }
    if (health.online && !this.supervisor.isActive && !managedNamedServer) {
      await vscode.window.showWarningMessage(
        `PiLink is already running outside the extension for ${previous.workspace}. Stop that instance before using ${workspace}.`,
        { modal: true },
      );
      return false;
    }
    const approval = await vscode.window.showWarningMessage(
      `PiLink is configured for ${previous.workspace}. Use the open folder ${workspace} instead?`,
      {
        modal: true,
        detail: "Chat and connected MCP clients will use the new folder. Provider sign-ins, OAuth clients, and hosting stay unchanged.",
      },
      "Use open folder",
    );
    if (approval !== "Use open folder") return false;

    const oldChatAgentId = this.activeChatAgentId;
    if (oldChatAgentId) this.rememberDismissedChatAgent(oldChatAgentId);
    if (health.online && previous.bootstrapSecret && oldChatAgentId) {
      try {
        await stopAdminAgent(previous.port, previous.bootstrapSecret, oldChatAgentId);
      } catch {
        // A stale conversation must not prevent an explicit workspace switch.
      }
    }
    const selectionGeneration = ++this.chatSelectionGeneration;
    await this.setActiveChatAgent(undefined, selectionGeneration);
    const contents = fs.readFileSync(previous.configPath, "utf8");
    writePrivateFile(previous.configPath, updateEnvValue(contents, "PI_WORK_DIR", path.resolve(workspace)));
    this.mcpChanged.fire();

    if (this.supervisor.isActive) {
      await this.supervisor.restart();
    } else if (managedNamedServer && previous.bootstrapSecret) {
      await this.restartManagedChatServer(previous);
      const ready = await waitForAdminRuntime(previous.port, previous.bootstrapSecret, 120_000);
      if (!ready.online || !inspectAdminAgentRuntime(ready.payload).ready) {
        throw new Error(`The PiLink service restarted for the new folder, but the agent runtime is not ready: ${ready.error || "status unavailable"}.`);
      }
    }
    return true;
  }

  private async sendChat(value: string): Promise<void> {
    this.requireTrustedWorkspace();
    const message = value.trim();
    if (!message) throw new Error("Write a message before sending it.");
    if (Buffer.byteLength(message, "utf8") > 64 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(message)) {
      throw new Error("The message contains invalid control characters or exceeds 64 KiB.");
    }
    if (this.chatCommandBusy) throw new Error("Wait for the current chat operation to finish.");
    this.chatCommandBusy = true;
    void this.dashboard.refresh();
    try {
      if (!await this.setupChat()) return;
      const sendGeneration = this.chatSelectionGeneration;
      const snapshot = this.snapshot();
      if (!snapshot.bootstrapSecret) throw new Error("PI_BOOTSTRAP_SECRET is unavailable.");
      const { agents } = await readAdminAgents(snapshot.port, snapshot.bootstrapSecret, 100);
      const selected = this.activeChatAgentId
        ? agents.find((agent) => agent.agentId === this.activeChatAgentId)
        : undefined;
      if (selected && (selected.status === "running" || selected.status === "waiting")) {
        await sendAdminAgentMessage(snapshot.port, snapshot.bootstrapSecret, selected.agentId, message);
      } else {
        const coordinationPermissions = this.effectiveRuntimeMode(snapshot) === "collaboration"
          ? ["coordination:read", "coordination:write"]
          : [];
        const permissions = [
          ...coordinationPermissions,
          "workspace:read",
          "workspace:write",
          "network:outbound",
          ...(snapshot.unsafeFullAccess ? ["process:execute"] : []),
        ];
        const agent = await spawnAdminAgent(snapshot.port, snapshot.bootstrapSecret, {
          role: "collaborator",
          initialMessage: message,
          label: CHAT_AGENT_LABEL,
          permissions,
        });
        if (sendGeneration !== this.chatSelectionGeneration) {
          this.rememberDismissedChatAgent(agent.agentId);
          try {
            await stopAdminAgent(snapshot.port, snapshot.bootstrapSecret, agent.agentId);
          } catch {
            // The newer chat-selection command remains authoritative.
          }
          return;
        }
        const selectionGeneration = ++this.chatSelectionGeneration;
        this.dismissedChatAgentIds.delete(agent.agentId);
        await this.setActiveChatAgent(agent.agentId, selectionGeneration);
      }
    } finally {
      this.chatCommandBusy = false;
      await this.dashboard.refresh();
    }
  }

  private async cancelChat(): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    if (!snapshot.bootstrapSecret || !this.activeChatAgentId) return;
    this.chatCommandBusy = true;
    void this.dashboard.refresh();
    try {
      await cancelAdminAgentTurn(snapshot.port, snapshot.bootstrapSecret, this.activeChatAgentId);
    } finally {
      this.chatCommandBusy = false;
      await this.dashboard.refresh();
    }
  }

  private async newChat(): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    const agentId = this.activeChatAgentId;
    const selectionGeneration = ++this.chatSelectionGeneration;
    if (agentId) this.rememberDismissedChatAgent(agentId);
    await this.setActiveChatAgent(undefined, selectionGeneration);
    try {
      if (snapshot.bootstrapSecret && agentId) {
        try {
          await cancelAdminAgentTurn(snapshot.port, snapshot.bootstrapSecret, agentId, "New chat requested from the VSPiLink dashboard");
        } catch {
          // An idle, terminal, or already-closed agent does not need cancellation.
        }
        try {
          await stopAdminAgent(snapshot.port, snapshot.bootstrapSecret, agentId);
        } catch {
          // A stale runtime must not resurrect the dismissed conversation.
        }
      }
    } finally {
      await this.setActiveChatAgent(undefined, selectionGeneration);
      await this.dashboard.refresh();
    }
  }

  private rememberDismissedChatAgent(agentId: string): void {
    this.dismissedChatAgentIds.add(agentId);
    while (this.dismissedChatAgentIds.size > 32) {
      const oldest = this.dismissedChatAgentIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.dismissedChatAgentIds.delete(oldest);
    }
  }

  private async setActiveChatAgent(agentId: string | undefined, generation = this.chatSelectionGeneration): Promise<boolean> {
    if (generation !== this.chatSelectionGeneration) return false;
    this.activeChatAgentId = agentId;
    await this.context.workspaceState.update(CHAT_AGENT_STATE_KEY, agentId);
    if (generation === this.chatSelectionGeneration) return true;
    await this.context.workspaceState.update(CHAT_AGENT_STATE_KEY, this.activeChatAgentId);
    return false;
  }

  private async configureAgents(): Promise<boolean> {
    this.requireTrustedWorkspace();
    if (!await this.ensureRuntimeModeSelection()) return false;
    const snapshot = this.snapshot();
    if (!snapshot.configured) throw new Error("Complete VSPiLink setup first.");
    let catalog = await this.loadAgentCatalog(snapshot, true);
    const providers = [...catalog.providers].sort((left, right) => providerRank(left) - providerRank(right) || left.name.localeCompare(right.name));
    if (!providers.length) throw new Error("The installed runtime does not expose any compatible agent providers.");
    const providerPick = await vscode.window.showQuickPick(providers.map((provider) => ({
      label: provider.name,
      description: provider.configuredAuthType
        ? `${authTypeLabel(provider.configuredAuthType)} sign-in already configured`
        : providerRank(provider) === 0 ? "Recommended for Codex OAuth" : "Sign-in required",
      detail: `${provider.models.length} models available · ${provider.id}`,
      provider,
    })), {
      title: "Agents · 1 of 3 · Choose a provider",
      placeHolder: "Select the provider new agents will use",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!providerPick) return false;
    let provider = providerPick.provider;

    const authChoices: Array<{ label: string; description: string; authType?: "oauth" | "api_key" }> = [];
    if (provider.configuredAuthType) {
      authChoices.push({ label: "Use existing sign-in", description: `${authTypeLabel(provider.configuredAuthType)} credential is already available` });
    }
    if (provider.authTypes.includes("oauth")) authChoices.push({ label: "Sign in with OAuth", description: "Opens the provider sign-in page automatically", authType: "oauth" });
    if (provider.authTypes.includes("api_key")) authChoices.push({ label: "Enter API key", description: "The key is entered in a protected prompt and stored only in the private 0600 auth.json file", authType: "api_key" });
    const authChoice = await vscode.window.showQuickPick(authChoices, {
      title: "Agents · 2 of 3 · Authentication",
      placeHolder: "Choose how to authenticate with this provider",
    });
    if (!authChoice) return false;
    if (authChoice.authType) {
      let oauthMethod: "browser" | "device_code" | undefined;
      if (authChoice.authType === "oauth") {
        const method = await vscode.window.showQuickPick(
          agentOAuthMethodChoices(vscode.env.remoteName),
          { title: "Agents · OAuth method", placeHolder: "Choose a sign-in method" },
        );
        if (!method) return false;
        oauthMethod = method.value;
      }
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Signing in to ${provider.name}`,
        cancellable: false,
      }, async () => {
        await this.agentAuth.login(
          this.agentAuthOptions(snapshot),
          provider.id,
          authChoice.authType as "oauth" | "api_key",
          oauthMethod,
          {
            prompt: (prompt) => this.agentAuthPrompt(prompt),
            notify: (event) => this.agentAuthNotification(event),
          },
        );
      });
      this.agentCatalogCache = undefined;
      catalog = await this.loadAgentCatalog(snapshot, true);
      provider = catalog.providers.find((entry) => entry.id === provider.id) || provider;
    }

    if (!provider.models.length) throw new Error("The selected provider does not expose any usable models.");
    const currentModel = snapshot.values.PI_AGENT_PROVIDER === provider.id ? snapshot.values.PI_AGENT_MODEL : undefined;
    const modelPick = await vscode.window.showQuickPick(
      [...provider.models]
        .sort((left, right) => Number(right.id === currentModel) - Number(left.id === currentModel) || left.name.localeCompare(right.name))
        .map((model) => ({
          label: model.name,
          description: `${model.reasoning ? "Reasoning" : "Chat"} · ${formatContextWindow(model.contextWindow)} context`,
          detail: model.id,
          model,
        })),
      {
        title: "Agents · 3 of 3 · Choose a model",
        placeHolder: "Select the default model for new agents",
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (!modelPick) return false;
    let contents = fs.readFileSync(snapshot.configPath, "utf8");
    contents = updateEnvValue(contents, "PI_AGENT_PROVIDER", provider.id);
    contents = updateEnvValue(contents, "PI_AGENT_MODEL", modelPick.model.id);
    if (!snapshot.values.PI_AGENT_MAX_CONCURRENT) contents = updateEnvValue(contents, "PI_AGENT_MAX_CONCURRENT", "4");
    writePrivateFile(snapshot.configPath, contents.endsWith("\n") ? contents : `${contents}\n`);
    await this.restartAfterAgentChange(snapshot);
    await this.dashboard.refresh();
    void vscode.window.showInformationMessage(`Agents configured: ${provider.name} · ${modelPick.model.name}.`);
    return true;
  }

  private async logoutAgent(): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    const catalog = await this.loadAgentCatalog(snapshot, true);
    const configured = catalog.providers.filter((provider) => provider.configuredAuthType);
    if (!configured.length) {
      void vscode.window.showInformationMessage("No provider sign-ins are configured.");
      return;
    }
    const picked = await vscode.window.showQuickPick(configured.map((provider) => ({
      label: provider.name,
      description: authTypeLabel(provider.configuredAuthType as "oauth" | "api_key"),
      provider,
    })), { title: "Sign out of an agent provider", placeHolder: "Select the provider to sign out of" });
    if (!picked) return;
    const confirmation = await vscode.window.showWarningMessage(
      `Remove the ${picked.label} sign-in from the private agent credential file?`,
      { modal: true },
      "Sign out",
    );
    if (confirmation !== "Sign out") return;
    await this.agentAuth.logout(this.agentAuthOptions(snapshot), picked.provider.id);
    if (snapshot.values.PI_AGENT_PROVIDER === picked.provider.id) {
      let contents = fs.readFileSync(snapshot.configPath, "utf8");
      contents = removeEnvValue(removeEnvValue(contents, "PI_AGENT_PROVIDER"), "PI_AGENT_MODEL");
      writePrivateFile(snapshot.configPath, contents.endsWith("\n") ? contents : `${contents}\n`);
      await this.restartAfterAgentChange(snapshot);
    }
    this.agentCatalogCache = undefined;
    await this.dashboard.refresh();
  }

  private async spawnAgent(): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    if (!snapshot.bootstrapSecret) throw new Error("PI_BOOTSTRAP_SECRET is unavailable.");
    if (!snapshot.values.PI_AGENT_PROVIDER || !snapshot.values.PI_AGENT_MODEL) {
      const action = await vscode.window.showInformationMessage(
        "Configure an agent provider, sign-in, and model first.",
        { modal: true },
        "Configure agents",
      );
      if (action === "Configure agents") await this.configureAgents();
      return;
    }
    const role = await vscode.window.showQuickPick([
      { label: "Implementer", description: "Implements a bounded change", value: "implementer" },
      { label: "Researcher", description: "Collects evidence and analyzes it", value: "researcher" },
      { label: "Manager", description: "Breaks down work and coordinates it", value: "manager" },
      { label: "AI Engineer", description: "Designs orchestration and evaluation", value: "ai-engineer" },
      { label: "Collaborator", description: "Provides general-purpose support", value: "collaborator" },
    ], { title: "New agent · 1 of 3 · Role", placeHolder: "Select the agent role" });
    if (!role) return;
    const coordinationPermissions = this.effectiveRuntimeMode(snapshot) === "collaboration"
      ? ["coordination:read", "coordination:write"]
      : [];
    const accessChoices = [
      {
        label: "Read and research",
        description: this.effectiveRuntimeMode(snapshot) === "collaboration"
          ? "Read-only workspace access, coordination, and outbound network access"
          : "Read-only workspace and outbound network access",
        value: [...coordinationPermissions, "workspace:read", "network:outbound"],
      },
      {
        label: "Edit workspace",
        description: "Can read and write files; process execution stays disabled",
        value: [...coordinationPermissions, "workspace:read", "workspace:write", "network:outbound"],
      },
      ...(snapshot.unsafeFullAccess ? [{
        label: "Edit + run processes",
        description: "Available only because PI_UNSAFE_FULL_ACCESS is enabled",
        value: [...coordinationPermissions, "workspace:read", "workspace:write", "process:execute", "network:outbound"],
      }] : []),
    ];
    const access = await vscode.window.showQuickPick(accessChoices, { title: "New agent · 2 of 3 · Permissions", placeHolder: "Select the access level" });
    if (!access) return;
    if (access.value.includes("workspace:write")) {
      const approval = await vscode.window.showWarningMessage(
        access.value.includes("process:execute")
          ? "This agent can modify files and run processes in the selected workspace."
          : "This agent can modify files in the selected workspace; process execution remains disabled.",
        { modal: true },
        "Allow in workspace",
      );
      if (approval !== "Allow in workspace") return;
    }
    const task = await vscode.window.showInputBox({
      title: "New agent · 3 of 3 · Task",
      prompt: "Describe the concrete outcome the agent must achieve. It will use the workspace shown in the dashboard.",
      placeHolder: "Example: verify the OAuth tests and propose a bounded fix",
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : "Describe the agent task.",
    });
    if (!task) return;
    const spawned = await spawnAdminAgent(snapshot.port, snapshot.bootstrapSecret, {
      role: role.value,
      initialMessage: task,
      label: task.trim().replace(/[\r\n]+/g, " ").slice(0, 80),
      permissions: access.value,
    });
    await this.dashboard.refresh();
    void vscode.window.showInformationMessage(`${spawned.role} agent created · status ${spawned.status}.`);
  }

  private async stopAgent(agentId: string): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    if (!snapshot.bootstrapSecret) throw new Error("PI_BOOTSTRAP_SECRET is unavailable.");
    const approval = await vscode.window.showWarningMessage("Stop this agent?", { modal: true }, "Stop agent");
    if (approval !== "Stop agent") return;
    await stopAdminAgent(snapshot.port, snapshot.bootstrapSecret, agentId);
    await this.dashboard.refresh();
  }

  private async viewAgentOutput(agentId: string): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    if (!snapshot.bootstrapSecret) throw new Error("PI_BOOTSTRAP_SECRET is unavailable.");
    const entries = await readAdminAgentOutput(snapshot.port, snapshot.bootstrapSecret, agentId);
    const contents = entries.length
      ? entries.map((entry) => `### ${entry.channel}${entry.createdAt ? ` · ${entry.createdAt}` : ""}\n\n${entry.text}`).join("\n\n")
      : "No output is available for this agent.";
    const document = await vscode.workspace.openTextDocument({ language: "markdown", content: contents });
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }

  private async agentAuthPrompt(prompt: AgentAuthPrompt): Promise<string | undefined> {
    if (prompt.kind === "select") {
      const picked = await vscode.window.showQuickPick((prompt.options || []).map((option) => ({
        label: option.label,
        description: option.description,
        value: option.id,
      })), { title: prompt.message, placeHolder: "Select an option to continue", ignoreFocusOut: true });
      return picked?.value;
    }
    return vscode.window.showInputBox({
      title: prompt.message,
      prompt: prompt.kind === "secret" ? "This value is protected and is not saved by the extension." : undefined,
      placeHolder: prompt.placeholder,
      password: prompt.kind === "secret",
      ignoreFocusOut: true,
      validateInput: (value) => value ? undefined : "Enter the required value.",
    });
  }

  private async agentAuthNotification(event: AgentAuthEvent): Promise<void> {
    if (event.type === "auth_url") {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(event.url, true));
      if (!opened) throw new Error("The browser did not open the agent provider OAuth page.");
      if (event.instructions) void vscode.window.showInformationMessage(event.instructions);
      return;
    }
    if (event.type === "device_code") {
      await vscode.env.clipboard.writeText(event.userCode);
      const opened = await vscode.env.openExternal(vscode.Uri.parse(event.verificationUri, true));
      if (!opened) throw new Error("The browser did not open the device-code page.");
      void vscode.window.showInformationMessage(`Device code copied: ${event.userCode}. Paste it into the page that just opened.`);
      return;
    }
    if (event.type === "info") void vscode.window.showInformationMessage(event.message);
  }

  private wizardSnapshot(state: Readonly<PersistedWizardState>): ConfigSnapshot {
    if (!state.configPath) throw new Error("The wizard's private configuration is unavailable.");
    return readConfigSnapshot(state.configPath, state.workspace || this.defaultWorkspacePath() || "");
  }

  private async openDocs(): Promise<void> {
    const development = path.resolve(this.context.extensionPath, "..", "..", "docs", "VSCODE_EXTENSION.md");
    const packaged = path.join(this.context.extensionPath, "runtime", "docs", "VSCODE_EXTENSION.md");
    const target = fs.existsSync(packaged) ? packaged : development;
    if (!fs.existsSync(target)) {
      await vscode.env.openExternal(vscode.Uri.parse("https://github.com/roccoangelella/PiLink#readme"));
      return;
    }
    const document = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async startConfigured(): Promise<void> {
    this.requireTrustedWorkspace();
    if (!await this.ensureRuntimeModeSelection()) return;
    const snapshot = this.snapshot();
    const workflow = runtimeModeLabel(this.effectiveRuntimeMode(snapshot));
    if (snapshot.hostingMode !== "cloudflare-named") {
      await this.runCli(["start"], `Tunnel · ${workflow}`);
      return;
    }
    const hosting = await this.ensureNamedHostingSelection(snapshot);
    if (this.supervisor.isActive) await this.supervisor.stop();
    await this.runNamedHostingCli("start", hosting, snapshot, true);
    this.invalidateManagedHosting();
    const health = await waitForHealth(snapshot.port, 120_000);
    if (!health.online) throw new Error(`The persistent service did not become reachable: ${health.error || "timeout"}`);
    void vscode.window.showInformationMessage("VSPiLink and the Cloudflare Named Tunnel are running.");
  }

  private async serveConfigured(): Promise<void> {
    this.requireTrustedWorkspace();
    if (!await this.ensureRuntimeModeSelection()) return;
    const snapshot = this.snapshot();
    if (snapshot.hostingMode === "cloudflare-named") {
      throw new Error("This installation uses persistent Cloudflare services. Click ‘Start securely’; a second local process on port 3200 is blocked.");
    }
    await this.runCli(["serve"], `Local · ${runtimeModeLabel(this.effectiveRuntimeMode(snapshot))}`);
  }

  private async stopConfigured(): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    if (snapshot.hostingMode !== "cloudflare-named") {
      await this.supervisor.stop();
      return;
    }
    if (this.supervisor.isActive) await this.supervisor.stop();
    await this.runNamedHostingCli("stop", await this.ensureNamedHostingSelection(snapshot), snapshot, true);
    this.invalidateManagedHosting();
  }

  private async restartConfigured(): Promise<void> {
    this.requireTrustedWorkspace();
    if (!await this.ensureRuntimeModeSelection()) return;
    const snapshot = this.snapshot();
    if (snapshot.hostingMode !== "cloudflare-named") {
      await this.supervisor.restart();
      return;
    }
    const hosting = await this.ensureNamedHostingSelection(snapshot);
    if (this.supervisor.isActive) await this.supervisor.stop();
    await this.runNamedHostingCli("stop", hosting, snapshot, true);
    await this.runNamedHostingCli("start", hosting, snapshot, true);
    this.invalidateManagedHosting();
    const health = await waitForHealth(snapshot.port, 120_000);
    if (!health.online) throw new Error(`The persistent service did not become reachable after restart: ${health.error || "timeout"}`);
  }

  private namedHostingSelection(snapshot: ConfigSnapshot): HostingSelection & { kind: "cloudflare-named" } {
    const hosting = this.namedHostingPreference(snapshot);
    if (!hosting) {
      throw new Error("Secure Named Tunnel details are unavailable. Open ‘New guided setup’, choose Cloudflare Named Tunnel, and select the credential again.");
    }
    return hosting;
  }

  private namedHostingPreference(snapshot: ConfigSnapshot): (HostingSelection & { kind: "cloudflare-named" }) | undefined {
    const state = this.wizard.currentState;
    const appliedMatches = state.appliedHosting?.kind === "cloudflare-named" && state.appliedConfigPath &&
      path.resolve(state.appliedConfigPath) === path.resolve(snapshot.configPath);
    const currentMatches = state.hosting?.kind === "cloudflare-named" && state.configPath &&
      path.resolve(state.configPath) === path.resolve(snapshot.configPath);
    const hosting = appliedMatches ? state.appliedHosting : currentMatches ? state.hosting : undefined;
    return hosting?.kind === "cloudflare-named"
      ? hosting as HostingSelection & { kind: "cloudflare-named" }
      : undefined;
  }

  private async ensureNamedHostingSelection(
    snapshot: ConfigSnapshot,
    interactive = true,
  ): Promise<HostingSelection & { kind: "cloudflare-named" }> {
    const existing = this.namedHostingPreference(snapshot);
    if (existing?.credentialReference && existing.credentialLabel && existing.cloudflareAuthKind) {
      const stored = await this.cloudflareCredentials.get({
        reference: existing.credentialReference,
        label: existing.credentialLabel,
        kind: existing.cloudflareAuthKind,
      });
      if (stored) return existing;
    }
    if (!interactive) throw new Error("The Named Tunnel credential must be selected again before a managed command can run.");

    const key = path.resolve(snapshot.configPath);
    if (this.namedRecoveryInFlight?.key === key) return this.namedRecoveryInFlight.promise;
    const promise = this.recoverNamedHosting(snapshot, existing).finally(() => {
      if (this.namedRecoveryInFlight?.promise === promise) this.namedRecoveryInFlight = undefined;
    });
    this.namedRecoveryInFlight = { key, promise };
    return promise;
  }

  private async recoverNamedHosting(
    snapshot: ConfigSnapshot,
    preferredHosting?: HostingSelection,
  ): Promise<HostingSelection & { kind: "cloudflare-named" }> {
    this.requireTrustedWorkspace();
    const control = this.managedServerControlOptions();
    const evidence = inspectManagedNamedHosting(snapshot, {
      systemdUserDirectory: control.systemdUserDirectory,
      ...(control.expectedUid === undefined ? {} : { expectedUid: control.expectedUid }),
      ...(preferredHosting ? { preferredHosting } : {}),
    });
    let zoneName = evidence.hosting.zoneName as string;
    if (!evidence.zoneConfirmed) {
      const confirmed = await vscode.window.showInputBox({
        title: "Confirm the Cloudflare DNS zone",
        value: zoneName,
        placeHolder: "example.com",
        ignoreFocusOut: true,
        validateInput: (value) => {
          const zoneError = validateDnsHostname(value);
          if (zoneError) return zoneError;
          return validateHostnameInZone(evidence.hosting.mcpHostname as string, value) ||
            validateHostnameInZone(evidence.hosting.landingHostname as string, value);
        },
      });
      if (!confirmed) throw new Error("Named Tunnel recovery was cancelled before the DNS zone was confirmed.");
      zoneName = confirmed.trim().toLowerCase().replace(/\.$/u, "");
    }
    const authKind = evidence.hosting.cloudflareAuthKind;
    if (!authKind) throw new Error("The managed Named Tunnel authentication mode is unavailable.");
    const credential = await this.selectCloudflareCredential(authKind);
    if (!credential) throw new Error("Named Tunnel recovery was cancelled before a Cloudflare credential was selected.");
    const hosting = normalizeHostingSelection({
      ...evidence.hosting,
      zoneName,
      credentialReference: credential.reference,
      credentialLabel: credential.label,
    }, true);
    if (!hosting || hosting.kind !== "cloudflare-named" || !hosting.publicUrl) {
      throw new Error("The recovered Named Tunnel configuration is invalid.");
    }
    await this.wizard.adoptRuntime({
      workspace: snapshot.workspace,
      configPath: snapshot.configPath,
      publicUrl: hosting.publicUrl,
      mcpUrl: `${hosting.publicUrl}/sse`,
      hosting,
    });
    return hosting as HostingSelection & { kind: "cloudflare-named" };
  }

  private async runNamedHostingCli(
    command: "plan" | "provision" | "install" | "enable" | "start" | "stop" | "disable" | "status",
    hosting: HostingSelection & { kind: "cloudflare-named" },
    snapshot: ConfigSnapshot,
    apply: boolean,
  ): Promise<Record<string, unknown>> {
    if (apply && (command === "plan" || command === "status")) throw new Error("A read-only hosting command cannot be applied.");
    const reference = hosting.credentialReference;
    const label = hosting.credentialLabel;
    const kind = hosting.cloudflareAuthKind;
    if (!reference || !label || !kind) throw new Error("Select the Cloudflare credential again in the wizard.");
    const credential = await this.cloudflareCredentials.get({ reference, label, kind });
    if (!credential || credential.kind !== kind) throw new Error("The Cloudflare credential is no longer available in VS Code SecretStorage.");
    let credentialValid = false;
    try {
      const credentialStat = fs.statSync(credential.filePath);
      credentialValid = credentialStat.isFile() && credentialStat.size > 0 && credentialStat.size <= 64 * 1024;
    } catch {
      credentialValid = false;
    }
    if (!credentialValid) {
      throw new Error("The Cloudflare credential file is no longer valid.");
    }
    const sidecarNode = this.sidecarNodeRuntime();
    if (!sidecarNode.ok) throw new Error(sidecarNode.error);
    const nodeExecutable = absoluteExecutable(sidecarNode.executable);
    const cliPath = resolveCliPath(this.context.extensionPath);
    if (!fs.existsSync(cliPath)) throw new Error(`PiLink runtime not found: ${cliPath}.`);
    const cloudflaredPath = absoluteExecutable(snapshot.values.PI_CLOUDFLARED_PATH || "cloudflared", [
      "/usr/local/bin/cloudflared",
      "/usr/bin/cloudflared",
    ]);
    const systemctlPath = absoluteExecutable("systemctl", ["/usr/bin/systemctl", "/bin/systemctl"]);
    const systemdAnalyzePath = absoluteExecutable("systemd-analyze", ["/usr/bin/systemd-analyze", "/bin/systemd-analyze"]);
    const systemdUserDirectory = path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "systemd",
      "user",
    );
    const args = [
      "hosting", command,
      "--tunnel-name", hosting.tunnelName as string,
      "--origin", `http://127.0.0.1:${snapshot.port}`,
      "--zone", hosting.zoneName as string,
      "--mcp-hostname", hosting.mcpHostname as string,
      "--landing-hostname", hosting.landingHostname as string,
      "--auth-mode", kind === "origin-certificate" ? "certificate" : "token-file",
      ...(kind === "origin-certificate"
        ? ["--certificate-path", credential.filePath]
        : ["--token-file", credential.filePath, "--tunnel-id", hosting.tunnelId as string]),
      "--state-dir", path.join(path.dirname(snapshot.configPath), "cloudflare"),
      "--cloudflared-path", cloudflaredPath,
      "--node-path", nodeExecutable,
      "--pilink-cli-path", cliPath,
      "--pilink-config-path", snapshot.configPath,
      "--systemctl-path", systemctlPath,
      "--systemd-analyze-path", systemdAnalyzePath,
      "--systemd-user-dir", systemdUserDirectory,
      ...(typeof process.getuid === "function" ? ["--expected-owner-uid", String(process.getuid())] : []),
      ...(apply ? ["--apply"] : []),
    ];
    return runJsonCli({
      nodeExecutable,
      cliPath,
      args,
      cwd: snapshot.workspace,
      configPath: snapshot.configPath,
      environment: { PI_RUNTIME_MODE: this.effectiveRuntimeMode(snapshot) },
      timeoutMs: command === "provision" || command === "start" ? 180_000 : 120_000,
    });
  }

  private async managedHostingState(snapshot: ConfigSnapshot): Promise<DashboardState["managedHosting"]> {
    const empty: DashboardState["managedHosting"] = {
      configured: false,
      productionReady: false,
      serverState: "not-managed",
      tunnelState: "not-managed",
      enableState: "unknown",
    };
    if (snapshot.hostingMode !== "cloudflare-named") return empty;
    const key = `${snapshot.configPath}:${this.wizard.currentState.revision}`;
    if (this.managedHostingCache?.key === key && this.managedHostingCache.expiresAt > Date.now()) {
      return this.managedHostingCache.state;
    }
    let state: DashboardState["managedHosting"];
    try {
      const envelope = await this.runNamedHostingCli("status", await this.ensureNamedHostingSelection(snapshot, false), snapshot, false);
      const result = jsonObject(envelope.result);
      const hostingStatus = jsonObject(result?.hosting);
      const service = jsonObject(hostingStatus?.service);
      const systemd = jsonObject(result?.systemd);
      const publicUrls = jsonObject(hostingStatus?.publicUrls);
      const mcpOrigin = normalizeMcpEndpointOrigin(publicUrls?.mcp);
      const landingOrigin = safeHttpsUrl(publicUrls?.landing);
      state = {
        configured: true,
        productionReady: result?.productionReady === true,
        serverState: safeState(service?.serverState, "unknown"),
        tunnelState: safeState(service?.state, "unknown"),
        enableState: safeState(systemd?.tunnelEnableState, "unknown"),
        ...(mcpOrigin ? { publicUrl: mcpOrigin } : {}),
        ...(landingOrigin ? { landingUrl: landingOrigin } : {}),
      };
    } catch {
      try {
        const control = this.managedServerControlOptions();
        const preferredHosting = this.namedHostingPreference(snapshot);
        const evidence = inspectManagedNamedHosting(snapshot, {
          systemdUserDirectory: control.systemdUserDirectory,
          ...(control.expectedUid === undefined ? {} : { expectedUid: control.expectedUid }),
          ...(preferredHosting ? { preferredHosting } : {}),
        });
        const runtime = await readManagedUnitRuntimeState(control.systemctlPath);
        const publicUrl = normalizeMcpEndpointOrigin(`${evidence.hosting.publicUrl}/sse`);
        const landingUrl = safeHttpsUrl(`https://${evidence.hosting.landingHostname}`);
        state = {
          configured: true,
          productionReady: runtime.serverState === "active" && runtime.tunnelState === "active" && runtime.enableState === "enabled",
          serverState: runtime.serverState,
          tunnelState: runtime.tunnelState,
          enableState: runtime.enableState,
          ...(publicUrl ? { publicUrl } : {}),
          ...(landingUrl ? { landingUrl } : {}),
        };
      } catch (error) {
        state = {
          ...empty,
          configured: true,
          error: cleanMessage(error),
        };
      }
    }
    this.managedHostingCache = { key, expiresAt: Date.now() + (state.error ? 2_500 : 5_000), state };
    return state;
  }

  private invalidateManagedHosting(): void {
    this.managedHostingCache = undefined;
    this.mcpChanged.fire();
    void this.dashboard.refresh();
  }

  private agentAuthOptions(snapshot: ConfigSnapshot) {
    const sidecarNode = this.sidecarNodeRuntime();
    if (!sidecarNode.ok) throw new Error(sidecarNode.error);
    const cliPath = resolveCliPath(this.context.extensionPath);
    if (!fs.existsSync(cliPath)) throw new Error(`PiLink runtime not found: ${cliPath}.`);
    return {
      nodeExecutable: absoluteExecutable(sidecarNode.executable),
      cliPath,
      cwd: snapshot.workspace,
      configPath: snapshot.configPath,
    };
  }

  private async loadAgentCatalog(snapshot: ConfigSnapshot, refresh = false): Promise<AgentAuthCatalog> {
    const options = this.agentAuthOptions(snapshot);
    const key = `${options.nodeExecutable}:${options.cliPath}`;
    if (!refresh && this.agentCatalogCache?.key === key && (this.agentCatalogCache.expiresAt > Date.now() || this.agentAuth.busy)) {
      return this.agentCatalogCache.catalog;
    }
    const catalog = await this.agentAuth.catalog(options);
    this.agentCatalogCache = { key, expiresAt: Date.now() + 30_000, catalog };
    return catalog;
  }

  private async agentRuntimeState(
    snapshot: ConfigSnapshot,
    adminPayload: Record<string, unknown> | null,
    adminOnline: boolean,
  ): Promise<DashboardState["agentRuntime"]> {
    const aggregate = jsonObject(adminPayload?.agents);
    const runtime = jsonObject(aggregate?.runtime);
    const coordination = jsonObject(aggregate?.coordination);
    const counts = jsonObject(aggregate?.agents);
    const byStatusSource = jsonObject(counts?.by_status) || {};
    const byStatus: Record<string, number> = {};
    for (const [key, value] of Object.entries(byStatusSource)) {
      if (/^[a-z_]{1,40}$/.test(key) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) byStatus[key] = value;
    }
    let catalog: AgentAuthCatalog = { providers: [] };
    let agents: DashboardState["agentRuntime"]["agents"] = [];
    const errors: string[] = [];
    if (snapshot.configured && vscode.workspace.isTrusted) {
      try {
        catalog = await this.loadAgentCatalog(snapshot);
      } catch (error) {
        errors.push(cleanMessage(error));
      }
    }
    if (adminOnline && snapshot.bootstrapSecret) {
      try {
        agents = (await readAdminAgents(snapshot.port, snapshot.bootstrapSecret, 50)).agents;
      } catch (error) {
        errors.push(cleanMessage(error));
      }
    }
    const selectedProvider = snapshot.values.PI_AGENT_PROVIDER;
    const selectedModel = snapshot.values.PI_AGENT_MODEL;
    const provider = catalog.providers.find((entry) => entry.id === selectedProvider);
    const model = provider?.models.find((entry) => entry.id === selectedModel);
    return {
      state: safeState(aggregate?.state, adminOnline ? "unavailable" : "offline"),
      runtimeState: safeState(runtime?.state, adminOnline ? "unavailable" : "offline"),
      coordinationState: safeState(coordination?.state, adminOnline ? "unavailable" : "offline"),
      active: safeCount(counts?.active),
      retained: safeCount(counts?.retained),
      maxConcurrent: safeCount(counts?.max_concurrent),
      byStatus,
      ...(selectedProvider ? { selectedProvider } : {}),
      ...(selectedModel ? { selectedModel } : {}),
      ...(provider ? { selectedProviderName: provider.name } : {}),
      ...(model ? { selectedModelName: model.name } : {}),
      ...(provider?.configuredAuthType ? { configuredAuthType: provider.configuredAuthType } : {}),
      authReady: hasConfiguredAgentAuth(snapshot.values, provider?.configuredAuthType),
      catalogAvailable: catalog.providers.length > 0,
      authBusy: this.agentAuth.busy,
      agents,
      ...(errors.length ? { error: errors.join(" · ").slice(0, 500) } : {}),
    };
  }

  private async localChatState(
    snapshot: ConfigSnapshot,
    agents: DashboardState["agentRuntime"]["agents"],
    adminOnline: boolean,
  ): Promise<DashboardState["chat"]> {
    const selectionGeneration = this.chatSelectionGeneration;
    if (!vscode.workspace.isTrusted) {
      return { status: "needs-trust", busy: false, messages: [] };
    }
    if (!snapshot.configured) {
      return { status: "needs-setup", busy: this.chatCommandBusy, messages: [] };
    }
    const currentWorkspace = this.defaultWorkspacePath();
    if (!currentWorkspace) {
      return { status: "needs-workspace", busy: this.chatCommandBusy, messages: [] };
    }
    if (path.resolve(snapshot.workspace) !== path.resolve(currentWorkspace)) {
      return { status: "workspace-mismatch", busy: this.chatCommandBusy, messages: [] };
    }
    if (!snapshot.values.PI_AGENT_PROVIDER || !snapshot.values.PI_AGENT_MODEL) {
      return { status: "needs-login", busy: this.chatCommandBusy, messages: [] };
    }
    if (!adminOnline || !snapshot.bootstrapSecret) {
      return { status: "offline", busy: this.chatCommandBusy, messages: [] };
    }

    let selected = this.activeChatAgentId
      ? agents.find((agent) => agent.agentId === this.activeChatAgentId && !this.dismissedChatAgentIds.has(agent.agentId))
      : undefined;
    if (!selected) {
      selected = [...agents].reverse().find((agent) =>
        agent.label === CHAT_AGENT_LABEL &&
        ACTIVE_CHAT_STATUSES.has(agent.status) &&
        !this.dismissedChatAgentIds.has(agent.agentId)
      );
      if (selected) await this.setActiveChatAgent(selected.agentId, selectionGeneration);
      else if (this.activeChatAgentId) await this.setActiveChatAgent(undefined, selectionGeneration);
    }
    if (!selected || selectionGeneration !== this.chatSelectionGeneration) {
      return { status: "ready", busy: this.chatCommandBusy, messages: [] };
    }

    try {
      const output = await readAdminAgentOutput(snapshot.port, snapshot.bootstrapSecret, selected.agentId);
      if (selectionGeneration !== this.chatSelectionGeneration || this.dismissedChatAgentIds.has(selected.agentId)) {
        return { status: "ready", busy: this.chatCommandBusy, messages: [] };
      }
      return {
        agentId: selected.agentId,
        status: selected.status,
        busy: this.chatCommandBusy || ["starting", "running", "cancelling", "stopping"].includes(selected.status),
        messages: output.map((entry) => ({
          cursor: entry.cursor,
          role: entry.channel === "user" ? "user" : entry.channel === "assistant" ? "assistant" : "status",
          text: entry.text,
          ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
        })),
        ...(selected.hasError ? { error: "The Pi session reported an error. Open Agents for details." } : {}),
      };
    } catch (error) {
      return {
        agentId: selected.agentId,
        status: selected.status,
        busy: this.chatCommandBusy,
        messages: [],
        error: cleanMessage(error),
      };
    }
  }

  private async restartAfterAgentChange(previous: ConfigSnapshot): Promise<void> {
    this.mcpChanged.fire();
    if (this.supervisor.isActive) {
      await this.supervisor.restart();
      return;
    }
    if (previous.hostingMode === "cloudflare-named" && previous.bootstrapSecret) {
      const admin = await readAdminStatus(previous.port, previous.bootstrapSecret, 2_000);
      if (admin.online) {
        await this.restartManagedChatServer(previous);
        const ready = await waitForAdminRuntime(previous.port, previous.bootstrapSecret, 120_000);
        if (!ready.online || !inspectAdminAgentRuntime(ready.payload).ready) {
          throw new Error(`The PiLink service restarted, but the agent runtime is not ready: ${ready.error || "status unavailable"}.`);
        }
        return;
      }
    }
    void vscode.window.showInformationMessage("Agent configuration saved. PiLink will apply it the next time chat starts.");
  }

  private async runCli(
    args: string[],
    mode: string,
    revealTerminal = true,
    workspaceOverride?: string,
    environment?: Readonly<Record<string, string>>,
    options: { allowNamedLocalServe?: boolean } = {},
  ): Promise<void> {
    this.requireTrustedWorkspace();
    const workspacePath = workspaceOverride || await this.selectWorkspace();
    if (!workspacePath) return;
    const snapshot = this.snapshot(workspacePath);
    if (
      snapshot.hostingMode === "cloudflare-named" &&
      (args[0] === "start" || args[0] === "serve") &&
      !(options.allowNamedLocalServe && args[0] === "serve")
    ) {
      throw new Error("The Named Tunnel is managed by systemd. Use the ‘Start securely’ button to avoid starting a second process on the same port.");
    }
    const cliPath = resolveCliPath(this.context.extensionPath);
    if (!fs.existsSync(cliPath)) throw new Error(`PiLink runtime not found: ${cliPath}. Run npm run build.`);
    const sidecarNode = this.sidecarNodeRuntime();
    if (!sidecarNode.ok) throw new Error(sidecarNode.error);
    const runtimeMode = this.effectiveRuntimeMode(snapshot);
    await this.supervisor.start({
      nodeExecutable: sidecarNode.executable,
      cliPath,
      args,
      cwd: workspacePath,
      configPath: snapshot.configPath,
      mode,
      revealTerminal,
      environment: {
        ...(environment || {}),
        // The selected workflow is authoritative for every supervised launch;
        // this also makes legacy configurations safe before they are edited.
        PI_RUNTIME_MODE: runtimeMode,
      },
    });
  }

  private snapshot(workspaceOverride?: string): ConfigSnapshot {
    const workspacePath = workspaceOverride || this.defaultWorkspacePath() || "";
    const config = vscode.workspace.getConfiguration("vspilink", this.configurationScope(workspaceOverride));
    const configuredPath = config.get<string>("configPath", "");
    return readConfigSnapshot(resolveConfigPath(configuredPath, workspacePath), workspacePath);
  }

  private effectiveRuntimeMode(snapshot: ConfigSnapshot): RuntimeMode {
    return this.runtimeModeStore.load() || runtimeModeFromConfig(snapshot.values.PI_RUNTIME_MODE) || DEFAULT_RUNTIME_MODE;
  }

  private async ensureRuntimeModeSelection(): Promise<boolean> {
    if (this.runtimeModeStore.load()) return true;
    const configured = runtimeModeFromConfig(this.snapshot().values.PI_RUNTIME_MODE);
    if (configured) {
      await this.runtimeModeStore.set(configured);
      return true;
    }
    await this.selectRuntimeMode("");
    return this.runtimeModeStore.load() !== undefined;
  }

  private sidecarNodeRuntime(): SidecarNodeRuntime {
    const configured = vscode.workspace.getConfiguration("vspilink").get<string>("nodeExecutable", "").trim();
    const key = JSON.stringify([
      configured,
      process.execPath,
      process.version,
      process.env.PATH || "",
      process.env.HOME || "",
      process.env.XDG_DATA_HOME || "",
      process.env.LOCALAPPDATA || "",
    ]);
    if (this.sidecarNodeCache?.key === key) return this.sidecarNodeCache.runtime;
    const runtime = resolveSidecarNodeRuntime({
      configured,
      processExecutable: process.execPath,
      processVersion: process.version,
    });
    this.sidecarNodeCache = { key, runtime };
    return runtime;
  }

  private nativeScope(): McpScope {
    const configured = vscode.workspace.getConfiguration("vspilink").get<string>("nativeMcpScope", "mcp:read");
    return isMcpScope(configured) ? configured : "mcp:read";
  }

  private mcpVersion(snapshot: ConfigSnapshot, scope: McpScope): string {
    const configId = createHash("sha256").update(snapshot.configPath).digest("hex").slice(0, 12);
    return `${this.context.extension.packageJSON.version || "1.1.0"}:${configId}:${scope}:${snapshot.port}`;
  }

  private requireTrustedWorkspace(): void {
    if (vscode.workspace.isTrusted) return;
    void vscode.commands.executeCommand("workbench.trust.manage");
    throw new Error("VSPiLink blocks this operation in Restricted Mode. Trust the workspace to continue.");
  }

  private configurationScope(workspaceOverride?: string): vscode.Uri | undefined {
    if (workspaceOverride) {
      const folders = vscode.workspace.workspaceFolders || [];
      const resolvedOverride = path.resolve(workspaceOverride);
      const exactFolder = folders.find((folder) => samePath(folder.uri.fsPath, resolvedOverride));
      if (exactFolder) return exactFolder.uri;
      const containingFolder = folders.find((folder) => isPathInside(folder.uri.fsPath, resolvedOverride));
      if (containingFolder) return containingFolder.uri;
      return vscode.Uri.file(workspaceOverride);
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    if (activeFolder) return activeFolder.uri;
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private defaultWorkspacePath(): string | undefined {
    return this.configurationScope()?.fsPath || this.selectedWorkspacePath;
  }

  private async selectWorkspace(resource?: vscode.Uri, forcePicker = false): Promise<string | undefined> {
    if (resource?.scheme === "file") {
      try {
        return fs.statSync(resource.fsPath).isDirectory() ? resource.fsPath : path.dirname(resource.fsPath);
      } catch {
        return path.dirname(resource.fsPath);
      }
    }
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 1 && !forcePicker) return folders[0].uri.fsPath;
    if (folders.length > 1 && !forcePicker) {
      const selected = await vscode.window.showQuickPick(
        folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, value: folder.uri.fsPath })),
        { title: "Choose the VSPiLink workspace" },
      );
      return selected?.value;
    }
    const selected = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: "Choose the VSPiLink workspace" });
    return selected?.[0]?.fsPath;
  }
}

function validateRedirectUris(value: string): string | undefined {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length) return "Enter at least one redirect URI.";
  for (const entry of entries) {
    try {
      const uri = new URL(entry);
      if (uri.protocol !== "http:" && uri.protocol !== "https:") return `${entry} does not use HTTP(S).`;
    } catch {
      return `${entry} is not a valid absolute URL.`;
    }
  }
  return undefined;
}

function runtimeModeFromConfig(value: unknown): RuntimeMode | undefined {
  return isRuntimeMode(value) ? value : undefined;
}

function runtimeModeLabel(mode: RuntimeMode): string {
  return mode === "collaboration" ? "Public chat & orchestration" : "Single-agent";
}

function validatePublicHttpsOrigin(value: string): string | undefined {
  const normalized = normalizeHostingSelection({ kind: "custom-domain", publicUrl: value });
  return normalized ? undefined : "Use an HTTPS origin without credentials, a port, path, query, or fragment.";
}

function validateDnsHostname(value: string): string | undefined {
  const hostname = value.trim().toLowerCase().replace(/\.$/u, "");
  if (!hostname || hostname.length > 253 || hostname.includes("..")) return "Enter a valid DNS hostname.";
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
  return hostname.split(".").length >= 2 && hostname.split(".").every((part) => label.test(part))
    ? undefined
    : "Enter a valid DNS hostname.";
}

function validateHostnameInZone(value: string, rawZone: string): string | undefined {
  const invalid = validateDnsHostname(value);
  if (invalid) return invalid;
  const hostname = value.trim().toLowerCase().replace(/\.$/u, "");
  const zone = rawZone.trim().toLowerCase().replace(/\.$/u, "");
  return hostname === zone || hostname.endsWith(`.${zone}`)
    ? undefined
    : "The hostname must belong to the selected DNS zone.";
}

function validateTunnelName(value: string): string | undefined {
  return /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])$/u.test(value.trim())
    ? undefined
    : "Use 2–63 characters: letters, numbers, dots, hyphens, or underscores.";
}

function validateTunnelId(value: string): string | undefined {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.trim())
    ? undefined
    : "Enter the complete Cloudflare tunnel UUID.";
}

function validatePairingUrl(value: string, expectedPublicUrl: string, expiresAt: string): string {
  let pairing: URL;
  let expected: URL;
  try {
    pairing = new URL(value);
    expected = new URL(expectedPublicUrl);
  } catch {
    throw new Error("The server returned an invalid OAuth pairing URL.");
  }
  if (
    pairing.protocol !== "https:" || pairing.origin !== expected.origin || pairing.pathname !== "/oauth/pair" ||
    pairing.username || pairing.password || pairing.hash ||
    [...pairing.searchParams.keys()].some((key) => key !== "code") ||
    !/^[A-Za-z0-9_-]{20,512}$/.test(pairing.searchParams.get("code") || "")
  ) throw new Error("The server returned a disallowed OAuth pairing destination.");
  const expiration = Date.parse(expiresAt);
  if (!Number.isFinite(expiration) || expiration <= Date.now()) throw new Error("The OAuth pairing request has already expired.");
  return pairing.toString();
}

function isLoopbackBrowserHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.replace(/[\r\n\0]+/g, " ").slice(0, 300))
    : [];
}

function cleanMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || "Hosting status unavailable."))
    .replace(/[\r\n\0]+/g, " ")
    .slice(0, 500);
}

function safeState(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9_.-]{1,80}$/i.test(value) ? value : fallback;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function providerRank(provider: AgentProviderCatalogEntry): number {
  const value = `${provider.id} ${provider.name}`.toLowerCase();
  if (value.includes("openai") && value.includes("codex")) return 0;
  if (value.includes("openai")) return 1;
  return 2;
}

function authTypeLabel(value: "oauth" | "api_key"): string {
  return value === "oauth" ? "OAuth" : "API key";
}

function formatContextWindow(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "not reported";
  return value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);
}

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    if (parsed.pathname !== "/" && parsed.pathname !== "") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function absoluteExecutable(value: string, preferred: readonly string[] = []): string {
  const expanded = value.replace(/^~(?=$|[\\/])/, os.homedir());
  const hasPath = path.isAbsolute(expanded) || /[\\/]/.test(expanded);
  const candidates = hasPath
    ? [path.resolve(expanded)]
    : [
        ...preferred,
        ...(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, expanded)),
      ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const status = fs.statSync(candidate);
      if (!status.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue through the allowlisted executable locations.
    }
  }
  throw new Error(`Required executable not found: ${path.basename(expanded)}.`);
}
