/**
 * content.js — Content Script (Revised with research-backed selectors)
 * Runs on leetcode.com/problems/* pages.
 * Detects submissions, extracts code + metadata, injects the overlay UI.
 *
 * Key architecture notes:
 * - Code extraction uses an injected page-context script to access monaco API
 * - Submission results intercepted via network (most reliable)
 * - Falls back to DOM scraping for all data points
 *
 * UX FIXES APPLIED:
 * FIX #1:  FAB moved to bottom-right corner (always visible, discoverable)
 * FIX #2:  Toast shown for non-Accepted submissions
 * FIX #6:  Cycling loading messages
 * FIX #7:  Contextual error actions (settings button for NO_API_KEY, countdown for 429)
 * FIX #10: Keyboard nav — Escape closes panel, scroll-to-top on section switch
 * FIX #11: History search + difficulty filter
 * FIX #12: Complexity color gauge
 * FIX #15: SVG icons in stat cards instead of emoji
 * FIX #17: Smells block alignment fix (flex column)
 * FIX #18: History skeleton loading
 * FIX #19: Scroll-to-top on section switch
 */

(function () {
  "use strict";

  // ─── State ─────────────────────────────────────────────────────────────────
  let overlayInjected = false;
  let lastSubmissionId = null;
  let isAnalyzing = false;
  let submitPending = false;
  let currentProblemMeta = {};
  let pendingCode = "";
  let pendingLanguage = "";
  let _loadingMsgInterval = null;
  let _hasAnalysisResult = false;  // Track whether a real analysis has been rendered

  // ─── Init ──────────────────────────────────────────────────────────────────
  function init() {
    extractProblemMeta();
    injectPageContextBridge();
    injectOverlay();
    hookSubmitButton();
    interceptSubmissionNetwork();
    startPollingFallback();
    watchSPANavigation();
    console.log("[LCI] Content script initialized on:", currentProblemMeta.problemTitle);
  }

  // ─── Page Context Bridge ───────────────────────────────────────────────────
  function injectPageContextBridge() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("bridge.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);

    window.addEventListener("__lci_submission_result", (e) => {
      handleSubmissionResultData(e.detail);
    });
  }

  function requestCodeFromPageContext() {
    return new Promise((resolve) => {
      const onResponse = (e) => {
        window.removeEventListener("__lci_code_response", onResponse);
        resolve(e.detail);
      };
      window.addEventListener("__lci_code_response", onResponse);
      window.dispatchEvent(new Event("__lci_request_code"));
      setTimeout(() => {
        window.removeEventListener("__lci_code_response", onResponse);
        resolve({ code: null, lang: null });
      }, 2000);
    });
  }

  // ─── Problem Meta Extraction ───────────────────────────────────────────────
  function extractProblemMeta() {
    currentProblemMeta = {
      problemTitle: extractProblemTitle(),
      difficulty: extractDifficulty(),
    };
  }

  function extractProblemTitle() {
    const strategies = [
      () => document.querySelector('[data-cy="question-title"]')?.textContent?.trim(),
      () => document.querySelector('[data-e2e-locator="question-title"]')?.textContent?.trim(),
      () => document.querySelector("div.text-title-large")?.textContent?.trim(),
      () => document.querySelector("h1")?.textContent?.trim(),
      () => {
        const match = window.location.pathname.match(/\/problems\/([^/]+)/);
        if (match) {
          return match[1].split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
        }
        return null;
      },
      () => document.title?.replace(/ - LeetCode.*/, "").trim(),
    ];
    for (const fn of strategies) {
      try {
        const r = fn();
        if (r && r.length > 0 && r.length < 200) return r;
      } catch {}
    }
    return "Unknown Problem";
  }

  function extractDifficulty() {
    const selectors = [
      '[data-cy="difficulty"]',
      '[data-e2e-locator="difficulty"]',
      '[class*="text-difficulty-"]',
      '[class*="difficulty" i]',
    ];
    for (const selector of selectors) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent?.trim().match(/\b(easy|medium|hard)\b/i)?.[1];
          if (text) return text[0].toUpperCase() + text.slice(1).toLowerCase();
          const classMatch = String(el.className || "").match(/difficulty-(easy|medium|hard)/i);
          if (classMatch) return classMatch[1][0].toUpperCase() + classMatch[1].slice(1).toLowerCase();
        }
      } catch {}
    }

    // Last resort for older LeetCode layouts; only exact badge text qualifies.
    const candidates = document.querySelectorAll("span, div, p, button, [role]");
    for (const el of candidates) {
      const txt = (el.getAttribute("aria-label") || el.textContent || "").trim();
      if (["Easy", "Medium", "Hard"].includes(txt)) return txt;
    }
    return "Unknown";
  }

  // ─── Submit Button Hook ────────────────────────────────────────────────────
  function hookSubmitButton() {
    const findAndHook = () => {
      const selectors = [
        '[data-e2e-locator="console-submit-button"]',
        '[data-cy="submit-button"]',
      ];
      let btn = null;
      for (const sel of selectors) {
        btn = document.querySelector(sel);
        if (btn) break;
      }
      if (!btn) {
        const buttons = document.querySelectorAll("button");
        for (const b of buttons) {
          if (b.textContent?.trim() === "Submit") { btn = b; break; }
        }
      }
      if (btn && !btn.__lciHooked) {
        btn.__lciHooked = true;
        btn.addEventListener("click", async () => {
          _lastAnalysisKey = '';
          lastSubmissionId = null;
          isAnalyzing = false;
          submitPending = true;
          hideFABBadge();
          window.dispatchEvent(new Event('__lci_submit_clicked'));

          const result = await requestCodeFromPageContext();
          if (result.code) {
            pendingCode = result.code;
            pendingLanguage = result.lang ? mapModeIdToLanguage(result.lang) : extractLanguageFromDOM();
          } else {
            pendingCode = extractCodeFallback();
            pendingLanguage = extractLanguageFromDOM();
          }
          sessionStorage.setItem("lci_pending_code", pendingCode);
          sessionStorage.setItem("lci_pending_lang", pendingLanguage);
          console.log('[LCI] Submit clicked — code captured, waiting for result...');
        });
        return true;
      }
      return false;
    };
    if (!findAndHook()) {
      const obs = new MutationObserver(() => findAndHook());
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  // ─── Network Interception ──────────────────────────────────────────────────
  function interceptSubmissionNetwork() {
    startDOMObserver();
  }

  function startDOMObserver() {
    const observer = new MutationObserver(
      debounce(() => {
        if (!submitPending || isAnalyzing) return;
        chrome.storage.local.get("lci_auto_analyze", (data) => {
          if (data.lci_auto_analyze !== false) checkDOMForResult();
        });
      }, 500)
    );
    observer.observe(document.body, { childList: true, subtree: true, characterData: false });
  }

  let pollingInterval = null;
  function startPollingFallback() {
    window.addEventListener('__lci_submit_clicked', () => {
      if (pollingInterval) clearInterval(pollingInterval);
      chrome.storage.local.get("lci_auto_analyze", (data) => {
        if (data.lci_auto_analyze === false) return;
        let attempts = 0;
        pollingInterval = setInterval(() => {
          attempts++;
          if (attempts > 30) {
            clearInterval(pollingInterval);
            pollingInterval = null;
            submitPending = false;
            return;
          }
          if (!isAnalyzing) checkDOMForResult();
        }, 2000);
      });
    });
  }

  function stopPolling() {
    if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
  }

  // ─── Dedup key ─────────────────────────────────────────────────────────────
  let _lastAnalysisKey = '';

  function checkDOMForResult(force = false, bypassCache = false) {
    if (!submitPending && !force) return;

    const resultEl = document.querySelector('[data-e2e-locator="submission-result"]');
    const verdict = resultEl?.textContent?.trim();

    if (!verdict || verdict === 'Checking...' || verdict === '') return;

    if (verdict.toLowerCase() !== 'accepted') {
      submitPending = false;
      stopPolling();
      // FIX #2: Show non-intrusive toast for non-Accepted submissions
      if (force) {
        showOverlay();
        sendToOverlay({ type: "ERROR", error: "Only successful (Accepted) submissions can be analyzed." });
      } else {
        showVerdictToast(verdict);
      }
      return;
    }

    const key = `${currentProblemMeta.problemTitle}::${verdict}`;
    if (!force && key === _lastAnalysisKey) return;
    _lastAnalysisKey = key;

    submitPending = false;
    stopPolling();
    console.log('[LCI] DOM detected verdict:', verdict);
    // Use dedicated runtime extractor (polls until stats appear or 8 s timeout)
    const seedStats = {
      runtime: document.querySelector('[data-e2e-locator="submission-runtime"]')?.textContent?.trim() || null,
      memory:  document.querySelector('[data-e2e-locator="submission-memory"]')?.textContent?.trim()  || null,
    };
    triggerAnalysis({ status_msg: verdict, ...seedStats }, bypassCache, true /*useExtractor*/);
  }

  async function handleSubmissionResultData(data) {
    if (isAnalyzing) return;
    if (!data?.status_msg || data.status_msg === "Pending") return;
    if (!submitPending) return;

    if (data.status_msg.toLowerCase() !== 'accepted') {
      submitPending = false;
      // FIX #2: Show toast for non-Accepted on network path too
      showVerdictToast(data.status_msg);
      return;
    }

    const subId = data.submission_id || data.id ||
      `${currentProblemMeta.problemTitle}::${data.status_msg}`;
    if (subId === lastSubmissionId) {
      console.log('[LCI] Duplicate network event, skipping:', subId);
      return;
    }
    lastSubmissionId = subId;
    submitPending = false;
    chrome.storage.local.get("lci_auto_analyze", (dataStorage) => {
      if (dataStorage.lci_auto_analyze !== false) {
        // Network data may have percentiles but DOM stats not yet painted —
        // useExtractor=true polls for actual runtime/memory values
        triggerAnalysis(data, false, true /*useExtractor*/);
      } else {
        console.log('[LCI] Auto-analyze is disabled. Click the FAB button to analyze.');
        // FIX #2: Show FAB with badge indicating analysis is ready on demand
        showFABBadge("Click ⚡");
      }
    });
  }

  // ─── Analysis Trigger ──────────────────────────────────────────────────────
  /**
   * @param {object}  resultData      – partial data already known (verdict, runtime, etc.)
   * @param {boolean} bypassCache     – skip cache lookup
   * @param {boolean} useExtractor    – when true, call LCIRuntimeExtractor to
   *                                   reliably poll for runtime/memory before
   *                                   sending the analysis request
   */
  async function triggerAnalysis(resultData, bypassCache = false, useExtractor = false) {
    isAnalyzing = true;
    try {
      if (!resultData) resultData = {};
      let code = "";
      let language = "";
      try {
        code = sessionStorage.getItem("lci_pending_code") || pendingCode;
        language = sessionStorage.getItem("lci_pending_lang") || pendingLanguage;
        if (language?.trim().toLowerCase() === "unknown") language = "";
      } catch (e) {
        code = pendingCode;
        language = pendingLanguage;
      }
      if (!code) {
        const fresh = await requestCodeFromPageContext();
        code = fresh.code || extractCodeFallback();
        language = fresh.lang ? mapModeIdToLanguage(fresh.lang) : extractLanguageFromDOM();
      }
      extractProblemMeta();
      const verdict = resultData.status_msg || "Unknown";

      // ── Show loading immediately so the user gets feedback ──────────────
      showOverlay();
      sendToOverlay({ type: "LOADING", payload: { problemTitle: currentProblemMeta?.problemTitle } });

      // ── Runtime / Memory resolution ──────────────────────────────────────
      let runtime, memory, runtimePercentile, memoryPercentile;

      if (useExtractor && window.LCIRuntimeExtractor) {
        // Dedicated extractor: polls the DOM with multiple strategies & retries
        const seed = {
          runtime:           resultData.runtime  || null,
          memory:            resultData.memory   || null,
          runtimePercentile: resultData.runtime_percentile
            ? `Beats ${parseFloat(resultData.runtime_percentile).toFixed(1)}% of users`
            : null,
          memoryPercentile: resultData.memory_percentile
            ? `Beats ${parseFloat(resultData.memory_percentile).toFixed(1)}% of users`
            : null,
        };
        const extracted = await window.LCIRuntimeExtractor.extract(seed);
        runtime           = extracted.runtime;
        memory            = extracted.memory;
        runtimePercentile = extracted.runtimePercentile;
        memoryPercentile  = extracted.memoryPercentile;
      } else {
        // Legacy single-shot path (network interception path already has values)
        runtime = resultData.runtime || extractStatFromDOM("runtime");
        memory  = resultData.memory  || extractStatFromDOM("memory");
        try {
          runtimePercentile = resultData.runtime_percentile
            ? `Beats ${parseFloat(resultData.runtime_percentile).toFixed(1)}% of users`
            : extractPercentileFromDOM("runtime");
        } catch { runtimePercentile = extractPercentileFromDOM("runtime"); }
        try {
          memoryPercentile = resultData.memory_percentile
            ? `Beats ${parseFloat(resultData.memory_percentile).toFixed(1)}% of users`
            : extractPercentileFromDOM("memory");
        } catch { memoryPercentile = extractPercentileFromDOM("memory"); }
      }

      const payload = {
        code: code || "(code unavailable)",
        language: mapModeIdToLanguage(language || extractLanguageFromDOM()),
        problemTitle: currentProblemMeta?.problemTitle || "Unknown Problem",
        difficulty: currentProblemMeta?.difficulty || "Unknown",
        verdict, runtime, memory, runtimePercentile, memoryPercentile, bypassCache,
      };

      chrome.runtime.sendMessage({ type: "ANALYZE_SUBMISSION", payload }, (response) => {
        if (chrome.runtime.lastError) {
          sendToOverlay({ type: "ERROR", error: "Extension communication error. Try reloading the page." });
          isAnalyzing = false;
          return;
        }
        if (response?.success) {
          sendToOverlay({ type: "ANALYSIS_RESULT", data: response.data });
        } else {
          sendToOverlay({ type: "ERROR", error: response?.error || "Analysis failed." });
        }
        isAnalyzing = false;
      });
    } catch (err) {
      console.error("[LCI] Error during analysis:", err);
      sendToOverlay({
        type: "ERROR",
        error: err?.message || String(err) || "Unexpected error. Please try again.",
      });
      isAnalyzing = false;
    }
  }

  // ─── Code Extraction Fallbacks ─────────────────────────────────────────────
  function extractCodeFallback() {
    try { const cm = document.querySelector(".CodeMirror"); if (cm?.CodeMirror) return cm.CodeMirror.getValue(); } catch {}
    try { const ta = document.querySelector(".monaco-editor textarea"); if (ta?.value?.trim()) return ta.value; } catch {}
    try {
      const lines = document.querySelectorAll(".view-lines .view-line");
      if (lines.length > 0) return Array.from(lines).map((l) => l.textContent).join("\n");
    } catch {}
    return "";
  }

  function extractLanguageFromDOM() {
    try {
      const modeId = document.querySelector(".monaco-editor")?.getAttribute("data-mode-id");
      if (modeId) return mapModeIdToLanguage(modeId);
    } catch {}
    const selectors = [
      '[data-cy="lang-select"] button',
      '[data-e2e-locator*="lang" i]',
      'button[id*="headlessui-listbox-button"]',
      'button[aria-label*="language" i]',
    ];
    for (const sel of selectors) {
      try {
        const txt = document.querySelector(sel)?.textContent?.trim();
        if (txt && isKnownLanguage(txt)) return mapModeIdToLanguage(txt);
      } catch {}
    }
    // LeetCode has changed the language picker markup several times. Search
    // visible button labels as a final fallback, matching known names exactly.
    for (const button of document.querySelectorAll("button")) {
      const text = button.textContent?.trim();
      if (text && isKnownLanguage(text)) return mapModeIdToLanguage(text);
    }
    return "Unknown";
  }

  function mapModeIdToLanguage(modeId) {
    const original = String(modeId || "").trim();
    const key = original.toLowerCase().split(/[ (]/, 1)[0].replace(/[\s_.-]/g, "");
    if (/^python\d*$/.test(key)) return "Python3";
    if (/^(cpp|cplusplus|c\+\+)\d*$/.test(key)) return "C++";
    const map = {
      javascript: "JavaScript", node: "JavaScript", nodejs: "JavaScript",
      typescript: "TypeScript", java: "Java",
      c: "C", csharp: "C#", go: "Go", golang: "Go", rust: "Rust",
      swift: "Swift", kotlin: "Kotlin", ruby: "Ruby", scala: "Scala",
      php: "PHP", dart: "Dart", elixir: "Elixir", r: "R",
      mysql: "MySQL", mssql: "MS SQL Server", oraclesql: "Oracle",
    };
    return map[key] || original || "Unknown";
  }

  function isKnownLanguage(str) {
    const normalized = String(str || "").trim().toLowerCase().split(/[ (]/, 1)[0].replace(/[\s_.-]/g, "");
    return [
      "python", "python3", "python311", "java", "cpp", "cplusplus", "c++", "c",
      "javascript", "node", "nodejs", "typescript", "go", "golang", "rust",
      "swift", "kotlin", "ruby", "scala", "php", "csharp", "elixir", "r",
      "dart", "mysql", "mssql", "oraclesql",
    ].includes(normalized);
  }

  function extractStatFromDOM(keyword) {
    try {
      const el = document.querySelector(`[data-e2e-locator="submission-${keyword}"]`);
      if (el) return el.textContent?.trim();
    } catch {}
    return null;
  }

  function extractPercentileFromDOM(keyword) {
    try {
      const resultPanel = document.querySelector('[data-e2e-locator="submission-result"]')?.closest('[class*="result"]') || document.querySelector('[data-e2e-locator="submission-result"]')?.parentElement?.parentElement || document.body;
      const text = resultPanel.innerText;
      const regex = new RegExp(`beats\\s+(\\d+\\.?\\d*)%[^\\n]{0,60}${keyword}`, "i");
      const altRegex = new RegExp(`${keyword}[^\\n]{0,60}beats\\s+(\\d+\\.?\\d*)%`, "i");
      const match = text.match(regex) || text.match(altRegex);
      if (match) return `Beats ${match[1]}% of users`;
    } catch {}
    return null;
  }

  // ─── SPA Navigation Watcher ────────────────────────────────────────────────
  function watchSPANavigation() {
    let lastUrl = window.location.href;
    let lastSlug = getProblemSlug(lastUrl);
    new MutationObserver(() => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        const currentSlug = getProblemSlug(currentUrl);
        if (currentSlug !== lastSlug) {
          lastSlug = currentSlug;
          isAnalyzing = false; lastSubmissionId = null; _lastAnalysisKey = '';
          _hasAnalysisResult = false;
          submitPending = false; stopPolling(); extractProblemMeta(); hookSubmitButton();
        } else {
          hookSubmitButton();
        }
      }
    }).observe(document.body, { subtree: true, childList: true });
  }

  function getProblemSlug(urlStr) {
    try { const url = new URL(urlStr); const match = url.pathname.match(/\/problems\/([^/]+)/); return match ? match[1] : null; } catch { return null; }
  }

  // ─── Overlay Injection ─────────────────────────────────────────────────────
  function injectOverlay() {
    if (overlayInjected) return;
    overlayInjected = true;
    const container = document.createElement("div");
    container.id = "lci-overlay-container";
    container.innerHTML = buildOverlayHTML();
    document.body.appendChild(container);
    attachOverlayListeners(container);
  }

  function buildOverlayHTML() {
    return `
<div id="lci-overlay" class="lci-hidden" role="dialog" aria-label="LeetCode Complexity Insight" aria-modal="false">
  <div class="lci-panel" id="lci-panel">
    <div class="lci-header" id="lci-drag-handle">
      <div class="lci-logo">
        <!-- FIX #4: Drag handle dots visual -->
        <div class="lci-drag-dots" aria-hidden="true">
          <span></span><span></span>
        </div>
        <span class="lci-logo-icon">⚡</span>
        <span class="lci-logo-text">Complexity Insight</span>
      </div>
      <div class="lci-header-actions">
        <button id="lci-home-btn" class="lci-icon-btn" title="Dashboard" aria-label="Open dashboard" tabindex="0">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 10 9-7 9 7"/><path d="M5 9v12h14V9"/><path d="M9 21v-7h6v7"/></svg>
        </button>
        <button id="lci-settings-btn" class="lci-icon-btn" title="Settings / API Key" aria-label="Settings" tabindex="0">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
        <button id="lci-history-btn" class="lci-icon-btn" title="View history" aria-label="View history" tabindex="0">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </button>
        <button id="lci-theme-btn" class="lci-icon-btn" title="Toggle theme" aria-label="Toggle theme" tabindex="0">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        </button>
        <button id="lci-minimize-btn" class="lci-icon-btn" title="Minimize" aria-label="Minimize panel" tabindex="0">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button id="lci-close-btn" class="lci-icon-btn" title="Close" aria-label="Close panel" tabindex="0">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>

    <div id="lci-content" class="lci-content">
      <!-- Loading (FIX #6: progress bar + cycling messages) -->
      <div id="lci-loading" class="lci-state-view lci-loading-view lci-hidden">
        <div class="lci-spinner-wrap">
          <div class="lci-spinner"></div>
        </div>
        <p class="lci-loading-text" id="lci-loading-text">Analyzing your submission…</p>
        <div class="lci-loading-bar-wrap">
          <div class="lci-loading-bar"></div>
        </div>
        <p id="lci-loading-sub" class="lci-loading-sub">Powered by Gemini AI</p>
      </div>

      <!-- Error (FIX #7: contextual action buttons) -->
      <div id="lci-error" class="lci-state-view lci-error-view lci-hidden">
        <div class="lci-error-icon">⚠️</div>
        <p id="lci-error-msg" class="lci-error-text">Something went wrong.</p>
        <div class="lci-error-actions" id="lci-error-actions">
          <button id="lci-retry-btn" class="lci-btn-secondary">Retry</button>
        </div>
        <span class="lci-error-countdown" id="lci-error-countdown"></span>
      </div>

      <!-- Settings View -->
      <div id="lci-settings" class="lci-settings-view lci-hidden">
        <div class="lci-settings-header">
          <button id="lci-settings-back-btn" class="lci-icon-btn" aria-label="Back" tabindex="0">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span class="lci-settings-title">Settings</span>
        </div>
        <div class="lci-settings-body">
          <div class="lci-settings-label">Gemini API Key</div>
          <div class="lci-settings-input-wrap">
            <input id="lci-api-key-input" type="password" class="lci-settings-input"
              placeholder="AIza… or AQ…" autocomplete="off" spellcheck="false"
              aria-label="Gemini API Key" />
            <button id="lci-api-vis-btn" class="lci-settings-vis-btn" title="Show/hide key" aria-label="Toggle key visibility">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
          <div class="lci-settings-actions">
            <button id="lci-api-save-btn" class="lci-settings-btn lci-settings-btn-primary">Save Key</button>
            <button id="lci-api-clear-btn" class="lci-settings-btn lci-settings-btn-ghost">Clear</button>
          </div>
          <div id="lci-api-feedback" class="lci-settings-feedback" aria-live="polite"></div>

          <!-- FIX #14: Model dropdown with description -->
          <div class="lci-settings-label" style="margin-top: 10px;">Model</div>
          <div class="lci-settings-select-wrap">
            <select id="lci-model-select" class="lci-settings-select" aria-label="Select Gemini Model">
              <option value="models/gemini-3.6-flash">Gemini 3.6 Flash (Default)</option>
              <option value="models/gemini-3.1-pro-preview">Gemini 3.1 Pro (Preview)</option>
            </select>
          </div>
          <div class="lci-settings-model-hint">Flash = fastest, free-tier friendly · Pro = most thorough, slower</div>

          <div class="lci-settings-note">
            🔒 Stored locally only. Code is sent to Google Gemini for analysis.
            <a class="lci-settings-link" href="#" id="lci-get-key-link">Get a free key ↗</a>
          </div>
          <div class="lci-settings-divider"></div>
          <div class="lci-settings-row">
            <div>
              <div class="lci-settings-toggle-label">Auto-analyze</div>
              <div class="lci-settings-toggle-sub">Analyze on each submission</div>
            </div>
            <label class="lci-toggle-switch" for="lci-toggle-auto-analyze">
              <input type="checkbox" id="lci-toggle-auto-analyze" checked />
              <span class="lci-toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <!-- Setup / No API Key -->
      <div id="lci-setup" class="lci-state-view lci-setup-view lci-hidden">
        <div class="lci-setup-icon">🔑</div>
        <h3 class="lci-setup-title">Setup Required</h3>
        <p class="lci-setup-desc">Add your Gemini API key to start analyzing submissions.</p>
        <button id="lci-open-settings-btn" class="lci-setup-open-btn">⚙ Open Settings</button>
        <a class="lci-setup-link" href="#" id="lci-get-key-link2">Get a free key ↗</a>
      </div>

      <!-- Home / Idle State (shown when no analysis is active) -->
      <div id="lci-home" class="lci-state-view lci-home-view lci-hidden">
        <div class="lci-home-icon">⚡</div>
        <h3 class="lci-home-title" id="lci-home-title">Ready to Analyze</h3>
        <p class="lci-home-desc">Submit a solution on LeetCode and the complexity analysis will appear here automatically.</p>
        <p class="lci-home-hint">Or click the ⚡ Analyze button after a successful submission.</p>
        <button id="lci-latest-analysis-btn" class="lci-setup-open-btn lci-hidden">View latest analysis</button>
      </div>

      <!-- Main Analysis -->
      <div id="lci-analysis" class="lci-analysis-view lci-hidden">

        <!-- § 1 Your Submission -->
        <section class="lci-section">
          <h2 class="lci-section-title"><span class="lci-sec-icon">📋</span>Your Submission</h2>
          <div class="lci-submission-meta">
            <div class="lci-meta-top">
              <span id="lci-problem-title" class="lci-problem-title"></span>
              <span id="lci-difficulty-badge" class="lci-diff-badge"></span>
            </div>
            <div class="lci-meta-chips">
              <span id="lci-lang-chip" class="lci-chip lci-chip-lang"></span>
              <span id="lci-verdict-badge" class="lci-verdict-badge"></span>
            </div>
          </div>
          <!-- FIX #15: SVG icons instead of emoji -->
          <div id="lci-stats-row" class="lci-stats-row lci-hidden">
            <div class="lci-stat-card">
              <svg class="lci-stat-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
              </svg>
              <div>
                <div class="lci-stat-value" id="lci-runtime-val">—</div>
                <div class="lci-stat-label">Runtime</div>
                <div class="lci-stat-pct" id="lci-runtime-pct"></div>
              </div>
            </div>
            <div class="lci-stat-card">
              <svg class="lci-stat-svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
              </svg>
              <div>
                <div class="lci-stat-value" id="lci-memory-val">—</div>
                <div class="lci-stat-label">Memory</div>
                <div class="lci-stat-pct" id="lci-memory-pct"></div>
              </div>
            </div>
          </div>
        </section>

        <!-- § 2 Complexity Analysis (FIX #12: color gauge) -->
        <section class="lci-section">
          <h2 class="lci-section-title"><span class="lci-sec-icon">📊</span>Complexity Analysis</h2>
          <div class="lci-complexity-grid">
            <div class="lci-complexity-card lci-time-card">
              <div class="lci-complexity-header">
                <span class="lci-complexity-label">Time</span>
                <div style="display:flex;align-items:center;gap:4px;">
                  <span class="lci-complexity-value" id="lci-time-complexity">—</span>
                  <span class="lci-complexity-gauge" id="lci-time-gauge" title="Complexity efficiency" aria-hidden="true"></span>
                </div>
              </div>
              <div class="lci-efficiency-bar" aria-hidden="true">
                <div class="lci-efficiency-marker" id="lci-time-marker"></div>
              </div>
              <p class="lci-complexity-reasoning" id="lci-time-reasoning" style="margin-top:8px;"></p>
            </div>
            <div class="lci-complexity-card lci-space-card">
              <div class="lci-complexity-header">
                <span class="lci-complexity-label">Space</span>
                <div style="display:flex;align-items:center;gap:4px;">
                  <span class="lci-complexity-value" id="lci-space-complexity">—</span>
                  <span class="lci-complexity-gauge" id="lci-space-gauge" title="Complexity efficiency" aria-hidden="true"></span>
                </div>
              </div>
              <div class="lci-efficiency-bar" aria-hidden="true">
                <div class="lci-efficiency-marker" id="lci-space-marker"></div>
              </div>
              <p class="lci-complexity-reasoning" id="lci-space-reasoning" style="margin-top:8px;"></p>
            </div>
          </div>
        </section>

        <!-- § 3 Insights (FIX #17: smells block alignment) -->
        <section class="lci-section">
          <h2 class="lci-section-title"><span class="lci-sec-icon">🔍</span>Insights</h2>
          <div class="lci-insight-row">
            <span class="lci-insight-label">Approach:</span>
            <span id="lci-approach-used" class="lci-chip lci-chip-approach"></span>
          </div>
          <div id="lci-patterns-block" class="lci-insight-row">
            <span class="lci-insight-label">Patterns:</span>
            <div id="lci-patterns-tags" class="lci-tags-row"></div>
          </div>
          <!-- FIX #17: Smells block now uses same flex pattern as other insight rows -->
          <div id="lci-smells-block" class="lci-smells-block">
            <span class="lci-insight-label">Watch out for:</span>
            <ul id="lci-smells-list" class="lci-smells-list"></ul>
          </div>
        </section>

        <!-- § 4 Suggested Approach -->
        <section class="lci-section">
          <h2 class="lci-section-title"><span class="lci-sec-icon">💡</span>Suggested Approach</h2>
          <div id="lci-no-suggestion" class="lci-optimal-badge lci-hidden">
            <span>✅</span>&nbsp;Your approach is already optimal!
          </div>
          <div id="lci-suggestion-content">
            <div class="lci-suggestion-header">
              <span id="lci-suggestion-name" class="lci-suggestion-name"></span>
              <div class="lci-sug-complexities">
                <span class="lci-chip lci-chip-time" id="lci-sug-time"></span>
                <span class="lci-chip lci-chip-space" id="lci-sug-space"></span>
              </div>
            </div>
            <dl class="lci-suggestion-body">
              <dt>Why better</dt>
              <dd id="lci-sug-why-better"></dd>
              <dt>Core insight</dt>
              <dd id="lci-sug-intuition"></dd>
            </dl>
            <div class="lci-why-matters" id="lci-why-matters-block">
              <span class="lci-why-icon">🌐</span>
              <p id="lci-sug-why-matters"></p>
            </div>
          </div>
        </section>

        <div id="lci-cache-notice" class="lci-cache-notice lci-hidden">
          ⚡ From cache &nbsp;·&nbsp;
          <button id="lci-refresh-btn" class="lci-link-btn">Re-analyze</button>
        </div>
      </div>

      <!-- History View (FIX #11: search + filter) -->
      <div id="lci-history" class="lci-history-view lci-hidden">
        <div class="lci-history-header">
          <button id="lci-history-back-btn" class="lci-icon-btn" aria-label="Back" tabindex="0">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span class="lci-history-title">History</span>
          <button id="lci-clear-history-btn" class="lci-link-btn lci-danger-link">Clear all</button>
        </div>
        <!-- FIX #11: Search + difficulty filter chips -->
        <div class="lci-history-search-bar">
          <input
            type="search"
            id="lci-history-search"
            class="lci-history-search-input"
            placeholder="Search problems…"
            aria-label="Search history"
          />
          <div class="lci-history-filter-chips">
            <button class="lci-filter-chip" data-filter="Easy" title="Filter Easy">E</button>
            <button class="lci-filter-chip" data-filter="Medium" title="Filter Medium">M</button>
            <button class="lci-filter-chip" data-filter="Hard" title="Filter Hard">H</button>
          </div>
        </div>
        <div id="lci-history-list" class="lci-history-list">
          <p class="lci-empty-state">No history yet. Submit a solution to get started!</p>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- FIX #1: FAB is now bottom-right pill, always visible -->
<button id="lci-fab" class="lci-hidden" title="Analyze this solution" aria-label="Analyze complexity">
  <span class="lci-fab-badge" id="lci-fab-badge"></span>
  <span class="lci-fab-icon">⚡</span>
  <span class="lci-fab-label">Analyze</span>
</button>

<!-- FIX #2: Toast for non-Accepted submissions -->
<div id="lci-toast" role="status" aria-live="polite"></div>
    `;
  }

  function attachOverlayListeners(container) {
    requestAnimationFrame(() => {
      const overlay = document.querySelector("#lci-overlay");
      const panel = document.querySelector("#lci-panel");
      const fab = document.querySelector("#lci-fab");
      const dragHandle = document.querySelector("#lci-drag-handle");
      const content = document.querySelector("#lci-content");

      // FIX #1: Show FAB immediately (bottom-right, always visible)
      fab?.classList.remove("lci-hidden");

      // Close — reveal the FAB again
      document.querySelector("#lci-close-btn")?.addEventListener("click", () => {
        overlay?.classList.add("lci-hidden");
        fab?.classList.remove("lci-hidden");
      });

      // Minimize
      document.querySelector("#lci-minimize-btn")?.addEventListener("click", () => {
        panel?.classList.toggle("lci-minimized");
      });

      // FIX #10: Escape key closes the panel
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !overlay?.classList.contains("lci-hidden")) {
          overlay?.classList.add("lci-hidden");
          fab?.classList.remove("lci-hidden");
        }
      });

      // Analyze FAB — open panel + manual fresh analysis
      fab?.addEventListener("click", () => {
        overlay?.classList.remove("lci-hidden");
        panel?.classList.remove("lci-minimized");
        fab?.classList.add("lci-hidden");
        hideFABBadge();
        isAnalyzing = false;
        lastSubmissionId = null;
        _lastAnalysisKey = '';
        // Show home view first; checkDOMForResult will switch to analysis/loading if a result is found
        if (!_hasAnalysisResult) {
          showSection("lci-home");
        }
        checkDOMForResult(true, true);
      });

      // Theme
      document.querySelector("#lci-theme-btn")?.addEventListener("click", () => {
        const isLight = overlay?.classList.toggle("lci-light");
        chrome.storage.local.set({ lci_theme: isLight ? "light" : "dark" });
      });

      // History toggle
      document.querySelector("#lci-history-btn")?.addEventListener("click", () => showHistoryView());
      document.querySelector("#lci-home-btn")?.addEventListener("click", () => {
        const title = document.querySelector("#lci-home-title");
        const latestButton = document.querySelector("#lci-latest-analysis-btn");
        if (title) title.textContent = _hasAnalysisResult ? "Your Dashboard" : "Ready to Analyze";
        latestButton?.classList.toggle("lci-hidden", !_hasAnalysisResult);
        showSection("lci-home");
      });
      document.querySelector("#lci-latest-analysis-btn")?.addEventListener("click", () => showAnalysisView());
      document.querySelector("#lci-history-back-btn")?.addEventListener("click", () => showAnalysisView());

      // FIX #11: History search + filter
      const histSearch = document.querySelector("#lci-history-search");
      const filterChips = document.querySelectorAll(".lci-filter-chip");
      let activeFilter = null;
      let _cachedHistory = [];

      function applyHistoryFilters() {
        const q = histSearch?.value?.toLowerCase() || "";
        filterChips.forEach(chip => {
          chip.classList.toggle("lci-filter-active", chip.dataset.filter === activeFilter);
        });
        const filtered = _cachedHistory.filter(entry => {
          const matchesQ = !q || (entry.problemTitle || "").toLowerCase().includes(q);
          const matchesDiff = !activeFilter || entry.difficulty === activeFilter;
          return matchesQ && matchesDiff;
        });
        renderHistoryListFiltered(filtered);
      }

      histSearch?.addEventListener("input", () => applyHistoryFilters());

      filterChips.forEach(chip => {
        chip.addEventListener("click", () => {
          activeFilter = activeFilter === chip.dataset.filter ? null : chip.dataset.filter;
          applyHistoryFilters();
        });
      });

      // Clear history (FIX: no confirm(), inline confirmation instead)
      document.querySelector("#lci-clear-history-btn")?.addEventListener("click", () => {
        const listEl = document.querySelector("#lci-history-list");
        const existing = listEl?.querySelector(".lci-clear-confirm");
        if (existing) { existing.remove(); return; }
        const confirmRow = document.createElement("div");
        confirmRow.className = "lci-clear-confirm";
        confirmRow.style.cssText = "display:flex;align-items:center;gap:8px;padding:10px 16px;background:rgba(255,92,92,0.08);border-bottom:1px solid rgba(255,92,92,0.15);";
        confirmRow.innerHTML = `<span style="font-size:11px;color:#ff5c5c;flex:1;">Clear all history?</span><button id="lci-confirm-history-yes" style="background:#ff5c5c;color:#fff;border:none;border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;">Yes</button><button id="lci-confirm-history-no" style="background:transparent;color:#8b92a9;border:1px solid rgba(255,255,255,0.1);border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;">No</button>`;
        listEl?.insertBefore(confirmRow, listEl.firstChild);
        document.querySelector("#lci-confirm-history-yes")?.addEventListener("click", () => {
          chrome.storage.local.remove("lci_history", () => {
            _cachedHistory = [];
            renderHistoryList([]);
          });
        });
        document.querySelector("#lci-confirm-history-no")?.addEventListener("click", () => confirmRow.remove());
      });

      // Retry
      document.querySelector("#lci-retry-btn")?.addEventListener("click", () => {
        isAnalyzing = false; lastSubmissionId = null; _lastAnalysisKey = '';
        clearRateLimitCountdown();
        checkDOMForResult(true);
      });

      // Re-analyze
      document.querySelector("#lci-refresh-btn")?.addEventListener("click", () => {
        isAnalyzing = false; lastSubmissionId = null; _lastAnalysisKey = '';
        checkDOMForResult(true, true);
      });

      // Settings button
      document.querySelector("#lci-settings-btn")?.addEventListener("click", () => {
        showSection("lci-settings");
        chrome.storage.local.get(["geminiApiKey", "lci_auto_analyze", "geminiModel"], (data) => {
          const inp = document.querySelector("#lci-api-key-input");
          if (inp) inp.value = data.geminiApiKey || "";
          const tog = document.querySelector("#lci-toggle-auto-analyze");
          if (tog) tog.checked = data.lci_auto_analyze !== false;
          fetchAndPopulateOverlayModels(data.geminiApiKey, data.geminiModel);
        });
      });

      document.querySelector("#lci-settings-back-btn")?.addEventListener("click", () => showAnalysisView());

      document.querySelector("#lci-open-settings-btn")?.addEventListener("click", () => {
        showSection("lci-settings");
        chrome.storage.local.get(["geminiApiKey", "lci_auto_analyze", "geminiModel"], (data) => {
          const inp = document.querySelector("#lci-api-key-input");
          if (inp) inp.value = data.geminiApiKey || "";
          const tog = document.querySelector("#lci-toggle-auto-analyze");
          if (tog) tog.checked = data.lci_auto_analyze !== false;
          fetchAndPopulateOverlayModels(data.geminiApiKey, data.geminiModel);
        });
      });

      // Save API key
      document.querySelector("#lci-api-save-btn")?.addEventListener("click", () => {
        const inp = document.querySelector("#lci-api-key-input");
        const key = inp?.value?.trim();
        if (!key) { showSettingsFeedback("Please enter your API key.", "error"); return; }
        const isStandard = key.startsWith("AIza") || key.startsWith("AQ");
        chrome.storage.local.set({ geminiApiKey: key }, () => {
          showSettingsFeedback(isStandard ? "✓ API key saved!" : "✓ Key saved! (Unusual format)", isStandard ? "ok" : "error");
          chrome.storage.local.get("geminiModel", (data) => fetchAndPopulateOverlayModels(key, data.geminiModel));
        });
      });

      document.querySelector("#lci-api-clear-btn")?.addEventListener("click", () => {
        chrome.storage.local.remove(["geminiApiKey", "geminiModel"], () => {
          const inp = document.querySelector("#lci-api-key-input");
          if (inp) inp.value = "";
          showSettingsFeedback("API key cleared.", "ok");
          resetOverlayModelDropdown(null);
        });
      });

      document.querySelector("#lci-api-vis-btn")?.addEventListener("click", () => {
        const inp = document.querySelector("#lci-api-key-input");
        if (inp) inp.type = inp.type === "password" ? "text" : "password";
      });

      document.querySelector("#lci-model-select")?.addEventListener("change", (e) => {
        const selectedModel = e.target.value;
        if (selectedModel) chrome.storage.local.set({ geminiModel: selectedModel }, () => showSettingsFeedback("✓ Model updated!", "ok"));
      });

      document.querySelector("#lci-api-key-input")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") document.querySelector("#lci-api-save-btn")?.click();
      });

      ["#lci-get-key-link", "#lci-get-key-link2"].forEach(sel => {
        document.querySelector(sel)?.addEventListener("click", (e) => {
          e.preventDefault();
          window.open("https://aistudio.google.com/app/apikey", "_blank");
        });
      });

      document.querySelector("#lci-toggle-auto-analyze")?.addEventListener("change", (e) => {
        chrome.storage.local.set({ lci_auto_analyze: e.target.checked });
        showSettingsFeedback(e.target.checked ? "Auto-analyze enabled." : "Auto-analyze disabled.", "ok");
      });

      // Drag — FIX #4 cursor set via CSS, JS handles movement
      makeDraggable(panel, dragHandle);

      // Restore theme
      chrome.storage.local.get("lci_theme", (data) => {
        if (data.lci_theme === "light") overlay?.classList.add("lci-light");
      });

      // Store reference to history cache for filtering
      window._lciGetCachedHistory = () => _cachedHistory;
      window._lciSetCachedHistory = (h) => { _cachedHistory = h; };
    });
  }

  // ─── Loading message cycling (FIX #6) ─────────────────────────────────────
  const LOADING_MESSAGES = [
    "Analyzing your submission…",
    "Detecting algorithmic patterns…",
    "Estimating Big-O complexity…",
    "Checking for optimizations…",
    "Almost there…",
  ];

  function startLoadingMessages() {
    let idx = 0;
    const el = document.querySelector("#lci-loading-text");
    if (!el) return;
    el.textContent = LOADING_MESSAGES[0];
    _loadingMsgInterval = setInterval(() => {
      idx = (idx + 1) % LOADING_MESSAGES.length;
      el.style.opacity = "0";
      setTimeout(() => {
        el.textContent = LOADING_MESSAGES[idx];
        el.style.transition = "opacity 0.3s";
        el.style.opacity = "1";
      }, 200);
    }, 2800);
  }

  function stopLoadingMessages() {
    if (_loadingMsgInterval) { clearInterval(_loadingMsgInterval); _loadingMsgInterval = null; }
  }

  // ─── Toast (FIX #2) ───────────────────────────────────────────────────────
  let _toastTimeout = null;
  function showVerdictToast(verdict) {
    const toast = document.querySelector("#lci-toast");
    if (!toast) return;
    const verdictLabel = verdict || "Non-Accepted";
    toast.innerHTML = `<span class="lci-toast-icon">❌</span>${escHtml(verdictLabel)} — analysis only runs on Accepted submissions. Click ⚡ to try manually.`;
    toast.classList.add("lci-toast-visible");
    clearTimeout(_toastTimeout);
    _toastTimeout = setTimeout(() => toast.classList.remove("lci-toast-visible"), 5000);
  }

  // ─── FAB Badge helpers ─────────────────────────────────────────────────────
  function showFABBadge(text) {
    const badge = document.querySelector("#lci-fab-badge");
    if (!badge) return;
    badge.textContent = text;
    badge.classList.add("lci-badge-visible");
  }

  function hideFABBadge() {
    const badge = document.querySelector("#lci-fab-badge");
    if (badge) badge.classList.remove("lci-badge-visible");
  }

  // ─── Error rate-limit countdown (FIX #7) ─────────────────────────────────
  let _countdownInterval = null;
  function startRateLimitCountdown(seconds) {
    clearRateLimitCountdown();
    const el = document.querySelector("#lci-error-countdown");
    if (!el) return;
    let remaining = seconds;
    el.textContent = `Retry in ${remaining}s`;
    el.classList.add("lci-visible");
    _countdownInterval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearRateLimitCountdown();
      } else {
        el.textContent = `Retry in ${remaining}s`;
      }
    }, 1000);
  }

  function clearRateLimitCountdown() {
    if (_countdownInterval) { clearInterval(_countdownInterval); _countdownInterval = null; }
    const el = document.querySelector("#lci-error-countdown");
    if (el) { el.textContent = ""; el.classList.remove("lci-visible"); }
  }

  function showSettingsFeedback(msg, type) {
    const el = document.querySelector("#lci-api-feedback");
    if (!el) return;
    el.textContent = msg;
    el.className = `lci-settings-feedback ${type === "error" ? "lci-settings-feedback-error" : "lci-settings-feedback-ok"}`;
    setTimeout(() => { el.textContent = ""; el.className = "lci-settings-feedback"; }, 3000);
  }

  // ─── Allowed models (single source of truth — mirrors popup.js) ───────────
  const OVERLAY_ALLOWED_MODELS = [
    { value: "models/gemini-3.6-flash", label: "Gemini 3.6 Flash (Default)" },
    { value: "models/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
  ];

  function fetchAndPopulateOverlayModels(apiKey, selectedModel) {
    const sel = document.querySelector("#lci-model-select");
    if (!sel) return;
    if (!apiKey) { resetOverlayModelDropdown(selectedModel); return; }
    sel.innerHTML = `<option value="">Loading models...</option>`;
    chrome.runtime.sendMessage({ type: "GET_GEMINI_MODELS" }, (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        resetOverlayModelDropdown(selectedModel);
        return;
      }

      // Only show curated models confirmed by Gemini's API.
      const availableNames = new Set((response.models || []).map((model) => model.name));
      const filtered = OVERLAY_ALLOWED_MODELS.filter((model) => availableNames.has(model.value));
      const toShow = filtered.length > 0 ? filtered : OVERLAY_ALLOWED_MODELS;

      sel.innerHTML = "";
      toShow.forEach((model) => {
        const option = document.createElement("option");
        option.value = model.value;
        option.textContent = model.label;
        if (model.value === selectedModel) option.selected = true;
        sel.appendChild(option);
      });

      const currentOptions = Array.from(sel.options).map((option) => option.value);
      if (selectedModel && !currentOptions.includes(selectedModel)) {
        sel.value = currentOptions[0];
        chrome.storage.local.set({ geminiModel: currentOptions[0] });
      } else if (!selectedModel) {
        const defaultModel = OVERLAY_ALLOWED_MODELS[0].value;
        sel.value = currentOptions.includes(defaultModel) ? defaultModel : currentOptions[0];
        chrome.storage.local.set({ geminiModel: sel.value });
      }
    });
  }

  function resetOverlayModelDropdown(selectedModel) {
    const sel = document.querySelector("#lci-model-select");
    if (!sel) return;
    sel.innerHTML = "";
    OVERLAY_ALLOWED_MODELS.forEach(f => {
      const opt = document.createElement("option");
      opt.value = f.value;
      opt.textContent = f.label;
      if (f.value === selectedModel) opt.selected = true;
      sel.appendChild(opt);
    });
    if (!selectedModel || !OVERLAY_ALLOWED_MODELS.some(f => f.value === selectedModel)) {
      sel.value = OVERLAY_ALLOWED_MODELS[0].value;
      chrome.storage.local.set({ geminiModel: OVERLAY_ALLOWED_MODELS[0].value });
    }
  }

  // ─── Overlay View Control ──────────────────────────────────────────────────
  function showOverlay() {
    const overlay = document.querySelector("#lci-overlay");
    const panel   = document.querySelector("#lci-panel");
    const fab     = document.querySelector("#lci-fab");
    overlay?.classList.remove("lci-hidden");
    panel?.classList.remove("lci-minimized");
    overlay?.classList.add("lci-enter");
    setTimeout(() => overlay?.classList.remove("lci-enter"), 400);
    fab?.classList.add("lci-hidden");
  }

  // FIX #19: Scroll-to-top on every section switch
  function showSection(id) {
    ["lci-loading", "lci-error", "lci-analysis", "lci-history", "lci-setup", "lci-settings", "lci-home"].forEach((sid) => {
      document.querySelector(`#${sid}`)?.classList.add("lci-hidden");
    });
    document.querySelector(`#${id}`)?.classList.remove("lci-hidden");
    // FIX #19: scroll content to top
    const content = document.querySelector("#lci-content");
    if (content) content.scrollTop = 0;

    // Stop loading messages if leaving loading state
    if (id !== "lci-loading") stopLoadingMessages();
  }

  function showHistoryView() {
    showSection("lci-history");
    // FIX #18: Show skeleton while loading
    const listEl = document.querySelector("#lci-history-list");
    if (listEl) {
      listEl.innerHTML = [1,2,3].map(() => `
        <div class="lci-skeleton-item">
          <div class="lci-skeleton-line lci-sk-title"></div>
          <div class="lci-skeleton-line lci-sk-sub"></div>
        </div>
      `).join("");
    }
    chrome.storage.local.get("lci_history", (data) => {
      const history = data.lci_history || [];
      if (window._lciSetCachedHistory) window._lciSetCachedHistory(history);
      renderHistoryList(history);
    });
  }

  function showAnalysisView() {
    if (_hasAnalysisResult) {
      showSection("lci-analysis");
    } else {
      showSection("lci-home");
    }
  }

  function sendToOverlay(message) {
    if (message.type === "LOADING") {
      showSection("lci-loading");
      startLoadingMessages(); // FIX #6
      const sub = document.querySelector("#lci-loading-sub");
      if (sub) sub.textContent = `Analyzing "${message.payload?.problemTitle || "your solution"}"…`;
    } else if (message.type === "ERROR") {
      stopLoadingMessages();
      if (message.error === "NO_API_KEY") {
        showSection("lci-setup");
        return;
      }
      showSection("lci-error");
      const errEl = document.querySelector("#lci-error-msg");
      if (errEl) errEl.textContent = humanizeError(message.error);

      // FIX #7: Contextual action buttons
      const actionsEl = document.querySelector("#lci-error-actions");
      if (actionsEl) {
        actionsEl.innerHTML = `<button id="lci-retry-btn" class="lci-btn-secondary">Retry</button>`;
        const isAuthErr = message.error?.includes("401") || message.error?.includes("403") || message.error?.includes("Invalid");
        const isRateLimit = message.error?.includes("429") || message.error?.toLowerCase().includes("rate limit");
        if (isAuthErr) {
          const settingsBtn = document.createElement("button");
          settingsBtn.className = "lci-btn-primary";
          settingsBtn.textContent = "Open Settings";
          settingsBtn.addEventListener("click", () => {
            showSection("lci-settings");
            chrome.storage.local.get(["geminiApiKey", "lci_auto_analyze", "geminiModel"], (data) => {
              const inp = document.querySelector("#lci-api-key-input");
              if (inp) inp.value = data.geminiApiKey || "";
              fetchAndPopulateOverlayModels(data.geminiApiKey, data.geminiModel);
            });
          });
          actionsEl.appendChild(settingsBtn);
        }
        if (isRateLimit) startRateLimitCountdown(45);

        // Re-attach retry listener
        document.querySelector("#lci-retry-btn")?.addEventListener("click", () => {
          isAnalyzing = false; lastSubmissionId = null; _lastAnalysisKey = '';
          clearRateLimitCountdown();
          checkDOMForResult(true);
        });
      }
    } else if (message.type === "ANALYSIS_RESULT") {
      stopLoadingMessages();
      _hasAnalysisResult = true;
      renderAnalysis(message.data);
      showSection("lci-analysis");
    }
  }

  // ─── Complexity color gauge helpers (FIX #12) ─────────────────────────────
  // Maps Big-O notation to an efficiency score 0–100 (100 = best)
  function complexityScore(bigO) {
    if (!bigO) return 50;
    const s = bigO.toLowerCase().replace(/\s/g, "");
    if (s === "o(1)") return 100;
    if (s === "o(logn)") return 90;
    if (s === "o(n)") return 75;
    if (s === "o(nlogn)") return 60;
    if (s.includes("n^2") || s.includes("n²") || s === "o(n*n)") return 35;
    if (s.includes("n^3") || s.includes("n³")) return 20;
    if (s.includes("2^n") || s.includes("2ⁿ")) return 8;
    if (s.includes("n!")) return 2;
    return 50;
  }

  function gaugeColor(score) {
    if (score >= 80) return "#3dcc87"; // green
    if (score >= 60) return "#a3e635"; // lime
    if (score >= 45) return "#ffd166"; // yellow
    if (score >= 25) return "#fb923c"; // orange
    return "#ff5c5c"; // red
  }

  function applyComplexityGauge(gaugeId, markerId, bigO) {
    const score = complexityScore(bigO);
    const color = gaugeColor(score);
    const gaugeEl = document.querySelector(`#${gaugeId}`);
    const markerEl = document.querySelector(`#${markerId}`);
    if (gaugeEl) {
      gaugeEl.style.background = color;
      gaugeEl.style.boxShadow = `0 0 5px ${color}66`;
      gaugeEl.title = score >= 80 ? "Optimal" : score >= 60 ? "Good" : score >= 45 ? "Acceptable" : score >= 25 ? "Slow" : "Very slow";
    }
    if (markerEl) {
      // Position marker along the gradient bar (0=right/red, 100=left/green)
      // The gradient goes green→yellow→red left-to-right, so invert: left% = (100-score)%
      markerEl.style.left = `${100 - score}%`;
    }
  }

  // ─── Render Analysis ───────────────────────────────────────────────────────
  function renderAnalysis(data) {
    if (!data) return;

    setText("#lci-problem-title", data.problemTitle || "Unknown Problem");

    const diffBadge = document.querySelector("#lci-difficulty-badge");
    if (diffBadge) {
      diffBadge.textContent = data.difficulty || "";
      diffBadge.className = `lci-diff-badge lci-diff-${(data.difficulty || "").toLowerCase()}`;
    }

    const meta = data.submissionMeta || {};
    setText("#lci-lang-chip", meta.language || "");

    const verdictBadge = document.querySelector("#lci-verdict-badge");
    if (verdictBadge) {
      verdictBadge.textContent = meta.verdict || "";
      verdictBadge.className = `lci-verdict-badge lci-verdict-${meta.verdict === "Accepted" ? "ok" : "err"}`;
    }

    const statsRow = document.querySelector("#lci-stats-row");
    if (meta.runtime || meta.memory) {
      statsRow?.classList.remove("lci-hidden");
      setText("#lci-runtime-val", meta.runtime || "—");
      setText("#lci-memory-val", meta.memory || "—");
      setText("#lci-runtime-pct", meta.runtimePercentile || "");
      setText("#lci-memory-pct", meta.memoryPercentile || "");
    } else {
      statsRow?.classList.add("lci-hidden");
    }

    setText("#lci-time-complexity", data.timeComplexity || "—");
    setText("#lci-space-complexity", data.spaceComplexity || "—");
    setText("#lci-time-reasoning", data.timeReasoning || "");
    setText("#lci-space-reasoning", data.spaceReasoning || "");
    setText("#lci-approach-used", data.approachUsed || "Unknown");

    // FIX #12: Apply complexity color gauges
    applyComplexityGauge("lci-time-gauge", "lci-time-marker", data.timeComplexity);
    applyComplexityGauge("lci-space-gauge", "lci-space-marker", data.spaceComplexity);

    const patternsEl = document.querySelector("#lci-patterns-tags");
    if (patternsEl) {
      patternsEl.innerHTML = (data.patternsDetected || [])
        .map((p) => `<span class="lci-chip lci-chip-pattern">${escHtml(p)}</span>`)
        .join("");
    }

    const smellsList = document.querySelector("#lci-smells-list");
    if (smellsList) {
      if (data.codeSmells?.length > 0) {
        smellsList.innerHTML = data.codeSmells
          .map((s) => `<li>⚠️ ${escHtml(s)}</li>`)
          .join("");
      } else {
        smellsList.innerHTML = `<li class="lci-smell-ok">✅ No significant issues found</li>`;
      }
    }

    const better = data.betterApproach;
    const noSug = document.querySelector("#lci-no-suggestion");
    const sugContent = document.querySelector("#lci-suggestion-content");

    if (!better || !better.exists) {
      noSug?.classList.remove("lci-hidden");
      sugContent?.classList.add("lci-hidden");
    } else {
      noSug?.classList.add("lci-hidden");
      sugContent?.classList.remove("lci-hidden");
      setText("#lci-suggestion-name", better.name || "");
      setText("#lci-sug-time", better.expectedTimeComplexity || "");
      setText("#lci-sug-space", better.expectedSpaceComplexity || "");
      setText("#lci-sug-why-better", better.whyBetter || "");
      setText("#lci-sug-intuition", better.intuition || "");
      setText("#lci-sug-why-matters", better.whyMatters || "");
    }

    const cacheNotice = document.querySelector("#lci-cache-notice");
    if (data.fromCache) cacheNotice?.classList.remove("lci-hidden");
    else cacheNotice?.classList.add("lci-hidden");
  }

  // ─── History Render ────────────────────────────────────────────────────────
  function renderHistoryList(history) {
    if (window._lciSetCachedHistory) window._lciSetCachedHistory(history || []);
    renderHistoryListFiltered(history || []);
  }

  function renderHistoryListFiltered(history) {
    const listEl = document.querySelector("#lci-history-list");
    if (!listEl) return;
    if (!history?.length) {
      listEl.innerHTML = '<p class="lci-empty-state">No results. Try a different search or filter.</p>';
      return;
    }
    listEl.innerHTML = history.map((entry) => `
      <div class="lci-history-item" tabindex="0" data-cache-key="${escHtml(entry.cacheKey || "")}">
        <div class="lci-hi-top">
          <span class="lci-hi-title">${escHtml(entry.problemTitle || "Unknown")}</span>
          <span class="lci-verdict-badge lci-verdict-${entry.verdict === "Accepted" ? "ok" : "err"} lci-chip-sm">
            ${escHtml(entry.verdict || "")}
          </span>
        </div>
        <div class="lci-hi-bottom">
          <span class="lci-diff-badge lci-diff-${(entry.difficulty || "").toLowerCase()} lci-chip-sm">${escHtml(entry.difficulty || "")}</span>
          <span class="lci-chip lci-chip-lang lci-chip-sm">${escHtml(entry.language || "")}</span>
          <span class="lci-chip lci-chip-time lci-chip-sm">T: ${escHtml(entry.timeComplexity || "?")}</span>
          <span class="lci-chip lci-chip-space lci-chip-sm">S: ${escHtml(entry.spaceComplexity || "?")}</span>
          <span class="lci-hi-date">${formatDate(entry.analyzedAt)}</span>
        </div>
      </div>
    `).join("");

    listEl.querySelectorAll(".lci-history-item").forEach((item) => {
      const activate = () => {
        const key = item.dataset.cacheKey;
        chrome.storage.local.get(key, (data) => {
          if (data[key]) { renderAnalysis(data[key]); showAnalysisView(); }
        });
      };
      item.addEventListener("click", activate);
      item.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") activate(); });
    });
  }

  // ─── Drag (FIX #4: cursor is set via CSS, JS just moves the panel) ────────
  function makeDraggable(panel, handle) {
    if (!panel || !handle) return;
    let dragging = false, ox = 0, oy = 0;

    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
      panel.style.cssText += `left:${x}px;top:${y}px;right:auto;bottom:auto;`;
    });

    document.addEventListener("mouseup", () => { dragging = false; });
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────
  function setText(sel, val) {
    const el = document.querySelector(sel);
    if (el) el.textContent = val;
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDate(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      });
    } catch { return ""; }
  }

  function humanizeError(err) {
    if (!err) return "An unexpected error occurred.";
    const errStr = typeof err === "string" ? err : (err.message || String(err));
    if (errStr === "NO_API_KEY") return "No API key set. Click the extension icon ⚡ in your toolbar to add your free Gemini API key.";
    if (errStr.includes("401") || errStr.includes("403") || errStr.toLowerCase().includes("invalid")) return "Invalid API key. Please check your Gemini API key in settings.";
    if (errStr.includes("429") || errStr.toLowerCase().includes("rate limit")) return "Rate limit reached. Please wait ~45 seconds and try again.";
    if (errStr.toLowerCase().includes("503") || errStr.toLowerCase().includes("overloaded") || errStr.toLowerCase().includes("unavailable")) return "Gemini servers are temporarily overloaded. Please try again in a moment.";
    if (errStr.includes("network") || errStr.includes("fetch")) return "Network error. Please check your internet connection.";
    return errStr.length > 120 ? errStr.substring(0, 120) + "…" : errStr;
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  chrome.storage.local.get("lci_enabled", (data) => {
    const enabled = data.lci_enabled !== false;
    if (!enabled) {
      console.log("[LCI] Extension is disabled via popup settings.");
      return;
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  });
})();
