/**
 * #2192 — `panel_get_errors` kept echoing a validation error for a link that had
 * already been repaired.
 *
 * The reporter rewired an `ImpactSwitch.select` (INT) inside a subgraph. Mid-rewire it
 * was briefly fed by an IMAGE node, ComfyUI rejected the queue, and the frontend stored
 * that rejection in `app.lastNodeErrors`. They then fixed the wire and confirmed the fix
 * with `panel_query_graph`. Every subsequent `panel_get_errors` — twice in a row, after a
 * save, and again from root scope — still shipped:
 *
 *     "errored_count": 0,
 *     "node_errors": { "249:252": { errors: [{ type: "return_type_mismatch",
 *       details: "select, received_type(IMAGE) mismatch input_type(INT)",
 *       extra_info: { input_name: "select", linked_node: ["249:265", 0] } }] } }
 *
 * Two halves to that. The map is only replaced on the NEXT queue attempt, so a repaired
 * graph never clears it; and its key is a SCOPED locator that never string-equals a
 * visible node's own id, so the entry reached no per-node reason either — which is how a
 * populated `node_errors` came to ship beside `errored_count: 0` in one payload.
 *
 * These tests drive the SHIPPED `graph_get_errors` (via the production-path harness) on
 * the reporter's exact shapes, plus the pure classifier's fail-open paths.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  pruneContradictedNodeErrors,
  pruneContradictedNodeErrorMaps,
} from "../../web/js/lib/asset-staleness.js";
import { runProductionGraphGetErrors } from "./_graph-get-errors-harness.mjs";
import { runProductionValidationBanner } from "./_validation-banner-harness.mjs";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

// ── the reporter's graph ────────────────────────────────────────────────────────
// root: [249 = subgraph host] · inside 249: 251 (INT source), 265 (IMAGE source),
// 252 (ImpactSwitch, whose `select` input is now fed by 251).

const SELECT_MISMATCH = {
  type: "return_type_mismatch",
  message: "Return type mismatch between linked nodes",
  details: "select, received_type(IMAGE) mismatch input_type(INT)",
  extra_info: {
    input_name: "select",
    received_type: "IMAGE",
    linked_node: ["249:265", 0],
  },
};

/** A LiteGraph-shaped graph: `_nodes`, `getNodeById`, and a link store keyed by id. */
function makeGraph({ id, nodes, links = {} }) {
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const graph = {
    id,
    _nodes: nodes,
    links,
    getNodeById: (nid) => byId.get(String(nid)) ?? null,
  };
  for (const n of nodes) n.graph = graph;
  return graph;
}

/**
 * `select` fed by `originId` (or by nothing when null). Link id 900 is the live wire;
 * the error above names 265, so origin 251 is the REPAIRED state and 265 the broken one.
 */
function reporterGraphs({ originId = "251", selectInputName = "select" } = {}) {
  const impactSwitch = {
    id: 252,
    type: "ImpactSwitch",
    inputs: [
      { name: "input1", type: "IMAGE", link: null },
      { name: selectInputName, type: "INT", link: originId == null ? null : 900 },
    ],
  };
  const inner = makeGraph({
    id: "249",
    nodes: [{ id: 251, type: "ImpactInt" }, { id: 265, type: "PreviewImage" }, impactSwitch],
    links: originId == null ? {} : { 900: { id: 900, origin_id: originId, origin_slot: 0, target_id: 252, target_slot: 1 } },
  });
  const host = { id: 249, type: "SubgraphNode", subgraph: inner };
  const rootGraph = makeGraph({ id: "root", nodes: [host] });
  return { rootGraph, inner, impactSwitch };
}

// ── the production path ─────────────────────────────────────────────────────────

