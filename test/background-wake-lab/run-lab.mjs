#!/usr/bin/env node
/**
 * Repeatable test script for Background Wake Lab MV3 Fixture.
 *
 * Strict Isolation Guarantees:
 * 1. Uses a unique --user-data-dir created strictly inside this worktree under test/background-wake-lab/.
 * 2. Never accesses the user's real Brave profile (~/.config/BraveSoftware/...) or home directory.
 * 3. Never loads ChatGPT or external/cloud endpoints; only loads the local MV3 synthetic test page.
 * 4. Never captures desktop screenshots; captures ONLY the local synthetic test page via CDP Page.captureScreenshot.
 * 5. Cleans up processes and temporary data cleanly within the worktree.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXTENSION_DIR = __dirname;
const SCREENSHOT_PATH = path.join(__dirname, "fixture.png");
const RESULT_PATH = path.join(__dirname, "result.json");

// Helper to get an available TCP port on localhost
async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

// Locate Brave (or Chromium-based) browser binary
async function findBrowserBinary() {
  const candidates = [
    process.env.BRAVE_BIN,
    "brave-browser",
    "brave",
    "/usr/bin/brave-browser",
    "/usr/bin/brave",
    "/opt/brave.com/brave/brave-browser",
    "/snap/bin/brave",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome"
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const resolved = execFileSync("which", [candidate], { encoding: "utf8", timeout: 1000 }).trim();
      if (resolved) {
        return resolved;
      }
    } catch {
      // Not found, continue
    }
  }

  // Check direct file existence if which failed
  const { existsSync } = await import("node:fs");
  for (const candidate of candidates) {
    if (candidate.startsWith("/") && existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("No Brave or Chromium browser binary found in PATH or standard locations.");
}

// Simple CDP JSON-RPC client over WebSocket
class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.pending = new Map();
  }

  async connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.ws) this.ws.close();
        reject(new Error(`WebSocket connection timeout to ${this.wsUrl}`));
      }, timeoutMs);

      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        }
      };
    });
  }

  async send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }
  }
}

async function waitForHttp(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      // wait and retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

async function run() {
  console.log("=== Bounded Background Wake Lab Experiment ===");

  const browserBin = await findBrowserBinary();
  console.log(`[Lab] Browser binary resolved: ${browserBin}`);

  // Guarantee unique user-data-dir strictly within worktree test/background-wake-lab/
  const labTmpBase = path.join(__dirname, ".tmp-run");
  await mkdir(labTmpBase, { recursive: true });
  const uniqueUserDataDir = await mkdtemp(path.join(labTmpBase, "brave-profile-"));
  console.log(`[Lab] Unique isolated user-data-dir: ${uniqueUserDataDir}`);

  const port = await getAvailablePort();
  console.log(`[Lab] CDP remote debugging port: ${port}`);

  const chromeArgs = [
    "--headless=new",
    `--user-data-dir=${uniqueUserDataDir}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-client-side-phishing-detection",
    "--disable-domain-reliability",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--disable-gpu",
    "about:blank"
  ];

  console.log(`[Lab] Spawning browser with isolated configuration...`);
  const browserProc = spawn(browserBin, chromeArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false
  });

  let browserStderr = "";
  browserProc.stderr.on("data", (data) => {
    browserStderr += data.toString();
  });

  const cleanup = async () => {
    console.log("[Lab] Cleaning up browser process and temporary directories...");
    try {
      browserProc.kill("SIGTERM");
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
    try {
      browserProc.kill("SIGKILL");
    } catch {}
    try {
      await rm(uniqueUserDataDir, { recursive: true, force: true });
    } catch {}
  };

  try {
    // Wait for CDP endpoint to respond
    console.log("[Lab] Waiting for CDP endpoint...");
    const versionInfo = await waitForHttp(`http://127.0.0.1:${port}/json/version`, 15000);
    console.log(`[Lab] Connected to browser: ${versionInfo["Browser"]} (User-Agent: ${versionInfo["User-Agent"]})`);

    // Poll targets for the created page.html tab
    console.log("[Lab] Polling for background tab creation by extension...");
    let pageTarget = null;
    let initialTabTarget = null;
    let allTargets = [];

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      allTargets = await waitForHttp(`http://127.0.0.1:${port}/json/list`, 5000);
      pageTarget = allTargets.find((t) => t.url && t.url.includes("page.html"));
      initialTabTarget = allTargets.find((t) => t.url === "about:blank");
      if (pageTarget) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    if (!pageTarget) {
      throw new Error(`Extension did not create page.html tab within timeout. Targets found: ${JSON.stringify(allTargets)}`);
    }

    console.log(`[Lab] Found created synthetic page target: ${pageTarget.id} (${pageTarget.url})`);

    // Connect CDP session to browser to query extension tab active state
    const browserWs = new CdpSession(versionInfo.webSocketDebuggerUrl);
    await browserWs.connect();

    // Query extension background worker target
    const serviceWorkerTarget = allTargets.find((t) => t.type === "service_worker" || (t.url && t.url.includes("service-worker.js")));
    console.log(`[Lab] Service worker target:`, serviceWorkerTarget ? serviceWorkerTarget.id : "none");

    // Connect directly to the synthetic test page target
    const pageWs = new CdpSession(pageTarget.webSocketDebuggerUrl);
    await pageWs.connect();

    // Verify document visibility / active state from the page target itself
    await pageWs.send("Runtime.enable");
    const evalVisibility = await pageWs.send("Runtime.evaluate", {
      expression: "({ visibilityState: document.visibilityState, hasFocus: document.hasFocus() })",
      returnByValue: true
    });
    const visibilityInfo = evalVisibility.result.value;
    console.log(`[Lab] Page state: visibilityState='${visibilityInfo.visibilityState}', hasFocus=${visibilityInfo.hasFocus}`);

    // Verify via Target.getTargets to check active / target state
    const targetListResult = await browserWs.send("Target.getTargets");
    const pageTargetMeta = targetListResult.targetInfos.find((t) => t.url.includes("page.html"));

    // Also check extension tab query via service worker if available
    let extensionTabQueryResult = null;
    if (serviceWorkerTarget) {
      try {
        const swWs = new CdpSession(serviceWorkerTarget.webSocketDebuggerUrl);
        await swWs.connect();
        await swWs.send("Runtime.enable");
        const evalSw = await swWs.send("Runtime.evaluate", {
          expression: "new Promise((res) => chrome.tabs.get(createdTabId, (tab) => res(tab)))",
          awaitPromise: true,
          returnByValue: true
        });
        extensionTabQueryResult = evalSw.result.value;
        console.log(`[Lab] Extension tabs API query result:`, extensionTabQueryResult);
        swWs.close();
      } catch (err) {
        console.log(`[Lab] Could not query extension tabs directly from SW: ${err.message}`);
      }
    }

    const tabIsInactive = extensionTabQueryResult?.active === false;
    if (!tabIsInactive) throw new Error("Chrome tabs API did not independently confirm active=false");
    console.log("[Lab] Tab inactive verification: PASSED (chrome.tabs reports active=false)");

    // Capture screenshot of ONLY the local synthetic test page
    console.log(`[Lab] Capturing screenshot of local synthetic test page to ${SCREENSHOT_PATH}...`);
    await pageWs.send("Page.enable");
    const screenshotResult = await pageWs.send("Page.captureScreenshot", {
      format: "png"
    });

    const buffer = Buffer.from(screenshotResult.data, "base64");
    await writeFile(SCREENSHOT_PATH, buffer);
    console.log(`[Lab] Screenshot successfully written to ${SCREENSHOT_PATH} (${buffer.length} bytes)`);

    pageWs.close();
    browserWs.close();

    const labResult = {
      success: true,
      browserBinary: browserBin,
      isolatedUserDataDir: uniqueUserDataDir,
      tabCreated: true,
      tabUrl: pageTarget.url,
      tabActive: extensionTabQueryResult ? extensionTabQueryResult.active : false,
      tabVisibilityState: visibilityInfo.visibilityState,
      tabHasFocus: visibilityInfo.hasFocus,
      verifiedInactive: tabIsInactive,
      screenshotPath: SCREENSHOT_PATH,
      screenshotSizeBytes: buffer.length,
      timestamp: new Date().toISOString()
    };

    await writeFile(RESULT_PATH, JSON.stringify(labResult, null, 2), "utf8");
    console.log(`[Lab] Results saved to ${RESULT_PATH}`);
    console.log("=== Experiment Complete ===");
    return labResult;
  } catch (err) {
    console.error("[Lab] Experiment failed:", err);
    if (browserStderr) {
      console.error("[Lab] Browser stderr:", browserStderr.slice(-1000));
    }
    throw err;
  } finally {
    await cleanup();
  }
}

run().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
