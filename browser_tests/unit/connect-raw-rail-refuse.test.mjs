/**
 * #1953 — `panel_connect` to a raw rail id silently auto-exposed.
 *
 * Documented contract (panel_expose_subgraph_output):
 *   "do NOT panel_connect to a guessed rail node id"
 * Documented contract (panel_unexpose_subgraph_output):
 *   a rail_node_id "is forwarded to the panel, which REFUSES it"
 *
 * The refusal did not exist. Inside a subgraph the reported call
 *
 *     panel_connect { from_node_id: 2, from_output: "LATENT", to_node_id: -20 }
 *
 * SUCCEEDED with `{ exposed: { name: "LATENT", … } }` and minted a new
 * boundary slot — a shape panel_connect's own description never mentions.
 * A typo'd to_node_id that happened to hit a rail mutated the subgraph's
 * public interface with no error.
 *
 * These tests run the REAL shipped `graph_connect`, extracted from
 * web/js/comfyui-mcp-panel.js, with a STUB expose that records the call and
 * returns `{ exposed }` — so leftover auto-expose is a SUCCESS the assertions
 * fail on, not a TypeError `assert.throws` would swallow. Connecting to an
 * EXISTING named rail slot is still a connect (not this bug).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  isLinkPersisted,
  removePhantomLink,
  isWidgetBackedInput,
  inputLinkIds,
  railSlotLinkIds,
  linkIdExclusionSet,
  findLandedInboundLink,
  findLandedRailLink,
  isRailLinkPersisted,
  landedAfterThrowWarning,
  verifyConnect,
  snapshotInputSlotLinks,
  connectCollateralBullets,
  connectCollateralWarning,
} from "../../web/js/lib/connect-verify.js";
import { snapshotGraphState } from "../../web/js/lib/disconnect-verify.js";
import { findExistingRailSlot, refuseConnectToRawRail } from "../../web/js/lib/rail-slot.js";
import {
  captureNodeTitles,
  describeTitleRewrites,
  titleRewriteWarning,
} from "../../web/js/lib/node-title-rewrite.js";
import {
  captureSlotNames,
  describeSlotRewrites,
  slotRewriteWarning,
} from "../../web/js/lib/slot-rename-disclosure.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");

function sliceMethod(signature) {
  const lines = panelSrc.split("\n");
  const start = lines.findIndex((l) => l === signature);
  assert.ok(start >= 0, `could not locate "${signature}" in the panel source`);
  const end = lines.findIndex((l, i) => i > start && l === "  },");
  assert.ok(end > start, `could not locate the end of "${signature}"`);
  return lines.slice(start, end + 1).join("\n");
}

const connectSrc = sliceMethod(
  "  graph_connect({ from_node_id, from_output, to_node_id, to_input, auto_match }) {",
);

function resolveNode(graph, id) {
  const n = graph.getNodeById(id);
  if (!n) throw new Error(`No node with id ${id}`);
  return n;
}

function resolveSlot(slots, ref, kind) {
  const list = slots ?? [];
  if (typeof ref === "number") {
    if (ref < 0 || ref >= list.length) throw new Error(`no ${kind} slot ${ref}`);
    return ref;
  }
  const i = list.findIndex((s) => s?.name === ref);
  if (i === -1) throw new Error(`no ${kind} named ${ref}`);
  return i;
}

function resolveRail(graph, ref) {
  const inNode = graph?.inputNode ?? null;
  const outNode = graph?.outputNode ?? null;
  if (typeof ref === "string") {
    const key = ref.trim().toLowerCase();
    if (key === "input" || key === "input_rail" || key === "inputs" || key === "in") {
      return inNode ? { rail: "input", node: inNode } : null;
    }
    if (key === "output" || key === "output_rail" || key === "outputs" || key === "out") {
      return outNode ? { rail: "output", node: outNode } : null;
    }
  }
  const num = Number(ref);
  if (Number.isFinite(num)) {
    if (inNode && (Number(inNode.id) === num || num === -10)) return { rail: "input", node: inNode };
    if (outNode && (Number(outNode.id) === num || num === -20)) return { rail: "output", node: outNode };
  }
  return null;
}

const railIntent = (ref) => {
  const r = resolveRail({ inputNode: { id: -10 }, outputNode: { id: -20 } }, ref);
  return r?.rail ?? null;
};
const isEmptyRailSlotRef = (ref) =>
  ref == null || ref === "" || (typeof ref === "string" && ["new", "empty", "+"].includes(ref.trim().toLowerCase()));
const slotDiagnostic = () => "slot diagnostic";
const loopbackRefusalReason = () => "loopback";
const findSubgraphHostNode = () => null;
const uniqueSubgraphOutputName = (_g, base) => base;
const uniqueSubgraphInputName = (_g, base) => base;

function autoMatchSlots(origin, target, from_output, to_input) {
  return {
    outIdx: resolveSlot(origin.outputs, from_output ?? 0, "output"),
    inIdx: resolveSlot(target.inputs, to_input ?? 0, "input"),
    autoMatched: [],
  };
}

function mkLinkStore() {
  const isIndex = (prop) => typeof prop === "string" && /^(?:0|[1-9]\d*)$/.test(prop);
  const map = new Map();
  const proxy = new Proxy(map, {
    get(target, prop) {
      if (isIndex(prop)) return target.get(Number(prop));
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
    has: (target, prop) => (isIndex(prop) ? target.has(Number(prop)) : Reflect.has(target, prop)),
    deleteProperty: (target, prop) =>
      isIndex(prop) ? target.delete(Number(prop)) : Reflect.deleteProperty(target, prop),
    ownKeys: (target) => [...target.keys()].map(String),
    getOwnPropertyDescriptor(target, prop) {
      if (isIndex(prop) && target.has(Number(prop))) {
        return { value: target.get(Number(prop)), enumerable: true, configurable: true, writable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  return { map, proxy };
}

function mkRailOutput(graph, name, type) {
  const slot = { name, type, linkIds: [] };
  slot.connect = (outputSlot, node) => {
    const outIdx = node.outputs.indexOf(outputSlot);
    const id = ++graph.lastLinkId;
    const link = { id, origin_id: node.id, origin_slot: outIdx, target_id: -20, target_slot: 0 };
    graph._links.set(id, link);
    slot.linkIds[0] = id;
    (outputSlot.links ??= []).push(id);
    return link;
  };
  return slot;
}

function mkRailInput(graph, name, type) {
  const slot = { name, type, linkIds: [] };
  slot.connect = (inputSlot, node) => {
    const inIdx = node.inputs.indexOf(inputSlot);
    const id = ++graph.lastLinkId;
    const link = { id, origin_id: -10, origin_slot: 0, target_id: node.id, target_slot: inIdx };
    graph._links.set(id, link);
    slot.linkIds.push(id);
    inputSlot.link = id;
    return link;
  };
  return slot;
}

function mkGraph() {
  const store = mkLinkStore();
  const graph = {
    lastLinkId: 0,
    _links: store.map,
    links: store.proxy,
    nodes: [],
    outputs: [],
    inputs: [],
    outputNode: { id: -20 },
    inputNode: { id: -10 },
    getNodeById: (id) => graph.nodes.find((n) => String(n.id) === String(id)) ?? null,
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
    addOutput(name, type) {
      const slot = mkRailOutput(graph, name, type);
      graph.outputs.push(slot);
      return slot;
    },
    addInput(name, type) {
      const slot = mkRailInput(graph, name, type);
      graph.inputs.push(slot);
      return slot;
    },
    getLink: (id) => store.map.get(id) ?? null,
  };
  return graph;
}

function mkNode(graph, id, inputs, outputs) {
  const node = { id, inputs, outputs, graph };
  graph.nodes.push(node);
  return node;
}

/**
 * Build shipped `graph_connect` with stub expose twins that RECORD a call and
 * return `{ exposed }` — leftover auto-expose is then a success, not a throw.
 */
