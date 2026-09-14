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
    selectedTaskId: text(storedUi && storedUi.selectedTaskId, 256),
    boardScrollLeft: integer(storedUi && storedUi.boardScrollLeft),
  };
  let currentState = normalizeState({});
  let lastSignature = "";

  window.addEventListener("message", function (event) {
    const message = event.data;
    if (!message || message.type !== "state") return;
    currentState = normalizeState(message.state);
    const signature = JSON.stringify(currentState);
    if (signature === lastSignature) return;
    lastSignature = signature;
    render();
  });

  if (root) {
    root.addEventListener("click", function (event) {
      const selected = event.target instanceof Element ? event.target.closest("[data-task-select]") : null;
      if (selected) {
        const taskId = selected.getAttribute("data-task-select") || "";
        uiState.selectedTaskId = uiState.selectedTaskId === taskId ? "" : taskId;
        vscode.setState(uiState);
        render();
        return;
      }
      const target = event.target instanceof Element ? event.target.closest("[data-command]") : null;
      if (!target || target.hasAttribute("disabled") || currentState.operation) return;
      const command = target.getAttribute("data-command");
      if (!command) return;
      const message = { type: "command", command: command };
      const taskId = target.getAttribute("data-task-id");
      const revision = Number(target.getAttribute("data-task-revision"));
      if (taskId) message.taskId = taskId;
      if (Number.isSafeInteger(revision) && revision > 0) message.revision = revision;
      vscode.postMessage(message);
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
    const externalMcp = record(source.externalMcp);
    const collaboration = record(source.collaboration);
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
      operation: text(source.operation, 160),
      runtimeMode: source.runtimeMode === "collaboration" ? "collaboration" : "single",
      hostingMode: text(source.hostingMode, 80).toLowerCase(),
      unsafeFullAccess: source.unsafeFullAccess === true,
      mcpUrl: text(source.mcpUrl, 4096),
      publicUrl: text(source.publicUrl, 4096),
      externalMcp: {
        configured: externalMcp.configured === true,
        authorized: externalMcp.authorized === true,
        connected: externalMcp.connected === true,
        active: externalMcp.active === true,
        activeSessions: integer(externalMcp.activeSessions),
      },
      collaboration: {
        status: ["ready", "stale", "error"].includes(text(collaboration.status, 20)) ? text(collaboration.status, 20) : "error",
        tasks: Array.isArray(collaboration.tasks) ? collaboration.tasks.slice(0, 200).map(normalizeTask).filter(Boolean) : [],
        participants: Array.isArray(collaboration.participants) ? collaboration.participants.slice(0, 100).map(normalizeParticipant).filter(Boolean) : [],
        refreshedAt: text(collaboration.refreshedAt, 80),
        sourceTimestamp: text(collaboration.sourceTimestamp, 80),
        error: text(collaboration.error, 800),
      },
      version: text(source.version, 80),
      nodeVersion: text(source.nodeVersion, 80),
      error: text(source.error, 1200),
    };
  }

  function normalizeTask(value) {
    const source = record(value);
    const taskId = text(source.taskId, 256);
    const title = text(source.title, 256);
    const status = text(source.status, 40);
    const priority = text(source.priority, 10);
    const risk = text(source.risk, 20);
    const revision = integer(source.revision);
    if (!taskId || !title || !["open", "working", "input_required", "completed", "failed", "cancelled"].includes(status) ||
        !["P0", "P1", "P2", "P3"].includes(priority) || !["low", "medium", "high"].includes(risk) || revision < 1) return null;
    const actions = record(source.actions);
    return {
      taskId: taskId,
      title: title,
      details: text(source.details, 8192),
      status: status,
      statusMessage: text(source.statusMessage, 8192),
      artifact: text(source.artifact, 16384),
      priority: priority,
      dependencies: Array.isArray(source.dependencies) ? source.dependencies.slice(0, 50).map(function (value) {
        const dependency = record(value);
        const dependencyTaskId = text(dependency.taskId, 256);
        const condition = text(dependency.condition, 20);
        return dependencyTaskId && (condition === "completed" || condition === "terminal")
          ? { taskId: dependencyTaskId, condition: condition }
          : null;
      }).filter(Boolean) : [],
      eligibleRoleIds: stringArray(source.eligibleRoleIds, 20, 128),
      requiredCapabilities: stringArray(source.requiredCapabilities, 20, 128),
      risk: risk,
      notBefore: text(source.notBefore, 80),
      createdBy: text(source.createdBy, 100),
      createdBySessionId: text(source.createdBySessionId, 256),
      owner: text(source.owner, 100),
      ownerSessionId: text(source.ownerSessionId, 256),
      ownerRoleId: text(source.ownerRoleId, 128),
      ownerRoleLabel: text(source.ownerRoleLabel, 128),
      leaseExpiresAt: text(source.leaseExpiresAt, 80),
      createdAt: text(source.createdAt, 80),
      updatedAt: text(source.updatedAt, 80),
      revision: revision,
      actions: {
        provideInput: actions.provideInput === true,
        cancel: actions.cancel === true,
        release: actions.release === true,
      },
    };
  }

  function normalizeParticipant(value) {
    const source = record(value);
    const collaborationSessionId = text(source.collaborationSessionId, 256);
    const agentName = text(source.agentName, 100);
    const canonicalRoleId = text(source.canonicalRoleId, 128);
    const occupancyLabel = text(source.occupancyLabel, 128);
    const lifecycle = text(source.lifecycle, 40);
    const revision = integer(source.revision);
    if (!collaborationSessionId || !agentName || !canonicalRoleId || !occupancyLabel ||
        !["working", "waiting_for_task", "offline", "released"].includes(lifecycle) || revision < 1) return null;
    return {
      collaborationSessionId: collaborationSessionId,
      agentName: agentName,
      canonicalRoleId: canonicalRoleId,
      occupancyLabel: occupancyLabel,
      lifecycle: lifecycle,
      updatedAt: text(source.updatedAt, 80),
      revision: revision,
    };
  }

  function render() {
    if (!root) return;
    const boardBefore = root.querySelector(".kanban");
    if (boardBefore) uiState.boardScrollLeft = Math.max(0, Math.floor(boardBefore.scrollLeft));
    const focusedTaskId = document.activeElement instanceof Element
      ? document.activeElement.getAttribute("data-task-select") || ""
      : "";
    const pageScrollY = window.scrollY;
    const shell = el("main", "shell");
    shell.appendChild(renderHeader());
    if (!currentState.trustKnown) shell.appendChild(renderLoading());
    else if (!currentState.trusted) shell.appendChild(renderTrustGate());
    else {
      shell.appendChild(renderPrimaryCard());
      if (currentState.error) shell.appendChild(renderError(currentState.error));
      if (currentState.unsafeFullAccess) shell.appendChild(renderFullAccessNotice());
      if (currentState.runtimeMode === "collaboration") {
        shell.appendChild(renderCollaborationNotice());
        shell.appendChild(renderCollaborationBoard());
      }
      if (isExternalRuntime()) shell.appendChild(renderExternalRuntimeNotice());
      shell.appendChild(renderAdvanced());
    }
    shell.appendChild(renderFooter());
    root.replaceChildren(shell);
    const boardAfter = root.querySelector(".kanban");
    if (boardAfter) boardAfter.scrollLeft = uiState.boardScrollLeft || 0;
    if (focusedTaskId) {
      const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(focusedTaskId) : focusedTaskId.replace(/[^A-Za-z0-9_.:@-]/g, "");
      const focused = root.querySelector(`[data-task-select="${escaped}"]`);
      if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    }
    window.scrollTo({ top: pageScrollY });
    vscode.setState(uiState);
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
    card.appendChild(el("h2", "primary-card__title", "Trust this project to use PiLink"));
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
        actions.appendChild(commandButton(action.label, action.command, action.variant));
      });
      card.appendChild(actions);
    }
    if (model.note) card.appendChild(el("p", "primary-card__note", model.note));
    card.appendChild(renderStatusGrid());
    return card;
  }

  function primaryModel() {
    if (currentState.operation) {
      return {
        eyebrow: "PILINK",
        title: currentState.operation + "…",
        description: "This operation is in progress. PiLink disables other state-changing actions until it finishes.",
        tone: "progress",
        badge: { label: "Working", tone: "progress" },
        actions: [],
      };
    }

    if (!currentState.configured) {
      if (!currentState.workspace) {
        return {
          eyebrow: "FIRST RUN",
          title: "Choose the project PiLink may access",
          description: "Pick the folder to expose through MCP. PiLink keeps private credentials and runtime state outside that project.",
          badge: { label: "Not configured", tone: "neutral" },
          actions: [{ label: "Choose project folder", command: "chooseWorkspace", variant: "primary" }],
        };
      }
      return {
        eyebrow: "FIRST RUN",
        title: "Start PiLink for this project",
        description: "The graphical path always uses the single-agent toolset and confines file access to this project.",
        badge: { label: "Safe default", tone: "success" },
        actions: [
          { label: "Set up stable endpoint", command: "setupStable", variant: "primary" },
          { label: "Temporary quick start", command: "setupQuick", variant: "secondary" },
          { label: "Local only", command: "setupLocal", variant: "ghost" },
        ],
        note: "Stable hosting is recommended for ChatGPT. Quick Tunnel is temporary and gets a new URL when recreated.",
      };
    }

    const online = isOnline();
    const external = isExternalRuntime();
    if (currentState.unsafeFullAccess) {
      if (online && external) {
        return {
          eyebrow: "SAFETY CHECK",
          title: "External Full-access PiLink detected",
          description: "This instance was started outside VS Code with unrestricted machine access. VS Code will monitor it but will not take ownership or change its configuration.",
          tone: "warning",
          badge: { label: "Full access · external", tone: "danger" },
          actions: [{ label: "Open config", command: "openConfig", variant: "ghost" }],
          note: "Stop or reconfigure this instance using the CLI or service manager that started it.",
        };
      }
      return {
        eyebrow: "SAFETY CHECK",
        title: online ? "Full machine access is running" : "Full machine access is saved",
        description: online
          ? "This configuration is outside the normal graphical workflow. Stop it before returning to project-folder access."
          : "PiLink will not start a saved Full-access configuration from the graphical workflow.",
        tone: "warning",
        badge: { label: "Full access", tone: "danger" },
        actions: online
          ? [{ label: "Stop PiLink", command: "stop", variant: "primary" }]
          : [
              { label: "Reconfigure safely…", command: "reconfigure", variant: "primary" },
              { label: "Open config", command: "openConfig", variant: "ghost" },
            ],
        note: "Unrestricted machine access remains an explicit PiLink CLI/operator workflow.",
      };
    }

    if (!online) {
      return {
        eyebrow: "MCP BRIDGE",
        title: "PiLink is stopped",
        description: "This project is configured. Start the bridge to make its MCP endpoint available again.",
        badge: { label: "Stopped", tone: "neutral" },
        actions: [
          { label: "Start PiLink", command: "start", variant: "primary" },
          { label: "Reconfigure…", command: "reconfigure", variant: "secondary" },
        ],
      };
    }

    if (!isPublicEndpoint()) {
      return {
        eyebrow: "MCP BRIDGE",
        title: external ? "PiLink is already running locally" : "PiLink is running locally",
        description: external
          ? "VS Code detected a PiLink instance started elsewhere. It can monitor it, but it will not take ownership of that process."
          : "The bridge is healthy on this machine. ChatGPT Work needs a public HTTPS endpoint to reach it.",
        badge: { label: external ? "Detected" : "Local", tone: "success" },
        actions: external
          ? []
          : [
              { label: "Configure remote endpoint", command: "setupStable", variant: "primary" },
              { label: "Stop", command: "stop", variant: "secondary" },
            ],
      };
    }

    if (!currentState.externalMcp.configured) {
      return {
        eyebrow: "REMOTE MCP",
        title: "PiLink is online",
        description: "The HTTPS MCP endpoint is reachable. Connect ChatGPT when you want it to use this project.",
        badge: { label: "Endpoint ready", tone: "success" },
        actions: [
          { label: "Connect ChatGPT", command: "connectChatGpt", variant: "primary" },
          { label: "Copy MCP URL", command: "copyMcpUrl", variant: "secondary" },
          ...(!external ? [{ label: "Stop", command: "stop", variant: "ghost" }] : []),
        ],
      };
    }

    if (!currentState.externalMcp.connected) {
      return {
        eyebrow: "REMOTE MCP",
        title: "Finish connecting ChatGPT",
        description: "A ChatGPT OAuth client exists, but authorization is unfinished. Continue the existing connection instead of creating another one.",
        badge: { label: "Authorization pending", tone: "warning" },
        actions: [
          { label: "Continue connection", command: "connectChatGpt", variant: "primary" },
          ...(!external ? [{ label: "Stop", command: "stop", variant: "secondary" }] : []),
        ],
      };
    }

    if (currentState.externalMcp.active) {
      const sessions = currentState.externalMcp.activeSessions;
      return {
        eyebrow: "REMOTE MCP",
        title: "ChatGPT is connected",
        description: "An authenticated MCP session is active. Keep working in ChatGPT Work; this panel only manages and monitors the bridge.",
        badge: { label: sessions ? sessions + " active" : "Connected", tone: "success" },
        actions: [
          { label: "Open ChatGPT Work", command: "openChatGpt", variant: "primary" },
          ...(!external ? [{ label: "Stop PiLink", command: "stop", variant: "secondary" }] : []),
        ],
      };
    }

    return {
      eyebrow: "REMOTE MCP",
      title: "PiLink is ready",
      description: "OAuth is authorized and saved. ChatGPT will open an MCP session when it actually needs PiLink tools.",
      badge: { label: "OAuth ready", tone: "success" },
      actions: [
        { label: "Open ChatGPT Work", command: "openChatGpt", variant: "primary" },
        { label: "Copy MCP URL", command: "copyMcpUrl", variant: "secondary" },
        ...(!external ? [{ label: "Stop", command: "stop", variant: "ghost" }] : []),
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

  function renderError(message) {
    const notice = el("section", "notice notice--error");
    const body = el("div", "notice__body");
    body.appendChild(el("strong", "notice__title", "PiLink needs attention"));
    body.appendChild(el("p", "notice__copy", message));
    notice.appendChild(body);
    notice.appendChild(commandButton("Refresh", "refresh", "secondary"));
    return notice;
  }

  function renderFullAccessNotice() {
    const notice = el("section", "notice notice--error");
    const body = el("div", "notice__body");
    body.appendChild(el("strong", "notice__title", "Full access is not part of the normal VS Code workflow"));
    body.appendChild(el("p", "notice__copy", "Full access removes the project boundary and permits general process execution as the PiLink OS user."));
    notice.appendChild(body);
    return notice;
  }

  function renderCollaborationBoard() {
    const board = currentState.collaboration;
    const section = el("section", "section-card collaboration-board");
    section.setAttribute("aria-labelledby", "collaboration-board-title");
    const header = el("div", "section-card__header");
    const copy = el("div", "");
    copy.appendChild(el("div", "eyebrow", "MULTI-AGENT CONTROL ROOM"));
    const title = el("h2", "section-card__title", "Collaboration task board");
    title.id = "collaboration-board-title";
    copy.appendChild(title);
    copy.appendChild(el("p", "section-card__hint", participantSummary(board.participants)));
    header.appendChild(copy);
    const controls = el("div", "board-controls");
    controls.appendChild(chip(board.status === "ready" ? "Live" : board.status === "stale" ? "Stale" : "Unavailable", board.status === "ready" ? "success" : board.status === "stale" ? "warning" : "danger"));
    const createButton = commandButton("Create task", "createTask", "primary");
    if (board.status !== "ready") createButton.disabled = true;
    controls.appendChild(createButton);
    header.appendChild(controls);
    section.appendChild(header);

    if (board.status !== "ready") {
      const notice = el("div", "board-health board-health--" + board.status);
      notice.setAttribute("role", board.status === "error" ? "alert" : "status");
      notice.appendChild(el("strong", "", board.status === "stale" ? "Showing the last good task snapshot." : "Task board data is unavailable."));
      if (board.error) notice.appendChild(el("span", "", " " + board.error));
      section.appendChild(notice);
    }

    const kanban = el("div", "kanban");
    kanban.setAttribute("role", "region");
    kanban.setAttribute("aria-label", "Canonical collaboration tasks");
    kanban.tabIndex = 0;
    const definitions = [
      { id: "open", label: "Open / Ready" },
      { id: "working", label: "Working" },
      { id: "blocked", label: "Needs input / Blocked" },
      { id: "done", label: "Done / Failed" },
    ];
    definitions.forEach(function (definition) {
      const tasks = board.tasks.filter(function (task) { return taskColumn(task, board.tasks) === definition.id; });
      kanban.appendChild(renderKanbanColumn(definition.id, definition.label, tasks));
    });
    section.appendChild(kanban);
    section.appendChild(renderParticipantRoster(board.participants));
    section.appendChild(el("p", "section-card__hint", "This board shows authoritative durable collaboration tasks. Local supervised-agent operations are a separate runtime surface and are not merged into these columns. Worker release is a separate manager-authorized lifecycle action, not task cancellation."));
    return section;
  }

  function renderParticipantRoster(participants) {
    const roster = el("section", "participant-roster");
    roster.setAttribute("aria-label", "Collaboration worker lifecycle");
    const header = el("div", "participant-roster__header");
    header.appendChild(el("h3", "participant-roster__title", "Workers"));
    header.appendChild(el("span", "participant-roster__hint", "Durable lifecycle"));
    roster.appendChild(header);
    const list = el("div", "participant-list");
    if (!participants.length) list.appendChild(el("p", "kanban-empty", "No registered workers"));
    participants.forEach(function (participant) {
      const row = el("div", "participant-row");
      const identity = el("div", "participant-row__identity");
      identity.appendChild(el("strong", "", participant.occupancyLabel || participant.agentName));
      identity.appendChild(el("span", "participant-row__meta", participant.canonicalRoleId + " · " + shortId(participant.collaborationSessionId)));
      row.appendChild(identity);
      const lifecycle = participant.lifecycle === "waiting_for_task" ? "Waiting for task" :
        participant.lifecycle === "working" ? "Working" :
        participant.lifecycle === "released" ? "Released" : "Offline";
      row.appendChild(chip(lifecycle, participant.lifecycle === "working" ? "success" : participant.lifecycle === "waiting_for_task" ? "warning" : participant.lifecycle === "released" ? "danger" : "neutral"));
      list.appendChild(row);
    });
    roster.appendChild(list);
    return roster;
  }

  function renderKanbanColumn(id, label, tasks) {
    const column = el("section", "kanban-column kanban-column--" + id);
    const heading = el("div", "kanban-column__header");
    heading.appendChild(el("h3", "kanban-column__title", label));
    heading.appendChild(chip(String(tasks.length), "neutral"));
    column.appendChild(heading);
    const body = el("div", "kanban-column__body");
    if (!tasks.length) body.appendChild(el("p", "kanban-empty", "No tasks"));
    tasks.forEach(function (task) { body.appendChild(renderTaskCard(task)); });
    column.appendChild(body);
    return column;
  }

  function renderTaskCard(task) {
    const selected = uiState.selectedTaskId === task.taskId;
    const card = el("article", "task-card" + (selected ? " task-card--selected" : ""));
    card.dataset.taskId = task.taskId;
    const summary = document.createElement("button");
    summary.type = "button";
    summary.className = "task-card__summary";
    summary.dataset.taskSelect = task.taskId;
    summary.setAttribute("aria-expanded", selected ? "true" : "false");
    summary.setAttribute("aria-label", `${task.title}. ${taskStatusLabel(task)}. ${dependencyLabel(task)}.`);
    const top = el("span", "task-card__top");
    top.appendChild(el("span", "task-card__title", task.title));
    top.appendChild(chip(task.priority, task.priority === "P0" ? "danger" : task.priority === "P1" ? "warning" : "neutral"));
    summary.appendChild(top);
    const compact = el("span", "task-card__compact");
    compact.appendChild(el("span", "", taskStatusLabel(task)));
    compact.appendChild(el("span", "", dependencyLabel(task)));
    summary.appendChild(compact);
    card.appendChild(summary);

    if (selected) {
      const details = el("div", "task-card__details");
      if (task.details) details.appendChild(el("p", "task-card__description", task.details));
      const grid = el("dl", "task-detail-grid");
      taskDetailRow(grid, "Task ID", task.taskId);
      taskDetailRow(grid, "Owner", task.owner || "Unassigned");
      if (task.ownerSessionId) taskDetailRow(grid, "Session", shortId(task.ownerSessionId));
      if (task.ownerRoleLabel || task.ownerRoleId) taskDetailRow(grid, "Role", task.ownerRoleLabel || task.ownerRoleId);
      taskDetailRow(grid, "Priority / risk", `${task.priority} · ${task.risk}`);
      taskDetailRow(grid, "Dependencies", dependencyDetail(task));
      if (task.eligibleRoleIds.length) taskDetailRow(grid, "Eligible roles", task.eligibleRoleIds.join(", "));
      if (task.requiredCapabilities.length) taskDetailRow(grid, "Capabilities", task.requiredCapabilities.join(", "));
      taskDetailRow(grid, "Lease", task.leaseExpiresAt ? leaseLabel(task.leaseExpiresAt) : "No active lease");
      taskDetailRow(grid, "Updated", timeLabel(task.updatedAt));
      if (task.statusMessage) taskDetailRow(grid, "Status", task.statusMessage);
      if (task.artifact) taskDetailRow(grid, "Artifact", task.artifact);
      details.appendChild(grid);
      if (task.actions.provideInput || task.actions.cancel) {
        const actions = el("div", "button-row");
        if (task.actions.provideInput) actions.appendChild(taskCommandButton("Provide input", "provideTaskInput", "primary", task));
        if (task.actions.cancel) actions.appendChild(taskCommandButton("Cancel task", "cancelTask", "secondary", task));
        details.appendChild(actions);
      }
      card.appendChild(details);
    }
    return card;
  }

  function taskDetailRow(list, label, value) {
    const row = el("div", "task-detail-grid__row");
    row.appendChild(el("dt", "task-detail-grid__label", label));
    row.appendChild(el("dd", "task-detail-grid__value", value));
    list.appendChild(row);
  }

  function taskColumn(task, tasks) {
    if (task.status === "working") return "working";
    if (task.status === "input_required") return "blocked";
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return "done";
    if (dependencyLabelForTasks(task, tasks) !== "Ready") return "blocked";
    if (task.notBefore && Date.parse(task.notBefore) > Date.now()) return "blocked";
    return "open";
  }

  function taskStatusLabel(task) {
    const labels = {
      open: "Open",
      working: "Working",
      input_required: "Needs input",
      completed: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
    };
    return labels[task.status] || task.status;
  }

  function dependencyLabel(task) {
    return dependencyLabelForTasks(task, currentState.collaboration.tasks);
  }

  function dependencyLabelForTasks(task, tasks) {
    if (!task.dependencies.length) return task.status === "open" ? "Ready" : "No blockers";
    const byId = new Map(tasks.map(function (candidate) { return [candidate.taskId, candidate]; }));
    const unsatisfied = task.dependencies.filter(function (dependency) {
      const candidate = byId.get(dependency.taskId);
      if (!candidate) return true;
      return dependency.condition === "completed"
        ? candidate.status !== "completed"
        : !["completed", "failed", "cancelled"].includes(candidate.status);
    });
    return unsatisfied.length ? `${unsatisfied.length} blocker${unsatisfied.length === 1 ? "" : "s"}` : "Ready";
  }

  function dependencyDetail(task) {
    if (!task.dependencies.length) return "None";
    return task.dependencies.map(function (dependency) {
      return `${shortId(dependency.taskId)} (${dependency.condition})`;
    }).join(", ");
  }

  function participantSummary(participants) {
    if (!participants.length) return "Durable coordination state · no registered workers";
    const active = participants.filter(function (participant) { return participant.lifecycle === "working"; }).length;
    const waiting = participants.filter(function (participant) { return participant.lifecycle === "waiting_for_task"; }).length;
    return `${participants.length} workers · ${active} working · ${waiting} waiting`;
  }

  function leaseLabel(value) {
    const milliseconds = Date.parse(value) - Date.now();
    if (!Number.isFinite(milliseconds)) return "Unknown";
    if (milliseconds <= 0) return "Expired";
    const minutes = Math.max(1, Math.ceil(milliseconds / 60000));
    return `${minutes}m remaining`;
  }

  function timeLabel(value) {
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) return value || "Unknown";
    const delta = Math.max(0, Date.now() - milliseconds);
    const minutes = Math.floor(delta / 60000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(milliseconds).toLocaleString();
  }

  function shortId(value) {
    if (!value) return "";
    return value.length > 18 ? value.slice(0, 9) + "…" + value.slice(-6) : value;
  }

  function renderCollaborationNotice() {
    const notice = el("section", "notice notice--info");
    const body = el("div", "notice__body");
    body.appendChild(el("strong", "notice__title", "Collaboration mode is active"));
    body.appendChild(el("p", "notice__copy", "The control room below reads canonical durable coordination state. Task ownership and scheduling decisions remain server-authoritative."));
    notice.appendChild(body);
    if (!isExternalRuntime()) notice.appendChild(commandButton("Switch to single-agent", "switchToSingle", "secondary"));
    return notice;
  }

  function renderExternalRuntimeNotice() {
    const notice = el("section", "notice notice--info");
    const body = el("div", "notice__body");
    body.appendChild(el("strong", "notice__title", "PiLink was started outside VS Code"));
    body.appendChild(el("p", "notice__copy", "This extension will monitor the detected service but will not stop, restart, or reconfigure a process it does not own. Use the launcher or service manager that started it."));
    notice.appendChild(body);
    return notice;
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
    detailRow(info, "Process", isExternalRuntime() ? "Detected outside VS Code" : currentState.process.mode || (isOnline() ? "Managed by VS Code" : "Stopped"));
    detailRow(info, "MCP endpoint", currentState.mcpUrl ? compactUrl(currentState.mcpUrl) : "Not available");
    body.appendChild(info);

    const actions = el("div", "button-row");
    if (isOnline() && !isExternalRuntime()) actions.appendChild(commandButton("Restart", "restart", "secondary"));
    if (isOnline() && !isExternalRuntime()) actions.appendChild(commandButton("Stop", "stop", "secondary"));
    if (!isExternalRuntime()) actions.appendChild(commandButton("Reconfigure endpoint…", "reconfigure", "secondary"));
    if (currentState.mcpUrl) actions.appendChild(commandButton("Copy MCP URL", "copyMcpUrl", "ghost"));
    actions.appendChild(commandButton("Open config", "openConfig", "ghost"));
    if (!isExternalRuntime()) actions.appendChild(commandButton("Show terminal", "openTerminal", "ghost"));
    actions.appendChild(commandButton("Open guide", "openDocs", "ghost"));
    body.appendChild(actions);
    body.appendChild(el("p", "advanced-section__hint", "Local model-provider chat, native VS Code MCP, manual OAuth clients, collaboration enablement, and Full-access launch are intentionally not part of the ordinary graphical workflow."));
    details.appendChild(body);
    return details;
  }

  function renderFooter() {
    const footer = el("footer", "footer");
    footer.appendChild(el("span", "", currentState.version ? "PiLink " + currentState.version : "PiLink"));
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
    if (currentState.operation) return { label: "Working", tone: "warning" };
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
    if (isExternalRuntime()) return "Running · external";
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

  function commandButton(label, command, variant) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button--" + (variant || "secondary");
    button.textContent = label;
    button.dataset.command = command;
    if (currentState.operation) button.disabled = true;
    return button;
  }

  function taskCommandButton(label, command, variant, task) {
    const button = commandButton(label, command, variant);
    button.dataset.taskId = task.taskId;
    button.dataset.taskRevision = String(task.revision);
    if (currentState.collaboration.status !== "ready") button.disabled = true;
    return button;
  }

  function isOnline() {
    return currentState.process.status === "running" || currentState.process.status === "starting";
  }

  function isExternalRuntime() {
    return isOnline() && currentState.process.mode.toLowerCase() === "detected service";
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
    if (!currentState.workspace) return "VS Code MCP launcher";
    const parts = currentState.workspace.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || currentState.workspace;
  }

  function hostingLabel(kind) {
    const labels = {
      "quick-tunnel": "Quick Tunnel (temporary)",
      "cloudflare-fixed": "Cloudflare fixed domain",
      "cloudflare-named": "Legacy managed Named Tunnel",
      "external": "Existing HTTPS domain",
      "custom-domain": "Existing HTTPS domain",
      "nip-io": "Legacy nip.io",
      "local": "Local only",
      "not configured": "Not configured",
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

  function chip(label, tone) {
    return el("span", "chip chip--" + (tone || "neutral"), label);
  }

  function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function integer(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function stringArray(value, maximumItems, maximumText) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, maximumItems).map(function (candidate) { return text(candidate, maximumText); }).filter(Boolean);
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
