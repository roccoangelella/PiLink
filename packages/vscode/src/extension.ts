import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { chatGptNavigation, type ChatGptDestination } from "./chatgpt-links.js";
import {
  localServerUrl,
  provisionWizardConfiguration,
  readConfigSnapshot,
  resolveConfigPath,
  updateEnvValue,
  writePrivateFile,
  type ConfigSnapshot,
} from "./configuration.js";
import { DashboardProvider } from "./dashboard.js";
import { effectiveProcessState } from "./dashboard-model.js";
import {
  createOwnerPairing,
  readAdminCollaboration,
  readAdminStatus,
  readHealth,
  waitForHealth,
  waitForPublicHealth,
} from "./health.js";
import {
  hostingStartPlan,
  normalizeHostingSelection,
  type HostingSelection,
} from "./hosting-model.js";
import { resolveSidecarNodeRuntime, type SidecarNodeRuntime } from "./node-runtime.js";
import { ProcessSupervisor, resolveCliPath, runJsonCli } from "./process-supervisor.js";
import type { DashboardState, WebviewCommand, WebviewCommandMessage } from "./protocol.js";
import { DEFAULT_RUNTIME_MODE, isRuntimeMode, type RuntimeMode } from "./runtime-mode.js";

let activeController: ExtensionController | undefined;

