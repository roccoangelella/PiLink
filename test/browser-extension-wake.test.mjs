import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageGatewayBrowserExtension } from "../dist/llm-gateway-browser-setup.js";
import vm from "node:vm";

const NONCE = "0123456789abcdef0123456789abcdef";
const WAKE = "@PiLink Gateway wake up";
const URL_OK = `https://chatgpt.com/?q=${encodeURIComponent(WAKE)}&pilink_wake=${NONCE}`;

class FakeClock {
  now = 0;
  nextId = 1;
  timers = new Map();

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, at: this.now + delay });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  advance(ms) {
    const target = this.now + ms;
    while (true) {
      let nextId = null;
      let next = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (!next || timer.at < next.at)) {
          nextId = id;
          next = timer;
        }
      }
      if (!next) break;
      this.timers.delete(nextId);
      this.now = next.at;
      next.callback();
    }
    this.now = target;
  }
}

class FakeDate extends Date {
  static clock;
  static now() { return FakeDate.clock.now; }
}

class FakeForm {
  constructor(buttons = []) { this.buttons = buttons; }
  querySelectorAll(selector) { return this.buttons.filter((button) => button.matches(selector)); }
}

class FakeComposer {
  constructor({ text = WAKE, tagName = "TEXTAREA", form = new FakeForm() } = {}) {
    this.tagName = tagName;
    this.form = form;
    this.focusCount = 0;
    this.value = tagName === "TEXTAREA" ? text : undefined;
    this.innerText = tagName === "TEXTAREA" ? undefined : text;
    this.textContent = text;
  }
  closest(selector) { return selector === "form" ? this.form : null; }
  focus() { this.focusCount++; }
}

class FakeButton {
  constructor({ id = null, testId = null, type = null, ariaLabel = null, disabled = false, ariaDisabled = null } = {}) {
    this.id = id;
    this.testId = testId;
    this.type = type;
    this.ariaLabel = ariaLabel;
    this.disabled = disabled;
    this.ariaDisabled = ariaDisabled;
    this.isSendButton = true;
    this.clickCount = 0;
    this.form = null;
  }
  closest(selector) { return selector === "form" ? this.form : null; }
  getAttribute(name) {
    return name === "aria-disabled" ? this.ariaDisabled : name === "aria-label" ? this.ariaLabel : null;
  }
  matches(selector) {
    // Plain fixtures represent the existing known send selector; explicit
    // fixtures match only the selector they declare.
    if (!this.id && !this.testId && !this.type && !this.ariaLabel) return selector !== 'button[type="submit"][aria-label]';
    return selector.split(",").some((part) => {
      const s = part.trim();
      return (this.id && s === `button#${this.id}`) ||
        (this.testId && s === `button[data-testid="${this.testId}"]`) ||
        (this.ariaLabel && s === `button[aria-label="${this.ariaLabel}"]`) ||
        (this.type === "submit" && this.ariaLabel && s === 'button[type="submit"][aria-label]');
    });
  }
  click() { this.clickCount++; }
}

function makeStore() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

function runExtension({ href = URL_OK, composers = [], documentButtons = [], store = makeStore(), clock = new FakeClock(), bodyReady = true, source = extensionSource, chrome } = {}) {
  const banners = [];
  const body = { appendChild: (element) => banners.push(element) };
  const document = {
    querySelectorAll: (selector) => selector === COMPOSER_SELECTOR_FOR_TEST
      ? composers.slice() : documentButtons.filter((button) => button.matches(selector)),
    createElement: () => ({ style: {}, textContent: "" }),
    body: bodyReady ? body : null,
  };
  FakeDate.clock = clock;
  const context = vm.createContext({
    URL,
    Date: FakeDate,
    location: { href },
    document,
    sessionStorage: store,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...(chrome ? { chrome } : {}),
  });
  vm.runInContext(source, context, { timeout: 1000 });
  return { clock, document, body, store, context, banners };
}

