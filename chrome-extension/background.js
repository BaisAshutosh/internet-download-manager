const STORAGE_KEY = "mini_idm_detected_urls";

const DEBUG = false;
function log(...args) {
  if (DEBUG) console.log("[Mini-IDM-BG]", ...args);
}

log("Background service worker loaded");


async function readList() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (res) => {
      resolve(Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : []);
    });
  });
}

async function writeList(list) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: list }, resolve);
  });
}

function notifyListUpdated() {
  chrome.runtime.sendMessage({ type: "UPDATED_LIST" }).catch(() => {});
}

// ─── Core operations ─────────────────────────────────────────────────────────

async function addDetected(url, meta = {}) {
  if (!url) return;
  log("addDetected:", url);
  const list = await readList();
  const normalized = url.split("?")[0];
  const existing = list.find(
    (item) => item.url === url || item.url.split("?")[0] === normalized
  );
  if (existing) {
    existing.lastSeen = Date.now();
    existing.meta = Object.assign({}, existing.meta || {}, meta);
  } else {
    list.unshift({ url, meta: meta || {}, firstSeen: Date.now(), lastSeen: Date.now() });
    if (list.length > 120) list.splice(120);
  }
  await writeList(list);
  notifyListUpdated();
}

// ─── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  log("Message:", msg.type);

  switch (msg.type) {
    case "DETECTED_URL":
      addDetected(msg.url, msg.meta || {});
      break;

    case "GET_LIST":
      readList().then((list) => sendResponse({ list }));
      return true; // async response

    case "CLEAR_LIST":
      writeList([]).then(notifyListUpdated);
      break;

    case "REMOVE_URL":
      readList().then((list) => {
        writeList(list.filter((i) => i.url !== msg.url)).then(notifyListUpdated);
      });
      break;
  }
});

// ─── Install hook ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  readList(); // ensure key exists
});