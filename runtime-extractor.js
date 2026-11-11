/**
 * runtime-extractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Dedicated module for reliably extracting Runtime & Memory stats from the
 * LeetCode submission results page.
 *
 * Problem: LeetCode renders result stats asynchronously (React / SPA), so a
 * single-shot DOM query often hits before the numbers are painted.
 *
 * Strategy:
 *   1. Try the official data-e2e-locator attributes (fastest when present).
 *   2. Try a broad set of CSS class/text heuristics used across LeetCode
 *      redesigns (they change classes frequently).
 *   3. Scan the visible innerText of the result panel for regex patterns.
 *   4. If nothing found yet, retry on a short interval for up to MAX_WAIT_MS.
 *   5. All strategies run in isolation so a failure in one never blocks others.
 *
 * Usage (called from content.js):
 *   const stats = await LCIRuntimeExtractor.extract();
 *   // stats = { runtime, memory, runtimePercentile, memoryPercentile }
 *   // Any field may be null if not found.
 */

window.LCIRuntimeExtractor = (() => {
  "use strict";

  // ─── Config ───────────────────────────────────────────────────────────────
  // Stats are optional for complexity analysis; keep their lookup from holding
  // up the Gemini request for several seconds when LeetCode omits them.
  const MAX_WAIT_MS  = 2500;
  const POLL_INTERVAL_MS = 300; // check every 300 ms

  // ─── Strategy 1 — official e2e-locator attributes ─────────────────────────
  function fromE2ELocators() {
    try {
      const rt = document.querySelector('[data-e2e-locator="submission-runtime"]')?.textContent?.trim();
      const mem = document.querySelector('[data-e2e-locator="submission-memory"]')?.textContent?.trim();
      return { runtime: rt || null, memory: mem || null };
    } catch {
      return { runtime: null, memory: null };
    }
  }

  // ─── Strategy 2 — class-name heuristics (LeetCode changes these often) ────
  /**
   * LeetCode has used many class conventions over the years, e.g.:
   *   • css-9jkqno / css-xif5lh  (older)
   *   • text-[1.375rem] / font-semibold (Tailwind era)
   *   • ResultItem__ACRuntimeInfoWrapper / ResultItem__StatsWrapper
   * We scan for elements whose text matches a known runtime/memory pattern
   * and whose sibling/parent context mentions the right keyword.
   */
  function fromClassHeuristics() {
    const result = { runtime: null, memory: null };
    try {
      // Pattern: "123 ms" or "45.6 MB"
      const runtimePattern = /^\d+(\.\d+)?\s*ms$/i;
      const memoryPattern  = /^\d+(\.\d+)?\s*MB$/i;

      const allEls = document.querySelectorAll('span, div, p');
      for (const el of allEls) {
        const text = el.textContent?.trim();
        if (!text) continue;

        if (!result.runtime && runtimePattern.test(text)) {
          // Confirm context mentions "runtime" or "time" nearby
          const ctx = (el.closest('[class*="result"], [class*="Result"], [class*="stat"], [class*="Stat"]') ||
                       el.parentElement?.parentElement)?.innerText?.toLowerCase() || '';
          if (ctx.includes('runtime') || ctx.includes('time') || ctx.includes('speed')) {
            result.runtime = text;
          }
        }

        if (!result.memory && memoryPattern.test(text)) {
          const ctx = (el.closest('[class*="result"], [class*="Result"], [class*="stat"], [class*="Stat"]') ||
                       el.parentElement?.parentElement)?.innerText?.toLowerCase() || '';
          if (ctx.includes('memory') || ctx.includes('mem') || ctx.includes('space')) {
            result.memory = text;
          }
        }

        if (result.runtime && result.memory) break;
      }
    } catch {}
    return result;
  }

  // ─── Strategy 3 — innerText regex scan of the result panel ───────────────
  function fromTextScan() {
    const result = { runtime: null, memory: null, runtimePercentile: null, memoryPercentile: null };
    try {
      // Find the result panel: prefer the submission-result anchor and walk up
      const anchor = document.querySelector('[data-e2e-locator="submission-result"]');
      const panel  =
        anchor?.closest('[class*="result" i]') ||
        anchor?.closest('[class*="container" i]') ||
        anchor?.parentElement?.parentElement?.parentElement ||
        document.body;

      const text = panel.innerText || '';

      // Runtime: "Runtime: 123 ms" or just "123 ms" near "runtime"
      const rtMatch = text.match(/runtime[:\s]+(\d+(?:\.\d+)?\s*ms)/i) ||
                      text.match(/(\d+(?:\.\d+)?\s*ms)[^\n]{0,40}runtime/i);
      if (rtMatch) result.runtime = rtMatch[1].trim();

      // Memory: "Memory: 45.6 MB" etc.
      const memMatch = text.match(/memory[:\s]+(\d+(?:\.\d+)?\s*MB)/i) ||
                       text.match(/(\d+(?:\.\d+)?\s*MB)[^\n]{0,40}memory/i);
      if (memMatch) result.memory = memMatch[1].trim();

      // Percentiles — "beats 94.3% of users" near runtime / memory
      const rtPctMatch = text.match(/beats\s+(\d+(?:\.\d+)?)%[^\n]{0,80}runtime/i) ||
                         text.match(/runtime[^\n]{0,80}beats\s+(\d+(?:\.\d+)?)%/i);
      if (rtPctMatch) result.runtimePercentile = `Beats ${rtPctMatch[1]}% of users`;

      const memPctMatch = text.match(/beats\s+(\d+(?:\.\d+)?)%[^\n]{0,80}memory/i) ||
                          text.match(/memory[^\n]{0,80}beats\s+(\d+(?:\.\d+)?)%/i);
      if (memPctMatch) result.memoryPercentile = `Beats ${memPctMatch[1]}% of users`;

    } catch {}
    return result;
  }

  // ─── Strategy 4 — percentile-only DOM scan (separate element structure) ──
  function fromPercentileDom(keyword) {
    try {
      const resultPanel =
        document.querySelector('[data-e2e-locator="submission-result"]')?.closest('[class*="result" i]') ||
        document.querySelector('[data-e2e-locator="submission-result"]')?.parentElement?.parentElement ||
        document.body;
      // innerText may place the percentile and its Runtime/Memory label on
      // separate lines; normalize whitespace so the nearby-label patterns can
      // still associate them.
      const text = (resultPanel.innerText || '').replace(/\s+/g, ' ').trim();
      const regex    = new RegExp(`beats\\s+(\\d+\\.?\\d*)%[^\\n]{0,60}${keyword}`, 'i');
      const altRegex = new RegExp(`${keyword}[^\\n]{0,60}beats\\s+(\\d+\\.?\\d*)%`, 'i');
      const match = text.match(regex) || text.match(altRegex);
      if (match) return `Beats ${match[1]}% of users`;
    } catch {}
    return null;
  }

  // ─── Merge results from all strategies ───────────────────────────────────
  function mergeAll() {
    const e2e  = fromE2ELocators();
    const cls  = fromClassHeuristics();
    const scan = fromTextScan();

    const runtime  = e2e.runtime  || cls.runtime  || scan.runtime  || null;
    const memory   = e2e.memory   || cls.memory   || scan.memory   || null;
    const rtPct    = scan.runtimePercentile || fromPercentileDom('runtime')  || null;
    const memPct   = scan.memoryPercentile  || fromPercentileDom('memory')   || null;

    return { runtime, memory, runtimePercentile: rtPct, memoryPercentile: memPct };
  }

  // ─── isComplete check ─────────────────────────────────────────────────────
  function isComplete(stats) {
    return !!(stats.runtime && stats.memory);
  }

  // ─── Public API: extract() ────────────────────────────────────────────────
  /**
   * Polls until runtime + memory are both found or MAX_WAIT_MS expires.
   * Returns a Promise that always resolves (never rejects) with whatever
   * stats were found — partial results are better than nothing.
   *
   * @param {object} [seed] — optional partial data already known (e.g. from
   *                          network interception). Fields already set won't
   *                          be overridden unless null/undefined.
   * @returns {Promise<{runtime, memory, runtimePercentile, memoryPercentile}>}
   */
  function extract(seed = {}) {
    const seedData = seed && typeof seed === "object" ? seed : {};
    return new Promise((resolve) => {
      const start = Date.now();

      function attempt() {
        const found = mergeAll() || {};

        // Merge with seed (seed wins only if found is null for that field)
        const merged = {
          runtime:           found.runtime           || seedData.runtime           || null,
          memory:            found.memory            || seedData.memory            || null,
          runtimePercentile: found.runtimePercentile || seedData.runtimePercentile || null,
          memoryPercentile:  found.memoryPercentile  || seedData.memoryPercentile  || null,
        };

        if (isComplete(merged) || Date.now() - start >= MAX_WAIT_MS) {
          if (!merged.runtime && !merged.memory) {
            console.debug('[LCI:RuntimeExtractor] Runtime/memory stats were not available before timeout.');
          } else {
            console.log('[LCI:RuntimeExtractor] Extracted stats:', merged);
          }
          resolve(merged);
          return;
        }

        // Not found yet — wait and retry
        setTimeout(attempt, POLL_INTERVAL_MS);
      }

      attempt();
    });
  }

  return { extract };
})();
