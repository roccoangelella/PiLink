import assert from "node:assert/strict";
import test from "node:test";
import { WizardController, validateCallbackUrl } from "../src/wizard-controller.js";
import { WizardStateStore, WIZARD_STATE_KEY, wizardViewState } from "../src/wizard-state.js";

class MemoryMemento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  update(key: string, value: unknown): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
}

test("advanced MCP setup never opens a client automatically and keeps secrets out of state", async () => {
  const events: string[] = [];
  const memento = new MemoryMemento();
  const controller = new WizardController(new WizardStateStore(memento), {
    selectWorkspace: async () => "/selected",
    selectCloudflareCredential: async () => undefined,
    confirmFullAccess: async () => true,
    provision: async () => { events.push("provision"); return { configPath: "/private/.env" }; },
    start: async () => { events.push("start"); return { configPath: "/private/.env", publicUrl: "https://mcp.example.test", mcpUrl: "https://mcp.example.test/sse" }; },
    pairOwner: async (destination) => { events.push(`pair:${destination}`); return true; },
    openChatGpt: async (destination) => { events.push(`open:${destination}`); },
    copyText: async (value) => { events.push(`copy:${value}`); },
    registerChatGpt: async (callbackUrl) => {
      events.push(`register:${callbackUrl}`);
      return {
        clientId: "public-client-id",
        clientName: "External MCP client",
        redirectUris: [callbackUrl],
        grantTypes: ["authorization_code", "refresh_token"],
        scope: "mcp:tools offline_access",
        tokenEndpointAuthMethod: "client_secret_post",
        createdAt: "2026-08-03T00:00:00.000Z",
        hasSecret: true,
      };
    },
    credentialValue: async (field) => field === "clientSecret" ? "vault-only-secret" : undefined,
    onDidChange: () => undefined,
  }, "/workspace");

  await controller.open("/workspace");
  await controller.handle({ type: "wizard", action: "acceptWorkspace", requestId: "1" });
  await controller.handle({
    type: "wizard",
    action: "configureAndStart",
    requestId: "2",
    hosting: { kind: "quick-tunnel" },
    accessMode: "workspace",
  });
  assert.deepEqual(events, ["provision", "start"]);
  assert.equal(events.some((event) => event.startsWith("copy:")), false, "automatic navigation must not copy without a gesture");
  assert.equal(controller.viewState.phase, "callback");
  assert.equal(controller.currentState.appliedHosting?.kind, "quick-tunnel");
  assert.equal(controller.currentState.appliedConfigPath, "/private/.env");
  await controller.handle({ type: "wizard", action: "openChatGpt", requestId: "security", destination: "security" });
  assert.deepEqual(events, ["provision", "start", "pair:security"]);
  assert.equal(controller.viewState.developerModeConfirmed, false);
  await controller.handle({ type: "wizard", action: "confirmDeveloperMode", requestId: "confirm-dev" });
  assert.deepEqual(events, ["provision", "start", "pair:security", "pair:plugins"]);
  assert.equal(controller.viewState.developerModeConfirmed, true);
  await controller.handle({ type: "wizard", action: "dismiss", requestId: "dismiss" });
  assert.equal(controller.viewState.active, false);
  await controller.open("/different-workspace");
  assert.equal(controller.viewState.phase, "callback");
  assert.equal(controller.viewState.workspace, "/workspace");

  await controller.handle({
    type: "wizard",
    action: "submitCallback",
    requestId: "3",
    callbackUrl: "https://client.example/oauth/callback",
  });
  assert.equal(controller.viewState.phase, "credentials");
  assert.equal(controller.viewState.credential?.clientId, "public-client-id");
  assert.equal(JSON.stringify(controller.viewState).includes("vault-only-secret"), false);
  assert.equal(JSON.stringify(memento.values.get(WIZARD_STATE_KEY)).includes("vault-only-secret"), false);

  await controller.handle({ type: "wizard", action: "copyCredential", requestId: "4", field: "clientSecret" });
  assert.equal(events.at(-1), "copy:vault-only-secret");
  await controller.noteChatGptConnected();
  assert.equal(controller.viewState.chatGptConnected, true);
  assert.equal(controller.viewState.phase, "complete");
  assert.equal(controller.viewState.completed, true);

  const restored = new WizardController(new WizardStateStore(memento), {
    selectWorkspace: async () => undefined,
    selectCloudflareCredential: async () => undefined,
    confirmFullAccess: async () => false,
    provision: async () => ({ configPath: "" }),
    start: async () => ({ configPath: "", publicUrl: "", mcpUrl: "" }),
    pairOwner: async () => false,
    openChatGpt: async () => undefined,
    copyText: async () => undefined,
    registerChatGpt: async () => { throw new Error("unused"); },
    credentialValue: async () => undefined,
    onDidChange: () => undefined,
  });
  assert.equal(restored.viewState.phase, "complete");
  assert.equal(restored.viewState.credential?.clientId, "public-client-id");
});

