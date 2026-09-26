import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildGatewayWakeUrl,
  gatewayAutoWakeEnabled,
  shouldAutoWakeGateway,
  startGatewayAutoWakeSupervisor,
} from "../dist/llm-gateway-auto-wake.js";

function status(overrides = {}) {
  return {
    state: "waiting_for_chatgpt", queued: 1, claimed: 0, completed: 0, failed: 0, cancelled: 0,
    worker_polling: false, pending_worker_polls: 0, worker_contact: "never", processing_claim: false,
    oldest_queue_age_ms: 0, next_action: "wake_worker", ...overrides,
  };
}

test("auto-wake is opt-in and restricted to graphical Linux CLI endpoint launches", () => {
  const base = { PI_LLM_GATEWAY_ENABLED: "true", PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" };
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
  assert.equal(gatewayAutoWakeEnabled({ ...base, DISPLAY: ":0" }, "linux"), true);
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: "wayland-0" }, "darwin"), false);
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: "wayland-0", PI_LLM_GATEWAY_AUTO_WAKE: undefined }, "linux"), false);
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: "wayland-0", PI_LLM_GATEWAY_AUTO_WAKE: "false" }, "linux"), false);
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: undefined, DISPLAY: undefined }, "linux"), false);
  assert.equal(gatewayAutoWakeEnabled({ WAYLAND_DISPLAY: "wayland-0", PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" }, "linux"), false);
});

test("wake URLs require one random nonce and the exact prefill phrase", () => {
  const nonce = "0123456789abcdef0123456789abcdef";
  assert.equal(buildGatewayWakeUrl(nonce),
    `https://chatgpt.com/?q=%40PiLink-desktop%20wake%20up&pilink_wake=${nonce}`);
  assert.throws(() => buildGatewayWakeUrl("not-a-nonce"));
  assert.throws(() => buildGatewayWakeUrl("../123456789abcdef0123456789abcdef"));
});

test("wake needs queued work or a previously active worker and explicit wake_worker status", () => {
  assert.equal(shouldAutoWakeGateway(status()), true);
  assert.equal(shouldAutoWakeGateway(status({ queued: 0 })), false);
  assert.equal(shouldAutoWakeGateway(status({ queued: 0 }), true), true);
  assert.equal(shouldAutoWakeGateway(status({ next_action: "poll" }), true), false);
  assert.equal(shouldAutoWakeGateway(status({ worker_polling: true })), false);
  assert.equal(shouldAutoWakeGateway(status({ processing_claim: true })), false);
  assert.equal(shouldAutoWakeGateway(status({ state: "released", next_action: "none" })), false);
});

test("browser driver opens a nonce-tagged URL in Brave or the default browser, never a keyboard daemon", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-wake-driver-"));
  const log = path.join(root, "opened");
  const writeCommand = async (name, body) => fs.writeFile(path.join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  try {
    for (const browser of ["brave-browser.desktop", "firefox.desktop"]) {
      await writeCommand("xdg-settings", `printf '%s\\n' '${browser}'`);
      await writeCommand("brave", `printf '%s\\n' "$@" > '${log}'`);
      await writeCommand("xdg-open", `printf '%s\\n' "$@" > '${log}'`);
      await fs.rm(log, { force: true });
      const supervisor = startGatewayAutoWakeSupervisor({
        store: { status: async () => status() },
        env: { PATH: `${root}:/usr/bin:/bin`, DISPLAY: ":0", PI_LLM_GATEWAY_ENABLED: "true",
          PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" },
        platform: "linux", pollIntervalMs: 5, wakeGraceMs: 0, confirmationMs: 25,
        log: () => {},
      });
      assert.ok(supervisor);
      try {
        // Driver preparation, execFile, and the status recheck are asynchronous.
        let output = "";
        for (let attempt = 0; attempt < 80; attempt++) {
          try { output = await fs.readFile(log, "utf8"); } catch { /* not yet created */ }
          if (output.includes("https://chatgpt.com/")) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.match(output, /https:\/\/chatgpt\.com\//);
        const args = output.trim().split("\n");
        const url = new URL(args.at(-1));
        assert.equal(url.origin, "https://chatgpt.com");
        assert.equal(url.pathname, "/");
        assert.equal(url.searchParams.get("q"), "@PiLink-desktop wake up");
        assert.match(url.searchParams.get("pilink_wake"), /^[0-9a-f]{32}$/);
        assert.equal(url.searchParams.size, 2);
        assert.deepEqual(args.slice(0, -1), browser === "brave-browser.desktop" ? ["--new-window"] : []);
      } finally {
        supervisor.close();
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("supervisor opens only once per persistent wake condition and waits for real worker contact", async () => {
  let state = status();
  let opens = 0;
  const logs = [];
  const supervisor = startGatewayAutoWakeSupervisor({
    store: { status: async () => state },
    env: { WAYLAND_DISPLAY: "wayland-0", PI_LLM_GATEWAY_ENABLED: "true", PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" },
    platform: "linux", driver: { wake: async () => { opens++; } }, pollIntervalMs: 5,
    wakeGraceMs: 0, confirmationMs: 40, log: (message) => logs.push(message),
  });
  assert.ok(supervisor);
  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(opens, 1);
    assert.ok(logs.some((line) => /no worker contact/.test(line)));
    state = status({ worker_polling: true, next_action: "poll" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(opens, 1);
  } finally {
    supervisor.close();
  }
});
