// popup.js
const BACKEND = "http://localhost:8000";

const urlSelect    = document.getElementById("urlSelect");
const metaPanel    = document.getElementById("metaPanel");
const metaLoading  = document.getElementById("metaLoading");
const metaContent  = document.getElementById("metaContent");
const metaFallback = document.getElementById("metaFallback");
const metaTitle    = document.getElementById("metaTitle");
const metaDuration = document.getElementById("metaDuration");
const formatSelect = document.getElementById("formatSelect");
const filenameInput = document.getElementById("filename");
const manualUrlInput = document.getElementById("manualUrl");
const sendBtn      = document.getElementById("sendBtn");
const refreshBtn   = document.getElementById("refreshBtn");
const clearBtn     = document.getElementById("clearBtn");

document.getElementById("backendUrl").textContent = BACKEND;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendExtensionMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("[Mini-IDM]", chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

function triggerContentScan(resetSeen = false) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { force_scan: true, reset_seen: resetSeen }, () => {});
    }
  });
}

// ─── URL list ─────────────────────────────────────────────────────────────────

async function loadList() {
  const resp = await sendExtensionMessage({ type: "GET_LIST" });
  populateSelect(resp && resp.list ? resp.list : []);
}

function populateSelect(list) {
  urlSelect.innerHTML = "";
  hideMetaPanel();

  if (!list || list.length === 0) {
    const opt = document.createElement("option");
    opt.text = "No streams detected yet";
    opt.disabled = true;
    opt.selected = true;
    urlSelect.appendChild(opt);
    return;
  }

  list.forEach((item) => {
    const opt  = document.createElement("option");
    opt.value  = item.url;

    const meta   = item.meta || {};
    const method = meta.method   || "unknown";
    const host   = meta.pageHost || "";

    // Primary: page title if captured, else hostname
    let primary = meta.pageTitle
      ? (meta.pageTitle.length > 50 ? meta.pageTitle.slice(0, 47) + "…" : meta.pageTitle)
      : (host || "Unknown page");

    // Format badge from URL extension
    const lu = item.url.toLowerCase();
    let fmt = "stream";
    if      (lu.includes(".m3u8")) fmt = "HLS";
    else if (lu.includes(".mpd"))  fmt = "DASH";
    else if (lu.includes(".mp4"))  fmt = "MP4";
    else if (lu.includes(".webm")) fmt = "WebM";
    else if (lu.includes(".mkv"))  fmt = "MKV";
    else if (lu.includes(".ts"))   fmt = "TS";

    opt.text  = `${primary}  [${fmt} · ${method}]`;
    opt.title = item.url;
    urlSelect.appendChild(opt);
  });

  urlSelect.selectedIndex = 0;
  // Auto-fetch meta for the first item
  fetchMeta(urlSelect.value);
}

// ─── Meta fetching ────────────────────────────────────────────────────────────

// Track the URL we last requested so stale responses are ignored
let _currentMetaUrl = null;

function hideMetaPanel() {
  metaPanel.style.display = "none";
  metaContent.style.display = "none";
  metaLoading.style.display = "flex";
  metaFallback.style.display = "none";
}

async function fetchMeta(url) {
  if (!url) return;
  _currentMetaUrl = url;

  metaPanel.style.display = "block";
  metaLoading.style.display = "flex";
  metaContent.style.display = "none";
  metaFallback.style.display = "none";

  let data;
  try {
    const r = await fetch(`${BACKEND}/meta?url=${encodeURIComponent(url)}`);
    data = await r.json();
  } catch (e) {
    // Backend unreachable — show minimal fallback
    if (_currentMetaUrl !== url) return;
    metaLoading.style.display = "none";
    metaFallback.style.display = "block";
    metaFallback.textContent = "Could not reach backend for metadata.";
    return;
  }

  // Ignore if user already switched to a different URL
  if (_currentMetaUrl !== url) return;

  metaLoading.style.display = "none";

  if (data.error && !data.title && (!data.formats || data.formats.length <= 1)) {
    // Complete failure — show fallback message
    metaFallback.style.display = "block";
    metaFallback.textContent = "Metadata unavailable for this URL — select quality manually below.";
    // Switch to manual format input
    showManualFormat();
    return;
  }

  // Populate meta panel
  metaTitle.textContent    = data.title    || "Unknown title";
  metaDuration.textContent = data.duration ? `⏱ ${data.duration}` : "";

  // Populate format dropdown
  formatSelect.innerHTML = "";
  (data.formats || []).forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.format_str;
    opt.text  = f.label;
    formatSelect.appendChild(opt);
  });

  metaContent.style.display = "block";

  // Auto-fill filename from title if the field is empty or still has the
  // previous auto-filled value (i.e. user hasn't typed their own name)
  if (data.title && !filenameInput.dataset.userEdited) {
    filenameInput.value = data.title;
  }
}

