import { test } from "node:test";
import assert from "node:assert/strict";
import { subgraphValueProvenance } from "../../web/js/lib/subgraph-value-provenance.js";
import { redactWidgetValue, REDACTED_WIDGET_VALUE } from "../../web/js/lib/widget-secret-redaction.js";

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
test("WIRING: production graph_get_subgraph redacts instance provenance", async () => {
  // Execute the module-private handler's source fragment. A source-only assertion
  // would miss a sanitizer applied to the wrong object, while a helper-only test
  // would miss this alternate structured-read path entirely.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(src, /import \{ subgraphValueProvenance \} from "\.\/lib\/subgraph-value-provenance\.js";/);
  assert.match(src, /const safeProvenance = redactWidgetValue\("", subgraphValueProvenance\(node\)\);/);
  assert.match(src, /\.\.\.safeProvenance,/);

  const start = src.indexOf("graph_get_subgraph({ node_id }) {");
  const end = src.indexOf("async graph_add_node(", start);
  assert.ok(start >= 0 && end > start, "graph_get_subgraph handler must remain extractable");
  const method = src.slice(start, end).replace(/,\s*$/, "");
  const graph = {};
  const sharedParentValue = { value: "SECRET" };
  const parent = {
    id: 173,
    title: "Reusable secret node",
    widgets: [
      { name: "ordinarySettings", value: sharedParentValue },
      { name: "apiKey", value: sharedParentValue },
      {
        name: "instanceSettings",
        value: {
          visible: "keep this setting",
          api_key: "nested-api-key",
          values: [{ privateKey: "nested-private-key" }, "Bearer abcdefghijklmnop"],
        },
      },
      { name: "prompt", value: "visible prompt" },
    ],
    subgraph: { _nodes: [{ id: 166, mode: 4, inputs: [], outputs: [] }] },
  };
  const getSubgraph = new Function(
    "getGraphCtx",
    "resolveNode",
    "describeActiveGraph",
    "subgraphValueProvenance",
    "redactWidgetValue",
    "MAX_STATE_NODES",
    "fixedCapNote",
    "summarizeNode",
    `return ({${method}}).graph_get_subgraph;`,
  )(
    () => ({ graph }),
    () => parent,
    () => ({ graph: "root" }),
    subgraphValueProvenance,
    redactWidgetValue,
    50,
    () => "truncation note",
    (node) => ({ id: node.id, mode: node.mode, inputs: node.inputs, outputs: node.outputs }),
  );

  const out = getSubgraph({ node_id: 173 });
  assert.deepEqual(out.subgraph_of, { node_id: 173, title: "Reusable secret node" });
  assert.deepEqual(out.instance_widgets, {
    ordinarySettings: { value: "SECRET" },
    apiKey: { value: REDACTED_WIDGET_VALUE },
    instanceSettings: {
      visible: "keep this setting",
      api_key: REDACTED_WIDGET_VALUE,
      values: [{ privateKey: REDACTED_WIDGET_VALUE }, REDACTED_WIDGET_VALUE],
    },
    prompt: "visible prompt",
  });
  assert.notStrictEqual(
    out.instance_widgets.ordinarySettings,
    out.instance_widgets.apiKey,
    "production provenance must split ordinary and sensitive alias contexts",
  );
  assert.deepEqual(out.nodes, [{ id: 166, mode: 4, inputs: [], outputs: [] }]);
  assert.ok(!JSON.stringify(out).includes("nested-private-key"));
});
