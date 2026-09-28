"use strict";

const NONCE = /^[0-9a-f]{32}$/;
const PORT = /^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/;
const POLL_MS = 250;
const MAX_WAIT_MS = 30_000;

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "pilink-register-wake" || !NONCE.test(message.nonce ?? "") ||
      !PORT.test(String(message.port ?? "")) || !Number.isInteger(sender.tab?.id)) return;
  void waitForConfirmation(sender.tab.id, message.nonce, Number(message.port));
});

async function waitForConfirmation(tabId, nonce, port) {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/gateway/wake/${nonce}`, { cache: "no-store" });
      if (response.ok) {
        const body = await response.json();
        if (body?.confirmed === true) {
          requestVerifiedClose(tabId, nonce);
          return;
        }
      } else if (response.status === 404) {
        return;
      }
    } catch (_) {
      // The local gateway can disappear while a wake is in flight. Leave the tab open.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function requestVerifiedClose(tabId, nonce) {
  chrome.tabs.sendMessage(tabId, { type: "pilink-confirm-close", nonce }, (reply) => {
    if (chrome.runtime.lastError || reply?.ok !== true) return;
    chrome.tabs.remove(tabId, () => void chrome.runtime.lastError);
  });
}
