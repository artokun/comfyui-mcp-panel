/**
 * #1087 — a DIRECT write to a LINK-DRIVEN widget reports success and does not reach the
 * render. Run against runSetWidget (web/js/lib/set-widget.js), the same async unit
 * GRAPH_TOOL_EXECUTORS.graph_set_widget delegates to.
 *
 * The reported case: an inner subgraph node whose `steps` is driven from a promoted parent
 * rail. `panel_set_widget(node_id=3, widget="steps", value=10)` returned
 * `{previous:14, value:10}` with no warning, and the queue sampled at 14 because the rail's
 * value is what serializes.
 *
 * The trap these tests exist to hold: on the WORKING parent→inner path the inner widget is
 * ALSO link-driven, so an ungated check fires on precisely the writes that are correct.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";

const HOOKS = { beforeChange() {}, afterChange() {}, setDirty() {} };

function mkCtor() {
  const c = function NodeCtor() {};
  c.nodeData = { input: { required: {} } };
  return c;
}
function wired(extra = {}) {
  const r = { KSampler: mkCtor() };
  return { registry: r, getRegistry: () => r, getFreshObjectInfo: async () => ({ KSampler: {} }), ...HOOKS, ...extra };
}

/** An inner KSampler whose `steps` input carries a link — what a promoted parent rail
 *  looks like from inside the subgraph. Node id 3 and steps=14 mirror the report. */
function innerKSampler({ linked }) {
  const graph = { links: { 4: { origin_id: -10, origin_slot: 4 } } };
  return {
    id: 3,
    type: "KSampler",
    constructor: mkCtor(),
    graph,
    widgets: [{ name: "steps", type: "INT", value: 14 }],
    inputs: linked ? [{ name: "steps", link: 4 }] : [{ name: "steps", link: null }],
  };
}

test("#1087: a direct write to a link-driven widget warns that it will not reach the render", async () => {
  const node = innerKSampler({ linked: true });
  const res = await runSetWidget(node, "steps", 10, wired());

  // The write itself still lands and is still reported — the report asked for a warning,
  // not a refusal, because setting a subgraph's stored default is legitimate work.
  assert.equal(res.set.value, 10);
  assert.equal(res.set.previous, 14);
  assert.equal(node.widgets[0].value, 10);

  assert.ok(res.warning, "a silent success is the bug — there must be a warning");
  assert.match(res.warning, /will NOT change the render/);
  assert.match(res.warning, /link-driven/);
  assert.match(res.warning, /#-10\.4/, "names the link origin the outline already reports");
  assert.match(res.warning, /panel_exit_subgraph/, "and the remedy is executable");
});

test("#1087: an ordinary (unlinked) widget write is unchanged — no warning", async () => {
  const node = innerKSampler({ linked: false });
  const res = await runSetWidget(node, "steps", 10, wired());
  assert.equal(res.set.value, 10);
  assert.equal(res.warning, undefined, "the everyday write must not grow a warning");
});

test("#1087: a widget whose node has NO inputs at all is unaffected", async () => {
  const node = {
    id: 3,
    type: "KSampler",
    constructor: mkCtor(),
    graph: { links: {} },
    widgets: [{ name: "steps", type: "INT", value: 14 }],
  };
  const res = await runSetWidget(node, "steps", 10, wired());
  assert.equal(res.set.value, 10);
  assert.equal(res.warning, undefined);
});

test("#1087: a link on a DIFFERENT input does not warn about this widget", async () => {
  // Only the input matching the widget's own name makes that widget link-driven; a linked
  // `model` input is an ordinary connection and says nothing about `steps`.
  const node = innerKSampler({ linked: false });
  node.inputs = [{ name: "model", link: 4 }, { name: "steps", link: null }];
  const res = await runSetWidget(node, "steps", 10, wired());
  assert.equal(res.warning, undefined);
});

test("#1087: a dangling link id does not fabricate a warning", async () => {
  // linkDrivenWidgets skips an input whose link id resolves to nothing, so a stale link
  // reference cannot make a perfectly writable widget look unreachable.
  const node = innerKSampler({ linked: true });
  node.graph.links = {}; // the link id no longer resolves
  const res = await runSetWidget(node, "steps", 10, wired());
  assert.equal(res.warning, undefined);
});

/**
 * The trap. On the WORKING parent→inner path the inner widget is link-driven too, so an
 * ungated check would warn on exactly the writes that already succeed end-to-end — the ones
 * reporting `parent_widget_synced: true`. Fixture shape mirrors widget-write.test.mjs's
 * promoted-subgraph fixture: the parent's authoritative rail is object-identity linked from
 * the host input via `_widget`, and `widget` is only a name stub, as in real ComfyUI.
 */
function makePromotedFixture() {
  const inner = {
    id: 54,
    type: "KSampler",
    // A genuinely-resolved instance (live def on the constructor), or the placeholder guard
    // refuses before the advisory this test is about ever runs.
    constructor: mkCtor(),
    // Inside the subgraph, the promoted input arrives as a LINK — the same shape that makes
    // a direct inner write unreachable.
    graph: { links: { 7: { origin_id: -10, origin_slot: 4 } } },
    inputs: [{ name: "steps", link: 7 }],
    widgets: [{ name: "steps", type: "INT", value: 14 }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) };
  const railWidget = { name: "steps", type: "INT", value: 14 };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    constructor: mkCtor(),
    subgraph,
    graph: { links: {} },
    inputs: [{ name: "steps", _widget: railWidget, widget: { name: "steps" }, _subgraphSlot: { name: "steps" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_node, subgraphInput) =>
    subgraphInput?.name === "steps" ? { sourceNodeId: "54", sourceWidgetName: "steps" } : null;
  return { parent, inner, railWidget, resolveSource };
}

test("#1087 TRAP: the working PARENT-addressed promoted write must NOT warn", async () => {
  const { parent, inner, railWidget, resolveSource } = makePromotedFixture();
  const r = { SubgraphNode: mkCtor(), KSampler: mkCtor() };
  const res = await runSetWidget(parent, "steps", 10, {
    registry: r,
    getRegistry: () => r,
    getFreshObjectInfo: async () => ({ SubgraphNode: {}, KSampler: {} }),
    resolveSource,
    ...HOOKS,
  });

  // This is the path that already works: both sides land and the render uses the new value.
  assert.equal(inner.widgets[0].value, 10, "inner widget written");
  assert.equal(railWidget.value, 10, "and the authoritative parent rail synced");
  assert.equal(res.set?.promoted_from?.parent_widget_synced, true);
  assert.equal(
    res.warning,
    undefined,
    "a warning here would fire on a correct write — the false positive to avoid",
  );
});

/**
 * MUTATION NOTE, recorded where someone would otherwise delete the wrong line: the check is
 * driven by reading the node the CALLER ADDRESSED (`node`) rather than the resolved write
 * target. Removing the `isResolvedPromotion` guard leaves the test above GREEN — that guard
 * is belt-and-braces, not the mechanism. Changing the read to `authTarget` is what would
 * break it, and that is the edit this file is really guarding.
 */
test("#1087: the check reads the ADDRESSED node — a promoted parent is not link-driven", async () => {
  const { parent } = makePromotedFixture();
  // Stated as a property rather than left implicit in the test above: the SubgraphNode's
  // host input carries _widget/_subgraphSlot and NO `link`, which is why asking it the
  // question yields nothing to warn about.
  assert.equal(parent.inputs[0].link, undefined, "a promoted host input has no link");
  assert.ok(parent.inputs[0]._widget, "it carries an identity-linked rail projection instead");
});
