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
 * THE RULE THESE TESTS PIN. An entry is withheld only on positive proof from the live
 * graph, and for a `return_type_mismatch` that proof is local and about TYPES: the input
 * the error names now receives exactly the type it declares. It is deliberately NOT
 * "the link named by `extra_info.linked_node` changed" — `linked_node` is a coordinate in
 * the COMPILED prompt, which flattens subgraphs, renames dynamic slots and resolves
 * through virtual/muted/bypassed nodes, and a changed link is not even sufficient (moving
 * to another output of the same type repairs nothing).
 *
 * Both shipped consumers are driven through production-path harnesses: `graph_get_errors`
 * and `validationBanner`, which reads the same map and asserts the user is seeing it now.
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

const SELECT_MISMATCH = {
  type: "return_type_mismatch",
  message: "Return type mismatch between linked nodes",
  details: "select, received_type(IMAGE) mismatch input_type(INT)",
  extra_info: {
    input_name: "select",
    received_type: "IMAGE",
    input_config: ["INT", {}],
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
 * The reporter's graph. Root holds subgraph host 249; inside it, 251 emits INT, 265 emits
 * IMAGE, and 252 is the ImpactSwitch whose `select` (INT) is fed by `originId`.
 * `originId: "251"` is the REPAIRED state; `"265"` is the broken one the error describes.
 */
function reporterGraphs({ originId = "251", selectInputName = "select" } = {}) {
  const impactSwitch = {
    id: 252,
    type: "ImpactSwitch",
    comfyClass: "ImpactSwitch",
    inputs: [
      { name: "input1", type: "IMAGE", link: null },
      { name: selectInputName, type: "INT", link: originId == null ? null : 900 },
    ],
  };
  const inner = makeGraph({
    id: "249",
    nodes: [
      { id: 251, type: "ImpactInt", outputs: [{ name: "INT", type: "INT" }] },
      { id: 265, type: "LoadImage", outputs: [{ name: "IMAGE", type: "IMAGE" }] },
      impactSwitch,
    ],
    links:
      originId == null
        ? {}
        : { 900: { id: 900, origin_id: originId, origin_slot: 0, target_id: 252, target_slot: 1 } },
  });
  const host = { id: 249, type: "SubgraphNode", subgraph: inner };
  const rootGraph = makeGraph({ id: "root", nodes: [host] });
  return { rootGraph, inner, impactSwitch };
}

// ── the reported bug, through the shipped executor ──────────────────────────────

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
  // same defect the field exists to close. 60 nodes, all repaired, cap is 50.
  const switches = [];
  const links = {};
  for (let i = 0; i < 60; i += 1) {
    const id = 300 + i;
    switches.push({
      id,
      type: "ImpactSwitch",
      comfyClass: "ImpactSwitch",
      inputs: [{ name: "select", type: "INT", link: 1000 + i }],
    });
    links[1000 + i] = { id: 1000 + i, origin_id: 251, origin_slot: 0, target_id: id, target_slot: 0 };
  }
  const inner = makeGraph({
    id: "249",
    nodes: [{ id: 251, type: "ImpactInt", outputs: [{ type: "INT" }] }, ...switches],
    links,
  });
  const rootGraph = makeGraph({ id: "root", nodes: [{ id: 249, type: "SubgraphNode", subgraph: inner }] });
  const lastNodeErrors = Object.fromEntries(
    switches.map((n) => [`249:${n.id}`, { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH] }]),
  );

  const result = await runProductionGraphGetErrors({ graph: inner, rootGraph, lastNodeErrors });
  assert.equal(result.node_errors, null);
  assert.equal(result.stale_node_errors.length, 50);
  assert.equal(result.stale_node_errors_truncated, true);
  // The harness stubs fixedCapNote, so the TEXT is pinned in the wiring test below
  // (against the shipped source); here the observable facts are the cut and its flag.
  assert.equal(typeof result.stale_node_errors_truncation_hint, "string");
});

// ── the type rule: what counts as proof, and what does not ─────────────────────

