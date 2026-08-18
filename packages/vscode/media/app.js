(function () {
  "use strict";

  const vscode = typeof acquireVsCodeApi === "function"
    ? acquireVsCodeApi()
    : { postMessage: function () {}, getState: function () { return {}; }, setState: function () {} };

  const root = document.getElementById("app");
  const logoUri = root && root.dataset ? root.dataset.logoUri || "" : "";
  const storedUi = typeof vscode.getState === "function" ? vscode.getState() : {};
  let uiState = {
    advancedOpen: Boolean(storedUi && storedUi.advancedOpen),
    localAgentOpen: Boolean(storedUi && storedUi.localAgentOpen),
  };
  let currentState = normalizeState({});
  let lastSignature = "";

  window.addEventListener("message", function (event) {
    const message = event.data;
    if (!message || message.type !== "state") return;
    currentState = normalizeState(message.state);
    const signature = visibleSignature(currentState);
    if (signature === lastSignature) return;
    lastSignature = signature;
    render();
  });

  if (root) {
    root.addEventListener("click", function (event) {
      const target = event.target instanceof Element ? event.target.closest("[data-command]") : null;
      if (!target) return;
      const command = target.getAttribute("data-command");
      if (!command || target.hasAttribute("disabled")) return;
      postCommand(command, target.getAttribute("data-value") || undefined);
    });
    root.addEventListener("toggle", function (event) {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement)) return;
      if (details.dataset.stateKey === "advanced") uiState.advancedOpen = details.open;
      if (details.dataset.stateKey === "local-agent") uiState.localAgentOpen = details.open;
      vscode.setState(uiState);
    }, true);
  }

  function normalizeState(value) {
    const source = record(value);
    const process = record(source.process);
    const runtimeMode = record(source.runtimeMode);
    const externalMcp = record(source.externalMcp);
    const nativeMcp = record(source.nativeMcp);
    const collaboration = record(source.collaboration);
    const agentRuntime = record(source.agentRuntime);
    const wizard = record(source.wizard);

    return {
      trusted: source.trusted === true,
      trustKnown: typeof source.trusted === "boolean",
      configured: source.configured === true,
      workspace: text(source.workspace, 8192),
      configPath: text(source.configPath, 8192),
      process: {
        status: text(process.status, 40).toLowerCase() || "stopped",
        mode: text(process.mode, 120),
      },
      runtimeMode: {
        mode: runtimeMode.mode === "collaboration" ? "collaboration" : "single",
        configured: runtimeMode.configured === true,
      },
      hostingMode: text(source.hostingMode, 80).toLowerCase(),
      unsafeFullAccess: source.unsafeFullAccess === true,
      fullAccessClientCount: integer(source.fullAccessClientCount),
      mcpUrl: text(source.mcpUrl, 4096),
      publicUrl: text(source.publicUrl, 4096),
      version: text(source.version, 80),
      nodeVersion: text(source.nodeVersion, 80),
      error: text(source.error, 1200),
      externalMcp: {
        configured: externalMcp.configured === true,
        authorized: externalMcp.authorized === true,
        active: externalMcp.active === true,
        connected: externalMcp.connected === true,
        activeSessions: integer(externalMcp.activeSessions),
      },
      nativeMcp: {
        connected: nativeMcp.connected === true,
        scope: text(nativeMcp.scope, 160),
      },
      clients: normalizeClients(source.clients),
      activity: normalizeActivity(collaboration.activity),
      collaborationError: text(collaboration.error, 800),
      agentRuntime: {
        state: text(agentRuntime.state, 80).toLowerCase(),
        authReady: agentRuntime.authReady === true,
        authBusy: agentRuntime.authBusy === true,
        selectedProviderName: text(agentRuntime.selectedProviderName, 200),
        selectedModelName: text(agentRuntime.selectedModelName, 200),
        agents: normalizeAgents(agentRuntime.agents),
        error: text(agentRuntime.error, 800),
      },
      wizard: {
        phase: text(wizard.phase, 40).toLowerCase() || "idle",
        workspace: text(wizard.workspace, 8192),
        publicUrl: text(wizard.publicUrl, 4096),
        mcpUrl: text(wizard.mcpUrl, 4096),
        error: normalizeWizardError(wizard.error),
      },
    };
  }

  function normalizeClients(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 100).flatMap(function (entry) {
      const item = record(entry);
      const id = text(item.id, 200);
      if (!id) return [];
      return [{
        id: id,
        name: text(item.name, 200) || id,
        grantTypes: Array.isArray(item.grantTypes)
          ? item.grantTypes.slice(0, 8).map(function (entry) { return text(entry, 80); }).filter(Boolean)
          : [],
        scope: text(item.scope, 400),
        chatGpt: item.chatGpt === true,
        authorized: item.authorized === true,
      }];
    });
  }

  function normalizeActivity(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(-8).flatMap(function (entry) {
      const item = record(entry);
      const tool = text(item.tool, 120);
      if (!tool) return [];
      return [{
        tool: tool,
        outcome: item.outcome === "error" ? "error" : "success",
        durationMs: integer(item.durationMs),
        startedAt: text(item.startedAt, 100),
        accessMode: item.accessMode === "full-access" ? "full-access" : "workspace",
      }];
    });
  }

  function normalizeAgents(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).flatMap(function (entry) {
      const item = record(entry);
      const agentId = text(item.agentId, 256);
      if (!agentId) return [];
      return [{
        agentId: agentId,
        label: text(item.label, 160) || text(item.role, 100) || "Local agent",
        status: text(item.status, 80).toLowerCase() || "unknown",
        hasError: item.hasError === true,
      }];
    });
  }

  function normalizeWizardError(value) {
    const source = record(value);
    const message = text(source.message, 1000);
    if (!message) return null;
    return {
      message: message,
      retryable: source.retryable === true,
      phase: text(source.phase, 40),
    };
  }

  function visibleSignature(state) {
    return JSON.stringify({
      trusted: state.trusted,
      trustKnown: state.trustKnown,
      configured: state.configured,
      workspace: state.workspace,
      process: state.process,
      runtimeMode: state.runtimeMode,
      hostingMode: state.hostingMode,
      unsafeFullAccess: state.unsafeFullAccess,
      fullAccessClientCount: state.fullAccessClientCount,
      mcpUrl: state.mcpUrl,
      publicUrl: state.publicUrl,
      externalMcp: state.externalMcp,
      nativeMcp: state.nativeMcp,
      clients: state.clients,
      activity: state.activity,
      agentRuntime: state.agentRuntime,
      wizard: state.wizard,
      version: state.version,
      nodeVersion: state.nodeVersion,
      error: state.error,
    });
  }

  function render() {
    if (!root) return;
    const shell = el("main", "shell");
    shell.appendChild(renderHeader());

    if (!currentState.trustKnown) {
      shell.appendChild(renderLoading());
    } else if (!currentState.trusted) {
      shell.appendChild(renderTrustGate());
    } else {
      shell.appendChild(renderPrimaryCard());
      const error = currentState.wizard.error || (currentState.error ? { message: currentState.error, retryable: false } : null);
      if (error) shell.appendChild(renderError(error));
      if (currentState.unsafeFullAccess && isOnline()) shell.appendChild(renderFullAccessNotice());
      if (currentState.activity.length) shell.appendChild(renderActivity());
      if (currentState.runtimeMode.mode === "collaboration") shell.appendChild(renderCollaborationNotice());
      shell.appendChild(renderAdvanced());
    }

    shell.appendChild(renderFooter());
    root.replaceChildren(shell);
  }

  function renderHeader() {
    const header = el("header", "header");
    const brand = el("div", "brand");
    if (logoUri) {
      const image = document.createElement("img");
      image.className = "brand__logo";
      image.src = logoUri;
      image.alt = "";
      brand.appendChild(image);
    }
    const copy = el("div", "brand__copy");
    copy.appendChild(el("h1", "brand__title", "PiLink"));
    copy.appendChild(el("div", "brand__subtitle", workspaceLabel()));
    brand.appendChild(copy);
    header.appendChild(brand);
    header.appendChild(statusPill());
    return header;
  }

  function renderLoading() {
    const card = el("section", "primary-card");
    card.appendChild(el("div", "eyebrow", "PILINK"));
    card.appendChild(el("h2", "primary-card__title", "Reading workspace status…"));
    card.appendChild(el("p", "primary-card__description", "The extension is checking the local PiLink service."));
    return card;
  }

  function renderTrustGate() {
    const card = el("section", "primary-card primary-card--warning");
    card.appendChild(el("div", "eyebrow", "WORKSPACE TRUST"));
    card.appendChild(el("h2", "primary-card__title", "Trust this folder to use PiLink"));
    card.appendChild(el(
      "p",
      "primary-card__description",
      "VS Code Restricted Mode blocks PiLink setup, OAuth, service start, and project access.",
    ));
    const actions = el("div", "actions");
    actions.appendChild(commandButton("Manage Workspace Trust", "manageTrust", "primary"));
    card.appendChild(actions);
    return card;
  }

  function renderPrimaryCard() {
    const model = primaryModel();
    const card = el("section", "primary-card" + (model.tone ? " primary-card--" + model.tone : ""));
    const headingRow = el("div", "primary-card__heading");
    const headingCopy = el("div", "");
    headingCopy.appendChild(el("div", "eyebrow", model.eyebrow));
    headingCopy.appendChild(el("h2", "primary-card__title", model.title));
    headingRow.appendChild(headingCopy);
    if (model.badge) headingRow.appendChild(chip(model.badge.label, model.badge.tone));
    card.appendChild(headingRow);
    card.appendChild(el("p", "primary-card__description", model.description));

    if (model.actions.length) {
      const actions = el("div", "actions");
      model.actions.forEach(function (action) {
        if (action.wizard) {
          actions.appendChild(wizardButton(action.label, action.wizard, action.variant || "secondary"));
        } else {
          actions.appendChild(commandButton(action.label, action.command, action.variant || "secondary", action.value, action.disabled));
        }
      });
      card.appendChild(actions);
    }

    if (model.note) card.appendChild(el("p", "primary-card__note", model.note));
    card.appendChild(renderStatusGrid());
    return card;
  }

  function primaryModel() {
    const busySetup = currentState.wizard.phase === "provisioning" || currentState.wizard.phase === "starting";
    const processTransition = currentState.process.status === "starting" || currentState.process.status === "stopping";
    if (busySetup || processTransition) {
      return {
        eyebrow: "SETTING UP",
        title: currentState.process.status === "stopping"
          ? "Stopping PiLink…"
          : currentState.wizard.phase === "provisioning"
            ? "Preparing PiLink…"
            : "Starting PiLink…",
        description: currentState.process.status === "stopping"
          ? "The extension is shutting down the managed PiLink service."
          : "VSPiLink is configuring the selected workspace and checking the service.",
        tone: "progress",
        badge: { label: "Working", tone: "progress" },
        actions: [],
      };
    }

    if (!currentState.configured) {
      const hasWorkspace = Boolean(currentState.wizard.workspace || currentState.workspace);
      if (!hasWorkspace) {
        return {
          eyebrow: "FIRST RUN",
          title: "Choose the project PiLink may access",
          description: "PiLink never chooses a folder implicitly. Pick the project you want the MCP server to expose.",
          badge: { label: "Not configured", tone: "neutral" },
          actions: [{
            label: "Choose project folder",
            wizard: { action: "chooseWorkspace" },
            variant: "primary",
          }],
        };
      }
      return {
        eyebrow: "FIRST RUN",
        title: "Start PiLink",
        description: "The default is intentionally simple: single-agent workflow, project-folder access, no unrestricted shell.",
        badge: { label: "Single agent", tone: "success" },
        actions: [
          {
            label: "Quick start for ChatGPT",
            wizard: {
              action: "configureAndStart",
              hosting: { kind: "quick-tunnel" },
              accessMode: "workspace",
            },
            variant: "primary",
          },
          {
            label: "Local only",
            wizard: {
              action: "configureAndStart",
              hosting: { kind: "local" },
              accessMode: "workspace",
            },
          },
          { label: "Stable endpoint…", command: "guidedSetup" },
        ],
        note: "Quick start creates a temporary HTTPS address. Use Stable endpoint for a hostname you want to keep across restarts.",
      };
    }

    const online = isOnline();
    if (!online && currentState.unsafeFullAccess) {
      return {
        eyebrow: "ACCESS WARNING",
        title: "Full machine access is configured",
        description: "Starting the saved configuration will restore unrestricted filesystem and process access for its approved OAuth client. Return to Project-folder access unless you still need that authority.",
        tone: "warning",
        badge: { label: "Full machine", tone: "danger" },
        actions: [
          { label: "Return to Project-folder access", command: "guidedSetup", variant: "primary" },
          { label: "Start configured Full access", command: "start", variant: "danger" },
        ],
        note: "The Full-access start is deliberately not presented as the normal Start PiLink action.",
      };
    }

    if (!online) {
      return {
        eyebrow: "MCP SERVER",
        title: "PiLink is stopped",
        description: "The workspace is configured. Start the server to make its MCP tools available again.",
        badge: { label: "Stopped", tone: "neutral" },
        actions: [
          { label: "Start PiLink", command: "start", variant: "primary" },
          { label: "Reconfigure…", command: "guidedSetup" },
        ],
      };
    }

    if (!isPublicEndpoint()) {
      return {
        eyebrow: "MCP SERVER",
        title: "PiLink is running locally",
        description: "The MCP server is healthy, but this endpoint is local to this machine. That is enough for local clients, not ChatGPT Work.",
        badge: { label: "Local", tone: "success" },
        actions: [
          { label: "Make it reachable from ChatGPT", command: "guidedSetup", variant: "primary" },
          { label: "Stop", command: "stop" },
        ],
      };
    }

    if (!currentState.externalMcp.configured) {
      return {
        eyebrow: "REMOTE MCP",
        title: "PiLink is online",
        description: "The HTTPS MCP endpoint is ready. Connect your ChatGPT Work plugin when you want to use this project remotely.",
        badge: { label: "Ready", tone: "success" },
        actions: [
          { label: "Connect ChatGPT", command: "connectChatGpt", variant: "primary" },
          { label: "Copy MCP URL", command: "copyMcpUrl" },
          { label: "Stop", command: "stop" },
        ],
      };
    }

    if (!currentState.externalMcp.connected) {
      return {
        eyebrow: "REMOTE MCP",
        title: "Finish the ChatGPT connection",
        description: "The OAuth client already exists. Continue the authorization flow instead of creating another client.",
        badge: { label: "Authorization pending", tone: "warning" },
        actions: [
          { label: "Continue connection", command: "connectChatGpt", variant: "primary" },
          { label: "Copy MCP URL", command: "copyMcpUrl" },
          { label: "Stop", command: "stop" },
        ],
      };
    }

    if (currentState.externalMcp.active) {
      const sessions = currentState.externalMcp.activeSessions;
      return {
        eyebrow: "REMOTE MCP",
        title: "ChatGPT is using PiLink",
        description: "The authenticated MCP connection is active. Keep working in ChatGPT Work; this panel only manages the bridge.",
        badge: { label: sessions ? sessions + " active" : "Active", tone: "success" },
        actions: [
          { label: "Open ChatGPT Work", command: "openChatGpt", variant: "primary" },
          { label: "Stop PiLink", command: "stop" },
        ],
      };
    }

    return {
      eyebrow: "REMOTE MCP",
      title: "PiLink is ready",
      description: "OAuth is authorized and persistent. ChatGPT will open an MCP connection when it needs PiLink tools.",
      badge: { label: "OAuth ready", tone: "success" },
      actions: [
        { label: "Open ChatGPT Work", command: "openChatGpt", variant: "primary" },
        { label: "Copy MCP URL", command: "copyMcpUrl" },
        { label: "Stop", command: "stop" },
      ],
    };
  }

  function renderStatusGrid() {
    const grid = el("div", "status-grid");
    grid.appendChild(statusItem("Server", serverStatus(), isOnline() ? "success" : "neutral"));
    grid.appendChild(statusItem("Remote", remoteStatus(), remoteTone()));
    grid.appendChild(statusItem("Access", currentState.unsafeFullAccess ? "Full machine" : "Project folder", currentState.unsafeFullAccess ? "danger" : "success"));
    return grid;
  }

  function renderError(error) {
    const card = el("section", "notice notice--error");
    const body = el("div", "notice__body");
    body.appendChild(el("strong", "notice__title", "PiLink needs attention"));
    body.appendChild(el("p", "notice__copy", error.message));
    card.appendChild(body);
    if (error.retryable) {
      card.appendChild(wizardButton("Retry", { action: "retry" }, "secondary"));
    }
    return card;
  }

  function renderFullAccessNotice() {
    const notice = el("section", "notice notice--error");
    const body = el("div", "notice__body");
    body.appendChild(el("strong", "notice__title", "Full machine access is active"));
    body.appendChild(el(
      "p",
      "notice__copy",
      "An approved OAuth client can use PiLink outside the project boundary and run processes as the PiLink OS user.",
    ));
    notice.appendChild(body);
    notice.appendChild(commandButton("Return to Project-folder access", "guidedSetup", "secondary"));
    return notice;
  }

  function renderActivity() {
    const section = el("section", "section-card");
    const header = el("div", "section-card__header");
    const copy = el("div", "");
    copy.appendChild(el("div", "eyebrow", "RECENT ACTIVITY"));
    copy.appendChild(el("h3", "section-card__title", "MCP calls"));
    header.appendChild(copy);
    header.appendChild(chip("Metadata only", "neutral"));
    section.appendChild(header);

    const list = el("div", "activity-list");
    currentState.activity.slice(-5).reverse().forEach(function (item) {
      const row = el("div", "activity-row");
      const main = el("div", "activity-row__main");
      main.appendChild(el("span", "activity-row__tool", item.tool));
      main.appendChild(el("span", "activity-row__meta", activityMeta(item)));
      row.appendChild(main);
      row.appendChild(chip(item.outcome === "error" ? "Error" : "OK", item.outcome === "error" ? "danger" : "success"));
      list.appendChild(row);
    });
    section.appendChild(list);
    section.appendChild(el(
      "p",
      "section-card__hint",
      "Arguments, file paths, prompts, and results are intentionally not shown here.",
    ));
    return section;
  }

  function renderCollaborationNotice() {
    const notice = el("section", "notice notice--info");
    const body = el("div", "notice__body");
    body.appendChild(el("strong", "notice__title", "Collaboration workflow is enabled"));
    body.appendChild(el(
      "p",
      "notice__copy",
      "Shared chat, tasks, coordination, and remote agent-management tools are available. This is an advanced mode; single-agent is the normal default.",
    ));
    notice.appendChild(body);
    notice.appendChild(commandButton("Open agent & task monitor", "openCollaborationMonitor", "secondary"));
    return notice;
  }

  function renderAdvanced() {
    const details = el("details", "advanced");
    details.dataset.stateKey = "advanced";
    details.open = uiState.advancedOpen;
    const summary = document.createElement("summary");
    summary.className = "advanced__summary";
    summary.appendChild(el("span", "advanced__summary-title", "Advanced"));
    summary.appendChild(el("span", "advanced__summary-copy", "Hosting, workflow, access, integrations"));
    details.appendChild(summary);

    const body = el("div", "advanced__body");
    body.appendChild(advancedServerSection());
    body.appendChild(advancedWorkflowSection());
    body.appendChild(advancedAccessSection());
    body.appendChild(advancedIntegrationSection());
    body.appendChild(advancedLocalAgentSection());
    details.appendChild(body);
    return details;
  }

  function advancedServerSection() {
    const section = advancedSection(
      "Server & hosting",
      hostingLabel(currentState.hostingMode) + (currentState.mcpUrl ? " · " + compactUrl(currentState.mcpUrl) : ""),
    );
    const actions = el("div", "button-row");
    if (isOnline()) actions.appendChild(commandButton("Restart", "restart", "secondary"));
    if (!isOnline() && !currentState.unsafeFullAccess) actions.appendChild(commandButton("Start", "start", "secondary"));
    if (isOnline()) actions.appendChild(commandButton("Stop", "stop", "secondary"));
    actions.appendChild(commandButton("Change hosting…", "guidedSetup", "secondary"));
    if (currentState.mcpUrl) actions.appendChild(commandButton("Copy MCP URL", "copyMcpUrl", "ghost"));
    actions.appendChild(commandButton("Open config", "openConfig", "ghost"));
    actions.appendChild(commandButton("Show terminal", "openTerminal", "ghost"));
    section.appendChild(actions);
    return section;
  }

  function advancedWorkflowSection() {
    const collaboration = currentState.runtimeMode.mode === "collaboration";
    const section = advancedSection(
      "Workflow",
      collaboration
        ? "Public chat & orchestration is enabled."
        : "Single-agent is the default and keeps collaboration services out of the MCP catalog.",
    );
    section.appendChild(commandButton(
      collaboration ? "Switch back to single-agent" : "Enable collaboration…",
      "selectRuntimeMode",
      collaboration ? "secondary" : "ghost",
      collaboration ? "single" : "collaboration",
    ));
    return section;
  }

  function advancedAccessSection() {
    const eligible = currentState.clients.some(function (client) {
      return client.chatGpt && client.grantTypes.includes("authorization_code") && /\bmcp:tools\b/.test(client.scope);
    });
    const section = advancedSection(
      "Access boundary",
      currentState.unsafeFullAccess
        ? "Full machine access is enabled for " + currentState.fullAccessClientCount + " OAuth client(s)."
        : "Project-folder access is active. General shell access is disabled.",
    );
    if (!currentState.unsafeFullAccess) {
      section.appendChild(commandButton(
        "Start with Full access…",
        "startUnsafe",
        "danger",
        undefined,
        !eligible,
      ));
      if (!eligible) {
        section.appendChild(el(
          "p",
          "advanced-section__hint",
          "Full access becomes available only after a ChatGPT OAuth client with mcp:tools exists.",
        ));
      }
    } else {
      section.appendChild(commandButton("Return to Project-folder access", "guidedSetup", "secondary"));
    }
    return section;
  }

  function advancedIntegrationSection() {
    const section = advancedSection(
      "Integrations",
      currentState.nativeMcp.connected
        ? "VS Code agents are connected with " + (currentState.nativeMcp.scope || "the configured scope") + "."
        : "ChatGPT Work is the primary remote client. VS Code's native MCP provider is optional.",
    );
    const actions = el("div", "button-row");
    actions.appendChild(commandButton(
      currentState.nativeMcp.connected ? "Disconnect VS Code agents" : "Connect VS Code agents…",
      currentState.nativeMcp.connected ? "disconnectNativeMcp" : "connectNativeMcp",
      "secondary",
    ));
    actions.appendChild(commandButton("Register OAuth client…", "registerClient", "ghost"));
    actions.appendChild(commandButton("Open guide", "openDocs", "ghost"));
    section.appendChild(actions);
    return section;
  }

  function advancedLocalAgentSection() {
    const details = el("details", "nested-details");
    details.dataset.stateKey = "local-agent";
    details.open = uiState.localAgentOpen;
    const summary = document.createElement("summary");
    summary.className = "nested-details__summary";
    summary.appendChild(el("span", "", "Optional local Pi agent"));
    summary.appendChild(el("span", "nested-details__meta", localAgentSummary()));
    details.appendChild(summary);

    const body = el("div", "nested-details__body");
    body.appendChild(el(
      "p",
      "advanced-section__copy",
      "This is separate from ChatGPT MCP. Keep it only if you want PiLink to call a model provider configured on this machine.",
    ));
    const actions = el("div", "button-row");
    actions.appendChild(commandButton("Provider & model…", "configureAgents", "secondary"));
    if (currentState.agentRuntime.authReady) {
      actions.appendChild(commandButton("Create local agent…", "spawnAgent", "secondary"));
      actions.appendChild(commandButton("Sign out provider", "logoutAgent", "ghost"));
    }
    body.appendChild(actions);

    currentState.agentRuntime.agents.slice(0, 5).forEach(function (agent) {
      const row = el("div", "agent-row");
      const copy = el("div", "agent-row__copy");
      copy.appendChild(el("strong", "", agent.label));
      copy.appendChild(el("span", "agent-row__meta", agent.status));
      row.appendChild(copy);
      const rowActions = el("div", "agent-row__actions");
      rowActions.appendChild(commandButton("Output", "viewAgentOutput", "ghost", agent.agentId));
      if (activeAgentStatus(agent.status)) rowActions.appendChild(commandButton("Stop", "stopAgent", "ghost", agent.agentId));
      row.appendChild(rowActions);
      body.appendChild(row);
    });
    details.appendChild(body);
    return details;
  }

  function renderFooter() {
    const footer = el("footer", "footer");
    footer.appendChild(el("span", "", currentState.version ? "VSPiLink " + currentState.version : "VSPiLink"));
    if (currentState.nodeVersion) footer.appendChild(el("span", "", "Node " + currentState.nodeVersion));
    return footer;
  }

  function statusPill() {
    const model = topStatus();
    const pill = el("div", "status-pill status-pill--" + model.tone);
    pill.appendChild(el("span", "status-pill__dot", ""));
    pill.appendChild(el("span", "", model.label));
    return pill;
  }

  function topStatus() {
    if (!currentState.trustKnown) return { label: "Loading", tone: "neutral" };
    if (!currentState.trusted) return { label: "Restricted", tone: "warning" };
    if (!currentState.configured) return { label: "Setup", tone: "neutral" };
    if (!isOnline()) return currentState.unsafeFullAccess
      ? { label: "Full access", tone: "warning" }
      : { label: "Stopped", tone: "neutral" };
    if (currentState.unsafeFullAccess) return { label: "Full access", tone: "warning" };
    if (currentState.externalMcp.active) return { label: "Connected", tone: "success" };
    if (currentState.externalMcp.connected) return { label: "Ready", tone: "success" };
    if (isPublicEndpoint()) return { label: "Online", tone: "success" };
    return { label: "Local", tone: "success" };
  }

  function serverStatus() {
    if (!currentState.configured) return "Not configured";
    if (!isOnline()) return "Stopped";
    return "Running";
  }

  function remoteStatus() {
    if (!isOnline()) return "Offline";
    if (!isPublicEndpoint()) return "Local only";
    if (currentState.externalMcp.active) {
      return currentState.externalMcp.activeSessions
        ? currentState.externalMcp.activeSessions + " active"
        : "Connected";
    }
    if (currentState.externalMcp.connected) return "OAuth ready";
    if (currentState.externalMcp.configured) return "Authorize";
    return "Not connected";
  }

  function remoteTone() {
    if (!isOnline()) return "neutral";
    if (currentState.externalMcp.connected || currentState.externalMcp.active) return "success";
    if (currentState.externalMcp.configured) return "warning";
    return "neutral";
  }

  function statusItem(label, value, tone) {
    const item = el("div", "status-item");
    item.appendChild(el("span", "status-item__label", label));
    const valueRow = el("div", "status-item__value");
    valueRow.appendChild(el("span", "mini-dot mini-dot--" + tone, ""));
    valueRow.appendChild(el("span", "", value));
    item.appendChild(valueRow);
    return item;
  }

  function advancedSection(title, copy) {
    const section = el("section", "advanced-section");
    section.appendChild(el("h4", "advanced-section__title", title));
    section.appendChild(el("p", "advanced-section__copy", copy));
    return section;
  }

  function commandButton(label, command, variant, value, disabled) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button--" + (variant || "secondary");
    button.textContent = label;
    button.dataset.command = command;
    if (value !== undefined) button.dataset.value = String(value);
    if (disabled) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
    }
    return button;
  }

  function wizardButton(label, descriptor, variant) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button--" + (variant || "secondary");
    button.textContent = label;
    button.addEventListener("click", function () {
      postWizard(descriptor.action, descriptor);
    });
    return button;
  }

  function chip(label, tone) {
    return el("span", "chip chip--" + (tone || "neutral"), label);
  }

  function postCommand(command, value) {
    vscode.postMessage({
      type: "command",
      command: command,
      ...(value !== undefined ? { value: value } : {}),
    });
  }

  function postWizard(action, descriptor) {
    const message = {
      type: "wizard",
      action: action,
      requestId: "ui-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    };
    if (descriptor && descriptor.hosting) message.hosting = descriptor.hosting;
    if (descriptor && descriptor.accessMode) message.accessMode = descriptor.accessMode;
    if (descriptor && descriptor.destination) message.destination = descriptor.destination;
    vscode.postMessage(message);
  }

  function isOnline() {
    return currentState.process.status === "running" || currentState.process.status === "starting";
  }

  function isPublicEndpoint() {
    if (!currentState.publicUrl) return false;
    try {
      const url = new URL(currentState.publicUrl);
      return url.protocol === "https:" && !isLoopbackHost(url.hostname);
    } catch {
      return false;
    }
  }

  function isLoopbackHost(hostname) {
    const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
  }

  function workspaceLabel() {
    const workspace = currentState.workspace || currentState.wizard.workspace;
    if (!workspace) return "VS Code control panel";
    const parts = workspace.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || workspace;
  }

  function hostingLabel(kind) {
    const labels = {
      "quick-tunnel": "Quick Tunnel",
      "cloudflare-fixed": "Cloudflare fixed domain",
      "cloudflare-named": "Cloudflare Named Tunnel",
      "custom-domain": "Existing HTTPS domain",
      "nip-io": "Legacy nip.io",
      "local": "Local only",
      "serve": "Local only",
      "none": "Local only",
    };
    return labels[kind] || (kind ? kind : "Not configured");
  }

  function compactUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value);
      return url.host + (url.pathname && url.pathname !== "/" ? url.pathname : "");
    } catch {
      return value.length > 60 ? value.slice(0, 57) + "…" : value;
    }
  }

  function localAgentSummary() {
    if (currentState.agentRuntime.authBusy) return "signing in";
    if (!currentState.agentRuntime.authReady) return "not configured";
    const provider = currentState.agentRuntime.selectedProviderName;
    const model = currentState.agentRuntime.selectedModelName;
    if (provider && model) return provider + " · " + model;
    if (provider) return provider;
    return "configured";
  }

  function activeAgentStatus(status) {
    return ["starting", "running", "waiting", "cancelling", "stopping", "stop_failed"].includes(status);
  }

  function activityMeta(item) {
    const parts = [];
    if (item.durationMs) parts.push(item.durationMs + " ms");
    if (item.accessMode === "full-access") parts.push("full access");
    if (item.startedAt) {
      const formatted = shortTime(item.startedAt);
      if (formatted) parts.push(formatted);
    }
    return parts.join(" · ") || "MCP tool call";
  }

  function shortTime(value) {
    try {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function text(value, max) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
    return String(value).replace(/\0/g, "").slice(0, max || 8192);
  }

  function integer(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null && content !== "") node.textContent = String(content);
    return node;
  }
})();
