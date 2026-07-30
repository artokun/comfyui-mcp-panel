/**
 * Unit tests for web/js/lib/asset-staleness.js — run with `node --test`.
 *
 * Covers the WS-3 stale-snapshot fixes: subgraph-scoped id resolution, the
 * missing-asset live-graph cross-check (fixed-by-set_widget and appeared-on-disk),
 * fail-open/closed safety, and UNKNOWN-widget positional reconciliation.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  findNodeByScopedId,
  assetCandidateStillReferenced,
  assetCandidateResolvesLive,
  isStaleAssetCandidate,
  orderedWidgetInputNames,
  isWidgetInputSpec,
  reconcileUnknownWidgetNames,
  collectAllGraphs,
  reapplyDefsToLiveNodes,
} from "../../web/js/lib/asset-staleness.js";

/** The REAL LTXICLoRALoaderModelOnly schema: a `model` CONNECTION input plus two
 *  WIDGET inputs. Connection inputs must not be counted as widgets (finding #3). */
const LTX_ICLORA_DEF = {
  input: {
    required: {
      model: ["MODEL"],
      lora_name: [["lora_a.safetensors", "lora_b.safetensors"]],
      strength_model: ["FLOAT", { default: 1.0 }],
    },
  },
};

/** Minimal fake graph: id → node keyed as a STRING (so numeric AND string/UUID
 *  ids both resolve), exposes _nodes + getNodeById + optional per-node subgraph. */
function graphOf(nodes) {
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  return { _nodes: nodes, getNodeById: (id) => byId.get(String(id)) ?? null };
}

test("findNodeByScopedId resolves a plain id", () => {
  const n = { id: 42, widgets: [] };
  assert.equal(findNodeByScopedId(graphOf([n]), 42), n);
});

test("findNodeByScopedId walks a subgraph-scoped id one hop per segment", () => {
  const inner = { id: 1913, widgets: [] };
  const sub = { id: 6051, subgraph: graphOf([inner]) };
  const root = graphOf([sub]);
  assert.equal(findNodeByScopedId(root, "6051:1913"), inner);
});

test("findNodeByScopedId returns null for a missing node", () => {
  assert.equal(findNodeByScopedId(graphOf([]), 7), null);
  assert.equal(findNodeByScopedId(graphOf([{ id: 6051 }]), "6051:9999"), null);
});

test("assetCandidateStillReferenced: true while a widget still holds the file", () => {
  const node = { id: 5, widgets: [{ name: "lora_name", value: "old.safetensors" }] };
  assert.equal(
    assetCandidateStillReferenced(graphOf([node]), 5, "old.safetensors"),
    true,
  );
});

test("assetCandidateStillReferenced: false after the widget was pointed elsewhere (#196)", () => {
  const node = { id: 5, widgets: [{ name: "lora_name", value: "new.safetensors" }] };
  assert.equal(
    assetCandidateStillReferenced(graphOf([node]), 5, "old.safetensors"),
    false,
  );
});

test("assetCandidateStillReferenced fails OPEN when the node is gone", () => {
  assert.equal(assetCandidateStillReferenced(graphOf([]), 99, "x.safetensors"), true);
});

test("assetCandidateResolvesLive: true when the file is now a live combo value (#223/#185)", () => {
  const node = {
    id: 4,
    widgets: [
      { name: "ckpt_name", value: "model.safetensors", options: { values: ["model.safetensors", "other.safetensors"] } },
    ],
  };
  assert.equal(
    assetCandidateResolvesLive(graphOf([node]), 4, "model.safetensors", "ckpt_name"),
    true,
  );
});

test("assetCandidateResolvesLive supports a function-valued combo and fails CLOSED when absent", () => {
  const node = {
    id: 4,
    widgets: [{ name: "ckpt_name", value: "a", options: { values: () => ["a", "b"] } }],
  };
  assert.equal(assetCandidateResolvesLive(graphOf([node]), 4, "a", "ckpt_name"), true);
  assert.equal(assetCandidateResolvesLive(graphOf([node]), 4, "missing", "ckpt_name"), false);
});