/** `target.select` (INT) fed by output `slot` of node 7, whose outputs are `outTypes`. */
function typeGraph({ outTypes, slot, via = {} }) {
  const source = {
    id: 7,
    type: "MultiOut",
    comfyClass: "MultiOut",
    outputs: outTypes.map((t) => ({ type: t })),
    ...via,
  };
  const target = {
    id: 9,
    type: "ImpactSwitch",
    comfyClass: "ImpactSwitch",
    inputs: [{ name: "select", type: "INT", link: 900 }],
  };
  const graph = makeGraph({
    id: "root",
    nodes: [source, target],
    links: { 900: { id: 900, origin_id: 7, origin_slot: slot, target_id: 9, target_slot: 0 } },
  });
  const nodeErrors = {
    9: {
      class_type: "ImpactSwitch",
      errors: [
        {
          type: "return_type_mismatch",
          details: "select, received_type(IMAGE) mismatch input_type(INT)",
          extra_info: { input_name: "select", received_type: "IMAGE", input_config: ["INT", {}], linked_node: [7, 0] },
        },
      ],
    },
  };
  return { graph, nodeErrors };
}

test("#2192 types: the input now receives exactly its own type ⇒ repaired", () => {
  const { graph, nodeErrors } = typeGraph({ outTypes: ["IMAGE", "INT"], slot: 1 });
  assert.equal(pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors, null);
});

test("#2192 types: a slot move between two SAME-typed outputs repairs nothing", () => {
  // The link the error names ([7,0]) is no longer the live one ([7,1]) — but both emit
  // IMAGE, so ComfyUI produces the identical mismatch. A link-identity rule got this
  // wrong; a type rule cannot.
  const { graph, nodeErrors } = typeGraph({ outTypes: ["IMAGE", "IMAGE"], slot: 1 });
  assert.deepEqual(pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors, nodeErrors);
});

test("#2192 types: a DIFFERENT source node that still emits the wrong type is still wrong", () => {
  const source = { id: 7, type: "A", outputs: [{ type: "IMAGE" }] };
  const other = { id: 8, type: "B", outputs: [{ type: "IMAGE" }] };
  const target = { id: 9, type: "Sw", inputs: [{ name: "select", type: "INT", link: 900 }] };
  const graph = makeGraph({
    id: "root",
    nodes: [source, other, target],
    links: { 900: { id: 900, origin_id: 8, origin_slot: 0, target_id: 9, target_slot: 0 } },
  });
  const nodeErrors = {
    9: { errors: [{ type: "return_type_mismatch", extra_info: { input_name: "select", input_config: ["INT", {}], linked_node: [7, 0] } }] },
  };
  assert.deepEqual(pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors, nodeErrors);
});

test("#2192 types: the linked_node coordinates are not consulted at all", () => {
  // A claim naming a node in another scope entirely still resolves on the live types,
  // because the prompt's coordinates are not what the verdict is made of.
  const { graph, nodeErrors } = typeGraph({ outTypes: ["INT"], slot: 0 });
  nodeErrors[9].errors[0].extra_info.linked_node = ["999:12345", 7];
  assert.equal(pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors, null);
});

test("#2192 types: an UNCONNECTED input is not proof of repair", () => {
  // Nothing feeds it, so there is no source type to prove anything with. ComfyUI would
  // report `required_input_missing` — a different error — rather than nothing at all.
  const { rootGraph, inner } = reporterGraphs({ originId: null });
  const nodeErrors = { "249:252": { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH] } };
  assert.deepEqual(pruneContradictedNodeErrors(rootGraph, nodeErrors).nodeErrors, nodeErrors);
  assert.equal(inner.getNodeById(252).inputs[1].link, null);
});

test("#2192 types: a `*` wildcard on either side is never exact proof", () => {
  for (const [inType, outType] of [
    ["*", "*"],
    ["INT", "*"],
    ["*", "INT"],
  ]) {
    const source = { id: 7, type: "A", outputs: [{ type: outType }] };
    const target = { id: 9, type: "Sw", inputs: [{ name: "select", type: inType, link: 900 }] };
    const graph = makeGraph({
      id: "root",
      nodes: [source, target],
      links: { 900: { id: 900, origin_id: 7, origin_slot: 0, target_id: 9, target_slot: 0 } },
    });
    const nodeErrors = {
      9: { errors: [{ type: "return_type_mismatch", extra_info: { input_name: "select", input_config: ["INT", {}], linked_node: [7, 0] } }] },
    };
    assert.deepEqual(
      pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors,
      nodeErrors,
      `wildcard ${inType}/${outType} must not be read as a match`,
    );
  }
});