test("#2192: the repaired link's validation error is gone from a subgraph-scope read", async () => {
  const { rootGraph, inner } = reporterGraphs();
  const result = await runProductionGraphGetErrors({
    graph: inner,
    rootGraph,
    lastNodeErrors: { "249:252": { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH] } },
  });

  assert.equal(result.errored_count, 0);
  assert.equal(result.node_errors, null, "the repaired link must not still be reported");
  // The self-contradiction the report is about: a clean count beside a populated map.
  // Now the count and the map agree, and the payload says so out loud.
  assert.equal(result.note, "no errors recorded since the last execution start");
  assert.equal(result.stale_node_errors.length, 1);
  assert.equal(result.stale_node_errors[0].node_id, "249:252");
  assert.equal(result.stale_node_errors[0].class_type, "ImpactSwitch");
  assert.match(result.stale_node_errors[0].contradicted_by, /select/);
});

test("#2192: exiting to ROOT scope does not resurrect it (the reporter's step 5)", async () => {
  const { rootGraph } = reporterGraphs();
  const result = await runProductionGraphGetErrors({
    graph: rootGraph,
    rootGraph,
    lastNodeErrors: { "249:252": { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH] } },
  });
  assert.equal(result.errored_count, 0);
  assert.equal(result.node_errors, null);
  assert.equal(result.stale_node_errors.length, 1);
});

test("#2192: the STILL-BROKEN wire is reported exactly as before", async () => {
  // Same call, only the live origin differs — `select` really is fed by 265 (IMAGE).
  const { rootGraph, inner } = reporterGraphs({ originId: "265" });
  const nodeErrors = { "249:252": { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH] } };
  const result = await runProductionGraphGetErrors({ graph: inner, rootGraph, lastNodeErrors: nodeErrors });

  assert.deepEqual(result.node_errors, nodeErrors, "a live rejection must survive untouched");
  assert.equal(result.stale_node_errors, undefined);
  assert.equal(result.note, undefined, "a graph with a live validation error is not clean");
});

test("#2192: the execution-error store is pruned too, not just app.lastNodeErrors", async () => {
  // ComfyUI can clear the app map while the store retains the rejection, which is why
  // the two are unioned before they are reported — the prune must cover both.
  const { rootGraph, inner } = reporterGraphs();
  const result = await runProductionGraphGetErrors({
    graph: inner,
    rootGraph,
    lastNodeErrors: null,
    storeNodeErrors: { "249:252": { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH] } },
  });
  assert.equal(result.node_errors, null);
  assert.equal(result.stale_node_errors.length, 1);
});

test("#2192: a disclosure list cut at the cap says so (#809)", async () => {
  // A silently short list inside the field whose whole job is disclosure would be the
  // same defect the field exists to close. 60 nodes, all contradicted, cap is 50.
  const impactSwitches = [];
  const links = {};
  for (let i = 0; i < 60; i += 1) {
    const id = 300 + i;
    impactSwitches.push({
      id,
      type: "ImpactSwitch",
      inputs: [{ name: "select", type: "INT", link: 1000 + i }],
    });
    links[1000 + i] = { id: 1000 + i, origin_id: "251", origin_slot: 0, target_id: id, target_slot: 0 };
  }
  const inner = makeGraph({ id: "249", nodes: [{ id: 251, type: "ImpactInt" }, ...impactSwitches], links });
  const rootGraph = makeGraph({ id: "root", nodes: [{ id: 249, type: "SubgraphNode", subgraph: inner }] });
  const lastNodeErrors = Object.fromEntries(
    impactSwitches.map((n) => [`249:${n.id}`, { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH] }]),
  );

  const result = await runProductionGraphGetErrors({ graph: inner, rootGraph, lastNodeErrors });
  assert.equal(result.node_errors, null);
  assert.equal(result.stale_node_errors.length, 50);
  assert.equal(result.stale_node_errors_truncated, true);
  // The harness stubs fixedCapNote, so the TEXT is pinned in the wiring test below
  // (against the shipped source); here the observable facts are the cut and its flag.
  assert.equal(typeof result.stale_node_errors_truncation_hint, "string");
});

// ── codex gate P1: one map's label must never decide the other map's fate ────

