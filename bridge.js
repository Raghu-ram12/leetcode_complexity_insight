/**
 * bridge.js — Runs in PAGE context via chrome.runtime.getURL injection.
 * Intercepts XHR, fetch, and GraphQL to catch LeetCode submission results.
 * Communicates with content.js via CustomEvents on window.
 */
(function () {
  "use strict";

  // ─── Code Request Handler ────────────────────────────────────────────────────
  window.addEventListener("__lci_request_code", function () {
    try {
      // Try Monaco editor models (most reliable)
      const models = window.monaco?.editor?.getModels?.();
      if (models && models.length > 0) {
        const code = models[0].getValue();
        const lang =
          document.querySelector(".monaco-editor")?.getAttribute("data-mode-id") || "";
        window.dispatchEvent(
          new CustomEvent("__lci_code_response", { detail: { code, lang } })
        );
        return;
      }
    } catch (e) {}
    window.dispatchEvent(
      new CustomEvent("__lci_code_response", { detail: { code: null, lang: null } })
    );
  });

  // ─── Unified result dispatcher ───────────────────────────────────────────────
  function maybeDispatchResult(data) {
    if (!data) return;
    // LeetCode submission check response shape
    if (data.status_msg && data.status_msg !== "Pending" && data.status_msg !== "Checking") {
      window.dispatchEvent(
        new CustomEvent("__lci_submission_result", { detail: data })
      );
      return;
    }
    // GraphQL response shape: data.submissionDetails or data.data.submissionDetails
    const sub = data?.data?.submissionDetails || data?.submissionDetails;
    if (sub && sub.statusCode) {
      const statusMap = {
        10: "Accepted", 11: "Wrong Answer", 12: "Memory Limit Exceeded",
        13: "Output Limit Exceeded", 14: "Time Limit Exceeded",
        15: "Runtime Error", 16: "Compile Error", 20: "Compile Error",
      };
      window.dispatchEvent(
        new CustomEvent("__lci_submission_result", {
          detail: {
            status_msg: statusMap[sub.statusCode] || "Unknown",
            status_code: sub.statusCode,
            runtime: sub.runtimeDisplay || sub.runtime,
            memory: sub.memoryDisplay || sub.memory,
            runtime_percentile: sub.runtimePercentile,
            memory_percentile: sub.memoryPercentile,
          },
        })
      );
    }
  }

  // ─── XHR Interception ────────────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lci_url = String(url || "");
    this.__lci_method = String(method || "");
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener("load", function () {
      try {
        const url = this.__lci_url;
        // Classic check endpoint
        if (url.includes("/check/") || url.includes("submissions/detail")) {
          maybeDispatchResult(JSON.parse(this.responseText));
        }
        // GraphQL endpoint
        if (url.includes("/graphql") || url.includes("graphql/")) {
          const req = tryParseJSON(typeof body === "string" ? body : "");
          const res = tryParseJSON(this.responseText);
          if (isSubmissionQuery(req)) maybeDispatchResult(res);
        }
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  // ─── Fetch Interception ───────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    const body = init?.body || "";
    const promise = origFetch.apply(this, arguments);

    const relevant =
      url.includes("/check/") ||
      url.includes("submissions/detail") ||
      url.includes("/graphql") ||
      url.includes("graphql/");

    if (relevant) {
      promise
        .then((r) => r.clone().json())
        .then((data) => {
          // For graphql, check if it's a submission-related query
          if (url.includes("graphql")) {
            const req = tryParseJSON(typeof body === "string" ? body : "");
            if (!isSubmissionQuery(req)) return;
          }
          maybeDispatchResult(data);
        })
        .catch((e) => console.warn("[LCI] Fetch interception error:", e));
    }
    return promise;
  };

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  function tryParseJSON(str) {
    try { return JSON.parse(str); } catch { return null; }
  }

  function isSubmissionQuery(parsed) {
    if (!parsed) return false;
    const q = parsed.query || parsed.operationName || "";
    return (
      q.includes("submissionDetails") ||
      q.includes("SubmissionDetails") ||
      q.includes("checkSubmission") ||
      q.includes("submission")
    );
  }

  window.dispatchEvent(new Event("__lci_bridge_ready"));
  console.log("[LCI] Bridge loaded in page context");
})();