test("#2192 types: an unreadable slot type or output index keeps the error", () => {
  const cases = {
    "no output at that index": { outputs: [{ type: "INT" }], slot: 5 },
    "output with no type": { outputs: [{}], slot: 0 },
    "output type not a string": { outputs: [{ type: 7 }], slot: 0 },
  };
  for (const [label, { outputs, slot }] of Object.entries(cases)) {
    const graph = makeGraph({
      id: "root",
      nodes: [
        { id: 7, type: "A", outputs },
        { id: 9, type: "Sw", inputs: [{ name: "select", type: "INT", link: 900 }] },
      ],
      links: { 900: { id: 900, origin_id: 7, origin_slot: slot, target_id: 9, target_slot: 0 } },
    });
    const nodeErrors = {
      9: { errors: [{ type: "return_type_mismatch", extra_info: { input_name: "select", input_config: ["INT", {}], linked_node: [7, 0] } }] },
    };
    assert.deepEqual(pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors, nodeErrors, label);
  }
});

test("#2192 types: a link with no readable origin_slot keeps the error", () => {
  const graph = makeGraph({
    id: "root",
    nodes: [
      { id: 7, type: "A", outputs: [{ type: "INT" }] },
      { id: 9, type: "Sw", inputs: [{ name: "select", type: "INT", link: 900 }] },
    ],
    links: { 900: { id: 900, origin_id: 7, target_id: 9, target_slot: 0 } },
  });
  const nodeErrors = {
    9: { errors: [{ type: "return_type_mismatch", extra_info: { input_name: "select", input_config: ["INT", {}], linked_node: [7, 0] } }] },
  };
  assert.deepEqual(pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors, nodeErrors);
});

test("#2192: a slot the live node no longer exposes is NOT proof of repair", () => {
  // Impact-Pack renames dynamic slots by position (#1873). An input we cannot find is
  // unjudgeable, not repaired.
  const { rootGraph } = reporterGraphs({ selectInputName: "select_renamed" });
  const nodeErrors = { "249:252": { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH] } };
  const out = pruneContradictedNodeErrors(rootGraph, nodeErrors);
  assert.deepEqual(out.nodeErrors, nodeErrors);
  assert.equal(out.dropped.length, 0);
});

test("#2192: an unreadable link store keeps the error rather than clearing it", () => {
  const { rootGraph, inner } = reporterGraphs();
  inner.links = {}; // link 900 is referenced by the input but not resolvable
  const nodeErrors = { "249:252": { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH] } };
  assert.deepEqual(pruneContradictedNodeErrors(rootGraph, nodeErrors).nodeErrors, nodeErrors);
});

test("#2192: sibling errors on the same node survive the one that proved repaired", () => {
  const { rootGraph } = reporterGraphs();
  const live = { type: "value_not_in_list", message: "ckpt not in list", extra_info: { input_name: "ckpt_name" } };
  const { nodeErrors, dropped } = pruneContradictedNodeErrors(rootGraph, {
    "249:252": { class_type: "ImpactSwitch", errors: [SELECT_MISMATCH, live] },
  });
  assert.deepEqual(nodeErrors["249:252"].errors, [live]);
  assert.equal(nodeErrors["249:252"].class_type, "ImpactSwitch");
  assert.equal(dropped.length, 1);
});

// ── the frontend's socket types are the FRONTEND's ────────────────────────────

test("#2192 defs: a live socket type the SERVER did not validate against is no proof", () => {
  // A pack update plus a reconnect moves the server ahead of the node def this tab
  // loaded. The server validated `select` as STRING; the tab still draws it INT, and an
  // INT link therefore still fails at the server. `input_config[0]` is the server's own
  // word on it — execution.py's `info = (input_type, extra_info)` — so a disagreement
  // means the frontend's view cannot corroborate anything.
  const { graph, nodeErrors } = typeGraph({ outTypes: ["INT"], slot: 0 });
  nodeErrors[9].errors[0].extra_info.input_config = ["STRING", {}];
  assert.deepEqual(pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors, nodeErrors);
});

test("#2192 defs: an absent or non-string input_config gives nothing to corroborate", () => {
  // A combo input's `input_type` is the option LIST, not a name — nothing to compare.
  for (const config of [undefined, null, [], [["a", "b"], {}], ["", {}], [7, {}]]) {
    const { graph, nodeErrors } = typeGraph({ outTypes: ["INT"], slot: 0 });
    if (config === undefined) delete nodeErrors[9].errors[0].extra_info.input_config;
    else nodeErrors[9].errors[0].extra_info.input_config = config;
    assert.deepEqual(
      pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors,
      nodeErrors,
      `input_config ${JSON.stringify(config)} must not be read as corroboration`,
    );
  }
});