test("local wizard completes without pairing or opening ChatGPT", async () => {
  let browserCalls = 0;
  const controller = new WizardController(new WizardStateStore(new MemoryMemento()), {
    selectWorkspace: async () => undefined,
    selectCloudflareCredential: async () => undefined,
    confirmFullAccess: async () => true,
    provision: async () => ({ configPath: "/private/.env" }),
    start: async () => ({ configPath: "/private/.env", publicUrl: "http://127.0.0.1:3200", mcpUrl: "http://127.0.0.1:3200/sse" }),
    pairOwner: async () => { browserCalls += 1; return false; },
    openChatGpt: async () => { browserCalls += 1; },
    copyText: async () => undefined,
    registerChatGpt: async () => { throw new Error("unused"); },
    credentialValue: async () => undefined,
    onDidChange: () => undefined,
  }, "/workspace");
  await controller.open("/workspace");
  await controller.handle({ type: "wizard", action: "acceptWorkspace", requestId: "1" });
  await controller.handle({ type: "wizard", action: "configureAndStart", requestId: "2", hosting: { kind: "local" }, accessMode: "workspace" });
  assert.equal(controller.viewState.phase, "complete");
  assert.equal(controller.viewState.completed, true);
  assert.equal(browserCalls, 0);
});

test("OAuth callbacks require HTTPS except for loopback HTTP", () => {
  assert.equal(validateCallbackUrl("https://chatgpt.com/callback"), "https://chatgpt.com/callback");
  assert.equal(validateCallbackUrl("http://127.0.0.1:4100/callback"), "http://127.0.0.1:4100/callback");
  assert.equal(validateCallbackUrl("http://localhost:4100/callback"), "http://localhost:4100/callback");
  assert.throws(() => validateCallbackUrl("http://example.test/callback"), /HTTPS/);
  assert.throws(() => validateCallbackUrl("file:///tmp/callback"), /HTTPS/);
});

test("persisted wizard state migrates the pre-connection-status schema conservatively", () => {
  const memento = new MemoryMemento();
  memento.values.set(WIZARD_STATE_KEY, {
    schemaVersion: 1,
    runId: "existing-run",
    revision: 7,
    seen: true,
    active: false,
    completed: false,
    phase: "hosting",
    workspace: "/workspace",
    accessMode: "workspace",
    chatGptPageOpened: false,
  });
  const state = new WizardStateStore(memento).load("/fallback");
  assert.equal(state.runId, "existing-run");
  assert.equal(state.phase, "hosting");
  assert.equal(state.chatGptConnected, false);
});