test("#2192 P1: a stale STORE entry does not take the live APP error down with it", async () => {
  // combineNodeErrorMaps merges same-id entries with {...previous, ...entry}, so the
  // LAST map's class_type governs an entry whose errors came from BOTH. Pruning after
  // that merge let a retained foreign label drop a live error: node_errors null,
  // errored_count 0, real error suppressed. Reproduced against the shipped executor
  // before the fix; adjudicating each map on its own is what makes it survive.
  const node = { id: 2, type: "Current", inputs: [] };
  const graph = makeGraph({ id: "root", nodes: [node] });
  const live = { type: "value_not_in_list", message: "ckpt not in list", extra_info: { input_name: "ckpt_name" } };

  const result = await runProductionGraphGetErrors({
    graph,
    rootGraph: graph,
    lastNodeErrors: { 2: { class_type: "Current", errors: [live] } },
    storeNodeErrors: { 2: { class_type: "OldWorkflowType", errors: [{ message: "stale from another workflow" }] } },
  });

  assert.deepEqual(result.node_errors?.[2]?.errors, [live], "the live app error must survive");
  assert.equal(result.node_errors[2].class_type, "Current", "and keep its OWN source's label");
  assert.equal(result.errored_count, 1, "and still count as an error on the graph");
  assert.equal(result.note, undefined, "a graph with a live validation error is not clean");
  // The foreign entry IS withheld, and says why.
  assert.equal(result.stale_node_errors.length, 1);
  assert.match(result.stale_node_errors[0].contradicted_by, /not the OldWorkflowType/);
});

test("#2192 P1: the same stale entry in BOTH stores is one withheld fact, not two", () => {
  const node = { id: 2, type: "Current", inputs: [] };
  const graph = makeGraph({ id: "root", nodes: [node] });
  const foreign = { class_type: "OldWorkflowType", errors: [{ message: "stale" }] };
  const { nodeErrors, dropped } = pruneContradictedNodeErrorMaps(graph, [{ 2: foreign }, { 2: foreign }]);
  assert.equal(nodeErrors, null);
  assert.equal(dropped.length, 1, "deduplicated on (node id, reason)");
});

test("#2192 P1: the composer keeps combineNodeErrorMaps' union of two LIVE sources", () => {
  // The reason that union exists (#579): ComfyUI can clear the app map while the store
  // still holds the rejection. Pruning per-map must not cost that.
  const node = { id: 2, type: "Current", inputs: [] };
  const graph = makeGraph({ id: "root", nodes: [node] });
  const a = { message: "from the app map" };
  const b = { message: "from the execution store" };
  const { nodeErrors } = pruneContradictedNodeErrorMaps(graph, [
    { 2: { class_type: "Current", errors: [a] } },
    { 2: { class_type: "Current", errors: [b] } },
  ]);
  assert.deepEqual(nodeErrors[2].errors, [a, b]);
});

test("#2192 P1: a non-array argument is still accepted as a single map", () => {
  const node = { id: 2, type: "Current", inputs: [] };
  const graph = makeGraph({ id: "root", nodes: [node] });
  const map = { 2: { class_type: "Current", errors: [{ message: "live" }] } };
  assert.deepEqual(pruneContradictedNodeErrorMaps(graph, map).nodeErrors, map);
  assert.equal(pruneContradictedNodeErrorMaps(graph, null).nodeErrors, null);
});

// ── codex gate round 2: the two halves of the claim, and the right type field ──

test("#2192 r2: class_type is matched against comfyClass, not just node.type", async () => {
  // The frontend's prompt compiler writes `class_type: e.comfyClass`, and registration
  // sets type and comfyClass from different sources (`registerNodeType(n.id, i)` vs
  // `i.comfyClass = t.name`). Comparing against `type` alone dropped live errors.
  const node = { id: 2, type: "b2f0…-subgraph-uuid", comfyClass: "LoadImage", inputs: [] };
  const graph = makeGraph({ id: "root", nodes: [node] });
  const live = { type: "value_not_in_list", message: "image not in list" };

  const result = await runProductionGraphGetErrors({
    graph,
    rootGraph: graph,
    lastNodeErrors: { 2: { class_type: "LoadImage", errors: [live] } },
  });
  assert.deepEqual(result.node_errors?.[2]?.errors, [live], "comfyClass agrees — nothing to drop");
  assert.equal(result.errored_count, 1);
  assert.equal(result.stale_node_errors, undefined);
});

