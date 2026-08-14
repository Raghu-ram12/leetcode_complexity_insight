/**
 * content.js — Content Script (Revised with research-backed selectors)
 * Runs on leetcode.com/problems/* pages.
 * Detects submissions, extracts code + metadata, injects the overlay UI.
 *
 * Key architecture notes:
 * - Code extraction uses an injected page-context script to access monaco API
 * - Submission results intercepted via network (most reliable)
 * - Falls back to DOM scraping for all data points
 */

(function () {
  "use strict";

  // ─── State ─────────────────────────────────────────────────────────────────
  let overlayInjected = false;
  let lastSubmissionId = null;
  let isAnalyzing = false;
  let submitPending = false;  // true only after user clicks Submit — gates DOM/polling triggers
  let currentProblemMeta = {};
  let pendingCode = "";
  let pendingLanguage = "";

  // ─── Init ──────────────────────────────────────────────────────────────────
  function init() {
    extractProblemMeta();
    injectPageContextBridge();
    injectOverlay();
    showFABImmediately();   // Always show FAB so user knows extension is running
    hookSubmitButton();
    interceptSubmissionNetwork();
    startPollingFallback();  // Polling backup in case network interception fails
    watchSPANavigation();
    console.log("[LCI] Content script initialized on:", currentProblemMeta.problemTitle);
  }

  // ─── Page Context Bridge ───────────────────────────────────────────────────
  // Monaco and XHR/fetch interception must run in page context, not the isolated
  // content script world. We inject bridge.js via chrome.runtime.getURL — extension
  // files bypass the page's Content Security Policy (unlike inline scripts).
  function injectPageContextBridge() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("bridge.js");
    script.onload = () => script.remove(); // Clean up DOM after execution

    (document.head || document.documentElement).appendChild(script);

    // Listen for submission results from page context (bridge.js communicates via CustomEvents)
    // Note: __lci_code_response is intentionally NOT listened to here persistently;
    // requestCodeFromPageContext() registers a one-time listener per request to avoid
    // duplicate listeners that could corrupt pendingCode state.
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
      // Timeout fallback
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
    // Priority order: data-cy → text-title-large → h1 → URL slug → page title
    const strategies = [
      () => document.querySelector('[data-cy="question-title"]')?.textContent?.trim(),
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
    // Text-content scan — most reliable, class names change per build
    const candidates = document.querySelectorAll("span, div");
    for (const el of candidates) {
      const txt = el.textContent?.trim();
      if (["Easy", "Medium", "Hard"].includes(txt)) return txt;
    }
    // Partial class match fallback
    try {
      const el = document.querySelector('[class*="difficulty"]');
      if (el) return el.textContent?.trim();
    } catch {}
    return "Unknown";
  }

  // ─── Submit Button Hook ────────────────────────────────────────────────────
  function hookSubmitButton() {
    const findAndHook = () => {
      const selectors = [
        '[data-e2e-locator="console-submit-button"]',
        '[data-cy="submit-button"]',
        // Text-content fallback
      ];

      let btn = null;
      for (const sel of selectors) {
        btn = document.querySelector(sel);
        if (btn) break;
      }

      // Text-based fallback
      if (!btn) {
        const buttons = document.querySelectorAll("button");
        for (const b of buttons) {
          if (b.textContent?.trim() === "Submit") {
            btn = b;
            break;
          }
        }
      }

      if (btn && !btn.__lciHooked) {
        btn.__lciHooked = true;
        btn.addEventListener("click", async () => {
          // Reset dedup so next result is always fresh
          _lastAnalysisKey = '';
          lastSubmissionId = null;
          isAnalyzing = false;
          submitPending = true;  // gate: allow DOM observer & polling to act

          // Activate polling fallback
          window.dispatchEvent(new Event('__lci_submit_clicked'));

          // Capture code at submit time
          const result = await requestCodeFromPageContext();
          if (result.code) {
            pendingCode = result.code;
            pendingLanguage = result.lang || extractLanguageFromDOM();
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
    // bridge.js (page context) handles XHR/fetch/GraphQL interception via CustomEvents.
    // startDOMObserver() is a secondary fallback watching the DOM for result elements.
    startDOMObserver();
  }

  function startDOMObserver() {
    const observer = new MutationObserver(
      debounce(() => {
        // Only fire if user has actually clicked Submit — prevents accidental triggers
        // from stale DOM state on page load or LeetCode's SPA keeping old results visible
        if (!submitPending || isAnalyzing) return;
        chrome.storage.local.get("lci_auto_analyze", (data) => {
          if (data.lci_auto_analyze !== false) {
            checkDOMForResult();
          }
        });
      }, 500)
    );
    observer.observe(document.body, { childList: true, subtree: true, characterData: false });
  }

  // Polling fallback — starts on submit click, stops as soon as analysis fires
  let pollingInterval = null;
  function startPollingFallback() {
    window.addEventListener('__lci_submit_clicked', () => {
      // Clear any previous interval
      if (pollingInterval) clearInterval(pollingInterval);
      chrome.storage.local.get("lci_auto_analyze", (data) => {
        if (data.lci_auto_analyze === false) return;
        let attempts = 0;
        console.log('[LCI] Polling fallback activated');
        pollingInterval = setInterval(() => {
          attempts++;
          if (attempts > 30) {  // Timeout after 60s
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
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }

  // Show FAB immediately so users know the extension is active
  function showFABImmediately() {
    requestAnimationFrame(() => {
      const fab = document.querySelector('#lci-fab');
      if (fab) {
        fab.classList.remove('lci-hidden');
        // FAB click: open overlay or manually trigger scan
        fab.addEventListener('click', () => {
          const overlay = document.querySelector('#lci-overlay');
          if (overlay && !overlay.classList.contains('lci-hidden')) return;
          // Try to find a pending result first
          const hasResult = document.querySelector('[data-e2e-locator="submission-result"]');
          if (hasResult && !isAnalyzing) {
            isAnalyzing = false;
            _lastAnalysisKey = ''; // reset dedup so FAB-triggered scan works
            checkDOMForResult(true); // Force manual run
          } else {
            // Just open the overlay to show last analysis or empty state
            showOverlay();
            showSection('lci-analysis');
          }
        });
      }
    });
  }

  // Dedup key: problem+verdict, reset only on new submit click
  // This prevents re-triggering on the same result page (unlike time-based dedup)
  let _lastAnalysisKey = '';

  function checkDOMForResult(force = false, bypassCache = false) {
    // Guard: only run if user has clicked Submit (or forced via FAB/buttons click) — prevents firing on stale page state
    if (!submitPending && !force) return;

    // Only use the stable data-e2e-locator element — do NOT scan body.innerText
    // (body text contains 'Accepted' in sidebar/tabs/stats even before submission)
    const resultEl = document.querySelector('[data-e2e-locator="submission-result"]');
    const verdict = resultEl?.textContent?.trim();

    if (!verdict || verdict === 'Checking...' || verdict === '') return;

    if (verdict.toLowerCase() !== 'accepted') {
      submitPending = false;  // consume the gate
      stopPolling();          // stop polling
      if (force) {
        showOverlay();
        sendToOverlay({ type: "ERROR", error: "Only successful (Accepted) submissions can be analyzed." });
      }
      return;
    }

    // Dedupe by problem+verdict — resets only on new submit click
    const key = `${currentProblemMeta.problemTitle}::${verdict}`;
    if (!force && key === _lastAnalysisKey) return;
    _lastAnalysisKey = key;

    submitPending = false;  // consume the gate — done waiting for this submission's result
    stopPolling();          // stop polling immediately — we found a result
    console.log('[LCI] DOM detected verdict:', verdict);
    triggerAnalysis({
      status_msg: verdict,
      runtime: document.querySelector('[data-e2e-locator="submission-runtime"]')?.textContent?.trim(),
      memory: document.querySelector('[data-e2e-locator="submission-memory"]')?.textContent?.trim(),
    }, bypassCache);
  }

  async function handleSubmissionResultData(data) {
    if (isAnalyzing) return;
    if (!data?.status_msg || data.status_msg === "Pending") return;
    // Network path: require submitPending too, to prevent accidental triggers
    // from GraphQL polls LeetCode fires for other reasons (e.g. viewing past submissions)
    if (!submitPending) return;

    // Only proceed for Accepted submissions
    if (data.status_msg.toLowerCase() !== 'accepted') {
      submitPending = false;
      return;
    }

    // Dedupe by submission ID if available
    const subId = data.submission_id || data.id || `${data.status_msg}-${Math.floor(Date.now() / 3000)}`;
    if (subId === lastSubmissionId) return;
    lastSubmissionId = subId;

    submitPending = false;  // consume the gate
    chrome.storage.local.get("lci_auto_analyze", (dataStorage) => {
      if (dataStorage.lci_auto_analyze !== false) {
        triggerAnalysis(data);
      } else {
        console.log('[LCI] Auto-analyze is disabled. Click the FAB button to analyze.');
      }
    });
  }

  // ─── Analysis Trigger ──────────────────────────────────────────────────────
  async function triggerAnalysis(resultData, bypassCache = false) {
    isAnalyzing = true;

    try {
      if (!resultData) resultData = {};

      // Get code from session storage (captured on submit click) or request fresh
      let code = "";
      let language = "";
      try {
        code = sessionStorage.getItem("lci_pending_code") || pendingCode;
        language = sessionStorage.getItem("lci_pending_lang") || pendingLanguage;
      } catch (e) {
        console.warn("[LCI] sessionStorage access blocked:", e);
        code = pendingCode;
        language = pendingLanguage;
      }

      if (!code) {
        const fresh = await requestCodeFromPageContext();
        code = fresh.code || extractCodeFallback();
        language = fresh.lang || extractLanguageFromDOM();
      }

      // Refresh meta
      extractProblemMeta();

      // Parse result data
      const verdict = resultData.status_msg || "Unknown";
      const runtime = resultData.runtime || extractStatFromDOM("runtime");
      const memory = resultData.memory || extractStatFromDOM("memory");

      let runtimePercentile = null;
      let memoryPercentile = null;
      try {
        runtimePercentile = resultData.runtime_percentile
          ? `Beats ${parseFloat(resultData.runtime_percentile).toFixed(1)}% of users`
          : extractPercentileFromDOM("runtime");
      } catch (e) {
        runtimePercentile = extractPercentileFromDOM("runtime");
      }

      try {
        memoryPercentile = resultData.memory_percentile
          ? `Beats ${parseFloat(resultData.memory_percentile).toFixed(1)}% of users`
          : extractPercentileFromDOM("memory");
      } catch (e) {
        memoryPercentile = extractPercentileFromDOM("memory");
      }

      const payload = {
        code: code || "(code unavailable)",
        language: language || extractLanguageFromDOM(),
        problemTitle: currentProblemMeta?.problemTitle || "Unknown Problem",
        difficulty: currentProblemMeta?.difficulty || "Unknown",
        verdict,
        runtime,
        memory,
        runtimePercentile,
        memoryPercentile,
        bypassCache,
      };

      console.log("[LCI] Triggering analysis:", payload.problemTitle, payload.verdict);

      showOverlay();
      sendToOverlay({ type: "LOADING", payload });

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
      sendToOverlay({ type: "ERROR", error: "Unexpected error. Please try again." });
      isAnalyzing = false;
    }
  }

  // ─── Code Extraction Fallbacks ─────────────────────────────────────────────
  function extractCodeFallback() {
    // CodeMirror (older LeetCode)
    try {
      const cm = document.querySelector(".CodeMirror");
      if (cm?.CodeMirror) return cm.CodeMirror.getValue();
    } catch {}
    // Hidden textarea
    try {
      const ta = document.querySelector(".monaco-editor textarea");
      if (ta?.value?.trim()) return ta.value;
    } catch {}
    // Last resort: view-lines (incomplete for long files)
    try {
      const lines = document.querySelectorAll(".view-lines .view-line");
      if (lines.length > 0) {
        return Array.from(lines).map((l) => l.textContent).join("\n");
      }
    } catch {}
    return "";
  }

  function extractLanguageFromDOM() {
    // Monaco data-mode-id is the most reliable
    try {
      const modeId = document.querySelector(".monaco-editor")?.getAttribute("data-mode-id");
      if (modeId) return mapModeIdToLanguage(modeId);
    } catch {}
    // Language selector dropdown
    const selectors = [
      '[data-cy="lang-select"] button',
      'button[id*="headlessui-listbox-button"]',
    ];
    for (const sel of selectors) {
      try {
        const txt = document.querySelector(sel)?.textContent?.trim();
        if (txt && isKnownLanguage(txt)) return txt;
      } catch {}
    }
    return "Unknown";
  }

  function mapModeIdToLanguage(modeId) {
    const map = {
      python: "Python3",
      javascript: "JavaScript",
      typescript: "TypeScript",
      java: "Java",
      cpp: "C++",
      c: "C",
      csharp: "C#",
      go: "Go",
      rust: "Rust",
      swift: "Swift",
      kotlin: "Kotlin",
      ruby: "Ruby",
      scala: "Scala",
      php: "PHP",
      dart: "Dart",
    };
    return map[modeId.toLowerCase()] || modeId;
  }

  function isKnownLanguage(str) {
    const langs = ["Python", "Python3", "Java", "C++", "C", "JavaScript", "TypeScript",
      "Go", "Rust", "Swift", "Kotlin", "Ruby", "Scala", "PHP", "C#", "R", "Dart"];
    return langs.some((l) => str.includes(l));
  }

  // ─── DOM Stats Extraction ──────────────────────────────────────────────────
  function extractStatFromDOM(keyword) {
    try {
      const sel = `[data-e2e-locator="submission-${keyword}"]`;
      const el = document.querySelector(sel);
      if (el) return el.textContent?.trim();
    } catch {}
    return null;
  }

  function extractPercentileFromDOM(keyword) {
    try {
      // Scope to the submission result panel to avoid false matches from sidebars/stats
      const resultPanel =
        document.querySelector('[data-e2e-locator="submission-result"]')?.closest('[class*="result"]') ||
        document.querySelector('[data-e2e-locator="submission-result"]')?.parentElement?.parentElement ||
        document.body;
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

    // Observe document.body (not document) to avoid firing on every head/meta mutation.
    // For LeetCode's SPA, body child changes reliably reflect route transitions.
    new MutationObserver(() => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        const currentSlug = getProblemSlug(currentUrl);

        if (currentSlug !== lastSlug) {
          lastSlug = currentSlug;
          isAnalyzing = false;
          lastSubmissionId = null;
          _lastAnalysisKey = '';
          submitPending = false;  // reset on navigation — new page, no submission pending
          stopPolling();
          extractProblemMeta();
          hookSubmitButton();
        } else {
          // Same problem, but URL changed (e.g. redirected to submission details)
          // Re-hook the submit button in case the DOM was recreated
          hookSubmitButton();
        }
      }
    }).observe(document.body, { subtree: true, childList: true });
  }

  function getProblemSlug(urlStr) {
    try {
      const url = new URL(urlStr);
      const match = url.pathname.match(/\/problems\/([^/]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
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
        <span class="lci-logo-icon">⚡</span>
        <span class="lci-logo-text">Complexity Insight</span>
      </div>
      <div class="lci-header-actions">
        <button id="lci-settings-btn" class="lci-icon-btn" title="Settings / API Key" aria-label="Settings">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
        <button id="lci-history-btn" class="lci-icon-btn" title="View history" aria-label="View history">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </button>
        <button id="lci-theme-btn" class="lci-icon-btn" title="Toggle theme" aria-label="Toggle theme">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        </button>
        <button id="lci-minimize-btn" class="lci-icon-btn" title="Minimize" aria-label="Minimize panel">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button id="lci-close-btn" class="lci-icon-btn" title="Close" aria-label="Close panel">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>

    <div id="lci-content" class="lci-content">
      <!-- Loading -->
      <div id="lci-loading" class="lci-state-view lci-loading-view lci-hidden">
        <div class="lci-spinner-wrap">
          <div class="lci-spinner"></div>
        </div>
        <p class="lci-loading-text">Analyzing your submission…</p>
        <p id="lci-loading-sub" class="lci-loading-sub">Powered by Gemini AI</p>
      </div>

      <!-- Error -->
      <div id="lci-error" class="lci-state-view lci-error-view lci-hidden">
        <div class="lci-error-icon">⚠️</div>
        <p id="lci-error-msg" class="lci-error-text">Something went wrong.</p>
        <button id="lci-retry-btn" class="lci-btn-secondary">Retry</button>
      </div>

      <!-- Settings View -->
      <div id="lci-settings" class="lci-settings-view lci-hidden">
        <div class="lci-settings-header">
          <button id="lci-settings-back-btn" class="lci-icon-btn" aria-label="Back">
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
          
          <div class="lci-settings-label" style="margin-top: 10px;">Model</div>
          <div class="lci-settings-select-wrap">
            <select id="lci-model-select" class="lci-settings-select" aria-label="Select Gemini Model">
              <option value="models/gemini-2.0-flash">Gemini 2.0 Flash (Default)</option>
              <option value="models/gemini-1.5-flash">Gemini 1.5 Flash</option>
              <option value="models/gemini-1.5-pro">Gemini 1.5 Pro</option>
            </select>
          </div>

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
          <div id="lci-stats-row" class="lci-stats-row lci-hidden">
            <div class="lci-stat-card">
              <div class="lci-stat-emoji">⚡</div>
              <div>
                <div class="lci-stat-value" id="lci-runtime-val">—</div>
                <div class="lci-stat-label">Runtime</div>
                <div class="lci-stat-pct" id="lci-runtime-pct"></div>
              </div>
            </div>
            <div class="lci-stat-card">
              <div class="lci-stat-emoji">💾</div>
              <div>
                <div class="lci-stat-value" id="lci-memory-val">—</div>
                <div class="lci-stat-label">Memory</div>
                <div class="lci-stat-pct" id="lci-memory-pct"></div>
              </div>
            </div>
          </div>
        </section>

        <!-- § 2 Complexity Analysis -->
        <section class="lci-section">
          <h2 class="lci-section-title"><span class="lci-sec-icon">📊</span>Complexity Analysis</h2>
          <div class="lci-complexity-grid">
            <div class="lci-complexity-card lci-time-card">
              <div class="lci-complexity-header">
                <span class="lci-complexity-label">Time</span>
                <span class="lci-complexity-value" id="lci-time-complexity">—</span>
              </div>
              <p class="lci-complexity-reasoning" id="lci-time-reasoning"></p>
            </div>
            <div class="lci-complexity-card lci-space-card">
              <div class="lci-complexity-header">
                <span class="lci-complexity-label">Space</span>
                <span class="lci-complexity-value" id="lci-space-complexity">—</span>
              </div>
              <p class="lci-complexity-reasoning" id="lci-space-reasoning"></p>
            </div>
          </div>
        </section>

        <!-- § 3 Insights -->
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

      <!-- History View -->
      <div id="lci-history" class="lci-history-view lci-hidden">
        <div class="lci-history-header">
          <button id="lci-history-back-btn" class="lci-icon-btn" aria-label="Back">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span class="lci-history-title">History</span>
          <button id="lci-clear-history-btn" class="lci-link-btn lci-danger-link">Clear all</button>
        </div>
        <div id="lci-history-list" class="lci-history-list">
          <p class="lci-empty-state">No history yet. Submit a solution to get started!</p>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Floating Action Button (shown when panel is closed) -->
<button id="lci-fab" class="lci-fab lci-hidden" title="Open Complexity Insight" aria-label="Open LeetCode Complexity Insight">
  <span>⚡</span>
</button>
    `;
  }

  function attachOverlayListeners(container) {
    requestAnimationFrame(() => {
      const overlay = document.querySelector("#lci-overlay");
      const panel = document.querySelector("#lci-panel");
      const fab = document.querySelector("#lci-fab");
      const dragHandle = document.querySelector("#lci-drag-handle");

      // Close
      document.querySelector("#lci-close-btn")?.addEventListener("click", () => {
        overlay?.classList.add("lci-hidden");
        fab?.classList.remove("lci-hidden");
      });

      // Minimize
      document.querySelector("#lci-minimize-btn")?.addEventListener("click", () => {
        panel?.classList.toggle("lci-minimized");
      });

      // FAB — always un-minimize when reopening so user never sees a blank header-only panel
      fab?.addEventListener("click", () => {
        overlay?.classList.remove("lci-hidden");
        panel?.classList.remove("lci-minimized");
        fab?.classList.add("lci-hidden");
      });

      // Theme
      document.querySelector("#lci-theme-btn")?.addEventListener("click", () => {
        const isLight = overlay?.classList.toggle("lci-light");
        chrome.storage.local.set({ lci_theme: isLight ? "light" : "dark" });
      });

      // History toggle
      document.querySelector("#lci-history-btn")?.addEventListener("click", () => showHistoryView());
      document.querySelector("#lci-history-back-btn")?.addEventListener("click", () => showAnalysisView());

      // Clear history
      document.querySelector("#lci-clear-history-btn")?.addEventListener("click", () => {
        if (confirm("Clear all analysis history?")) {
          chrome.storage.local.remove("lci_history", () => renderHistoryList([]));
        }
      });

      // Retry
      document.querySelector("#lci-retry-btn")?.addEventListener("click", () => {
        isAnalyzing = false;
        lastSubmissionId = null;
        _lastAnalysisKey = ''; // reset dedup so retry re-triggers analysis
        checkDOMForResult(true);
      });

      // Re-analyze
      document.querySelector("#lci-refresh-btn")?.addEventListener("click", () => {
        isAnalyzing = false;
        lastSubmissionId = null;
        _lastAnalysisKey = ''; // reset dedup so re-analyze re-triggers analysis
        checkDOMForResult(true, true);
      });

      // Settings button
      document.querySelector("#lci-settings-btn")?.addEventListener("click", () => {
        showSection("lci-settings");
        // Load current key into the input
        chrome.storage.local.get(["geminiApiKey", "lci_auto_analyze", "geminiModel"], (data) => {
          const inp = document.querySelector("#lci-api-key-input");
          if (inp) inp.value = data.geminiApiKey || "";
          const tog = document.querySelector("#lci-toggle-auto-analyze");
          if (tog) tog.checked = data.lci_auto_analyze !== false;
          fetchAndPopulateOverlayModels(data.geminiApiKey, data.geminiModel);
        });
      });

      document.querySelector("#lci-settings-back-btn")?.addEventListener("click", () => showAnalysisView());

      // Open settings from the setup screen
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
          if (isStandard) {
            showSettingsFeedback("✓ API key saved!", "success");
          } else {
            showSettingsFeedback("✓ Key saved! (Unusual format)", "error");
          }
          chrome.storage.local.get("geminiModel", (data) => {
            fetchAndPopulateOverlayModels(key, data.geminiModel);
          });
        });
      });

      // Clear API key
      document.querySelector("#lci-api-clear-btn")?.addEventListener("click", () => {
        chrome.storage.local.remove(["geminiApiKey", "geminiModel"], () => {
          const inp = document.querySelector("#lci-api-key-input");
          if (inp) inp.value = "";
          showSettingsFeedback("API key cleared.", "success");
          resetOverlayModelDropdown(null);
        });
      });

      // Toggle key visibility
      document.querySelector("#lci-api-vis-btn")?.addEventListener("click", () => {
        const inp = document.querySelector("#lci-api-key-input");
        if (inp) inp.type = inp.type === "password" ? "text" : "password";
      });

      // Model select change listener
      document.querySelector("#lci-model-select")?.addEventListener("change", (e) => {
        const selectedModel = e.target.value;
        if (selectedModel) {
          chrome.storage.local.set({ geminiModel: selectedModel }, () => {
            showSettingsFeedback("✓ Model updated!", "success");
          });
        }
      });

      // Enter to save
      document.querySelector("#lci-api-key-input")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") document.querySelector("#lci-api-save-btn")?.click();
      });

      // Get free key link (both in settings and setup)
      ["#lci-get-key-link", "#lci-get-key-link2"].forEach(sel => {
        document.querySelector(sel)?.addEventListener("click", (e) => {
          e.preventDefault();
          window.open("https://aistudio.google.com/app/apikey", "_blank");
        });
      });

      // Auto-analyze toggle inside overlay
      document.querySelector("#lci-toggle-auto-analyze")?.addEventListener("change", (e) => {
        chrome.storage.local.set({ lci_auto_analyze: e.target.checked });
        showSettingsFeedback(e.target.checked ? "Auto-analyze enabled." : "Auto-analyze disabled.", "success");
      });

      // Drag
      makeDraggable(panel, dragHandle);

      // Restore theme
      chrome.storage.local.get("lci_theme", (data) => {
        if (data.lci_theme === "light") overlay?.classList.add("lci-light");
      });
    });
  }

  function showSettingsFeedback(msg, type) {
    const el = document.querySelector("#lci-api-feedback");
    if (!el) return;
    el.textContent = msg;
    el.className = `lci-settings-feedback ${type === "error" ? "lci-settings-feedback-error" : "lci-settings-feedback-ok"}`;
    setTimeout(() => { el.textContent = ""; el.className = "lci-settings-feedback"; }, 3000);
  }

  function fetchAndPopulateOverlayModels(apiKey, selectedModel) {
    const sel = document.querySelector("#lci-model-select");
    if (!sel) return;
    if (!apiKey) {
      resetOverlayModelDropdown(selectedModel);
      return;
    }

    sel.innerHTML = `<option value="">Loading models...</option>`;

    fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`)
      .then(response => {
        if (!response.ok) throw new Error("API call failed");
        return response.json();
      })
      .then(data => {
        if (!data.models || data.models.length === 0) {
          throw new Error("No models returned");
        }
        
        const geminiModels = data.models.filter(m => 
          m.supportedGenerationMethods?.includes("generateContent") &&
          m.name?.startsWith("models/gemini-")
        );

        if (geminiModels.length === 0) {
          throw new Error("No compatible Gemini models found");
        }

        sel.innerHTML = "";
        geminiModels.forEach(m => {
          const opt = document.createElement("option");
          opt.value = m.name;
          opt.textContent = m.displayName || m.name.replace("models/", "");
          if (m.name === selectedModel) {
            opt.selected = true;
          }
          sel.appendChild(opt);
        });

        const currentOptions = Array.from(sel.options).map(o => o.value);
        if (selectedModel && !currentOptions.includes(selectedModel)) {
          const opt = document.createElement("option");
          opt.value = selectedModel;
          opt.textContent = selectedModel.replace("models/", "") + " (Custom)";
          opt.selected = true;
          sel.appendChild(opt);
        } else if (!selectedModel) {
          const defaultModel = "models/gemini-2.0-flash";
          if (currentOptions.includes(defaultModel)) {
            sel.value = defaultModel;
            chrome.storage.local.set({ geminiModel: defaultModel });
          } else {
            chrome.storage.local.set({ geminiModel: sel.value });
          }
        }
      })
      .catch(err => {
        console.warn("[LCI] Failed to fetch dynamic models, using fallback list:", err);
        resetOverlayModelDropdown(selectedModel);
      });
  }

  function resetOverlayModelDropdown(selectedModel) {
    const sel = document.querySelector("#lci-model-select");
    if (!sel) return;
    const fallbacks = [
      { value: "models/gemini-2.0-flash", label: "Gemini 2.0 Flash (Default)" },
      { value: "models/gemini-1.5-flash", label: "Gemini 1.5 Flash" },
      { value: "models/gemini-1.5-pro", label: "Gemini 1.5 Pro" }
    ];
    sel.innerHTML = "";
    fallbacks.forEach(f => {
      const opt = document.createElement("option");
      opt.value = f.value;
      opt.textContent = f.label;
      if (f.value === selectedModel) opt.selected = true;
      sel.appendChild(opt);
    });
    if (selectedModel && !fallbacks.some(f => f.value === selectedModel)) {
      const opt = document.createElement("option");
      opt.value = selectedModel;
      opt.textContent = selectedModel.replace("models/", "") + " (Custom)";
      opt.selected = true;
      sel.appendChild(opt);
    } else if (!selectedModel) {
      sel.value = "models/gemini-2.0-flash";
      chrome.storage.local.set({ geminiModel: "models/gemini-2.0-flash" });
    }
  }

  // ─── Overlay View Control ──────────────────────────────────────────────────
  function showOverlay() {
    const overlay = document.querySelector("#lci-overlay");
    const panel = document.querySelector("#lci-panel");
    const fab = document.querySelector("#lci-fab");
    overlay?.classList.remove("lci-hidden");
    panel?.classList.remove("lci-minimized"); // always un-minimize when opening programmatically
    overlay?.classList.add("lci-enter");
    setTimeout(() => overlay?.classList.remove("lci-enter"), 400);
    fab?.classList.add("lci-hidden");
  }

  function showSection(id) {
    ["lci-loading", "lci-error", "lci-analysis", "lci-history", "lci-setup", "lci-settings"].forEach((sid) => {
      document.querySelector(`#${sid}`)?.classList.add("lci-hidden");
    });
    document.querySelector(`#${id}`)?.classList.remove("lci-hidden");
  }

  function showHistoryView() {
    showSection("lci-history");
    chrome.storage.local.get("lci_history", (data) => {
      renderHistoryList(data.lci_history || []);
    });
  }

  function showAnalysisView() {
    showSection("lci-analysis");
  }

  function sendToOverlay(message) {
    if (message.type === "LOADING") {
      showSection("lci-loading");
      const sub = document.querySelector("#lci-loading-sub");
      if (sub) sub.textContent = `Analyzing "${message.payload?.problemTitle || "your solution"}"…`;
    } else if (message.type === "ERROR") {
      // Show dedicated setup view for missing API key — much more helpful than generic error
      if (message.error === "NO_API_KEY") {
        showSection("lci-setup");
        return;
      }
      showSection("lci-error");
      const errEl = document.querySelector("#lci-error-msg");
      if (errEl) errEl.textContent = humanizeError(message.error);
    } else if (message.type === "ANALYSIS_RESULT") {
      renderAnalysis(message.data);
      showSection("lci-analysis");
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
    if (data.fromCache) {
      cacheNotice?.classList.remove("lci-hidden");
    } else {
      cacheNotice?.classList.add("lci-hidden");
    }
  }

  // ─── History Render ────────────────────────────────────────────────────────
  function renderHistoryList(history) {
    const listEl = document.querySelector("#lci-history-list");
    if (!listEl) return;

    if (!history?.length) {
      listEl.innerHTML = '<p class="lci-empty-state">No history yet. Submit a solution to get started!</p>';
      return;
    }

    listEl.innerHTML = history
      .map(
        (entry) => `
      <div class="lci-history-item" tabindex="0" data-cache-key="${escHtml(entry.cacheKey || "")}">
        <div class="lci-hi-top">
          <span class="lci-hi-title">${escHtml(entry.problemTitle || "Unknown")}</span>
          <span class="lci-verdict-badge lci-verdict-${entry.verdict === "Accepted" ? "ok" : "err"} lci-chip-sm">
            ${escHtml(entry.verdict || "")}
          </span>
        </div>
        <div class="lci-hi-bottom">
          <span class="lci-chip lci-chip-lang lci-chip-sm">${escHtml(entry.language || "")}</span>
          <span class="lci-chip lci-chip-time lci-chip-sm">T: ${escHtml(entry.timeComplexity || "?")}</span>
          <span class="lci-chip lci-chip-space lci-chip-sm">S: ${escHtml(entry.spaceComplexity || "?")}</span>
          <span class="lci-hi-date">${formatDate(entry.analyzedAt)}</span>
        </div>
      </div>
    `
      )
      .join("");

    listEl.querySelectorAll(".lci-history-item").forEach((item) => {
      const activate = () => {
        const key = item.dataset.cacheKey;
        chrome.storage.local.get(key, (data) => {
          if (data[key]) {
            renderAnalysis(data[key]);
            showAnalysisView();
          }
        });
      };
      item.addEventListener("click", activate);
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") activate();
      });
    });
  }

  // ─── Drag ──────────────────────────────────────────────────────────────────
  function makeDraggable(panel, handle) {
    if (!panel || !handle) return;
    let dragging = false, ox = 0, oy = 0, sx = 0, sy = 0;

    handle.style.cursor = "grab";

    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      handle.style.cursor = "grabbing";
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

    document.addEventListener("mouseup", () => {
      dragging = false;
      handle.style.cursor = "grab";
    });
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────
  function setText(sel, val) {
    const el = document.querySelector(sel);
    if (el) el.textContent = val;
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
    if (errStr.includes("401") || errStr.includes("403")) return "Invalid API key. Check your Gemini API key in the extension settings.";
    if (errStr.includes("429")) return "Rate limit reached. Please wait a moment and try again.";
    if (errStr.toLowerCase().includes("503") || errStr.toLowerCase().includes("overloaded") || errStr.toLowerCase().includes("high demand") || errStr.toLowerCase().includes("unavailable")) {
      return "Google's Gemini servers are temporarily overloaded (503 High Demand). This is a Google service-wide issue, not your quota. Please try again in a few moments.";
    }
    if (errStr.includes("network") || errStr.includes("fetch")) return "Network error. Please check your internet connection.";
    return errStr.length > 120 ? errStr.substring(0, 120) + "…" : errStr;
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  // Respect the enabled toggle from popup
  chrome.storage.local.get("lci_enabled", (data) => {
    // Default to enabled if setting has never been set
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