test("named hosting restores its opaque vault reference without sending it to the webview", () => {
  const memento = new MemoryMemento();
  const reference = "11111111-1111-4111-8111-111111111111";
  memento.values.set(WIZARD_STATE_KEY, {
    schemaVersion: 1,
    runId: "named-run",
    revision: 2,
    seen: true,
    active: false,
    completed: true,
    phase: "complete",
    workspace: "/workspace",
    accessMode: "workspace",
    chatGptPageOpened: true,
    chatGptConnected: true,
    hosting: {
      kind: "cloudflare-named",
      tunnelName: "customer-production",
      zoneName: "example.test",
      mcpHostname: "mcp.example.test",
      landingHostname: "vspilink.example.test",
      cloudflareAuthKind: "origin-certificate",
      credentialReference: reference,
      credentialLabel: "cloudflare-origin.pem",
    },
  });
  const restored = new WizardStateStore(memento).load();
  assert.equal(restored.hosting?.credentialReference, reference);
  const serializedView = JSON.stringify(wizardViewState(restored, true));
  assert.equal(serializedView.includes(reference), false);
  assert.equal(serializedView.includes("credentialReference"), false);
});

test("opening and dismissing a new setup preserves the last applied named tunnel", async () => {
  const memento = new MemoryMemento();
  const reference = "22222222-2222-4222-8222-222222222222";
  memento.values.set(WIZARD_STATE_KEY, {
    schemaVersion: 1,
    runId: "completed-run",
    revision: 8,
    seen: true,
    active: false,
    completed: true,
    phase: "complete",
    workspace: "/workspace",
    accessMode: "workspace",
    chatGptPageOpened: true,
    chatGptConnected: true,
    configPath: "/private/.env",
    hosting: {
      kind: "cloudflare-named",
      tunnelName: "customer-production",
      zoneName: "example.test",
      mcpHostname: "mcp.example.test",
      landingHostname: "vspilink.example.test",
      cloudflareAuthKind: "origin-certificate",
      credentialReference: reference,
      credentialLabel: "cloudflare-origin.pem",
    },
  });
  const controller = new WizardController(new WizardStateStore(memento), {
    selectWorkspace: async () => undefined,
    selectCloudflareCredential: async () => undefined,
    confirmFullAccess: async () => false,
    provision: async () => { throw new Error("unused"); },
    start: async () => { throw new Error("unused"); },
    pairOwner: async () => false,
    openChatGpt: async () => undefined,
    copyText: async () => undefined,
    registerChatGpt: async () => { throw new Error("unused"); },
    credentialValue: async () => undefined,
    onDidChange: () => undefined,
  });

  await controller.open("/workspace");
  assert.equal(controller.viewState.phase, "workspace");
  assert.equal(controller.currentState.appliedHosting?.kind, "cloudflare-named");
  assert.equal(controller.currentState.appliedHosting?.credentialReference, reference);
  assert.equal(controller.currentState.appliedConfigPath, "/private/.env");
  assert.equal(JSON.stringify(controller.viewState).includes(reference), false);

  await controller.handle({ type: "wizard", action: "dismiss", requestId: "dismiss" });
  assert.equal(controller.viewState.active, false);
  assert.equal(controller.currentState.appliedHosting?.credentialReference, reference);
});

test("resuming an existing public runtime does not open a client automatically", async () => {
  const events: string[] = [];
  const controller = new WizardController(new WizardStateStore(new MemoryMemento()), {
    selectWorkspace: async () => undefined,
    selectCloudflareCredential: async () => undefined,
    confirmFullAccess: async () => false,
    provision: async () => { throw new Error("hosting must not be repeated"); },
    start: async () => { throw new Error("runtime must not be restarted"); },
    pairOwner: async () => { events.push("pair"); return false; },
    openChatGpt: async (destination) => { events.push(`open:${destination}`); },
    copyText: async () => undefined,
    registerChatGpt: async () => { throw new Error("unused"); },
    credentialValue: async () => undefined,
    onDidChange: () => undefined,
  });

  await controller.resumeRuntime({
    workspace: "/workspace",
    configPath: "/private/.env",
    publicUrl: "https://mcp.example.test/",
    mcpUrl: "https://mcp.example.test/sse",
    hosting: { kind: "custom-domain", publicUrl: "https://mcp.example.test" },
  });

  assert.equal(controller.viewState.active, true);
  assert.equal(controller.viewState.phase, "callback");
  assert.equal(controller.viewState.mcpUrl, "https://mcp.example.test/sse");
  assert.deepEqual(events, []);
});