test("#2192 r2: a class that matches NEITHER field is still dropped", () => {
  const node = { id: 2, type: "SomeType", comfyClass: "LoadImage", inputs: [] };
  const graph = makeGraph({ id: "root", nodes: [node] });
  const { nodeErrors, dropped } = pruneContradictedNodeErrors(graph, {
    2: { class_type: "KSampler", errors: [{ message: "from another workflow" }] },
  });
  assert.equal(nodeErrors, null);
  assert.match(dropped[0].contradicted_by, /not the KSampler/);
});

test("#2192 r2: re-pointing the input at a different OUTPUT SLOT of the same node is a repair", () => {
  // linked_node is [node_id, slot_index] and received_type is RETURN_TYPES[slot_index],
  // so moving from output 0 (IMAGE) to output 1 (INT) fixes the mismatch without the
  // source node changing at all. Comparing the id alone reported it forever.
  const target = { id: 9, type: "ImpactSwitch", comfyClass: "ImpactSwitch", inputs: [{ name: "select", type: "INT", link: 900 }] };
  const graph = makeGraph({
    id: "root",
    nodes: [{ id: 7, type: "MultiOut" }, target],
    links: { 900: { id: 900, origin_id: 7, origin_slot: 1, target_id: 9, target_slot: 0 } },
  });
  const err = {
    type: "return_type_mismatch",
    details: "select, received_type(IMAGE) mismatch input_type(INT)",
    extra_info: { input_name: "select", received_type: "IMAGE", linked_node: [7, 0] },
  };
  const { nodeErrors, dropped } = pruneContradictedNodeErrors(graph, {
    9: { class_type: "ImpactSwitch", errors: [err] },
  });
  assert.equal(nodeErrors, null, "the slot the error names no longer feeds this input");
  assert.equal(dropped.length, 1);
});

test("#2192 r2: the SAME node AND slot is still a live error", () => {
  const target = { id: 9, type: "ImpactSwitch", comfyClass: "ImpactSwitch", inputs: [{ name: "select", type: "INT", link: 900 }] };
  const graph = makeGraph({
    id: "root",
    nodes: [{ id: 7, type: "MultiOut" }, target],
    links: { 900: { id: 900, origin_id: 7, origin_slot: 0, target_id: 9, target_slot: 0 } },
  });
  const nodeErrors = {
    9: {
      class_type: "ImpactSwitch",
      errors: [{ type: "return_type_mismatch", extra_info: { input_name: "select", linked_node: [7, 0] } }],
    },
  };
  assert.deepEqual(pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors, nodeErrors);
});

test("#2192 r2: a slot neither side states is unreadable, not a disagreement", () => {
  const target = { id: 9, type: "ImpactSwitch", inputs: [{ name: "select", type: "INT", link: 900 }] };
  // Live link carries no readable origin_slot.
  const graph = makeGraph({
    id: "root",
    nodes: [{ id: 7, type: "MultiOut" }, target],
    links: { 900: { id: 900, origin_id: 7, target_id: 9, target_slot: 0 } },
  });
  const withSlot = {
    9: { errors: [{ type: "return_type_mismatch", extra_info: { input_name: "select", linked_node: [7, 3] } }] },
  };
  assert.deepEqual(pruneContradictedNodeErrors(graph, withSlot).nodeErrors, withSlot, "no live slot → keep");

  // …and the mirror: a live slot with no claimed one.
  const graph2 = makeGraph({
    id: "root",
    nodes: [{ id: 7, type: "MultiOut" }, { id: 9, type: "ImpactSwitch", inputs: [{ name: "select", link: 900 }] }],
    links: { 900: { id: 900, origin_id: 7, origin_slot: 2, target_id: 9, target_slot: 0 } },
  });
  const noSlot = {
    9: { errors: [{ type: "return_type_mismatch", extra_info: { input_name: "select", linked_node: [7] } }] },
  };
  assert.deepEqual(pruneContradictedNodeErrors(graph2, noSlot).nodeErrors, noSlot, "no claimed slot → keep");
});

