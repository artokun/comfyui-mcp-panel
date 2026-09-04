/**
 * #2225 — after panel_open_workflow reopens a modified subgraph, outline lists
 * promoted width/height/seed while `_subgraphSlot` is still unbound and
 * properties.proxyWidgets still names the FILE's inner Primitive `value`
 * widgets. graph_get_subgraph must publish a complete promoted-terminal
 * witness so panel_set_widget can dispatch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isPromotedContainer } from "../../web/js/lib/graph-read.js";
import {
  applyWidgetWrite,
  followPromotionToConcrete,
  MAX_PROMOTION_CHAIN_DEPTH,
  promotedInputAliases,
  resolvePromotedInnerTarget,
} from "../../web/js/lib/widget-write.js";
import { rebindLoadedPromotedMappings } from "../../web/js/lib/subgraph-instance-widgets.js";

const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);

function extractPromotedTerminalWitnesses() {
  const helperStart = PANEL_SRC.indexOf("function resolveSubgraphLink(");
  const helperEnd = PANEL_SRC.indexOf("\nfunction findPromotedHostInput", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "production promotion helper range must remain extractable");
  return new Function(
    "resolvePromotedInnerTarget",
    "followPromotionToConcrete",
    "MAX_PROMOTION_CHAIN_DEPTH",
    "promotedInputAliases",
    "isPromotedContainer",
    `${PANEL_SRC.slice(helperStart, helperEnd)}; return promotedTerminalWitnesses;`,
  )(
    resolvePromotedInnerTarget,
    followPromotionToConcrete,
    MAX_PROMOTION_CHAIN_DEPTH,
    promotedInputAliases,
    isPromotedContainer,
  );
}

const ROOT_GRAPH_ID = "c4a254bb-935e-4013-b380-5e36954de4b0";

function makePrimitive(id, value) {
  const inner = { name: "value", type: "INT", value };
  const node = {
    id,
    type: "PrimitiveInt",
    inputs: [{ name: "value", widget: { name: "value" }, type: "INT", link: id }],
    widgets: [inner],
  };
  return { node, inner };
}

/** Modified subgraph after reopen: host rails exist, slots not rebound,
 * proxyWidgets still names inner `value` (and may keep the FILE's host names). */
function makeReopenedModifiedHost({ includeHostInputs = true, staleProxyNodeIds = false } = {}) {
  const width = makePrimitive(10, 1024);
  const height = makePrimitive(11, 1024);
  const seed = makePrimitive(12, 42);
  const links = {
    10: { id: 10, origin_id: -10, origin_slot: 0, target_id: 10, target_slot: 0 },
    11: { id: 11, origin_id: -10, origin_slot: 1, target_id: 11, target_slot: 0 },
    12: { id: 12, origin_id: -10, origin_slot: 2, target_id: 12, target_slot: 0 },
  };
  const subgraphInputs = [
    { name: "width", linkIds: [] },
    { name: "height", linkIds: [] },
    { name: "seed", linkIds: [] },
  ];
  const subgraph = {
    _nodes: [width.node, height.node, seed.node],
    inputs: subgraphInputs,
    inputNode: { id: -10, slots: subgraphInputs },
    links,
    getNodeById: (id) => {
      if (String(id) === "10") return width.node;
      if (String(id) === "11") return height.node;
      if (String(id) === "12") return seed.node;
      return null;
    },
    getLink: (id) => links[id] ?? null,
  };

  const rails = {};
  const widgets = [];
  for (const name of ["width", "height", "seed"]) {
    const widgetId = `${ROOT_GRAPH_ID}:42:${name}`;
    const rail = { name, type: "INT", value: name === "seed" ? 42 : 1024, widgetId };
    rails[name] = rail;
    widgets.push(rail);
  }
  const hostInput = (name) => ({ name });
  const host = {
    id: 42,
    type: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    subgraph,
    inputs: includeHostInputs ? [hostInput("width"), hostInput("height"), hostInput("seed")] : [],
    widgets,
    properties: {
      proxyWidgets: staleProxyNodeIds
        ? [
            [99, "width"],
            [98, "height"],
            [97, "seed"],
          ]
        : [
            [10, "value"],
            [11, "value"],
            [12, "value"],
            [10, "width"],
            [11, "height"],
            [12, "seed"],
          ],
    },
  };
  return { host, rails, width, height, seed };
}

