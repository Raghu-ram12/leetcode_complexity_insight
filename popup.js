/**
 * popup.js — Extension popup logic
 * Handles: API key save/load/clear, enable toggle, cache stats
 *
 * FIX #8:  Toggle shows warning + inline "Reload Now" button
 * FIX #9:  Cache shows real byte count via getBytesInUse
 * FIX #13: GitHub link points to real repo URL
 * FIX #16: Privacy note font increased via CSS
 * FIX #20: Status has 2s fallback timeout so "Checking…" never hangs
 */

document.addEventListener("DOMContentLoaded", () => {
  const apiKeyInput = document.getElementById("api-key-input");
  const toggleVisBtn = document.getElementById("toggle-key-visibility");
  const saveKeyBtn = document.getElementById("save-key-btn");
  const clearKeyBtn = document.getElementById("clear-key-btn");
  const keyFeedback = document.getElementById("key-feedback");
  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const toggleEnabled = document.getElementById("toggle-enabled");
  const clearCacheBtn = document.getElementById("clear-cache-btn");
  const cacheCount = document.getElementById("cache-count");
  const cacheSize = document.getElementById("cache-size");
  const getKeyLink = document.getElementById("get-key-link");
  const githubLink = document.getElementById("github-link");
  const modelSelect = document.getElementById("model-select");
  const reloadContainer = document.getElementById("reload-prompt-container");
  const streakDot = document.getElementById("streak-dot");
  const streakText = document.getElementById("streak-text");

  // ─── Tab Navigation ─────────────────────────────────────────────────────────
  const tabBtns = document.querySelectorAll(".popup-tab-btn");
  const tabDashboard = document.getElementById("tab-dashboard");
  const tabSettings = document.getElementById("tab-settings");

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      tabBtns.forEach((b) => b.classList.remove("popup-tab-active"));
      btn.classList.add("popup-tab-active");
      if (tab === "dashboard") {
        tabDashboard.classList.remove("popup-tab-hidden");
        tabSettings.classList.add("popup-tab-hidden");
      } else {
        tabDashboard.classList.add("popup-tab-hidden");
        tabSettings.classList.remove("popup-tab-hidden");
      }
    });
  });

  // FIX #20: Status fallback — if storage is slow, don't hang on "Checking…"
  const statusTimeout = setTimeout(() => {
    setStatus("inactive", "No API key");
  }, 2000);

  // ─── Load Saved Settings ───────────────────────────────────────────────────
  chrome.storage.local.get(
    ["geminiApiKey", "lci_enabled", "lci_history", "geminiModel"],
    (data) => {
      clearTimeout(statusTimeout);

      if (data.geminiApiKey) {
        apiKeyInput.value = data.geminiApiKey;
        setStatus("active", "Ready");
        fetchAndPopulateModels(data.geminiApiKey, data.geminiModel);
      } else {
        setStatus("inactive", "No API key");
        resetModelDropdown(data.geminiModel);
      }

      toggleEnabled.checked = data.lci_enabled !== false; // default: true

      // FIX #3/#9: Show "0" immediately, then update with real count + size
      const count = (data.lci_history || []).length;
      cacheCount.textContent = count;
      updateCacheSize();

      // ── Render home dashboard: streak + recent problems ──
      renderHomeDashboard(data.lci_history || []);
    }
  );

  // ─── Render Home Dashboard ─────────────────────────────────────────────────
  function renderHomeDashboard(history) {
    // Streak
    chrome.runtime.sendMessage({ type: "GET_STREAK" }, (response) => {
      const streak = response?.streak || { current: 0, best: 0, lastDate: null };
      const currentEl = document.getElementById("streak-current-value");
      const bestEl = document.getElementById("streak-best-value");
      const dotEl = streakDot;
      const textEl = streakText;

      if (currentEl) currentEl.textContent = streak.current || 0;
      if (bestEl) bestEl.textContent = streak.best || 0;

      if (dotEl && textEl) {
        dotEl.className = "status-dot streak-dot " + (streak.current > 0 ? "active" : "");
        textEl.textContent = streak.current > 0
          ? `${streak.current} day${streak.current !== 1 ? "s" : ""} streak`
          : "No streak yet";
      }
    });

    // Recent analyzed problems, newest first.
    const recentList = document.getElementById("recent-problems-list");
    const recentEmpty = document.getElementById("recent-empty-problems");
    const recent = (history || [])
      .slice(0, 6);

    if (recentList && recentEmpty) {
      if (recent.length > 0) {
        recentEmpty.style.display = "none";
        recentList.innerHTML = recent.map((entry, i) => `
          <div class="recent-problem-item" style="opacity: ${1 - i * 0.1}; transition: opacity 0.3s;">
            <span class="recent-problem-title">${escHtml(entry.problemTitle || "Unknown Problem")}</span>
            <span class="recent-problem-date">${formatDate(entry.analyzedAt)}</span>
          </div>
        `).join("");
      } else {
        recentEmpty.style.display = "block";
        recentList.innerHTML = "";
      }
    }
  }

  // ─── Helper: escape HTML ─────────────────────────────────────────────────
  function escHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ─── Helper: format date ─────────────────────────────────────────────────
  function formatDate(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: "short", day: "numeric",
      });
    } catch { return ""; }
  }

  // FIX #9: Show storage bytes used
  function updateCacheSize() {
    if (!chrome.storage.local.getBytesInUse) {
      if (cacheSize) cacheSize.textContent = "";
      return;
    }
    chrome.storage.local.getBytesInUse(null, (bytes) => {
      if (cacheSize) {
        if (bytes < 1024) {
          cacheSize.textContent = `~${bytes} B used`;
        } else {
          cacheSize.textContent = `~${(bytes / 1024).toFixed(1)} KB used`;
        }
      }
    });
  }

  // ─── Save API Key ──────────────────────────────────────────────────────────
  saveKeyBtn.addEventListener("click", () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      showFeedback("Please enter an API key.", "error");
      return;
    }
    const isStandard = key.startsWith("AIza") || key.startsWith("AQ");
    chrome.storage.local.set({ geminiApiKey: key }, () => {
      if (isStandard) {
        showFeedback("✓ API key saved!", "success");
      } else {
        showFeedback("✓ Key saved! (Unusual format)", "error");
      }
      setStatus("active", "Ready");

      // Fetch models with the new key
      chrome.storage.local.get("geminiModel", (data) => {
        fetchAndPopulateModels(key, data.geminiModel);
      });
    });
  });

  // ─── Clear API Key ─────────────────────────────────────────────────────────
  clearKeyBtn.addEventListener("click", () => {
    chrome.storage.local.remove(["geminiApiKey", "geminiModel"], () => {
      apiKeyInput.value = "";
      showFeedback("API key cleared.", "success");
      setStatus("inactive", "No API key");
      resetModelDropdown(null);
    });
  });

  // ─── Model Selection Change ────────────────────────────────────────────────
  modelSelect.addEventListener("change", () => {
    const selectedModel = modelSelect.value;
    if (selectedModel) {
      chrome.storage.local.set({ geminiModel: selectedModel }, () => {
        showFeedback("✓ Model updated!", "success");
      });
    }
  });

  // ─── Toggle Key Visibility ─────────────────────────────────────────────────
  toggleVisBtn.addEventListener("click", () => {
    const isHidden = apiKeyInput.type === "password";
    apiKeyInput.type = isHidden ? "text" : "password";
    toggleVisBtn.setAttribute("aria-label", isHidden ? "Hide key" : "Show key");
  });

  // ─── Enter to Save ─────────────────────────────────────────────────────────
  apiKeyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveKeyBtn.click();
  });

  // ─── Allowed models (single source of truth) ──────────────────────────────
  const ALLOWED_MODELS = [
    { value: "models/gemini-3.6-flash", label: "Gemini 3.6 Flash (Default)" },
    { value: "models/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
  ];

  // ─── Dynamic Model Fetcher Helpers ─────────────────────────────────────────
  function fetchAndPopulateModels(apiKey, selectedModel) {
    if (!apiKey) {
      resetModelDropdown(selectedModel);
      return;
    }

    modelSelect.innerHTML = `<option value="">Loading models...</option>`;

    fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`)
      .then(response => {
        if (!response.ok) throw new Error("API call failed");
        return response.json();
      })
      .then(data => {
        if (!data.models || data.models.length === 0) {
          throw new Error("No models returned");
        }

        // Only show the curated allowed models that the API confirms exist
        const availableNames = new Set(data.models.map(m => m.name));
        const filtered = ALLOWED_MODELS.filter(m => availableNames.has(m.value));

        // Fall back to full allowed list if API doesn't confirm any (e.g. key restriction)
        const toShow = filtered.length > 0 ? filtered : ALLOWED_MODELS;

        modelSelect.innerHTML = "";
        toShow.forEach(m => {
          const opt = document.createElement("option");
          opt.value = m.value;
          opt.textContent = m.label;
          if (m.value === selectedModel) opt.selected = true;
          modelSelect.appendChild(opt);
        });

        // If the saved model isn't in our allowed list, default to first
        const currentOptions = Array.from(modelSelect.options).map(o => o.value);
        if (selectedModel && !currentOptions.includes(selectedModel)) {
          modelSelect.value = currentOptions[0];
          chrome.storage.local.set({ geminiModel: currentOptions[0] });
        } else if (!selectedModel) {
          const def = ALLOWED_MODELS[0].value;
          modelSelect.value = currentOptions.includes(def) ? def : currentOptions[0];
          chrome.storage.local.set({ geminiModel: modelSelect.value });
        }
      })
      .catch(err => {
        console.warn("[LCI] Failed to fetch dynamic models, using fallback list:", err);
        resetModelDropdown(selectedModel);
      });
  }

  function resetModelDropdown(selectedModel) {
    modelSelect.innerHTML = "";
    ALLOWED_MODELS.forEach(f => {
      const opt = document.createElement("option");
      opt.value = f.value;
      opt.textContent = f.label;
      if (f.value === selectedModel) opt.selected = true;
      modelSelect.appendChild(opt);
    });
    if (!selectedModel || !ALLOWED_MODELS.some(f => f.value === selectedModel)) {
      modelSelect.value = ALLOWED_MODELS[0].value;
      chrome.storage.local.set({ geminiModel: ALLOWED_MODELS[0].value });
    }
  }

  // ─── Enable Toggle (FIX #8) ────────────────────────────────────────────────
  // Shows warning color + inline "Reload Now" button since change requires reload
  toggleEnabled.addEventListener("change", () => {
    const enabled = toggleEnabled.checked;
    chrome.storage.local.set({ lci_enabled: enabled });
    setStatus(enabled ? "active" : "inactive", enabled ? "Ready" : "Disabled");

    // FIX #8: Show reload prompt with actual button
    showReloadPrompt(
      enabled
        ? "Enabled — reload open LeetCode tabs to activate."
        : "Disabled — reload open LeetCode tabs to deactivate."
    );
  });

  // FIX #8: Inline reload row with a "Reload Now" button
  function showReloadPrompt(msg) {
    if (!reloadContainer) return;
    reloadContainer.innerHTML = "";

    const row = document.createElement("div");
    row.className = "popup-reload-row";
    row.innerHTML = `
      <span class="popup-reload-text">${msg}</span>
      <button class="popup-reload-btn" id="do-reload-btn">Reload Now</button>
    `;
    reloadContainer.appendChild(row);

    document.getElementById("do-reload-btn")?.addEventListener("click", () => {
      chrome.tabs.query({ url: ["*://leetcode.com/*", "*://www.leetcode.com/*"] }, (tabs) => {
        tabs.forEach(tab => chrome.tabs.reload(tab.id));
        row.innerHTML = `<span class="popup-reload-text" style="color:var(--green)">✓ Reloaded ${tabs.length} LeetCode tab${tabs.length !== 1 ? 's' : ''}.</span>`;
        setTimeout(() => { reloadContainer.innerHTML = ""; }, 2500);
      });
    });

    // Auto-dismiss after 8 seconds
    setTimeout(() => {
      if (reloadContainer.contains(row)) reloadContainer.innerHTML = "";
    }, 8000);
  }

  // ─── Clear Cache (no confirm() — blocked in extension popups) ─────────────
  clearCacheBtn.addEventListener("click", () => {
    // Show inline confirmation instead of window.confirm()
    const existing = document.getElementById("lci-confirm-row");
    if (existing) { existing.remove(); return; }

    const row = document.createElement("div");
    row.id = "lci-confirm-row";
    row.style.cssText = `
      display:flex; align-items:center; gap:8px; margin-top:8px;
      padding:8px 10px; background:rgba(255,92,92,0.1);
      border:1px solid rgba(255,92,92,0.25); border-radius:7px;
    `;
    row.innerHTML = `
      <span style="font-size:11px;color:#ff5c5c;flex:1;">Clear all cached analyses?</span>
      <button id="lci-confirm-yes" style="background:#ff5c5c;color:#fff;border:none;border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;">Yes</button>
      <button id="lci-confirm-no" style="background:transparent;color:#8b92a9;border:1px solid rgba(255,255,255,0.1);border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;">No</button>
    `;
    clearCacheBtn.parentElement.appendChild(row);

    document.getElementById("lci-confirm-yes").addEventListener("click", () => {
      row.remove();
      chrome.storage.local.get(null, (allData) => {
        const keysToRemove = Object.keys(allData).filter(
          (k) => k.startsWith("v1_") || k === "lci_history"
        );
        if (keysToRemove.length === 0) {
          animateCacheCount(0);
          if (cacheSize) cacheSize.textContent = "";
          showFeedback("Cache already empty.", "success");
          return;
        }
        chrome.storage.local.remove(keysToRemove, () => {
          animateCacheCount(0);
          if (cacheSize) cacheSize.textContent = "~0 B used";
          showFeedback("Cache cleared.", "success");
        });
      });
    });

    document.getElementById("lci-confirm-no").addEventListener("click", () => {
      row.remove();
    });
  });

  // FIX #9: Animate cache count number
  function animateCacheCount(newVal) {
    if (!cacheCount) return;
    cacheCount.style.transform = "scale(1.3)";
    cacheCount.textContent = newVal;
    setTimeout(() => { cacheCount.style.transform = "scale(1)"; }, 200);
  }

  // ─── Get Free Key Link — opens in new tab ─────────────────────────────────
  getKeyLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "https://aistudio.google.com/app/apikey" });
  });

  // FIX #13: GitHub link — opens in new tab (real URL set in HTML)
  githubLink?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: githubLink.href });
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────
  function setStatus(state, text) {
    statusDot.className = `status-dot ${state}`;
    statusText.textContent = text;
  }

  function showFeedback(msg, type = "success") {
    keyFeedback.textContent = msg;
    // FIX #8: warning type for reload messages
    const cls = type === "error" ? "error" : type === "warning" ? "warning" : "";
    keyFeedback.className = `popup-feedback ${cls}`;
    setTimeout(() => {
      keyFeedback.classList.add("fade");
      setTimeout(() => {
        keyFeedback.textContent = "";
        keyFeedback.className = "popup-feedback";
      }, 300);
    }, 2500);
  }
});
