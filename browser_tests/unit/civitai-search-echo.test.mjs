import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeSearchFilters } from "../../web/js/lib/civitai-search-echo.js";

/**
 * #691 — panel_civitai_search accepted a documented `filters` object, echoed
 * tab/query/creator back but never `filters`, and reported dispatched:true. The
 * caller could not tell applied from silently dropped.
 *
 * The second half matters as much: the reporter concluded modelSort was inert
 * because the results were not sorted. The panel does send it — CivitAI ignores
 * `sort` whenever a `query` is present (three different sorts return an identical
 * ordering; without a query they diverge). So the receipt has to distinguish
 * "your filter was dropped" from "upstream cannot honour it here", because those
 * call for completely different actions.
 */

test("filters are echoed, so 'applied' is distinguishable from 'dropped'", () => {
  const r = summarizeSearchFilters({
    filters: { period: "Month", modelSort: "Most Liked", baseModels: ["Flux.1 D"], browsingLevels: [1, 2] },
    query: "",
    modelTab: true,
  });
  assert.deepEqual(r.filters, {
    period: "Month",
    modelSort: "Most Liked",
    baseModels: ["Flux.1 D"],
    browsingLevels: [1, 2],
  });
});

test("array fields are COPIED, not aliased to live panel state", () => {
  // The receipt is serialized after this returns; sharing the array would let a
  // later filter change rewrite a receipt already handed to the caller.
  const live = { baseModels: ["Flux.1 D"], browsingLevels: [1] };
  const r = summarizeSearchFilters({ filters: live, query: "", modelTab: true });
  live.baseModels.push("SDXL");
  live.browsingLevels.push(8);
  assert.deepEqual(r.filters.baseModels, ["Flux.1 D"], "echo must not follow later mutations");
  assert.deepEqual(r.filters.browsingLevels, [1]);
});

test("unset filters are omitted rather than reported as null", () => {
  const r = summarizeSearchFilters({ filters: { period: "Week", modelSort: null, imageSort: undefined }, query: "", modelTab: true });
  assert.deepEqual(Object.keys(r.filters), ["period"]);
});

test("a keyword search reports sortApplied:false and says why", () => {
  // The load-bearing case. Without this the agent sees an unsorted grid and
  // reports a sort failure that no one can fix, because CivitAI relevance-ranks.
  const r = summarizeSearchFilters({
    filters: { modelSort: "Most Downloaded" },
    query: "z-image turbo detail enhancer",
    modelTab: true,
  });
  assert.equal(r.sortApplied, false);
  assert.match(r.filterNote, /relevance-ranks/i);
  assert.match(r.filterNote, /Most Downloaded/);
  assert.match(r.filterNote, /NOT applied/);
  // It must tell the agent NOT to call this a sort failure — that instruction is
  // the whole point of surfacing it.
  assert.match(r.filterNote, /Do NOT report it as a sort failure/i);
});

test("an EMPTY query sorts normally — sortApplied:true and no note", () => {
  // The other direction: claiming the sort is inert when it does work would be a
  // false warning, and would push the agent away from the one form that sorts.
  for (const query of ["", "   ", undefined, null]) {
    const r = summarizeSearchFilters({ filters: { modelSort: "Most Downloaded" }, query, modelTab: true });
    assert.equal(r.sortApplied, true, `query ${JSON.stringify(query)} sorts normally`);
    assert.equal(r.filterNote, undefined, "no warning when the sort really applies");
  }
});

test("no note when no modelSort was requested, even with a query", () => {
  // Nothing was asked for, so nothing was denied. A note here would be noise on
  // every ordinary search.
  const r = summarizeSearchFilters({ filters: { period: "Week" }, query: "portrait", modelTab: true });
  assert.equal(r.sortApplied, false, "still reported — the sort would be inert if set");
  assert.equal(r.filterNote, undefined);
});

test("NON-model tabs report no sortApplied verdict at all", () => {
  // The image/video tabs hit a different endpoint whose behaviour was not
  // measured. Asserting there would be a guess dressed up as a receipt.
  const r = summarizeSearchFilters({
    filters: { imageSort: "Most Reactions" },
    query: "portrait",
    modelTab: false,
  });
  assert.deepEqual(r.filters, { imageSort: "Most Reactions" }, "filters still echoed");
  assert.equal("sortApplied" in r, false, "no claim about a path that wasn't measured");
  assert.equal(r.filterNote, undefined);
});

test("a missing/garbage filters object yields an empty echo, never a throw", () => {
  for (const bad of [undefined, null, "nope", 42]) {
    const r = summarizeSearchFilters({ filters: bad, query: "", modelTab: true });
    assert.deepEqual(r.filters, {});
  }
});

// ── WIRING ────────────────────────────────────────────────────────────────
// The tests above prove the helper is right. They cannot prove it is CALLED:
// deleting the spread from driveSearch's return would leave every one of them
// green while restoring the exact bug (#691's receipt, with no `filters`).
// driveSearch is a closure inside openCivitai and is not exported, so the
// callable seam does not exist to drive — pin the wiring at source instead.

test("WIRING: driveSearch's receipt actually spreads the summary", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/cmcp-civitai-ui.js", import.meta.url), "utf8");

  assert.match(src, /import \{ summarizeSearchFilters \} from "\.\/lib\/civitai-search-echo\.js";/,
    "the helper must be imported");

  // Anchor inside driveSearch's return, not merely somewhere in a 2000-line file.
  const ret = src.slice(src.indexOf("async function driveSearch"));
  const body = ret.slice(0, ret.indexOf("function driveGetResults"));
  assert.ok(body.includes("...summarizeSearchFilters({"),
    "driveSearch's receipt must SPREAD the summary — without this the receipt omits `filters` again");
  // The arguments are load-bearing: passing the raw request instead of the
  // EFFECTIVE state would echo what was asked for rather than what was applied,
  // which is the same lie in a different shape.
  assert.ok(body.includes("filters: state.filters"), "must echo the EFFECTIVE folded state");
  assert.ok(body.includes("query: state.query"), "must judge the sort against the APPLIED query");
  assert.ok(body.includes("modelTab: !!tabDef().model"), "must scope the sort verdict to model tabs");
});
