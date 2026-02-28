(() => {
  let seenUrls = new Set();

  const DEBUG = false;
  function log(...args) {
    if (DEBUG) console.log("[Mini-IDM]", ...args);
  }

  log("Content script loaded on:", window.location.href);

  // ─── Utility ────────────────────────────────────────────────────────────────

  function reportFound(url, meta = {}) {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    log("Reporting URL:", url, "via method:", meta.method);
    chrome.runtime.sendMessage({ type: "DETECTED_URL", url, meta });
  }

  // ─── Scanners ────────────────────────────────────────────────────────────────

  // 1) <video> tags and <source> children
  function scanVideoTags() {
    document.querySelectorAll("video").forEach((v) => {
      const src = v.currentSrc || v.src;
      if (src && !src.startsWith("blob:")) reportFound(src, { method: "video_tag" });

      v.querySelectorAll("source").forEach((s) => {
        if (s.src) reportFound(s.src, { method: "video_source" });
      });

      ["data-src", "data-hls", "data-mpd", "data-video"].forEach((attr) => {
        const val = v.getAttribute && v.getAttribute(attr);
        if (val) reportFound(val, { method: "data_attr", attr });
      });
    });
  }

  // 2) Performance resource entries — catches network requests the page already made
  const VIDEO_PATTERN = /\.(m3u8|mpd|m4s|m4v|mp4|mkv|webm|ts|mov|avi)(\?|$)/i;
  const STREAM_PATTERN = /(videoplayback|\/chunk|\/seg[_\-/]|\/hls\/|\/dash\/)/i;

  function scanPerformanceResources() {
    try {
      (performance.getEntriesByType("resource") || []).forEach((e) => {
        const url = e.name || "";
        if (VIDEO_PATTERN.test(url) || STREAM_PATTERN.test(url)) {
          reportFound(url, { method: "perf_entry", initiatorType: e.initiatorType || null });
        }
      });
    } catch (err) {
      log("Error scanning performance resources:", err.message);
    }
  }

  // 3) Inline <script> tag content scan (Hls.js / dash.js config, etc.)
  function scanScriptTags() {
    try {
      document.querySelectorAll("script").forEach((script) => {
        if (!script.textContent) return;
        const matches = script.textContent.match(
          /(https?:\/\/[^\s"'<>]+\.(?:m3u8|mpd|mp4|mkv|webm|ts|m4s|m4v)(?:\?[^\s"'<>]*)?)/gi
        );
        if (matches) matches.forEach((m) => reportFound(m, { method: "script_tag" }));
      });
    } catch (e) {
      log("Error scanning script tags:", e.message);
    }
  }

  // 4) Common window-level player config objects
  function scanPlayerConfigs() {
    try {
      [
        window.playerConfig, window.videoData, window.streamUrls,
        window.__player, window.__VIDEO_CONFIG__, window.jwplayer && window.jwplayer().getConfig(),
      ].forEach((cfg) => {
        if (!cfg) return;
        try {
          const matches = JSON.stringify(cfg).match(
            /(https?:\/\/[^\s"<>]+\.(?:m3u8|mpd|mp4|mkv|webm|ts|m4s|m4v)(?:\?[^\s"<>]*)?)/gi
          );
          if (matches) matches.forEach((m) => reportFound(m, { method: "player_config" }));
        } catch (_) {}
      });
    } catch (e) {
      log("Error scanning player configs:", e.message);
    }
  }

  // 5) Blob URL correlation — find the underlying manifest that MSE players use
  function correlateBlobURLs() {
    try {
      document.querySelectorAll("video").forEach((v) => {
        const src = v.currentSrc || v.src || "";
        if (!src.startsWith("blob:")) return;
        const resources = performance.getEntriesByType("resource") || [];
        const candidates = resources
          .filter((r) => {
            const n = (r.name || "").toLowerCase();
            return n.includes(".mpd") || n.includes(".m3u8") || n.includes(".m4s") || n.includes(".ts");
          })
          .sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
        if (candidates.length > 0) {
          reportFound(candidates[0].name, { method: "blob_correlate", blob: src });
        }
      });
    } catch (e) {
      log("Error correlating blob URLs:", e.message);
    }
  }

  // ─── Network interception (fetch + XHR) ─────────────────────────────────────

  function interceptNetworkRequests() {
    try {
      const origFetch = window.fetch;
      window.fetch = function (...args) {
        const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        if (url && (VIDEO_PATTERN.test(url) || STREAM_PATTERN.test(url))) {
          log("Fetch intercept:", url);
          reportFound(url, { method: "fetch_intercept" });
        }
        return origFetch.apply(this, args);
      };

      const origXHROpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        if (typeof url === "string" && (VIDEO_PATTERN.test(url) || STREAM_PATTERN.test(url))) {
          log("XHR intercept:", url);
          reportFound(url, { method: "xhr_intercept" });
        }
        return origXHROpen.apply(this, [method, url, ...rest]);
      };

      log("Network interception installed");
    } catch (e) {
      log("Error setting up network interception:", e.message);
    }
  }

  // ─── Orchestration ───────────────────────────────────────────────────────────

  // Debounced scan runner — avoids spamming on rapid DOM mutations
  let scanTimer = null;
  function scheduleScan(immediate = false) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      log("=== Running scans ===");
      scanVideoTags();
      scanPlayerConfigs();
      scanScriptTags();
      scanPerformanceResources();
      correlateBlobURLs();
      log("=== Scans complete ===");
    }, immediate ? 0 : 400);
  }

  // Run immediately and on page load
  interceptNetworkRequests(); // install first so we catch early requests
  scheduleScan(true);
  window.addEventListener("load", () => scheduleScan(true));

  // MutationObserver — debounced so rapid DOM changes don't cause a flood
  try {
    const obs = new MutationObserver(() => scheduleScan(false));
    obs.observe(document.documentElement || document.body || document, {
      childList: true,
      subtree: true,
    });
    log("MutationObserver installed");
  } catch (e) {
    log("Error installing MutationObserver:", e.message);
  }

  // ─── Message listener (from popup) ───────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;

    if (msg.force_scan) {
      // wipe seenUrls so all previously detected URLs get re-reported.
      if (msg.reset_seen) {
        log("Resetting seenUrls cache");
        seenUrls = new Set();
      }
      log("Force scan requested from popup");
      scheduleScan(true);
      sendResponse({ ok: true });
    }
  });
})();