// content.js
(() => {
  const REPORT_THROTTLE_MS = 800;
  let lastReport = 0;
  let seenUrls = new Set();

  // Debug logging
  const DEBUG = true;
  function log(...args) {
    if (DEBUG) console.log("[Mini-IDM]", ...args);
  }

  log("Content script loaded on:", window.location.href);

  // Utility to store a detected URL in extension storage via background
  function reportFound(url, meta = {}) {
    if (!url || seenUrls.has(url)) return; // dedupe
    seenUrls.add(url);
    log("Reporting URL:", url, "via method:", meta.method);
    chrome.runtime.sendMessage({ type: "DETECTED_URL", url, meta });
  }

  // 1) Detect <video> tags and <source> children
  function scanVideoTags() {
    const videos = Array.from(document.querySelectorAll("video"));
    log("Scan video tags: found", videos.length, "video elements");
    videos.forEach((v) => {
      // v.currentSrc may be the resolved src (works for many cases)
      const src = v.currentSrc || v.src;
      if (src) {
        log("Video tag src:", src);
        reportFound(src, { method: "video_tag" });
      }

      // check <source> children
      const sources = v.querySelectorAll("source");
      log("Video has", sources.length, "source children");
      sources.forEach((s) => {
        if (s.src) {
          log("Source element src:", s.src);
          reportFound(s.src, { method: "video_source" });
        }
      });

      // Some players attach data attributes
      ["data-src", "data-hls", "data-mpd", "data-video"].forEach((attr) => {
        const val = v.getAttribute && v.getAttribute(attr);
        if (val) {
          log("Video data attribute", attr, ":", val);
          reportFound(val, { method: "data_attr", attr });
        }
      });
    });
  }

  // 1b) Detect URLs in common video player scripts and configurations
  function scanPlayerScripts() {
    try {
      // Look for window.playerConfig, window.videoData, window.streamUrls, etc.
      const playerConfigs = [
        window.playerConfig,
        window.videoData,
        window.streamUrls,
        window.__player,
        window.__VIDEO_CONFIG__,
      ];

      playerConfigs.forEach((cfg) => {
        if (!cfg) return;
        const cfgStr = JSON.stringify(cfg);
        // extract URLs that look like m3u8, mpd, mp4, mkv, webm, or start with http
        const urlPattern =
          /(https?:\/\/[^\s"<>]+\.(?:m3u8|mpd|mp4|mkv|webm|ts|m4s|m4v|avi|mov)(?:\?[^\s"<>]*)?)/gi;
        const matches = cfgStr.match(urlPattern);
        if (matches) {
          log("Found URLs in player config:", matches.length);
          matches.forEach((m) => reportFound(m, { method: "player_config" }));
        }
      });
    } catch (e) {
      log("Error scanning player scripts:", e.message);
    }
  }

  // 1c) Scan for <script> tags that might contain URLs (Hls.js, dash.js config, etc.)
  function scanScriptTags() {
    try {
      const scripts = Array.from(document.querySelectorAll("script"));
      log("Scanning", scripts.length, "script tags");
      scripts.forEach((script) => {
        if (!script.textContent) return;
        const text = script.textContent;
        // look for m3u8, mpd, mp4 URLs in script text
        const urlPattern =
          /(https?:\/\/[^\s"'<>]+\.(?:m3u8|mpd|mp4|mkv|webm|ts|m4s|m4v)(?:\?[^\s"'<>]*)?)/gi;
        const matches = text.match(urlPattern);
        if (matches) {
          log("Found URLs in script tag:", matches.length);
          matches.forEach((m) => reportFound(m, { method: "script_tag" }));
        }
      });
    } catch (e) {
      log("Error scanning script tags:", e.message);
    }
  }

  // 2) Detect network-level streaming manifests / segments via performance entries
  function scanPerformanceResources() {
    try {
      const entries = performance.getEntriesByType("resource") || [];
      log("Performance entries:", entries.length);
      entries.forEach((e) => {
        const url = e.name || "";
        // Lowercase match
        const lu = url.toLowerCase();
        if (
          lu.includes(".m3u8") ||
          lu.includes(".mpd") ||
          lu.includes(".m4s") ||
          lu.includes(".m4sf") ||
          lu.includes(".ts") ||
          lu.includes("videoplayback") ||
          lu.includes("/chunk") ||
          lu.includes("/seg")
        ) {
          log("Found in perf entry:", url);
          reportFound(url, {
            method: "perf_entry",
            initiatorType: e.initiatorType || null,
          });
        }
      });
    } catch (err) {
      log("Error scanning performance resources:", err.message);
    }
  }

  // 2b) Intercept fetch/XHR requests to detect manifest requests
  function interceptNetworkRequests() {
    try {
      const origFetch = window.fetch;
      const origXHROpen = XMLHttpRequest.prototype.open;

      window.fetch = function (...args) {
        const url = args[0];
        if (typeof url === "string") {
          const lu = url.toLowerCase();
          if (
            lu.includes(".m3u8") ||
            lu.includes(".mpd") ||
            lu.includes(".m4s") ||
            lu.includes(".ts")
          ) {
            log("Fetch intercept:", url);
            reportFound(url, { method: "fetch_intercept" });
          }
        }
        return origFetch.apply(this, args);
      };

      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        if (typeof url === "string") {
          const lu = url.toLowerCase();
          if (
            lu.includes(".m3u8") ||
            lu.includes(".mpd") ||
            lu.includes(".m4s") ||
            lu.includes(".ts")
          ) {
            log("XHR intercept:", url);
            reportFound(url, { method: "xhr_intercept" });
          }
        }
        return origXHROpen.apply(this, [method, url, ...rest]);
      };
      log("Network interception installed");
    } catch (e) {
      log("Error setting up network interception:", e.message);
    }
  }

  // 3) Attempt to correlate blob:video URLs with real network resource
  //    Many MSE players create blob: URLs; the underlying manifest/segments are visible in performance entries.
  function correlateBlobURLs() {
    // If there are <video src="blob:...">, look up recent .mpd/.m3u8 in performance entries
    try {
      document.querySelectorAll("video").forEach((v) => {
        const src = v.currentSrc || v.src || "";
        if (src && src.startsWith("blob:")) {
          // try to find last manifest-like resource
          const resources = performance.getEntriesByType("resource") || [];
          // right-most manifest/playlist/seg should be recent — pick latest by startTime
          const candidates = resources
            .filter((r) => {
              const n = (r.name || "").toLowerCase();
              return (
                n.includes(".mpd") ||
                n.includes(".m3u8") ||
                n.includes(".m4s") ||
                n.includes(".ts")
              );
            })
            .sort((a, b) => (b.startTime || 0) - (a.startTime || 0));

          if (candidates.length > 0) {
            // report the manifest and the blob (so backend knows blob was used)
            reportFound(candidates[0].name, {
              method: "blob_correlate",
              blob: src,
            });
          } else {
            // fallback: send the blob itself so user can try (some backends can handle blob or attempt fetch)
            reportFound(src, { method: "blob_direct" });
          }
        }
      });
    } catch (e) {
      // ignore
    }
  }

  // Combine scans and throttle reporting frequency
  function runScans() {
    const now = Date.now();
    if (now - lastReport < REPORT_THROTTLE_MS) return;
    lastReport = now;

    log("=== Running scans ===");
    scanVideoTags();
    scanPlayerScripts();
    scanScriptTags();
    scanPerformanceResources();
    correlateBlobURLs();
    log("=== Scans complete ===");
  }

  // Run initial scan immediately
  log("Running initial scan");
  runScans();

  // MutationObserver for new nodes (dynamically loaded players)
  const obs = new MutationObserver((mutations) => {
    log("DOM mutation detected, running scan");
    runScans();
  });
  try {
    obs.observe(document.documentElement || document.body || document, {
      childList: true,
      subtree: true,
    });
    log("MutationObserver installed");
  } catch (e) {
    log("Error installing MutationObserver:", e.message);
  }

  // Poll performance entries regularly (to catch network manifest loads)
  setInterval(runScans, 1000);
  log("Polling installed (1s interval)");

  // Intercept fetch/XHR for manifest detection
  try {
    interceptNetworkRequests();
  } catch (e) {
    log("Error with network interception:", e.message);
  }

  // Also listen for messages from popup to force a scan
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.force_scan) {
      log("Force scan requested from popup");
      runScans();
      sendResponse({ ok: true });
    }
  });
})();