// ── codex gate round 4: only ONE error type files its linked_node this way ────

test("#2192 r4: exception_during_inner_validation is never judged by the link check", async () => {
  // execution.py files this one under the UPSTREAM node — `validated[o_id] = (False,
  // reasons, o_id)` — while `input_name` names an input of the DOWNSTREAM node and
  // `linked_node` points back at the errored node itself. Read with return_type_mismatch's
  // premise it finds a same-named input on the wrong node and drops a live error.
  const node1 = { id: 1, type: "Upstream", comfyClass: "Upstream", inputs: [{ name: "x", type: "IMAGE", link: null }] };
  const graph = makeGraph({ id: "root", nodes: [node1, { id: 2, type: "Downstream" }] });
  const nodeErrors = {
    1: {
      class_type: "Upstream",
      errors: [
        {
          type: "exception_during_inner_validation",
          message: "Exception when validating inner node",
          extra_info: { input_name: "x", linked_node: [2, 0] },
        },
      ],
    },
  };

  const result = await runProductionGraphGetErrors({ graph, rootGraph: graph, lastNodeErrors: nodeErrors });
  assert.deepEqual(result.node_errors, nodeErrors, "a live inner-validation exception must survive");
  assert.equal(result.errored_count, 1);
  assert.equal(result.note, undefined);
});

test("#2192 r4: an unknown error type carrying linked_node is never judged either", () => {
  // Whitelist, not blocklist: a newer ComfyUI's error type, or a custom validator's, must
  // not be read with semantics borrowed from return_type_mismatch.
  const target = { id: 9, type: "Sw", comfyClass: "Sw", inputs: [{ name: "select", link: 900 }] };
  const graph = makeGraph({
    id: "root",
    nodes: [{ id: 7, type: "A" }, { id: 8, type: "B" }, target],
    links: { 900: { id: 900, origin_id: 8, origin_slot: 0, target_id: 9, target_slot: 0 } },
  });
  const nodeErrors = {
    9: { class_type: "Sw", errors: [{ type: "some_future_error", extra_info: { input_name: "select", linked_node: [7, 0] } }] },
  };
  assert.deepEqual(pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors, nodeErrors);
});

test("#2192 r4: an error with NO type is not judged", () => {
  const target = { id: 9, type: "Sw", inputs: [{ name: "select", link: 900 }] };
  const graph = makeGraph({
    id: "root",
    nodes: [{ id: 7, type: "A" }, { id: 8, type: "B" }, target],
    links: { 900: { id: 900, origin_id: 8, origin_slot: 0, target_id: 9, target_slot: 0 } },
  });
  const nodeErrors = { 9: { errors: [{ extra_info: { input_name: "select", linked_node: [7, 0] } }] } };
  assert.deepEqual(pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors, nodeErrors);
});

// ── codex gate round 5: the prompt is COMPILED; the graph is not ─────────────
//
// The serializer skips `isVirtualNode || mode === NEVER || mode === BYPASS` and attributes
// the link to whatever is upstream, so an input fed through any of those has a
// `linked_node` that CANNOT equal its immediate origin_id. Reading that as a repair drops
// live errors on any graph with a reroute in it.

/** target.select fed by `via` (id 7), which is upstream-fed by the real source 5. */
function indirectionGraph(via) {
  const target = { id: 9, type: "Sw", comfyClass: "Sw", inputs: [{ name: "select", link: 900 }] };
  return {
    graph: makeGraph({
      id: "root",
      nodes: [{ id: 5, type: "RealSource" }, via, target],
      links: { 900: { id: 900, origin_id: 7, origin_slot: 0, target_id: 9, target_slot: 0 } },
    }),
    nodeErrors: {
      9: {
        class_type: "Sw",
        errors: [
          {
            type: "return_type_mismatch",
            details: "select, received_type(IMAGE) mismatch input_type(INT)",
            extra_info: { input_name: "select", linked_node: [5, 0] },
          },
        ],
      },
    },
  };
}

