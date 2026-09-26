(() => {
  "use strict";

  const WAKE_TEXT = "@PiLink-desktop wake up";
  const COMPOSER_SELECTOR = '#prompt-textarea, textarea, [contenteditable="true"], [contenteditable=""]';
  const SEND_BUTTON_SELECTOR = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]';
  const MAX_WAIT_MS = 15000;
  const POLL_MS = 100;

  let url;
  try {
    url = new URL(location.href);
  } catch (_) {
    return;
  }

  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.pathname !== "/" || url.hash !== "") {
    return;
  }

  const entries = Array.from(url.searchParams.entries());
  const nonceValues = url.searchParams.getAll("pilink_wake");
  const wakeValues = url.searchParams.getAll("q");
  if (
    entries.length !== 2 ||
    nonceValues.length !== 1 ||
    wakeValues.length !== 1 ||
    wakeValues[0] !== WAKE_TEXT ||
    !/^[0-9a-f]{32}$/.test(nonceValues[0])
  ) {
    return;
  }

  function stillOnWakePage() {
    try {
      const current = new URL(location.href);
      if (current.origin !== "https://chatgpt.com" || current.pathname !== "/" || current.hash !== "" ||
          current.searchParams.getAll("pilink_wake").length !== 1 ||
          current.searchParams.get("pilink_wake") !== nonceValues[0]) return false;
      const query = current.searchParams.getAll("q");
      const count = Array.from(current.searchParams).length;
      // ChatGPT consumes ?q to pre-fill the editor, then removes only ?q
      // with a same-tab history change. Keep the nonce and strict editor
      // check; never send after another route or extra query parameter.
      return (query.length === 1 && query[0] === WAKE_TEXT && count === 2) ||
        (query.length === 0 && count === 1);
    } catch (_) {
      return false;
    }
  }

  // A small, non-interactive diagnostic is visible only on a PiLink wake URL.
  // It shows fixed status labels, never user messages, cookies or tokens.
  let badge = null;
  if (document.body && typeof document.createElement === "function") {
    badge = document.createElement("div");
    badge.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;" +
      "padding:8px 12px;border-radius:8px;background:#142334;color:white;" +
      "font:13px system-ui,sans-serif;pointer-events:none;max-width:320px";
    document.body.appendChild(badge);
  }
  function status(label) {
    if (badge) badge.textContent = `PiLink wake: ${label}`;
  }
  status("extension active; checking the editor");

  let storage;
  try {
    storage = sessionStorage;
    const key = `pilink-wake-attempted:${nonceValues[0]}`;
    if (storage.getItem(key) !== null) {
      status("already attempted for this tab");
      return;
    }
    storage.setItem(key, "1");
  } catch (_) {
    status("browser storage unavailable; nothing sent");
    return;
  }

  const startedAt = Date.now();
  let finished = false;
  let timer = null;
  let pinnedComposer = null;
  let waitingFor = "ChatGPT editor";

  function finish(reason) {
    if (reason) status(reason);
    finished = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNext() {
    if (finished) return;
    const remaining = MAX_WAIT_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      finish(`${waitingFor} not ready after 15 seconds; nothing sent`);
      return;
    }
    timer = setTimeout(checkReady, Math.min(POLL_MS, remaining));
  }

  function readComposerText(composer) {
    if (composer.tagName === "TEXTAREA") return composer.value;
    if (typeof composer.innerText === "string") return composer.innerText;
    return composer.textContent;
  }

  function findSendButtons(composer) {
    const form = typeof composer.closest === "function" ? composer.closest("form") : null;
    if (form && typeof form.querySelectorAll === "function") {
      const localButtons = form.querySelectorAll(SEND_BUTTON_SELECTOR);
      if (localButtons.length > 0) return localButtons;
    }
    // ChatGPT has moved composer controls across container boundaries before.
    // On the exact new-chat wake URL, accept a document-level fallback only
    // when the send selector remains unique; ambiguity still fails closed.
    return document.querySelectorAll(SEND_BUTTON_SELECTOR);
  }

  function checkReady() {
    timer = null;
    if (finished) return;
    if (!stillOnWakePage()) {
      finish("ChatGPT changed the wake URL; nothing sent");
      return;
    }
    if (Date.now() - startedAt >= MAX_WAIT_MS) {
      finish(`${waitingFor} not ready after 15 seconds; nothing sent`);
      return;
    }

    try {
      const composers = document.querySelectorAll(COMPOSER_SELECTOR);
      if (composers.length > 1) {
        finish("multiple text boxes; nothing sent");
        return;
      }
      if (composers.length === 0) {
        waitingFor = "ChatGPT editor";
        scheduleNext();
        return;
      }

      const composer = composers[0];
      if (readComposerText(composer) !== WAKE_TEXT) {
        waitingFor = "exact pre-filled wake phrase";
        scheduleNext();
        return;
      }

      if (pinnedComposer === null) {
        if (typeof composer.focus !== "function") {
          finish("editor cannot be focused; nothing sent");
          return;
        }
        composer.focus();
        pinnedComposer = composer;
      } else if (composer !== pinnedComposer) {
        finish("editor changed; nothing sent");
        return;
      }

      const buttons = findSendButtons(composer);
      if (buttons.length > 1) {
        finish("multiple send buttons; nothing sent");
        return;
      }
      if (buttons.length === 0) {
        waitingFor = "send button";
        scheduleNext();
        return;
      }

      const button = buttons[0];
      if (button.disabled || button.getAttribute("aria-disabled") === "true") {
        waitingFor = "enabled send button";
        scheduleNext();
        return;
      }
      if (typeof button.click !== "function" || readComposerText(composer) !== WAKE_TEXT) {
        finish("send button or phrase changed; nothing sent");
        return;
      }

      // Seal the attempt before dispatching the single click; never retry a click.
      finish("clicked the send button once");
      button.click();
    } catch (_) {
      finish("browser UI error; send unconfirmed");
    }
  }

  checkReady();
})();
