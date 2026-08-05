/**
 * End-to-end unit tests for runSetWidget (web/js/lib/set-widget.js), the SAME async
 * unit GRAPH_TOOL_EXECUTORS.graph_set_widget delegates to — run with `node --test`.
 *
 * Covers the two set_widget honesty fixes wired at the runSetWidget layer:
 *   #560 — `widget:"lora_1.on"` is parsed into a base-widget + sub-field and MERGED
 *          (preserving lora/strength/strengthTwo); a bare scalar to a composite is
 *          refused upstream (see widget-write.test.mjs).
 *   #558 — a write to a value governed by a NON-fixed control_after_generate returns
 *          a `warning` (the value will be overwritten next run); a 'fixed' one does not.
 *
 * Driven with the fresh-oracle capability wired exactly as the panel wires it, so the
 * dotted-path parsing, promotion resolution, and warning all run their real path.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import { CONTROL_AFTER_GENERATE_MODES } from "../../web/js/lib/control-after-generate.js";

const HOOKS = { beforeChange() {}, afterChange() {}, setDirty() {} };

// A genuinely-resolved node instance (its constructor carries a live def) so the
// registry/placeholder guards pass and ONLY the intended behavior is under test.
function regNode(type, widgets, extra = {}) {
  return { id: 3, type, widgets, constructor: { nodeData: { input: { required: {} } } }, ...extra };
}
const reg = () => ({ KSampler: mkCtor(), "Power Lora Loader (rgthree)": mkCtor() });
function mkCtor() {
  const c = function NodeCtor() {};
  c.nodeData = { input: { required: {} } };
  return c;
}
const oracle = async () => ({ KSampler: {}, "Power Lora Loader (rgthree)": {} });

function wired(extra = {}) {
  const r = reg();
  return { registry: r, getRegistry: () => r, getFreshObjectInfo: oracle, ...HOOKS, ...extra };
}

// ---- #560: dotted sub-field parsing at the runSetWidget layer ----------------

test("#560 e2e: runSetWidget parses 'lora_1.on' and merges, preserving other fields", async () => {
  const node = regNode("Power Lora Loader (rgthree)", [
    { name: "lora_1", value: { on: true, lora: "motion.safetensors", strength: 1, strengthTwo: null } },
  ]);
  const res = await runSetWidget(node, "lora_1.on", false, wired());
  assert.equal(res.set.value.on, false);
  assert.equal(node.widgets[0].value.lora, "motion.safetensors");
  assert.equal(node.widgets[0].value.strength, 1);
  assert.equal(node.widgets[0].value.strengthTwo, null);
  assert.equal(res.warning, undefined); // no control_after_generate here
});

test("#560 e2e: a bare scalar to the composite base is refused, value untouched", async () => {
  const node = regNode("Power Lora Loader (rgthree)", [
    { name: "lora_1", value: { on: true, lora: "keep.safetensors", strength: 1, strengthTwo: null } },
  ]);
  await assert.rejects(
    () => runSetWidget(node, "lora_1", false, wired()),
    /composite object widget|bare scalar would corrupt/,
  );
  assert.deepEqual(node.widgets[0].value, {
    on: true,
    lora: "keep.safetensors",
    strength: 1,
    strengthTwo: null,
  });
});

// ---- #558: control_after_generate warning on write --------------------------

function ksamplerWithSeedControl(mode) {
  const seed = { name: "seed", type: "INT", value: 111 };
  const control = {
    name: "control_after_generate",
    type: "combo",
    value: mode,
    options: { values: [...CONTROL_AFTER_GENERATE_MODES], serialize: false, canvasOnly: true },
  };
  seed.linkedWidgets = [control];
  return regNode("KSampler", [seed, control, { name: "steps", type: "INT", value: 20 }]);
}

test("#558 e2e: writing a seed governed by 'randomize' SUCCEEDS but returns a warning", async () => {
  const node = ksamplerWithSeedControl("randomize");
  const res = await runSetWidget(node, "seed", 777777, wired());
  assert.equal(res.set.value, 777777); // the write took
  assert.match(res.warning, /control_after_generate='randomize'/);
  assert.match(res.warning, /will NOT persist/);
  assert.match(res.warning, /'fixed'/);
});

test("#558 e2e: writing a seed with 'fixed' control returns NO warning", async () => {
  const node = ksamplerWithSeedControl("fixed");
  const res = await runSetWidget(node, "seed", 777777, wired());
  assert.equal(res.set.value, 777777);
  assert.equal(res.warning, undefined);
});

test("#558 e2e: writing an unrelated widget (steps) returns NO warning even under randomize", async () => {
  const node = ksamplerWithSeedControl("randomize");
  const res = await runSetWidget(node, "steps", 30, wired());
  assert.equal(res.set.value, 30);
  assert.equal(res.warning, undefined);
});

test("#558 e2e: setting control_after_generate itself to 'fixed' is the fix — no warning", async () => {
  const node = ksamplerWithSeedControl("randomize");
  const res = await runSetWidget(node, "control_after_generate", "fixed", wired());
  assert.equal(res.set.value, "fixed");
  assert.equal(res.warning, undefined);
});

// A TWO-LEVEL nested promotion A→B→KSampler where control_after_generate lives on the
// CONCRETE KSampler (not the intermediate virtual B). The warning MUST be computed on
// the concrete node reached by following the promotion chain, not the immediate virtual
// target — otherwise a nested seed write reports no warning despite randomize (P1 in
// review). Mirrors makeNestedSubgraphFixture from set-widget-fresh-backend.test.mjs.
function nestedSeedControl(r, mode) {
  const seedW = { name: "seed", type: "INT", value: 111 };
  const controlW = {
    name: "control_after_generate",
    type: "combo",
    value: mode,
    options: { values: [...CONTROL_AFTER_GENERATE_MODES], serialize: false, canvasOnly: true },
  };
  seedW.linkedWidgets = [controlW];
  const concrete = {
    id: 90,
    type: "KSampler",
    widgets: [seedW, controlW],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const b = {
    id: 80,
    type: "SubgraphB",
    widgets: [{ name: "seed", type: "INT", value: 111 }],
    subgraph: { _nodes: [concrete], getNodeById: (id) => (String(id) === "90" ? concrete : null) },
    inputs: [{ name: "seed", _subgraphSlot: { name: "seed" } }],
  };
  const aRail = { name: "seed", type: "INT", value: 111 };
  const a = {
    id: 70,
    type: "SubgraphA",
    widgets: [aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "seed", _widget: aRail, widget: { name: "seed" }, _subgraphSlot: { name: "seed" } }],
  };
  r.SubgraphA = function SubgraphA() {};
  r.SubgraphB = function SubgraphB() {};
  const resolveSource = (sn, si) => {
    if (sn === a && si?.name === "seed") return { sourceNodeId: "80", sourceWidgetName: "seed" };
    if (sn === b && si?.name === "seed") return { sourceNodeId: "90", sourceWidgetName: "seed" };
    return null;
  };
  return { a, b, concrete, resolveSource };
}

test("#558 e2e NESTED: the warning is computed on the CONCRETE node's control (A→B→KSampler)", async () => {
  const r = reg();
  const { a, b, resolveSource } = nestedSeedControl(r, "randomize");
  const res = await runSetWidget(a, "seed", 777777, {
    registry: r,
    getRegistry: () => r,
    getFreshObjectInfo: async () => ({ KSampler: {} }), // SubgraphA/B are virtual, absent
    resolveSource,
    ...HOOKS,
  });
  assert.equal(res.set.value, 777777, "nested promoted seed write succeeds");
  assert.equal(b.widgets.find((w) => w.name === "seed").value, 777777);
  // The control lives on KSampler, reached by following the chain — warning must fire.
  assert.match(res.warning, /control_after_generate='randomize'/);
  assert.match(res.warning, /will NOT persist/);
});

test("#558 e2e NESTED: a 'fixed' concrete control yields NO warning", async () => {
  const r = reg();
  const { a, resolveSource } = nestedSeedControl(r, "fixed");
  const res = await runSetWidget(a, "seed", 777777, {
    registry: r,
    getRegistry: () => r,
    getFreshObjectInfo: async () => ({ KSampler: {} }),
    resolveSource,
    ...HOOKS,
  });
  assert.equal(res.set.value, 777777);
  assert.equal(res.warning, undefined);
});

// ---- #650: the warning's REMEDY must be executable from the CALLER'S scope ----
//
// Reported: setting a promoted seed on root node 78 returned
// `panel_set_widget(node_id=75, widget='control_after_generate', value='fixed')`.
// Node 75 is INSIDE the subgraph; following that at root returns "No node with id 75
// in the current graph". A remedy the caller cannot follow is worse than none — it
// reads as a working instruction and costs a round trip to discover otherwise.
//
// The reachability below is not inferred from names or shapes: it is read off the SAME
// promotion resolution the write was driven through.

// The reported shape: outer subgraph node 78 promotes `seed` from inner KSampler 75,
// whose control_after_generate is NOT promoted (ComfyUI marks it canvasOnly, so it has
// no connectable slot). `promoteControl` adds a legacy proxyWidgets-style promotion of
// the control widget itself, which makes it settable from the outer scope directly.
function promotedSeedFixture(r, mode, { promoteControl = false } = {}) {
  const seedW = { name: "seed", type: "INT", value: 111 };
  const controlW = {
    name: "control_after_generate",
    type: "combo",
    value: mode,
    options: { values: [...CONTROL_AFTER_GENERATE_MODES], serialize: false, canvasOnly: true },
  };
  seedW.linkedWidgets = [controlW];
  const inner = {
    id: 75,
    type: "KSampler",
    widgets: [seedW, controlW],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const rail = { name: "seed", type: "INT", value: 111 };
  const inputs = [{ name: "seed", _widget: rail, widget: { name: "seed" }, _subgraphSlot: { name: "seed" } }];
  const widgets = [rail];
  if (promoteControl) {
    const controlRail = { name: "control_after_generate", type: "combo", value: mode };
    inputs.push({
      name: "control_after_generate",
      _widget: controlRail,
      widget: { name: "control_after_generate" },
      _subgraphSlot: { name: "control_after_generate" },
    });
    widgets.push(controlRail);
  }
  const outer = {
    id: 78,
    type: "SubgraphOuter",
    widgets,
    subgraph: { _nodes: [inner], getNodeById: (id) => (String(id) === "75" ? inner : null) },
    inputs,
  };
  r.SubgraphOuter = function SubgraphOuter() {};
  const resolveSource = (sn, si) => {
    if (sn !== outer) return null;
    if (si?.name === "seed") return { sourceNodeId: "75", sourceWidgetName: "seed" };
    if (si?.name === "control_after_generate") {
      return { sourceNodeId: "75", sourceWidgetName: "control_after_generate" };
    }
    return null;
  };
  return { outer, inner, resolveSource };
}

test("#650: a PROMOTED seed write's remedy enters the owning subgraph — it never hands back a bare inner node id", async () => {
  const r = reg();
  const { outer, resolveSource } = promotedSeedFixture(r, "randomize");
  const res = await runSetWidget(outer, "seed", 777777, {
    registry: r,
    getRegistry: () => r,
    getFreshObjectInfo: async () => ({ KSampler: {} }),
    resolveSource,
    ...HOOKS,
  });
  assert.equal(res.set.value, 777777, "the write itself still succeeds");
  assert.match(res.warning, /control_after_generate='randomize'/);
  // The remedy must START by entering the owning subgraph…
  assert.match(res.warning, /panel_enter_subgraph\(node_id=78\)/);
  // …and it must say WHY the plain call would fail, so the caller is not left to
  // discover "No node with id 75 in the current graph" by running it.
  assert.match(res.warning, /node 75 does not exist in the graph you are addressing/);
  assert.match(res.warning, /panel_exit_subgraph\(\)/);
  // THE REASON, not the shape: the enter step must come BEFORE the inner-node write.
  assert.ok(
    res.warning.indexOf("panel_enter_subgraph(node_id=78)") <
      res.warning.indexOf("panel_set_widget(node_id=75"),
    "the enter step must precede the inner-node write, or the remedy is still unexecutable",
  );
});

test("#650: a DIRECT write's remedy is unchanged — no spurious enter step", async () => {
  // The scope correction must not add ceremony where the control widget is already
  // addressable. Deleting the scope logic would make this pass and the one above fail;
  // hard-coding the enter form would do the reverse. Both directions are pinned.
  const node = ksamplerWithSeedControl("randomize");
  const res = await runSetWidget(node, "seed", 777777, wired());
  assert.match(res.warning, /panel_set_widget\(node_id=3, widget='control_after_generate', value='fixed'\)/);
  assert.doesNotMatch(res.warning, /panel_enter_subgraph/);
  assert.doesNotMatch(res.warning, /does not exist in the graph you are addressing/);
});

test("#650 NESTED: the remedy enters EVERY container the promotion is driven through, in order", async () => {
  // A→B→KSampler. Entering A alone lands in A's subgraph, where node 90 still does not
  // exist — the remedy has to name B too, or it is unexecutable one level deeper.
  const r = reg();
  const { a, resolveSource } = nestedSeedControl(r, "randomize");
  const res = await runSetWidget(a, "seed", 777777, {
    registry: r,
    getRegistry: () => r,
    getFreshObjectInfo: async () => ({ KSampler: {} }),
    resolveSource,
    ...HOOKS,
  });
  assert.match(res.warning, /panel_enter_subgraph\(node_id=70\).*panel_enter_subgraph\(node_id=80\)/s);
  assert.ok(
    res.warning.indexOf("panel_enter_subgraph(node_id=80)") <
      res.warning.indexOf("panel_set_widget(node_id=90"),
    "both enters must precede the inner-node write",
  );
  assert.match(res.warning, /panel_exit_subgraph\(\) 2 times/);
});

test("#650 guard: a THROWING resolver while composing the warning never turns a COMPLETED write into a failure", async () => {
  // The warning is advisory and runs AFTER the write has landed and been verified. It
  // re-enters the promotion resolver to work out the caller's scope, and that resolver
  // is injected — a malformed or control-only promotion link can throw there. Refuse
  // before the action; disclose after it: an advisory failure must downgrade to a
  // disclosed gap, never to a reported failure for a write that already happened (the
  // caller would then "retry" a mutation it already made).
  const r = reg();
  const { outer, inner, resolveSource } = promotedSeedFixture(r, "randomize", { promoteControl: true });
  const seedWidget = inner.widgets.find((w) => w.name === "seed");
  // The SEED slot resolves normally, so the write itself runs its whole real path and
  // succeeds. The CONTROL slot — which only the advisory's scope walk ever looks up —
  // throws, standing in for the malformed/legacy promotion link that can do this live.
  const exploding = (sn, si) => {
    if (si?.name === "control_after_generate") throw new Error("promotion link is malformed");
    return resolveSource(sn, si);
  };
  const res = await runSetWidget(outer, "seed", 777777, {
    registry: r,
    getRegistry: () => r,
    getFreshObjectInfo: async () => ({ KSampler: {} }),
    resolveSource: exploding,
    ...HOOKS,
  });
  // The write is reported as the success it was, and the mutation is real.
  assert.equal(res.set.value, 777777);
  assert.equal(seedWidget.value, 777777, "the write landed on the inner node");
  // …and the gap is DISCLOSED as unknown, not silently swallowed into "no control".
  assert.match(res.warning, /The write SUCCEEDED and was verified/);
  assert.match(res.warning, /UNKNOWN, not as "no control"/);
  assert.match(res.warning, /promotion link is malformed/);
});

test("#650: when the CONTROL widget is itself promoted, the remedy sets it on the OUTER node with no entering", async () => {
  // The best remedy available: a legacy proxyWidgets promotion exposes the control on
  // the boundary, so it IS settable from the caller's scope. Asserted as an OBSERVED
  // promotion — resolved through the same resolver the write used — never assumed.
  const r = reg();
  const { outer, resolveSource } = promotedSeedFixture(r, "randomize", { promoteControl: true });
  const res = await runSetWidget(outer, "seed", 777777, {
    registry: r,
    getRegistry: () => r,
    getFreshObjectInfo: async () => ({ KSampler: {} }),
    resolveSource,
    ...HOOKS,
  });
  assert.match(res.warning, /is promoted onto subgraph node 78 as "control_after_generate"/);
  assert.match(res.warning, /panel_set_widget\(node_id=78, widget='control_after_generate', value='fixed'\)/);
  assert.doesNotMatch(res.warning, /panel_enter_subgraph/);
});