test("isStaleAssetCandidate: stale once fixed by set_widget (subgraph-scoped)", () => {
  const inner = { id: 6077, widgets: [{ name: "model", value: "..._fp8_scaled.safetensors" }] };
  const sub = { id: 6105, subgraph: graphOf([inner]) };
  const root = graphOf([sub]);
  // Store still lists the pre-edit filename — the widget no longer references it.
  assert.equal(
    isStaleAssetCandidate(root, { nodeId: "6105:6077", name: "..._fp16.safetensors", widgetName: "model" }),
    true,
  );
});

test("isStaleAssetCandidate: NOT stale for a genuinely missing model", () => {
  const node = {
    id: 8,
    widgets: [{ name: "ckpt_name", value: "gone.safetensors", options: { values: ["present.safetensors"] } }],
  };
  assert.equal(
    isStaleAssetCandidate(graphOf([node]), { nodeId: 8, name: "gone.safetensors", widgetName: "ckpt_name" }),
    false,
  );
});

test("findNodeByScopedId resolves a string/UUID node id without NaN coercion (finding #5)", () => {
  const n = { id: "a1b2c3d4-uuid", widgets: [] };
  assert.equal(findNodeByScopedId(graphOf([n]), "a1b2c3d4-uuid"), n);
});

test("isStaleAssetCandidate clears a fixed candidate on a string/UUID-keyed graph (finding #5)", () => {
  // Widget was pointed at a new file; the store still lists the old one. The
  // still-referenced check must work even though the id is a non-numeric string.
  const node = { id: "node-uuid-1", widgets: [{ name: "ckpt_name", value: "new.safetensors" }] };
  assert.equal(
    isStaleAssetCandidate(graphOf([node]), { nodeId: "node-uuid-1", name: "old.safetensors", widgetName: "ckpt_name" }),
    true,
  );
});

test("a STALE combo still listing a deleted file must NOT suppress a genuine miss (finding #4)", () => {
  // The model was deleted, but the combo populated at page load still lists it.
  // The widget still references it → still-referenced can't clear it. Combo
  // membership could — but only when a refresh is CONFIRMED.
  const node = {
    id: 5,
    widgets: [{ name: "ckpt_name", value: "deleted.safetensors", options: { values: ["deleted.safetensors"] } }],
  };
  const candidate = { nodeId: 5, name: "deleted.safetensors", widgetName: "ckpt_name" };
  // Default (no confirmed refresh): must keep reporting the genuine miss.
  assert.equal(isStaleAssetCandidate(graphOf([node]), candidate), false);
  assert.equal(isStaleAssetCandidate(graphOf([node]), candidate, { trustCombo: false }), false);
  // Only after a confirmed refresh is combo membership trusted to clear it.
  assert.equal(isStaleAssetCandidate(graphOf([node]), candidate, { trustCombo: true }), true);
});

test("collectAllGraphs walks nested subgraphs", () => {
  const inner = { id: 2, widgets: [] };
  const innerGraph = graphOf([inner]);
  const host = { id: 1, subgraph: innerGraph };
  const root = graphOf([host]);
  const graphs = collectAllGraphs(root);
  assert.ok(graphs.includes(root));
  assert.ok(graphs.includes(innerGraph));
});

