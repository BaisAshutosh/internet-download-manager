// popup.js
const backendEndpoint = "http://localhost:8000/download"; // change if your backend uses another URL

const urlSelect = document.getElementById("urlSelect");
const filenameInput = document.getElementById("filename");
const formatInput = document.getElementById("format");
const manualUrlInput = document.getElementById("manualUrl");
const sendBtn = document.getElementById("sendBtn");
const refreshBtn = document.getElementById("refreshBtn");
const clearBtn = document.getElementById("clearBtn");
const backendElem = document.getElementById("backendUrl");

backendElem.textContent = backendEndpoint;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendExtensionMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("[Mini-IDM] Message error:", chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

// Ask the active tab's content script to rescan, optionally resetting its seen-URL cache
function triggerContentScan(resetSeen = false) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      chrome.tabs.sendMessage(
        tabs[0].id,
        { force_scan: true, reset_seen: resetSeen },
        () => { /* ignore */ }
      );
    }
  });
}

// ─── List management ─────────────────────────────────────────────────────────

async function loadList() {
  const resp = await sendExtensionMessage({ type: "GET_LIST" });
  populateSelect(resp && resp.list ? resp.list : []);
}

function populateSelect(list) {
  urlSelect.innerHTML = "";
  if (!list || list.length === 0) {
    const opt = document.createElement("option");
    opt.text = "No streams detected yet";
    opt.disabled = true;
    opt.selected = true;
    urlSelect.appendChild(opt);
    return;
  }
  list.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item.url;
    const method = (item.meta && item.meta.method) || "unknown";
    const displayUrl = item.url.length > 60 ? item.url.substring(0, 57) + "..." : item.url;
    opt.text = `[${method}] ${displayUrl}`;
    opt.title = item.url;
    urlSelect.appendChild(opt);
  });
  urlSelect.selectedIndex = 0;
}

// ─── Button handlers ─────────────────────────────────────────────────────────

sendBtn.addEventListener("click", async () => {
  let selected = manualUrlInput.value.trim() || urlSelect.value;
  if (!selected || urlSelect.options[0]?.disabled) {
    alert("Select a URL or paste one manually");
    return;
  }

  let url = selected;

  // Blob URLs exist only in browser memory — swap for the page URL so yt-dlp can handle it
  if (url.startsWith("blob:")) {
    const ok = confirm(
      "The selected URL is a blob URL (browser-local) and cannot be downloaded directly.\n" +
      "Send the current page URL to the downloader instead?"
    );
    if (!ok) return;

    url = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs && tabs[0] ? tabs[0].url : null);
      });
    });

    if (!url) {
      alert("Unable to determine the current page URL. Please open the video page and try again.");
      return;
    }
  }

  const filename = filenameInput.value.trim() || undefined;
  const format   = formatInput.value.trim()   || undefined;

  sendBtn.disabled    = true;
  sendBtn.textContent = "Sending…";

  try {
    const res = await fetch(backendEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, filename, quality: format }),
    });

    if (!res.ok) {
      alert("Backend error: " + (await res.text()));
    } else {
      const data = await res.json();
      alert("Sent to downloader! Download ID: " + data.id);
      if (!manualUrlInput.value.trim()) {
        sendExtensionMessage({ type: "REMOVE_URL", url: selected });
      }
      manualUrlInput.value = "";
      loadList();
    }
  } catch (err) {
    alert("Failed to reach backend: " + err.message);
  } finally {
    sendBtn.disabled    = false;
    sendBtn.textContent = "Send to Downloader";
  }
});

refreshBtn.addEventListener("click", () => {
  // Rescan without resetting — user just wants to poll for newly loaded streams
  triggerContentScan(false);
  // Small delay to let the scan complete before we pull the updated list
  setTimeout(loadList, 600);
});

clearBtn.addEventListener("click", async () => {
  // 1. Clear storage
  await sendExtensionMessage({ type: "CLEAR_LIST" });
  // 2. Reload the (now-empty) list immediately
  await loadList();
  // 3. KEY FIX: tell the content script to forget every URL it has seen,
  //    then rescan — so URLs will be re-reported from scratch.
  triggerContentScan(true /* reset_seen */);
});

// ─── Background push updates ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "UPDATED_LIST") loadList();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

// Small delay to make sure the background service worker is ready
setTimeout(() => {
  loadList();
  triggerContentScan(false);
}, 150);