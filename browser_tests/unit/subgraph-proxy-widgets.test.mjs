// #2005 — panel_save_subgraph must accept promoted legacy proxyWidgets
// object/null metadata by rewriting it to the string-tuple schema the
// frontend publisher validates, or refuse with a repair action before
// publishSubgraph is invoked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyLegacyProxyWidgetEntry,
  legacyProxyWidgetsRefusalMessage,
  normalizeLegacyProxyWidgets,
  prepareSubgraphProxyWidgetsForPublish,
} from "../../web/js/lib/subgraph-proxy-widgets.js";

function inner(id, widgetNames) {
  return {
    id,
    type: "KSamplerAdvanced",
    widgets: widgetNames.map((name) => ({ name, value: `${name}-inner` })),
  };
}

function subgraphNode(proxyWidgets, { nodes = [inner(6, ["seed", "control_after_generate"])], widgets = [], inputs = [] } = {}) {
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  return {
    id: 10,
    title: "Sampling Core",
    widgets: [...widgets],
    inputs: [...inputs],
    properties: { proxyWidgets },
    subgraph: {
      _nodes: nodes,
      getNodeById(id) {
        return byId.get(String(id)) ?? null;
      },
    },
  };
}

test("#2005 already-canonical string tuples pass through unchanged", () => {
  const raw = [
    ["6", "seed"],
    ["6", "control_after_generate"],
  ];
  const result = normalizeLegacyProxyWidgets(raw, {
    subgraphNode: subgraphNode(raw),
  });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.tuples, raw);
});

test("#2005 numeric node ids coerce to the string schema", () => {
  const node = subgraphNode([[6, "seed"]]);
  const result = normalizeLegacyProxyWidgets(node.properties.proxyWidgets, { subgraphNode: node });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.tuples, [["6", "seed"]]);
});

test("#2005 a 3-string tuple is kept (the publisher accepts it)", () => {
  const raw = [["6", "seed", "INT"]];
  const result = normalizeLegacyProxyWidgets(raw, { subgraphNode: subgraphNode(raw) });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.tuples, raw);
});

test("#2005 absent proxyWidgets is a no-op, not an empty rewrite", () => {
  const node = subgraphNode(undefined);
  delete node.properties.proxyWidgets;
  const result = prepareSubgraphProxyWidgetsForPublish(node);
  assert.equal(result.changed, false);
  assert.equal(node.properties.proxyWidgets, undefined);
});

test("#2005 the reported legacy-store shape [sourceObject, null] resolves", () => {
  const source = { sourceNodeId: "6", sourceWidgetName: "control_after_generate" };
  const node = subgraphNode([["6", "seed"], ["6", "steps"], ["6", "cfg"], [source, null]], {
    nodes: [inner(6, ["seed", "steps", "cfg", "control_after_generate"])],
  });
  const result = normalizeLegacyProxyWidgets(node.properties.proxyWidgets, { subgraphNode: node });
  assert.equal(result.ok, true);
  assert.equal(result.resolved, 1);
  assert.deepEqual(result.tuples[3], ["6", "control_after_generate"]);
});

test("#2005 interiorNodeId/widgetName objects resolve the same way", () => {
  const node = subgraphNode([[{ interiorNodeId: 6, widgetName: "seed" }, null]]);
  const result = normalizeLegacyProxyWidgets(node.properties.proxyWidgets, { subgraphNode: node });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tuples, [["6", "seed"]]);
});

test("#2005 null placeholders are dropped, not rewritten into empty strings", () => {
  const node = subgraphNode([["6", "seed"], null, [null, null], []]);
  const result = normalizeLegacyProxyWidgets(node.properties.proxyWidgets, { subgraphNode: node });
  assert.equal(result.ok, true);
  assert.equal(result.dropped, 3);
  assert.deepEqual(result.tuples, [["6", "seed"]]);
});

test("#2005 a live widget object is resolved by identity, not by guessing .id", () => {
  const control = { name: "control_after_generate", type: "combo", value: "randomize", id: "widget-uuid" };
  const ksampler = { id: 6, type: "KSamplerAdvanced", widgets: [{ name: "seed", value: 1 }, control] };
  const node = subgraphNode([[control, null]], { nodes: [ksampler] });
  const result = normalizeLegacyProxyWidgets(node.properties.proxyWidgets, { subgraphNode: node });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tuples, [["6", "control_after_generate"]]);
});

