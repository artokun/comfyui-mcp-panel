// #1271 — panel_promote_widget on frontend 1.48.7: the 'promotion' Pinia store
// is gone, preview widgets ($$canvas-image-preview) live in `previewExposure`,
// and a failed link-only promote must not hide behind "no 'promotion' store".
//
// graph_promote_widget lives inline in GRAPH_TOOL_EXECUTORS (browser/ComfyUI
// globals), so this extracts the REAL helper block + the shipped method and
// evaluates them via `new Function`. The tests drive that function, not a copy.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findSubgraphOwner } from "../../web/js/lib/subgraph-scope.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

function panelFunctionStart(src, name, from = 0) {
  const bare = src.indexOf(`function ${name}(`, from);
  assert.notEqual(bare, -1, `could not locate ${name} in panel source`);
  return bare;
}

const helpersSrc = panelSrc.slice(
  panelFunctionStart(panelSrc, "getPiniaStore"),
  panelFunctionStart(panelSrc, "describeActiveGraph"),
);
const methodMatch = panelSrc.match(/graph_promote_widget\(\{ node_id, widget, demote \}\) \{[\s\S]*?\n  \},/);
assert.ok(methodMatch, "could not locate graph_promote_widget in panel source");

function realPromoteWidget(document, getGraphCtx, resolveNode, pressableWidgetHint = () => "", findSubgraphOwnerFn = findSubgraphOwner) {
  return new Function(
    "document",
    "getGraphCtx",
    "resolveNode",
    "pressableWidgetHint",
    "findSubgraphOwner",
    `${helpersSrc}
     const executors = { ${methodMatch[0]} };
     return executors.graph_promote_widget;`,
  )(document, getGraphCtx, resolveNode, pressableWidgetHint, findSubgraphOwnerFn);
}

/** Pinia as getPiniaStore finds it: #vue-app → __vue_app__ → $pinia._s.get(id). */
function mockDocument(stores) {
  const map = new Map(Object.entries(stores));
  return {
    getElementById(id) {
      if (id !== "vue-app") return null;
      return {
        __vue_app__: {
          config: { globalProperties: { $pinia: { _s: { get: (k) => map.get(k) ?? null } } } },
        },
      };
    },
    querySelector() {
      return null;
    },
  };
}

/** Minimal previewExposure store — same (rootGraphId, hostLocator) key and
 *  addExposure/getExposures/removeExposure shape as ComfyUI_frontend 1.48. */
function makePreviewStore() {
  const byHost = new Map();
  const calls = { add: [], remove: [] };
  const keyOf = (rootGraphId, hostId) => `${rootGraphId}|${hostId}`;
  return {
    calls,
    getExposures(rootGraphId, hostId) {
      return byHost.get(keyOf(rootGraphId, hostId)) ?? [];
    },
    addExposure(rootGraphId, hostId, source) {
      calls.add.push({ rootGraphId, hostId, source });
      const key = keyOf(rootGraphId, hostId);
      const entry = {
        name: source.sourcePreviewName,
        sourceNodeId: String(source.sourceNodeId),
        sourcePreviewName: source.sourcePreviewName,
      };
      byHost.set(key, [...(byHost.get(key) ?? []), entry]);
      return entry;
    },
    removeExposure(rootGraphId, hostId, name) {
      calls.remove.push({ rootGraphId, hostId, name });
      const key = keyOf(rootGraphId, hostId);
      byHost.set(
        key,
        (byHost.get(key) ?? []).filter((e) => e.name !== name),
      );
    },
  };
}

function makeLegacyPromotionStore() {
  const calls = [];
  return {
    calls,
    promote(...args) {
      calls.push(["promote", ...args]);
    },
    demote(...args) {
      calls.push(["demote", ...args]);
    },
  };
}