function buildConnect(graph, exposeCalls) {
  const deps = {
    getGraphCtx: () => ({ graph, canvas: {}, app: {}, rootGraph: graph, LG: {} }),
    resolveNode,
    resolveSlot,
    resolveRail,
    railIntent,
    isEmptyRailSlotRef,
    findExistingRailSlot,
    refuseConnectToRawRail,
    findSubgraphHostNode,
    autoMatchSlots,
    slotDiagnostic,
    loopbackRefusalReason,
    uniqueSubgraphOutputName,
    uniqueSubgraphInputName,
    isLinkPersisted,
    removePhantomLink,
    isWidgetBackedInput,
    inputLinkIds,
    railSlotLinkIds,
    linkIdExclusionSet,
    findLandedInboundLink,
    findLandedRailLink,
    isRailLinkPersisted,
    landedAfterThrowWarning,
    snapshotGraphState,
    snapshotInputSlotLinks,
    verifyConnect,
    connectCollateralBullets,
    connectCollateralWarning,
    captureNodeTitles,
    describeTitleRewrites,
    titleRewriteWarning,
    captureSlotNames,
    describeSlotRewrites,
    slotRewriteWarning,
    exposeCalls,
  };
  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `const GRAPH_TOOL_EXECUTORS = {
${connectSrc}
  graph_expose_subgraph_output(args) {
    exposeCalls.push({ side: "output", args });
    return {
      exposed: {
        name: args.name || "LATENT",
        type: "LATENT",
        slot: 0,
        on_host_subgraph_node: true,
        from: { node_id: String(args.from_node_id), output: args.from_output },
      },
    };
  },
  graph_expose_subgraph_input(args) {
    exposeCalls.push({ side: "input", args });
    return {
      exposed: {
        name: args.name || "model",
        type: "MODEL",
        slot: 0,
        on_host_subgraph_node: true,
        to: { node_id: String(args.to_node_id), input: args.to_input },
      },
    };
  },
};
return GRAPH_TOOL_EXECUTORS.graph_connect;`,
  );
  return factory(...names.map((n) => deps[n]));
}