function assertCompleteWitness(entries, name, terminalId, terminalType) {
  const witness = entries.find((entry) => entry.widget === name);
  assert.ok(witness, `missing witness for ${name}`);
  assert.equal(witness.error, undefined, `${name} must not publish an incomplete witness`);
  assert.equal(witness.parent_rail?.authoritative, true);
  assert.equal(witness.terminal_widget, "value");
  assert.equal(witness.terminal_node_id, terminalId);
  assert.equal(witness.terminal_node_type, terminalType);
  assert.ok(Array.isArray(witness.terminal_inputs));
}

test("#2225 rebindLoadedPromotedMappings binds unique IO slots onto host inputs", () => {
  const { host } = makeReopenedModifiedHost();
  assert.equal(host.inputs[0]._subgraphSlot, undefined);
  const result = rebindLoadedPromotedMappings({ _nodes: [host] });
  assert.equal(result.rebound, 6);
  assert.equal(host.inputs[0]._subgraphSlot, host.subgraph.inputs[0]);
  assert.equal(host.inputs[1]._subgraphSlot, host.subgraph.inputs[1]);
  assert.equal(host.widgets[0]._subgraphSlot, host.subgraph.inputs[0]);
});

test("#2225 after reopen, host width/height/seed resolve to PrimitiveInt.value via -10", () => {
  const { host, width, height, seed } = makeReopenedModifiedHost();
  const w = resolvePromotedInnerTarget(host, "width", () => null);
  assert.equal(w.promoted, true);
  assert.equal(w.target.node, width.node);
  assert.equal(w.target.widget, width.inner);
  assert.equal(w.target.parentWidget?.name, "width");
  const h = resolvePromotedInnerTarget(host, "height", () => null);
  assert.equal(h.target.node, height.node);
  const s = resolvePromotedInnerTarget(host, "seed", () => null);
  assert.equal(s.target.node, seed.node);
  assert.equal(s.target.widget.name, "value");
});

test("#2225 after reopen with no host inputs, unique IO-slot host widgets still resolve", () => {
  const { host, width } = makeReopenedModifiedHost({ includeHostInputs: false });
  const res = resolvePromotedInnerTarget(host, "width", () => null);
  assert.equal(res.promoted, true);
  assert.equal(res.target.node, width.node);
  assert.equal(res.target.parentWidget?.name, "width");
});

test("#2225 production witness completes for reopened PrimitiveInt width/height/seed", () => {
  const makeWitnesses = extractPromotedTerminalWitnesses();
  const { host } = makeReopenedModifiedHost();
  const entries = makeWitnesses(host);
  assertCompleteWitness(entries, "width", 10, "PrimitiveInt");
  assertCompleteWitness(entries, "height", 11, "PrimitiveInt");
  assertCompleteWitness(entries, "seed", 12, "PrimitiveInt");
});

test("#2225 stale file proxyWidgets ids do not veto a live parent-rail resolution", () => {
  const makeWitnesses = extractPromotedTerminalWitnesses();
  const { host } = makeReopenedModifiedHost({ staleProxyNodeIds: true });
  const entries = makeWitnesses(host);
  assertCompleteWitness(entries, "width", 10, "PrimitiveInt");
  assert.equal(entries.find((entry) => entry.widget === "width")?.error, undefined);
});

test("#2225 applyWidgetWrite sets reopened promoted width without unpacking", () => {
  const { host, width, rails } = makeReopenedModifiedHost();
  const set = applyWidgetWrite(host, "width", 1280, { resolveSource: () => null });
  assert.equal(set.value, 1280);
  assert.equal(width.inner.value, 1280);
  assert.equal(rails.width.value, 1280);
});

test("#2225 workflow_open / graph_load / refresh_nodes all rebind the mapping", () => {
  assert.match(
    PANEL_SRC,
    /rebindLoadedPromotedMappings/,
    "the post-load mapping rebuild must be imported",
  );
  assert.match(
    PANEL_SRC,
    /applySavedSubgraphHostWidgets\(app\?\.graph, clone\)/,
    "graph_load still restores host widgets (which now rebinds slots first)",
  );
  const refreshStart = PANEL_SRC.indexOf("async refresh_nodes() {");
  const refreshEnd = PANEL_SRC.indexOf("\n  graph_serialize()", refreshStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, "refresh_nodes must remain extractable");
  assert.match(
    PANEL_SRC.slice(refreshStart, refreshEnd),
    /rebindLoadedPromotedMappings\(app\?\.graph\)/,
    "panel_refresh_nodes must rebuild promoted-terminal slots after a defs refresh",
  );
});
