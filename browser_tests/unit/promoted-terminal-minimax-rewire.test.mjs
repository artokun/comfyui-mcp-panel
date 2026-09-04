/**
 * #2057 reopen — after entering MiniMax H3 T2V host 140 and replacing/rewiring
 * inner loaders, panel_set_widget still refused promoted `value` / `value_2`
 * because graph_get_subgraph could not classify the HOST (it is not in the
 * viewed inner graph) and because `_subgraphSlot` was unbound after the
 * reconfigure. MCP never dispatched graph_set_widget.
 *
 * Drives the shipped resolvePromotedContainerForRead / resolvePromotedInnerTarget
 * / applyWidgetWrite and the production promotedTerminalWitnesses extractor.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isPromotedContainer } from "../../web/js/lib/graph-read.js";
import { resolveLiveNode } from "../../web/js/lib/node-id.js";
import {
  resolvePromotedContainerForRead,
} from "../../web/js/lib/subgraph-scope.js";
import { withPreservedPromotedInstanceWidgets } from "../../web/js/lib/subgraph-instance-widgets.js";
import {
  applyWidgetWrite,
  followPromotionToConcrete,
  MAX_PROMOTION_CHAIN_DEPTH,
  promotedInputAliases,
  resolvePromotedInnerTarget,
} from "../../web/js/lib/widget-write.js";

const PANEL_SRC = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);

const HOST_TYPE = "79dd8a95-ce9d-4c14-b264-2162e8bec5ce";
const ROOT_GRAPH_ID = "e3f2b845-8f2c-4b5a-9caf-eac1029d3e7e";

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

function extractGetSubgraph() {
  const start = PANEL_SRC.indexOf("graph_get_subgraph({ node_id }) {");
  const end = PANEL_SRC.indexOf("async graph_add_node(", start);
  assert.ok(start >= 0 && end > start, "graph_get_subgraph handler must remain extractable");
  const method = PANEL_SRC.slice(start, end).replace(/,\s*$/, "");
  const makeWitnesses = extractPromotedTerminalWitnesses();
  return (ctx) =>
    new Function(
      "getGraphCtx",
      "resolveNode",
      "describeActiveGraph",
      "subgraphValueProvenance",
      "redactWidgetValue",
      "graphViewIdentityFor",
      "MAX_STATE_NODES",
      "fixedCapNote",
      "summarizeNode",
      "promotedTerminalWitnesses",
      "isPromotedContainer",
      "resolvePromotedContainerForRead",
      `return ({${method}}).graph_get_subgraph;`,
    )(
      () => ctx,
      (graph, nodeId) => {
        const found = resolveLiveNode(graph, nodeId);
        if (!found) throw new Error(`No node with id ${nodeId} in the current graph`);
        return found;
      },
      () => ({
        scope: ctx.graph === ctx.rootGraph ? "root" : "subgraph",
        owner_node_id: ctx.graph === ctx.rootGraph ? undefined : 140,
        graph_identity: "graph:inner",
      }),
      () => ({}),
      () => ({}),
      () => "graph:inner",
      50,
      () => "truncation note",
      (inner) => ({ id: inner.id, type: inner.type }),
      (node) => makeWitnesses(node),
      isPromotedContainer,
      resolvePromotedContainerForRead,
    );
}

function makePrimitive(id, type, value) {
  const inner = { name: "value", type: type === "PrimitiveBoolean" ? "BOOLEAN" : "INT", value };
  const node = {
    id,
    type,
    inputs: [{ name: "value", widget: { name: "value" }, type: inner.type, link: id }],
    widgets: [inner],
  };
  return { node, inner };
}

/** Official MiniMax H3 T2V host 140 after enter + replace UNETLoader.
 * Host rails exist; `_subgraphSlot` unbound; several inner Primitive `value`
 * widgets (so a name-only inner match is ambiguous); -10 still drives
 * turbo_mode (`value`) and turbo_steps (`value_2`). */