for (const [label, via] of [
  ["a BYPASSED node (mode 4)", { id: 7, type: "Passthrough", mode: 4 }],
  ["a MUTED node (mode 2)", { id: 7, type: "Passthrough", mode: 2 }],
  ["a virtual Reroute", { id: 7, type: "Reroute", isVirtualNode: true }],
  ["a subgraph container", { id: 7, type: "SubgraphNode", isVirtualNode: true, subgraph: {} }],
]) {
  test(`#2192 r5: an error whose source is reached through ${label} is NOT dropped`, async () => {
    const { graph, nodeErrors } = indirectionGraph(via);
    const result = await runProductionGraphGetErrors({ graph, rootGraph: graph, lastNodeErrors: nodeErrors });
    assert.deepEqual(result.node_errors, nodeErrors, "the compiler resolves through it — this is not a repair");
    assert.equal(result.errored_count, 1);
    assert.equal(result.note, undefined);
  });
}

test("#2192 r5: an unresolvable source node keeps the error", () => {
  const target = { id: 9, type: "Sw", inputs: [{ name: "select", link: 900 }] };
  const graph = makeGraph({
    id: "root",
    nodes: [target], // node 8 is referenced by the link but absent from the graph
    links: { 900: { id: 900, origin_id: 8, origin_slot: 0, target_id: 9, target_slot: 0 } },
  });
  const nodeErrors = {
    9: { errors: [{ type: "return_type_mismatch", extra_info: { input_name: "select", linked_node: [5, 0] } }] },
  };
  assert.deepEqual(pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors, nodeErrors);
});

test("#2192 r5: an ORDINARY source node is still judged — the fix survives the guard", () => {
  // mode 0 and mode-absent are both ordinary; the reporter's repair is exactly this shape.
  for (const mode of [0, undefined]) {
    const { graph, nodeErrors } = indirectionGraph({ id: 7, type: "RealPassthrough", mode });
    const out = pruneContradictedNodeErrors(graph, nodeErrors);
    assert.equal(out.nodeErrors, null, `mode ${String(mode)} is a real source, so [5,0] is falsified`);
  }
});

// ── the OTHER consumer: the turn-start banner ──────────────────────────────
//
// `validationBanner` reads the same map and injects it into the agent's turn asserting
// the user "is seeing these RIGHT NOW". A fix that corrected only panel_get_errors would
// leave the stale claim on the louder surface.

test("#2192: the turn-start banner does not claim the repaired link is on screen", async () => {
  const { rootGraph } = reporterGraphs();
  const banner = await runProductionValidationBanner({
    rootGraph,
    lastNodeErrors: { "249:252": { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH] } },
  });
  assert.equal(banner, "", "a repaired graph injects nothing");
});

test("#2192: the banner still fires for the STILL-BROKEN wire", async () => {
  const { rootGraph } = reporterGraphs({ originId: "265" });
  const banner = await runProductionValidationBanner({
    rootGraph,
    lastNodeErrors: { "249:252": { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH] } },
  });
  assert.match(banner, /GRAPH VALIDATION ERRORS/);
  assert.match(banner, /received_type\(IMAGE\) mismatch input_type\(INT\)/);
});

test("#2192: NO root graph is not evidence — the banner reports every error unchanged", async () => {
  // validationBanner's `getGraphCtx()` probe is try/catch-wrapped and yields null when
  // the binding is unresolvable. Reading that as "none of these nodes exist" would drop
  // the whole map on a real code path; absence of evidence is not disproof.
  const banner = await runProductionValidationBanner({
    rootGraph: null,
    lastNodeErrors: { 5: { class_type: "KSampler", errors: [{ message: "boom" }] } },
  });
  assert.match(banner, /node 5 \(KSampler\): boom/);
});

test("#2192: pruneContradictedNodeErrors fails open on a nullish graph", () => {
  const nodeErrors = { 5: { class_type: "KSampler", errors: [SELECT_MISMATCH] } };
  for (const graph of [null, undefined, 0, ""]) {
    const out = pruneContradictedNodeErrors(graph, nodeErrors);
    assert.deepEqual(out.nodeErrors, nodeErrors, `nullish graph ${String(graph)} must not drop anything`);
    assert.equal(out.dropped.length, 0);
  }
});

