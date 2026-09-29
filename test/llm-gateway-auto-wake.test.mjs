import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildGatewayWakeUrl,
  GatewayWakeConfirmations,
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

async function eventually(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("auto-wake condition was not met before the deadline");
}

test("auto-wake is opt-in for graphical Linux and Windows CLI endpoint launches", () => {
  const base = { PI_LLM_GATEWAY_ENABLED: "true", PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" };
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
  assert.equal(gatewayAutoWakeEnabled({ ...base, DISPLAY: ":0" }, "linux"), true);
  assert.equal(gatewayAutoWakeEnabled(base, "win32"), true);
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: "wayland-0" }, "darwin"), false);
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: "wayland-0", PI_LLM_GATEWAY_AUTO_WAKE: undefined }, "linux"), false);
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: "wayland-0", PI_LLM_GATEWAY_AUTO_WAKE: "false" }, "linux"), false);
  assert.equal(gatewayAutoWakeEnabled({ ...base, WAYLAND_DISPLAY: undefined, DISPLAY: undefined }, "linux"), false);
  assert.equal(gatewayAutoWakeEnabled({ ...base, PI_LLM_GATEWAY_AUTO_WAKE: "false" }, "win32"), false);
  assert.equal(gatewayAutoWakeEnabled({ WAYLAND_DISPLAY: "wayland-0", PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" }, "linux"), false);
});

test("Windows auto-wake supervisor runs without X11 or Wayland variables", async () => {
  let opens = 0;
  const supervisor = startGatewayAutoWakeSupervisor({
    store: { status: async () => status() },
    env: { PI_LLM_GATEWAY_ENABLED: "true", PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" },
    platform: "win32", driver: { wake: async () => { opens++; } },
    pollIntervalMs: 5, wakeGraceMs: 0, confirmationMs: 20, log: () => {},
  });
  assert.ok(supervisor);
  try {
    await eventually(() => opens === 1);
  } finally {
    supervisor.close();
  }
});

test("wake URLs require one random nonce and the exact prefill phrase", () => {
  const nonce = "0123456789abcdef0123456789abcdef";
  assert.equal(buildGatewayWakeUrl(nonce),
    `https://chatgpt.com/?q=%40PiLink%20Gateway%20wake%20up&pilink_wake=${nonce}`);
  assert.equal(buildGatewayWakeUrl(nonce, {}, 8765),
    `https://chatgpt.com/?q=%40PiLink%20Gateway%20wake%20up&pilink_wake=${nonce}&pilink_port=8765`);
  assert.throws(() => buildGatewayWakeUrl(nonce, {}, 0));
  assert.throws(() => buildGatewayWakeUrl(nonce, {}, 65536));
  assert.throws(() => buildGatewayWakeUrl("not-a-nonce"));
  assert.throws(() => buildGatewayWakeUrl("../123456789abcdef0123456789abcdef"));
});

test("wake confirmation state is scoped to an exact nonce", () => {
  const confirmations = new GatewayWakeConfirmations();
  const nonce = "0123456789abcdef0123456789abcdef";
  const other = "fedcba9876543210fedcba9876543210";
  confirmations.register(nonce);
  assert.equal(confirmations.status(nonce), "pending");
  assert.equal(confirmations.status(other), undefined);
  confirmations.confirm(other);
  assert.equal(confirmations.status(nonce), "pending");
  confirmations.confirm(nonce);
  assert.equal(confirmations.status(nonce), "confirmed");
  confirmations.clear(nonce);
  assert.equal(confirmations.status(nonce), undefined);
});

test("register prunes expired wake confirmations without exposing their backing map", () => {
  let now = 1_000;
  const confirmations = new GatewayWakeConfirmations(10, () => now);
  const expired = "11111111111111111111111111111111";
  const current = "22222222222222222222222222222222";
  confirmations.register(expired);
  now = 1_011;
  confirmations.register(current);

  // Move the injected clock backwards. The expired nonce can stay absent only
  // if register() already pruned it at 1011; current() alone would revive it.
  now = 1_005;
  assert.equal(confirmations.status(expired), undefined);
  assert.equal(confirmations.status(current), "pending");
});

test("a throwing wake driver clears its registered confirmation nonce", async () => {
  const confirmations = new GatewayWakeConfirmations();
  let attemptedNonce;
  const logs = [];
  const supervisor = startGatewayAutoWakeSupervisor({
    store: { status: async () => status() },
    env: { WAYLAND_DISPLAY: "wayland-0", PI_LLM_GATEWAY_ENABLED: "true",
      PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" },
    platform: "linux",
    driver: { wake: async (nonce) => { attemptedNonce = nonce; throw new Error("synthetic launch failure"); } },
    wakeConfirmations: confirmations,
    pollIntervalMs: 5, suspendedPollMs: 5, wakeGraceMs: 0, confirmationMs: 20,
    log: (line) => logs.push(line),
  });
  assert.ok(supervisor);
  try {
    await eventually(() => logs.some((line) => /synthetic launch failure/.test(line)));
    assert.match(attemptedNonce, /^[0-9a-f]{32}$/);
    assert.equal(confirmations.status(attemptedNonce), undefined);
  } finally {
    supervisor.close();
  }
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

test("queued work can wake before the 120s contact staleness deadline when the worker stopped polling", () => {
  const lastExchange = new Date(Date.now() - 10_000).toISOString();
  const idle = status({ state: "active", worker_contact: "recent", next_action: "poll",
    last_exchange_at: lastExchange, oldest_queue_age_ms: 6_000 });
  assert.equal(shouldAutoWakeGateway(idle), true);
  assert.equal(shouldAutoWakeGateway({ ...idle, oldest_queue_age_ms: 1_000 }), false);
  assert.equal(shouldAutoWakeGateway({ ...idle, last_exchange_at: new Date().toISOString() }), false);
  assert.equal(shouldAutoWakeGateway({ ...idle, worker_polling: true, next_action: "wait_for_worker" }), false);
  assert.equal(shouldAutoWakeGateway({ ...idle, processing_claim: true, next_action: "wait_for_worker" }), false);
  assert.equal(shouldAutoWakeGateway({ ...idle, queued: 0 }), false);
});

test("Windows driver uses SystemRoot rundll32 with exact non-shell-interpolated argv", async (t) => {
  if (process.platform === "win32") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-win-wake-driver-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemRoot = path.join(root, "Windows Root");
  const system32 = path.join(systemRoot, "System32");
  const handler = path.join(system32, "rundll32.exe");
  const logFile = path.join(root, "argv.log");
  await fs.mkdir(system32, { recursive: true });
  await fs.writeFile(handler, `#!/bin/sh\nprintf '%s\\n' "$@" > '${logFile}'\n`, { mode: 0o700 });

  const logs = [];
  const supervisor = startGatewayAutoWakeSupervisor({
    store: { status: async () => status({ oldest_queue_request_id: "req_windows-driver" }) },
    env: { SystemRoot: systemRoot, PATH: "", PI_LLM_GATEWAY_ENABLED: "true",
      PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true",
      PI_LLM_GATEWAY_CONNECTOR_NAME: "Windows Connector" },
    platform: "win32", apiPort: 8765, pollIntervalMs: 5, suspendedPollMs: 5,
    wakeGraceMs: 0, confirmationMs: 25, log: (line) => logs.push(line),
  });
  assert.ok(supervisor);
  try {
    await eventually(() => logs.some((line) => /wake URL opened/.test(line)));
    const args = (await fs.readFile(logFile, "utf8")).trim().split("\n");
    assert.equal(args.length, 2);
    assert.equal(args[0], "url.dll,FileProtocolHandler");
    const url = new URL(args[1]);
    assert.equal(url.origin, "https://chatgpt.com");
    assert.equal(url.pathname, "/");
    assert.equal(url.searchParams.get("q"), "@Windows Connector wake up");
    assert.match(url.searchParams.get("pilink_wake"), /^[0-9a-f]{32}$/);
    assert.equal(url.searchParams.get("pilink_port"), "8765");
    assert.equal(url.searchParams.size, 3);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await fs.readFile(logFile, "utf8")).trim().split("\n").length, 2,
      "one queue head must launch rundll32 only once");
  } finally {
    supervisor.close();
  }
});

test("Windows driver preparation can recover on a new queued head after a transient missing handler", async (t) => {
  if (process.platform === "win32") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-win-wake-retry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const systemRoot = path.join(root, "Windows");
  const system32 = path.join(systemRoot, "System32");
  const handler = path.join(system32, "rundll32.exe");
  const logFile = path.join(root, "argv.log");
  await fs.mkdir(system32, { recursive: true });

  const requestA = "req_windows_a";
  const requestB = "req_windows_b";
  let state = status({ oldest_queue_request_id: requestA });
  const logs = [];
  const supervisor = startGatewayAutoWakeSupervisor({
    store: { status: async () => state },
    env: { SystemRoot: systemRoot, PATH: "", PI_LLM_GATEWAY_ENABLED: "true",
      PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" },
    platform: "win32", apiPort: 8765, pollIntervalMs: 5, suspendedPollMs: 5,
    wakeGraceMs: 0, confirmationMs: 25, log: (line) => logs.push(line),
  });
  assert.ok(supervisor);
  try {
    await eventually(() => logs.some((line) => /rundll32\.exe was not found/.test(line)));
    await fs.writeFile(handler, `#!/bin/sh\nprintf '%s\\n' "$@" > '${logFile}'\n`, { mode: 0o700 });
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(logs.filter((line) => /rundll32\.exe was not found|wake URL opened/.test(line)).length, 1,
      "unchanged A must not retry even after rundll32 becomes available");

    // The first preparation failure consumed A's bounded attempt. Only a new
    // oldest queue head may re-arm and force driver preparation to run again.
    state = status({ oldest_queue_request_id: requestB });
    await eventually(() => logs.some((line) => /wake URL opened/.test(line)));
    const args = (await fs.readFile(logFile, "utf8")).trim().split("\n");
    assert.equal(args[0], "url.dll,FileProtocolHandler");
    assert.match(args[1], /pilink_port=8765/);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await fs.readFile(logFile, "utf8")).trim().split("\n").length, 2,
      "recovered driver must still make only one bounded launch for B");
  } finally {
    supervisor.close();
  }
});

test("browser driver opens a nonce-tagged URL in Brave or the default browser, never a keyboard daemon", async () => {
  if (process.platform === "win32") return;
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
          PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true",
          PI_LLM_GATEWAY_CONNECTOR_NAME: browser === "brave-browser.desktop" ? "My Coding Connector" : "PiLink Gateway" },
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
        assert.equal(url.searchParams.get("q"), browser === "brave-browser.desktop"
          ? "@My Coding Connector wake up" : "@PiLink Gateway wake up");
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

test("a failed idle wake cannot suppress a later queued request after ChatGPT sleeps", async () => {
  const lastExchange = new Date(Date.now() - 10_000).toISOString();
  let state = status({ queued: 0, state: "active", next_action: "poll",
    worker_contact: "recent", last_exchange_at: lastExchange });
  let opens = 0;
  let polls = 0;
  const supervisor = startGatewayAutoWakeSupervisor({
    store: { status: async () => { polls++; return state; } },
    env: { WAYLAND_DISPLAY: "wayland-0", PI_LLM_GATEWAY_ENABLED: "true", PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" },
    platform: "linux", driver: { wake: async () => { opens++; } }, pollIntervalMs: 5,
    suspendedPollMs: 5, wakeGraceMs: 0, confirmationMs: 30, log: () => {},
  });
  assert.ok(supervisor);
  try {
    await eventually(() => polls > 0); // observe the initial active worker
    assert.equal(opens, 0);
    state = status({ queued: 0, worker_contact: "stale", last_exchange_at: lastExchange });
    await eventually(() => opens === 1);
    await new Promise((resolve) => setTimeout(resolve, 70)); // first wake failed and is paused
    assert.equal(opens, 1);
    state = { ...state, queued: 1, oldest_queue_age_ms: 10_000 };
    await eventually(() => opens === 2);
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(opens, 2); // no tab storm for the same queued condition
  } finally {
    supervisor.close();
  }
});

test("a hidden queued-request replacement rearms once without rearming for an append", async () => {
  const requestA = "req_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const requestB = "req_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let state = status({ oldest_queue_request_id: requestA });
  let opens = 0;
  const logs = [];
  const supervisor = startGatewayAutoWakeSupervisor({
    store: { status: async () => state },
    env: { WAYLAND_DISPLAY: "wayland-0", PI_LLM_GATEWAY_ENABLED: "true",
      PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" },
    platform: "linux", driver: { wake: async () => { opens++; } },
    pollIntervalMs: 5, suspendedPollMs: 5, wakeGraceMs: 0, confirmationMs: 30,
    log: (line) => logs.push(line),
  });
  assert.ok(supervisor);
  try {
    await eventually(() => logs.filter((line) => /no worker contact/.test(line)).length === 1);
    assert.equal(opens, 1);

    // A was removed and B was enqueued entirely between supervisor polls. The
    // queue count never appears as zero, but the oldest queued request changed.
    state = status({ oldest_queue_request_id: requestB });
    await eventually(() => opens === 2);
    await eventually(() => logs.filter((line) => /no worker contact/.test(line)).length === 2);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(opens, 2, "unchanged B must stay suppressed after its bounded attempt");

    // C is appended behind B: queue depth changes, but the oldest request does
    // not, so this is still the same wake condition.
    state = status({ queued: 2, oldest_queue_request_id: requestB });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(opens, 2, "appending behind B must not rearm auto-wake");
  } finally {
    supervisor.close();
  }
});

test("a temporary suppression does not retry a failed wake for the same stranded queue", async () => {
  let state = status();
  let opens = 0;
  let polls = 0;
  const logs = [];
  const supervisor = startGatewayAutoWakeSupervisor({
    store: { status: async () => { polls++; return state; } },
    env: { WAYLAND_DISPLAY: "wayland-0", PI_LLM_GATEWAY_ENABLED: "true",
      PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" },
    platform: "linux", driver: { wake: async () => { opens++; } },
    pollIntervalMs: 5, suspendedPollMs: 5, wakeGraceMs: 0, confirmationMs: 30,
    log: (line) => logs.push(line),
  });
  assert.ok(supervisor);
  try {
    await eventually(() => logs.some((line) => /no worker contact/.test(line)));
    assert.equal(opens, 1);
    state = status({ worker_polling: true, next_action: "wait_for_worker" });
    const before = polls;
    await eventually(() => polls > before + 1);
    state = status(); // Same queue, no new exchange; do not grant another attempt.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(opens, 1);
    state = status({ state: "active", worker_contact: "recent", next_action: "poll",
      last_exchange_at: new Date(Date.now() - 10_000).toISOString(), oldest_queue_age_ms: 10_000 });
    await eventually(() => opens === 2); // A genuinely new exchange is eligible.
  } finally {
    supervisor.close();
  }
});

test("recent-but-idle worker wakes a waiting request and confirms only new contact", async () => {
  let state = status({ state: "active", worker_contact: "recent", next_action: "poll",
    last_exchange_at: new Date(Date.now() - 10_000).toISOString(), oldest_queue_age_ms: 6_000 });
  let opens = 0;
  const logs = [];
  const supervisor = startGatewayAutoWakeSupervisor({
    store: { status: async () => state },
    env: { WAYLAND_DISPLAY: "wayland-0", PI_LLM_GATEWAY_ENABLED: "true", PILINK_GATEWAY_LAUNCH: "true", PI_LLM_GATEWAY_AUTO_WAKE: "true" },
    platform: "linux", driver: { wake: async () => { opens++; } }, pollIntervalMs: 5,
    wakeGraceMs: 0, confirmationMs: 100, log: (line) => logs.push(line),
  });
  assert.ok(supervisor);
  try {
    await eventually(() => opens === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(logs.some((line) => /worker contact confirmed/.test(line)), false);
    state = { ...state, last_exchange_at: new Date().toISOString(),
      worker_polling: true, next_action: "wait_for_worker" };
    await eventually(() => logs.some((line) => /worker contact confirmed/.test(line)));
    assert.equal(opens, 1);
  } finally {
    supervisor.close();
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
