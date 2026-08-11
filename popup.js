/**
 * popup.js — Extension popup logic
 * Handles: API key save/load/clear, enable toggle, cache stats
 *
 * Notes:
 * - window.confirm() is NOT available in Chrome extension popups — never use it
 * - chrome.tabs.create() requires the 'tabs' permission in manifest
 * - External font loading may be blocked by MV3 CSP — use system fonts only
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
  const getKeyLink = document.getElementById("get-key-link");

  const modelSelect = document.getElementById("model-select");

  // ─── Load Saved Settings ───────────────────────────────────────────────────
  chrome.storage.local.get(
    ["geminiApiKey", "lci_enabled", "lci_history", "geminiModel"],
    (data) => {
      if (data.geminiApiKey) {
        apiKeyInput.value = data.geminiApiKey;
        setStatus("active", "Ready");
        fetchAndPopulateModels(data.geminiApiKey, data.geminiModel);
      } else {
        setStatus("inactive", "No API key");
        resetModelDropdown(data.geminiModel);
      }

      toggleEnabled.checked = data.lci_enabled !== false; // default: true

      const count = (data.lci_history || []).length;
      cacheCount.textContent = count;
    }
  );

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
        
        const geminiModels = data.models.filter(m => 
          m.supportedGenerationMethods?.includes("generateContent") &&
          m.name?.startsWith("models/gemini-")
        );

        if (geminiModels.length === 0) {
          throw new Error("No compatible Gemini models found");
        }

        modelSelect.innerHTML = "";
        geminiModels.forEach(m => {
          const opt = document.createElement("option");
          opt.value = m.name;
          opt.textContent = m.displayName || m.name.replace("models/", "");
          if (m.name === selectedModel) {
            opt.selected = true;
          }
          modelSelect.appendChild(opt);
        });

        const currentOptions = Array.from(modelSelect.options).map(o => o.value);
        if (selectedModel && !currentOptions.includes(selectedModel)) {
          const opt = document.createElement("option");
          opt.value = selectedModel;
          opt.textContent = selectedModel.replace("models/", "") + " (Custom)";
          opt.selected = true;
          modelSelect.appendChild(opt);
        } else if (!selectedModel) {
          const defaultModel = "models/gemini-2.0-flash";
          if (currentOptions.includes(defaultModel)) {
            modelSelect.value = defaultModel;
            chrome.storage.local.set({ geminiModel: defaultModel });
          } else {
            chrome.storage.local.set({ geminiModel: modelSelect.value });
          }
        }
      })
      .catch(err => {
        console.warn("[LCI] Failed to fetch dynamic models, using fallback list:", err);
        resetModelDropdown(selectedModel);
      });
  }

  function resetModelDropdown(selectedModel) {
    const fallbacks = [
      { value: "models/gemini-2.0-flash", label: "Gemini 2.0 Flash (Default)" },
      { value: "models/gemini-1.5-flash", label: "Gemini 1.5 Flash" },
      { value: "models/gemini-1.5-pro", label: "Gemini 1.5 Pro" }
    ];
    modelSelect.innerHTML = "";
    fallbacks.forEach(f => {
      const opt = document.createElement("option");
      opt.value = f.value;
      opt.textContent = f.label;
      if (f.value === selectedModel) opt.selected = true;
      modelSelect.appendChild(opt);
    });
    if (selectedModel && !fallbacks.some(f => f.value === selectedModel)) {
      const opt = document.createElement("option");
      opt.value = selectedModel;
      opt.textContent = selectedModel.replace("models/", "") + " (Custom)";
      opt.selected = true;
      modelSelect.appendChild(opt);
    } else if (!selectedModel) {
      modelSelect.value = "models/gemini-2.0-flash";
      chrome.storage.local.set({ geminiModel: "models/gemini-2.0-flash" });
    }
  }

  // ─── Enable Toggle ─────────────────────────────────────────────────────────
  toggleEnabled.addEventListener("change", () => {
    const enabled = toggleEnabled.checked;
    chrome.storage.local.set({ lci_enabled: enabled });
    setStatus(enabled ? "active" : "inactive", enabled ? "Ready" : "Disabled");
    // lci_enabled is read at boot time by content.js, so already-open LeetCode
    // tabs won't see this change until reloaded — notify the user.
    showFeedback(enabled ? "Enabled — reload LeetCode tabs to activate." : "Disabled — reload LeetCode tabs to deactivate.", "success");
  });

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
          cacheCount.textContent = "0";
          showFeedback("Cache already empty.", "success");
          return;
        }
        chrome.storage.local.remove(keysToRemove, () => {
          cacheCount.textContent = "0";
          showFeedback("Cache cleared.", "success");
        });
      });
    });

    document.getElementById("lci-confirm-no").addEventListener("click", () => {
      row.remove();
    });
  });

  // ─── Get Free Key Link — opens in new tab ─────────────────────────────────
  // Use chrome.tabs.create (requires 'tabs' permission in manifest)
  getKeyLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "https://aistudio.google.com/app/apikey" });
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────
  function setStatus(state, text) {
    statusDot.className = `status-dot ${state}`;
    statusText.textContent = text;
  }

  function showFeedback(msg, type = "success") {
    keyFeedback.textContent = msg;
    keyFeedback.className = `popup-feedback ${type === "error" ? "error" : ""}`;
    setTimeout(() => {
      keyFeedback.classList.add("fade");
      setTimeout(() => {
        keyFeedback.textContent = "";
        keyFeedback.className = "popup-feedback";
      }, 300);
    }, 2500);
  }
});
