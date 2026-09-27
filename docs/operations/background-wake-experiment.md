# Background wake experiment (not enabled in PiLink)

The production gateway still launches Brave with `--new-window` so its installed content script can submit the exact wake message. This branch contains **only an isolated proof of concept**, not a working replacement for that driver.

## What the experiment establishes

`test/background-wake-lab/` contains an MV3 extension fixture, a synthetic extension page, and a headless Brave/CDP runner using a fresh temporary browser profile in that folder. It never contacts ChatGPT or uses the normal Brave profile. Run `node test/background-wake-lab/run-lab.mjs` and inspect `fixture.png`; the test also checks `chrome.tabs.get(createdTabId).active === false`. The Chromium tab can be created inactive with `chrome.tabs.create({active:false})` **without `tabs` permission**. Antigravity independently inspected the synthetic screenshot and test result. The screenshot is a rendering of the synthetic page, not a desktop capture or proof of a live ChatGPT wake.

## Unresolved before enabling this in production

1. **Authenticated trigger:** The gateway is a local Node process, not a Chrome extension. It cannot invoke `chrome.tabs.create` directly. An MV3 service worker needs a narrow, authenticated gateway→extension channel. Native Messaging would require a separately registered host, a stable extension ID in its `allowed_origins`, and the new `nativeMessaging` browser permission. Loopback polling instead requires additional localhost host permissions and careful origin, token, replay, lifecycle, and abuse protections. Do not introduce unauthenticated endpoints or DevTools remote debugging on the real browser profile.
2. **Real worker delivery:** This fixture loads a tiny extension page. Inactive `chatgpt.com` tabs may delay loading, freeze or be discarded; a background tab containing a prefilled message might never run the content script or send the message. Only a real, consented end-to-end test with the user's account and verified gateway worker contact can establish this.
3. **Lifecycle:** A successful trigger should deduplicate or clean up wake tabs without reading unrelated tabs or chat contents. Fallback to the existing foreground/manual flow must be explicit and must never synthesize a global Enter key.

The user's existing PiLink setup, Brave profile, and ChatGPT session are not modified by this experiment. Do not ship or enable background wake on the basis of the synthetic screenshot alone.
