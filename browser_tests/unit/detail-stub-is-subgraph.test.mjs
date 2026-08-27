/**
 * artokun/comfyui-mcp#2436 — a node wide enough to degrade became UNWRITABLE.
 *
 * The `detail` projection emits an always-boolean `is_subgraph` on purpose. #2314's
 * comment says why: "MCP must distinguish a definitive ordinary node from an older
 * Panel whose detail projection cannot classify promotion. Positive-only emission made
 * missing capability look like false."
 *
 * `fitDetailLine` then replaced an oversized row with a stub carrying only
 * `{id, type, title}` — dropping exactly that boolean, and reintroducing the absence
 * #2314 had removed, one layer further down.
 *
 * The orchestrator's `parseVerifiedQueriedNodeScope` requires
 * `typeof is_subgraph === "boolean"` and treats anything else as INDETERMINATE. Its
 * caller then falls through to `graph_get_subgraph`, whose non-definitive answer is
 * refused by the promoted-write fence. Net effect: every ordinary `panel_set_widget`
 * on a wide node (`KSampler (Efficient)` in the report) was refused, with a message
 * about promoted containers, on a root node that is not one.
 *
 * Run with `node --test`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fitDetailLine } from "../../web/js/lib/graph-read.js";

/** A detail row too wide for the budget — the shape that triggers the degrade. */
const wide = (isSubgraph) =>
  JSON.stringify({
    id: 43,
    type: "KSampler (Efficient)",
    title: "KSampler (Efficient)",
    is_subgraph: isSubgraph,
    widgets: { blob: "x".repeat(4000) },
  });

test("#2436 the degraded stub PRESERVES a false is_subgraph", () => {
  const out = fitDetailLine(wide(false), { id: 43, type: "KSampler (Efficient)", is_subgraph: false }, 300);

  assert.ok(out.length <= 300, "the stub must still respect max_chars");
  const parsed = JSON.parse(out);
  assert.equal(typeof parsed.is_subgraph, "boolean", "a boolean is what the classifier requires");
  assert.equal(parsed.is_subgraph, false);
  assert.ok(parsed.detail_omitted, "and it still says the detail was omitted");
});

test("#2436 a true is_subgraph survives too — the degrade must not flip it", () => {
  const out = fitDetailLine(wide(true), { id: 7, type: "MySubgraph", is_subgraph: true }, 300);
  assert.equal(JSON.parse(out).is_subgraph, true);
});

test("#2436 an ABSENT is_subgraph stays absent — never invented as false", () => {
  // An older panel cannot classify. Emitting `false` here would be the #2314 defect
  // exactly: making missing capability look like a definitive ordinary node, which
  // would authorize a promoted write the panel never vouched for.
  const out = fitDetailLine(wide(false), { id: 9, type: "Old" }, 300);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(out), "is_subgraph"), false);
});

test("#2436 a non-boolean is_subgraph is dropped rather than passed through", () => {
  const out = fitDetailLine(wide(false), { id: 9, type: "Weird", is_subgraph: "false" }, 300);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(out), "is_subgraph"), false);
});

test("#2436 an unclipped line is returned untouched — no stub, no added field", () => {
  const small = JSON.stringify({ id: 1, type: "KSampler", is_subgraph: false });
  assert.equal(fitDetailLine(small, { id: 1, type: "KSampler", is_subgraph: false }, 10_000), small);
});

test("#2436 the absurdly-small-budget fallback is unchanged", () => {
  // That path identifies the node and nothing else by design; adding a field there
  // could push it back over a budget that is already too small for the normal stub.
  const out = fitDetailLine(wide(false), { id: 43, type: "KSampler (Efficient)", is_subgraph: false }, 40);
  assert.ok(out.length <= 60, "stays minimal");
  assert.equal(JSON.parse(out).detail_omitted, "raise `max_chars`");
});

test("#2436 the stub still fits the budget with the extra field", () => {
  // The whole point of the stub is the bound. A boolean costs ~18 chars; prove the
  // guarantee holds across a range of budgets rather than at one convenient number.
  for (const budget of [120, 200, 300, 500, 1000]) {
    const out = fitDetailLine(wide(false), { id: 43, type: "KSampler (Efficient)", is_subgraph: false }, budget);
    assert.ok(out.length <= budget, `budget ${budget}: got ${out.length}`);
    JSON.parse(out); // and it is always valid JSON
  }
});

// The library fix is inert unless the detail projection actually HANDS it the field.
// Read with CRLF normalized: the panel tree is CRLF, so an anchor taken from `git show`
// never matches the working file (panel#1880 lost four pins to exactly that).
test("#2436 WIRING: the detail projection passes is_subgraph into the stub", () => {
  const SRC = readFileSync(
    new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const call = SRC.match(/line = fitDetailLine\([^;]*\);/);
  assert.ok(call, "the fitDetailLine call site moved — re-anchor this pin");
  assert.match(call[0], /is_subgraph: summary\.is_subgraph/);
});