test("#2192 defs: server and frontend agreeing is what makes the type proof usable", () => {
  // The positive case, stated explicitly so the guard above cannot silently become the
  // only outcome: server says INT, the tab draws INT, the live source emits INT.
  const { graph, nodeErrors } = typeGraph({ outTypes: ["INT"], slot: 0 });
  assert.equal(nodeErrors[9].errors[0].extra_info.input_config[0], "INT");
  assert.equal(pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors, null);
});

// ── the prompt is COMPILED; the graph is not ──────────────────────────────────
//
// The serializer skips `isVirtualNode || mode === NEVER || mode === BYPASS` and the input
// receives the type of whatever is further upstream, so the immediate source's own output
// type is not evidence about what this input actually gets.

for (const [label, via] of [
  ["a BYPASSED node (mode 4)", { mode: 4 }],
  ["a MUTED node (mode 2)", { mode: 2 }],
  ["a virtual Reroute", { isVirtualNode: true }],
  ["a subgraph container", { isVirtualNode: true, subgraph: {} }],
]) {
  test(`#2192 compiled: a matching type read through ${label} is not proof`, async () => {
    const { graph, nodeErrors } = typeGraph({ outTypes: ["INT"], slot: 0, via });
    const result = await runProductionGraphGetErrors({ graph, rootGraph: graph, lastNodeErrors: nodeErrors });
    assert.deepEqual(result.node_errors, nodeErrors, "the compiler resolves through it — read no verdict off it");
    assert.equal(result.errored_count, 1);
    assert.equal(result.note, undefined);
  });
}

test("#2192 compiled: an ORDINARY source is judged — the guard does not disable the fix", () => {
  // mode 0 and mode-absent are both ordinary; the reporter's repair is exactly this shape.
  for (const mode of [0, undefined]) {
    const { graph, nodeErrors } = typeGraph({ outTypes: ["INT"], slot: 0, via: { mode } });
    assert.equal(
      pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors,
      null,
      `mode ${String(mode)} is a real source, so the matching type is proof`,
    );
  }
});

test("#2192 compiled: an unresolvable source node keeps the error", () => {
  const graph = makeGraph({
    id: "root",
    nodes: [{ id: 9, type: "Sw", inputs: [{ name: "select", type: "INT", link: 900 }] }],
    links: { 900: { id: 900, origin_id: 8, origin_slot: 0, target_id: 9, target_slot: 0 } },
  });
  const nodeErrors = {
    9: { errors: [{ type: "return_type_mismatch", extra_info: { input_name: "select", input_config: ["INT", {}], linked_node: [5, 0] } }] },
  };
  assert.deepEqual(pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors, nodeErrors);
});

// ── only ONE ComfyUI error type files its input_name this way ─────────────────