const SELECTED_WORKSPACE_KEY = "pilink.selectedWorkspace.v1";
const QUICK_TUNNEL_AUTHORIZED_ORIGIN_KEY = "pilink.quickTunnelAuthorizedOrigin.v1";

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
  private readonly disposables: vscode.Disposable[] = [];
  private readonly dashboard: DashboardProvider;
  private sidecarNodeCache?: { key: string; runtime: SidecarNodeRuntime };
  private selectedWorkspacePath?: string;
  private disposing = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.selectedWorkspacePath = context.workspaceState.get<string>(SELECTED_WORKSPACE_KEY);
    this.dashboard = new DashboardProvider(
      context.extensionUri,
      () => this.dashboardState(),
      (message) => this.handleWebviewCommand(message),
    );
  }

  async activate(): Promise<void> {
    this.registerViews();
    this.registerCommands();
    this.disposables.push(
      this.supervisor.onDidChange(() => void this.dashboard.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("vspilink")) return;
        if (event.affectsConfiguration("vspilink.nodeExecutable")) this.sidecarNodeCache = undefined;
        void this.dashboard.refresh();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.dashboard.refresh()),
    );

    const installedVersion = String(this.context.extension.packageJSON.version || "0");
    const lastOpenedVersion = this.context.globalState.get<string>("pilink.lastOpenedVersion");
    const firstOpenForVersion = lastOpenedVersion !== installedVersion;
    if (firstOpenForVersion) await this.context.globalState.update("pilink.lastOpenedVersion", installedVersion);

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
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    await this.supervisor.disposeAsync();
  }

  private registerViews(): void {
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(
        "vspilink.sidebarSecondaryView",
        this.dashboard,
        { webviewOptions: { retainContextWhenHidden: false } },
      ),
    );
  }

  private registerCommands(): void {
    const register = (name: string, callback: (...args: unknown[]) => unknown) => {
      this.disposables.push(vscode.commands.registerCommand(`vspilink.${name}`, callback));
    };

    // Public command-palette surface.
    register("openSidebar", () => this.openSidebar());
    register("openPanel", () => this.dashboard.openPanel());
    register("connectChatGpt", () => this.connectChatGpt());
    register("stop", () => this.stopConfigured());
    register("guidedSetup", () => this.reconfigure());
    register("openConfig", () => this.openConfig());
    register("refresh", () => this.dashboard.refresh());
    register("useWorkspace", (resource) => this.chooseWorkspace(resource instanceof vscode.Uri ? resource : undefined));
    register("openDocs", () => this.openDocs());

    // State-aware dashboard commands. They remain hidden from the palette.
    register("manageTrust", () => vscode.commands.executeCommand("workbench.trust.manage"));
    register("chooseWorkspace", () => this.chooseWorkspace(undefined, true));
    register("setupStable", () => this.setupStable());
    register("setupQuick", () => this.setupAndStart({ kind: "quick-tunnel" }));
    register("setupLocal", () => this.setupAndStart({ kind: "local" }));
    register("start", () => this.startConfigured());
    register("restart", () => this.restartConfigured());
    register("openChatGpt", () => this.openChatGptInVsCode());
    register("copyMcpUrl", () => this.copyMcpUrl());
    register("openTerminal", () => this.showTerminal());
    register("switchToSingle", () => this.switchToSingle());
  }

  private async handleWebviewCommand(message: WebviewCommandMessage): Promise<void> {
    const commandMap: Record<WebviewCommand, string> = {
      refresh: "vspilink.refresh",
      manageTrust: "vspilink.manageTrust",
      chooseWorkspace: "vspilink.chooseWorkspace",
      setupStable: "vspilink.setupStable",
      setupQuick: "vspilink.setupQuick",
      setupLocal: "vspilink.setupLocal",
      connectChatGpt: "vspilink.connectChatGpt",
      openChatGpt: "vspilink.openChatGpt",
      start: "vspilink.start",
      stop: "vspilink.stop",
      restart: "vspilink.restart",
      reconfigure: "vspilink.guidedSetup",
      openConfig: "vspilink.openConfig",
      copyMcpUrl: "vspilink.copyMcpUrl",
      openTerminal: "vspilink.openTerminal",
      openPanel: "vspilink.openPanel",
      openDocs: "vspilink.openDocs",
      switchToSingle: "vspilink.switchToSingle",
    };
    await vscode.commands.executeCommand(commandMap[message.command]);
  }

  private async dashboardState(): Promise<DashboardState> {
    const snapshot = this.snapshot();
    const health = await readHealth(snapshot.port);
    const admin = health.online && snapshot.bootstrapSecret
      ? await readAdminStatus(snapshot.port, snapshot.bootstrapSecret)
      : { online: false, chatGptConnected: false, activeSessions: 0, payload: null };

    const publicUrl = this.publicUrl(snapshot);
    const persistedChatGptClients = snapshot.clients.filter((client) => client.chatGpt);
    const chatGptActive = admin.chatGptConnected;
    const quickTunnel = snapshot.hostingMode === "quick-tunnel";
    let quickAuthorizedOrigin = this.context.workspaceState.get<string>(QUICK_TUNNEL_AUTHORIZED_ORIGIN_KEY) || "";
    if (quickTunnel && chatGptActive && publicUrl.startsWith("https://") && quickAuthorizedOrigin !== publicUrl) {
      quickAuthorizedOrigin = publicUrl;
      await this.context.workspaceState.update(QUICK_TUNNEL_AUTHORIZED_ORIGIN_KEY, publicUrl);
    }
    const durableAuthorization = persistedChatGptClients.some((client) => client.authorized);
    const chatGptAuthorized = quickTunnel
      ? chatGptActive || (Boolean(quickAuthorizedOrigin) && quickAuthorizedOrigin === publicUrl && durableAuthorization)
      : durableAuthorization;
    const chatGptConfigured = persistedChatGptClients.length > 0 || chatGptActive;
    const chatGptConnected = chatGptAuthorized || chatGptActive;

    let activity: DashboardState["activity"] = [];
    if (admin.online && snapshot.bootstrapSecret) {
      try {
        const collaboration = await readAdminCollaboration(snapshot.port, snapshot.bootstrapSecret);
        activity = collaboration.activity.slice(-8).map((item) => ({
          tool: item.tool,
          startedAt: item.startedAt,
          durationMs: item.durationMs,
          outcome: item.outcome,
        }));
      } catch {
        // Single-agent servers may not expose the collaboration projection.
      }
    }

    const processState = effectiveProcessState(
      this.supervisor.viewState,
      admin.online,
      "not-managed",
      "not-managed",
    );
    const sidecarNode = this.sidecarNodeRuntime();
    const runtimeMode = runtimeModeFromConfig(snapshot.values.PI_RUNTIME_MODE) || DEFAULT_RUNTIME_MODE;

    return {
      configured: snapshot.configured,
      trusted: vscode.workspace.isTrusted,
      workspace: snapshot.workspace || this.defaultWorkspacePath() || "",
      configPath: snapshot.configPath,
      process: processState,
      hostingMode: snapshot.hostingMode,
      runtimeMode,
      unsafeFullAccess: snapshot.unsafeFullAccess,
      mcpUrl: `${publicUrl.replace(/\/$/u, "")}/sse`,
      publicUrl,
      externalMcp: {
        configured: chatGptConfigured,
        authorized: chatGptAuthorized,
        active: chatGptActive,
        connected: chatGptConnected,
        activeSessions: admin.activeSessions,
      },
      activity,
      version: String(this.context.extension.packageJSON.version || "2.2.0"),
      nodeVersion: sidecarNode.version || "not detected",
      ...(!sidecarNode.ok ? { error: sidecarNode.error } : {}),
    };
  }

  private publicUrl(snapshot: ConfigSnapshot): string {
    if ((snapshot.hostingMode === "quick-tunnel" || snapshot.hostingMode === "nip-io") && this.supervisor.capturedPublicUrl) {
      return this.supervisor.capturedPublicUrl.replace(/\/$/u, "");
    }
    return snapshot.serverUrl.replace(/\/$/u, "");
  }

  private async openSidebar(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.view.extension.vspilinkSecondaryViewContainer");
    } catch {
      this.dashboard.openPanel();
    }
  }

  private async chooseWorkspace(resource?: vscode.Uri, forcePicker = false): Promise<void> {
    this.requireTrustedWorkspace();
    const target = await this.selectWorkspace(resource, forcePicker);
    if (!target) return;
    this.selectedWorkspacePath = path.resolve(target);
    await this.context.workspaceState.update(SELECTED_WORKSPACE_KEY, this.selectedWorkspacePath);

    const snapshot = this.snapshot(target);
    if (!snapshot.configured || samePath(snapshot.workspace, target)) {
      await this.dashboard.refresh();
      return;
    }

    const approval = await vscode.window.showWarningMessage(
      `Use ${target} as the PiLink project instead of ${snapshot.workspace}?`,
      {
        modal: true,
        detail: "Authorized MCP clients will see the new project. OAuth and hosting settings remain unchanged.",
      },
      "Use this project",
    );
    if (approval !== "Use this project") return;

    if (await this.detectExternalRuntime(snapshot)) {
      throw new Error("PiLink is running outside this VS Code session. Stop it with the CLI before changing the project.");
    }
    const wasRunning = this.supervisor.isActive;
    if (wasRunning) await this.supervisor.stop();
    let contents = fs.readFileSync(snapshot.configPath, "utf8");
    contents = updateEnvValue(contents, "PI_WORK_DIR", path.resolve(target));
    writePrivateFile(snapshot.configPath, contents.endsWith("\n") ? contents : `${contents}\n`);
    if (wasRunning) await this.startConfigured();
    await this.dashboard.refresh();
  }

  private async setupStable(): Promise<void> {
    this.requireTrustedWorkspace();
    const selected = await vscode.window.showQuickPick([
      {
        label: "Cloudflare fixed domain",
        description: "Recommended · stable HTTPS URL and automatic tunnel/DNS provisioning",
        value: "cloudflare-fixed" as const,
      },
      {
        label: "Existing HTTPS domain",
        description: "Use an HTTPS reverse proxy you already operate",
        value: "custom-domain" as const,
      },
    ], {
      title: "PiLink · Stable endpoint",
      placeHolder: "Choose how the remote MCP endpoint should stay reachable",
    });
    if (!selected) return;
    const hosting = await this.collectHostingSelection(selected.value);
    if (!hosting) return;
    await this.setupAndStart(hosting);
  }

  private async reconfigure(): Promise<void> {
    this.requireTrustedWorkspace();
    const selected = await vscode.window.showQuickPick([
      {
        label: "Cloudflare fixed domain",
        description: "Stable HTTPS URL · PiLink provisions tunnel and DNS",
        value: "cloudflare-fixed" as const,
      },
      {
        label: "Existing HTTPS domain",
        description: "Stable endpoint through your reverse proxy",
        value: "custom-domain" as const,
      },
      {
        label: "Cloudflare Quick Tunnel",
        description: "Temporary evaluation URL; reconnect after the URL changes",
        value: "quick-tunnel" as const,
      },
      {
        label: "Local only",
        description: "No public endpoint",
        value: "local" as const,
      },
    ], {
      title: "PiLink · Reconfigure endpoint",
      placeHolder: "All graphical setup uses single-agent and project-folder access",
    });
    if (!selected) return;
    const hosting = await this.collectHostingSelection(selected.value);
    if (!hosting) return;
    await this.setupAndStart(hosting);
  }

  private async collectHostingSelection(
    kind: "cloudflare-fixed" | "custom-domain" | "quick-tunnel" | "local",
  ): Promise<HostingSelection | undefined> {
    if (kind === "quick-tunnel" || kind === "local") return { kind };

    if (kind === "custom-domain") {
      const publicUrl = await vscode.window.showInputBox({
        title: "Public HTTPS origin",
        prompt: "Enter the stable HTTPS origin already routed to this PiLink machine. Do not include /sse.",
        placeHolder: "https://mcp.example.com",
        ignoreFocusOut: true,
        validateInput: validatePublicHttpsOrigin,
      });
      if (!publicUrl) return undefined;
      return normalizeHostingSelection({ kind, publicUrl });
    }

    const publicUrl = await vscode.window.showInputBox({
      title: "Cloudflare hostname",
      prompt: "Enter a hostname in a DNS zone already managed by your Cloudflare account. Do not include /sse.",
      placeHolder: "https://mcp.example.com",
      ignoreFocusOut: true,
      validateInput: validatePublicHttpsOrigin,
    });
    if (!publicUrl) return undefined;
    const apiToken = await vscode.window.showInputBox({
      title: "Cloudflare API token",
      prompt: "Use a scoped token with Cloudflare Tunnel Edit, DNS Edit, and Zone Read. PiLink uses it once and does not save it.",
      placeHolder: "Paste the scoped Cloudflare API token",
      password: true,
      ignoreFocusOut: true,
      validateInput: validateCloudflareApiToken,
    });
    if (!apiToken) return undefined;

    const workspace = await this.requireWorkspace();
    const provisioned = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Provision Cloudflare fixed domain",
      cancellable: false,
    }, () => this.provisionFixedDomainViaCli(workspace, publicUrl, apiToken));
    const hosting = normalizeHostingSelection({
      kind,
      publicUrl,
      tunnelId: provisioned.tunnelId,
    });
    if (!hosting) throw new Error("Cloudflare provisioning returned an invalid fixed-domain configuration.");
    return { ...hosting, credentialLabel: provisioned.tokenFile };
  }

  private async provisionFixedDomainViaCli(
    workspace: string,
    publicUrl: string,
    apiToken: string,
  ): Promise<{ tunnelId: string; tokenFile: string }> {
    const snapshot = this.snapshot(workspace);
    const cliPath = resolveCliPath(this.context.extensionPath);
    if (!fs.existsSync(cliPath)) throw new Error(`PiLink runtime not found at ${cliPath}. Build or reinstall PiLink.`);
    const sidecarNode = this.sidecarNodeRuntime();
    if (!sidecarNode.ok) throw new Error(sidecarNode.error);
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
        `http://127.0.0.1:${snapshot.port}`,
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
    const tokenFile = typeof result?.tokenFile === "string" ? result.tokenFile : "";
    if (validateTunnelId(tunnelId)) throw new Error("Cloudflare provisioning returned an invalid tunnel UUID.");
    if (!tokenFile || !path.isAbsolute(tokenFile) || !isPathInside(tokenDirectory, tokenFile)) {
      throw new Error("Cloudflare provisioning returned an invalid tunnel-token path.");
    }
    const stat = fs.statSync(tokenFile);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024) {
      throw new Error("Cloudflare provisioning returned an invalid tunnel-token file.");
    }
    return { tunnelId, tokenFile };
  }

  private async setupAndStart(hosting: HostingSelection): Promise<void> {
    this.requireTrustedWorkspace();
    const workspace = await this.requireWorkspace();
    const before = this.snapshot(workspace);
    if (await this.detectExternalRuntime(before)) {
      throw new Error("PiLink is already running outside this VS Code session. Stop that instance with the CLI before reconfiguring it.");
    }
    if (this.supervisor.isActive) await this.supervisor.stop();

    provisionWizardConfiguration({
      configPath: before.configPath,
      workspace,
      hosting,
      port: before.port,
      runtimeMode: DEFAULT_RUNTIME_MODE,
    });
    if (hosting.kind === "cloudflare-fixed") {
      const tokenFile = hosting.credentialLabel;
      if (!tokenFile || !path.isAbsolute(tokenFile)) {
        throw new Error("The Cloudflare tunnel token file is unavailable. Run fixed-domain setup again.");
      }
      let contents = fs.readFileSync(before.configPath, "utf8");
      contents = updateEnvValue(contents, "PI_CLOUDFLARE_TOKEN_FILE", tokenFile);
      writePrivateFile(before.configPath, contents.endsWith("\n") ? contents : `${contents}\n`);
    }

    await this.startConfigured();
    await this.dashboard.refresh();
  }

  private async startConfigured(): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    if (!snapshot.configured) {
      await this.reconfigure();
      return;
    }
    if (snapshot.unsafeFullAccess) {
      throw new Error("This configuration enables Full access. Reconfigure PiLink safely in VS Code, or use the CLI if unrestricted machine access is intentional.");
    }
    const existing = await readHealth(snapshot.port, 1_500);
    if (existing.online) {
      await this.dashboard.refresh();
      return;
    }
    if (snapshot.hostingMode === "cloudflare-named") {
      throw new Error("This project uses the legacy managed Named-Tunnel service. Reconfigure it in PiLink for VS Code, or manage that service with the CLI.");
    }

    const plan = startPlanFromSnapshot(snapshot);
    await this.runServer(snapshot, plan.command, plan.label);
    const health = await waitForHealth(snapshot.port, 120_000);
    if (!health.online) throw new Error(`PiLink did not become reachable: ${health.error || "timeout"}`);

    if (plan.public) {
      const publicUrl = snapshot.hostingMode === "quick-tunnel"
        ? await this.supervisor.waitForPublicUrl(120_000)
        : this.publicUrl(this.snapshot());
      const publicHealth = await waitForPublicHealth(publicUrl, 45_000);
      if (!publicHealth.online) {
        throw new Error(`The public HTTPS endpoint is not ready: ${publicHealth.error || "timeout"}`);
      }
    }
    await this.dashboard.refresh();
  }

  private async runServer(snapshot: ConfigSnapshot, command: "start" | "serve", label: string): Promise<void> {
    const cliPath = resolveCliPath(this.context.extensionPath);
    if (!fs.existsSync(cliPath)) throw new Error(`PiLink runtime not found at ${cliPath}. Build or reinstall PiLink.`);
    const sidecarNode = this.sidecarNodeRuntime();
    if (!sidecarNode.ok) throw new Error(sidecarNode.error);
    const runtimeMode = runtimeModeFromConfig(snapshot.values.PI_RUNTIME_MODE) || DEFAULT_RUNTIME_MODE;
    await this.supervisor.start({
      nodeExecutable: sidecarNode.executable,
      cliPath,
      args: [command],
      cwd: snapshot.workspace,
      configPath: snapshot.configPath,
      mode: label,
      revealTerminal: false,
      environment: {
        PI_RUNTIME_MODE: runtimeMode,
        PI_OAUTH_CONSENT_MODE: "paired",
        PILINK_OAUTH_SETUP_DRIVER: "vscode",
      },
    });
  }

  private async stopConfigured(): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    if (this.supervisor.isActive) {
      await this.supervisor.stop();
      await this.dashboard.refresh();
      return;
    }
    const health = await readHealth(snapshot.port, 1_500);
    if (health.online) {
      throw new Error("PiLink is running outside this VS Code session. Stop that instance with the PiLink CLI or its service manager.");
    }
    await this.dashboard.refresh();
  }

  private async restartConfigured(): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    if (snapshot.unsafeFullAccess) {
      throw new Error("VSPiLink will not restart a saved Full-access configuration. Reconfigure safely or use the CLI deliberately.");
    }
    if (this.supervisor.isActive) {
      await this.supervisor.stop();
      await this.startConfigured();
      return;
    }
    const health = await readHealth(snapshot.port, 1_500);
    if (health.online) {
      throw new Error("PiLink is running outside this VS Code session. Restart it with the CLI or its service manager.");
    }
    await this.startConfigured();
  }

  private async switchToSingle(): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    if (!snapshot.configured) return;
    if (runtimeModeFromConfig(snapshot.values.PI_RUNTIME_MODE) !== "collaboration") return;
    if (await this.detectExternalRuntime(snapshot)) {
      throw new Error("PiLink is running outside this VS Code session. Stop it before switching the workflow.");
    }
    const wasRunning = this.supervisor.isActive;
    if (wasRunning) await this.supervisor.stop();
    let contents = fs.readFileSync(snapshot.configPath, "utf8");
    contents = updateEnvValue(contents, "PI_RUNTIME_MODE", "single");
    writePrivateFile(snapshot.configPath, contents.endsWith("\n") ? contents : `${contents}\n`);
    if (wasRunning) await this.startConfigured();
    await this.dashboard.refresh();
    void vscode.window.showInformationMessage("PiLink now uses the single-agent workflow.");
  }

  private async connectChatGpt(): Promise<void> {
    this.requireTrustedWorkspace();
    let snapshot = this.snapshot();
    if (!snapshot.configured) {
      await this.setupStable();
      return;
    }
    if (snapshot.unsafeFullAccess) {
      throw new Error("Reconfigure PiLink for project-folder access before connecting ChatGPT through the graphical workflow.");
    }

    let health = await readHealth(snapshot.port, 1_500);
    if (!health.online) {
      await this.startConfigured();
      health = await waitForHealth(snapshot.port, 120_000);
      if (!health.online) throw new Error(`PiLink is unreachable: ${health.error || "timeout"}`);
      snapshot = this.snapshot();
    }

    const state = await this.dashboardState();
    if (!isPublicHttpsOrigin(state.publicUrl)) {
      const action = await vscode.window.showInformationMessage(
        "ChatGPT needs a public HTTPS PiLink endpoint.",
        { modal: true },
        "Configure endpoint",
      );
      if (action === "Configure endpoint") await this.setupStable();
      return;
    }

    if (state.externalMcp.connected) {
      await this.openChatGpt("work");
      return;
    }

    await vscode.env.clipboard.writeText(state.mcpUrl);
    await this.pairOwner(state.publicUrl, snapshot, "plugins");
    await this.dashboard.refresh();
  }

  private async openChatGptInVsCode(): Promise<void> {
    this.requireTrustedWorkspace();
    const state = await this.dashboardState();
    if (!state.externalMcp.connected) {
      await this.connectChatGpt();
      return;
    }
    await this.openChatGpt("work");
  }

  private async pairOwner(publicUrl: string, snapshot: ConfigSnapshot, destination: ChatGptDestination): Promise<void> {
    await this.requirePersistentBrowserStorage();
    if (!snapshot.bootstrapSecret) throw new Error("PI_BOOTSTRAP_SECRET is missing from the private PiLink configuration.");
    const pairing = await createOwnerPairing(snapshot.port, snapshot.bootstrapSecret);
    const pairingUrl = validatePairingUrl(pairing.pairingUrl, publicUrl, pairing.expiresAt);
    const action = await vscode.window.showInformationMessage(
      "Verify this computer before connecting ChatGPT.",
      {
        modal: true,
        detail: `Local verification code: ${pairing.verificationCode}\n\nThe public pairing URL alone cannot authorize access. Paste this short-lived code only into the PiLink pairing page opened by VS Code.`,
      },
      "Copy code and continue",
    );
    if (action !== "Copy code and continue") return;
    await vscode.env.clipboard.writeText(pairing.verificationCode);
    const navigation = chatGptNavigation(destination);
    const pairedNavigation = new URL(pairingUrl);
    pairedNavigation.searchParams.set("continue", navigation.url);
    const opened = await this.openIntegratedBrowser(
      pairedNavigation.toString(),
      `${publicUrl.replace(/\/$/u, "")}/oauth/pair*`,
    );
    if (!opened) throw new Error("The browser did not open the PiLink pairing page.");
  }

  private async openChatGpt(destination: ChatGptDestination): Promise<void> {
    const navigation = chatGptNavigation(destination);
    const opened = await this.openIntegratedBrowser(navigation.url, navigation.reuseUrlFilter);
    if (!opened) throw new Error("The browser did not open the ChatGPT page.");
  }

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
        : "This version of VS Code does not provide the integrated browser used by PiLink.",
      {
        modal: true,
        detail: "The system browser will open only if you choose it explicitly. During Remote SSH it may be on a different computer.",
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
      "The integrated browser is using ephemeral storage, so PiLink owner verification cannot persist through the OAuth flow.",
      {
        modal: true,
        detail: "Set Workbench › Browser: Data Storage to Global or Workspace, then connect ChatGPT again.",
      },
      "Open setting",
    );
    if (action === "Open setting") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "workbench.browser.dataStorage");
    }
    throw new Error("Persistent browser storage is required for PiLink OAuth pairing.");
  }

  private async copyMcpUrl(): Promise<void> {
    const state = await this.dashboardState();
    await vscode.env.clipboard.writeText(state.mcpUrl);
    void vscode.window.showInformationMessage(`PiLink MCP URL copied: ${state.mcpUrl}`);
  }

  private async openConfig(): Promise<void> {
    this.requireTrustedWorkspace();
    const snapshot = this.snapshot();
    if (!snapshot.configured) {
      void vscode.window.showInformationMessage("PiLink is not configured for this project yet.");
      return;
    }
    const document = await vscode.workspace.openTextDocument(snapshot.configPath);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private showTerminal(): void {
    try {
      this.supervisor.showTerminal();
    } catch {
      this.supervisor.showOutput();
    }
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

  private async detectExternalRuntime(snapshot: ConfigSnapshot): Promise<boolean> {
    if (this.supervisor.isActive) return false;
    return (await readHealth(snapshot.port, 1_000)).online;
  }

  private snapshot(workspaceOverride?: string): ConfigSnapshot {
    const workspace = workspaceOverride || this.defaultWorkspacePath() || "";
    const config = vscode.workspace.getConfiguration("vspilink", this.configurationScope(workspaceOverride));
    const configuredPath = config.get<string>("configPath", "");
    return readConfigSnapshot(resolveConfigPath(configuredPath, workspace), workspace);
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

  private configurationScope(workspaceOverride?: string): vscode.Uri | undefined {
    if (workspaceOverride) {
      const folders = vscode.workspace.workspaceFolders || [];
      const resolved = path.resolve(workspaceOverride);
      const exact = folders.find((folder) => samePath(folder.uri.fsPath, resolved));
      if (exact) return exact.uri;
      const containing = folders.find((folder) => isPathInside(folder.uri.fsPath, resolved));
      if (containing) return containing.uri;
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

  private async requireWorkspace(): Promise<string> {
    const current = this.defaultWorkspacePath();
    if (current) return path.resolve(current);
    const selected = await this.selectWorkspace(undefined, true);
    if (!selected) throw new Error("Choose a project folder before starting PiLink.");
    this.selectedWorkspacePath = path.resolve(selected);
    await this.context.workspaceState.update(SELECTED_WORKSPACE_KEY, this.selectedWorkspacePath);
    return this.selectedWorkspacePath;
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
        { title: "Choose the PiLink project" },
      );
      return selected?.value;
    }
    const selected = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: "Choose the PiLink project",
    });
    return selected?.[0]?.fsPath;
  }

  private requireTrustedWorkspace(): void {
    if (vscode.workspace.isTrusted) return;
    void vscode.commands.executeCommand("workbench.trust.manage");
    throw new Error("PiLink blocks this operation in Restricted Mode. Trust the project to continue.");
  }
}