function makeRewiredMiniMaxHost() {
  const turbo = makePrimitive(139, "PrimitiveBoolean", false);
  const steps = makePrimitive(138, "PrimitiveInt", 8);
  const duration = makePrimitive(133, "PrimitiveFloat", 5);
  const unetInner = { name: "unet_name", type: "combo", value: "new.safetensors" };
  const unet = {
    id: 200,
    type: "UNETLoader",
    inputs: [{ name: "unet_name", widget: { name: "unet_name" }, type: "COMBO", link: 221 }],
    widgets: [unetInner],
  };
  const slotNames = [
    "first_frame",
    "last_frame",
    "prompt",
    "width",
    "height",
    "value_1",
    "noise_seed",
    "unet_name",
    "clip_name",
    "vae_name",
    "vae_name_1",
    "value",
    "lora_name",
    "strength_model_1",
    "value_2",
  ];
  const subgraphInputs = slotNames.map((name) => ({
    name,
    label: name === "value" ? "turbo_mode" : name === "value_2" ? "turbo_steps" : name === "value_1" ? "duration" : name,
    linkIds: [],
  }));
  const links = {
    133: { id: 133, origin_id: -10, origin_slot: 5, target_id: 133, target_slot: 0 },
    138: { id: 138, origin_id: -10, origin_slot: 14, target_id: 138, target_slot: 0 },
    139: { id: 139, origin_id: -10, origin_slot: 11, target_id: 139, target_slot: 0 },
    221: { id: 221, origin_id: -10, origin_slot: 7, target_id: 200, target_slot: 0 },
  };
  const nodes = [duration.node, steps.node, turbo.node, unet];
  const subgraph = {
    _nodes: nodes,
    inputs: subgraphInputs,
    inputNode: { id: -10, slots: subgraphInputs },
    links,
    getNodeById: (id) => nodes.find((node) => String(node.id) === String(id)) ?? null,
    getLink: (id) => links[id] ?? null,
  };

  const rail = (name, type, value, label) => {
    const widget = {
      name,
      type,
      value,
      widgetId: `${ROOT_GRAPH_ID}:140:${name}`,
      ...(label ? { label } : {}),
    };
    return widget;
  };
  const valueRail = rail("value", "BOOLEAN", false, "turbo_mode");
  const value2Rail = rail("value_2", "INT", 8, "turbo_steps");
  const host = {
    id: 140,
    type: HOST_TYPE,
    title: "Image to Video (MiniMax H3)",
    subgraph,
    inputs: [
      { name: "first_frame", type: "IMAGE", link: null },
      { name: "last_frame", type: "IMAGE", link: null },
      { name: "width", type: "INT", link: 246, widget: { name: "width" } },
      { name: "height", type: "INT", link: 247, widget: { name: "height" } },
      { name: "value_1", type: "FLOAT", link: null, widget: { name: "value_1" } },
      { name: "value", type: "BOOLEAN", link: null, widget: valueRail, _widget: valueRail },
      { name: "value_2", type: "INT", link: null, widget: value2Rail, _widget: value2Rail },
    ],
    widgets: [
      rail("prompt", "STRING", "a prompt"),
      rail("width", "INT", 1344),
      rail("height", "INT", 768),
      rail("value_1", "FLOAT", 5, "duration"),
      rail("noise_seed", "INT", 1),
      rail("unet_name", "combo", "new.safetensors"),
      valueRail,
      value2Rail,
    ],
    properties: {
      proxyWidgets: [
        [127, "unet_name"],
        [139, "value"],
        [138, "value"],
      ],
    },
  };
  const root = { _nodes: [host] };
  return { host, root, subgraph, turbo, steps, valueRail, value2Rail };
}

function assertCompleteWitness(entries, name, terminalId, terminalType) {
  const witness = entries.find((entry) => entry.widget === name);
  assert.ok(witness, `missing witness for ${name}`);
  assert.equal(witness.error, undefined, `${name} must not publish an incomplete witness`);
  assert.equal(witness.parent_rail?.authoritative, true);
  assert.equal(witness.terminal_widget, "value");
  assert.equal(witness.terminal_node_id, terminalId);
  assert.equal(witness.terminal_node_type, terminalType);
}

