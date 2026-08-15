import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  boundByChars,
  normalizeViewportMaxChars,
  viewportTruncation,
  VIEWPORT_DEFAULT_MAX_CHARS,
} from "../../web/js/lib/viewport-char-bound.js";

/**
 * #845 — panel_view_nodes_in_viewport returned 135,531 characters across 5,662 lines
 * for a caller inspecting ONE node in a 175-node workflow.
 *
 * It was not unbounded: it capped at MAX_STATE_NODES (100). It was bounded by the
 * WRONG UNIT — 100 nodes at ~1.3k chars each honours the cap exactly and still emits
 * 135k characters. panel_query_graph is bounded by max_chars for this very reason.
 */

const node = (id, pad = 1200) => ({ id, type: "T", title: "x".repeat(pad) });

test("the reported blowup is bounded: 100 fat nodes no longer emit ~135k chars", () => {
  const cap = Array.from({ length: 100 }, (_, i) => node(i));
  const raw = JSON.stringify(cap).length;
  assert.ok(raw > 120000, `precondition: unbounded payload is large (${raw})`);
  const { kept, keptChars } = boundByChars(cap, VIEWPORT_DEFAULT_MAX_CHARS);
  assert.ok(keptChars <= VIEWPORT_DEFAULT_MAX_CHARS, `kept ${keptChars} within budget`);
  assert.ok(kept.length < cap.length, "and fewer nodes came back");
});

test("a small viewport is NOT clipped — the common case is untouched", () => {
  const few = [node(1), node(2), node(3)];
  const { kept, droppedForChars } = boundByChars(few, VIEWPORT_DEFAULT_MAX_CHARS);
  assert.equal(kept.length, 3);
  assert.equal(droppedForChars, 0);
});

test("the FIRST node is always admitted, even if it alone blows the budget", () => {
  // Returning an empty viewport for one large node would report "nothing here" about
  // the very node the user is looking at.
  const huge = [node(1, 50000), node(2)];
  const { kept } = boundByChars(huge, 2000);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 1);
});

test("nodes are never partially serialized", () => {
  // Half a node summary is not a smaller answer, it is a malformed one.
  const { kept } = boundByChars([node(1), node(2), node(3)], 3000);
  for (const k of kept) assert.deepEqual(Object.keys(k).sort(), ["id", "title", "type"]);
});

test("truncation is VISIBLE and says what was withheld", () => {
  const t = viewportTruncation({ inViewCount: 87, keptCount: 12, nodeCap: 100, maxChars: 24000 });
  assert.equal(t.truncated, true);
  assert.equal(t.returned, 12);
  assert.match(t.truncation_hint, /Showing 12 of 87/);
  assert.match(t.truncation_hint, /do not read this as the viewport being empty/i);
  assert.match(t.truncation_hint, /character budget 24000/);
  // Names a lever WITH a ceiling — a caller already at the max must not be sent on a
  // retry that cannot change anything.
  assert.match(t.truncation_hint, /up to 200000/);
});

test("it distinguishes the NODE CAP from the character budget", () => {
  // Different remedies: zoom out fewer nodes vs raise max_chars. Reporting the wrong
  // cause sends the caller at a lever that will not move.
  const byCap = viewportTruncation({ inViewCount: 175, keptCount: 100, nodeCap: 100, maxChars: 24000 });
  assert.match(byCap.truncation_hint, /node cap 100/);
  const byChars = viewportTruncation({ inViewCount: 40, keptCount: 12, nodeCap: 100, maxChars: 24000 });
  assert.match(byChars.truncation_hint, /character budget/);
});

test("nothing withheld ⇒ NO truncation fields at all", () => {
  assert.deepEqual(viewportTruncation({ inViewCount: 5, keptCount: 5, nodeCap: 100, maxChars: 24000 }), {});
});

test("a garbage max_chars falls back to the default, never to zero", () => {
  for (const bad of [0, -5, NaN, "abc", null, undefined, {}]) {
    assert.equal(normalizeViewportMaxChars(bad), VIEWPORT_DEFAULT_MAX_CHARS, String(bad));
  }
  assert.equal(normalizeViewportMaxChars(1e9), 200000, "clamped to the ceiling");
  assert.equal(normalizeViewportMaxChars(10), 2000, "clamped to the floor");
});

test("an unserializable summary does not abort the whole page", () => {
  const cyclic = { id: 9 }; cyclic.self = cyclic;
  const { kept } = boundByChars([cyclic, node(2)], VIEWPORT_DEFAULT_MAX_CHARS);
  assert.equal(kept.length, 2);
});

// ── WIRING ────────────────────────────────────────────────────────────────
test("WIRING: the handler applies the budget and keeps in_view_count honest", () => {
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("graph_view_nodes_in_viewport({ max_chars } = {}) {"));
  const body = fn.slice(0, fn.indexOf("\n  graph_", 10));
  assert.ok(body.includes("normalizeViewportMaxChars(max_chars)"), "must normalize the caller's budget");
  assert.ok(body.includes("boundByChars(cap, budget)"), "must apply the character budget");
  assert.ok(body.includes("in_view_count: visible.length"),
    "in_view_count must stay the SCREEN count, not the payload count");
  // The node cap still runs first, so the char budget is a second gate, not a replacement.
  assert.ok(body.includes("visible.slice(0, MAX_STATE_NODES)"), "the node cap must still apply");
});