function documentedOutputRefusal(err) {
  assert.match(err.message, /do NOT panel_connect to a guessed rail node id/);
  assert.match(err.message, /panel_connect REFUSES it/);
  assert.match(err.message, /panel_expose_subgraph_output/);
  assert.match(err.message, /rail_node_id/);
  assert.match(err.message, /Nothing was exposed/);
  assert.doesNotMatch(err.message, /graph_expose_subgraph_output/);
  return true;
}

function documentedInputRefusal(err) {
  assert.match(err.message, /do NOT panel_connect to a guessed rail node id/);
  assert.match(err.message, /panel_connect REFUSES it/);
  assert.match(err.message, /panel_expose_subgraph_input/);
  assert.match(err.message, /Nothing was exposed/);
  assert.doesNotMatch(err.message, /graph_expose_subgraph_input/);
  return true;
}

test("#1953 WIRING: graph_connect no longer falls through to graph_expose_subgraph_*", () => {
  assert.doesNotMatch(
    connectSrc,
    /graph_expose_subgraph_output/,
    "output-rail auto-expose must be gone from graph_connect",
  );
  assert.doesNotMatch(
    connectSrc,
    /graph_expose_subgraph_input/,
    "input-rail auto-expose must be gone from graph_connect",
  );
  assert.match(connectSrc, /refuseConnectToRawRail\(to_node_id, "output"\)/);
  assert.match(connectSrc, /refuseConnectToRawRail\(from_node_id, "input"\)/);
});

