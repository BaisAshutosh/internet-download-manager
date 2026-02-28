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


// Send message with timeout to avoid "Receiving end does not exist" error
function sendExtensionMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        // ignore connection errors (background not ready yet)
        console.warn("[Mini-IDM] Message error:", chrome.runtime.lastError);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

async function loadList() {
  const resp = await sendExtensionMessage({ type: "GET_LIST" });
  const list = resp && resp.list ? resp.list : [];
  populateSelect(list);
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
  list.forEach((item, idx) => {
    const opt = document.createElement("option");
    opt.value = item.url;
    const method = (item.meta && item.meta.method) || "unknown";
    // truncate long URLs
    const displayUrl =
      item.url.length > 60
        ? item.url.substring(0, 57) + "..."
        : item.url;
    opt.text = `[${method}] ${displayUrl}`;
    opt.title = item.url; // full URL on hover
    urlSelect.appendChild(opt);
  });
  if (list.length > 0) urlSelect.selectedIndex = 0;
}

// send selected URL to backend
sendBtn.addEventListener("click", async () => {
  // prioritize manual URL if provided, else use select
  let selected = manualUrlInput.value.trim() || urlSelect.value;
  if (!selected) {
    alert("Select a URL or paste one manually");
    return;
  }

  // If the detected URL is a blob: URL, it exists only in the browser's memory.
  // Prompt the user to send the active tab's page URL (e.g. the watch page) instead.
  let url = selected;
  if (typeof url === "string" && url.startsWith("blob:")) {
    const ok = confirm(
      "The selected URL is a blob URL (browser-local) and cannot be downloaded directly. Send the current page URL to the downloader instead?"
    );
    if (!ok) return;

    // get active tab page URL
    url = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || !tabs[0]) return resolve(null);
        resolve(tabs[0].url);
      });
    });

    if (!url) {
      alert(
        "Unable to determine the current page URL. Please open the video page and try again."
      );
      return;
    }
  }
  const filename = filenameInput.value.trim() || undefined;
  const format = formatInput.value.trim() || undefined;

  sendBtn.disabled = true;
  sendBtn.textContent = "Sending...";

  try {
    const res = await fetch(backendEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, filename, quality: format }),
    });

    if (!res.ok) {
      const txt = await res.text();
      alert("Backend error: " + txt);
    } else {
      const data = await res.json();
      alert("Sent to downloader! Download ID: " + data.id);
      // optional: remove the sent URL from list
      if (!manualUrlInput.value.trim()) {
        chrome.runtime.sendMessage({ type: "REMOVE_URL", url: selected });
      }
      loadList();
      manualUrlInput.value = ""; // clear manual input
    }
  } catch (err) {
    alert("Failed to reach backend: " + err.message);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "Send to Downloader";
  }
});

refreshBtn.addEventListener("click", () => loadList());
clearBtn.addEventListener("click", () => {
  sendExtensionMessage({ type: "CLEAR_LIST" });
  loadList();
});

// listen for updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "UPDATED_LIST") {
    loadList();
  }
});

// initial load with a small delay to ensure background is ready
setTimeout(() => {
  loadList();
  // force a content script scan for immediate detection
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { force_scan: true }, (resp) => {
        // ignore
      });
    }
  });
}, 100);