test("#2005 a widget object's own .id is never treated as the inner node id", () => {
  const classified = classifyLegacyProxyWidgetEntry(
    [{ name: "control_after_generate", id: "widget-uuid" }, null],
    subgraphNode([["6", "seed"]], { nodes: [inner(6, ["seed"])] }),
  );
  assert.equal(classified.kind, "refuse");
  assert.notEqual(classified.nodeId, "widget-uuid");
});

test("#2005 [innerNode, widgetName] resolves from the node object", () => {
  const ksampler = inner(6, ["seed", "control_after_generate"]);
  ksampler.name = "KSampler Advanced";
  const node = subgraphNode([[ksampler, "control_after_generate"]], { nodes: [ksampler] });
  const result = normalizeLegacyProxyWidgets(node.properties.proxyWidgets, { subgraphNode: node });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tuples, [["6", "control_after_generate"]]);
});

test("#2005 an object that names a missing inner widget refuses", () => {
  const node = subgraphNode([[{ sourceNodeId: "6", sourceWidgetName: "does_not_exist" }, null]]);
  const result = normalizeLegacyProxyWidgets(node.properties.proxyWidgets, { subgraphNode: node });
  assert.equal(result.ok, false);
  assert.equal(result.affected[0].nodeId, "6");
  assert.equal(result.affected[0].widgetName, "does_not_exist");
  assert.match(result.affected[0].reason, /not on the live subgraph/);
});

test("#2005 an unreadable object without identifiers refuses at that index", () => {
  const node = subgraphNode([["6", "seed"], [{}, null]]);
  const result = normalizeLegacyProxyWidgets(node.properties.proxyWidgets, { subgraphNode: node });
  assert.equal(result.ok, false);
  assert.equal(result.affected[0].index, 1);
  assert.match(legacyProxyWidgetsRefusalMessage(result.affected), /index 1/);
  assert.match(
    legacyProxyWidgetsRefusalMessage(result.affected),
    /panel_promote_widget|demote/,
  );
});

test("#2005 an ambiguous inner widget name is not guessed", () => {
  const widget = { name: "seed", type: "INT", value: 1 };
  const node = subgraphNode([[widget, null]], {
    nodes: [
      { id: 6, widgets: [{ name: "seed", value: 1 }] },
      { id: 7, widgets: [{ name: "seed", value: 2 }] },
    ],
  });
  const result = normalizeLegacyProxyWidgets(node.properties.proxyWidgets, { subgraphNode: node });
  assert.equal(result.ok, false);
  assert.match(result.affected[0].reason, /not which inner node|no inner node id/i);
});

test("#2005 a unique inner widget name is enough when the object has no node id", () => {
  const node = subgraphNode([[{ name: "control_after_generate" }, null]]);
  const result = normalizeLegacyProxyWidgets(node.properties.proxyWidgets, { subgraphNode: node });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tuples, [["6", "control_after_generate"]]);
});

test("#2005 a four-slot tuple is unreadable, not silently trimmed", () => {
  const node = subgraphNode([["6", "seed", "INT", "extra"]]);
  const result = normalizeLegacyProxyWidgets(node.properties.proxyWidgets, { subgraphNode: node });
  assert.equal(result.ok, false);
  assert.match(result.affected[0].reason, /more than three/);
});

test("#2005 a non-array proxyWidgets property refuses rather than inventing []", () => {
  const result = normalizeLegacyProxyWidgets("seed", { subgraphNode: subgraphNode(["seed"]) });
  assert.equal(result.ok, false);
  assert.match(result.affected[0].reason, /not an array/);
});

