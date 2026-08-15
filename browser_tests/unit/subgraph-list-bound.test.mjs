import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boundSubgraphList,
  normalizeSubgraphLimit,
  SUBGRAPH_LIST_DEFAULT_LIMIT,
} from "../../web/js/lib/subgraph-list-bound.js";

/**
 * #690(5) — panel_list_subgraphs returned all 90 bundled blueprints with full
 * descriptions in one response, while every other panel read tool is explicitly
 * token-bounded.
 *
 * The risk in fixing it is creating a worse bug: a tool that quietly returns 25 of
 * 90 is a silent omission, and an agent that concludes a blueprint doesn't exist
 * rebuilds it by hand. So most of these tests are about the bound being VISIBLE.
 */

const lib = (n, prefix = "bp") =>
  Array.from({ length: n }, (_, i) => ({
    name: `${prefix}${i}`,
    type: `SubgraphBlueprint.${prefix}${i}`,
    display_name: `Blueprint ${i}`,
    description: `desc ${i}`,
    is_global: i % 2 === 0,
  }));

test("a small library returns whole, with no truncation fields at all", () => {
  const out = boundSubgraphList(lib(5));
  assert.equal(out.count, 5);
  assert.equal(out.blueprints.length, 5);
  assert.equal(out.truncated, undefined, "must not claim truncation that did not happen");
  assert.equal(out.note, undefined);
  assert.equal(out.matched, undefined, "no filter ⇒ no matched field");
});

test("count stays the LIBRARY TOTAL when truncated — never the returned length", () => {
  // The load-bearing property. If count shrank to the page size, a caller could not
  // tell a bounded list from a complete one.
  const out = boundSubgraphList(lib(90));
  assert.equal(out.count, 90);
  assert.equal(out.blueprints.length, SUBGRAPH_LIST_DEFAULT_LIMIT);
  assert.equal(out.returned, SUBGRAPH_LIST_DEFAULT_LIMIT);
  assert.equal(out.truncated, true);
});

test("the truncation note says entries were withheld and how to reach them", () => {
  const out = boundSubgraphList(lib(90));
  assert.match(out.note, /Showing 40 of 90/);
  assert.match(out.note, /do not conclude a blueprint is absent/i);
  assert.match(out.note, /filter/);
  assert.match(out.note, /limit/);
});

test("a filter narrows and reports `matched` distinctly from `count`", () => {
  // "3 of 90 matched" must be distinguishable from "the library has 3".
  const out = boundSubgraphList([...lib(50), ...lib(3, "video")], { filter: "video" });
  assert.equal(out.count, 53, "count is the whole library");
  assert.equal(out.matched, 3, "matched is what the filter selected");
  assert.equal(out.blueprints.length, 3);
  assert.equal(out.truncated, undefined, "everything matching fit — nothing withheld");
});

test("the filter searches display name and description, not just name", () => {
  const bps = [
    { name: "a", display_name: "Upscale Chain", description: "x" },
    { name: "b", display_name: "y", description: "does an upscale pass" },
    { name: "c", display_name: "y", description: "unrelated" },
  ];
  assert.equal(boundSubgraphList(bps, { filter: "upscale" }).matched, 2);
});

test("filtering is case-insensitive and trims", () => {
  const bps = [{ name: "Video_Gen", display_name: null, description: null }];
  assert.equal(boundSubgraphList(bps, { filter: "  VIDEO  " }).matched, 1);
});

test("a filter that matches nothing says so honestly — 0 matched of a non-empty library", () => {
  const out = boundSubgraphList(lib(10), { filter: "zzz-nothing" });
  assert.equal(out.count, 10);
  assert.equal(out.matched, 0);
  assert.deepEqual(out.blueprints, []);
  assert.equal(out.truncated, undefined, "nothing was withheld — the filter simply missed");
});

test("long descriptions clip, but name and type never do", () => {
  // name/type are what panel_add_subgraph needs to act; the prose is not.
  const long = "x".repeat(500);
  const [bp] = boundSubgraphList([
    { name: "keep-me-exactly", type: "SubgraphBlueprint.keep-me-exactly", description: long },
  ]).blueprints;
  assert.equal(bp.name, "keep-me-exactly");
  assert.equal(bp.type, "SubgraphBlueprint.keep-me-exactly");
  assert.ok(bp.description.length < 250);
  assert.match(bp.description, /…$/);
});

test("an explicit limit is honoured and still reports truncation", () => {
  const out = boundSubgraphList(lib(90), { limit: 5 });
  assert.equal(out.blueprints.length, 5);
  assert.equal(out.truncated, true);
  assert.match(out.note, /Showing 5 of 90/);
});

test("a garbage limit falls back to the default rather than returning nothing", () => {
  // A caller fumbling the parameter must not get an empty library that reads as
  // "you have no blueprints".
  for (const bad of [0, -3, NaN, "abc", null, undefined, {}]) {
    assert.equal(normalizeSubgraphLimit(bad), SUBGRAPH_LIST_DEFAULT_LIMIT, `limit ${String(bad)}`);
  }
  assert.equal(boundSubgraphList(lib(50), { limit: 0 }).blueprints.length, SUBGRAPH_LIST_DEFAULT_LIMIT);
});

test("a huge limit is capped, and a fractional one floors", () => {
  assert.equal(normalizeSubgraphLimit(1e9), 500);
  assert.equal(normalizeSubgraphLimit(7.9), 7);
});

test("an empty or malformed library yields an honest empty result", () => {
  for (const bad of [[], null, undefined, "nope", 42]) {
    const out = boundSubgraphList(bad);
    assert.equal(out.count, 0);
    assert.deepEqual(out.blueprints, []);
    assert.equal(out.truncated, undefined);
  }
});

// ── WIRING ────────────────────────────────────────────────────────────────
test("WIRING: graph_list_subgraphs returns the bounded shape and accepts the params", async () => {
  // graph_list_subgraphs is a module-private handler needing a live subgraph store,
  // so the wiring is pinned at source. Without this, deleting the call restores the
  // unbounded dump with every test above still green.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(src, /import \{ boundSubgraphList \} from "\.\/lib\/subgraph-list-bound\.js";/);
  assert.ok(src.includes("graph_list_subgraphs({ filter, limit } = {}) {"),
    "the handler must accept filter/limit — a defaulted destructure keeps a no-arg call working");
  assert.ok(src.includes("return boundSubgraphList(blueprints, { filter, limit });"),
    "the list must go through the bound — otherwise the unbounded dump returns");
});
