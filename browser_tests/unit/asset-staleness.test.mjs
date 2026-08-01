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
  findSubgraphByUuid,
  assetCandidateStillReferenced,
  assetCandidateResolvesLive,
  isStaleAssetCandidate,
  locatorIsRecognized,
  orderedWidgetInputNames,
  isWidgetInputSpec,
  reconcileUnknownWidgetNames,
  collectAllGraphs,
  reapplyDefsToLiveNodes,
  collectMissingNodeTypeReasons,
  graphErrorsResultIsClean,
  nodeRedFlagIsStale,
  resolveMissingModelDirectory,
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

/** A subgraph whose UUID is its `id` (real LiteGraph shape), holding `nodes`. */
function subgraphOf(id, nodes) {
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  return { id, _nodes: nodes, getNodeById: (nid) => byId.get(String(nid)) ?? null };
}
/** A root graph with a `subgraphs` UUID→Subgraph registry (real ComfyUI shape). */
function rootWithSubgraphs(rootNodes, subgraphs) {
  const byId = new Map(rootNodes.map((n) => [String(n.id), n]));
  return {
    _nodes: rootNodes,
    getNodeById: (id) => byId.get(String(id)) ?? null,
    subgraphs: new Map(subgraphs.map((s) => [s.id, s])),
  };
}

const SG_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

test("findSubgraphByUuid resolves via the root subgraphs registry", () => {
  const sub = subgraphOf(SG_UUID, []);
  const root = rootWithSubgraphs([], [sub]);
  assert.equal(findSubgraphByUuid(root, SG_UUID), sub);
});

test("findSubgraphByUuid falls back to a recursive subgraph.id match", () => {
  const inner = { id: 1913, widgets: [] };
  const sub = subgraphOf(SG_UUID, [inner]);
  const host = { id: 6051, subgraph: sub };
  const root = graphOf([host]); // no registry
  assert.equal(findSubgraphByUuid(root, SG_UUID), sub);
});

test("findNodeByScopedId resolves a REAL locator '<subgraphUuid>:<localId>' (#247)", () => {
  const inner = { id: 1913, widgets: [] };
  const sub = subgraphOf(SG_UUID, [inner]);
  const root = rootWithSubgraphs([], [sub]);
  assert.equal(findNodeByScopedId(root, `${SG_UUID}:1913`), inner);
});

test("findNodeByScopedId returns null when the subgraph UUID is unknown (fails open)", () => {
  const root = rootWithSubgraphs([], []);
  assert.equal(findNodeByScopedId(root, `${SG_UUID}:1913`), null);
});

test("findNodeByScopedId STRICT-rejects malformed locators ⇒ null ⇒ fail-open (codex round-2 #1)", () => {
  // The subgraph DOES contain node 6077 — a loose first/last-segment parse would
  // wrongly resolve it and suppress a genuine miss. Strict parsing must return
  // null for every malformed shape so the cross-check keeps reporting.
  const inner = { id: 6077, widgets: [{ name: "image", value: "still-missing.png" }] };
  const sub = subgraphOf(SG_UUID, [inner]);
  const root = rootWithSubgraphs([], [sub]);
  assert.equal(findNodeByScopedId(root, `${SG_UUID}:unexpected:6077`), null); // 3 segments
  assert.equal(findNodeByScopedId(root, `${SG_UUID}::6077`), null); // empty middle
  assert.equal(findNodeByScopedId(root, `${SG_UUID}:`), null); // empty local id
  assert.equal(findNodeByScopedId(root, `not-a-uuid:6077`), null); // bad UUID
  assert.equal(findNodeByScopedId(root, `${SG_UUID}:6077:extra:more`), null); // 4 segments
  // The valid two-segment form still resolves.
  assert.equal(findNodeByScopedId(root, `${SG_UUID}:6077`), inner);
});

test("isStaleAssetCandidate: a malformed 3-segment locator does NOT suppress a genuine miss (fail-open, codex round-2 #1)", () => {
  const inner = { id: 6077, widgets: [{ name: "image", value: "moved.png" }] };
  const sub = subgraphOf(SG_UUID, [inner]);
  const root = rootWithSubgraphs([], [sub]);
  // Even though no widget holds "gone.png", the locator is unrecognized ⇒ resolver
  // returns null ⇒ still-referenced fails OPEN ⇒ candidate is NOT dropped.
  assert.equal(
    isStaleAssetCandidate(root, { nodeId: `${SG_UUID}:x:6077`, name: "gone.png", widgetName: "image" }),
    false,
  );
});

