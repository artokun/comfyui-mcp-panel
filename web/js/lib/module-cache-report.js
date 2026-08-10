/**
 * #584 — THE PAGE ALREADY KNOWS WHETHER ITS MODULES CAME FROM CACHE.
 *
 * Five fixes have shipped against "this tab is running stale panel JS" and it
 * keeps recurring, because every one of them was built on an unmeasured
 * hypothesis about the browser's cache. The evidence that would settle it has
 * only ever been askable as "open DevTools → Network → filter, and tell me what
 * you see" — which almost never comes back, and never comes back from the tab
 * that was actually wedged.
 *
 * It does not need asking. `performance.getEntriesByType("resource")` records
 * every module fetch the document made, and PerformanceResourceTiming carries
 * exactly the two facts in dispute:
 *
 *   transferSize === 0 with a decoded body  →  served from the HTTP cache
 *   responseStatus                          →  what the server actually said
 *
 * So the tab can report its own cache state, on the recurrence, without a human
 * in the loop.
 *
 * WHAT THIS DOES NOT DO. It does not fix staleness and does not claim to. It
 * decides between the two live explanations, which no amount of source reading
 * can: modules disagreeing with each other (skew), or an intermediary stripping
 * the `no-store` that ComfyUI's own cache middleware puts on every `.js`.
 *
 * THREE STATES, NOT TWO. "Cannot tell" is a real answer here and is kept
 * separate from "came from the network":
 *
 *   • the Resource Timing API may be unavailable or the buffer already dropped;
 *   • `transferSize` is 0 for a CROSS-ORIGIN response without
 *     Timing-Allow-Origin, which looks identical to a cache hit. Our modules are
 *     same-origin so it should not arise — but "should not" is how this issue
 *     got five fixes, so an entry with no decoded body is `unknown`, never
 *     `cached`.
 *
 * Reporting "all fresh" when the truth is "the API told us nothing" would send
 * the next investigation down exactly the path this module exists to close.
 */

/** A resource entry that is one of OUR modules, by URL prefix. */
function isOurModule(entry, base) {
  const name = typeof entry?.name === "string" ? entry.name : "";
  if (!name.includes(base)) return false;
  // `initiatorType` is "script" for a module fetch; a `link rel=modulepreload`
  // shows as "link". Both are real fetches of our code. Anything else with this
  // prefix (an image, a fetch() of the version probe) is not a module.
  const kind = entry?.initiatorType;
  return kind === undefined || kind === "script" || kind === "link" || kind === "other";
}

/**
 * Classify ONE resource entry.
 *
 * @returns {"cached"|"network"|"unknown"}
 */
export function classifyEntry(entry) {
  const transfer = entry?.transferSize;
  const decoded = entry?.decodedBodySize;
  // The API is not required to expose sizes. Absent numbers are not evidence.
  if (typeof transfer !== "number" || typeof decoded !== "number") return "unknown";
  // A body we never saw the size of cannot be called a cache hit — this is the
  // cross-origin/opaque shape, and it is indistinguishable from one.
  if (decoded <= 0) return "unknown";
  // Bytes crossed the wire.
  if (transfer > 0) return "network";
  // Decoded content with nothing transferred: the cache served it.
  return "cached";
}

/**
 * Summarise how this document obtained the panel's modules.
 *
 * @param {ArrayLike<PerformanceResourceTiming>|null|undefined} entries
 * @param {{ base?: string }} [opts] `base` is the URL fragment identifying our
 *        modules; defaults to the pack's extension path.
 */
export function summarizeModuleCache(entries, opts = {}) {
  const base = typeof opts.base === "string" && opts.base ? opts.base : "/extensions/comfyui-mcp-panel/";
  const empty = { total: 0, cached: 0, network: 0, unknown: 0, verdict: "unknown", cachedUrls: [], statuses: {} };
  if (!entries || typeof entries.length !== "number") return empty;

  const out = { ...empty, cachedUrls: [], statuses: {} };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!isOurModule(entry, base)) continue;
    out.total++;
    const verdict = classifyEntry(entry);
    out[verdict]++;
    if (verdict === "cached") {
      // The URL is the actionable half — WHICH modules are stale tells skew
      // apart from a uniformly old page. Bounded: a wedged page has 112 of
      // these and an unbounded list helps nobody read the first ten.
      if (out.cachedUrls.length < 12) out.cachedUrls.push(shortName(entry.name, base));
    }
    const status = entry?.responseStatus;
    if (typeof status === "number" && status > 0) {
      out.statuses[status] = (out.statuses[status] || 0) + 1;
    }
  }

  if (out.total === 0) out.verdict = "unknown";
  else if (out.cached === 0 && out.unknown === 0) out.verdict = "all-network";
  else if (out.cached === out.total) out.verdict = "all-cached";
  else if (out.cached > 0) out.verdict = "mixed";
  else out.verdict = "unknown";
  return out;
}

/** `/extensions/comfyui-mcp-panel/js/lib/x.js` → `js/lib/x.js`. */
function shortName(name, base) {
  const i = typeof name === "string" ? name.indexOf(base) : -1;
  return i === -1 ? String(name ?? "") : name.slice(i + base.length);
}

/**
 * The human/agent-readable line for a summary — the sentence that lands in a
 * console warning and in an issue report.
 *
 * Deliberately states the OBSERVATION and its consequence separately, because
 * the two branches have different owners: `mixed` is ours to fix (modules
 * disagreeing), `all-cached` points outside the panel entirely (something is
 * not honouring the `no-store` ComfyUI sets on every .js).
 */
export function describeModuleCache(summary) {
  const s = summary ?? {};
  const total = s.total || 0;
  if (!total) {
    return (
      "module cache: could not be measured (the Resource Timing buffer held no panel modules) — " +
      "this is not evidence that they were fresh."
    );
  }
  const head = `module cache: ${total} panel module(s) — ${s.network || 0} from the network, ${s.cached || 0} from cache, ${s.unknown || 0} undetermined`;
  const statuses = Object.keys(s.statuses || {}).length
    ? ` [status ${Object.entries(s.statuses).map(([k, v]) => `${k}×${v}`).join(", ")}]`
    : "";
  if (s.verdict === "all-network") {
    return `${head}${statuses}. Every module was fetched — staleness here is NOT the HTTP cache.`;
  }
  if (s.verdict === "all-cached") {
    return (
      `${head}${statuses}. The whole pack came from cache, which ComfyUI's own cache middleware ` +
      `(no-store on every .js) should prevent — so something between this browser and ComfyUI is ` +
      `not passing that header: a proxy, tunnel, or Desktop's server. Sample: ${(s.cachedUrls || []).join(", ")}`
    );
  }
  if (s.verdict === "mixed") {
    return (
      `${head}${statuses}. SOME modules are cached and some are not, so this page is running a ` +
      `MIXTURE of versions — which is why a single version check can look healthy while writes ` +
      `stay broken. Cached: ${(s.cachedUrls || []).join(", ")}`
    );
  }
  return `${head}${statuses}. Too little was reported to tell cache from network.`;
}

/** Read the live document's timings; safe to call anywhere (returns the empty
 *  summary when the API is missing, which is `unknown`, not `fresh`). */
export function readModuleCacheSummary(perf = typeof performance === "undefined" ? null : performance, opts) {
  try {
    if (!perf || typeof perf.getEntriesByType !== "function") return summarizeModuleCache(null, opts);
    return summarizeModuleCache(perf.getEntriesByType("resource"), opts);
  } catch {
    return summarizeModuleCache(null, opts); // a diagnostic must never throw
  }
}
