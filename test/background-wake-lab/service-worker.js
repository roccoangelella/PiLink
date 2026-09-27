// Service worker for Background Wake Lab MV3 Fixture
const TARGET_PAGE_URL = chrome.runtime.getURL("page.html");

let createdTabId = null;
let createdTabInfo = null;

async function createBackgroundTab() {
  try {
    const tab = await chrome.tabs.create({
      url: TARGET_PAGE_URL,
      active: false
    });
    createdTabId = tab.id;
    createdTabInfo = {
      id: tab.id,
      url: tab.url,
      active: tab.active,
      status: tab.status,
      timestamp: Date.now()
    };
    console.log("[MV3 Fixture] chrome.tabs.create called with active:false", createdTabInfo);
    return tab;
  } catch (err) {
    console.error("[MV3 Fixture] Failed to create tab:", err);
    throw err;
  }
}

// Automatically create tab when extension is installed/loaded
chrome.runtime.onInstalled.addListener(() => {
  console.log("[MV3 Fixture] onInstalled event received");
  createBackgroundTab();
});

// Also support messaging for status inspection or re-triggering
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CREATE_TAB") {
    createBackgroundTab().then((tab) => sendResponse({ ok: true, tab })).catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message.type === "GET_STATUS") {
    if (createdTabId) {
      chrome.tabs.get(createdTabId, (tab) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, tab });
        }
      });
      return true;
    } else {
      sendResponse({ ok: false, error: "No tab created yet" });
    }
  }
});