test("#2005 already-canonical tuples are not re-proved against the inner graph", () => {
  // A quarantined promotion can remain as a string tuple after load. Save must
  // still publish it — re-checking would refuse graphs the frontend is holding.
  const raw = [["99", "ghost"]];
  const result = normalizeLegacyProxyWidgets(raw, { subgraphNode: subgraphNode(raw) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tuples, raw);
});

test("#2005 prepare writes the string tuples onto the live node", () => {
  const source = { sourceNodeId: "6", sourceWidgetName: "control_after_generate" };
  const node = subgraphNode([
    ["6", "seed"],
    [source, null],
    null,
  ]);
  const result = prepareSubgraphProxyWidgetsForPublish(node);
  assert.equal(result.changed, true);
  assert.equal(result.resolved, 1);
  assert.equal(result.dropped, 1);
  assert.deepEqual(node.properties.proxyWidgets, [
    ["6", "seed"],
    ["6", "control_after_generate"],
  ]);
});

test("#2005 prepare is a no-op when the metadata is already string tuples", () => {
  const node = subgraphNode([["6", "seed"]]);
  const original = node.properties.proxyWidgets;
  const result = prepareSubgraphProxyWidgetsForPublish(node);
  assert.equal(result.changed, false);
  assert.equal(node.properties.proxyWidgets, original);
});

test("#2005 prepare refuses and restores when rewriting would drop a rail value", () => {
  const source = { sourceNodeId: "6", sourceWidgetName: "seed" };
  const node = subgraphNode([[source, null]], {
    widgets: [{ name: "seed", value: "before" }],
  });
  let stored = node.properties.proxyWidgets;
  Object.defineProperty(node.properties, "proxyWidgets", {
    configurable: true,
    enumerable: true,
    get() {
      return stored;
    },
    set(next) {
      stored = next;
      node.widgets = [];
    },
  });
  assert.throws(
    () => prepareSubgraphProxyWidgetsForPublish(node),
    (err) => {
      assert.match(err.message, /would not preserve promoted values or rail bindings/);
      return true;
    },
  );
  assert.equal(stored[0][0], source);
});

test("#2005 prepare refuses an unproven mapping before any write", () => {
  const node = subgraphNode([[{ sourceNodeId: "6", sourceWidgetName: "missing" }, null]]);
  const original = node.properties.proxyWidgets;
  assert.throws(
    () => prepareSubgraphProxyWidgetsForPublish(node),
    (err) => {
      assert.match(err.message, /panel_save_subgraph cannot publish/);
      assert.match(err.message, /inner node 6 widget "missing"/);
      assert.match(err.message, /panel_promote_widget\(\{node_id: "6", widget: "missing", demote: true\}\)/);
      return true;
    },
  );
  assert.equal(node.properties.proxyWidgets, original);
});

test("#2005 additive host widgets after a successful rewrite are not a loss", () => {
  const source = { sourceNodeId: "6", sourceWidgetName: "control_after_generate" };
  const node = subgraphNode([["6", "seed"], [source, null]], {
    widgets: [{ name: "seed", value: 111 }],
    inputs: [{ name: "seed", link: 9, widgetId: "w-seed" }],
  });
  const result = prepareSubgraphProxyWidgetsForPublish(node);
  assert.equal(result.changed, true);
  assert.equal(node.widgets[0].value, 111);
  assert.equal(node.inputs[0].link, 9);
});

test("#2005 host-level -1 promotions coerce without looking up an inner node", () => {
  const node = subgraphNode([[-1, "seed"]], {
    widgets: [{ name: "seed", value: 1 }],
    nodes: [inner(6, ["steps"])],
  });
  const result = normalizeLegacyProxyWidgets(node.properties.proxyWidgets, { subgraphNode: node });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tuples, [["-1", "seed"]]);
});

test("#2005 mixed canonical and legacy entries keep order of the real promotions", () => {
  const node = subgraphNode([
    ["6", "seed"],
    [{ sourceNodeId: "6", sourceWidgetName: "control_after_generate" }, null],
    null,
    ["6", "cfg"],
  ], {
    nodes: [inner(6, ["seed", "cfg", "control_after_generate"])],
  });
  const result = normalizeLegacyProxyWidgets(node.properties.proxyWidgets, { subgraphNode: node });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tuples, [
    ["6", "seed"],
    ["6", "control_after_generate"],
    ["6", "cfg"],
  ]);
});

// ── wiring: the production save path actually runs this before publish ──────

const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
const saveSite = src.slice(
  src.indexOf("async graph_save_subgraph("),
  src.indexOf("graph_list_subgraphs({ filter, limit } = {})"),
);

test("#2005 graph_save_subgraph imports the proxyWidgets preparer", () => {
  assert.match(
    src,
    /import \{ prepareSubgraphProxyWidgetsForPublish \} from "\.\/lib\/subgraph-proxy-widgets\.js";/,
  );
});

test("#2005 graph_save_subgraph rewrites proxyWidgets before either publish call", () => {
  const prepareAt = saveSite.indexOf("prepareSubgraphProxyWidgetsForPublish(target)");
  assert.ok(prepareAt >= 0, "the save path must call the preparer on the subgraph node");
  const overwritePublish = saveSite.indexOf("store.publishSubgraph(finalName)");
  const firstPublish = saveSite.indexOf("await store.publishSubgraph(finalName);");
  assert.ok(overwritePublish > prepareAt, "rewrite must happen before the overwrite publish");
  assert.ok(firstPublish > prepareAt, "rewrite must happen before the first-publish call");
});
