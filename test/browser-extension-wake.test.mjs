import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const NONCE = "0123456789abcdef0123456789abcdef";
const WAKE = "@PiLink-desktop wake up";
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
  querySelectorAll() { return this.buttons.slice(); }
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
  constructor({ disabled = false, ariaDisabled = null } = {}) {
    this.disabled = disabled;
    this.ariaDisabled = ariaDisabled;
    this.isSendButton = true;
    this.clickCount = 0;
  }
  getAttribute(name) { return name === "aria-disabled" ? this.ariaDisabled : null; }
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

function runExtension({ href = URL_OK, composers = [], documentButtons = [], store = makeStore(), clock = new FakeClock() } = {}) {
  const banners = [];
  const document = {
    querySelectorAll: (selector) => selector === COMPOSER_SELECTOR_FOR_TEST ? composers.slice() : documentButtons.slice(),
    createElement: () => ({ style: {}, textContent: "" }),
    body: { appendChild: (element) => banners.push(element) },
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
  });
  vm.runInContext(extensionSource, context, { timeout: 1000 });
  return { clock, document, store, context, banners };
}

const COMPOSER_SELECTOR_FOR_TEST = '#prompt-textarea, textarea, [contenteditable="true"], [contenteditable=""]';
const extensionSource = await readFile(new URL("../browser-extension/wake.js", import.meta.url), "utf8");

function readyFixture() {
  const button = new FakeButton();
  const form = new FakeForm([button]);
  const composer = new FakeComposer({ form });
  return { button, form, composer };
}

test("manifest is MV3 with only the ChatGPT content-script match and no permissions/background", async () => {
  const manifest = JSON.parse(await readFile(new URL("../browser-extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://chatgpt.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].js, ["wake.js"]);
  assert.equal("permissions" in manifest, false);
  assert.equal("host_permissions" in manifest, false);
  assert.equal("background" in manifest, false);
});

test("matching URL focuses the exact composer and clicks its unique send button once", () => {
  const { button, composer } = readyFixture();
  runExtension({ composers: [composer] });
  assert.equal(composer.focusCount, 1);
  assert.equal(button.clickCount, 1);
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