test("#2192: exception_during_inner_validation is never judged by the type check", async () => {
  // execution.py files this one under the UPSTREAM node — `validated[o_id] = (False,
  // reasons, o_id)` — while `input_name` names an input of the DOWNSTREAM node. Read with
  // return_type_mismatch's premise it finds a same-named input on the wrong node.
  const node1 = {
    id: 1,
    type: "Upstream",
    comfyClass: "Upstream",
    inputs: [{ name: "x", type: "INT", link: 900 }],
    outputs: [{ type: "INT" }],
  };
  const src = { id: 3, type: "IntSrc", outputs: [{ type: "INT" }] };
  const graph = makeGraph({
    id: "root",
    nodes: [src, node1, { id: 2, type: "Downstream" }],
    links: { 900: { id: 900, origin_id: 3, origin_slot: 0, target_id: 1, target_slot: 0 } },
  });
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

test("#2192: an unknown or absent error type is never judged either", () => {
  // Whitelist, not blocklist: a newer ComfyUI's error type, or a custom validator's, must
  // not be read with semantics borrowed from return_type_mismatch.
  for (const type of ["some_future_error", "required_input_missing", undefined]) {
    const { graph, nodeErrors } = typeGraph({ outTypes: ["INT"], slot: 0 });
    if (type === undefined) delete nodeErrors[9].errors[0].type;
    else nodeErrors[9].errors[0].type = type;
    assert.deepEqual(
      pruneContradictedNodeErrors(graph, nodeErrors).nodeErrors,
      nodeErrors,
      `error type ${String(type)} must not be judged`,
    );
  }
});

// ── the class-type check ──────────────────────────────────────────────────────

test("#2192: an id ComfyUI reused for a different class is dropped (#1448, for validation)", () => {
  const { rootGraph } = reporterGraphs();
  const { nodeErrors, dropped } = pruneContradictedNodeErrors(rootGraph, {
    "249:252": { class_type: "LoadImage", errors: [{ message: "boom" }] },
  });
  assert.equal(nodeErrors, null);
  assert.match(dropped[0].contradicted_by, /ImpactSwitch now, not the LoadImage/);
});

test("#2192: class_type is matched against comfyClass, not just node.type", async () => {
  // The frontend's prompt compiler writes `class_type: e.comfyClass`, and registration
  // sets type and comfyClass from different sources (`registerNodeType(n.id, i)` vs
  // `i.comfyClass = t.name`). Comparing against `type` alone dropped live errors.
  const node = { id: 2, type: "b2f0-subgraph-uuid", comfyClass: "LoadImage", inputs: [] };
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

test("#2192: a class that matches NEITHER field is still dropped", () => {
  const node = { id: 2, type: "SomeType", comfyClass: "LoadImage", inputs: [] };
  const graph = makeGraph({ id: "root", nodes: [node] });
  const { nodeErrors, dropped } = pruneContradictedNodeErrors(graph, {
    2: { class_type: "KSampler", errors: [{ message: "from another workflow" }] },
  });
  assert.equal(nodeErrors, null);
  assert.match(dropped[0].contradicted_by, /not the KSampler/);
});

// ── absence is never evidence ─────────────────────────────────────────────────

test("#2192: an entry naming a node that does not resolve is KEPT, not dropped", () => {
  // Two separate review findings came from reading "does not resolve" as "does not
  // exist": a null root graph (a real validationBanner state) and a momentarily EMPTY
  // graph (ComfyUI clears and repopulates `_nodes` while loading).
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

test("#2192: NO root graph is not evidence — the banner reports every error unchanged", async () => {
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

// ── one map's label must never decide the other map's fate ────────────────────

test("#2192: a stale STORE entry does not take the live APP error down with it", async () => {
  // combineNodeErrorMaps merges same-id entries with {...previous, ...entry}, so the
  // LAST map's class_type governs an entry whose errors came from BOTH. Pruning after
  // that merge let a retained foreign label drop a live error: node_errors null,
  // errored_count 0, real error suppressed.
  const node = { id: 2, type: "Current", comfyClass: "Current", inputs: [] };
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
  assert.equal(result.stale_node_errors.length, 1);
  assert.match(result.stale_node_errors[0].contradicted_by, /not the OldWorkflowType/);
});

test("#2192: the same stale entry in BOTH stores is one withheld fact, not two", () => {
  const node = { id: 2, type: "Current", inputs: [] };
  const graph = makeGraph({ id: "root", nodes: [node] });
  const foreign = { class_type: "OldWorkflowType", errors: [{ message: "stale" }] };
  const { nodeErrors, dropped } = pruneContradictedNodeErrorMaps(graph, [{ 2: foreign }, { 2: foreign }]);
  assert.equal(nodeErrors, null);
  assert.equal(dropped.length, 1, "deduplicated on (node id, reason)");
});

test("#2192: the composer keeps combineNodeErrorMaps' union of two LIVE sources", () => {
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

test("#2192: a non-array argument is still accepted as a single map", () => {
  const node = { id: 2, type: "Current", inputs: [] };
  const graph = makeGraph({ id: "root", nodes: [node] });
  const map = { 2: { class_type: "Current", errors: [{ message: "live" }] } };
  assert.deepEqual(pruneContradictedNodeErrorMaps(graph, map).nodeErrors, map);
  assert.equal(pruneContradictedNodeErrorMaps(graph, null).nodeErrors, null);
});

// ── the OTHER consumer: the turn-start banner ─────────────────────────────────

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

// ── wiring: the shipped monolith must actually call it ────────────────────────

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

  // THE ORDERING INVARIANT. `combineNodeErrorMaps` merges same-id entries with
  // {...previous, ...entry}, so merging FIRST lets the last map's class_type govern the
  // first map's errors and a stale store entry drops a live app error. The panel must
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