// ── the classifier: what it drops, and everything it refuses to ────────────────

test("#2192: an entry naming a node that does not resolve is KEPT, not dropped", () => {
  // Absence of a node is absence of evidence. Two separate review P1s came from reading
  // "does not resolve" as "does not exist": a null root graph (a real validationBanner
  // state) and a momentarily EMPTY graph (ComfyUI clears and repopulates `_nodes` while
  // loading) both make every id unresolvable while the errors are perfectly live.
  const { rootGraph } = reporterGraphs();
  const nodeErrors = { 777: { class_type: "KSampler", errors: [{ message: "boom" }] } };
  const out = pruneContradictedNodeErrors(rootGraph, nodeErrors);
  assert.deepEqual(out.nodeErrors, nodeErrors);
  assert.equal(out.dropped.length, 0);
});

test("#2192: a momentarily EMPTY graph drops nothing (the mid-load state)", async () => {
  const empty = makeGraph({ id: "root", nodes: [] });
  const nodeErrors = { 5: { class_type: "KSampler", errors: [{ message: "ckpt not in list" }] } };

  const result = await runProductionGraphGetErrors({ graph: empty, rootGraph: empty, lastNodeErrors: nodeErrors });
  assert.deepEqual(result.node_errors, nodeErrors, "a load in flight is not a repaired graph");
  assert.equal(result.stale_node_errors, undefined);

  const banner = await runProductionValidationBanner({ rootGraph: empty, lastNodeErrors: nodeErrors });
  assert.match(banner, /GRAPH VALIDATION ERRORS/, "the banner must not go silent mid-load");
});

test("#2192: an id ComfyUI reused for a different class is dropped (#1448, for validation)", () => {
  const { rootGraph } = reporterGraphs();
  const { nodeErrors, dropped } = pruneContradictedNodeErrors(rootGraph, {
    "249:252": { class_type: "LoadImage", errors: [{ message: "boom" }] },
  });
  assert.equal(nodeErrors, null);
  assert.match(dropped[0].contradicted_by, /ImpactSwitch now, not the LoadImage/);
});

test("#2192: sibling errors on the same node survive the one that falsified", () => {
  const { rootGraph } = reporterGraphs();
  const live = { type: "value_not_in_list", message: "ckpt not in list", extra_info: { input_name: "ckpt_name" } };
  const { nodeErrors, dropped } = pruneContradictedNodeErrors(rootGraph, {
    "249:252": { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH, live] },
  });
  assert.deepEqual(nodeErrors["249:252"].errors, [live]);
  assert.equal(nodeErrors["249:252"].class_type, "ImpactSwitch");
  assert.equal(dropped.length, 1);
});

test("#2192: a slot the live node no longer exposes is NOT falsified by its absence", () => {
  // Impact-Pack renames dynamic slots by position (#1873). An input we cannot find is
  // unjudgeable, not disproven — keep reporting.
  const { rootGraph } = reporterGraphs({ selectInputName: "select_renamed" });
  const nodeErrors = { "249:252": { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH] } };
  const { nodeErrors: kept, dropped } = pruneContradictedNodeErrors(rootGraph, nodeErrors);
  assert.deepEqual(kept, nodeErrors);
  assert.equal(dropped.length, 0);
});

test("#2192: an unreadable link store keeps the error rather than clearing it", () => {
  const { rootGraph, inner } = reporterGraphs();
  inner.links = {}; // link 900 is referenced by the input but not resolvable
  const nodeErrors = { "249:252": { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH] } };
  assert.deepEqual(pruneContradictedNodeErrors(rootGraph, nodeErrors).nodeErrors, nodeErrors);
});

test("#2192: a linked_node in a DIFFERENT scope is not judged against a local origin id", () => {
  const { rootGraph } = reporterGraphs();
  const crossScope = {
    ...SELECT_MISMATCH,
    extra_info: { ...SELECT_MISMATCH.extra_info, linked_node: ["999:265", 0] },
  };
  const nodeErrors = { "249:252": { class_type: "ImpactSwitch", errors: [crossScope] } };
  assert.deepEqual(pruneContradictedNodeErrors(rootGraph, nodeErrors).nodeErrors, nodeErrors);
});