test("#1953 the reported call (to_node_id: -20, no to_input) REFUSES and exposes NOTHING", () => {
  const graph = mkGraph();
  mkNode(graph, 2, [], [{ name: "LATENT", type: "LATENT", links: [] }]);
  const exposeCalls = [];
  const graph_connect = buildConnect(graph, exposeCalls);

  assert.throws(
    () => graph_connect({ from_node_id: 2, from_output: "LATENT", to_node_id: -20 }),
    documentedOutputRefusal,
  );
  assert.equal(exposeCalls.length, 0, "auto-expose must not run");
  assert.equal(graph.outputs.length, 0, "the boundary rail must be untouched");
  assert.equal(graph._links.size, 0);
});

test("#1953 string '-20' (MCP coercion) is refused the same way", () => {
  const graph = mkGraph();
  mkNode(graph, 2, [], [{ name: "LATENT", type: "LATENT", links: [] }]);
  const exposeCalls = [];
  const graph_connect = buildConnect(graph, exposeCalls);

  assert.throws(
    () => graph_connect({ from_node_id: 2, from_output: "LATENT", to_node_id: "-20" }),
    documentedOutputRefusal,
  );
  assert.equal(exposeCalls.length, 0);
  assert.equal(graph.outputs.length, 0);
});

test("#1953 a missing to_input name still refuses — it must not mint that slot", () => {
  const graph = mkGraph();
  mkNode(graph, 2, [], [{ name: "LATENT", type: "LATENT", links: [] }]);
  const exposeCalls = [];
  const graph_connect = buildConnect(graph, exposeCalls);

  assert.throws(
    () => graph_connect({ from_node_id: 2, from_output: "LATENT", to_node_id: -20, to_input: "LATENT" }),
    documentedOutputRefusal,
  );
  assert.equal(exposeCalls.length, 0);
  assert.equal(graph.outputs.length, 0);
});

test("#1953 connect FROM -10 without a matching input-rail slot REFUSES", () => {
  const graph = mkGraph();
  mkNode(graph, 2, [{ name: "model", type: "MODEL", link: null }], []);
  const exposeCalls = [];
  const graph_connect = buildConnect(graph, exposeCalls);

  assert.throws(
    () => graph_connect({ from_node_id: -10, from_output: "model", to_node_id: 2, to_input: "model" }),
    documentedInputRefusal,
  );
  assert.equal(exposeCalls.length, 0);
  assert.equal(graph.inputs.length, 0);
});

test("#1953 connecting to an EXISTING named output-rail slot still wires (not an expose)", () => {
  const graph = mkGraph();
  mkNode(graph, 2, [], [{ name: "LATENT", type: "LATENT", links: [] }]);
  const rail = mkRailOutput(graph, "LATENT", "LATENT");
  graph.outputs.push(rail);
  const exposeCalls = [];
  const graph_connect = buildConnect(graph, exposeCalls);

  const res = graph_connect({
    from_node_id: 2,
    from_output: "LATENT",
    to_node_id: -20,
    to_input: "LATENT",
  });
  assert.equal(res.connected.to.subgraph_output, "LATENT");
  assert.equal(res.exposed, undefined, "must not return the auto-expose shape");
  assert.equal(exposeCalls.length, 0);
  assert.equal(graph.outputs.length, 1);
  assert.equal(rail.linkIds.length, 1);
});

test("#1953 connecting FROM an EXISTING named input-rail slot still wires", () => {
  const graph = mkGraph();
  mkNode(graph, 2, [{ name: "model", type: "MODEL", link: null }], []);
  const rail = mkRailInput(graph, "model", "MODEL");
  graph.inputs.push(rail);
  const exposeCalls = [];
  const graph_connect = buildConnect(graph, exposeCalls);

  const res = graph_connect({
    from_node_id: -10,
    from_output: "model",
    to_node_id: 2,
    to_input: "model",
  });
  assert.equal(res.connected.from.subgraph_input, "model");
  assert.equal(res.exposed, undefined);
  assert.equal(exposeCalls.length, 0);
  assert.equal(graph.inputs.length, 1);
});