test("one-click onboarding marks an already connected runtime complete without reopening the browser", async () => {
  let browserCalls = 0;
  const controller = new WizardController(new WizardStateStore(new MemoryMemento()), {
    selectWorkspace: async () => undefined,
    selectCloudflareCredential: async () => undefined,
    confirmFullAccess: async () => false,
    provision: async () => { throw new Error("unused"); },
    start: async () => { throw new Error("unused"); },
    pairOwner: async () => { browserCalls += 1; return false; },
    openChatGpt: async () => { browserCalls += 1; },
    copyText: async () => undefined,
    registerChatGpt: async () => { throw new Error("unused"); },
    credentialValue: async () => undefined,
    onDidChange: () => undefined,
  });

  await controller.resumeRuntime({
    workspace: "/workspace",
    configPath: "/private/.env",
    publicUrl: "https://mcp.example.test",
    mcpUrl: "https://mcp.example.test/sse",
    chatGptConnected: true,
  });

  assert.equal(controller.viewState.phase, "complete");
  assert.equal(controller.viewState.completed, true);
  assert.equal(browserCalls, 0);
});

test("persistent OAuth recovery completes a callback-phase wizard even when SecretStorage state was lost", async () => {
  const memento = new MemoryMemento();
  const controller = new WizardController(new WizardStateStore(memento), {
    selectWorkspace: async () => undefined,
    selectCloudflareCredential: async () => undefined,
    confirmFullAccess: async () => false,
    provision: async () => { throw new Error("unused"); },
    start: async () => { throw new Error("unused"); },
    pairOwner: async () => false,
    openChatGpt: async () => undefined,
    copyText: async () => undefined,
    registerChatGpt: async () => { throw new Error("unused"); },
    credentialValue: async () => undefined,
    onDidChange: () => undefined,
  });

  await controller.resumeRuntime({
    workspace: "/workspace",
    configPath: "/private/.env",
    publicUrl: "https://mcp.example.test",
    mcpUrl: "https://mcp.example.test/sse",
  });
  assert.equal(controller.viewState.phase, "callback");
  assert.equal(controller.viewState.credential, undefined);

  await controller.noteChatGptConnected();
  assert.equal(controller.viewState.phase, "complete");
  assert.equal(controller.viewState.completed, true);
  assert.equal(controller.viewState.chatGptConnected, true);
});

test("runtime adoption repairs durable hosting state without opening or activating onboarding", async () => {
  let browserCalls = 0;
  const controller = new WizardController(new WizardStateStore(new MemoryMemento()), {
    selectWorkspace: async () => undefined,
    selectCloudflareCredential: async () => undefined,
    confirmFullAccess: async () => false,
    provision: async () => { throw new Error("unused"); },
    start: async () => { throw new Error("unused"); },
    pairOwner: async () => { browserCalls += 1; return false; },
    openChatGpt: async () => { browserCalls += 1; },
    copyText: async () => undefined,
    registerChatGpt: async () => { throw new Error("unused"); },
    credentialValue: async () => undefined,
    onDidChange: () => undefined,
  });
  const reference = "33333333-3333-4333-8333-333333333333";

  await controller.adoptRuntime({
    workspace: "/workspace",
    configPath: "/private/.env",
    publicUrl: "https://mcp.example.test",
    mcpUrl: "https://mcp.example.test/sse",
    hosting: {
      kind: "cloudflare-named",
      tunnelName: "vspilink-example",
      zoneName: "example.test",
      mcpHostname: "mcp.example.test",
      landingHostname: "vspilink.example.test",
      cloudflareAuthKind: "origin-certificate",
      credentialReference: reference,
      credentialLabel: "cert.pem",
    },
  });

  assert.equal(controller.viewState.active, false);
  assert.equal(controller.viewState.phase, "idle");
  assert.equal(controller.currentState.appliedHosting?.credentialReference, reference);
  assert.equal(JSON.stringify(controller.viewState).includes(reference), false);
  assert.equal(browserCalls, 0);
});
