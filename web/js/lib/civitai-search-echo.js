/**
 * #691 — make a CivitAI search receipt say what actually happened to `filters`.
 *
 * `panel_civitai_search` accepts a documented `filters` object, echoes `tab`,
 * `query` and `creator` back, and says `dispatched: true` — but said nothing at
 * all about `filters`. From the caller's side there was no way to tell whether
 * they were parsed, applied, or silently dropped, which is the false-success
 * shape: a documented parameter accepted without complaint and no observable
 * effect. (#374 was the same defect for `creator`, fixed the same way: echo it,
 * and warn when it did not land.)
 *
 * THE SORT IS NOT DROPPED BY THE PANEL — it is ignored UPSTREAM.
 * The reporter saw `modelSort: "Most Downloaded"` produce ascending download
 * counts and reasonably concluded the filter was inert. It is not: `driveSearch`
 * folds it into `state.filters`, the model-tab branch passes `sort: f.modelSort`
 * to `fetchModels`, and "Most Downloaded" is inside MODEL_SORTS so the #459 clamp
 * passes it through untouched. The panel sends it correctly.
 *
 * What actually happens is that CivitAI's /v1/models RELEVANCE-RANKS whenever a
 * `query` is present and ignores `sort` completely. Measured directly against the
 * live endpoint:
 *
 *   query="portrait", sort=Most Downloaded → ids 5658,2067704,685224,131324,156948
 *   query="portrait", sort=Newest          → ids 5658,2067704,685224,131324,156948
 *   query="portrait", sort=Oldest          → ids 5658,2067704,685224,131324,156948
 *   (no query),       sort=Most Downloaded → ids 264290,58390,122359,82098,25995
 *   (no query),       sort=Newest          → ids 2840129,2756662,2773267,2840095,…
 *
 * Three different sorts returning a byte-identical ordering is what proves it;
 * without a query the same sorts diverge, which proves the parameter is otherwise
 * honoured. So a keyword search cannot be sorted, by anyone, and an agent that
 * asks for one deserves to be told that rather than left to infer it from a
 * result set that looks mis-sorted.
 *
 * Deliberately NOT done here: silently dropping the sort, or refusing the search.
 * The sort still matters — it applies the moment the query is cleared — and
 * refusing a search because one of its filters is upstream-inert would turn a
 * cosmetic surprise into a false refusal.
 */

/** The filter keys a caller can set through `panel_civitai_search`, echoed back
 *  in this order. `username` is echoed separately as `creator` by driveSearch, so
 *  it is not repeated here. */
const ECHOED_KEYS = ["period", "modelSort", "imageSort", "baseModels", "browsingLevels"];

/** Copy the effective filter state for the receipt. Arrays are COPIED, never
 *  aliased: the receipt is serialized asynchronously and must not mutate (or be
 *  mutated by) live panel state afterwards. Absent keys are omitted rather than
 *  reported as null, so the echo describes what IS set. */
function echoFilters(filters) {
  const out = {};
  if (!filters || typeof filters !== "object") return out;
  for (const key of ECHOED_KEYS) {
    const value = filters[key];
    if (value === undefined || value === null) continue;
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

/**
 * Build the `filters` half of a search receipt.
 *
 * @param {object}  opts
 * @param {object}  opts.filters   the panel's EFFECTIVE filter state after folding
 * @param {string}  opts.query     the search text actually applied (creator token stripped)
 * @param {boolean} opts.modelTab  true when the active tab queries /v1/models
 * @returns {{filters: object, sortApplied?: boolean, filterNote?: string}}
 *   `sortApplied` is reported ONLY for a model tab, where the answer is knowable:
 *   the image/video tabs use a different endpoint whose behaviour this has not
 *   measured, and asserting there would be a guess dressed as a receipt.
 */
export function summarizeSearchFilters({ filters, query, modelTab } = {}) {
  const echoed = echoFilters(filters);
  const result = { filters: echoed };
  if (!modelTab) return result;

  const hasQuery = typeof query === "string" && query.trim() !== "";
  result.sortApplied = !hasQuery;
  if (hasQuery && echoed.modelSort) {
    result.filterNote =
      `CivitAI relevance-ranks keyword searches: with a \`query\` set, /v1/models ignores ` +
      `\`sort\` entirely, so modelSort "${echoed.modelSort}" is NOT applied to these results ` +
      `(verified — "Most Downloaded", "Newest" and "Oldest" return an identical ordering for ` +
      `the same query). The ordering you see is relevance, not ${echoed.modelSort.toLowerCase()}. ` +
      `Do NOT report it as a sort failure. To sort, run the search with an empty query and rely ` +
      `on the other filters (baseModels / period) to narrow instead.`;
  }
  return result;
}
