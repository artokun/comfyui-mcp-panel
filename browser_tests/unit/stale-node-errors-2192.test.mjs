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

import { pruneContradictedNodeErrors } from "../../web/js/lib/asset-staleness.js";
import { runProductionGraphGetErrors } from "./_graph-get-errors-harness.mjs";

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

// ── the classifier: what it drops, and everything it refuses to ────────────────

test("#2192: an entry naming a node that is not on the graph at all is dropped", () => {
  const { rootGraph } = reporterGraphs();
  const { nodeErrors, dropped } = pruneContradictedNodeErrors(rootGraph, {
    777: { class_type: "KSampler", errors: [{ message: "boom" }] },
  });
  assert.equal(nodeErrors, null);
  assert.match(dropped[0].contradicted_by, /no node 777 is on the active graph/);
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

test("#2192 wiring: graph_get_errors prunes the map it reports, not a copy beside it", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /pruneContradictedNodeErrors,/, "imported from asset-staleness.js");
  // One binding: the pruned map is what the per-node join, `clean` and the payload read.
  // A second `const nodeErrors =` from the raw union would silently un-ship the fix.
  const bindings = src.match(/const \{ nodeErrors, dropped: contradictedNodeErrors \} = pruneContradictedNodeErrors\(/g);
  assert.equal(bindings?.length, 1);
  assert.equal(
    (src.match(/const nodeErrors = combineNodeErrorMaps\(/g) ?? []).length,
    0,
    "the raw union must not be bound as `nodeErrors` anywhere",
  );
  assert.match(src, /stale_node_errors: contradictedNodeErrors\.slice\(0, MAX_STATE_NODES\)/);
});