function makeHarness({
  stores = {},
  innerWidgets = [{ name: "steps", type: "number" }],
  slotFor = (widget) =>
    String(widget?.name ?? "").startsWith("$$")
      ? null
      : { name: widget.name, type: widget.type ?? "*", label: widget.label, widget: { name: widget.name } },
  linkConnects = true,
  atRoot = false,
} = {}) {
  const parentInputs = [];
  const subgraph = {
    inputs: [],
    addInput(name, type) {
      const input = {
        name,
        type,
        label: undefined,
        connect(_slot, _node) {
          return linkConnects ? { id: 1 } : null;
        },
      };
      this.inputs.push(input);
      parentInputs.push({ name, type, _subgraphSlot: input });
      return input;
    },
    removeInput(input) {
      this.inputs = this.inputs.filter((entry) => entry !== input);
      const idx = parentInputs.findIndex((entry) => entry._subgraphSlot === input);
      if (idx >= 0) parentInputs.splice(idx, 1);
    },
  };
  const parent = {
    id: 10,
    subgraph,
    inputs: parentInputs,
    rootGraph: { id: "root-uuid" },
    computeSize() {},
    setDirtyCanvas() {},
    invalidatePromotedViews() {},
  };
  const inner = {
    id: 3,
    type: "KSampler",
    widgets: innerWidgets,
    getSlotFromWidget(widget) {
      return slotFor(widget);
    },
  };
  const events = [];
  const subgraphGraph = {
    beforeChange() {
      events.push("before");
    },
    afterChange() {
      events.push("after");
    },
  };
  const rootGraph = { id: "root-uuid", _nodes: [parent] };
  const canvas = { setDirty() {} };
  const getGraphCtx = () =>
    atRoot
      ? { graph: rootGraph, canvas, rootGraph }
      : { graph: subgraphGraph, canvas, rootGraph };
  // The parent lookup is `n.subgraph === graph`. Inside a subgraph the active
  // graph IS the Subgraph object, not a wrapper — so parent.subgraph must be
  // the same reference getGraphCtx returns as `graph`.
  if (!atRoot) parent.subgraph = subgraphGraph;
  Object.assign(subgraphGraph, {
    addInput: subgraph.addInput.bind(subgraph),
    removeInput: subgraph.removeInput.bind(subgraph),
    inputs: subgraph.inputs,
  });
  // promoteWidgetByLink reads subgraphNode.subgraph.addInput — keep that
  // pointing at the same Subgraph methods after we retarget parent.subgraph.
  parent.subgraph.addInput = subgraph.addInput.bind(subgraph);
  parent.subgraph.removeInput = subgraph.removeInput.bind(subgraph);
  if (!parent.subgraph.inputs) parent.subgraph.inputs = subgraph.inputs;

  const fn = realPromoteWidget(
    mockDocument(stores),
    getGraphCtx,
    (_g, id) => {
      if (Number(id) === Number(inner.id)) return inner;
      throw new Error(`No node with id ${id} in the current graph`);
    },
  );
  return { fn, events, parent, inner, subgraph, stores };
}

const PREVIEW = "$$canvas-image-preview";

test("#1271 a $$ preview widget is promoted through previewExposure, not the gone promotion store", () => {
  const preview = makePreviewStore();
  const { fn, events } = makeHarness({
    stores: { previewExposure: preview },
    innerWidgets: [{ name: PREVIEW, type: "IMAGE_PREVIEW", serialize: false }],
  });

  const result = fn({ node_id: 3, widget: PREVIEW });

  assert.equal(result.strategy, "preview-exposure");
  assert.equal(result.promoted, PREVIEW);
  assert.deepEqual(result.on_subgraph_nodes, [10]);
  assert.equal(preview.calls.add.length, 1, "addExposure must run");
  assert.deepEqual(preview.calls.add[0], {
    rootGraphId: "root-uuid",
    hostId: "10",
    source: { sourceNodeId: "3", sourcePreviewName: PREVIEW },
  });
  assert.equal(preview.calls.remove.length, 0);
  assert.deepEqual(events, ["before", "after"], "must open and close the undo envelope");
});

test("#1271 demote of a preview exposure calls removeExposure by the store's name", () => {
  const preview = makePreviewStore();
  preview.addExposure("root-uuid", "10", { sourceNodeId: "3", sourcePreviewName: PREVIEW });
  preview.calls.add.length = 0;
  const { fn } = makeHarness({
    stores: { previewExposure: preview },
    innerWidgets: [{ name: PREVIEW, type: "IMAGE_PREVIEW", serialize: false }],
  });

  const result = fn({ node_id: 3, widget: PREVIEW, demote: true });

  assert.equal(result.strategy, "preview-exposure");
  assert.equal(result.demoted, PREVIEW);
  assert.equal(preview.calls.add.length, 0);
  assert.deepEqual(preview.calls.remove, [{ rootGraphId: "root-uuid", hostId: "10", name: PREVIEW }]);
});