test("findSubgraphByUuid terminates on a cyclic subgraph graph (codex round-2 #2)", () => {
  // Build a cycle: subgraph A hosts a node whose subgraph is B, and B hosts a
  // node whose subgraph is A again. An unknown UUID must not recurse forever.
  const a = subgraphOf("uuid-A", []);
  const b = subgraphOf("uuid-B", []);
  a._nodes = [{ id: 1, subgraph: b }];
  b._nodes = [{ id: 2, subgraph: a }];
  const root = graphOf([{ id: 10, subgraph: a }]);
  assert.equal(findSubgraphByUuid(root, "does-not-exist"), null); // terminates, no overflow
  assert.equal(findSubgraphByUuid(root, "uuid-B"), b); // still finds a real one
});

test("findNodeByScopedId fails open (null) on a cyclic graph with an unknown UUID (codex round-2 #2)", () => {
  const a = subgraphOf("uuid-A", []);
  const b = subgraphOf("uuid-B", []);
  a._nodes = [{ id: 1, subgraph: b }];
  b._nodes = [{ id: 2, subgraph: a }];
  const root = graphOf([{ id: 10, subgraph: a }]);
  assert.equal(findNodeByScopedId(root, `${SG_UUID}:6077`), null); // no overflow, fail-open
});

test("isStaleAssetCandidate: STALE once a subgraph LoadImage/model widget is fixed via a UUID locator (#247/#352)", () => {
  // LTX-style subgraph: the store still lists the pre-edit template filename, but
  // the live widget inside the subgraph now points at the installed alternative.
  const inner = { id: 6077, widgets: [{ name: "image", value: "ChatGPT Image.png" }] };
  const sub = subgraphOf(SG_UUID, [inner]);
  const root = rootWithSubgraphs([], [sub]);
  assert.equal(
    isStaleAssetCandidate(root, {
      nodeId: `${SG_UUID}:6077`,
      name: "sample_woman.png",
      widgetName: "image",
    }),
    true,
  );
});