// If meta fails, show a plain text input for the format string
function showManualFormat() {
  // Replace formatSelect area with a plain input if not already done
  if (document.getElementById("formatManual")) return;
  const input = document.createElement("input");
  input.id          = "formatManual";
  input.placeholder = "e.g. bestvideo+bestaudio/best";
  input.style.cssText = "width:100%;padding:7px 9px;margin-top:6px;background:#1a1e28;"
    + "border:1px solid rgba(180,200,215,0.12);border-radius:6px;color:#c8d8e4;font-size:12px;outline:none;";
  metaPanel.appendChild(input);
  metaPanel.style.display = "block";
}

// Track whether user manually edited the filename
filenameInput.addEventListener("input", () => {
  filenameInput.dataset.userEdited = filenameInput.value ? "1" : "";
});

// Fetch meta whenever selection changes
urlSelect.addEventListener("change", () => {
  filenameInput.dataset.userEdited = "";   // reset so new title can auto-fill
  fetchMeta(urlSelect.value);
});

// ─── Send to downloader ───────────────────────────────────────────────────────

sendBtn.addEventListener("click", async () => {
  let url = manualUrlInput.value.trim() || urlSelect.value;

  // Guard: disabled placeholder selected
  if (!url || (urlSelect.options[0] && urlSelect.options[0].disabled && !manualUrlInput.value.trim())) {
    alert("Select a stream or paste a URL manually.");
    return;
  }

  // Blob URL → swap for current page URL
  if (url.startsWith("blob:")) {
    const ok = confirm(
      "The selected URL is a blob URL (browser-local) and cannot be downloaded directly.\n"
      + "Send the current page URL to the downloader instead?"
    );
    if (!ok) return;
    url = await new Promise((res) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        res(tabs && tabs[0] ? tabs[0].url : null);
      });
    });
    if (!url) {
      alert("Could not determine the current page URL.");
      return;
    }
  }

  // Determine quality: formatSelect (if populated) → manual input → default
  const formatManual = document.getElementById("formatManual");
  let quality = formatSelect.options.length
    ? formatSelect.value
    : (formatManual ? formatManual.value.trim() : "");
  quality = quality || "bestvideo+bestaudio/best";

  const filename = filenameInput.value.trim() || undefined;

  // Title comes from meta panel if available
  const title = metaTitle.textContent !== "Unknown title" ? metaTitle.textContent : "";

  sendBtn.disabled    = true;
  sendBtn.textContent = "Sending…";

  try {
    const res = await fetch(`${BACKEND}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, filename, quality, title }),
    });

    if (!res.ok) {
      alert("Backend error: " + (await res.text()));
    } else {
      const data = await res.json();
      alert(`Queued! Download ID: #${data.id}`);
      if (!manualUrlInput.value.trim()) {
        sendExtensionMessage({ type: "REMOVE_URL", url });
      }
      manualUrlInput.value = "";
      filenameInput.value = "";
      filenameInput.dataset.userEdited = "";
      hideMetaPanel();
      loadList();
    }
  } catch (err) {
    alert("Failed to reach backend: " + err.message);
  } finally {
    sendBtn.disabled    = false;
    sendBtn.textContent = "Send to Downloader";
  }
});

// ─── Refresh / Clear ─────────────────────────────────────────────────────────

refreshBtn.addEventListener("click", () => {
  triggerContentScan(false);
  setTimeout(loadList, 600);
});

clearBtn.addEventListener("click", async () => {
  await sendExtensionMessage({ type: "CLEAR_LIST" });
  await loadList();
  triggerContentScan(true /* reset_seen */);
});

// ─── Background push updates ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "UPDATED_LIST") loadList();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

setTimeout(() => {
  loadList();
  triggerContentScan(false);
}, 150);