const COMPOSER_SELECTOR_FOR_TEST = '#prompt-textarea, textarea, [contenteditable="true"], [contenteditable=""]';
const extensionSource = await readFile(new URL("../browser-extension/wake.js", import.meta.url), "utf8");
const backgroundSource = await readFile(new URL("../browser-extension/background.js", import.meta.url), "utf8");

function readyFixture() {
  const button = new FakeButton();
  const form = new FakeForm([button]);
  const composer = new FakeComposer({ form });
  return { button, form, composer };
}

test("manifest is MV3 with only ChatGPT content access and loopback confirmation access", async () => {
  const manifest = JSON.parse(await readFile(new URL("../browser-extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://chatgpt.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].js, ["wake.js"]);
  assert.equal(manifest.content_scripts[0].run_at, "document_start");
  assert.equal("permissions" in manifest, false);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.deepEqual(manifest.background, { service_worker: "background.js" });
});

test("matching URL focuses the exact composer and clicks its unique send button once", () => {
  const { button, composer } = readyFixture();
  runExtension({ composers: [composer] });
  assert.equal(composer.focusCount, 1);
  assert.equal(button.clickCount, 1);
});

test("a port-tagged wake acknowledges close after ChatGPT's same-document conversation transition", () => {
  const { button, composer } = readyFixture();
  let registered;
  let closeListener;
  const chrome = { runtime: {
    sendMessage: (message) => { registered = message; },
    onMessage: { addListener: (listener) => { closeListener = listener; } },
  } };
  const href = `${URL_OK}&pilink_port=8765`;
  const { context } = runExtension({ href, composers: [composer], chrome });
  assert.deepEqual({ ...registered }, { type: "pilink-register-wake", nonce: NONCE, port: 8765 });
  assert.equal(button.clickCount, 1);

  context.location.href = "https://chatgpt.com/c/01234567-89ab-cdef-0123-456789abcdef";
  let reply;
  closeListener({ type: "pilink-confirm-close", nonce: NONCE }, {}, (value) => { reply = value; });
  assert.deepEqual({ ...reply }, { ok: true });

  reply = undefined;
  context.location.href = "https://example.com/";
  closeListener({ type: "pilink-confirm-close", nonce: NONCE }, {}, (value) => { reply = value; });
  assert.equal(reply, undefined, "a non-ChatGPT document must never acknowledge close");
});

test("background closes exactly the registering sender tab after gateway confirmation", async () => {
  let registerListener;
  const sent = [];
  const removed = [];
  const chrome = {
    runtime: { lastError: null, onMessage: { addListener: (listener) => { registerListener = listener; } } },
    tabs: {
      sendMessage: (tabId, message, options, callback) => { sent.push({ tabId, message, options }); callback({ ok: true }); },
      remove: (tabId, callback) => { removed.push(tabId); callback(); },
    },
  };
  const fetchCalls = [];
  const context = vm.createContext({
    chrome,
    fetch: async (url) => { fetchCalls.push(url); return { ok: true, status: 200, json: async () => ({ confirmed: true }) }; },
    setTimeout,
  });
  vm.runInContext(backgroundSource, context, { timeout: 1000 });
  registerListener({ type: "pilink-register-wake", nonce: NONCE, port: 8765 }, { tab: { id: 42 }, documentId: "doc-wake-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetchCalls, [`http://127.0.0.1:8765/v1/gateway/wake/${NONCE}`]);
  assert.deepEqual(sent.map(({ tabId, message, options }) => ({ tabId, message: { ...message }, options: { ...options } })),
    [{ tabId: 42, message: { type: "pilink-confirm-close", nonce: NONCE }, options: { documentId: "doc-wake-1" } }]);
  assert.deepEqual(removed, [42]);
});

test("a custom-name staged extension sends only its pinned wake phrase", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilink-custom-extension-vm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "extension");
  stageGatewayBrowserExtension({ source: fileURLToPath(new URL("../browser-extension/", import.meta.url)), destination, connectorName: "My Coding Connector" });
  const source = await readFile(path.join(destination, "wake.js"), "utf8");
  const phrase = "@My Coding Connector wake up";
  const button = new FakeButton();
  const composer = new FakeComposer({ text: phrase, form: new FakeForm([button]) });
  runExtension({ source, href: `https://chatgpt.com/?q=${encodeURIComponent(phrase)}&pilink_wake=${NONCE}`, composers: [composer] });
  assert.equal(button.clickCount, 1);
  runExtension({ source, composers: [composer] });
  assert.equal(button.clickCount, 1, "a default-name URL must not be sent by the custom-name extension");
});

test("contenteditable composer is supported when its own text exactly matches", () => {
  const button = new FakeButton();
  const composer = new FakeComposer({ tagName: "DIV", form: new FakeForm([button]) });
  runExtension({ composers: [composer] });
  assert.equal(composer.focusCount, 1);
  assert.equal(button.clickCount, 1);
});

test("unique document send button works when ChatGPT places it outside the editor form", () => {
  const button = new FakeButton();
  const composer = new FakeComposer({ form: null });
  runExtension({ composers: [composer], documentButtons: [button] });
  assert.equal(composer.focusCount, 1);
  assert.equal(button.clickCount, 1);
});

test("non-matching URL conditions do nothing", () => {
  const { button, composer } = readyFixture();
  for (const href of [
    `https://chatgpt.com/?q=other&pilink_wake=${NONCE}`,
    `https://chatgpt.com/?q=${encodeURIComponent("@Pilink-desktop wake up")}&pilink_wake=${NONCE}`,
    `https://chatgpt.com/?q=${encodeURIComponent(WAKE)}&pilink_wake=BAD`,
    `${URL_OK}&extra=1`,
    URL_OK.replace("chatgpt.com/", "chatgpt.com/path/"),
    `https://chatgpt.com/?q=${encodeURIComponent(WAKE)}&q=${encodeURIComponent(WAKE)}&pilink_wake=${NONCE}`,
    `https://chatgpt.com/?q=${encodeURIComponent(WAKE)}&pilink_wake=${NONCE}#chat`,
    `https://evil.example/?q=${encodeURIComponent(WAKE)}&pilink_wake=${NONCE}`,
    `http://chatgpt.com/?q=${encodeURIComponent(WAKE)}&pilink_wake=${NONCE}`,
  ]) {
    runExtension({ href, composers: [composer] });
  }
  assert.equal(composer.focusCount, 0);
  assert.equal(button.clickCount, 0);
});

test("sessionStorage makes a nonce idempotent across repeated script execution", () => {
  const { button, composer } = readyFixture();
  const store = makeStore();
  runExtension({ composers: [composer], store });
  runExtension({ composers: [composer], store });
  assert.equal(composer.focusCount, 1);
  assert.equal(button.clickCount, 1);
});

test("ambiguous composers or send buttons fail closed", () => {
  const first = readyFixture();
  const second = readyFixture();
  runExtension({ composers: [first.composer, second.composer] });
  assert.equal(first.composer.focusCount, 0);
  assert.equal(second.composer.focusCount, 0);
  assert.equal(first.button.clickCount, 0);

  const ambiguousButton = new FakeButton();
  const fixture = readyFixture();
  fixture.form.buttons.push(ambiguousButton);
  runExtension({ composers: [fixture.composer] });
  assert.equal(fixture.composer.focusCount, 1);
  assert.equal(fixture.button.clickCount, 0);
  assert.equal(ambiguousButton.clickCount, 0);

  const globalFirst = new FakeButton();
  const globalSecond = new FakeButton();
  const globalComposer = new FakeComposer({ form: null });
  runExtension({ composers: [globalComposer], documentButtons: [globalFirst, globalSecond] });
  assert.equal(globalComposer.focusCount, 1);
  assert.equal(globalFirst.clickCount, 0);
  assert.equal(globalSecond.clickCount, 0);
});

test("waits for delayed composer readiness within the bounded window", () => {
  const clock = new FakeClock();
  const composers = [];
  const { button, composer } = readyFixture();
  runExtension({ composers, clock });
  clock.setTimeout(() => composers.push(composer), 250);
  clock.advance(500);
  assert.equal(composer.focusCount, 1);
  assert.equal(button.clickCount, 1);
});

test("ChatGPT consuming only ?q retains the nonce and permits one exact send", () => {
  const clock = new FakeClock();
  const composers = [];
  const { button, composer } = readyFixture();
  const { context } = runExtension({ composers, clock });
  context.location.href = `https://chatgpt.com/?pilink_wake=${NONCE}`;
  composers.push(composer);
  clock.advance(300);
  assert.equal(button.clickCount, 1);
  clock.advance(1000);
  assert.equal(button.clickCount, 1);
});

test("captures the authorized URL before ChatGPT consumes q or creates the body", () => {
  const clock = new FakeClock();
  const composers = [];
  const { button, composer } = readyFixture();
  const { context, document, body, banners } = runExtension({ composers, clock, bodyReady: false });
  assert.equal(banners.length, 0);
  context.location.href = `https://chatgpt.com/?pilink_wake=${NONCE}`;
  document.body = body;
  composers.push(composer);
  clock.advance(200);
  assert.equal(button.clickCount, 1);
  assert.equal(banners.length, 1);
  assert.equal(banners[0].textContent, "PiLink wake: clicked the send button once");
});

test("a nonce alone cannot start the extension, and added parameters cancel it", () => {
  const initial = readyFixture();
  const alone = runExtension({ href: `https://chatgpt.com/?pilink_wake=${NONCE}`, composers: [initial.composer] });
  assert.equal(alone.banners.length, 0);
  assert.equal(initial.button.clickCount, 0);
  const delayed = readyFixture();
  const clock = new FakeClock();
  const composers = [];
  const { context, banners } = runExtension({ composers, clock });
  context.location.href = `https://chatgpt.com/?pilink_wake=${NONCE}&unrelated=1`;
  composers.push(delayed.composer);
  clock.advance(200);
  assert.equal(delayed.button.clickCount, 0);
  assert.match(banners[0].textContent, /changed the wake URL/);
});

test("SPA navigation away from the exact nonce page cancels a pending send", () => {
  const clock = new FakeClock();
  const composers = [];
  const { button, composer } = readyFixture();
  const { context } = runExtension({ composers, clock });
  context.location.href = "https://chatgpt.com/c/unrelated";
  composers.push(composer);
  clock.advance(500);
  assert.equal(composer.focusCount, 0);
  assert.equal(button.clickCount, 0);
});

test("wake-only diagnostic reports one click without reading other chat contents", () => {
  const { button, composer } = readyFixture();
  const { banners } = runExtension({ composers: [composer] });
  assert.equal(button.clickCount, 1);
  assert.equal(banners.length, 1);
  assert.equal(banners[0].textContent, "PiLink wake: clicked the send button once");
});

test("changed text and readiness beyond the deadline never send", () => {
  const changed = readyFixture();
  changed.composer.value = "different text";
  const { clock: waiting, banners } = runExtension({ composers: [changed.composer] });
  waiting.advance(15000);
  assert.equal(changed.composer.focusCount, 0);
  assert.equal(changed.button.clickCount, 0);
  assert.match(banners[0].textContent, /exact pre-filled wake phrase not ready/);

  const clock = new FakeClock();
  const composers = [];
  const late = readyFixture();
  runExtension({ composers, clock });
  clock.setTimeout(() => composers.push(late.composer), 16000);
  clock.advance(16000);
  assert.equal(late.composer.focusCount, 0);
  assert.equal(late.button.clickCount, 0);
});

test("current ChatGPT composer-submit-button is selected by id or test id, once", () => {
  for (const button of [new FakeButton({ id: "composer-submit-button" }),
    new FakeButton({ testId: "composer-submit-button" })]) {
    const composer = new FakeComposer({ form: new FakeForm([button]) });
    runExtension({ composers: [composer] });
    assert.equal(button.clickCount, 1);
    assert.equal(composer.focusCount, 1);
  }
  const external = new FakeButton({ id: "composer-submit-button" });
  runExtension({ composers: [new FakeComposer({ form: null })], documentButtons: [external] });
  assert.equal(external.clickCount, 1);
});

test("document fallback cannot click another form's send button", () => {
  const otherForm = new FakeForm();
  const unrelated = new FakeButton({ id: "composer-submit-button" });
  unrelated.form = otherForm;
  const composer = new FakeComposer({ form: new FakeForm() });
  const { clock, banners } = runExtension({ composers: [composer], documentButtons: [unrelated] });
  clock.advance(15000);
  assert.equal(unrelated.clickCount, 0);
  assert.match(banners[0].textContent, /send button not ready/);
});

test("ambiguous matching send buttons fail closed", () => {
  const one = new FakeButton({ id: "composer-submit-button" });
  const two = new FakeButton({ testId: "composer-submit-button" });
  const { banners } = runExtension({ composers: [new FakeComposer({ form: new FakeForm([one, two]) })] });
  assert.equal(one.clickCount + two.clickCount, 0);
  assert.match(banners[0].textContent, /multiple send buttons/);
});

test("unique localized submit button in the editor form takes priority over another document button", () => {
  const local = new FakeButton({ type: "submit", ariaLabel: "Invia" });
  const unrelated = new FakeButton({ id: "composer-submit-button" });
  const composer = new FakeComposer({ form: new FakeForm([local]) });
  runExtension({ composers: [composer], documentButtons: [unrelated] });
  assert.equal(local.clickCount, 1);
  assert.equal(unrelated.clickCount, 0);
});

test("ambiguous localized form buttons cannot fall through to a document button", () => {
  const one = new FakeButton({ type: "submit", ariaLabel: "Invia" });
  const two = new FakeButton({ type: "submit", ariaLabel: "Send" });
  const external = new FakeButton({ id: "composer-submit-button" });
  const { banners } = runExtension({
    composers: [new FakeComposer({ form: new FakeForm([one, two]) })],
    documentButtons: [external],
  });
  assert.equal(one.clickCount + two.clickCount + external.clickCount, 0);
  assert.match(banners[0].textContent, /multiple send buttons/);
});

test("unrelated labelled submit in the editor form is never clicked", () => {
  const unrelated = new FakeButton({ type: "submit", ariaLabel: "Delete conversation" });
  const { clock, banners } = runExtension({ composers: [new FakeComposer({ form: new FakeForm([unrelated]) })] });
  clock.advance(15000);
  assert.equal(unrelated.clickCount, 0);
  assert.match(banners[0].textContent, /send button not ready/);
});

test("disabled send control never clicks, even after the deadline", () => {
  const button = new FakeButton({ id: "composer-submit-button", disabled: true });
  const { clock, banners } = runExtension({ composers: [new FakeComposer({ form: new FakeForm([button]) })] });
  clock.advance(15000);
  assert.equal(button.clickCount, 0);
  assert.match(banners[0].textContent, /enabled send button not ready/);
});

test("generic document submit cannot be guessed without a composer form", () => {
  const unrelated = new FakeButton({ type: "submit", ariaLabel: "Invia" });
  const { clock, banners } = runExtension({
    composers: [new FakeComposer({ form: null })], documentButtons: [unrelated],
  });
  clock.advance(15000);
  assert.equal(unrelated.clickCount, 0);
  assert.match(banners[0].textContent, /send button not ready/);
});