test("#1271 a second promote of the same preview is idempotent", () => {
  const preview = makePreviewStore();
  const { fn } = makeHarness({
    stores: { previewExposure: preview },
    innerWidgets: [{ name: PREVIEW, type: "IMAGE_PREVIEW", serialize: false }],
  });

  fn({ node_id: 3, widget: PREVIEW });
  const again = fn({ node_id: 3, widget: PREVIEW });

  assert.equal(again.strategy, "preview-exposure");
  assert.equal(preview.calls.add.length, 1, "must not add a duplicate exposure");
});

test("#1271 a value widget with a slot still promotes link-only (no store required)", () => {
  const { fn, parent } = makeHarness({
    innerWidgets: [{ name: "steps", type: "number" }],
  });

  const result = fn({ node_id: 3, widget: "steps" });

  assert.equal(result.strategy, "link-only");
  assert.equal(result.promoted, "steps");
  assert.equal(parent.inputs.length, 1, "a subgraph input must have been added");
  assert.equal(parent.inputs[0]._subgraphSlot?.name, "steps");
});

test("#1271 a failed link-only promote no longer hides behind 'no promotion store'", () => {
  // The reported bug: a widget with no connectable slot fails the primary path,
  // then the 1.48 frontend has no 'promotion' store, and the user only saw that
  // second error. Both must be in the thrown message.
  const { fn } = makeHarness({
    innerWidgets: [{ name: "cfg", type: "number" }],
    slotFor: () => null,
  });

  assert.throws(
    () => fn({ node_id: 3, widget: "cfg" }),
    (err) => {
      assert.match(err.message, /not backed by a connectable input slot/);
      assert.match(err.message, /no 'promotion' store/);
      return true;
    },
  );
});

test("#1271 a preview widget without previewExposure still reports the real link-path error", () => {
  // 1.48.7 always has previewExposure. This is the "store gone AND preview
  // detector missed" path: do not regress to masking the slot error.
  const { fn } = makeHarness({
    innerWidgets: [{ name: PREVIEW, type: "IMAGE_PREVIEW", serialize: false }],
    slotFor: () => null,
  });

  assert.throws(
    () => fn({ node_id: 3, widget: PREVIEW }),
    (err) => {
      assert.match(err.message, /not backed by a connectable input slot/);
      assert.match(err.message, /no 'promotion' store/);
      return true;
    },
  );
});

test("#1271 a failed link-only promote still uses the legacy store when it exists", () => {
  const legacy = makeLegacyPromotionStore();
  const { fn } = makeHarness({
    stores: { promotion: legacy },
    innerWidgets: [{ name: "cfg", type: "number" }],
    slotFor: () => null,
  });

  const result = fn({ node_id: 3, widget: "cfg" });

  assert.equal(result.strategy, "legacy-store");
  assert.equal(legacy.calls.length, 1);
  assert.equal(legacy.calls[0][0], "promote");
  assert.equal(legacy.calls[0][1], "root-uuid");
  assert.equal(legacy.calls[0][2], 10);
  assert.deepEqual(legacy.calls[0][3], { sourceNodeId: "3", sourceWidgetName: "cfg" });
});

test("#1271 a type-preview widget (no $$ prefix) still uses previewExposure", () => {
  const preview = makePreviewStore();
  const { fn } = makeHarness({
    stores: { previewExposure: preview },
    innerWidgets: [{ name: "ui", type: "video", serialize: false }],
  });

  const result = fn({ node_id: 3, widget: "ui" });

  assert.equal(result.strategy, "preview-exposure");
  assert.equal(preview.calls.add[0].source.sourcePreviewName, "ui");
});

test("#1271 refuse at the root — promotion is an inner-widget operation", () => {
  const { fn } = makeHarness({ atRoot: true });
  assert.throws(() => fn({ node_id: 3, widget: "steps" }), /Enter the subgraph first/);
});

