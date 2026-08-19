/**
 * Unit tests for web/js/lib/asset-staleness.js — run with `node --test`.
 *
 * Covers the WS-3 stale-snapshot fixes: subgraph-scoped id resolution, the
 * missing-asset live-graph cross-check (fixed-by-set_widget and appeared-on-disk),
 * fail-open/closed safety, and UNKNOWN-widget positional reconciliation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** #1172 — the wiring assertion reads the shipped monolith, so the disclosure cannot be
 *  added to the verdict while the forwarding whitelist silently drops it. */
const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

import {
  findNodeByScopedId,
  findVisibleNodeByScopedId,
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
  comboRebuildCovered,
  authoritativeComboValues,
  emptyComboListsOnGraph,
  emptyComboNote,
  collectMissingNodeTypeReasons,
  collectUnexplainedRedOutlines,
  combineNodeErrorMaps,
  graphErrorsFindingCounts,
  graphErrorsResultIsClean,
  nodeRedFlagIsStale,
  collectLinkedNeighborNodeIds,
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

test("findVisibleNodeByScopedId maps a scoped missing asset only onto its displayed subgraph node (#579 P1)", () => {
  const inner = { id: 6077, has_errors: true, widgets: [{ name: "ckpt_name", value: "gone.safetensors" }] };
  const sameLocalIdElsewhere = { id: 6077, has_errors: true, widgets: [] };
  const sub = subgraphOf(SG_UUID, [inner]);
  const root = rootWithSubgraphs([{ id: 100, subgraph: sub }, sameLocalIdElsewhere], [sub]);
  const locator = `${SG_UUID}:6077`;

  assert.equal(findVisibleNodeByScopedId(root, [inner], locator), inner);
  assert.equal(
    findVisibleNodeByScopedId(root, [sameLocalIdElsewhere], locator),
    null,
    "a local-id collision in another scope must not receive the missing-asset reason",
  );
  const reasons = new Map([[String(inner.id), [{ kind: "missing_model", file: "gone.safetensors" }]]]);
  assert.deepEqual(
    collectUnexplainedRedOutlines([inner], reasons, {}).map((node) => node.id),
    [],
    "the real scoped missing asset stays a per-node error, never a stale outline",
  );
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

// ---- #586: stale missing_media after a LoadImage widget change ----
// The missingMedia Pinia store is populated at workflow LOAD; after the user
// repoints the node's image widget to a different file, the load-time candidate
// for the OLD value must no longer be reported. The drop must come from the
// WIDGET-REFERENCE cross-check — so pin it with trustCombo:false (the combo
// clear path inert) and a node that provably still exists (the scope-drop path
// inert). Mirroring the issue's repro: node 2129, load-time value
// 20260707_130607992_iOS.jpg, widget changed to helloe.png.
test("isStaleAssetCandidate drops a missing-MEDIA candidate whose LoadImage widget moved to a new file (#586)", () => {
  const node = {
    id: 2129,
    type: "LoadImage",
    widgets: [{ name: "image", value: "helloe.png", options: { values: ["helloe.png"] } }],
  };
  const candidate = {
    nodeId: "2129",
    name: "20260707_130607992_iOS.jpg",
    widgetName: "image",
    mediaType: "image",
    isMissing: true,
  };
  // Assert the REASON, not just the verdict: with no combo trust and the node
  // present, only the still-referenced check can drop it.
  assert.equal(
    assetCandidateStillReferenced(graphOf([node]), "2129", "20260707_130607992_iOS.jpg"),
    false,
    "no widget still holds the old file",
  );
  assert.equal(
    isStaleAssetCandidate(graphOf([node]), candidate, { trustCombo: false }),
    true,
  );
});

test("isStaleAssetCandidate KEEPS the media candidate while the widget still holds the missing file (#586 control)", () => {
  const node = {
    id: 2129,
    type: "LoadImage",
    widgets: [{ name: "image", value: "helloe.png", options: { values: ["helloe.png"] } }],
  };
  const candidate = {
    nodeId: "2129",
    name: "helloe.png",
    widgetName: "image",
    mediaType: "image",
    isMissing: true,
  };
  // trustCombo stays false: a genuinely missing current value must survive even
  // though the combo lists it (an untrusted combo may be a stale snapshot).
  assert.equal(
    isStaleAssetCandidate(graphOf([node]), candidate, { trustCombo: false }),
    false,
  );
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

// ---- #569: widget-shift blame — the node's CURRENT model-carrying widget clears ----
// A save corrupted by a node-signature change recorded the model filename under an
// unrelated widget (`control_after_generate`, whose fixed/increment/randomize combo
// can never contain a filename). After repair the file lives in the REAL model
// widget (`upscale_model_name`) — the same widget that keeps the candidate alive
// via the node-wide still-referenced scan — so the live-resolution check must
// consult it too, or a fully-fixed node reports a phantom missing model forever.
test("assetCandidateResolvesLive: widget-shift blamed widget — file held+resolved by a DIFFERENT widget clears the candidate (#569)", () => {
  const node = {
    id: 803,
    widgets: [
      { name: "control_after_generate", value: "fixed", options: { values: ["fixed", "increment", "randomize"] } },
      { name: "upscale_model_name", value: "4x_foolhardy_Remacri.pth", options: { values: ["4x_foolhardy_Remacri.pth", "other.pth"] } },
    ],
  };
  assert.equal(
    assetCandidateResolvesLive(graphOf([node]), 803, "4x_foolhardy_Remacri.pth", "control_after_generate"),
    true,
  );
});

test("assetCandidateResolvesLive: a genuinely-missing file held by a widget but NOT offered by any fresh combo still flags (#569 fail-closed)", () => {
  const node = {
    id: 804,
    widgets: [
      { name: "control_after_generate", value: "fixed", options: { values: ["fixed", "increment", "randomize"] } },
      { name: "upscale_model_name", value: "gone.pth", options: { values: ["other.pth"] } },
    ],
  };
  assert.equal(
    assetCandidateResolvesLive(graphOf([node]), 804, "gone.pth", "control_after_generate"),
    false,
  );
});

test("assetCandidateResolvesLive: blamed widget has NO usable combo but the model-carrying widget resolves (#569)", () => {
  // The blamed widget exists but carries no option list at all (a seed/INT-style
  // widget the shifted save blamed); the file is held + fresh-combo-listed elsewhere.
  const node = {
    id: 805,
    widgets: [
      { name: "seed", value: 42 },
      { name: "ckpt_name", value: "model.safetensors", options: { values: ["model.safetensors"] } },
    ],
  };
  assert.equal(
    assetCandidateResolvesLive(graphOf([node]), 805, "model.safetensors", "seed"),
    true,
  );
  // Same shape, but the model widget's combo does NOT offer the file → kept.
  const missing = {
    id: 806,
    widgets: [
      { name: "seed", value: 42 },
      { name: "ckpt_name", value: "gone.safetensors", options: { values: ["model.safetensors"] } },
    ],
  };
  assert.equal(
    assetCandidateResolvesLive(graphOf([missing]), 806, "gone.safetensors", "seed"),
    false,
  );
});

test("assetCandidateResolvesLive: the widened clear path still needs a REAL file-carrying widget (no value, no clear)", () => {
  // No widget literally holds the file (still-referenced would have dropped the
  // candidate before this runs) — the fallback must not invent a clear.
  const node = {
    id: 807,
    widgets: [
      { name: "control_after_generate", value: "fixed", options: { values: ["fixed", "increment", "randomize"] } },
      { name: "upscale_model_name", value: "other.pth", options: { values: ["4x_foolhardy_Remacri.pth", "other.pth"] } },
    ],
  };
  assert.equal(
    assetCandidateResolvesLive(graphOf([node]), 807, "4x_foolhardy_Remacri.pth", "control_after_generate"),
    false,
  );
});

test("isStaleAssetCandidate: the FULL #569 panel_get_errors verdict — fixed widget-shift node unflags only once the combo is trusted", () => {
  const node = {
    id: 803,
    widgets: [
      { name: "control_after_generate", value: "fixed", options: { values: ["fixed", "increment", "randomize"] } },
      { name: "upscale_model_name", value: "4x_foolhardy_Remacri.pth", options: { values: ["4x_foolhardy_Remacri.pth", "other.pth"] } },
    ],
  };
  const candidate = { nodeId: 803, name: "4x_foolhardy_Remacri.pth", widgetName: "control_after_generate" };
  // Before the authoritative /object_info refresh the combo is NOT trusted: the
  // candidate is kept (fail-closed) — the refresh gate is what makes the verdict.
  assert.equal(isStaleAssetCandidate(graphOf([node]), candidate, { trustCombo: false }), false);
  // After the confirmed refresh the node's CURRENT widgets resolve the file → stale.
  assert.equal(isStaleAssetCandidate(graphOf([node]), candidate, { trustCombo: true }), true);
});

test("isStaleAssetCandidate: a genuinely-missing model still reports after a widget-shift repair attempt (#569 fail-closed)", () => {
  const node = {
    id: 804,
    widgets: [
      { name: "control_after_generate", value: "fixed", options: { values: ["fixed", "increment", "randomize"] } },
      { name: "upscale_model_name", value: "gone.pth", options: { values: ["other.pth"] } },
    ],
  };
  assert.equal(
    isStaleAssetCandidate(graphOf([node]), { nodeId: 804, name: "gone.pth", widgetName: "control_after_generate" }, { trustCombo: true }),
    false,
  );
});

// ---- #569 × #743: annotated values in the live-resolution check ---------------
test("assetCandidateResolvesLive: an [input]-annotated value resolves via its stripped bare name in the combo (#743 composition)", () => {
  // `foo.png [input]` resolves against the INPUT root — exactly the root the
  // loader combo enumerates — so the stripped bare name is combo-adjudicable.
  const node = {
    id: 9,
    widgets: [
      { name: "control_after_generate", value: "fixed", options: { values: ["fixed", "increment", "randomize"] } },
      { name: "image", value: "foo.png [input]", options: { values: ["foo.png", "bar.png"] } },
    ],
  };
  // …both via the widget that currently carries it (fallback path) …
  assert.equal(
    assetCandidateResolvesLive(graphOf([node]), 9, "foo.png [input]", "control_after_generate"),
    true,
  );
  // …and when the blame lands on the carrying widget itself (named path).
  assert.equal(assetCandidateResolvesLive(graphOf([node]), 9, "foo.png [input]", "image"), true);
});

test("assetCandidateResolvesLive: [output]/[temp]-annotated values are NEVER combo-resolved (left to the #743 server probe)", () => {
  // These resolve against the OUTPUT/TEMP roots, which the input combo does not
  // enumerate — a bare-name combo hit proves nothing, so the candidate must stay
  // flagged for the /view probe even though the bare name IS listed.
  const node = {
    id: 9,
    widgets: [
      { name: "control_after_generate", value: "fixed", options: { values: ["fixed", "increment", "randomize"] } },
      { name: "image", value: "foo.png [output]", options: { values: ["foo.png", "bar.png"] } },
    ],
  };
  assert.equal(
    assetCandidateResolvesLive(graphOf([node]), 9, "foo.png [output]", "control_after_generate"),
    false,
  );
  const temp = {
    id: 10,
    widgets: [{ name: "image", value: "foo.png [temp]", options: { values: ["foo.png"] } }],
  };
  assert.equal(assetCandidateResolvesLive(graphOf([temp]), 10, "foo.png [temp]", "image"), false);
  // A combo entry that LITERALLY ends with `[output]` is just a weird input-root
  // filename — it must NOT clear the annotated candidate: the value resolves as
  // `foo.png` in the OUTPUT root (folder_paths.annotated_filepath), on which the
  // input combo has no verdict. The candidate stays flagged for the /view probe.
  const literal = {
    id: 11,
    widgets: [{ name: "image", value: "foo.png [output]", options: { values: ["foo.png [output]"] } }],
  };
  assert.equal(assetCandidateResolvesLive(graphOf([literal]), 11, "foo.png [output]", "image"), false);
});

test("assetCandidateResolvesLive: a combo entry literally ending `[input]` is a weird filename, NOT proof the bare name exists", () => {
  // The value resolves as `foo.png` in the input root; a combo listing only the
  // literal `foo.png [input]` says nothing about `foo.png` — no clear.
  const node = {
    id: 12,
    widgets: [{ name: "image", value: "foo.png [input]", options: { values: ["foo.png [input]"] } }],
  };
  assert.equal(assetCandidateResolvesLive(graphOf([node]), 12, "foo.png [input]", "image"), false);
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

// ── #1193 — the sweep must rebuild the shape the backend actually ships ────────
//
// MEASURED against a live ComfyUI 0.33 /object_info (848 types): 61 combo inputs use the
// V1 `[[opt,...], config]` shape this file was written for, and 467 use V2
// `["COMBO", {options:[...]}]`. V2 is the MAJORITY, not an edge case — and it was walked
// past in silence while `completed` was still set, which granted #1193's disclosure and
// the shared combo-trust flag over lists that had never been touched.

/** V2, as ComfyUI 0.33 publishes it — confirmed against a live payload and against the
 *  widget the frontend builds from it (`options.values` is the array under `options`). */
const CKPT_DEF_V2 = (values) => ({
  input: { required: { ckpt_name: ["COMBO", { multiselect: false, options: values }] } },
});
/** V2 whose list is a SEPARATE fetch: the frontend shows "Loading…" and `options.values`
 *  is not an array at all. Nothing here can copy a list that has not arrived. */
const REMOTE_DEF_V2 = {
  input: { required: { image: ["COMBO", { image_upload: true, remote: { route: "/internal/files/output" } }] } },
};
/** V3 dynamic: the "options" are `{key, inputs}` objects that select SUB-INPUTS to
 *  materialize. The live widget does present the keys as its values, which is exactly why
 *  a naive rebuild here would look right and publish a list this file cannot honour. */
const DYNAMIC_DEF_V3 = {
  input: {
    required: {
      format: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "png", inputs: {} }, { key: "exr", inputs: {} }] }],
    },
  },
};

test("#1193 authoritativeComboValues reads V1 and V2, and refuses to guess at the rest", () => {
  assert.deepEqual(authoritativeComboValues([["a", "b"], {}]), ["a", "b"]);
  assert.deepEqual(authoritativeComboValues(["COMBO", { options: ["x", "y"] }]), ["x", "y"]);
  // Not a list this file can derive — each must be null, which is what makes the caller
  // count it as SKIPPED instead of as "nothing to do".
  assert.equal(authoritativeComboValues(["COMBO", { remote: { route: "/internal/files/output" } }]), null);
  assert.equal(authoritativeComboValues(["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "png" }] }]), null);
  assert.equal(authoritativeComboValues(["INT", { default: 20 }]), null);
  assert.equal(authoritativeComboValues("STRING"), null);
  assert.equal(authoritativeComboValues(null), null);
});

test("#1193 END TO END: a V2 combo is rebuilt, so a deleted model is still REPORTED missing", () => {
  // The failure this exists to stop, driven the whole way to its consequence. The user
  // deleted anime.safetensors; the backend no longer lists it; the live widget still does
  // because it was populated at page load. If the sweep walks past a V2 combo while the
  // panel claims the lists were rebuilt, `assetCandidateResolvesLive` finds the file in
  // that stale list and the missing-model candidate is SUPPRESSED — the user loses the
  // warning. Fails on the pre-fix code at both the rebuild and the suppression.
  const node = {
    id: 1,
    type: "CheckpointLoaderSimple",
    widgets: [{ name: "ckpt_name", value: "anime.safetensors", options: { values: ["anime.safetensors", "sd15.ckpt"] } }],
    constructor: {},
  };
  const graph = graphOf([node]);
  const stats = {};
  reapplyDefsToLiveNodes(graph, { CheckpointLoaderSimple: CKPT_DEF_V2(["sd15.ckpt"]) }, stats);

  assert.equal(stats.combosRebuilt, 1, "a V2 combo must be rebuilt, not walked past");
  assert.equal(stats.combosSkipped ?? 0, 0);
  assert.equal(comboRebuildCovered(stats), true);
  assert.deepEqual(node.widgets[0].options.values, ["sd15.ckpt"], "the deleted file is gone from the live list");

  const candidate = { nodeId: 1, name: "anime.safetensors", widgetName: "ckpt_name", isMissing: true };
  assert.equal(
    assetCandidateResolvesLive(graph, 1, "anime.safetensors", "ckpt_name"),
    false,
    "the rebuilt list must no longer offer the deleted file",
  );
  assert.equal(
    isStaleAssetCandidate(graph, candidate, { trustCombo: true }),
    false,
    "a genuinely missing model must survive the scan — suppressing it is the one direction this must never fail in",
  );
});

test("#1193 a combo the sweep CANNOT rebuild is counted, and withdraws the claim", () => {
  // Remote V2 and dynamic V3: real shapes from the same live payload (1 and 120 inputs
  // across 848 types). Neither can be rebuilt from the payload alone, so the sweep must
  // say so rather than finish quietly — `completed` is true in both cases, and it is
  // `combosSkipped` that keeps `comboRebuildCovered` false.
  const remote = {
    id: 1,
    type: "LoadImageOutput",
    // The frontend leaves `values` undefined until the separate fetch lands, so the LIVE
    // widget gives no signal at all here — only the spec does. That is why the skip test
    // asks two independent questions instead of one.
    widgets: [{ name: "image", value: "Loading...", options: {} }],
    constructor: {},
  };
  const remoteStats = {};
  reapplyDefsToLiveNodes(graphOf([remote]), { LoadImageOutput: REMOTE_DEF_V2 }, remoteStats);
  assert.equal(remoteStats.completed, true, "the walk did finish");
  assert.equal(remoteStats.combosSkipped, 1, "…and it must record the combo it could not rebuild");
  assert.equal(comboRebuildCovered(remoteStats), false, "a finished sweep that skipped a combo has NOT covered the graph");

  const dynamic = {
    id: 2,
    type: "SaveImageAdvanced",
    widgets: [{ name: "format", value: "png", options: { values: ["png", "exr"] } }],
    constructor: {},
  };
  const dynamicStats = {};
  reapplyDefsToLiveNodes(graphOf([dynamic]), { SaveImageAdvanced: DYNAMIC_DEF_V3 }, dynamicStats);
  assert.equal(dynamicStats.combosSkipped, 1);
  assert.equal(comboRebuildCovered(dynamicStats), false);
  assert.deepEqual(dynamic.widgets[0].options.values, ["png", "exr"], "and it is left alone, not half-rebuilt");
});

test("#1193 a combo the SPEC does not announce is still caught by the live widget", () => {
  // The forward-compatible arm of the skip test, and the only one with no example on the
  // installs sampled for this fix — every unrebuildable shape there (remote V2, dynamic
  // V3) says COMBO in its type string. That is exactly why it is pinned: the arm exists
  // for the shape published AFTER this was written, and a shape nobody has seen yet cannot
  // be relied on to name itself. Deleting it is invisible to every other test here.
  //
  // The failure it prevents is the silent one: a widget presenting a stale option list,
  // walked past, and the graph then reported as covered.
  const node = {
    id: 1,
    type: "SomePack.FutureLoader",
    widgets: [{ name: "model_name", value: "deleted.safetensors", options: { values: ["deleted.safetensors"] } }],
    constructor: {},
  };
  const stats = {};
  reapplyDefsToLiveNodes(
    graphOf([node]),
    { "SomePack.FutureLoader": { input: { required: { model_name: ["MODEL_NAME_V4", { options_url: "/x" }] } } } },
    stats,
  );
  assert.equal(stats.combosSkipped, 1, "a live widget presenting an option array is a combo, whatever the spec calls itself");
  assert.equal(comboRebuildCovered(stats), false);
  assert.deepEqual(node.widgets[0].options.values, ["deleted.safetensors"], "and it is left alone rather than guessed at");

  // …while a genuine non-combo input is NOT a skip: an INT widget carries min/max/step and
  // no values array, and counting it would withdraw the claim on every graph in existence.
  const plain = {
    id: 2,
    type: "KSampler",
    widgets: [{ name: "steps", value: 20, options: { min: 1, max: 100 } }],
    constructor: {},
  };
  const plainStats = {};
  reapplyDefsToLiveNodes(graphOf([plain]), { KSampler: { input: { required: { steps: ["INT", { default: 20 }] } } } }, plainStats);
  assert.equal(plainStats.combosSkipped ?? 0, 0);
  assert.equal(comboRebuildCovered(plainStats), true);
});

test("#1193 a function-valued option source is NOT a skip", () => {
  // It derives its own list and `assetCandidateResolvesLive` INVOKES it, so it is never
  // stale for want of a rebuild. Counting it would withdraw the claim on every graph that
  // has one, which is how a safety counter turns into a permanently-off switch.
  const node = {
    id: 1,
    type: "CheckpointLoaderSimple",
    widgets: [{ name: "ckpt_name", value: "a", options: { values: () => ["live.safetensors"] } }],
    constructor: {},
  };
  const stats = {};
  reapplyDefsToLiveNodes(graphOf([node]), { CheckpointLoaderSimple: CKPT_DEF_V2(["live.safetensors"]) }, stats);
  assert.equal(stats.combosSkipped ?? 0, 0);
  assert.equal(comboRebuildCovered(stats), true);
  assert.equal(typeof node.widgets[0].options.values, "function", "the dynamic source is left intact");
});

test("#1193 comboRebuildCovered needs BOTH facts, and treats absence as unknown", () => {
  assert.equal(comboRebuildCovered({ completed: true, combosSkipped: 0 }), true);
  assert.equal(comboRebuildCovered({ completed: true }), true, "nothing skipped is the absence of the counter");
  assert.equal(comboRebuildCovered({ completed: true, combosSkipped: 1 }), false);
  assert.equal(comboRebuildCovered({ completed: false, combosSkipped: 0 }), false);
  assert.equal(comboRebuildCovered({}), false);
  assert.equal(comboRebuildCovered(null), false, "a sweep that never ran has covered nothing");
  // Never truthy-by-accident: a stats object that reports completion some other way must
  // not slip through.
  assert.equal(comboRebuildCovered({ completed: "yes", combosSkipped: 0 }), false);
});

test("#1193 the sweep REPORTS what it rebuilt, and only claims completion after the whole walk", () => {
  // The contract #1193's combo phase reads. `completed` is what licenses the panel to say
  // the live lists are current without waiting for the frontend's own refreshComboInNodes,
  // so it must be set by the sweep itself — never inferred from the fact that it was called.
  const nodes = [
    { id: 1, type: "CheckpointLoaderSimple", widgets: [{ name: "ckpt_name", value: "a", options: { values: [] } }], constructor: {} },
    { id: 2, type: "CheckpointLoaderSimple", widgets: [{ name: "ckpt_name", value: "a", options: { values: [] } }], constructor: {} },
  ];
  const stats = {};
  reapplyDefsToLiveNodes(graphOf(nodes), { CheckpointLoaderSimple: CKPT_DEF(["a.safetensors", "b.safetensors"]) }, stats);
  assert.equal(stats.completed, true);
  assert.equal(stats.nodesSwept, 2);
  assert.equal(stats.combosRebuilt, 2, "one combo widget rebuilt per node");
  assert.deepEqual(nodes[0].widgets[0].options.values, ["a.safetensors", "b.safetensors"]);

  // A sweep that stops part way must NOT claim completion. `_nodes` is a getter that
  // throws on the second graph, which is a failure the sweep swallows by design — the
  // point is that swallowing it cannot look like success to the caller.
  const good = graphOf([{ id: 3, type: "CheckpointLoaderSimple", widgets: [], constructor: {} }]);
  const exploding = { get _nodes() { throw new Error("graph went away mid-sweep"); } };
  const root = {
    _nodes: [{ id: 4, type: "Sub", subgraph: exploding }, ...good._nodes],
    getNodeById: () => null,
  };
  const partial = {};
  reapplyDefsToLiveNodes(root, { CheckpointLoaderSimple: CKPT_DEF(["a.safetensors"]) }, partial);
  assert.notEqual(partial.completed, true, "a sweep that threw part way must leave completion unclaimed");

  // No stats object at all is still supported — the argument is optional and every other
  // caller passes two arguments.
  assert.doesNotThrow(() => reapplyDefsToLiveNodes(good, { CheckpointLoaderSimple: CKPT_DEF(["a.safetensors"]) }));

  // #1193 — NO PAYLOAD is not a completed sweep. The panel's only call site sits inside
  // `if (defs)`, so this early return is unreachable from production today; it is pinned
  // anyway because that is a property of the CALL SITE, one refactor from changing, and
  // the failure it would cause is the silent one: `completed` claimed over a graph the
  // sweep never looked at. A mutation setting the flag above this return survived the
  // gate's run for exactly that reason.
  const noDefs = {};
  reapplyDefsToLiveNodes(good, null, noDefs);
  assert.notEqual(noDefs.completed, true, "a sweep with no payload has not covered anything");
  assert.equal(comboRebuildCovered(noDefs), false);
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
  assert.equal(
    graphErrorsResultIsClean({
      errored_count: 0,
      node_errors: null,
      last_execution_error: null,
      stale_flags: [{ id: 5, red_outline: true }],
    }),
    true,
    "a source-free visual outline is an informational stale flag, not an error",
  );
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

test("graphErrorsResultIsClean: FALSE for an unavailable_widget_values-ONLY result (#984)", () => {
  // Measured on a live install before the fix: a CheckpointLoader whose `config_name`
  // named an absent models/configs .yaml. No missing-MODEL store adjudicates that
  // folder, so every load-time surface was empty while the #745 live scan found it —
  // and the payload carried the finding AND "Checked errors — none".
  assert.equal(
    graphErrorsResultIsClean({
      errored_count: 0,
      node_errors: null,
      last_execution_error: null,
      unavailable_widget_values: [
        {
          id: 1,
          type: "CheckpointLoader",
          widget: "config_name",
          value: "totally_absent_config.yaml",
          kind: "missing_asset",
        },
      ],
    }),
    false,
  );
  // The other kind the scan reports is just as fatal at queue time — a value outside
  // the options the server publishes — so it must not be treated as cosmetic either.
  assert.equal(
    graphErrorsResultIsClean({
      unavailable_widget_values: [{ id: 2, widget: "sampler_name", value: "nope", kind: "invalid_value" }],
    }),
    false,
  );
  assert.equal(graphErrorsResultIsClean({ unavailable_widget_values: [] }), true, "an empty list is still clean");
});

test("#984 (codex): the two detection halves finding the SAME defect count ONCE", () => {
  // Measured on a live install: three absent UNET files appeared in BOTH the load-time
  // missingModel store and the #745 live scan. Adding the lists claimed six findings
  // for three problems — two corroborating signals, not two defects.
  const counts = graphErrorsFindingCounts({
    missing_models: [
      { node_id: 1, file: "a.safetensors", widget: "unet_name" },
      { node_id: 2, file: "b.safetensors", widget: "unet_name" },
    ],
    unavailable_widget_values: [
      { id: 1, widget: "unet_name", value: "a.safetensors", kind: "missing_asset" },
      { id: 2, widget: "unet_name", value: "b.safetensors", kind: "missing_asset" },
    ],
  });
  assert.equal(counts.missingAssets, 2);
  assert.equal(counts.unavailable, 0, "both halves saw the same two files — nothing extra to report");
});

test("#984 (codex): a live-scan finding the load-time half MISSED is still counted", () => {
  // The whole reason the live scan exists. CheckpointLoader.config_name is the measured
  // case: no missing-MODEL store adjudicates models/configs, so this is the only report.
  const counts = graphErrorsFindingCounts({
    missing_models: [{ node_id: 1, file: "a.safetensors", widget: "unet_name" }],
    unavailable_widget_values: [
      { id: 1, widget: "unet_name", value: "a.safetensors", kind: "missing_asset" }, // dup
      { id: 7, widget: "config_name", value: "totally_absent_config.yaml", kind: "missing_asset" },
    ],
  });
  assert.equal(counts.missingAssets, 1);
  assert.equal(counts.unavailable, 1, "the config_name finding is new information");
});

test("#984 (codex): overlap is detected even when the store entry omits `widget`", () => {
  const counts = graphErrorsFindingCounts({
    missing_media: [{ node_id: 3, file: "in.png" }], // no widget recorded
    unavailable_widget_values: [{ id: 3, widget: "image", value: "in.png", kind: "missing_asset" }],
  });
  assert.equal(counts.unavailable, 0, "the (node, file) join still catches it");
});

test("#984 (codex): an unjoinable live-scan entry is counted rather than silently dropped", () => {
  const counts = graphErrorsFindingCounts({
    missing_models: [{ node_id: 1, file: "a.safetensors" }],
    unavailable_widget_values: [{ widget: "unet_name", value: "a.safetensors" }], // no id
  });
  assert.equal(counts.unavailable, 1, "no identity to join on ⇒ report it, never assume a duplicate");
});

test("#984 (codex): node-type surfaces have no widget identity and are never deduped away", () => {
  const counts = graphErrorsFindingCounts({
    missing_node_types: ["RIFEInterpolation"],
    missing_node_count: 2,
    errored_count: 4,
  });
  assert.equal(counts.missingAssets, 3, "1 type + a count of 2");
  assert.equal(counts.erroredNodes, 4);
  assert.equal(counts.unavailable, 0);
});

test("#984 (codex): `unchecked` is reported but is never a finding", () => {
  const counts = graphErrorsFindingCounts({ unchecked_nodes: [{ id: 9 }, { id: 10 }] });
  assert.equal(counts.unchecked, 2);
  assert.equal(counts.missingAssets, 0);
  assert.equal(counts.unavailable, 0);
  assert.equal(counts.erroredNodes, 0);
});

test("#1357: `unchecked` counts NODES, because that is what the pill says", () => {
  // Since #1357 one node can contribute several entries — a widget value the
  // server's combo has no authority over is abstained on per VALUE. The pill reads
  // "{count} nodes could not be checked", so three nested LoadImage paths on node 4
  // must not render as "3 nodes".
  const counts = graphErrorsFindingCounts({
    unchecked_nodes: [
      { id: 4, type: "LoadImage", widget: "image", value: "a/1.png", reason: "not checked: x" },
      { id: 4, type: "LoadImage", widget: "image2", value: "a/2.png", reason: "not checked: x" },
      { id: 4, type: "LoadImage", widget: "image3", value: "a/3.png", reason: "not checked: x" },
      { id: 9, type: "SomePackNode", reason: "node type not found in /object_info" },
    ],
  });
  assert.equal(counts.unchecked, 2, "node 4 once, node 9 once");
  assert.equal(counts.unavailable, 0, "an abstention is still never a finding");
});

test("#1357: an id-less unchecked entry is counted, never merged away", () => {
  // Collapsing every `{id: undefined}` into one bucket would UNDER-report, which is
  // the wrong direction for a count whose whole job is to say "I did not look here".
  const counts = graphErrorsFindingCounts({
    unchecked_nodes: [{ reason: "a" }, { reason: "b" }, { id: null, reason: "c" }],
  });
  assert.equal(counts.unchecked, 3);
  // A numeric and a string id for the same node are one node, not two.
  assert.equal(
    graphErrorsFindingCounts({ unchecked_nodes: [{ id: 7 }, { id: "7" }] }).unchecked,
    1,
  );
});

test("#984: the overlap join is injective — a concatenation collision cannot swallow a finding", () => {
  // Without a field separator, (node "1", file "23") and (node "12", file "3") produce
  // the same key, and a real live-scan finding is silently deduped away as a phantom
  // duplicate. Suppressing a finding is the exact failure this whole issue is about.
  const counts = graphErrorsFindingCounts({
    missing_models: [{ node_id: "1", file: "23" }],
    unavailable_widget_values: [{ id: "12", value: "3", kind: "missing_asset" }],
  });
  assert.equal(counts.unavailable, 1, "different (node, file) pairs must not collide into one key");
});

test("#984 (codex r2): a filename containing the separator BYTE cannot forge a duplicate", () => {
  // A delimiter is not an encoding, whichever byte it is — a POSIX filename may contain
  // 0x1f, so `(node 1, file "x\x1fy")` and `(node 1, widget "x", value "y")` keyed the
  // same and the live finding vanished. The fields are escaped now, not just separated.
  // The collision must be built WITHIN one key shape, or the shape tag masks it — the
  // first version of this test put the two entries in different shapes and passed
  // against the broken join, proving nothing. Here both sides key as (node, widget,
  // file): the store's widget "x" + file "y<SEP>z" and the live entry's widget
  // "x<SEP>y" + value "z" delimit to the same string.
  const SEP = String.fromCharCode(31); // built, never written literally into source
  const counts = graphErrorsFindingCounts({
    missing_models: [{ node_id: "1", widget: "x", file: `y${SEP}z` }],
    unavailable_widget_values: [{ id: "1", widget: `x${SEP}y`, value: "z", kind: "missing_asset" }],
  });
  assert.equal(counts.unavailable, 1, "a control byte inside a field must not forge a key collision");
});

test("#984 (codex r2): a store miss on ONE widget does not swallow a live finding on ANOTHER", () => {
  // Same node, same filename, different widgets — genuinely two faults. The first
  // version added the widget-less key unconditionally, so the store's `unet_name` miss
  // absorbed the live scan's distinct `config_name` finding.
  const counts = graphErrorsFindingCounts({
    missing_models: [{ node_id: 1, file: "shared.safetensors", widget: "unet_name" }],
    unavailable_widget_values: [
      { id: 1, widget: "unet_name", value: "shared.safetensors", kind: "missing_asset" },
      { id: 1, widget: "config_name", value: "shared.safetensors", kind: "invalid_value" },
    ],
  });
  assert.equal(counts.missingAssets, 1);
  assert.equal(counts.unavailable, 1, "only the widget the store actually named is absorbed");
});

test("#984 (codex r2): a store entry with NO widget still absorbs any widget on that node", () => {
  // The other direction: with no widget recorded there is no identity to tell the
  // node's widgets apart, so the store entry has to be allowed to cover them.
  const counts = graphErrorsFindingCounts({
    missing_media: [{ node_id: 3, file: "in.png" }],
    unavailable_widget_values: [{ id: 3, widget: "image", value: "in.png", kind: "missing_asset" }],
  });
  assert.equal(counts.unavailable, 0);
});

test("#984 (codex r2): a subgraph LOCATOR and a bare id are kept apart, deliberately", () => {
  // The two producers do not canonicalize locators between them. Treating
  // "<uuid>:7" and 7 as the same node would merge findings on different nodes;
  // keeping them apart over-reports at worst. Over-reporting is the safe direction.
  const counts = graphErrorsFindingCounts({
    missing_models: [{ node_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890:7", file: "m.safetensors" }],
    unavailable_widget_values: [{ id: 7, widget: "unet_name", value: "m.safetensors" }],
  });
  assert.equal(counts.unavailable, 1);
});

test("#984: graphErrorsFindingCounts is total — a malformed or absent result yields zeroes", () => {
  for (const bad of [null, undefined, 42, "x", {}, { missing_models: "nope", unavailable_widget_values: 7 }]) {
    const c = graphErrorsFindingCounts(bad);
    assert.deepEqual(c, { erroredNodes: 0, missingAssets: 0, unavailable: 0, unchecked: 0 });
  }
});

test("#984 source guard: graph_get_errors' own `clean` folds in the live scan", () => {
  // The helper above governs the SUMMARY LABEL. The `note: "no errors recorded…"` in
  // the payload comes from a separate `clean` expression inside the monolith's
  // executor, which is not importable — and it is the one that produced the
  // self-contradicting payload. Both must fold in the live scan or the contradiction
  // simply moves. Deleting either half fails here.
  const panelSrc = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const cleanExpr = /const clean =([\s\S]{0,600}?);/.exec(panelSrc)?.[1] ?? "";
  assert.ok(cleanExpr.length > 0, "the `clean` expression must still exist to be checked");
  assert.match(cleanExpr, /!liveScan\?\.unavailable\?\.length/, "`clean` must account for the live scan (#984)");
  for (const surface of ["missingModels", "missingMedia", "missingNodeTypes", "missingNodeCount", "stalePlaceholders"]) {
    assert.match(cleanExpr, new RegExp(`!${surface}`), `the #399/#1332 surfaces must survive: ${surface}`);
  }
  // The summary now derives every count from the shared helper above, which is tested
  // BEHAVIOURALLY. This only pins that the label is wired to it — codex was right that
  // a source regex cannot prove the wiring, so the regex is kept as thin as possible
  // and the real assertions live on the importable helper.
  assert.match(
    panelSrc,
    /const counts = graphErrorsFindingCounts\(r\);/,
    "the summary label must count through the deduping helper, not by adding the lists",
  );
  assert.ok(
    !/\(r\.missing_models\?\.length \|\| 0\) \+/.test(panelSrc),
    "the old hand-rolled summing must not reappear — it double-counted the overlap",
  );
});

test("graphErrorsResultIsClean: unchecked_nodes alone does NOT make a result dirty (#984 scope)", () => {
  // The scan reports what it could not judge on almost every call. Treating that as an
  // error would make "Checked errors — none" unreachable on a normal canvas, which is
  // a different lie. Only what the scan positively FOUND counts.
  assert.equal(
    graphErrorsResultIsClean({ unchecked_nodes: [{ id: 9, type: "SomePack" }], unchecked_budget_exhausted: true }),
    true,
  );
});

test("graphErrorsResultIsClean: FALSE for raw validation / execution errors", () => {
  assert.equal(graphErrorsResultIsClean({ node_errors: { 3: { errors: [] } } }), false);
  assert.equal(graphErrorsResultIsClean({ last_execution_error: { node_id: 5 } }), false);
  assert.equal(graphErrorsResultIsClean({ errored_count: 2 }), false);
});

test("#1332 graphErrorsResultIsClean: FALSE for leftover placeholders after a class registered", () => {
  // The type is no longer missing, but the already-placed node is still dead.
  // Labelling that "none" is the #981 lie this issue must not re-open.
  assert.equal(
    graphErrorsResultIsClean({
      stale_placeholders: [{ node_id: "12", type: "easy stylesSelector" }],
      requires_reload: true,
    }),
    false,
  );
  assert.equal(graphErrorsResultIsClean({ requires_reload: true }), false);
});

test("#1332 graphErrorsFindingCounts: stale placeholders count as findings, not as missing types", () => {
  const counts = graphErrorsFindingCounts({
    missing_node_types: ["GetImageSize+"],
    stale_placeholders: [
      { node_id: "2", type: "easy stylesSelector" },
      { node_id: "3", type: "easy showAnything" },
    ],
  });
  assert.equal(counts.missingAssets, 3, "the still-missing type AND the two leftovers");
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

test("#579 source-free LiteGraph outlines are warnings, not graph errors", () => {
  const nodes = [
    { id: 1, has_errors: true, type: "FastFilmGrain" },
    { id: 2, has_errors: true, type: "KSampler" },
    { id: 3, has_errors: false, type: "VAEDecode" },
  ];
  const reasons = new Map([["2", [{ kind: "missing_model" }]]]);

  assert.deepEqual(
    collectUnexplainedRedOutlines(nodes, reasons, { nodeErrors: null, lastExecFailure: null }).map((n) => n.id),
    [1],
    "only an unexplained red outline with no run error source is stale",
  );
  assert.deepEqual(
    collectUnexplainedRedOutlines(nodes, reasons, { nodeErrors: { 9: { errors: [{ message: "bad" }] } } }),
    [],
    "a live validation source retains conservative error classification",
  );
  assert.deepEqual(
    collectUnexplainedRedOutlines(nodes, reasons, { lastExecFailure: { node_id: 9 } }),
    [],
    "a live execution source retains conservative error classification",
  );
});

test("combineNodeErrorMaps: an empty app map never masks a live execution-store validation error (#579 P1)", () => {
  const storeError = { message: "checkpoint is not installed" };
  const combined = combineNodeErrorMaps([
    {}, // app.lastNodeErrors may be reset immediately after the rejection
    { 41: { errors: [storeError] } },
  ]);
  assert.deepEqual(combined, { 41: { errors: [storeError] } });
  assert.deepEqual(
    combineNodeErrorMaps([{ 41: { errors: [] } }, { 41: { errors: [storeError] } }]),
    { 41: { errors: [storeError] } },
    "an empty entry for the same node also cannot overwrite the store's live error",
  );
  assert.deepEqual(
    collectUnexplainedRedOutlines([{ id: 8, has_errors: true }], new Map(), { nodeErrors: combined }),
    [],
    "a live store validation source keeps a red outline conservatively classified as an error",
  );
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

// ---- #516: native subgraph conversion rewires direct root neighbours -------
test("collectLinkedNeighborNodeIds finds every direct neighbour after a native subgraph conversion (#516)", () => {
  // Wrapper input link: LoadImage (7) → wrapper; wrapper output link: wrapper → SaveImage (9).
  // A second output uses the serialized tuple shape present in some LiteGraph paths.
  const wrapper = {
    inputs: [{ link: 11 }],
    outputs: [{ links: [12, 13] }],
  };
  const links = new Map([
    [11, { origin_id: 7, target_id: 100 }],
    [12, { origin_id: 100, target_id: 9 }],
    [13, [13, 100, 1, "uuid-target", 0, "IMAGE"]],
  ]);
  assert.deepEqual(
    [...collectLinkedNeighborNodeIds(wrapper, links)].sort(),
    [7, 9, "uuid-target"].sort(),
  );
});

test("collectLinkedNeighborNodeIds fails closed on malformed link storage (#516)", () => {
  const wrapper = { inputs: [{ link: 1 }], outputs: [{ links: [2] }] };
  assert.deepEqual([...collectLinkedNeighborNodeIds(wrapper, null)], []);
  assert.deepEqual([...collectLinkedNeighborNodeIds(null, {})], []);
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

// ── #1172: the reapply sweep must REBUILD combo options, and empty lists must be disclosed ──

const CKPT_DEF = (values) => ({ input: { required: { ckpt_name: [values, {}] } } });

test("#1172 the reapply sweep repopulates a combo whose option list is empty", () => {
  // The reported bug. panel_add_node builds the widget from the REGISTERED nodeData, so a
  // newly added CheckpointLoaderSimple starts with `values: []`. The sweep stamped nodeData
  // and reconciled UNKNOWN names but never touched options.values, leaving the node unusable
  // while refresh_nodes answered `refreshed: true`.
  const node = {
    id: 1,
    type: "CheckpointLoaderSimple",
    widgets: [{ name: "ckpt_name", value: "", options: { values: [] } }],
    constructor: {},
  };
  reapplyDefsToLiveNodes(graphOf([node]), { CheckpointLoaderSimple: CKPT_DEF(["anime.safetensors", "sd15.ckpt"]) });
  assert.deepEqual(node.widgets[0].options.values, ["anime.safetensors", "sd15.ckpt"]);
});

test("#1172 the rebuild reaches nodes inside SUBGRAPHS", () => {
  // collectAllGraphs already walks them; the rebuild rides the same sweep, so a promoted
  // inner node must be repaired too rather than silently skipped.
  const inner = { id: 2, type: "CheckpointLoaderSimple", widgets: [{ name: "ckpt_name", options: { values: [] } }], constructor: {} };
  const root = graphOf([{ id: 1, type: "Host", subgraph: { _nodes: [inner] } }]);
  reapplyDefsToLiveNodes(root, { CheckpointLoaderSimple: CKPT_DEF(["a.safetensors"]) });
  assert.deepEqual(inner.widgets[0].options.values, ["a.safetensors"]);
});

test("#1172 a DYNAMIC (function) option source is never clobbered", () => {
  // #507/#1133 hazard: a client-populated combo derives its own list. Overwriting it with the
  // backend's array would break exactly the nodes #1133 is making writable.
  const dynamic = () => ["computed"];
  const node = { id: 3, type: "CheckpointLoaderSimple", widgets: [{ name: "ckpt_name", options: { values: dynamic } }], constructor: {} };
  reapplyDefsToLiveNodes(graphOf([node]), { CheckpointLoaderSimple: CKPT_DEF(["a.safetensors"]) });
  assert.equal(node.widgets[0].options.values, dynamic, "a function source must survive the sweep");
});

test("#1172 emptyComboListsOnGraph reports only EMPTY lists, and only for types on the graph", () => {
  const node = { id: 1, type: "CheckpointLoaderSimple", widgets: [], constructor: {} };
  const defs = {
    CheckpointLoaderSimple: CKPT_DEF([]),
    // present in the payload but NOT on the graph — the backend may publish dozens of empty
    // combos for packs the user is not using, and reporting those buries the one that matters.
    SomeOtherLoader: { input: { required: { other_name: [[], {}] } } },
  };
  assert.deepEqual(emptyComboListsOnGraph(graphOf([node]), defs), [
    { type: "CheckpointLoaderSimple", widget: "ckpt_name" },
  ]);
});

test("#1172 FALSE-POSITIVE FLOOR: a populated list discloses nothing", () => {
  // If this ever goes red the disclosure fires on every refresh and is worthless.
  const node = { id: 1, type: "CheckpointLoaderSimple", widgets: [], constructor: {} };
  assert.deepEqual(emptyComboListsOnGraph(graphOf([node]), { CheckpointLoaderSimple: CKPT_DEF(["a.safetensors"]) }), []);
  // A non-combo input (a type string, not an option array) is not an empty combo either.
  assert.deepEqual(
    emptyComboListsOnGraph(graphOf([node]), { CheckpointLoaderSimple: { input: { required: { steps: ["INT", { default: 20 }] } } } }),
    [],
  );
  assert.deepEqual(emptyComboListsOnGraph(graphOf([node]), null), []);
  assert.deepEqual(emptyComboListsOnGraph(null, { CheckpointLoaderSimple: CKPT_DEF([]) }), []);
});

test("#1172 the note points at the BACKEND, never at another refresh", () => {
  // The wrong-remedy failure this repo keeps removing: telling the agent to re-run the very
  // command that just answered. The refresh worked; the server's answer is what is empty.
  const note = emptyComboNote([{ type: "CheckpointLoaderSimple", widget: "ckpt_name" }]);
  assert.match(note, /CheckpointLoaderSimple\.ckpt_name/);
  assert.match(note, /this empty list is what \/object_info answered/i);
  // …and nothing about the PANEL's internals: the disclosure is built from the payload alone,
  // so a clause about what the panel did or did not skip overstates what it can establish.
  assert.doesNotMatch(note, /panel (skipped|failed|missed)/i, "no claim about panel internals");
  // …and it must NOT predict what a later refresh will return: a second /object_info read can
  // observe changed server state, so that clause was a prediction dressed as an observation.
  assert.doesNotMatch(note, /refresh(ing)? again (returns|will return)/i, "no prediction about another command");
  assert.doesNotMatch(note, /panel_refresh_nodes|try refreshing|refresh the nodes again/i);
  assert.equal(emptyComboNote([]), "");
  assert.equal(emptyComboNote(null), "");
});

test("#1172 the note NAMES NO CAUSE and does not predict another command's outcome", () => {
  // #756's rule, applied to this note. A first version broke it twice: it inferred "the
  // backend is not finding it — check model paths, then restart", and it asserted "setting
  // one of these widgets will be refused". The second is FALSE — set-widget.js treats an
  // authoritative empty list as unknowable and PERFORMS the write with empty_option_list
  // (#507/#1133) — and would have talked an agent out of a write that succeeds.
  const note = emptyComboNote([{ type: "CheckpointLoaderSimple", widget: "ckpt_name" }]);
  assert.doesNotMatch(note, /model path|restart ComfyUI|not finding|missing/i, "no inferred cause");
  assert.doesNotMatch(note, /will be refused|cannot be set|must not be set/i, "no false refusal claim");
  // …and it must say the true thing about writes, so the agent is not left guessing.
  assert.match(note, /still permitted/i);
  assert.match(note, /empty_option_list/);
  // The one inference that IS supportable: the refresh is not what is empty.
  assert.match(note, /NOT established here/);
});

test("#1172 WIRING: the disclosure survives the `refreshed: true` branch (#981's hole)", () => {
  // That branch returns a FIXED object literal, so a field the verdict carries but the
  // whitelist does not name is dropped on exactly the successful path where it matters.
  // #981 fell into this hole at this same line; a verdict-only change would look correct in
  // every unit test and report nothing to the agent.
  const src = readFileSync(PANEL_JS, "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.match(code, /verdict\.empty_combo_lists = empties;/, "the verdict must carry the field");
  assert.match(
    code,
    /if \(refreshed\) return \{ ok: true, refreshed: true, \.\.\.stale, \.\.\.emptyCombos, \.\.\.restored, \.\.\.comboUnconfirmed \};/,
    "…and the refreshed:true branch must forward it (#1275's restored disclosure and #1193's " +
      "unconfirmed-combo disclosure ride the same branch)",
  );
  // The spread alone is not enough: `emptyCombos` could still be built without the list
  // itself, forwarding only the note. Pin BOTH fields of the mapping.
  assert.match(code, /empty_combo_lists: verdict\.empty_combo_lists,/, "the list must be mapped");
  assert.match(code, /empty_combo_lists_note: verdict\.empty_combo_lists_note,/, "…and the note");
  // #1133: an empty list must never flip the verdict to failed — that would re-refuse via the
  // verdict what #1133 deliberately permits via the write path.
  assert.doesNotMatch(code, /empty_combo_lists[\s\S]{0,200}?refreshed = false/, "disclosure, not failure");
});