test("#2057 after enter, the MiniMax host is still a promoted container from the inner view", () => {
  const { host, root, subgraph } = makeRewiredMiniMaxHost();
  assert.equal(resolveLiveNode(subgraph, 140), null, "the wrapper is not an inner node");
  assert.equal(resolvePromotedContainerForRead(subgraph, root, 140), host);
  assert.equal(isPromotedContainer(host), true);
});

test("#2057 after loader rewire, host value/value_2 resolve to Primitive terminals via -10", () => {
  const { host, turbo, steps } = makeRewiredMiniMaxHost();
  const mode = resolvePromotedInnerTarget(host, "value", () => null);
  assert.equal(mode.promoted, true);
  assert.equal(mode.target.node, turbo.node);
  assert.equal(mode.target.widget, turbo.inner);
  assert.equal(mode.target.parentWidget?.name, "value");
  const turboSteps = resolvePromotedInnerTarget(host, "value_2", () => null);
  assert.equal(turboSteps.promoted, true);
  assert.equal(turboSteps.target.node, steps.node);
  assert.equal(turboSteps.target.widget, steps.inner);
  assert.equal(turboSteps.target.parentWidget?.name, "value_2");
});

test("#2057 production witness completes for MiniMax value/value_2 after loader rewire", () => {
  const makeWitnesses = extractPromotedTerminalWitnesses();
  const { host } = makeRewiredMiniMaxHost();
  const entries = makeWitnesses(host);
  assertCompleteWitness(entries, "value", 139, "PrimitiveBoolean");
  assertCompleteWitness(entries, "value_2", 138, "PrimitiveInt");
});

test("#2057 graph_get_subgraph classifies host 140 while the canvas is inside it", () => {
  const { host, root, subgraph } = makeRewiredMiniMaxHost();
  const getSubgraph = extractGetSubgraph()({ graph: subgraph, rootGraph: root });
  const out = getSubgraph({ node_id: 140 });
  assert.equal(out.subgraph_of.node_id, 140);
  assert.equal(out.truncated, false);
  assert.equal(out.node_count, subgraph._nodes.length);
  assert.equal(out.nodes.length, subgraph._nodes.length);
  assertCompleteWitness(out.promoted_terminals, "value", 139, "PrimitiveBoolean");
  assertCompleteWitness(out.promoted_terminals, "value_2", 138, "PrimitiveInt");
  assert.equal(host.type, HOST_TYPE);
});

test("#2057 applyWidgetWrite sets MiniMax promoted value/value_2 without unpacking", () => {
  const { host, turbo, steps, valueRail, value2Rail } = makeRewiredMiniMaxHost();
  const mode = applyWidgetWrite(host, "value", true, { resolveSource: () => null });
  const turboSteps = applyWidgetWrite(host, "value_2", 4, { resolveSource: () => null });
  assert.equal(mode.value, true);
  assert.equal(turboSteps.value, 4);
  assert.equal(turbo.inner.value, true);
  assert.equal(steps.inner.value, 4);
  assert.equal(valueRail.value, true);
  assert.equal(value2Rail.value, 4);
});

test("#2057 inner mutations rebind unique promoted slots after restore", async () => {
  assert.match(
    readFileSync(new URL("../../web/js/lib/subgraph-instance-widgets.js", import.meta.url), "utf8"),
    /rebindLoadedPromotedMappings\(rootGraph\)/,
    "enter+rewire must rebuild host _subgraphSlot after the instance-rail restore",
  );
  const { host, root, subgraph } = makeRewiredMiniMaxHost();
  assert.equal(host.inputs.find((input) => input.name === "value")?._subgraphSlot, undefined);
  await withPreservedPromotedInstanceWidgets(root, subgraph, () => "ok");
  assert.equal(
    host.inputs.find((input) => input.name === "value")?._subgraphSlot,
    subgraph.inputs.find((slot) => slot.name === "value"),
  );
});
