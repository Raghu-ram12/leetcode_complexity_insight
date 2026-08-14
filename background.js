/**
 * background.js — Service Worker
 * Handles LLM API calls (Google Gemini), caching, and message routing.
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "models/gemini-2.0-flash";
const CACHE_VERSION = "v1";

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ANALYZE_SUBMISSION") {
    handleAnalysis(message.payload)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async response
  }

  if (message.type === "GET_CACHE") {
    const cacheKey = buildCacheKey(message.payload);
    chrome.storage.local.get(cacheKey, (data) => {
      sendResponse({ data: data[cacheKey] || null });
    });
    return true;
  }

  if (message.type === "CLEAR_CACHE") {
    chrome.storage.local.clear(() => sendResponse({ success: true }));
    return true;
  }
});

// ─── Main Analysis Handler ─────────────────────────────────────────────────────
async function handleAnalysis(payload) {
  const cacheKey = buildCacheKey(payload);

  // Check cache first (unless bypassed)
  if (!payload.bypassCache) {
    const cached = await getCached(cacheKey);
    if (cached) {
      console.log("[LCI] Returning cached analysis for:", payload.problemTitle);
      return { ...cached, fromCache: true };
    }
  } else {
    console.log("[LCI] Bypassing cache for:", payload.problemTitle);
  }

  // Get API key and model
  const { geminiApiKey, geminiModel } = await chrome.storage.local.get(["geminiApiKey", "geminiModel"]);
  if (!geminiApiKey) {
    throw new Error("NO_API_KEY");
  }

  const model = geminiModel || DEFAULT_MODEL;

  // Call Gemini
  const analysis = await callGeminiAPI(geminiApiKey, model, payload);

  // Validate & sanitize (strip any code that slipped through)
  const sanitized = sanitizeAnalysis(analysis);

  // Cache the result
  const resultToStore = {
    ...sanitized,
    submissionMeta: {
      language: payload.language,
      verdict: payload.verdict,
      runtime: payload.runtime,
      memory: payload.memory,
      runtimePercentile: payload.runtimePercentile,
      memoryPercentile: payload.memoryPercentile,
    },
    problemTitle: payload.problemTitle,
    difficulty: payload.difficulty,
    analyzedAt: new Date().toISOString(),
  };

  await storeCache(cacheKey, resultToStore);

  // Also push to history list
  await pushToHistory({
    cacheKey,
    problemTitle: payload.problemTitle,
    difficulty: payload.difficulty,
    verdict: payload.verdict,
    language: payload.language,
    analyzedAt: resultToStore.analyzedAt,
    timeComplexity: sanitized.timeComplexity,
    spaceComplexity: sanitized.spaceComplexity,
  });

  return { ...resultToStore, fromCache: false };
}

// ─── Gemini API Call ───────────────────────────────────────────────────────────
async function callGeminiAPI(apiKey, model, payload) {
  const prompt = buildPrompt(payload);
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;

  const requestBody = {
    system_instruction: {
      parts: [{ text: getSystemPrompt() }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1500,
      responseMimeType: "application/json",
    },
  };

  const maxRetries = 3;
  let attempt = 0;

  while (true) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
    } catch (fetchErr) {
      if (attempt < maxRetries) {
        attempt++;
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 300;
        console.warn(`[LCI] Fetch failed: ${fetchErr.message}. Retrying in ${Math.round(delay)}ms (attempt ${attempt}/${maxRetries})...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw fetchErr;
    }

    if (!response.ok) {
      const errText = await response.text();
      let errMsg = `Gemini API error ${response.status}`;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.error?.message) errMsg = errJson.error.message;
      } catch {}

      // Retry on 429 (Rate Limit) or 503/504 (Server Overload / Timeout)
      if ((response.status === 429 || response.status === 503 || response.status === 504) && attempt < maxRetries) {
        attempt++;
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 300;
        console.warn(`[LCI] Gemini API error ${response.status}: ${errMsg}. Retrying in ${Math.round(delay)}ms (attempt ${attempt}/${maxRetries})...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw new Error(errMsg);
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error("Empty response from Gemini API");

    try {
      return extractJSON(rawText);
    } catch (err) {
      console.error("[LCI] Failed to parse JSON response. Raw text was:", rawText);
      throw new Error("Failed to parse JSON response from Gemini API");
    }
  }
}

function extractJSON(text) {
  if (!text) return null;
  let cleanText = text.trim();

  // Strip markdown formatting if present
  if (cleanText.startsWith("```json")) {
    cleanText = cleanText.substring(7);
  } else if (cleanText.startsWith("```")) {
    cleanText = cleanText.substring(3);
  }
  if (cleanText.endsWith("```")) {
    cleanText = cleanText.substring(0, cleanText.length - 3);
  }
  cleanText = cleanText.trim();

  try {
    return JSON.parse(cleanText);
  } catch (e) {
    // Fallback: try to locate the main JSON object block
    const firstOpen = cleanText.indexOf('{');
    const lastClose = cleanText.lastIndexOf('}');
    if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
      const candidate = cleanText.substring(firstOpen, lastClose + 1);
      try {
        return JSON.parse(candidate);
      } catch (innerError) {
        console.error("[LCI] Fallback JSON parse failed:", innerError);
      }
    }
    throw e;
  }
}

// ─── Prompt Builder ────────────────────────────────────────────────────────────
function getSystemPrompt() {
  return `You are an expert computer science tutor and competitive programming mentor specializing in algorithm analysis.

ABSOLUTE RULES — NEVER VIOLATE THESE:
1. NEVER output any code, pseudocode, function signatures, variable declarations, or syntax of any programming language.
2. NEVER use backticks, angle brackets, or code-block formatting.
3. ALL explanations must be in plain, conversational English prose only.
4. You MUST return a valid JSON object matching the schema exactly. No markdown wrapper, no explanation outside JSON.

Your task is to:
- Analyze the algorithmic approach from code structure signals (loops, recursion, data structures used)
- Estimate time and space complexity in Big-O notation
- Identify the pattern/paradigm the user employed
- Suggest a better conceptual approach if one exists — by NAME and INTUITION ONLY, never by implementation
- Keep all text concise: each field should be 1-3 sentences max

JSON SCHEMA (return exactly this structure):
{
  "timeComplexity": "Big-O notation string, e.g. O(n²)",
  "spaceComplexity": "Big-O notation string, e.g. O(n)",
  "timeReasoning": "Plain English explanation of WHY this is the time complexity",
  "spaceReasoning": "Plain English explanation of WHY this is the space complexity",
  "patternsDetected": ["array of pattern strings, e.g. nested loops, hash map, recursion, memoization, sorting"],
  "codeSmells": ["array of conceptual concerns, e.g. repeated linear scans, no early termination, unbounded recursion without memoization"],
  "approachUsed": "Name of the paradigm used, e.g. Brute Force, Dynamic Programming, Greedy, Two Pointer",
  "betterApproach": {
    "exists": true or false,
    "name": "Name of the better technique, e.g. Sliding Window, Binary Search",
    "whyBetter": "Plain English: why it improves over current approach",
    "intuition": "Plain English: the core insight or invariant behind this technique",
    "expectedTimeComplexity": "e.g. O(n)",
    "expectedSpaceComplexity": "e.g. O(1)",
    "whyMatters": "Connection to interviews or real-world significance"
  }
}`;
}

function buildPrompt(payload) {
  const lines = [
    `Problem: ${payload.problemTitle} (${payload.difficulty || "Unknown difficulty"})`,
    `Language: ${payload.language}`,
    `Verdict: ${payload.verdict}`,
  ];
  if (payload.runtime) lines.push(`Runtime: ${payload.runtime}${payload.runtimePercentile ? ` — ${payload.runtimePercentile}` : ""}`);
  if (payload.memory) lines.push(`Memory: ${payload.memory}${payload.memoryPercentile ? ` — ${payload.memoryPercentile}` : ""}`);
  lines.push("", "Code to analyze:", "```", payload.code || "(code not available)", "```");
  return lines.join("\n");
}

// ─── Safety Sanitizer ─────────────────────────────────────────────────────────
function sanitizeAnalysis(analysis) {
  // Deep-clone and sanitize all string fields
  const clone = JSON.parse(JSON.stringify(analysis));

  function sanitizeString(str) {
    if (typeof str !== "string") return str;
    // Strip code blocks
    str = str.replace(/```[\s\S]*?```/g, "[code removed]");
    str = str.replace(/`[^`]*`/g, "[code removed]");
    // Strip lines that look like code: must have assignment/arrow-fn/block chars together
    // Avoids stripping valid reasoning like "runs O(n); inner loop adds O(n)" (lone semicolon)
    str = str.replace(/^.*(?:(?:=|=>|:=)[^\n]*[{};]|[{};][^\n]*(?:=|=>)).*$/gm, "[code removed]");
    str = str.replace(/^\s*(?:function|class|const|let|var|return|if|for|while)\b.*$/gm, "[code removed]");
    return str.trim();
  }

  function sanitizeDeep(obj) {
    if (typeof obj === "string") return sanitizeString(obj);
    if (Array.isArray(obj)) return obj.map(sanitizeDeep);
    if (typeof obj === "object" && obj !== null) {
      return Object.fromEntries(
        Object.entries(obj).map(([k, v]) => [k, sanitizeDeep(v)])
      );
    }
    return obj;
  }

  return sanitizeDeep(clone);
}

// ─── Cache Helpers ─────────────────────────────────────────────────────────────
function buildCacheKey(payload) {
  const safeTitle = (payload.problemTitle || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .substring(0, 60);
  const safeLang = (payload.language || "unknown").toLowerCase();
  return `${CACHE_VERSION}_${safeTitle}_${safeLang}`;
}

function getCached(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (data) => resolve(data[key] || null));
  });
}

function storeCache(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

async function pushToHistory(entry) {
  return new Promise((resolve) => {
    chrome.storage.local.get("lci_history", (data) => {
      const history = data.lci_history || [];
      // Remove existing entry for same problem+language if any
      const filtered = history.filter((h) => h.cacheKey !== entry.cacheKey);
      // Add newest at front, keep max 50
      filtered.unshift(entry);
      chrome.storage.local.set({ lci_history: filtered.slice(0, 50) }, resolve);
    });
  });
}