test("reapplyDefsToLiveNodes repairs an ALREADY-LOADED node using fresh defs (finding #3)", () => {
  // Existing instance: stale/generic constructor (nodeData absent), widgets came
  // in as positional UNKNOWN placeholders. The fresh def (which INCLUDES the
  // `model` CONNECTION input, as the real schema does) must repair it in place —
  // counting only the two WIDGET inputs, not the connection input.
  const node = {
    id: 7,
    type: "LTXICLoRALoaderModelOnly",
    widgets: [
      { name: "UNKNOWN", value: "x.safetensors" },
      { name: "UNKNOWN_1", value: 1.0 },
    ],
    constructor: {}, // generic fallback — no nodeData
  };
  const defs = { LTXICLoRALoaderModelOnly: LTX_ICLORA_DEF };
  const repaired = reapplyDefsToLiveNodes(graphOf([node]), defs);
  assert.equal(repaired, 1);
  assert.deepEqual(node.widgets.map((w) => w.name), ["lora_name", "strength_model"]);
});

test("reapplyDefsToLiveNodes stamps fresh nodeData onto a type-specific constructor", () => {
  const oldDef = { input: { required: { seed: {} } } };
  const newDef = { input: { required: { seed: {}, box_toggle_max_frames: {} } } };
  const shared = { nodeData: oldDef }; // type-specific constructor shared by instances
  const node = { id: 9, type: "CyberpunkWindowNode", widgets: [], constructor: shared };
  reapplyDefsToLiveNodes(graphOf([node]), { CyberpunkWindowNode: newDef });
  assert.equal(node.constructor.nodeData, newDef);
});

test("isWidgetInputSpec: combos + primitive widget types are widgets; connections + forced inputs are not", () => {
  assert.equal(isWidgetInputSpec([["a", "b"]]), true); // combo
  assert.equal(isWidgetInputSpec(["FLOAT", { default: 1 }]), true);
  assert.equal(isWidgetInputSpec(["INT"]), true);
  assert.equal(isWidgetInputSpec(["MODEL"]), false); // connection
  assert.equal(isWidgetInputSpec(["CLIP"]), false);
  assert.equal(isWidgetInputSpec(["STRING", { forceInput: true }]), false);
  assert.equal(isWidgetInputSpec(["INT", { widget: false }]), false);
});

test("orderedWidgetInputNames EXCLUDES connection inputs, honoring input_order (finding #3)", () => {
  // The real LTX schema: `model` connection must be dropped; only the 2 widgets
  // remain, in declaration order.
  assert.deepEqual(orderedWidgetInputNames(LTX_ICLORA_DEF), ["lora_name", "strength_model"]);
  const withOrder = {
    input: {
      required: { model: ["MODEL"], seed: ["INT"], name: ["STRING"] },
    },
    input_order: { required: ["model", "name", "seed"] },
  };
  assert.deepEqual(orderedWidgetInputNames(withOrder), ["name", "seed"]);
});

test("reconcileUnknownWidgetNames renames placeholders against the REAL schema with a connection input (#199 / finding #3)", () => {
  // 2 UNKNOWN widgets vs a def with 3 inputs (1 connection + 2 widgets). Counting
  // only widget inputs makes this the unambiguous 2==2 case and repairs it.
  const node = {
    widgets: [
      { name: "UNKNOWN", value: "x.safetensors" },
      { name: "UNKNOWN_1", value: 1.0 },
    ],
    constructor: { nodeData: LTX_ICLORA_DEF },
  };
  assert.equal(reconcileUnknownWidgetNames(node), true);
  assert.deepEqual(node.widgets.map((w) => w.name), ["lora_name", "strength_model"]);
});

test("reconcileUnknownWidgetNames leaves names alone when the mapping is ambiguous", () => {
  const node = {
    widgets: [{ name: "UNKNOWN", value: 1 }],
    constructor: { nodeData: { input: { required: { a: {}, b: {}, c: {} } } } },
  };
  assert.equal(reconcileUnknownWidgetNames(node), false);
  assert.equal(node.widgets[0].name, "UNKNOWN");
});

test("reconcileUnknownWidgetNames is a no-op when there are no placeholders", () => {
  const node = {
    widgets: [{ name: "seed", value: 1 }],
    constructor: { nodeData: { input: { required: { seed: {} } } } },
  };
  assert.equal(reconcileUnknownWidgetNames(node), false);
});
