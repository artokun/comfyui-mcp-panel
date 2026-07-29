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
  reconcileUnknownWidgetNames,
} from "../../web/js/lib/asset-staleness.js";

/** Minimal fake graph: a Map of id → node, with getNodeById + optional subgraph. */
function graphOf(nodes) {
  const byId = new Map(nodes.map((n) => [Number(n.id), n]));
  return { getNodeById: (id) => byId.get(Number(id)) ?? null };
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

test("orderedWidgetInputNames concatenates required then optional, honoring input_order", () => {
  const nodeData = {
    input: { required: { a: {}, b: {} }, optional: { c: {} } },
    input_order: { required: ["b", "a"], optional: ["c"] },
  };
  assert.deepEqual(orderedWidgetInputNames(nodeData), ["b", "a", "c"]);
});

test("reconcileUnknownWidgetNames renames placeholders when count matches (#199)", () => {
  const node = {
    widgets: [
      { name: "UNKNOWN", value: "x.safetensors" },
      { name: "UNKNOWN_1", value: 1.0 },
    ],
    constructor: { nodeData: { input: { required: { lora_name: {}, strength_model: {} } } } },
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
