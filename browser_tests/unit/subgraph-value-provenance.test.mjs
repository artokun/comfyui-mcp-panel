import { test } from "node:test";
import assert from "node:assert/strict";
import { subgraphValueProvenance } from "../../web/js/lib/subgraph-value-provenance.js";

/**
 * #636 (minor) — panel_get_subgraph(173) reported inner node 166 value "MiniMax_H3"
 * while panel_query_graph(ids:[173]) reported the parent instance value "MM3". Both
 * correct, describing different things, with nothing in either payload saying so —
 * so the difference read as stale data.
 *
 * That is the costly failure: an agent "fixes" a value that was never wrong, or
 * re-reads in a loop waiting for two numbers to agree that never will and should not.
 */

test("the reporter's case: instance values ride alongside, labelled", () => {
  const node = { id: 173, widgets: [{ name: "value", value: "MM3" }] };
  const out = subgraphValueProvenance(node);
  assert.deepEqual(out.instance_widgets, { value: "MM3" });
  assert.match(out.values_note, /belong to the subgraph DEFINITION/);
  assert.match(out.values_note, /node 173/);
});

test("the note names the override as INTENTIONAL, not stale", () => {
  // The load-bearing sentence. Without it the payload still shows two values and
  // leaves the reader to guess which is wrong — the original failure.
  const out = subgraphValueProvenance({ id: 5, widgets: [{ name: "a", value: 1 }] });
  assert.match(out.values_note, /intentional per-instance override/i);
  assert.match(out.values_note, /NOT stale/);
  assert.match(out.values_note, /do not "correct" it/i);
});

test("a subgraph with NO promoted widgets gets no block at all", () => {
  // Nothing can diverge, so a note would be noise on every parameterless subgraph.
  for (const node of [{ id: 1 }, { id: 1, widgets: [] }, { id: 1, widgets: null }]) {
    assert.deepEqual(subgraphValueProvenance(node), {});
  }
});

test("unnamed widgets are skipped rather than keyed on undefined", () => {
  const out = subgraphValueProvenance({
    id: 2,
    widgets: [{ value: "no-name" }, { name: "", value: "empty" }, { name: "real", value: 7 }],
  });
  assert.deepEqual(out.instance_widgets, { real: 7 });
});

test("falsy and empty instance values are reported, not dropped", () => {
  // 0 / "" / false are real widget values. Dropping them would recreate the ambiguity
  // in the other direction — a caller could not tell "set to 0" from "not promoted".
  const out = subgraphValueProvenance({
    id: 3,
    widgets: [
      { name: "zero", value: 0 },
      { name: "empty", value: "" },
      { name: "off", value: false },
      { name: "nul", value: null },
    ],
  });
  assert.deepEqual(out.instance_widgets, { zero: 0, empty: "", off: false, nul: null });
});

test("a malformed node yields no block rather than throwing", () => {
  for (const bad of [null, undefined, {}, 42, "x", { widgets: "nope" }]) {
    assert.deepEqual(subgraphValueProvenance(bad), {});
  }
});

test("no promotion-to-inner-widget PAIRING is asserted", () => {
  // The mapping is not reliably recoverable across frontend versions, and a wrong
  // pairing would state a false override relationship — worse than the ambiguity
  // being fixed. The payload reports names as they are and lets the caller compare.
  const out = subgraphValueProvenance({ id: 9, widgets: [{ name: "value", value: "MM3" }] });
  assert.equal(out.instance_widgets.value, "MM3");
  assert.ok(!("overrides" in out), "must not claim which inner widget this feeds");
  assert.ok(!("mapping" in out));
});

// ── WIRING ────────────────────────────────────────────────────────────────
test("WIRING: graph_get_subgraph spreads the provenance block", async () => {
  // graph_get_subgraph is a module-private handler needing a live graph, so the
  // wiring is pinned at source. Without the spread, both values are still returned
  // by the two tools with nothing explaining the difference — #636's minor item.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(src, /import \{ subgraphValueProvenance \} from "\.\/lib\/subgraph-value-provenance\.js";/);
  const fn = src.slice(src.indexOf("graph_get_subgraph({ node_id }) {"));
  const body = fn.slice(0, fn.indexOf("async graph_add_node("));
  assert.ok(body.includes("...subgraphValueProvenance(node),"),
    "the reply must carry the provenance block");
  // It must describe the PARENT instance, not one of the inner nodes.
  assert.ok(body.includes("subgraphValueProvenance(node)"), "must be passed the parent node");
});