test("#2192: an error with no linked_node claim is never dropped by this check", () => {
  const { rootGraph } = reporterGraphs();
  const nodeErrors = {
    "249:252": {
      class_type: "ImpactSwitch",
      errors: [{ type: "required_input_missing", extra_info: { input_name: "select" } }],
    },
  };
  assert.deepEqual(pruneContradictedNodeErrors(rootGraph, nodeErrors).nodeErrors, nodeErrors);
});

test("#2192: an UNRECOGNIZED locator fails open even though it resolves to nothing", () => {
  const { rootGraph } = reporterGraphs();
  const nodeErrors = { "a:b:c:": { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH] } };
  assert.deepEqual(pruneContradictedNodeErrors(rootGraph, nodeErrors).nodeErrors, nodeErrors);
});

test("#2192: a graph that throws on lookup reports the entry verbatim", () => {
  const exploding = {
    getNodeById: () => {
      throw new Error("detached graph");
    },
  };
  const nodeErrors = { 5: { class_type: "KSampler", errors: [SELECT_MISMATCH] } };
  assert.deepEqual(pruneContradictedNodeErrors(exploding, nodeErrors).nodeErrors, nodeErrors);
});

test("#2192: null / non-object maps pass through unchanged", () => {
  const { rootGraph } = reporterGraphs();
  assert.deepEqual(pruneContradictedNodeErrors(rootGraph, null), { nodeErrors: null, dropped: [] });
  assert.deepEqual(pruneContradictedNodeErrors(rootGraph, undefined), { nodeErrors: null, dropped: [] });
  assert.deepEqual(pruneContradictedNodeErrors(rootGraph, []).nodeErrors, []);
});

// ── wiring: the shipped monolith must actually call it ─────────────────────────

test("#2192 wiring: both consumers prune, and neither merges before it prunes", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /pruneContradictedNodeErrorMaps,/, "imported from asset-staleness.js");

  // BOTH consumers of the map, not just the one the issue names. A green helper test
  // proves nothing about a call path that never calls it.
  assert.equal(
    (src.match(/pruneContradictedNodeErrorMaps\(/g) ?? []).length,
    2,
    "graph_get_errors AND validationBanner must each prune",
  );

  // THE ORDERING INVARIANT (codex gate P1). `combineNodeErrorMaps` merges same-id entries
  // with {...previous, ...entry}, so merging FIRST lets the last map's class_type govern
  // the first map's errors and a stale store entry drops a live app error. The panel must
  // therefore never invoke the union itself — the composer owns that order.
  assert.equal(
    (src.match(/combineNodeErrorMaps\(/g) ?? []).length,
    0,
    "the panel must not union the maps itself; pruneContradictedNodeErrorMaps does it after pruning",
  );
  assert.equal(
    (src.match(/pruneContradictedNodeErrors\(/g) ?? []).length,
    0,
    "the single-map prune is the composer's internal; a direct call here would invite the merge-first order back",
  );

  // One binding: the pruned map is what the per-node join, `clean` and the payload read.
  assert.equal(
    (src.match(/const \{ nodeErrors, dropped: contradictedNodeErrors \} = pruneContradictedNodeErrorMaps\(/g) ?? [])
      .length,
    1,
  );
  assert.match(
    src,
    /nodeErrors = pruneContradictedNodeErrorMaps\(postProbeRootGraph, \[nodeErrors\]\)\.nodeErrors;/,
    "the banner must prune against the root graph its own binding guard just cleared",
  );

  assert.match(src, /stale_node_errors: contradictedNodeErrors\.slice\(0, MAX_STATE_NODES\)/);
  // The cut must be reported with the REAL total, not the shown count — a hint that
  // says "50 of 50" is the silent-cut defect wearing a disclosure.
  assert.match(
    src,
    /stale_node_errors_truncation_hint: fixedCapNote\(\s*"dropped stale validation error\(s\)",\s*MAX_STATE_NODES,\s*contradictedNodeErrors\.length,/,
  );
});
