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
