(function () {
  "use strict";

  const vscode = typeof acquireVsCodeApi === "function"
    ? acquireVsCodeApi()
    : { postMessage: function () {}, getState: function () { return {}; }, setState: function () {} };

  const ALLOWED_COMMANDS = new Set([
    "refresh",
    "manageTrust",
    "connectChatGpt",
    "openChatGpt",
    "setupChat",
    "sendChat",
    "cancelChat",
    "newChat",
    "configureAgents",
    "logoutAgent",
    "spawnAgent",
    "stopAgent",
    "viewAgentOutput",
    "initialize",
    "guidedSetup",
    "start",
    "startUnsafe",
    "serve",
    "stop",
    "restart",
    "openConfig",
    "copyMcpUrl",
    "registerClient",
    "connectNativeMcp",
    "disconnectNativeMcp",
    "openTerminal",
    "openCollaborationMonitor",
    "openPanel",
    "reset",
    "useWorkspace",
    "openDocs",
  ]);

  const ACTIVE_AGENT_STATUSES = new Set([
    "starting",
    "running",
    "waiting",
    "cancelling",
    "stopping",
    "stop_failed",
  ]);

  const CHAT_READY_STATUSES = new Set([
    "ready",
    "waiting",
    "running",
    "starting",
    "cancelling",
  ]);

  const EMPTY_STATE = {
    configured: null,
    trusted: null,
    workspace: "",
    configPath: "",
    process: { status: "loading", mode: "", pid: null, startedAt: null, awaitingInput: false },
    health: null,
    hostingMode: "",
    unsafeFullAccess: false,
    fullAccessClientCount: 0,
    mcpUrl: "",
    publicUrl: "",
    oauthEndpoints: null,
    clients: [],
    logs: [],
    nativeMcp: { connected: false, scope: "" },
    externalMcp: {
      configured: false,
      authorized: false,
      active: false,
      connected: false,
      activeSessions: 0,
    },
    collaboration: {
      available: false,
      latestCursor: 0,
      messages: [],
      tasks: [],
      activity: [],
      clients: [],
      error: "",
    },
    managedHosting: {
      configured: false,
      productionReady: false,
      serverState: "not-managed",
      tunnelState: "not-managed",
      enableState: "unknown",
      publicUrl: "",
      landingUrl: "",
      error: "",
    },
    agentRuntime: {
      state: "offline",
      runtimeState: "offline",
      coordinationState: "offline",
      active: 0,
      retained: 0,
      maxConcurrent: 0,
      byStatus: {},
      selectedProvider: "",
      selectedModel: "",
      selectedProviderName: "",
      selectedModelName: "",
      configuredAuthType: "",
      authReady: false,
      catalogAvailable: false,
      authBusy: false,
      agents: [],
      error: "",
    },
    chat: {
      agentId: "",
      status: "offline",
      busy: false,
      messages: [],
      error: "",
    },
    wizard: {
      active: false,
      completed: false,
      phase: "idle",
      revision: 0,
      workspace: "",
      accessMode: "workspace",
      publicUrl: "",
      mcpUrl: "",
      callbackUrl: "",
      chatGptPageOpened: false,
      developerModeConfirmed: false,
      chatGptConnected: false,
      credential: null,
      error: null,
    },
    version: "",
    nodeVersion: "",
    error: null,
  };

  const refs = {};
  let currentState = normalizeState(EMPTY_STATE);
  let hasReceivedState = false;
  let confirmationCommand = "";
  let confirmationValue;
  let confirmationTrigger = null;
  let lastRenderSignature = "";
  let renderRevision = 0;
  let pendingChatSubmission = null;
  let pendingChatTimer = null;
  let submissionError = "";
  const UI_STATE_VERSION = 2;
  const restoredUiState = typeof vscode.getState === "function" ? vscode.getState() : {};
  let uiMode = isRecord(restoredUiState) &&
    restoredUiState.version === UI_STATE_VERSION &&
    restoredUiState.mode === "local"
    ? "local"
    : "remote";

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function asText(value, fallback) {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return fallback || "";
  }

  function cleanText(value, maximum) {
    return asText(value).replace(/\0/g, "").slice(0, maximum || 262144);
  }

  function safeAgentId(value) {
    const candidate = asText(value);
    return /^[A-Za-z0-9._:@-]{1,256}$/.test(candidate) ? candidate : "";
  }

  function nonNegativeInteger(value, fallback) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : (fallback || 0);
  }

  function normalizeState(value) {
    const source = isRecord(value) ? value : {};
    const processState = isRecord(source.process) ? source.process : {};
    const nativeMcp = isRecord(source.nativeMcp) ? source.nativeMcp : {};
    const externalMcp = isRecord(source.externalMcp) ? source.externalMcp : {};
    const collaboration = isRecord(source.collaboration) ? source.collaboration : {};
    const managedHosting = isRecord(source.managedHosting) ? source.managedHosting : {};
    const agentRuntime = isRecord(source.agentRuntime) ? source.agentRuntime : {};
    const chat = isRecord(source.chat) ? source.chat : {};
    const wizard = isRecord(source.wizard) ? source.wizard : {};
    const wizardCredential = isRecord(wizard.credential) ? wizard.credential : null;
    const wizardError = isRecord(wizard.error) ? wizard.error : null;
    return {
      configured: typeof source.configured === "boolean" ? source.configured : null,
      trusted: typeof source.trusted === "boolean" ? source.trusted : null,
      workspace: cleanText(source.workspace, 8192),
      configPath: cleanText(source.configPath, 8192),
      process: {
        status: asText(processState.status, "stopped").toLowerCase(),
        mode: cleanText(processState.mode, 200).toLowerCase(),
        pid: typeof processState.pid === "number" || typeof processState.pid === "string" ? processState.pid : null,
        startedAt: processState.startedAt || null,
        awaitingInput: Boolean(processState.awaitingInput),
      },
      health: source.health === undefined ? null : source.health,
      hostingMode: cleanText(source.hostingMode, 100).toLowerCase(),
      unsafeFullAccess: source.unsafeFullAccess === true,
      fullAccessClientCount: nonNegativeInteger(source.fullAccessClientCount),
      mcpUrl: cleanText(source.mcpUrl, 4096),
      publicUrl: cleanText(source.publicUrl, 4096),
      oauthEndpoints: isRecord(source.oauthEndpoints) ? source.oauthEndpoints : null,
      clients: Array.isArray(source.clients) || typeof source.clients === "number" ? source.clients : [],
      logs: Array.isArray(source.logs) || typeof source.logs === "string" ? source.logs : [],
      nativeMcp: {
        connected: nativeMcp.connected === true,
        scope: Array.isArray(nativeMcp.scope)
          ? nativeMcp.scope.map(function (entry) { return cleanText(entry, 100); }).filter(Boolean).join(", ")
          : cleanText(nativeMcp.scope, 300),
      },
      externalMcp: {
        configured: externalMcp.configured === true,
        authorized: externalMcp.authorized === true,
        active: externalMcp.active === true,
        connected: externalMcp.connected === true,
        activeSessions: nonNegativeInteger(externalMcp.activeSessions),
      },
      collaboration: {
        available: collaboration.available === true,
        latestCursor: nonNegativeInteger(collaboration.latestCursor),
        messages: normalizeCollaborationMessages(collaboration.messages),
        tasks: normalizeCollaborationTasks(collaboration.tasks),
        activity: normalizeToolActivity(collaboration.activity),
        clients: normalizeCollaborationClients(collaboration.clients),
        error: cleanText(collaboration.error, 1000),
      },
      managedHosting: {
        configured: managedHosting.configured === true,
        productionReady: managedHosting.productionReady === true,
        serverState: cleanText(managedHosting.serverState, 100).toLowerCase() || "not-managed",
        tunnelState: cleanText(managedHosting.tunnelState, 100).toLowerCase() || "not-managed",
        enableState: cleanText(managedHosting.enableState, 100).toLowerCase() || "unknown",
        publicUrl: cleanText(managedHosting.publicUrl, 4096),
        landingUrl: cleanText(managedHosting.landingUrl, 4096),
        error: cleanText(managedHosting.error, 1000),
      },
      agentRuntime: {
        state: cleanText(agentRuntime.state, 100).toLowerCase() || "offline",
        runtimeState: cleanText(agentRuntime.runtimeState, 100).toLowerCase() || "offline",
        coordinationState: cleanText(agentRuntime.coordinationState, 100).toLowerCase() || "offline",
        active: nonNegativeInteger(agentRuntime.active),
        retained: nonNegativeInteger(agentRuntime.retained),
        maxConcurrent: nonNegativeInteger(agentRuntime.maxConcurrent),
        byStatus: isRecord(agentRuntime.byStatus) ? agentRuntime.byStatus : {},
        selectedProvider: cleanText(agentRuntime.selectedProvider, 256),
        selectedModel: cleanText(agentRuntime.selectedModel, 256),
        selectedProviderName: cleanText(agentRuntime.selectedProviderName, 300),
        selectedModelName: cleanText(agentRuntime.selectedModelName, 300),
        configuredAuthType: cleanText(agentRuntime.configuredAuthType, 40),
        authReady: agentRuntime.authReady === true,
        catalogAvailable: agentRuntime.catalogAvailable === true,
        authBusy: agentRuntime.authBusy === true,
        agents: normalizeAgents(agentRuntime.agents),
        error: cleanText(agentRuntime.error, 1000),
      },
      chat: {
        agentId: safeAgentId(chat.agentId),
        status: cleanText(chat.status, 100).toLowerCase() || "offline",
        busy: chat.busy === true,
        messages: normalizeChatMessages(chat.messages),
        error: cleanText(chat.error, 2000),
      },
      wizard: {
        active: wizard.active === true,
        completed: wizard.completed === true,
        phase: cleanText(wizard.phase, 40).toLowerCase() || "idle",
        revision: nonNegativeInteger(wizard.revision),
        workspace: cleanText(wizard.workspace, 8192),
        accessMode: wizard.accessMode === "full" ? "full" : "workspace",
        publicUrl: cleanText(wizard.publicUrl, 4096),
        mcpUrl: cleanText(wizard.mcpUrl, 4096),
        callbackUrl: cleanText(wizard.callbackUrl, 2048),
        chatGptPageOpened: wizard.chatGptPageOpened === true,
        developerModeConfirmed: wizard.developerModeConfirmed === true,
        chatGptConnected: wizard.chatGptConnected === true,
        credential: wizardCredential ? {
          clientId: cleanText(wizardCredential.clientId, 256),
          clientName: cleanText(wizardCredential.clientName, 200),
          scope: cleanText(wizardCredential.scope, 512),
          tokenEndpointAuthMethod: cleanText(wizardCredential.tokenEndpointAuthMethod, 100),
          hasSecret: wizardCredential.hasSecret === true,
        } : null,
        error: wizardError ? {
          message: cleanText(wizardError.message, 1000),
          retryable: wizardError.retryable === true,
        } : null,
      },
      version: cleanText(source.version, 100),
      nodeVersion: cleanText(source.nodeVersion, 100),
      error: source.error === undefined ? null : source.error,
    };
  }

  function normalizeAgents(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 50).flatMap(function (entry) {
      const source = isRecord(entry) ? entry : {};
      const agentId = safeAgentId(source.agentId);
      if (!agentId) return [];
      return [{
        agentId: agentId,
        role: cleanText(source.role, 128) || "agent",
        label: cleanText(source.label, 160),
        status: cleanText(source.status, 100).toLowerCase() || "unknown",
        hasError: source.hasError === true,
        updatedAt: cleanText(source.updatedAt, 100),
      }];
    });
  }

  function normalizeChatMessages(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(-300).flatMap(function (entry, index) {
      const source = isRecord(entry) ? entry : {};
      if (source.role !== "user" && source.role !== "assistant" && source.role !== "status") return [];
      const text = cleanText(source.text, 262144).trimEnd();
      if (!text) return [];
      return [{
        cursor: nonNegativeInteger(source.cursor, index + 1),
        role: source.role,
        text: text,
        createdAt: cleanText(source.createdAt, 100),
      }];
    });
  }

  function normalizeCollaborationMessages(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(-20).flatMap(function (entry, index) {
      const source = isRecord(entry) ? entry : {};
      const message = cleanText(source.message, 8192).trimEnd();
      if (!message) return [];
      return [{
        cursor: nonNegativeInteger(source.cursor, index + 1),
        agentId: cleanText(source.agentId, 256),
        agentInstanceId: cleanText(source.agentInstanceId, 256),
        agentName: cleanText(source.agentName, 100) || "ChatGPT agent",
        message: message,
      }];
    });
  }

  function normalizeCollaborationTasks(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 200).flatMap(function (entry) {
      const source = isRecord(entry) ? entry : {};
      const taskId = cleanText(source.taskId, 128);
      const title = cleanText(source.title, 256);
      if (!taskId || !title) return [];
      return [{
        taskId: taskId,
        title: title,
        details: cleanText(source.details, 8192),
        status: cleanText(source.status, 64).toLowerCase() || "unknown",
        statusMessage: cleanText(source.statusMessage, 8192),
        artifact: cleanText(source.artifact, 16384),
        createdBy: cleanText(source.createdBy, 100) || "Agent",
        owner: cleanText(source.owner, 100),
        leaseExpiresAt: cleanText(source.leaseExpiresAt, 100),
        createdAt: cleanText(source.createdAt, 100),
        updatedAt: cleanText(source.updatedAt, 100),
        revision: nonNegativeInteger(source.revision),
      }];
    });
  }

  function normalizeCollaborationClients(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 128).flatMap(function (entry) {
      const source = isRecord(entry) ? entry : {};
      const clientId = cleanText(source.clientId, 128);
      if (!clientId) return [];
      return [{
        clientId: clientId,
        activeMcpSessions: nonNegativeInteger(source.activeMcpSessions),
        registeredAt: cleanText(source.registeredAt, 100),
        authorizedAt: cleanText(source.authorizedAt, 100),
        tokenIssuedAt: cleanText(source.tokenIssuedAt, 100),
        refreshedAt: cleanText(source.refreshedAt, 100),
        mcpInitializedAt: cleanText(source.mcpInitializedAt, 100),
      }];
    });
  }

  function normalizeToolActivity(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(-100).flatMap(function (entry) {
      const source = isRecord(entry) ? entry : {};
      const tool = cleanText(source.tool, 100);
      const outcome = source.outcome === "success" || source.outcome === "error" ? source.outcome : "";
      const accessMode = source.accessMode === "full-access" ? "full-access" : source.accessMode === "workspace" ? "workspace" : "";
      if (!tool || !outcome || !accessMode) return [];
      return [{
        tool: tool,
        startedAt: cleanText(source.startedAt, 100),
        durationMs: nonNegativeInteger(source.durationMs),
        outcome: outcome,
        accessMode: accessMode,
        clientId: cleanText(source.clientId, 128),
        exitCode: typeof source.exitCode === "number" || source.exitCode === null ? source.exitCode : undefined,
        timedOut: source.timedOut === true,
        cancelled: source.cancelled === true,
      }];
    });
  }

  function visibleStateSignature(state) {
    try {
      return JSON.stringify({
        received: hasReceivedState,
        configured: state.configured,
        trusted: state.trusted,
        workspace: state.workspace,
        process: state.process,
        healthOnline: healthIsOnline(state.health),
        hostingMode: state.hostingMode,
        unsafeFullAccess: state.unsafeFullAccess,
        fullAccessClientCount: state.fullAccessClientCount,
        mcpUrl: state.mcpUrl,
        publicUrl: state.publicUrl,
        clients: state.clients,
        logs: state.logs,
        nativeMcp: state.nativeMcp,
        externalMcp: state.externalMcp,
        collaboration: state.collaboration,
        managedHosting: state.managedHosting,
        agentRuntime: state.agentRuntime,
        chat: state.chat,
        wizard: state.wizard,
        version: state.version,
        nodeVersion: state.nodeVersion,
        error: errorMessage(state.error),
      });
    } catch (_error) {
      return "state-signature-unavailable";
    }
  }

  function healthIsOnline(health) {
    if (health === true) return true;
    if (typeof health === "string") return ["ok", "healthy", "ready", "online"].includes(health.toLowerCase());
    return isRecord(health) && (
      health.online === true ||
      health.ok === true ||
      health.healthy === true ||
      ["ok", "healthy", "ready", "online"].includes(asText(health.status).toLowerCase())
    );
  }

  function el(tagName, className, textValue) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (textValue !== undefined && textValue !== null) element.textContent = asText(textValue);
    return element;
  }

  function append(parent) {
    for (let index = 1; index < arguments.length; index += 1) {
      const child = arguments[index];
      if (child) parent.appendChild(child);
    }
    return parent;
  }

  function makeButton(label, command, options) {
    const settings = options || {};
    const button = el("button", "button button--" + (settings.variant || "secondary"));
    button.type = "button";
    button.dataset.command = command;
    if (settings.compact) button.classList.add("button--compact");
    if (settings.iconOnly) button.classList.add("button--icon");
    if (settings.className) button.classList.add(settings.className);
    if (settings.value) button.dataset.value = settings.value;
    if (settings.disabled) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
    }
    if (settings.title) button.title = settings.title;
    if (settings.icon) {
      const icon = el("span", "button__icon", settings.icon);
      icon.setAttribute("aria-hidden", "true");
      button.appendChild(icon);
    }
    if (!settings.iconOnly) button.appendChild(el("span", "button__label", label));
    button.setAttribute("aria-label", settings.ariaLabel || label);
    return button;
  }

  function setButtonLabel(button, label) {
    if (!button) return;
    const target = button.querySelector(".button__label");
    if (target) target.textContent = label;
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  function makeChip(label, tone) {
    const chip = el("span", "chip chip--" + (tone || "neutral"));
    const dot = el("span", "chip__dot");
    dot.setAttribute("aria-hidden", "true");
    append(chip, dot, el("span", "chip__label", label));
    return chip;
  }

  function makeKeyValue(label, value, options) {
    const settings = options || {};
    const row = el("div", "key-value");
    row.appendChild(el("span", "key-value__label", label));
    const valueElement = el(settings.code ? "code" : "span", "key-value__value", value || "Not available");
    if (settings.title) valueElement.title = settings.title;
    row.appendChild(valueElement);
    return row;
  }

  function initialize() {
    let root = document.getElementById("app");
    if (!root) {
      root = el("div");
      root.id = "app";
      document.body.appendChild(root);
    }
    root.classList.add("app");
    refs.root = root;

    const header = el("header", "app-header");
    const brand = el("div", "brand");
    const mark = el("div", "brand-mark");
    mark.setAttribute("aria-hidden", "true");
    append(mark, el("span", "brand-mark__pi", "π"), el("span", "brand-mark__link brand-mark__link--one"), el("span", "brand-mark__link brand-mark__link--two"));
    const brandCopy = el("div", "brand__copy");
    append(brandCopy, el("h1", "brand__title", "VSPiLink"), el("p", "brand__subtitle", "ChatGPT ↔ Pi tools in your workspace"));
    append(brand, mark, brandCopy);

    const headerActions = el("div", "app-header__actions");
    const modeSwitch = el("div", "mode-switch");
    refs.remoteModeButton = el("button", "mode-switch__button", "ChatGPT MCP");
    refs.remoteModeButton.type = "button";
    refs.remoteModeButton.dataset.uiMode = "remote";
    refs.localModeButton = el("button", "mode-switch__button", "Pi Local");
    refs.localModeButton.type = "button";
    refs.localModeButton.dataset.uiMode = "local";
    append(modeSwitch, refs.remoteModeButton, refs.localModeButton);
    refs.openChatGptButton = makeButton("Open ChatGPT Work", "openChatGpt", {
      variant: "primary",
      compact: true,
      icon: "↗",
      className: "header-action",
      title: "Open ChatGPT Work, the current surface that supports plugins and remote MCP tools",
    });
    refs.headerStatus = el("span", "header-status", "Loading");
    refs.headerStatus.setAttribute("aria-live", "polite");
    const refreshButton = makeButton("Refresh", "refresh", {
      variant: "ghost",
      icon: "↻",
      iconOnly: true,
      compact: true,
      title: "Refresh status",
      ariaLabel: "Refresh VSPiLink status",
    });
    append(headerActions, modeSwitch, refs.openChatGptButton, refs.headerStatus, refreshButton);
    append(header, brand, headerActions);

    refs.main = el("main", "content chat-content");
    refs.main.id = "vspilink-main";
    const composer = buildComposer();
    const dialog = buildConfirmationDialog();
    refs.liveRegion = el("div", "sr-only");
    refs.liveRegion.setAttribute("role", "status");
    refs.liveRegion.setAttribute("aria-live", "polite");
    refs.liveRegion.setAttribute("aria-atomic", "true");

    root.replaceChildren(header, refs.main, composer, dialog, refs.liveRegion);
    root.addEventListener("click", handleRootClick);
    window.addEventListener("message", handleWindowMessage);
    render();
    postCommand("refresh");
  }

  function buildComposer() {
    const shell = el("div", "composer-shell is-hidden");
    refs.composerShell = shell;
    shell.setAttribute("aria-label", "Write to VSPiLink");

    refs.composerError = el("div", "composer-alert is-hidden");
    refs.composerError.setAttribute("role", "alert");
    const form = el("form", "composer");
    form.noValidate = true;
    const label = el("label", "sr-only", "Message for VSPiLink");
    label.htmlFor = "vspilink-composer-input";
    refs.composerInput = el("textarea", "composer__input");
    refs.composerInput.id = "vspilink-composer-input";
    refs.composerInput.rows = 1;
    refs.composerInput.maxLength = 65536;
    refs.composerInput.placeholder = "Ask VSPiLink…";
    refs.composerInput.autocomplete = "off";
    refs.composerInput.spellcheck = true;
    refs.cancelButton = el("button", "composer__cancel is-hidden", "■");
    refs.cancelButton.type = "button";
    refs.cancelButton.dataset.command = "cancelChat";
    refs.cancelButton.setAttribute("aria-label", "Stop the current turn");
    refs.cancelButton.title = "Stop";
    refs.sendButton = el("button", "composer__send", "↑");
    refs.sendButton.type = "submit";
    refs.sendButton.disabled = true;
    refs.sendButton.setAttribute("aria-label", "Send message");
    refs.sendButton.title = "Send message";
    append(form, label, refs.composerInput, refs.cancelButton, refs.sendButton);

    const meta = el("div", "composer-meta");
    refs.composerHelp = el("span", "composer-meta__help", "VSPiLink uses Pi in the open workspace.");
    const shortcut = el("span", "composer-meta__shortcut");
    append(shortcut, el("kbd", "key", "Enter"), document.createTextNode(" send · "), el("kbd", "key", "Shift+Enter"), document.createTextNode(" new line"));
    append(meta, refs.composerHelp, shortcut);
    append(shell, refs.composerError, form, meta);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      submitChat();
    });
    refs.composerInput.addEventListener("input", function () {
      if (submissionError) {
        submissionError = "";
        updateComposerError();
      }
      refs.sendButton.disabled = refs.composerInput.value.trim().length === 0 || chatIsBusy() || Boolean(pendingChatSubmission);
      resizeComposer();
    });
    refs.composerInput.addEventListener("keydown", handleComposerKeydown);
    return shell;
  }

  function buildConfirmationDialog() {
    const dialog = el("dialog", "confirm-dialog");
    dialog.setAttribute("aria-labelledby", "vspilink-confirm-title");
    dialog.setAttribute("aria-describedby", "vspilink-confirm-description");
    refs.confirmTitle = el("h2", "confirm-dialog__title", "Confirm action");
    refs.confirmTitle.id = "vspilink-confirm-title";
    refs.confirmDescription = el("p", "confirm-dialog__description");
    refs.confirmDescription.id = "vspilink-confirm-description";
    const actions = el("div", "confirm-dialog__actions");
    const cancel = el("button", "button button--secondary", "Cancel");
    cancel.type = "button";
    cancel.dataset.dialogAction = "cancel";
    refs.confirmButton = el("button", "button button--danger", "Continue");
    refs.confirmButton.type = "button";
    refs.confirmButton.dataset.dialogAction = "confirm";
    append(actions, cancel, refs.confirmButton);
    append(dialog, el("div", "confirm-dialog__mark", "!"), refs.confirmTitle, refs.confirmDescription, actions);
    dialog.addEventListener("cancel", closeConfirmation);
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) closeConfirmation();
    });
    return dialog;
  }

  function handleWindowMessage(event) {
    const message = event.data;
    if (!isRecord(message) || message.type !== "state" || !isRecord(message.state)) return;
    currentState = normalizeState(message.state);
    hasReceivedState = true;
    reconcilePendingChatSubmission();
    const nextSignature = visibleStateSignature(currentState);
    if (nextSignature !== lastRenderSignature) render();
  }

  function handleRootClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const modeButton = target.closest("button[data-ui-mode]");
    if (modeButton && (modeButton.dataset.uiMode === "remote" || modeButton.dataset.uiMode === "local")) {
      uiMode = modeButton.dataset.uiMode;
      if (typeof vscode.setState === "function") vscode.setState({ version: UI_STATE_VERSION, mode: uiMode });
      render();
      return;
    }
    const wizardButton = target.closest("button[data-wizard-action]");
    if (wizardButton && !wizardButton.disabled) {
      const action = wizardButton.dataset.wizardAction || "";
      if (action === "retry") postWizardAction("retry");
      if (action === "copyCredential") postWizardAction("copyCredential", { field: wizardButton.dataset.wizardField || "" });
      if (action === "confirmDeveloperMode") postWizardAction("confirmDeveloperMode");
      if (action === "openChatGpt") postWizardAction("openChatGpt", { destination: wizardButton.dataset.wizardDestination || "" });
      return;
    }
    const dialogButton = target.closest("[data-dialog-action]");
    if (dialogButton) {
      if (dialogButton.dataset.dialogAction === "confirm" && confirmationCommand) {
        const command = confirmationCommand;
        const value = confirmationValue;
        closeConfirmation();
        postCommand(command, value);
      } else {
        closeConfirmation();
      }
      return;
    }
    const commandButton = target.closest("button[data-command]");
    if (!commandButton || commandButton.disabled) return;
    const command = commandButton.dataset.command || "";
    if (!ALLOWED_COMMANDS.has(command)) return;
    const value = commandButton.dataset.value;
    if (command === "reset" || command === "startUnsafe") {
      openConfirmation(command, value, commandButton);
      return;
    }
    postCommand(command, value);
  }

  function postCommand(command, value) {
    if (!ALLOWED_COMMANDS.has(command)) return false;
    const message = { type: "command", command: command };
    if (value !== undefined) message.value = value;
    try {
      vscode.postMessage(message);
      if (command !== "refresh") announce(commandLabel(command) + " requested.");
      return true;
    } catch (_error) {
      announce("VSPiLink could not reach the extension host.");
      return false;
    }
  }

  function postWizardAction(action, payload) {
    const message = Object.assign({
      type: "wizard",
      action: action,
      requestId: "webview-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    }, payload || {});
    try {
      vscode.postMessage(message);
      announce("Connection step requested.");
      return true;
    } catch (_error) {
      announce("VSPiLink could not reach the setup controller.");
      return false;
    }
  }

  function commandLabel(command) {
    const labels = {
      setupChat: "Setup",
      connectChatGpt: "ChatGPT connection",
      openChatGpt: "Open ChatGPT",
      sendChat: "Message",
      cancelChat: "Stop",
      newChat: "New chat",
      configureAgents: "Model setup",
      spawnAgent: "New agent",
      stopAgent: "Stop agent",
    };
    return labels[command] || "Operation";
  }

  function openConfirmation(command, value, trigger) {
    confirmationCommand = command;
    confirmationValue = value;
    confirmationTrigger = trigger || document.activeElement;
    if (command === "startUnsafe") {
      refs.confirmTitle.textContent = "Enable full access?";
      refs.confirmDescription.textContent = "Authorized agents will be able to use the shell and access files outside the open folder.";
      refs.confirmButton.textContent = "Enable full access";
    } else {
      refs.confirmTitle.textContent = "Reset VSPiLink?";
      refs.confirmDescription.textContent = "Generated configuration and state will be removed. Project files will not be deleted.";
      refs.confirmButton.textContent = "Reset";
    }
    const dialog = refs.confirmTitle.closest("dialog");
    try { dialog.showModal(); } catch (_error) { dialog.setAttribute("open", ""); }
    refs.confirmButton.focus();
  }

  function closeConfirmation() {
    const dialog = refs.confirmTitle.closest("dialog");
    confirmationCommand = "";
    confirmationValue = undefined;
    if (dialog.open) dialog.close();
    else dialog.removeAttribute("open");
    if (confirmationTrigger && typeof confirmationTrigger.focus === "function") confirmationTrigger.focus();
    confirmationTrigger = null;
  }

  function render() {
    lastRenderSignature = visibleStateSignature(currentState);
    const revision = ++renderRevision;
    const renderState = captureRenderState();
    updateHeader();

    const fragment = document.createDocumentFragment();
    if (uiMode === "remote") {
      fragment.appendChild(renderChatGptWorkspace());
      fragment.appendChild(renderRemoteAgents());
      fragment.appendChild(renderTaskBoard());
    } else {
      fragment.appendChild(renderLocalModeIntro());
      fragment.appendChild(renderConversation());
      fragment.appendChild(renderCompactAgents());
    }
    fragment.appendChild(renderServerDetails());
    fragment.appendChild(renderFooter());
    refs.main.replaceChildren(fragment);
    updateComposerState();
    restoreRenderState(renderState, revision);
  }

  function captureRenderState() {
    const transcript = refs.main.querySelector(".transcript");
    const callbackInput = refs.main.querySelector("#vspilink-callback-url");
    const detailStates = {};
    refs.main.querySelectorAll("details[data-render-state-key]").forEach(function (details) {
      detailStates[details.dataset.renderStateKey] = details.open;
    });

    const input = refs.composerInput;
    return {
      transcript: transcript ? {
        scrollTop: transcript.scrollTop,
        follow: transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80,
      } : null,
      details: detailStates,
      callback: callbackInput ? {
        value: callbackInput.value,
        focused: document.activeElement === callbackInput,
        selectionStart: callbackInput.selectionStart,
        selectionEnd: callbackInput.selectionEnd,
      } : null,
      composer: input ? {
        draft: input.value,
        focused: document.activeElement === input,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
        selectionDirection: input.selectionDirection,
        scrollTop: input.scrollTop,
      } : null,
    };
  }

  function restoreRenderState(renderState, revision) {
    refs.main.querySelectorAll("details[data-render-state-key]").forEach(function (details) {
      const key = details.dataset.renderStateKey;
      if (Object.prototype.hasOwnProperty.call(renderState.details, key)) {
        details.open = renderState.details[key];
      }
    });

    const callbackInput = refs.main.querySelector("#vspilink-callback-url");
    if (renderState.callback && callbackInput) {
      callbackInput.value = renderState.callback.value;
      if (renderState.callback.focused) {
        try { callbackInput.focus({ preventScroll: true }); } catch (_error) { callbackInput.focus(); }
        try { callbackInput.setSelectionRange(renderState.callback.selectionStart, renderState.callback.selectionEnd); } catch (_error) {}
      }
    }

    const composer = renderState.composer;
    if (composer && refs.composerInput) {
      refs.composerInput.value = composer.draft;
      resizeComposer();
      refs.composerInput.scrollTop = composer.scrollTop;
      if (composer.focused && !refs.composerInput.disabled) {
        try { refs.composerInput.focus({ preventScroll: true }); } catch (_error) { refs.composerInput.focus(); }
        try {
          refs.composerInput.setSelectionRange(
            composer.selectionStart,
            composer.selectionEnd,
            composer.selectionDirection || "none",
          );
        } catch (_error) {}
      }
    }

    window.requestAnimationFrame(function () {
      if (revision !== renderRevision) return;
      const transcript = refs.main.querySelector(".transcript");
      if (!transcript) return;
      if (!renderState.transcript || renderState.transcript.follow) {
        transcript.scrollTop = transcript.scrollHeight;
      } else {
        transcript.scrollTop = renderState.transcript.scrollTop;
      }
    });
  }

  function updateHeader() {
    const status = chatStatusModel();
    refs.headerStatus.textContent = status.label;
    refs.headerStatus.className = "header-status header-status--" + status.tone;
    refs.headerStatus.title = status.description;
    refs.remoteModeButton.classList.toggle("is-active", uiMode === "remote");
    refs.localModeButton.classList.toggle("is-active", uiMode === "local");
    refs.remoteModeButton.setAttribute("aria-pressed", uiMode === "remote" ? "true" : "false");
    refs.localModeButton.setAttribute("aria-pressed", uiMode === "local" ? "true" : "false");
    refs.openChatGptButton.disabled = currentState.trusted === false;
  }

  function chatStatusModel() {
    if (!hasReceivedState) return { label: "Loading", tone: "neutral", description: "Checking the local runtime" };
    if (currentState.trusted === false) return { label: "Restricted", tone: "warning", description: "Trust this folder before agents can use it" };
    if (currentState.configured !== true) return { label: "Setup required", tone: "neutral", description: "Local configuration is required" };
    if (uiMode === "remote") {
      if (!isRuntimeOnline()) return { label: "Server stopped", tone: "warning", description: "Start the VSPiLink MCP server" };
      if (currentState.externalMcp.active) {
        return {
          label: "MCP active",
          tone: "success",
          description: "Active MCP connections: " + currentState.externalMcp.activeSessions,
        };
      }
      if (currentState.externalMcp.connected) return {
        label: "ChatGPT ready",
        tone: "success",
        description: "OAuth is already authorized; no callback needs to be entered again",
      };
      if (currentState.externalMcp.configured) return {
        label: "Finish sign-in",
        tone: "progress",
        description: "The OAuth client already exists; finish Connect/Authorize in ChatGPT",
      };
      if (currentState.wizard.credential) return { label: "Authorize", tone: "progress", description: "Finish Connect/Authorize in the ChatGPT tab" };
      if (currentState.wizard.chatGptPageOpened) return { label: "Install plugin", tone: "progress", description: "In ChatGPT Work, open Plugins and install or connect the private VSPiLink plugin" };
      return { label: "Not connected", tone: "warning", description: "Connect ChatGPT to the VSPiLink MCP server" };
    }
    if (currentState.chat.status === "needs-workspace") return { label: "Folder", tone: "warning", description: "Choose the folder where Pi should work" };
    if (currentState.chat.status === "workspace-mismatch") return { label: "Folder", tone: "warning", description: "Confirm the open folder before continuing" };
    if (currentState.chat.error || currentState.agentRuntime.error) return { label: "Error", tone: "danger", description: currentState.chat.error || currentState.agentRuntime.error };
    if (chatIsBusy()) return { label: "Working", tone: "progress", description: "VSPiLink is working" };
    if (isChatReady()) return { label: "Ready", tone: "success", description: "Pi is ready in the workspace" };
    if (!agentIsConfigured()) return { label: "Sign-in", tone: "warning", description: "Sign in and choose a model" };
    return { label: "Offline", tone: "warning", description: "Start the local runtime" };
  }

  function renderChatGptWorkspace() {
    const shell = el("section", "conversation-shell remote-workspace");
    shell.setAttribute("aria-labelledby", "vspilink-remote-title");
    const toolbar = el("div", "conversation-toolbar");
    const context = el("div", "conversation-context");
    const title = el("h2", "conversation-title", "ChatGPT via MCP");
    title.id = "vspilink-remote-title";
    const workspace = currentState.workspace || "No folder open";
    const workspaceLabel = el("span", "conversation-workspace", compactPath(workspace));
    workspaceLabel.title = workspace;
    append(context, title, workspaceLabel);
    append(toolbar, context, remoteConnectionChip());
    shell.appendChild(toolbar);

    if (!hasReceivedState) {
      shell.appendChild(renderRemoteEmpty("Preparing the connection", "Checking the MCP server, OAuth, and workspace.", null));
      return shell;
    }
    if (currentState.trusted === false) {
      shell.appendChild(renderRemoteEmpty(
        "Trust this folder",
        "VS Code must trust the workspace before ChatGPT can use the Pi tools.",
        { label: "Manage Workspace Trust", command: "manageTrust" }
      ));
      return shell;
    }
    if (currentState.configured !== true) {
      shell.appendChild(renderRemoteEmpty(
        "Set up the MCP bridge",
        "Choose a folder and prepare the endpoint ChatGPT will use to work here.",
        { label: "Start setup", command: "connectChatGpt" }
      ));
      return shell;
    }
    if (!isRuntimeOnline()) {
      shell.appendChild(renderRemoteEmpty(
        "Start the MCP server",
        "Configuration exists, but the PiLink service is not running.",
        { label: "Start and connect ChatGPT", command: "connectChatGpt" }
      ));
      return shell;
    }

    if (!currentState.externalMcp.configured) {
      shell.appendChild(renderChatGptConnectionGuide());
      return shell;
    }

    if (!currentState.externalMcp.connected) {
      const registered = el("div", "remote-connected remote-connected--pending");
      const registeredCopy = el("div", "remote-connected__copy");
      append(registeredCopy,
        el("strong", "remote-connected__title", "The OAuth client is already registered"),
        el("span", "remote-connected__description", "Do not search for a callback or create another client. Continue below, then open VSPiLink in ChatGPT and choose Connect/Authorize.")
      );
      const registeredActions = el("div", "remote-connected__actions");
      registeredActions.appendChild(makeButton("Continue in ChatGPT", "connectChatGpt", { variant: "primary", compact: true, icon: "↗" }));
      append(registered, registeredCopy, registeredActions);
      shell.appendChild(registered);
      return shell;
    }

    const connected = el("div", "remote-connected");
    const copy = el("div", "remote-connected__copy");
    append(copy,
      el("strong", "remote-connected__title", currentState.externalMcp.active ? "ChatGPT is connected" : "VSPiLink is configured"),
      el("span", "remote-connected__description", currentState.externalMcp.active
        ? "Active MCP connections: " + currentState.externalMcp.activeSessions + ". Write in the main ChatGPT tab; this panel monitors coordination activity, agents, and tasks."
        : "OAuth is stored persistently, so the callback does not need to be entered again. Open ChatGPT Work and start a task; the MCP session will activate automatically.")
    );
    const actions = el("div", "remote-connected__actions");
    append(actions,
      makeButton("Open ChatGPT Work", "openChatGpt", { variant: "primary", compact: true, icon: "↗" }),
      makeButton("Open collaboration monitor", "openCollaborationMonitor", { variant: "secondary", compact: true, icon: ">_" })
    );
    append(connected, copy, actions);
    shell.appendChild(connected);

    const transcript = el("div", "transcript remote-transcript");
    transcript.setAttribute("role", "log");
    transcript.setAttribute("aria-live", "polite");
    transcript.setAttribute("aria-label", "ChatGPT agent coordination activity");
    if (currentState.collaboration.messages.length) {
      currentState.collaboration.messages.forEach(function (message) {
        transcript.appendChild(renderCollaborationMessage(message));
      });
    }
    if (currentState.collaboration.activity.length) {
      transcript.appendChild(renderToolActivity(currentState.collaboration.activity));
    }
    if (!currentState.collaboration.messages.length && !currentState.collaboration.activity.length) {
      transcript.appendChild(renderRemoteEmpty(
        "No coordination activity yet",
        "Start a task in ChatGPT Work. MCP calls and messages published by agents will appear here automatically; observed agents and shared tasks remain in the monitor panels.",
        { label: "Open ChatGPT Work", command: "openChatGpt" }
      ));
    }
    if (currentState.collaboration.error) transcript.appendChild(renderInlineError(currentState.collaboration.error));
    shell.appendChild(transcript);
    return shell;
  }

  function renderToolActivity(activity) {
    const section = el("section", "tool-activity");
    append(section,
      el("h3", "tool-activity__title", "Recent MCP activity"),
      el("p", "tool-activity__description", "Technical metadata only: tool, outcome, and duration. Prompts, paths, arguments, and results are not displayed.")
    );
    const list = el("ul", "tool-activity__list");
    activity.slice(-30).reverse().forEach(function (entry) {
      const item = el("li", "tool-activity__item");
      const copy = el("span", "tool-activity__copy");
      const when = entry.startedAt && !Number.isNaN(Date.parse(entry.startedAt))
        ? new Date(entry.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        : "";
      append(copy,
        el("strong", "tool-activity__tool", entry.tool),
        el("span", "tool-activity__meta", [when, entry.durationMs + " ms", entry.accessMode === "full-access" ? "full access" : "workspace"].filter(Boolean).join(" · "))
      );
      append(item, copy, makeChip(entry.outcome === "success" ? "Completed" : "Error", entry.outcome === "success" ? "success" : "danger"));
      list.appendChild(item);
    });
    section.appendChild(list);
    return section;
  }

  function remoteConnectionChip() {
    if (currentState.externalMcp.active) {
      const label = currentState.externalMcp.activeSessions > 0
        ? "MCP · " + currentState.externalMcp.activeSessions + (currentState.externalMcp.activeSessions === 1 ? " connection" : " connections")
        : "MCP active";
      return makeChip(label, "success");
    }
    if (currentState.externalMcp.connected) return makeChip("OAuth ready", "success");
    if (currentState.externalMcp.configured) return makeChip("Client registered", "warning");
    if (isRuntimeOnline()) return makeChip("Not connected", "warning");
    return makeChip("Server stopped", "neutral");
  }

  function renderRemoteEmpty(title, description, action) {
    const empty = el("div", "empty-chat remote-empty");
    const mark = el("div", "empty-chat__mark", "↔");
    mark.setAttribute("aria-hidden", "true");
    append(empty, mark, el("h3", "empty-chat__title", title), el("p", "empty-chat__description", description));
    if (action) empty.appendChild(makeButton(action.label, action.command, {
      variant: "primary",
      icon: action.icon || "→",
    }));
    return empty;
  }

  function renderChatGptConnectionGuide() {
    const guide = el("div", "connection-guide");
    const intro = el("div", "connection-guide__intro");
    append(intro,
      el("p", "connection-guide__eyebrow", "PRIMARY PATH · CHATGPT WORK + MCP"),
      el("h3", "connection-guide__title", "Connect ChatGPT Work to this workspace"),
      el("p", "connection-guide__description", "ChatGPT Work remains the agent surface and coordinator. Its selected model uses the Pi tools that VSPiLink exposes for this folder through an OAuth-protected MCP connection.")
    );
    guide.appendChild(intro);

    const endpoint = el("div", "connection-endpoint");
    const endpointCopy = el("div", "connection-endpoint__copy");
    append(endpointCopy, el("span", "connection-endpoint__label", "MCP endpoint"), el("code", "connection-endpoint__value", currentState.mcpUrl || "Not available"));
    const endpointActions = el("div", "connection-endpoint__actions");
    append(endpointActions,
      makeButton("Copy", "copyMcpUrl", { variant: "secondary", compact: true, icon: "⧉", disabled: !currentState.mcpUrl }),
      makeButton("Agent monitor", "openCollaborationMonitor", { variant: "ghost", compact: true, icon: ">_" })
    );
    append(endpoint, endpointCopy, endpointActions);
    guide.appendChild(endpoint);

    const catalogWarning = el("div", "connection-catalog-warning");
    append(catalogWarning,
      el("strong", "connection-catalog-warning__title", "Do not choose a similarly named public result."),
      el("span", "connection-catalog-warning__text", "Your VSPiLink entry must come from your personal or workspace plugin source and point to the MCP endpoint shown above. Searching for “mcp server” will show other vendors' servers.")
    );
    guide.appendChild(catalogWarning);

    const steps = el("ol", "connection-steps");
    const workOpened = currentState.wizard.chatGptPageOpened === true;
    const workActions = el("div", "connection-step__actions");
    workActions.appendChild(makeWizardButton(
      workOpened ? "Reopen ChatGPT Work" : "Open ChatGPT Work",
      "openChatGpt",
      { destination: "work", variant: workOpened ? "secondary" : "primary", compact: true, icon: "↗" }
    ));
    steps.appendChild(renderConnectionStep(
      1,
      "Open ChatGPT Work",
      "In the ChatGPT tab, use the surface selector at the upper left and choose Work. VSPiLink tools are not available in normal Chat under the current plugin model.",
      workOpened,
      workActions
    ));
    const pluginAction = workOpened && !currentState.wizard.credential
      ? makeWizardButton("Open Work Plugins", "openChatGpt", { destination: "plugins", variant: "primary", compact: true })
      : null;
    steps.appendChild(renderConnectionStep(
      2,
      "Install or connect the private VSPiLink plugin",
      "In Work, click Plugins in the left sidebar. Open the VSPiLink entry supplied by your personal or workspace plugin source, then click Install or Connect. If you own the plugin and the builder is available, set its MCP URL to the endpoint copied above and choose OAuth. If no VSPiLink entry or creation/import control exists, ask the workspace administrator or publisher; do not install another vendor's result.",
      currentState.externalMcp.configured,
      pluginAction
    ));
    steps.appendChild(renderCallbackStep());
    steps.appendChild(renderCredentialStep());
    guide.appendChild(steps);

    const legacy = el("details", "manual-oauth");
    legacy.dataset.renderStateKey = "legacy-chatgpt-connection";
    legacy.appendChild(el("summary", "manual-oauth__summary", "Legacy Developer Mode compatibility"));
    legacy.appendChild(el("p", "manual-oauth__description", "Use this only if your account still exposes the older Developer Mode/private-connection builder. Open Security and login, enable Developer Mode, then open Plugins and create VSPiLink with the endpoint above. This compatibility path is not the supported primary Work flow."));
    const legacyActions = el("div", "connection-step__actions");
    append(legacyActions,
      makeWizardButton("Open Security and login", "openChatGpt", { destination: "security", variant: "secondary", compact: true, icon: "↗" }),
      makeWizardButton("Open legacy Plugins", "openChatGpt", { destination: "plugins", variant: "secondary", compact: true, icon: "↗" })
    );
    legacy.appendChild(legacyActions);
    guide.appendChild(legacy);
    if (currentState.wizard.error?.message) {
      guide.appendChild(renderInlineError(currentState.wizard.error.message));
      if (currentState.wizard.error.retryable) {
        guide.appendChild(makeWizardButton("Retry", "retry", { variant: "secondary", compact: true }));
      }
    }
    return guide;
  }

  function renderConnectionStep(number, title, description, complete, action) {
    const step = el("li", "connection-step" + (complete ? " is-complete" : ""));
    const marker = el("span", "connection-step__number", complete ? "✓" : String(number));
    const body = el("div", "connection-step__body");
    append(body, el("strong", "connection-step__title", title), el("p", "connection-step__description", description));
    if (action) body.appendChild(action);
    append(step, marker, body);
    return step;
  }

  function renderCallbackStep() {
    const complete = currentState.externalMcp.configured || Boolean(currentState.wizard.credential);
    const available = currentState.wizard.chatGptPageOpened === true;
    const step = renderConnectionStep(
      3,
      "Use automatic OAuth registration",
      complete
        ? "The ChatGPT OAuth client is already registered. You do not need to copy or enter a callback again."
        : available
          ? "In the ChatGPT form, open Advanced OAuth settings → Registration method → Dynamic Client Registration (DCR), then click Create. VSPiLink registers the callback automatically; you do not need to find or copy it."
          : "Open ChatGPT Work first. When the VSPiLink plugin builder asks for OAuth registration, use DCR; there is no callback to find or copy.",
      complete,
      null
    );
    if (!complete && available) {
      const body = step.querySelector(".connection-step__body");
      const manual = el("details", "manual-oauth");
      const summary = el("summary", "manual-oauth__summary", "Only when DCR is unavailable: User-Defined setup");
      manual.appendChild(summary);
      manual.appendChild(el("p", "manual-oauth__description", "This advanced fallback preserves manual registration. In ChatGPT, choose User-Defined OAuth Client, copy the Callback URL shown in the form, and paste it here."));
      const form = el("form", "callback-form");
      const label = el("label", "sr-only", "Callback URL shown by ChatGPT");
      label.htmlFor = "vspilink-callback-url";
      const input = el("input", "callback-form__input");
      input.id = "vspilink-callback-url";
      input.type = "url";
      input.placeholder = "https://…/oauth/callback";
      input.value = currentState.wizard.callbackUrl || "";
      input.autocomplete = "off";
      const submit = el("button", "button button--primary", "Register callback");
      submit.type = "submit";
      append(form, label, input, submit);
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        const value = input.value.trim();
        if (!value) {
          input.focus();
          return;
        }
        postWizardAction("submitCallback", { callbackUrl: value });
      });
      manual.appendChild(form);
      body.appendChild(manual);
    }
    return step;
  }

  function renderCredentialStep() {
    const credential = currentState.wizard.credential;
    const step = renderConnectionStep(
      4,
      "Complete OAuth and authorize",
      credential
        ? "Return to ChatGPT and paste the values below. Then click Connect/Authorize and approve the request on the VSPiLink page."
        : "After the callback is registered, VSPiLink generates a client ID and secret without exposing the secret in logs.",
      currentState.externalMcp.connected,
      null
    );
    if (!credential) return step;
    const body = step.querySelector(".connection-step__body");
    const values = el("div", "credential-grid");
    append(values,
      renderCredentialRow("Client ID", credential.clientId, "clientId"),
      renderCredentialRow("Client secret", "••••••••••••••••", "clientSecret"),
      renderCredentialRow("Authorization URL", (currentState.publicUrl || "") + "/oauth/authorize", "authorizationUrl"),
      renderCredentialRow("Token URL", (currentState.publicUrl || "") + "/oauth/token", "tokenUrl")
    );
    body.appendChild(values);
    body.appendChild(makeWizardButton("Return to plugin setup", "openChatGpt", { destination: "plugins", variant: "primary", compact: true }));
    return step;
  }

  function renderCredentialRow(label, value, field) {
    const row = el("div", "credential-row");
    const copy = el("div", "credential-row__copy");
    append(copy, el("span", "credential-row__label", label), el("code", "credential-row__value", value));
    append(row, copy, makeWizardButton("Copy", "copyCredential", { field: field, variant: "ghost", compact: true }));
    return row;
  }

  function makeWizardButton(label, action, options) {
    const settings = options || {};
    const button = el("button", "button button--" + (settings.variant || "secondary"));
    button.type = "button";
    button.dataset.wizardAction = action;
    if (settings.field) button.dataset.wizardField = settings.field;
    if (settings.destination) button.dataset.wizardDestination = settings.destination;
    if (settings.disabled) button.disabled = true;
    if (settings.compact) button.classList.add("button--compact");
    button.appendChild(el("span", "button__label", label));
    return button;
  }

  function renderCollaborationMessage(message) {
    const article = el("article", "chat-message chat-message--remote");
    const meta = el("div", "chat-message__meta");
    append(meta, el("span", "chat-message__author", message.agentName), el("span", "chat-message__time", "#" + message.cursor));
    const body = el("div", "chat-message__body", message.message);
    append(article, meta, body);
    return article;
  }

  function renderRemoteAgents() {
    const identities = new Map();
    currentState.collaboration.messages.forEach(function (message) {
      const key = message.agentInstanceId || message.agentId || message.agentName;
      identities.set(key, message.agentName);
    });
    const details = el("details", "compact-agents remote-agents");
    details.dataset.renderStateKey = "remote-agents";
    if (currentState.externalMcp.configured) details.open = true;
    const summary = el("summary", "compact-agents__summary");
    append(summary,
      el("span", "compact-agents__label", "Observed agent identities"),
      el("span", "compact-agents__count", String(identities.size)),
      el("span", "compact-agents__chevron", "⌄")
    );
    details.appendChild(summary);
    const body = el("div", "compact-agents__body");
    body.appendChild(el(
      "p",
      "compact-agents__hint",
      "Active MCP connections: " + currentState.externalMcp.activeSessions + ". This count measures MCP connections, not agents.",
    ));
    if (!identities.size) {
      body.appendChild(el("p", "compact-agents__empty", "No agent identity has been observed. An agent appears here only after publishing a message through agent_chat_post."));
    } else {
      const list = el("ul", "agent-list");
      identities.forEach(function (name, id) {
        const item = el("li", "agent-row");
        const avatar = el("span", "agent-row__avatar", (name || "A").slice(0, 1).toUpperCase());
        const copy = el("span", "agent-row__copy");
        append(copy, el("span", "agent-row__name", name), el("span", "agent-row__status", compactAgentId(id)));
        append(item, avatar, copy, makeChip("MCP", "success"));
        list.appendChild(item);
      });
      body.appendChild(list);
    }
    const initializedClients = currentState.collaboration.clients.filter(function (client) {
      return Boolean(client.mcpInitializedAt);
    });
    if (initializedClients.length) {
      body.appendChild(el("h3", "compact-agents__subheading", "Observed MCP clients"));
      const clients = el("ul", "agent-list");
      initializedClients.forEach(function (client) {
        const item = el("li", "agent-row");
        const avatar = el("span", "agent-row__avatar", "C");
        const copy = el("span", "agent-row__copy");
        append(copy,
          el("span", "agent-row__name", "MCP client " + client.clientId),
          el("span", "agent-row__status", "Active connections: " + client.activeMcpSessions),
        );
        append(item, avatar, copy, makeChip("Client", client.activeMcpSessions ? "success" : "neutral"));
        clients.appendChild(item);
      });
      body.appendChild(clients);
    }
    body.appendChild(el("p", "compact-agents__hint", "Write in the main ChatGPT Work tab. This panel only observes published identities, MCP clients, and shared tasks; it is not a remote prompt box."));
    details.appendChild(body);
    return details;
  }

  function renderTaskBoard() {
    const tasks = currentState.collaboration.tasks;
    const details = el("details", "task-board");
    details.dataset.renderStateKey = "tasks";
    const summary = el("summary", "task-board__summary");
    append(summary,
      el("span", "task-board__title", "Shared tasks"),
      el("span", "task-board__count", String(tasks.length)),
      el("span", "task-board__chevron", "⌄")
    );
    details.appendChild(summary);
    const body = el("div", "task-board__body");
    if (!tasks.length) {
      body.appendChild(el("p", "task-board__empty", "The board populates when ChatGPT uses the collaborative agent_task_* tools."));
    } else {
      const groups = [
        { title: "To do", statuses: ["open"] },
        { title: "In progress", statuses: ["working"] },
        { title: "Needs input", statuses: ["input_required"] },
        { title: "Closed", statuses: ["completed", "failed", "cancelled"] },
      ];
      const grid = el("div", "task-grid");
      groups.forEach(function (group) {
        const column = el("section", "task-column");
        const selected = tasks.filter(function (task) { return group.statuses.includes(task.status); });
        append(column, el("h3", "task-column__title", group.title + " · " + selected.length));
        if (!selected.length) {
          column.appendChild(el("p", "task-column__empty", "—"));
        } else {
          selected.forEach(function (task) { column.appendChild(renderTaskCard(task)); });
        }
        grid.appendChild(column);
      });
      body.appendChild(grid);
    }
    details.appendChild(body);
    return details;
  }

  function renderTaskCard(task) {
    const card = el("article", "task-card task-card--" + task.status);
    append(card, el("strong", "task-card__title", task.title));
    if (task.statusMessage) card.appendChild(el("p", "task-card__message", task.statusMessage));
    const owner = task.owner || task.createdBy;
    append(card, el("span", "task-card__meta", owner + " · " + task.taskId.slice(0, 8)));
    return card;
  }

  function renderLocalModeIntro() {
    const notice = el("section", "local-mode-intro");
    const copy = el("div", "local-mode-intro__copy");
    append(copy,
      el("p", "local-mode-intro__eyebrow", "OPTIONAL MODE"),
      el("h2", "local-mode-intro__title", "Pi Local chat"),
      el("p", "local-mode-intro__description", "This path uses a provider and model configured in Pi. It is not required for ChatGPT MCP and does not replace the original PiLink workflow.")
    );
    const actions = el("div", "local-mode-intro__actions");
    append(actions,
      makeButton("Provider and model", "configureAgents", { variant: "secondary", compact: true, disabled: currentState.configured !== true || currentState.agentRuntime.authBusy }),
      makeButton("New local chat", "newChat", { variant: "ghost", compact: true, disabled: !isChatReady() && !currentState.chat.agentId })
    );
    append(notice, copy, actions);
    return notice;
  }

  function compactAgentId(value) {
    const text = asText(value);
    return text.length > 20 ? text.slice(0, 8) + "…" + text.slice(-6) : text;
  }

  function renderConversation() {
    const shell = el("section", "conversation-shell");
    shell.setAttribute("aria-labelledby", "vspilink-conversation-title");
    const toolbar = el("div", "conversation-toolbar");
    const context = el("div", "conversation-context");
    const title = el("h2", "conversation-title", "Chat");
    title.id = "vspilink-conversation-title";
    const workspace = currentState.workspace || "No folder open";
    const workspaceLabel = el("span", "conversation-workspace", compactPath(workspace));
    workspaceLabel.title = workspace;
    append(context, title, workspaceLabel);
    const stateLabel = chatIsBusy() ? "Working" : (currentState.chat.agentId ? statusLabel(currentState.chat.status) : "New conversation");
    append(toolbar, context, makeChip(stateLabel, chatIsBusy() ? "progress" : (isChatReady() ? "success" : "neutral")));
    shell.appendChild(toolbar);

    const transcript = el("div", "transcript");
    transcript.setAttribute("role", "log");
    transcript.setAttribute("aria-live", "polite");
    transcript.setAttribute("aria-label", "VSPiLink conversation");
    if (currentState.chat.messages.length) {
      currentState.chat.messages.forEach(function (message) {
        transcript.appendChild(renderChatMessage(message));
      });
      if (chatIsBusy()) transcript.appendChild(renderThinkingMessage());
    } else {
      transcript.appendChild(renderEmptyChat());
    }
    if (currentState.chat.error) transcript.appendChild(renderInlineError(currentState.chat.error));
    shell.appendChild(transcript);
    return shell;
  }

  function renderChatMessage(message) {
    if (message.role === "status") {
      const status = el("div", "chat-event");
      append(status, el("span", "chat-event__dot"), el("span", "chat-event__text", message.text));
      if (message.createdAt) status.title = formatDate(message.createdAt);
      return status;
    }
    const article = el("article", "chat-message chat-message--" + message.role);
    const meta = el("div", "chat-message__meta");
    meta.appendChild(el("span", "chat-message__author", message.role === "user" ? "You" : "VSPiLink"));
    if (message.createdAt) meta.appendChild(el("time", "chat-message__time", formatTime(message.createdAt)));
    const body = el("div", "chat-message__body", message.text);
    append(article, meta, body);
    return article;
  }

  function renderThinkingMessage() {
    const article = el("article", "chat-message chat-message--assistant chat-message--thinking");
    const dots = el("span", "thinking-dots");
    append(dots, el("span"), el("span"), el("span"));
    append(article, el("div", "chat-message__meta", "VSPiLink"), dots);
    article.setAttribute("aria-label", "VSPiLink is working");
    return article;
  }

  function renderEmptyChat() {
    const empty = el("div", "empty-chat");
    const mark = el("div", "empty-chat__mark", "π");
    mark.setAttribute("aria-hidden", "true");
    const model = emptyChatModel();
    append(empty, mark, el("h3", "empty-chat__title", model.title), el("p", "empty-chat__description", model.description));
    if (model.command) empty.appendChild(makeButton(model.label, model.command, {
      variant: "primary",
      icon: model.icon || "→",
      disabled: model.disabled,
    }));
    return empty;
  }

  function emptyChatModel() {
    if (!hasReceivedState) return { title: "Preparing VSPiLink", description: "Checking the local runtime and configured model.", disabled: true };
    if (currentState.trusted === false) return {
      title: "Trust this folder",
      description: "VS Code requires your confirmation before agents can read or modify the project.",
      label: "Manage Workspace Trust",
      command: "manageTrust",
    };
    if (currentState.configured !== true) return {
      title: "Start working with Pi",
      description: "VSPiLink configures the open folder and prepares the local runtime. No external service is required.",
      label: "Set up and start",
      command: "setupChat",
    };
    if (currentState.chat.status === "needs-workspace") return {
      title: "Choose a working folder",
      description: "VSPiLink never chooses a folder implicitly. Select the project where Pi is allowed to work.",
      label: "Choose folder",
      command: "setupChat",
    };
    if (currentState.chat.status === "workspace-mismatch") return {
      title: "Use the open folder",
      description: "VSPiLink is configured for another project. Confirm the change before agents can work here.",
      label: "Use this folder",
      command: "setupChat",
    };
    if (!agentIsConfigured()) return {
      title: "Sign in to a model",
      description: "Choose the provider, sign-in method, and model Pi will use.",
      label: "Sign in and choose model",
      command: "configureAgents",
    };
    if (!isChatReady()) return {
      title: "Start the local runtime",
      description: "Setup is complete. Start Pi to begin the conversation.",
      label: "Start VSPiLink",
      command: "setupChat",
    };
    return {
      title: "What do you want to build?",
      description: "Describe the outcome. Pi will work directly in the open folder with the configured permissions.",
    };
  }

  function renderInlineError(message) {
    const notice = el("div", "inline-error");
    append(notice, el("span", "inline-error__icon", "!"), el("span", "inline-error__text", message));
    return notice;
  }

  function renderCompactAgents() {
    const agents = currentState.agentRuntime.agents;
    const details = el("details", "compact-agents");
    details.dataset.renderStateKey = "agents";
    const summary = el("summary", "compact-agents__summary");
    const label = el("span", "compact-agents__label", "Agents");
    const count = currentState.agentRuntime.active + (currentState.agentRuntime.maxConcurrent ? "/" + currentState.agentRuntime.maxConcurrent : "");
    append(summary, label, el("span", "compact-agents__count", count || "0"), el("span", "compact-agents__chevron", "⌄"));
    details.appendChild(summary);
    const body = el("div", "compact-agents__body");
    const actions = el("div", "compact-agents__actions");
    append(actions,
      makeButton("New agent", "spawnAgent", { variant: "secondary", compact: true, icon: "+", disabled: !isChatReady() }),
      makeButton("Provider and model", "configureAgents", { variant: "ghost", compact: true, disabled: currentState.configured !== true || currentState.agentRuntime.authBusy }),
      currentState.agentRuntime.configuredAuthType
        ? makeButton("Sign out of provider", "logoutAgent", { variant: "ghost", compact: true, disabled: currentState.agentRuntime.authBusy })
        : null
    );
    body.appendChild(actions);
    if (!agents.length) {
      body.appendChild(el("p", "compact-agents__empty", "No secondary agent is active."));
    } else {
      const list = el("ul", "agent-list");
      agents.slice(0, 12).forEach(function (agent) {
        const item = el("li", "agent-row");
        const avatar = el("span", "agent-row__avatar", (agent.role || "A").slice(0, 1).toUpperCase());
        const copy = el("span", "agent-row__copy");
        append(copy, el("span", "agent-row__name", agent.label || agent.role), el("span", "agent-row__status", agent.role + " · " + statusLabel(agent.status)));
        const rowActions = el("span", "agent-row__actions");
        rowActions.appendChild(makeButton("Output", "viewAgentOutput", { variant: "ghost", compact: true, value: agent.agentId }));
        if (ACTIVE_AGENT_STATUSES.has(agent.status)) {
          rowActions.appendChild(makeButton("Stop", "stopAgent", { variant: "ghost", compact: true, value: agent.agentId }));
        }
        append(item, avatar, copy, rowActions);
        list.appendChild(item);
      });
      body.appendChild(list);
    }
    details.appendChild(body);
    return details;
  }

  function renderServerDetails() {
    const details = el("details", "server-details");
    details.dataset.renderStateKey = "server";
    const summary = el("summary", "server-details__summary");
    const copy = el("span", "server-details__summary-copy");
    append(copy, el("span", "server-details__title", "MCP server and advanced settings"), el("span", "server-details__subtitle", "Hosting, clients, process, and diagnostics"));
    append(summary, copy, makeChip(isRuntimeOnline() ? "Active" : "Inactive", isRuntimeOnline() ? "success" : "neutral"), el("span", "server-details__chevron", "⌄"));
    details.appendChild(summary);

    const body = el("div", "server-details__body");
    const facts = el("div", "server-facts");
    append(facts,
      makeKeyValue("Process", statusLabel(currentState.process.status)),
      makeKeyValue("Hosting", hostingLabel()),
      makeKeyValue("Access", currentState.unsafeFullAccess
        ? "Full · " + currentState.fullAccessClientCount + (currentState.fullAccessClientCount === 1 ? " client" : " clients")
        : "Open folder"),
      makeKeyValue("Clients", String(clientCount()))
    );
    if (currentState.mcpUrl) facts.appendChild(makeKeyValue("MCP endpoint", currentState.mcpUrl, { code: true, title: currentState.mcpUrl }));
    if (currentState.managedHosting.configured) {
      append(facts,
        makeKeyValue("Persistent service", managedStateLabel(currentState.managedHosting.serverState)),
        makeKeyValue("Tunnel", managedStateLabel(currentState.managedHosting.tunnelState)),
        makeKeyValue("Automatic startup", managedStateLabel(currentState.managedHosting.enableState))
      );
    }
    body.appendChild(facts);

    const connectionActions = el("div", "server-actions");
    if (currentState.mcpUrl) connectionActions.appendChild(makeButton("Copy MCP URL", "copyMcpUrl", { variant: "secondary", compact: true, icon: "⧉" }));
    connectionActions.appendChild(makeButton(
      currentState.nativeMcp.connected ? "Disconnect MCP from VS Code" : "Connect MCP to VS Code",
      currentState.nativeMcp.connected ? "disconnectNativeMcp" : "connectNativeMcp",
      { variant: "secondary", compact: true, disabled: currentState.configured !== true }
    ));
    connectionActions.appendChild(makeButton("Register client", "registerClient", { variant: "ghost", compact: true, disabled: currentState.configured !== true }));
    body.appendChild(connectionActions);

    const operations = el("div", "operation-grid");
    const running = isRuntimeOnline();
    const busy = processIsBusy();
    [
      { label: running ? "Restart service" : "Start service", command: running ? "restart" : "start", icon: running ? "↻" : "▶", disabled: busy || currentState.configured !== true },
      { label: "Stop service", command: "stop", icon: "■", disabled: !running || busy },
      { label: "Start local only", command: "serve", icon: "⌂", disabled: running || busy || currentState.managedHosting.configured },
      { label: currentState.unsafeFullAccess ? "Manage full access" : "Full access", command: "startUnsafe", icon: "!", danger: true, disabled: busy || currentState.configured !== true },
      { label: "Configure MCP hosting", command: "guidedSetup", icon: "☁", disabled: busy },
      { label: "Private configuration", command: "openConfig", icon: "⚙" },
      { label: "Terminal", command: "openTerminal", icon: ">_" },
      { label: "Agent monitor", command: "openCollaborationMonitor", icon: "◎" },
      { label: "Open wide panel", command: "openPanel", icon: "□" },
      { label: "Documentation", command: "openDocs", icon: "?" },
      { label: "Reset", command: "reset", icon: "!", danger: true },
    ].forEach(function (action) {
      const button = makeButton(action.label, action.command, {
        variant: action.danger ? "danger-subtle" : "ghost",
        compact: true,
        icon: action.icon,
        disabled: action.disabled,
      });
      button.classList.add("operation-button");
      operations.appendChild(button);
    });
    body.appendChild(operations);

    const diagnosticError = errorMessage(currentState.error) || currentState.managedHosting.error || currentState.agentRuntime.error;
    if (diagnosticError) body.appendChild(renderInlineError(diagnosticError));
    body.appendChild(renderLogsDisclosure());
    details.appendChild(body);
    return details;
  }

  function renderLogsDisclosure() {
    const details = el("details", "logs-disclosure");
    details.dataset.renderStateKey = "logs";
    const logs = normalizeLogs(currentState.logs);
    details.appendChild(el("summary", "logs-disclosure__summary", "Technical activity · " + logs.length));
    const view = el("div", "log-view");
    view.setAttribute("role", "log");
    if (!logs.length) {
      view.appendChild(el("p", "log-empty", "No recent technical activity."));
    } else {
      logs.forEach(function (entry) {
        const row = el("div", "log-row log-row--" + entry.level);
        append(row, el("span", "log-row__time", entry.time), el("span", "log-row__message", entry.message));
        view.appendChild(row);
      });
    }
    details.appendChild(view);
    return details;
  }

  function renderFooter() {
    const footer = el("footer", "app-footer");
    const versions = [];
    if (currentState.version) versions.push("VSPiLink " + normalizeVersion(currentState.version));
    if (currentState.nodeVersion) versions.push("Node " + normalizeVersion(currentState.nodeVersion));
    append(footer, el("span", "app-footer__versions", versions.join(" · ") || "VSPiLink for VS Code"), el("span", "app-footer__privacy", "Local execution"));
    return footer;
  }

  function updateComposerState() {
    const ready = uiMode === "local" && isChatReady();
    const busy = chatIsBusy();
    refs.composerShell.classList.toggle("is-hidden", !ready);
    document.body.classList.toggle("has-composer", ready);
    refs.composerInput.disabled = busy;
    refs.composerInput.placeholder = busy ? "VSPiLink is working…" : "Ask VSPiLink…";
    refs.sendButton.classList.toggle("is-hidden", busy);
    refs.cancelButton.classList.toggle("is-hidden", !busy);
    refs.sendButton.disabled = busy || Boolean(pendingChatSubmission) || refs.composerInput.value.trim().length === 0;
    refs.composerHelp.textContent = currentState.agentRuntime.selectedModelName || currentState.agentRuntime.selectedModel
      ? (currentState.agentRuntime.selectedModelName || currentState.agentRuntime.selectedModel) + " · local Pi agent"
      : "Local Pi agent";
    updateComposerError();
  }

  function updateComposerError() {
    const error = submissionError || currentState.chat.error;
    refs.composerError.textContent = error;
    refs.composerError.classList.toggle("is-hidden", !error);
  }

  function handleComposerKeydown(event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitChat();
    }
  }

  function submitChat() {
    if (!isChatReady() || chatIsBusy() || pendingChatSubmission) return;
    const draft = refs.composerInput.value;
    const message = refs.composerInput.value.trim();
    if (!message) return;
    const baselineCursor = currentState.chat.messages.reduce(function (maximum, entry) {
      return Math.max(maximum, entry.cursor);
    }, 0);
    pendingChatSubmission = {
      message: message,
      draft: draft,
      baselineCursor: baselineCursor,
      sawBusy: false,
      quietPolls: 0,
    };
    submissionError = "";
    if (!postCommand("sendChat", message)) {
      settlePendingChatSubmission(false, "The message was not sent. Try again.");
      return;
    }
    refs.sendButton.disabled = true;
    pendingChatTimer = window.setTimeout(function () {
      if (!pendingChatSubmission) return;
      settlePendingChatSubmission(false, "The message was not confirmed. Your text is still available, so you can try again.");
    }, 30_000);
  }

  function reconcilePendingChatSubmission() {
    const pending = pendingChatSubmission;
    if (!pending) return;
    const echoed = currentState.chat.messages.some(function (entry) {
      return entry.role === "user" && entry.cursor > pending.baselineCursor && entry.text.trim() === pending.message;
    });
    if (echoed) {
      settlePendingChatSubmission(true);
      return;
    }
    if (currentState.chat.error) {
      settlePendingChatSubmission(false, currentState.chat.error);
      return;
    }
    if (currentState.chat.busy) {
      pending.sawBusy = true;
      pending.quietPolls = 0;
      return;
    }
    if (pending.sawBusy) {
      pending.quietPolls += 1;
      if (pending.quietPolls >= 2) {
        settlePendingChatSubmission(false, "The message did not appear in the conversation. Your text was preserved.");
      }
    }
  }

  function settlePendingChatSubmission(accepted, error) {
    const pending = pendingChatSubmission;
    if (!pending) return;
    pendingChatSubmission = null;
    if (pendingChatTimer !== null) {
      window.clearTimeout(pendingChatTimer);
      pendingChatTimer = null;
    }
    if (accepted) {
      if (refs.composerInput.value === pending.draft) refs.composerInput.value = "";
      submissionError = "";
    } else {
      if (!refs.composerInput.value) refs.composerInput.value = pending.draft;
      submissionError = cleanText(error, 1000) || "The message was not sent. Your text was preserved.";
    }
    resizeComposer();
    updateComposerState();
  }

  function resizeComposer() {
    refs.composerInput.style.height = "auto";
    refs.composerInput.style.height = Math.min(refs.composerInput.scrollHeight, 160) + "px";
  }

  function agentIsConfigured() {
    return Boolean(
      currentState.agentRuntime.selectedProvider &&
      currentState.agentRuntime.selectedModel &&
      currentState.agentRuntime.authReady
    );
  }

  function isChatReady() {
    if (!hasReceivedState || currentState.trusted !== true || currentState.configured !== true || !agentIsConfigured()) return false;
    if (CHAT_READY_STATUSES.has(currentState.chat.status)) return true;
    return currentState.agentRuntime.runtimeState === "ready" && isRuntimeOnline();
  }

  function chatIsBusy() {
    return currentState.chat.busy || ["starting", "running", "cancelling"].includes(currentState.chat.status);
  }

  function isRuntimeOnline() {
    if (["running", "online", "ready", "serving"].includes(currentState.process.status)) return true;
    if (currentState.managedHosting.serverState === "active") return true;
    return healthIsOnline(currentState.health);
  }

  function processIsBusy() {
    return ["starting", "stopping", "restarting", "initializing", "connecting"].includes(currentState.process.status);
  }

  function clientCount() {
    if (typeof currentState.clients === "number") return Math.max(0, currentState.clients);
    return Array.isArray(currentState.clients) ? currentState.clients.length : 0;
  }

  function hostingLabel() {
    const labels = {
      "quick-tunnel": "Quick Tunnel",
      cloudflare: "Quick Tunnel",
      "cloudflare-named": "Cloudflare Named Tunnel",
      "nip-io": "Direct nip.io",
      direct: "Direct HTTPS",
      local: "Local only",
      serve: "Local only",
      none: "Local only",
    };
    return labels[currentState.hostingMode] || currentState.hostingMode || "Not configured";
  }

  function managedStateLabel(value) {
    const labels = {
      active: "Active",
      inactive: "Stopped",
      enabled: "Enabled",
      disabled: "Disabled",
      failed: "Error",
      missing: "Missing",
      unknown: "Needs verification",
      "not-managed": "Not managed",
    };
    return labels[value] || statusLabel(value);
  }

  function statusLabel(value) {
    const normalized = asText(value).toLowerCase();
    const labels = {
      loading: "Loading",
      stopped: "Stopped",
      idle: "Waiting",
      starting: "Starting",
      stopping: "Stopping",
      restarting: "Restarting",
      initializing: "Initializing",
      connecting: "Connecting",
      waiting: "Waiting",
      cancelling: "Stopping",
      completed: "Completed",
      stop_failed: "Stop failed",
      running: "Running",
      online: "Online",
      ready: "Ready",
      serving: "Serving",
      error: "Error",
      failed: "Failed",
      exited: "Exited",
      unavailable: "Not available",
      offline: "Offline",
    };
    return labels[normalized] || (normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Unknown");
  }

  function normalizeLogs(value) {
    const raw = typeof value === "string" ? value.split(/\r?\n/) : (Array.isArray(value) ? value : []);
    return raw.slice(-100).flatMap(function (entry) {
      if (typeof entry === "string" || typeof entry === "number") {
        const message = cleanText(entry, 4000).trimEnd();
        return message ? [{ time: "", level: inferLogLevel(message), message: message }] : [];
      }
      if (!isRecord(entry)) return [];
      const message = cleanText(entry.message || entry.text || entry.data, 4000).trimEnd();
      if (!message) return [];
      const rawLevel = asText(entry.level, inferLogLevel(message)).toLowerCase();
      const level = ["error", "warning", "info", "success", "debug"].includes(rawLevel) ? rawLevel : (rawLevel === "warn" ? "warning" : "info");
      return [{ time: formatTime(entry.timestamp || entry.time || entry.createdAt), level: level, message: message }];
    });
  }

  function inferLogLevel(message) {
    const normalized = message.toLowerCase();
    if (/\b(error|failed|fatal|denied)\b/.test(normalized)) return "error";
    if (/\b(warn|warning|attention)\b/.test(normalized)) return "warning";
    if (/\b(ready|started|connected|success|created)\b/.test(normalized)) return "success";
    return "info";
  }

  function compactPath(value) {
    if (!value) return "No folder open";
    const parts = value.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || value;
  }

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return cleanText(value, 20);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? cleanText(value, 100) : date.toLocaleString();
  }

  function normalizeVersion(value) {
    const normalized = asText(value).trim();
    return normalized.startsWith("v") ? normalized.slice(1) : normalized;
  }

  function errorMessage(value) {
    if (!value) return "";
    if (typeof value === "string") return cleanText(value, 1000);
    if (isRecord(value)) return cleanText(value.message || value.error || value.detail, 1000);
    return cleanText(value, 1000);
  }

  function announce(message) {
    if (!refs.liveRegion) return;
    refs.liveRegion.textContent = "";
    window.setTimeout(function () { refs.liveRegion.textContent = message; }, 20);
  }

  initialize();
})();