test("#2321 nested subgraph: promote from innermost graph (root → 142 → 133 → inner node)", () => {
  // Build the reported shape: root → outer(142) → inner(133) → node to promote
  // The parent lookup must walk the FULL hierarchy, not just rootGraph._nodes.

  // Inner subgraph inputs (for node 133)
  const innerSubgraphInputs = [];
  const addInnerInput = (name, type) => {
    const input = {
      name,
      type,
      label: undefined,
      connect(_slot, _node) {
        return { id: 1 };  // linkConnects = true
      },
    };
    innerSubgraphInputs.push(input);
    return input;
  };

  // Innermost graph (node 133's subgraph)
  const innermostSubgraph = {
    id: "subgraph-133-uuid",
    inputs: [],
    addInput() {},
    removeInput() {},
    beforeChange() {},
    afterChange() {},
  };

  // Inner node (the node we're promoting a widget from) - lives in innermostSubgraph
  const innerNode = {
    id: 50,
    type: "KSampler",
    widgets: [{ name: "steps", type: "number" }],
    getSlotFromWidget: (w) => w ? { name: w.name, type: "*", label: w.label, widget: { name: w.name } } : null,
  };

  // Middle graph (node 142's subgraph) - contains node 133
  const middleSubgraphInputs = [];
  const middleSubgraph = {
    id: "subgraph-142-uuid",
    _nodes: [],
    inputs: middleSubgraphInputs,
    addInput(name, type) {
      const input = {
        name,
        type,
        label: undefined,
        connect(_slot, _node) {
          return { id: 1 };
        },
      };
      this.inputs.push(input);
      return input;
    },
    removeInput(input) {
      this.inputs = this.inputs.filter((x) => x !== input);
    },
    beforeChange() {},
    afterChange() {},
  };

  // Node 133 (inner SubgraphNode) - lives in middleSubgraph, owns innermostSubgraph
  const node133 = {
    id: 133,
    subgraph: innermostSubgraph,  // This node owns the innermost graph
    inputs: innerSubgraphInputs,
    rootGraph: { id: "root-uuid" },
    computeSize() {},
    setDirtyCanvas() {},
    invalidatePromotedViews() {},
  };
  middleSubgraph._nodes.push(node133);

  // Root graph - contains node 142
  const rootGraph = {
    id: "root-uuid",
    _nodes: [],
    inputs: [],
  };

  // Node 142 (outer SubgraphNode) - lives in rootGraph, owns middleSubgraph
  const node142 = {
    id: 142,
    subgraph: middleSubgraph,  // This node owns the middle graph
    inputs: middleSubgraphInputs,
    rootGraph,
    computeSize() {},
    setDirtyCanvas() {},
    invalidatePromotedViews() {},
  };
  rootGraph._nodes.push(node142);

  // Wire node 133's subgraph to the middle graph
  innermostSubgraph.addInput = (name, type) => {
    const input = {
      name,
      type,
      label: undefined,
      connect(_slot, _node) {
        return { id: 1 };
      },
    };
    innerSubgraphInputs.push(input);
    return input;
  };
  innermostSubgraph.removeInput = (input) => {
    const idx = innerSubgraphInputs.indexOf(input);
    if (idx >= 0) innerSubgraphInputs.splice(idx, 1);
  };

  // Create the promotion function
  const fn = realPromoteWidget(
    mockDocument({ previewExposure: makePreviewStore() }),
    () => ({ graph: innermostSubgraph, canvas: { setDirty() {} }, rootGraph }),
    (_g, id) => {
      if (Number(id) === innerNode.id) return innerNode;
      throw new Error(`No node with id ${id} in the current graph`);
    },
  );

  // The promotion should work: find node 133 as the parent
  const result = fn({ node_id: innerNode.id, widget: "steps" });

  // The fix walks ALL graphs; without it, it only searches rootGraph._nodes
  // and finds nothing because node 133 is not there (it's inside middleSubgraph).
  assert.equal(result.promoted, "steps", "promotion should succeed");
  assert.equal(result.from_node, innerNode.id, "source node should be inner");
  assert.deepEqual(result.on_subgraph_nodes, [133], "must find node 133 as the parent");
});
