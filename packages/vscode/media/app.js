(function () {
  "use strict";

  const vscode = typeof acquireVsCodeApi === "function"
    ? acquireVsCodeApi()
    : { postMessage: function () {}, getState: function () { return {}; }, setState: function () {} };

  const root = document.getElementById("app");
  const logoUri = root && root.dataset ? root.dataset.logoUri || "" : "";
  const storedUi = typeof vscode.getState === "function" ? vscode.getState() : {};
  let uiState = { advancedOpen: Boolean(storedUi && storedUi.advancedOpen) };
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
      if (!target || target.hasAttribute("disabled")) return;
      const command = target.getAttribute("data-command");
      if (!command) return;
      postCommand(command, target.getAttribute("data-value") || undefined);
    });
    root.addEventListener("toggle", function (event) {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement) || details.dataset.stateKey !== "advanced") return;
      uiState.advancedOpen = details.open;
      vscode.setState(uiState);
    }, true);
  }

  function normalizeState(value) {
    const source = record(value);
    const process = record(source.process);
    const runtimeMode = record(source.runtimeMode);
    const externalMcp = record(source.externalMcp);
    const collaboration = record(source.collaboration);
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
      runtimeMode: runtimeMode.mode === "collaboration" ? "collaboration" : "single",
      hostingMode: text(source.hostingMode, 80).toLowerCase(),
      unsafeFullAccess: source.unsafeFullAccess === true,
      mcpUrl: text(source.mcpUrl, 4096),
      publicUrl: text(source.publicUrl, 4096),
      version: text(source.version, 80),
      nodeVersion: text(source.nodeVersion, 80),
      error: text(source.error, 1200),
      externalMcp: {
        configured: externalMcp.configured === true,
        connected: externalMcp.connected === true,
        active: externalMcp.active === true,
        activeSessions: integer(externalMcp.activeSessions),
      },
      activity: normalizeActivity(collaboration.activity),
      wizard: {
        phase: text(wizard.phase, 40).toLowerCase() || "idle",
        workspace: text(wizard.workspace, 8192),
        error: normalizeWizardError(wizard.error),
      },
    };
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
      }];
    });
  }

  function normalizeWizardError(value) {
    const source = record(value);
    const message = text(source.message, 1000);
    if (!message) return null;
    return { message: message, retryable: source.retryable === true };
  }

  function visibleSignature(state) {
    return JSON.stringify(state);
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
      if (currentState.unsafeFullAccess) shell.appendChild(renderFullAccessNotice());
      if (currentState.runtimeMode === "collaboration") shell.appendChild(renderCollaborationNotice());
      if (currentState.activity.length) shell.appendChild(renderActivity());
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
    card.appendChild(el("h2", "primary-card__title", "Checking PiLink…"));
    card.appendChild(el("p", "primary-card__description", "Reading the project and local bridge status."));
    return card;
  }

  function renderTrustGate() {
    const card = el("section", "primary-card primary-card--warning");
    card.appendChild(el("div", "eyebrow", "WORKSPACE TRUST"));
    card.appendChild(el("h2", "primary-card__title", "Trust this folder to use PiLink"));
    card.appendChild(el("p", "primary-card__description", "VS Code Restricted Mode blocks PiLink setup, startup, OAuth, and project access."));
    const actions = el("div", "actions");
    actions.appendChild(commandButton("Manage Workspace Trust", "manageTrust", "primary"));
    card.appendChild(actions);
    return card;
  }

  function renderPrimaryCard() {
    const model = primaryModel();
    const card = el("section", "primary-card" + (model.tone ? " primary-card--" + model.tone : ""));
    const heading = el("div", "primary-card__heading");
    const copy = el("div", "");
    copy.appendChild(el("div", "eyebrow", model.eyebrow));
    copy.appendChild(el("h2", "primary-card__title", model.title));
    heading.appendChild(copy);
    if (model.badge) heading.appendChild(chip(model.badge.label, model.badge.tone));
    card.appendChild(heading);
    card.appendChild(el("p", "primary-card__description", model.description));

    if (model.actions.length) {
      const actions = el("div", "actions");
      model.actions.forEach(function (action) {
        actions.appendChild(action.wizard
          ? wizardButton(action.label, action.wizard, action.variant)
          : commandButton(action.label, action.command, action.variant, action.value));
      });
      card.appendChild(actions);
    }
    if (model.note) card.appendChild(el("p", "primary-card__note", model.note));
    card.appendChild(renderStatusGrid());
    return card;
  }

  function primaryModel() {
    const setupBusy = currentState.wizard.phase === "provisioning" || currentState.wizard.phase === "starting";
    const transition = currentState.process.status === "starting" || currentState.process.status === "stopping";
    if (setupBusy || transition) {
      return {
        eyebrow: "PILINK",
        title: currentState.process.status === "stopping" ? "Stopping PiLink…" : "Starting PiLink…",
        description: "VSPiLink is applying the project configuration and checking the bridge.",
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
          description: "Pick the folder you want to expose through MCP. PiLink will keep its private credentials and state outside that project.",
          badge: { label: "Not configured", tone: "neutral" },
          actions: [{ label: "Choose project folder", wizard: { action: "chooseWorkspace" }, variant: "primary" }],
        };
      }
      return {
        eyebrow: "FIRST RUN",
        title: "Start PiLink for this project",
        description: "Project-folder access and the single-agent MCP toolset are the default. Choose how remote clients should reach the bridge.",
        badge: { label: "Safe default", tone: "success" },
        actions: [
          { label: "Set up stable endpoint", command: "guidedSetup", variant: "primary" },
          { label: "Temporary quick start", wizard: { action: "configureAndStart", hosting: { kind: "quick-tunnel" }, accessMode: "workspace" }, variant: "secondary" },
          { label: "Local only", wizard: { action: "configureAndStart", hosting: { kind: "local" }, accessMode: "workspace" }, variant: "ghost" },
        ],
        note: "A stable endpoint is recommended for normal ChatGPT use. A Quick Tunnel gets a different public URL when it is recreated.",
      };
    }

    const online = isOnline();
    if (currentState.unsafeFullAccess) {
      return {
        eyebrow: "SAFETY CHECK",
        title: online ? "Full machine access is running" : "Full machine access is saved",
        description: online
          ? "This configuration is outside VSPiLink's normal safe workflow. Stop it or reconfigure PiLink for project-folder access."
          : "VSPiLink will not present an ordinary Start button for a saved Full-access configuration. Reconfigure it for project-folder access before normal use.",
        tone: "warning",
        badge: { label: "Full access", tone: "danger" },
        actions: online
          ? [
              { label: "Stop PiLink", command: "stop", variant: "primary" },
              { label: "Reconfigure safely…", command: "guidedSetup", variant: "secondary" },
            ]
          : [
              { label: "Reconfigure safely…", command: "guidedSetup", variant: "primary" },
              { label: "Open config", command: "openConfig", variant: "ghost" },
            ],
        note: "Deliberate Full-access operation remains available from the PiLink CLI for operators who explicitly need it.",
      };
    }

    if (!online) {
      return {
        eyebrow: "MCP BRIDGE",
        title: "PiLink is stopped",
        description: "This project is already configured. Start the bridge to make its MCP endpoint available again.",
        badge: { label: "Stopped", tone: "neutral" },
        actions: [
          { label: "Start PiLink", command: "start", variant: "primary" },
          { label: "Reconfigure…", command: "guidedSetup", variant: "secondary" },
        ],
      };
    }

    if (!isPublicEndpoint()) {
      return {
        eyebrow: "MCP BRIDGE",
        title: "PiLink is running locally",
        description: "The bridge is healthy on this machine. Configure a public HTTPS endpoint only if a remote client such as ChatGPT Work needs to reach it.",
        badge: { label: "Local", tone: "success" },
        actions: [
          { label: "Configure remote endpoint", command: "guidedSetup", variant: "primary" },
          { label: "Stop", command: "stop", variant: "secondary" },
        ],
      };
    }

    if (!currentState.externalMcp.configured) {
      return {
        eyebrow: "REMOTE MCP",
        title: "PiLink is online",
        description: "The HTTPS MCP endpoint is reachable. Connect ChatGPT Work when you want it to use this project.",
        badge: { label: "Endpoint ready", tone: "success" },
        actions: [
          { label: "Connect ChatGPT", command: "connectChatGpt", variant: "primary" },
          { label: "Copy MCP URL", command: "copyMcpUrl", variant: "secondary" },
          { label: "Stop", command: "stop", variant: "ghost" },
        ],
      };
    }

    if (!currentState.externalMcp.connected) {
      return {
        eyebrow: "REMOTE MCP",
        title: "Finish connecting ChatGPT",
        description: "The OAuth client already exists. Continue that authorization instead of registering another client.",
        badge: { label: "Authorization pending", tone: "warning" },
        actions: [
          { label: "Continue connection", command: "connectChatGpt", variant: "primary" },
          { label: "Stop", command: "stop", variant: "secondary" },
        ],
      };
    }

    if (currentState.externalMcp.active) {
      const sessions = currentState.externalMcp.activeSessions;
      return {
        eyebrow: "REMOTE MCP",
        title: "ChatGPT is connected",
        description: "An authenticated MCP session is active. Keep working in ChatGPT Work; VSPiLink only manages and monitors the bridge.",
        badge: { label: sessions ? sessions + " active" : "Connected", tone: "success" },
        actions: [
          { label: "Open ChatGPT Work", command: "openChatGpt", variant: "primary" },
          { label: "Stop PiLink", command: "stop", variant: "secondary" },
        ],
      };
    }

    return {
      eyebrow: "REMOTE MCP",
      title: "PiLink is ready",
      description: "OAuth is authorized and saved. ChatGPT will open an MCP session when it needs PiLink tools.",
      badge: { label: "OAuth ready", tone: "success" },
      actions: [
        { label: "Open ChatGPT Work", command: "openChatGpt", variant: "primary" },
        { label: "Copy MCP URL", command: "copyMcpUrl", variant: "secondary" },
        { label: "Stop", command: "stop", variant: "ghost" },
      ],
    };
  }

  function renderStatusGrid() {
    const grid = el("div", "status-grid");
    grid.appendChild(statusItem("Server", serverStatus(), isOnline() ? "success" : "neutral"));
    grid.appendChild(statusItem("Endpoint", endpointStatus(), endpointTone()));
    grid.appendChild(statusItem("ChatGPT", chatGptStatus(), chatGptTone()));
    return grid;
  }

  function renderError(error) {
    const notice = el("section", "notice notice--error");
    const body = el("div", "notice__body");
    body.appendChild(el("strong", "notice__title", "PiLink needs attention"));
    body.appendChild(el("p", "notice__copy", error.message));
    notice.appendChild(body);
    if (error.retryable) notice.appendChild(wizardButton("Retry", { action: "retry" }, "secondary"));
    return notice;
  }

  function renderFullAccessNotice() {
    const notice = el("section", "notice notice--error");
    const body = el("div", "notice__body");
    body.appendChild(el("strong", "notice__title", "Full access is outside the normal VSPiLink workflow"));
    body.appendChild(el("p", "notice__copy", "Full access removes the project boundary and permits general process execution as the PiLink OS user. VSPiLink does not offer it as a normal graphical launch option."));
    notice.appendChild(body);
    return notice;
  }

  function renderCollaborationNotice() {
    const notice = el("section", "notice notice--info");
    const body = el("div", "notice__body");
    body.appendChild(el("strong", "notice__title", "Advanced collaboration configuration detected"));
    body.appendChild(el("p", "notice__copy", "This project is using PiLink's collaboration tool catalog. VSPiLink now defaults to the simpler single-agent bridge and no longer promotes collaboration from the main UI."));
    notice.appendChild(body);
    notice.appendChild(commandButton("Switch to single-agent", "selectRuntimeMode", "secondary", "single"));
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
    section.appendChild(el("p", "section-card__hint", "Arguments, file paths, prompts, and results are intentionally not shown here."));
    return section;
  }

  function renderAdvanced() {
    const details = el("details", "advanced");
    details.dataset.stateKey = "advanced";
    details.open = uiState.advancedOpen;
    const summary = document.createElement("summary");
    summary.className = "advanced__summary";
    summary.appendChild(el("span", "advanced__summary-title", "Details & recovery"));
    summary.appendChild(el("span", "advanced__summary-copy", "Endpoint, config, terminal"));
    details.appendChild(summary);

    const body = el("div", "advanced__body");
    const info = el("dl", "detail-grid");
    detailRow(info, "Project", workspaceLabel());
    detailRow(info, "Hosting", hostingLabel(currentState.hostingMode));
    detailRow(info, "Workflow", currentState.runtimeMode === "collaboration" ? "Collaboration (advanced)" : "Single agent");
    detailRow(info, "MCP endpoint", currentState.mcpUrl ? compactUrl(currentState.mcpUrl) : "Not available");
    body.appendChild(info);

    const actions = el("div", "button-row");
    if (isOnline()) actions.appendChild(commandButton("Restart", "restart", "secondary"));
    if (isOnline()) actions.appendChild(commandButton("Stop", "stop", "secondary"));
    actions.appendChild(commandButton("Reconfigure hosting…", "guidedSetup", "secondary"));
    if (currentState.mcpUrl) actions.appendChild(commandButton("Copy MCP URL", "copyMcpUrl", "ghost"));
    actions.appendChild(commandButton("Open config", "openConfig", "ghost"));
    actions.appendChild(commandButton("Show terminal", "openTerminal", "ghost"));
    actions.appendChild(commandButton("Open guide", "openDocs", "ghost"));
    body.appendChild(actions);

    body.appendChild(el("p", "advanced-section__hint", "Local model-provider chat, native VS Code MCP, manual OAuth registration, collaboration enablement, and Full-access launch remain operator/compatibility features rather than part of the normal graphical workflow."));
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
    if (currentState.unsafeFullAccess) return { label: "Full access", tone: "warning" };
    if (!isOnline()) return { label: "Stopped", tone: "neutral" };
    if (currentState.externalMcp.active) return { label: "Connected", tone: "success" };
    if (currentState.externalMcp.connected) return { label: "Ready", tone: "success" };
    if (isPublicEndpoint()) return { label: "Online", tone: "success" };
    return { label: "Local", tone: "success" };
  }

  function serverStatus() {
    if (!currentState.configured) return "Not configured";
    return isOnline() ? "Running" : "Stopped";
  }

  function endpointStatus() {
    if (!isOnline()) return "Offline";
    return isPublicEndpoint() ? "Public HTTPS" : "Local only";
  }

  function endpointTone() {
    if (!isOnline()) return "neutral";
    return isPublicEndpoint() ? "success" : "neutral";
  }

  function chatGptStatus() {
    if (!isOnline() || !isPublicEndpoint()) return "Not available";
    if (currentState.externalMcp.active) return currentState.externalMcp.activeSessions ? currentState.externalMcp.activeSessions + " active" : "Connected";
    if (currentState.externalMcp.connected) return "OAuth ready";
    if (currentState.externalMcp.configured) return "Authorize";
    return "Not connected";
  }

  function chatGptTone() {
    if (currentState.externalMcp.active || currentState.externalMcp.connected) return "success";
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

  function detailRow(list, label, value) {
    const item = el("div", "detail-grid__row");
    item.appendChild(el("dt", "detail-grid__label", label));
    item.appendChild(el("dd", "detail-grid__value", value));
    list.appendChild(item);
  }

  function commandButton(label, command, variant, value) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button--" + (variant || "secondary");
    button.textContent = label;
    button.dataset.command = command;
    if (value !== undefined) button.dataset.value = String(value);
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

  function postCommand(command, value) {
    vscode.postMessage({ type: "command", command: command, ...(value !== undefined ? { value: value } : {}) });
  }

  function postWizard(action, descriptor) {
    const message = {
      type: "wizard",
      action: action,
      requestId: "ui-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    };
    if (descriptor && descriptor.hosting) message.hosting = descriptor.hosting;
    if (descriptor && descriptor.accessMode) message.accessMode = descriptor.accessMode;
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
    if (!workspace) return "VS Code launcher";
    const parts = workspace.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || workspace;
  }

  function hostingLabel(kind) {
    const labels = {
      "quick-tunnel": "Quick Tunnel (temporary)",
      "cloudflare-fixed": "Cloudflare fixed domain",
      "cloudflare-named": "Cloudflare Named Tunnel",
      "custom-domain": "Existing HTTPS domain",
      "nip-io": "Legacy nip.io",
      "local": "Local only",
      "serve": "Local only",
      "none": "Local only",
    };
    return labels[kind] || (kind || "Not configured");
  }

  function compactUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value);
      return url.host + (url.pathname && url.pathname !== "/" ? url.pathname : "");
    } catch {
      return value.length > 70 ? value.slice(0, 67) + "…" : value;
    }
  }

  function activityMeta(item) {
    const parts = [];
    if (item.durationMs) parts.push(item.durationMs + " ms");
    if (item.startedAt) {
      const date = new Date(item.startedAt);
      if (!Number.isNaN(date.getTime())) parts.push(date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    }
    return parts.join(" · ");
  }

  function chip(label, tone) {
    return el("span", "chip chip--" + (tone || "neutral"), label);
  }

  function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function integer(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function text(value, maximum) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
    return String(value).replace(/\0/g, "").slice(0, maximum || 262144);
  }

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }
}());
