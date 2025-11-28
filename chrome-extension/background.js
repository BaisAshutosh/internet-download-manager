// background.js (service worker)
const STORAGE_KEY = "mini_idm_detected_urls";

// Debug logging
const DEBUG = false;
function log(...args) {
  if (DEBUG) console.log("[Mini-IDM-BG]", ...args);
}

log("Background service worker loaded");

// helper: read list from storage
async function readList() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (res) => {
      resolve(
        res[STORAGE_KEY] && Array.isArray(res[STORAGE_KEY])
          ? res[STORAGE_KEY]
          : []
      );
    });
  });
}

// helper: write list to storage
async function writeList(list) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: list }, () => resolve());
  });
}

// add a detected url (dedupe)
async function addDetected(url, meta = {}) {
  if (!url) {
    log("Skipping empty URL");
    return;
  }
  log("addDetected called with:", url);
  const list = await readList();
  // normalize
  const normalized = url.split("?")[0];
  const exists = list.find(
    (item) => item.url === url || item.url.split("?")[0] === normalized
  );
  if (exists) {
    log("URL already exists, updating metadata");
    // update meta/timestamp
    exists.lastSeen = Date.now();
    exists.meta = Object.assign({}, exists.meta || {}, meta);
  } else {
    log("Adding new URL to list");
    list.unshift({
      url,
      meta: meta || {},
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });
    // keep list to reasonable length
    if (list.length > 120) list.splice(120);
  }
  await writeList(list);
  log("Notifying clients of list update");
  // notify popup(s)
  chrome.runtime.sendMessage({ type: "UPDATED_LIST" }).catch(() => {
    // ignore if no listener
  });
}

// handle messages from content / popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  log("Message received:", msg.type, "from", sender.url);
  if (!msg || !msg.type) return;
  if (msg.type === "DETECTED_URL") {
    log("Processing DETECTED_URL:", msg.url);
    addDetected(msg.url, msg.meta || {});
  } else if (msg.type === "CLEAR_LIST") {
    log("Clearing list");
    writeList([]).then(() =>
      chrome.runtime.sendMessage({ type: "UPDATED_LIST" }).catch(() => {})
    );
  } else if (msg.type === "GET_LIST") {
    log("GET_LIST requested");
    readList().then((list) => {
      log("Sending list with", list.length, "items");
      sendResponse({ list });
    });
    // indicates we'll send response asynchronously
    return true;
  } else if (msg.type === "REMOVE_URL") {
    log("REMOVE_URL:", msg.url);
    readList().then((list) => {
      const filtered = list.filter((i) => i.url !== msg.url);
      writeList(filtered).then(() =>
        chrome.runtime.sendMessage({ type: "UPDATED_LIST" }).catch(() => {})
      );
    });
  }
});

// optional: onInstalled cleanup
chrome.runtime.onInstalled.addListener(() => {
  // ensure storage key exists
  readList().then((list) => {
    if (!list) writeList([]);
  });
});