test("isStaleAssetCandidate: a genuinely-missing subgraph asset STILL reports (UUID locator)", () => {
  const inner = { id: 6077, widgets: [{ name: "ckpt_name", value: "ltx-2.3-22b-dev.safetensors" }] };
  const sub = subgraphOf(SG_UUID, [inner]);
  const root = rootWithSubgraphs([], [sub]);
  assert.equal(
    isStaleAssetCandidate(root, {
      nodeId: `${SG_UUID}:6077`,
      name: "ltx-2.3-22b-dev.safetensors",
      widgetName: "ckpt_name",
    }),
    false,
  );
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

// ── #316: cross-tab / removed-node scoping ──────────────────────────────────
test("locatorIsRecognized mirrors findNodeByScopedId's recognized shapes", () => {
  assert.equal(locatorIsRecognized("66"), true); // plain local id
  assert.equal(locatorIsRecognized("node-uuid-1"), true); // string/UUID-like id
  assert.equal(locatorIsRecognized("6051:1913"), true); // legacy numeric hop
  assert.equal(locatorIsRecognized(`${SG_UUID}:1913`), true); // real subgraph locator
  assert.equal(locatorIsRecognized(""), false); // empty
  assert.equal(locatorIsRecognized(`${SG_UUID}:x:6077`), false); // 3 segments
  assert.equal(locatorIsRecognized(`${SG_UUID}::6077`), false); // empty middle
  assert.equal(locatorIsRecognized(`${SG_UUID}:`), false); // empty local id
  assert.equal(locatorIsRecognized("not-a-uuid:6077"), false); // bad UUID
  assert.equal(locatorIsRecognized("6051:"), false); // trailing empty numeric hop
});

test("isStaleAssetCandidate: DROPS a candidate whose node isn't in the active graph (#316 cross-tab leak)", () => {
  // Active workflow tab is a simple 8-node graph WITHOUT node 66. The missingModel
  // store still holds node 66 from a previously-open tab → it must not be reported.
  const active = graphOf([{ id: 3 }, { id: 5 }, { id: 6 }, { id: 16 }]);
  assert.equal(
    isStaleAssetCandidate(active, {
      nodeId: "66",
      name: "z_image_turbo_bf16.safetensors",
      widgetName: "unet_name",
    }),
    true,
  );
});

test("isStaleAssetCandidate: DROPS a foreign SUBGRAPH-scoped candidate whose subgraph isn't in the active graph (#316)", () => {
  const active = rootWithSubgraphs([{ id: 3 }], []); // no subgraph registered
  assert.equal(
    isStaleAssetCandidate(active, {
      nodeId: `${SG_UUID}:6077`,
      name: "rife_v4.26.safetensors",
      widgetName: "ckpt_name",
    }),
    true,
  );
});

test("isStaleAssetCandidate: a foreign candidate is KEPT when scopeToActiveGraph is off (fail-open opt-out)", () => {
  const active = graphOf([{ id: 3 }]);
  const candidate = { nodeId: "66", name: "x.safetensors", widgetName: "unet_name" };
  assert.equal(isStaleAssetCandidate(active, candidate, { scopeToActiveGraph: false }), false);
});

test("isStaleAssetCandidate: an UNPARSEABLE foreign-looking locator is NOT dropped by scoping (fail-open, #316 safety)", () => {
  // A malformed locator with no matching node must fail OPEN, not be silently
  // dropped as 'foreign' — otherwise a genuine miss on an odd id would vanish.
  const active = graphOf([{ id: 3 }]);
  assert.equal(
    isStaleAssetCandidate(active, {
      nodeId: `${SG_UUID}:x:6077`,
      name: "gone.safetensors",
      widgetName: "ckpt_name",
    }),
    false,
  );
});

test("isStaleAssetCandidate: a genuine miss on a node PRESENT in the active graph still reports (scoping no-op)", () => {
  const node = {
    id: 66,
    widgets: [{ name: "unet_name", value: "z_image_turbo_bf16.safetensors" }],
  };
  assert.equal(
    isStaleAssetCandidate(graphOf([node]), {
      nodeId: "66",
      name: "z_image_turbo_bf16.safetensors",
      widgetName: "unet_name",
    }),
    false,
  );
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

// ---------------------------------------------------------------------------
// collectMissingNodeTypeReasons — per-node missing-node-type blame (#399)
// ---------------------------------------------------------------------------

test("collectMissingNodeTypeReasons: blames a node whose type is uninstalled (#399)", () => {
  const nodes = [
    { id: 5239, type: "RIFEInterpolation" },
    { id: 3, type: "KSampler" },
  ];
  assert.deepEqual(collectMissingNodeTypeReasons(nodes, ["RIFEInterpolation"]), [
    { nodeId: 5239, type: "RIFEInterpolation" },
  ]);
});

test("collectMissingNodeTypeReasons: surfaces a BYPASSED/MUTED missing node (mode never filters) (#399)", () => {
  // mode 4 = bypass, mode 2 = mute — the exact case the reporter hit. The helper must
  // still blame it; graph_get_errors' has_errors-based flagging would otherwise miss it.
  const nodes = [
    { id: 5239, type: "RIFEInterpolation", mode: 4 },
    { id: 7, type: "RIFEInterpolation", mode: 2 },
  ];
  assert.deepEqual(collectMissingNodeTypeReasons(nodes, ["RIFEInterpolation"]), [
    { nodeId: 5239, type: "RIFEInterpolation" },
    { nodeId: 7, type: "RIFEInterpolation" },
  ]);
});

test("collectMissingNodeTypeReasons: matches on comfyClass when type is absent", () => {
  const nodes = [{ id: 9, comfyClass: "SomeMissingNode" }];
  assert.deepEqual(collectMissingNodeTypeReasons(nodes, ["SomeMissingNode"]), [
    { nodeId: 9, type: "SomeMissingNode" },
  ]);
});

test("collectMissingNodeTypeReasons: empty for no missing types / no nodes / no match", () => {
  assert.deepEqual(collectMissingNodeTypeReasons([{ id: 1, type: "KSampler" }], []), []);
  assert.deepEqual(collectMissingNodeTypeReasons([], ["RIFEInterpolation"]), []);
  assert.deepEqual(
    collectMissingNodeTypeReasons([{ id: 1, type: "KSampler" }], ["RIFEInterpolation"]),
    [],
  );
});

test("collectMissingNodeTypeReasons: defensive against malformed inputs (never throws)", () => {
  assert.deepEqual(collectMissingNodeTypeReasons(null, ["X"]), []);
  assert.deepEqual(collectMissingNodeTypeReasons([{ id: 1, type: "X" }], null), []);
  // A node with no type/comfyClass is skipped, not blamed.
  assert.deepEqual(collectMissingNodeTypeReasons([{ id: 1 }], ["X"]), []);
});

// ---------------------------------------------------------------------------
// graphErrorsResultIsClean — honest "errors vs none" for the command summary (#399/#356)
// ---------------------------------------------------------------------------

test("graphErrorsResultIsClean: TRUE only for a truly empty result", () => {
  assert.equal(graphErrorsResultIsClean({ errored_count: 0, node_errors: null, last_execution_error: null }), true);
  assert.equal(graphErrorsResultIsClean({}), true);
  assert.equal(graphErrorsResultIsClean(null), true);
});

test("graphErrorsResultIsClean: FALSE for a missing-node-type-ONLY result (bypassed node — #399)", () => {
  // The exact false-clean the summary label produced: no node_errors / exec error, but
  // a populated missing_node_types (and errored_count from the attached per-node reason).
  assert.equal(
    graphErrorsResultIsClean({
      errored_count: 1,
      node_errors: null,
      last_execution_error: null,
      missing_node_types: ["RIFEInterpolation"],
    }),
    false,
  );
});

test("graphErrorsResultIsClean: FALSE for missing_models / missing_media / missing_node_count only", () => {
  assert.equal(graphErrorsResultIsClean({ missing_models: [{ file: "x.safetensors" }] }), false);
  assert.equal(graphErrorsResultIsClean({ missing_media: [{ file: "in.png" }] }), false);
  assert.equal(graphErrorsResultIsClean({ missing_node_count: 2 }), false);
});

test("graphErrorsResultIsClean: FALSE for raw validation / execution errors", () => {
  assert.equal(graphErrorsResultIsClean({ node_errors: { 3: { errors: [] } } }), false);
  assert.equal(graphErrorsResultIsClean({ last_execution_error: { node_id: 5 } }), false);
  assert.equal(graphErrorsResultIsClean({ errored_count: 2 }), false);
});

// ---- #407: a subfolder-registered model resolves against the live combo -----
// A custom-model root registered under a SUBFOLDER (Impact Subpack's
// `segm/yolov8m-seg.pt`) is a valid /object_info combo value; once the combo is
// trusted it must NOT be flagged missing. Match is EXACT (no separator munging —
// see the helper's comment on the POSIX literal-backslash hazard).
test("assetCandidateResolvesLive: resolves a subfolder model listed in the live combo (#407)", () => {
  const node = {
    id: 9,
    widgets: [
      { name: "model_name", options: { values: ["bbox/face.pt", "segm/yolov8m-seg.pt"] } },
    ],
  };
  const g = graphOf([node]);
  assert.equal(assetCandidateResolvesLive(g, 9, "segm/yolov8m-seg.pt", "model_name"), true);
  // a genuinely-absent nested model still fails CLOSED (kept as missing)
  assert.equal(assetCandidateResolvesLive(g, 9, "segm/not-here.pt", "model_name"), false);
  // a literal backslash filename is NOT equated with the forward-slash one (POSIX safety)
  const bs = String.fromCharCode(92);
  assert.equal(assetCandidateResolvesLive(g, 9, `segm${bs}yolov8m-seg.pt`, "model_name"), false);
});

// ---- #418: stale red-flag clearing after a set_widget fix ------------------
test("nodeRedFlagIsStale: TRUE when no missing asset and no validation error remain (#418)", () => {
  assert.equal(nodeRedFlagIsStale(5, { missingItems: [], nodeErrorsMap: null }), true);
  assert.equal(
    nodeRedFlagIsStale(5, { missingItems: [{ node_id: 7 }], nodeErrorsMap: { 9: { errors: [{}] } } }),
    true,
  );
});

test("nodeRedFlagIsStale: FALSE while the node is still a missing-asset target (#418)", () => {
  assert.equal(
    nodeRedFlagIsStale(5, { missingItems: [{ node_id: 5, file: "x.safetensors" }] }),
    false,
  );
  // id compared as a STRING so numeric/string node ids both match
  assert.equal(nodeRedFlagIsStale("5", { missingItems: [{ node_id: 5 }] }), false);
});

test("nodeRedFlagIsStale: FALSE while the node still has a live validation error (#418)", () => {
  assert.equal(
    nodeRedFlagIsStale(5, { nodeErrorsMap: { 5: { errors: [{ message: "bad" }] } } }),
    false,
  );
  // an EMPTY errors array is not a live error → stale (clearable)
  assert.equal(nodeRedFlagIsStale(5, { nodeErrorsMap: { 5: { errors: [] } } }), true);
});

test("nodeRedFlagIsStale: fails toward KEEPING the flag on a null/absent node id", () => {
  assert.equal(nodeRedFlagIsStale(null, {}), false);
  assert.equal(nodeRedFlagIsStale(undefined, {}), false);
});

test("nodeRedFlagIsStale: a NESTED still-missing asset (scoped locator) keeps the flag via resolvesToNode (#418 codex round-3 P0)", () => {
  const inner = { id: 6077, widgets: [{ name: "image", value: "gone.png" }] };
  // Candidate is keyed by a scoped locator "6105:6077" — does NOT string-equal 6077.
  const missingItems = [{ node_id: "6105:6077", file: "gone.png" }];
  // Without a resolver, the scoped id can't be matched → would wrongly read as stale.
  assert.equal(nodeRedFlagIsStale(6077, { missingItems }), true);
  // With a resolver that maps the scoped locator to THIS inner node, the still-missing
  // asset is recognized → flag KEPT (not stale).
  assert.equal(
    nodeRedFlagIsStale(6077, {
      missingItems,
      resolvesToNode: (scopedId) => (scopedId === "6105:6077" ? inner : null) === inner,
    }),
    false,
  );
  // A resolver that maps to a DIFFERENT node does not keep this node's flag.
  assert.equal(
    nodeRedFlagIsStale(6077, {
      missingItems,
      resolvesToNode: () => false,
    }),
    true,
  );
});

test("nodeRedFlagIsStale: OR across multiple maps — an EMPTY entry in one must not shadow a live error in another (#418 codex round-2 P0)", () => {
  const appMap = { 5: { errors: [] } }; // app reset to empty for node 5
  const storeMap = { 5: { errors: [{ message: "still bad" }] } }; // store still blames it
  // A shallow merge {...store, ...app} would drop the live store error → wrong clear.
  assert.equal(nodeRedFlagIsStale(5, { nodeErrorsMaps: [appMap, storeMap] }), false);
  // Order-independent — the live map second is also honored.
  assert.equal(nodeRedFlagIsStale(5, { nodeErrorsMaps: [storeMap, appMap] }), false);
  // Both empty → stale (clearable).
  assert.equal(
    nodeRedFlagIsStale(5, { nodeErrorsMaps: [{ 5: { errors: [] } }, null] }),
    true,
  );
});

// --- resolveMissingModelDirectory (#487) — Ultralytics bbox/segm subfolder ---

test("resolveMissingModelDirectory: segm/ combo value overrides a default ultralytics/bbox directory", () => {
  assert.equal(
    resolveMissingModelDirectory("ultralytics/bbox", "segm/ntd11_anime_nsfw_segm_v5.pt"),
    "ultralytics/segm",
  );
});

test("resolveMissingModelDirectory: bbox/ combo value stays in ultralytics/bbox", () => {
  assert.equal(
    resolveMissingModelDirectory("ultralytics/bbox", "bbox/face_yolov8m.pt"),
    "ultralytics/bbox",
  );
});

test("resolveMissingModelDirectory: bare `ultralytics` directory gains the prefix subfolder", () => {
  assert.equal(resolveMissingModelDirectory("ultralytics", "segm/x.pt"), "ultralytics/segm");
  assert.equal(resolveMissingModelDirectory("ultralytics", "bbox/x.pt"), "ultralytics/bbox");
});

test("resolveMissingModelDirectory: a store directory already ultralytics/segm is corrected by a bbox/ value", () => {
  assert.equal(resolveMissingModelDirectory("ultralytics/segm", "bbox/x.pt"), "ultralytics/bbox");
});

test("resolveMissingModelDirectory: Windows backslashes are normalized before matching", () => {
  assert.equal(resolveMissingModelDirectory("ultralytics\\bbox", "segm\\x.pt"), "ultralytics/segm");
});

test("resolveMissingModelDirectory: file WITHOUT a bbox/segm prefix is left unchanged", () => {
  assert.equal(resolveMissingModelDirectory("ultralytics/bbox", "yolov8m.pt"), "ultralytics/bbox");
  assert.equal(resolveMissingModelDirectory("ultralytics/bbox", null), "ultralytics/bbox");
});

test("resolveMissingModelDirectory: NON-ultralytics directories never regress", () => {
  // A checkpoint/lora subfolder that merely happens to start with bbox/segm-looking text
  // must be passed through untouched — only ultralytics folders are rewritten.
  assert.equal(resolveMissingModelDirectory("checkpoints", "segm/x.pt"), "checkpoints");
  assert.equal(resolveMissingModelDirectory("loras", "bbox/x.pt"), "loras");
  assert.equal(resolveMissingModelDirectory("ultralytics_extra", "segm/x.pt"), "ultralytics_extra");
  assert.equal(resolveMissingModelDirectory(null, "segm/x.pt"), null);
});