function startPlanFromSnapshot(snapshot: ConfigSnapshot): { command: "start" | "serve"; public: boolean; label: string } {
  switch (snapshot.hostingMode) {
    case "quick-tunnel":
      return { command: "start", public: true, label: "Quick Tunnel · project access" };
    case "cloudflare-fixed":
      return { command: "start", public: true, label: "Stable endpoint · project access" };
    case "external":
      return { command: "serve", public: true, label: "Existing HTTPS domain · project access" };
    case "nip-io":
      return { command: "start", public: true, label: "Legacy HTTPS · project access" };
    case "local":
      return { command: "serve", public: false, label: "Local only · project access" };
    default:
      return { command: "serve", public: false, label: "Local only · project access" };
  }
}

function validatePublicHttpsOrigin(value: string): string | undefined {
  const normalized = normalizeHostingSelection({ kind: "custom-domain", publicUrl: value });
  return normalized ? undefined : "Use an HTTPS origin without credentials, a port, path, query, or fragment.";
}

function validateCloudflareApiToken(value: string): string | undefined {
  const token = value.trim();
  return token.length >= 20 && token.length <= 512 && !/\s/u.test(token)
    ? undefined
    : "Enter the scoped Cloudflare API token.";
}

function validateTunnelId(value: string): string | undefined {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.trim())
    ? undefined
    : "Invalid Cloudflare tunnel UUID.";
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
    !/^[A-Za-z0-9_-]{20,512}$/u.test(pairing.searchParams.get("code") || "")
  ) throw new Error("The server returned a disallowed OAuth pairing destination.");
  const expiration = Date.parse(expiresAt);
  if (!Number.isFinite(expiration) || expiration <= Date.now()) throw new Error("The OAuth pairing request has expired.");
  return pairing.toString();
}

function isPublicHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !isLoopbackBrowserHost(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isLoopbackBrowserHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}

function runtimeModeFromConfig(value: unknown): RuntimeMode | undefined {
  return isRuntimeMode(value) ? value : undefined;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
