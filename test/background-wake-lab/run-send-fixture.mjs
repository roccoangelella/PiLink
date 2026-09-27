#!/usr/bin/env node
// Isolated, network-blocked Chromium test of the REAL PiLink content script in
// an inactive tab with a synthetic ChatGPT-shaped page. No real ChatGPT access.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, "../../browser-extension");
const nonce = "0123456789abcdef0123456789abcdef";
const url = `https://chatgpt.com/?q=${encodeURIComponent("@PiLink Gateway wake up")}&pilink_wake=${nonce}`;
const html = `<!doctype html><meta charset="utf-8"><title>Synthetic background wake</title>
<style>body{font:18px system-ui;color:white;background:#121923;margin:38px}textarea{display:block;width:90%;height:95px;margin:22px 0}button{padding:12px}</style>
<h1>Local synthetic ChatGPT fixture: no real network</h1>
<form><textarea id="prompt-textarea">@PiLink Gateway wake up</textarea>
<button type="button" id="composer-submit-button" onclick="window.fixtureClicks++;document.getElementById('result').textContent='Clicked once: '+window.fixtureClicks">Send</button></form>
<p id="result">Not clicked</p><script>window.fixtureClicks=0;</script>`;

class Cdp {
  constructor(ws) {
    this.ws = new WebSocket(ws);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.ws.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) this.events.get(msg.method)?.(msg.params);
    };
  }
  async ready() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timeout")), 8000);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP socket failed")); };
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function getJson(url, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const response = await fetch(url); if (response.ok) return response.json(); } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Isolated Brave CDP did not start");
}

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "pilink-background-send-"));
  const port = await freePort();
  const brave = process.env.BRAVE_BIN || "/usr/bin/brave";
  const browser = spawn(brave, [
    "--headless=new", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1", `--load-extension=${extension}`,
    `--disable-extensions-except=${extension}`, "--no-first-run", "--no-default-browser-check",
    "--disable-sync", "--disable-background-networking", "--disable-component-update",
    "--disable-gpu", "--proxy-server=http=127.0.0.1:1;https=127.0.0.1:1",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
    "about:blank",
  ], { stdio: "ignore" });
  let control, page;
  try {
    const version = await getJson(`http://127.0.0.1:${port}/json/version`);
    control = new Cdp(version.webSocketDebuggerUrl);
    await control.ready();
    await control.send("Target.createTarget", { url: "about:blank" });
    const target = await control.send("Target.createTarget", { url: "about:blank", background: true });
    let pageInfo;
    for (let i = 0; i < 50; i++) {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      pageInfo = targets.find((entry) => entry.id === target.targetId);
      if (pageInfo?.webSocketDebuggerUrl) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(pageInfo?.webSocketDebuggerUrl, "background target must have a CDP socket");
    page = new Cdp(pageInfo.webSocketDebuggerUrl);
    await page.ready();
    page.events.set("Fetch.requestPaused", (event) => {
      // Fail closed: only our exact fake wake navigation gets fixture HTML.
      const params = event.request.url === url
        ? { requestId: event.requestId, responseCode: 200,
            responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
            body: Buffer.from(html).toString("base64") }
        : { requestId: event.requestId, errorReason: "BlockedByClient" };
      const method = event.request.url === url ? "Fetch.fulfillRequest" : "Fetch.failRequest";
      void page.send(method, params).catch(() => {});
    });
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await page.send("Page.enable");
    await page.send("Page.navigate", { url });
    let result;
    for (let i = 0; i < 70; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const evaluated = await page.send("Runtime.evaluate", {
        expression: "({clicks:window.fixtureClicks ?? null,focus:document.hasFocus(),visibility:document.visibilityState,badge:Array.from(document.querySelectorAll('div')).find(e=>e.textContent?.startsWith('PiLink wake:'))?.textContent ?? null})",
        returnByValue: true,
      });
      result = evaluated.result.value;
      if (result?.clicks === 1) break;
    }
    assert.equal(result.visibility, "hidden", "the synthetic tab must be inactive");
    assert.equal(result.focus, false, "the synthetic tab must not hold focus");
    assert.equal(result.clicks, 1, `content script did not click in the isolated background tab: ${JSON.stringify(result)}`);
    const image = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await fs.writeFile(path.join(here, "send-background.png"), Buffer.from(image.data, "base64"));
    console.log(JSON.stringify({ ...result, syntheticOnly: true, screenshot: "test/background-wake-lab/send-background.png" }));
  } finally {
    page?.close(); control?.close();
    browser.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (browser.exitCode === null) browser.kill("SIGKILL");
    await fs.rm(profile, { recursive: true, force: true });
  }
}

await main();
