/**
 * #1272 — `panel_connect` threw "Cannot read properties of undefined (reading
 * 'slots')" while the link WAS created. Reproduced twice inside a subgraph: once
 * onto an ImpactSwitch input that the node materialises on connect, once onto the
 * subgraph OUTPUT rail (`to_node_id: -20`). Both times `panel_query_graph` /
 * `panel_graph_outline` showed the wire afterwards.
 *
 * MECHANISM (read from ComfyUI_frontend 1.48.7 — the reporter's own version — not
 * inferred): every connect path
 * writes the link and only THEN runs the node hooks.
 *
 *   LGraphNode.connectSlots  — graph._links.set / output.links.push /
 *     targetInput.link = link.id  … then  graph.trigger("node:slot-links:changed"),
 *     this.onConnectionsChange(), inputNode.onConnectionsChange()
 *   SubgraphOutput.connect / SubgraphInput.connect — subgraph._links.set /
 *     linkIds / slot.link  … then  node.onConnectionsChange()
 *
 * So a throw from a hook carries NO information about whether the wire exists, and
 * the panel's `try { … } finally { … }` (no catch) turned "threw but landed" and
 * "threw and nothing landed" into one indistinguishable failure. An agent that
 * trusts it retries, and the retry duplicates or tears down correct wiring.
 *
 * These tests run the REAL shipped executors, extracted from
 * web/js/comfyui-mcp-panel.js and given LiteGraph-shaped doubles, with the REAL
 * verification helpers injected — so deleting the fix from the panel source (not
 * merely from the helper module) fails them. The helper-only variant of this test
 * stayed green against the unfixed call site, which is the defect this file exists
 * to avoid.
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
  readStoredLink,
} from "../../web/js/lib/connect-verify.js";
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
import { findExistingRailSlot } from "../../web/js/lib/rail-slot.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");

/** The method source between its signature line and the first `  },` line. */
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
const exposeOutSrc = sliceMethod("  graph_expose_subgraph_output({ from_node_id, from_output, name }) {");
const exposeInSrc = sliceMethod("  graph_expose_subgraph_input({ to_node_id, to_input, name }) {");

// ---------------------------------------------------------------------------
// Doubles for everything AROUND the code under test. The verification helpers
// are the REAL modules — a stub there would let the extracted method pass
// against a checker that always said "landed" (#1425's lesson).
// ---------------------------------------------------------------------------

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

const railIntent = (ref) =>
  ref === -10 || ref === -20 || ref === "input" || ref === "output" ? String(ref) : null;

function resolveRail(graph, ref) {
  if (ref === -20 || ref === "output") return graph.outputNode ? { rail: "output" } : null;
  if (ref === -10 || ref === "input") return graph.inputNode ? { rail: "input" } : null;
  return null;
}

const isEmptyRailSlotRef = (ref) => ref == null || ref === "";

function autoMatchSlots(origin, target, from_output, to_input) {
  return {
    outIdx: resolveSlot(origin.outputs, from_output ?? 0, "output"),
    inIdx: resolveSlot(target.inputs, to_input ?? 0, "input"),
    autoMatched: [],
  };
}

const slotDiagnostic = () => "slot diagnostic";
const loopbackRefusalReason = () => "loopback";
const findSubgraphHostNode = () => null;
const uniqueSubgraphOutputName = (_g, base) => base;
const uniqueSubgraphInputName = (_g, base) => base;

function buildExecutors(graph, canvas = {}) {
  const factory = new Function(
    "getGraphCtx",
    "resolveNode",
    "resolveSlot",
    "resolveRail",
    "railIntent",
    "isEmptyRailSlotRef",
    "findExistingRailSlot",
    "findSubgraphHostNode",
    "autoMatchSlots",
    "slotDiagnostic",
    "loopbackRefusalReason",
    "uniqueSubgraphOutputName",
    "uniqueSubgraphInputName",
    "isLinkPersisted",
    "removePhantomLink",
    "isWidgetBackedInput",
    "inputLinkIds",
    "railSlotLinkIds",
    "linkIdExclusionSet",
    "findLandedInboundLink",
    "findLandedRailLink",
    "isRailLinkPersisted",
    "landedAfterThrowWarning",
    "captureNodeTitles",
    "describeTitleRewrites",
    "titleRewriteWarning",
    "captureSlotNames",
    "describeSlotRewrites",
    "slotRewriteWarning",
    `const GRAPH_TOOL_EXECUTORS = {
${connectSrc}
${exposeOutSrc}
${exposeInSrc}
};
return GRAPH_TOOL_EXECUTORS;`,
  );
  return factory(
    () => ({ graph, canvas, app: {}, rootGraph: graph, LG: {} }),
    resolveNode,
    resolveSlot,
    resolveRail,
    railIntent,
    isEmptyRailSlotRef,
    findExistingRailSlot,
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
    captureNodeTitles,
    describeTitleRewrites,
    titleRewriteWarning,
    captureSlotNames,
    describeSlotRewrites,
    slotRewriteWarning,
  );
}

// ---------------------------------------------------------------------------
// LiteGraph-shaped doubles
// ---------------------------------------------------------------------------

/**
 * The REAL link store shape, not a convenient one.
 *
 * `LGraph` holds `_links: Map<LinkId, LLink>` with `LinkId = number`, and exposes
 * `links` as a Proxy over that Map whose methods are bound straight through — so
 * `links.get` IS `Map.prototype.get`, and `links.get("7")` MISSES a key of `7`,
 * while `links[7]` resolves through the numeric-key trap.
 *
 * The first version of this fixture used `links: {}`, a plain object whose keys are
 * already strings, so `links["7"]` and `links[7]` coincided. That masked a helper
 * that stringified every rail link id before looking it up: against a real graph it
 * returned "no link landed" for a link that HAD landed, which made both
 * expose_subgraph_* paths tear down the slot they had just correctly created — on
 * the happy path, 100% of the time. Every fixture below now uses this shape, so a
 * string/number confusion cannot pass again.
 */
function mkLinkStore() {
  const isIndex = (prop) => typeof prop === "string" && /^(?:0|[1-9]\d*)$/.test(prop);
  const map = new Map();
  const proxy = new Proxy(map, {
    get(target, prop) {
      if (isIndex(prop)) return target.get(Number(prop));
      const v = Reflect.get(target, prop, target);
      // bindAllMethods: `get`/`set`/`delete` are the RAW Map methods, bound.
      return typeof v === "function" ? v.bind(target) : v;
    },
    has: (target, prop) => (isIndex(prop) ? target.has(Number(prop)) : Reflect.has(target, prop)),
    deleteProperty: (target, prop) =>
      isIndex(prop) ? target.delete(Number(prop)) : Reflect.deleteProperty(target, prop),
    ownKeys: (target) => [...target.keys()].map(String),
    getOwnPropertyDescriptor(target, prop) {
      if (isIndex(prop) && target.has(Number(prop))) {
        return {
          value: target.get(Number(prop)),
          enumerable: true,
          configurable: true,
          writable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  return { map, proxy };
}

function mkGraph({ subgraph = false } = {}) {
  const store = mkLinkStore();
  const graph = {
    lastLinkId: 0,
    _links: store.map,
    links: store.proxy,
    nodes: [],
    outputs: [],
    inputs: [],
    ...(subgraph ? { outputNode: { id: -20 }, inputNode: { id: -10 } } : {}),
    getNodeById: (id) => graph.nodes.find((n) => String(n.id) === String(id)) ?? null,
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
    addOutput(name, type) {
      const slot = mkRailOutput(graph, name, type);
      graph.outputs.push(slot);
      return slot;
    },
    removeOutput(slot) {
      const i = graph.outputs.indexOf(slot);
      if (i >= 0) graph.outputs.splice(i, 1);
    },
    addInput(name, type) {
      const slot = mkRailInput(graph, name, type);
      graph.inputs.push(slot);
      return slot;
    },
    removeInput(slot) {
      const i = graph.inputs.indexOf(slot);
      if (i >= 0) graph.inputs.splice(i, 1);
    },
    // LGraph.getLink is `this._links.get(id)` — number-keyed, no coercion.
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
 * The origin node's connect(), mirroring connectSlots' ORDER: write the link,
 * then run `afterWrite` — the position LiteGraph calls onConnectionsChange from.
 */
function attachConnect(node, afterWrite) {
  node.connect = (outIdx, target, inIdx) => {
    const graph = node.graph;
    // LiteGraph drops the wire already on the input before making the new one.
    const prior = target.inputs[inIdx]?.link;
    if (prior != null) {
      graph._links.delete(prior);
      target.inputs[inIdx].link = null;
    }
    const id = ++graph.lastLinkId;
    const link = {
      id,
      origin_id: node.id,
      origin_slot: outIdx,
      target_id: target.id,
      target_slot: inIdx,
    };
    graph._links.set(id, link);
    (node.outputs[outIdx].links ??= []).push(id);
    target.inputs[inIdx].link = id;
    afterWrite?.({ link, target, inIdx, graph });
    return link;
  };
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
    slot.afterWrite?.({ link, graph });
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
    slot.afterWrite?.({ link, graph });
    return link;
  };
  return slot;
}

const SLOTS_THROW = "Cannot read properties of undefined (reading 'slots')";

const readStoredLinkId = (graph, id) => readStoredLink(graph, id)?.id ?? null;

// ---------------------------------------------------------------------------
// node → node (repro 1: ImpactSwitch's dynamic input)
// ---------------------------------------------------------------------------

function nodeToNodeFixture(afterWrite) {
  const graph = mkGraph();
  const src = mkNode(graph, 140, [], [{ name: "IMAGE", type: "IMAGE", links: [] }]);
  const dst = mkNode(graph, 143, [{ name: "input1", type: "IMAGE", link: null }], []);
  attachConnect(src, afterWrite);
  return { graph, src, dst, executors: buildExecutors(graph) };
}

test("#1272 node→node: a hook that throws AFTER the link is written reports CONNECTED", () => {
  const { graph, dst, executors } = nodeToNodeFixture(() => {
    throw new Error(SLOTS_THROW);
  });
  const res = executors.graph_connect({
    from_node_id: 140,
    from_output: "IMAGE",
    to_node_id: 143,
    to_input: "input1",
  });
  assert.equal(res.connected.from.node_id, 140);
  assert.equal(res.connected.to.node_id, 143);
  assert.equal(res.connected.to.input, "input1");
  assert.equal(res.connected.to.input_index, 0);
  // The verdict came from the live graph, not from the return value.
  assert.equal(dst.inputs[0].link, graph._links.get(1).id);
  // The throw is disclosed, never swallowed, and the retry is named as harmful.
  assert.match(res.warning, /threw while applying this connect/);
  assert.match(res.warning, /reading 'slots'/);
  assert.match(res.warning, /Do NOT retry/);
});

test("#1272 node→node: a throw that leaves NOTHING on the graph still FAILS", () => {
  const { graph, src, executors } = nodeToNodeFixture();
  src.connect = () => {
    throw new Error(SLOTS_THROW);
  };
  assert.throws(
    () =>
      executors.graph_connect({
        from_node_id: 140,
        from_output: "IMAGE",
        to_node_id: 143,
        to_input: "input1",
      }),
    (err) => {
      assert.match(err.message, /threw and NOTHING landed/);
      assert.match(err.message, /reading 'slots'/);
      assert.match(err.message, /this call left NO new link from that output on node 143/);
      return true;
    },
  );
  assert.equal(graph._links.size, 0);
});

test("#1272 node→node: a throw AFTER the node re-slotted the link names the slot it landed on", () => {
  const { dst, executors } = nodeToNodeFixture(({ link, target, inIdx }) => {
    // ImpactSwitch materialises input2 and moves the wire onto it, then throws.
    target.inputs[inIdx].link = null;
    target.inputs.push({ name: "input2", type: "IMAGE", link: link.id });
    link.target_slot = target.inputs.length - 1;
    throw new Error(SLOTS_THROW);
  });
  const res = executors.graph_connect({
    from_node_id: 140,
    from_output: "IMAGE",
    to_node_id: 143,
    to_input: "input1",
  });
  assert.equal(res.connected.to.input, "input2");
  assert.equal(res.connected.to.input_index, 1);
  // The reported slot is the one the live graph actually wired, not the requested one.
  assert.equal(dst.inputs[0].link, null);
  assert.notEqual(dst.inputs[1].link, null);
  assert.match(res.warning, /re-slotted/);
});

test("#1272 node→node: a throw that DESTROYED the previous wire says the input is now empty", () => {
  const graph = mkGraph();
  const old = mkNode(graph, 100, [], [{ name: "IMAGE", type: "IMAGE", links: [7] }]);
  const src = mkNode(graph, 140, [], [{ name: "IMAGE", type: "IMAGE", links: [] }]);
  const dst = mkNode(graph, 143, [{ name: "input1", type: "IMAGE", link: 7 }], []);
  graph._links.set(7, { id: 7, origin_id: 100, origin_slot: 0, target_id: 143, target_slot: 0 });
  graph.lastLinkId = 7;
  void old;
  // The replacement disconnect throws: old wire gone, new one never made.
  src.connect = (_outIdx, target, inIdx) => {
    graph._links.delete(target.inputs[inIdx].link);
    target.inputs[inIdx].link = null;
    throw new Error(SLOTS_THROW);
  };
  const executors = buildExecutors(graph);
  assert.throws(
    () =>
      executors.graph_connect({
        from_node_id: 140,
        from_output: "IMAGE",
        to_node_id: 143,
        to_input: "input1",
      }),
    /is GONE — the input is now EMPTY/,
  );
  assert.equal(dst.inputs[0].link, null);
});

test("#1272 node→node: a link that PRE-DATED the call is never credited to it", () => {
  const graph = mkGraph();
  const src = mkNode(graph, 140, [], [{ name: "IMAGE", type: "IMAGE", links: [7] }]);
  // The wire from 140 is already on a DIFFERENT input; the requested one is empty.
  const dst = mkNode(
    graph,
    143,
    [
      { name: "input1", type: "IMAGE", link: null },
      { name: "input2", type: "IMAGE", link: 7 },
    ],
    [],
  );
  graph._links.set(7, { id: 7, origin_id: 140, origin_slot: 0, target_id: 143, target_slot: 1 });
  graph.lastLinkId = 7;
  src.connect = () => {
    throw new Error(SLOTS_THROW);
  };
  const executors = buildExecutors(graph);
  assert.throws(
    () =>
      executors.graph_connect({
        from_node_id: 140,
        from_output: "IMAGE",
        to_node_id: 143,
        to_input: "input1",
      }),
    /threw and NOTHING landed[\s\S]*ALREADY on input "input2"[\s\S]*do not tear it down/,
  );
  assert.equal(dst.inputs[1].link, 7, "the pre-existing wire is left untouched");
});

test("#1272 node→node: the clean path is unchanged — no warning, #397 refusal intact", () => {
  const clean = nodeToNodeFixture();
  const ok = clean.executors.graph_connect({
    from_node_id: 140,
    from_output: "IMAGE",
    to_node_id: 143,
    to_input: "input1",
  });
  assert.equal(ok.connected.to.input, "input1");
  assert.equal(ok.warning, undefined);

  // #397: a truthy return that does not persist is still an honest failure.
  const phantom = nodeToNodeFixture(({ target, inIdx }) => {
    target.inputs[inIdx].link = null;
  });
  assert.throws(
    () =>
      phantom.executors.graph_connect({
        from_node_id: 140,
        from_output: "IMAGE",
        to_node_id: 143,
        to_input: "input1",
      }),
    /reported no persisted link/,
  );
});

// ---------------------------------------------------------------------------
// OUTPUT rail (repro 2: to_node_id -20)
// ---------------------------------------------------------------------------

function outputRailFixture() {
  const graph = mkGraph({ subgraph: true });
  const src = mkNode(graph, 143, [], [{ name: "selected_value", type: "IMAGE", links: [] }]);
  const rail = mkRailOutput(graph, "image", "IMAGE");
  graph.outputs.push(rail);
  return { graph, src, rail, executors: buildExecutors(graph) };
}

test("#1272 output rail: connect throws after wiring the rail → CONNECTED with disclosure", () => {
  const { rail, executors } = outputRailFixture();
  rail.afterWrite = () => {
    throw new Error(SLOTS_THROW);
  };
  const res = executors.graph_connect({
    from_node_id: 143,
    from_output: "selected_value",
    to_node_id: -20,
    to_input: "image",
  });
  assert.equal(res.connected.to.subgraph_output, "image");
  assert.equal(rail.linkIds.length, 1);
  assert.match(res.warning, /reading 'slots'/);
  assert.match(res.warning, /Do NOT retry/);
});

test("#1272 output rail: connect throws and the rail is EMPTY → honest failure", () => {
  const { rail, executors } = outputRailFixture();
  rail.connect = () => {
    throw new Error(SLOTS_THROW);
  };
  assert.throws(
    () =>
      executors.graph_connect({
        from_node_id: 143,
        from_output: "selected_value",
        to_node_id: -20,
        to_input: "image",
      }),
    /threw and NOTHING landed[\s\S]*left no new link from that output on the rail slot/,
  );
  assert.equal(rail.linkIds.length, 0);
});

test("#397 output rail: a truthy return with NO persisted link is refused (per-call-site gap)", () => {
  const { rail, executors } = outputRailFixture();
  // The pre-fix behaviour of this branch: report success on the return value alone.
  rail.connect = () => ({ id: 999 });
  assert.throws(
    () =>
      executors.graph_connect({
        from_node_id: 143,
        from_output: "selected_value",
        to_node_id: -20,
        to_input: "image",
      }),
    /reported no persisted link[\s\S]*#397/,
  );
});

test("#1272 output rail: the clean path still reports connected with no warning", () => {
  const { executors, rail } = outputRailFixture();
  const res = executors.graph_connect({
    from_node_id: 143,
    from_output: "selected_value",
    to_node_id: -20,
    to_input: "image",
  });
  assert.equal(res.connected.to.subgraph_output, "image");
  assert.equal(res.warning, undefined);
  assert.equal(rail.linkIds.length, 1);
});

// ---------------------------------------------------------------------------
// INPUT rail
// ---------------------------------------------------------------------------

function inputRailFixture() {
  const graph = mkGraph({ subgraph: true });
  const dst = mkNode(graph, 143, [{ name: "image", type: "IMAGE", link: null }], []);
  const rail = mkRailInput(graph, "image", "IMAGE");
  graph.inputs.push(rail);
  return { graph, dst, rail, executors: buildExecutors(graph) };
}

test("#1272 input rail: connect throws after wiring → CONNECTED with disclosure", () => {
  const { rail, dst, executors } = inputRailFixture();
  rail.afterWrite = () => {
    throw new Error(SLOTS_THROW);
  };
  const res = executors.graph_connect({
    from_node_id: -10,
    from_output: "image",
    to_node_id: 143,
    to_input: "image",
  });
  assert.equal(res.connected.from.subgraph_input, "image");
  assert.equal(dst.inputs[0].link, rail.linkIds[0]);
  assert.match(res.warning, /reading 'slots'/);
});

test("#397 input rail: a truthy return with NO persisted link is refused", () => {
  const { executors, rail } = inputRailFixture();
  rail.connect = () => ({ id: 999 });
  assert.throws(
    () =>
      executors.graph_connect({
        from_node_id: -10,
        from_output: "image",
        to_node_id: 143,
        to_input: "image",
      }),
    /reported no persisted link[\s\S]*#397/,
  );
});

// ---------------------------------------------------------------------------
// graph_expose_subgraph_output / _input — the addOutput/addInput leak
// ---------------------------------------------------------------------------

test("#1272 expose output: a throwing connect no longer STRANDS the slot addOutput created", () => {
  const graph = mkGraph({ subgraph: true });
  const src = mkNode(graph, 143, [], [{ name: "selected_value", type: "IMAGE", links: [] }]);
  void src;
  const nativeAddOutput = graph.addOutput.bind(graph);
  graph.addOutput = (name, type) => {
    const slot = nativeAddOutput(name, type);
    slot.connect = () => {
      throw new Error(SLOTS_THROW);
    };
    return slot;
  };
  const executors = buildExecutors(graph);
  assert.throws(
    () =>
      executors.graph_expose_subgraph_output({
        from_node_id: 143,
        from_output: "selected_value",
        name: "image",
      }),
    /the frontend threw[\s\S]*was removed, so the rail carries no slot from this call/,
  );
  assert.deepEqual(graph.outputs, [], "no junk boundary output is left on the rail");
});

test("#1272 expose output: a throw AFTER the rail was wired reports EXPOSED, keeping the slot", () => {
  const graph = mkGraph({ subgraph: true });
  mkNode(graph, 143, [], [{ name: "selected_value", type: "IMAGE", links: [] }]);
  const nativeAddOutput = graph.addOutput.bind(graph);
  graph.addOutput = (name, type) => {
    const slot = nativeAddOutput(name, type);
    slot.afterWrite = () => {
      throw new Error(SLOTS_THROW);
    };
    return slot;
  };
  const executors = buildExecutors(graph);
  const res = executors.graph_expose_subgraph_output({
    from_node_id: 143,
    from_output: "selected_value",
    name: "image",
  });
  assert.equal(res.exposed.name, "image");
  assert.equal(graph.outputs.length, 1);
  assert.equal(graph.outputs[0].linkIds.length, 1);
  assert.match(res.warning, /reading 'slots'/);
});

test("#1272 expose output: a falsy connect still removes the slot (pre-existing behaviour kept)", () => {
  const graph = mkGraph({ subgraph: true });
  mkNode(graph, 143, [], [{ name: "selected_value", type: "IMAGE", links: [] }]);
  const nativeAddOutput = graph.addOutput.bind(graph);
  graph.addOutput = (name, type) => {
    const slot = nativeAddOutput(name, type);
    slot.connect = () => null;
    return slot;
  };
  const executors = buildExecutors(graph);
  assert.throws(
    () =>
      executors.graph_expose_subgraph_output({
        from_node_id: 143,
        from_output: "selected_value",
        name: "image",
      }),
    /Could not link node 143 output/,
  );
  assert.deepEqual(graph.outputs, []);
});

test("#1272 expose input: a throwing connect no longer STRANDS the slot addInput created", () => {
  const graph = mkGraph({ subgraph: true });
  mkNode(graph, 143, [{ name: "image", type: "IMAGE", link: null }], []);
  const nativeAddInput = graph.addInput.bind(graph);
  graph.addInput = (name, type) => {
    const slot = nativeAddInput(name, type);
    slot.connect = () => {
      throw new Error(SLOTS_THROW);
    };
    return slot;
  };
  const executors = buildExecutors(graph);
  assert.throws(
    () =>
      executors.graph_expose_subgraph_input({
        to_node_id: 143,
        to_input: "image",
        name: "image",
      }),
    /the frontend threw[\s\S]*was removed, so the rail carries no slot from this call/,
  );
  assert.deepEqual(graph.inputs, []);
});

test("#1272 expose input: a throw AFTER the rail was wired reports EXPOSED, keeping the slot", () => {
  const graph = mkGraph({ subgraph: true });
  mkNode(graph, 143, [{ name: "image", type: "IMAGE", link: null }], []);
  const nativeAddInput = graph.addInput.bind(graph);
  graph.addInput = (name, type) => {
    const slot = nativeAddInput(name, type);
    slot.afterWrite = () => {
      throw new Error(SLOTS_THROW);
    };
    return slot;
  };
  const executors = buildExecutors(graph);
  const res = executors.graph_expose_subgraph_input({
    to_node_id: 143,
    to_input: "image",
    name: "image",
  });
  assert.equal(res.exposed.name, "image");
  assert.equal(graph.inputs.length, 1);
  assert.match(res.warning, /reading 'slots'/);
});

// ---------------------------------------------------------------------------
// helper-level properties the call sites rely on
// ---------------------------------------------------------------------------

test("findLandedInboundLink: fails CLOSED when the store has no such link", () => {
  const graph = { links: {} };
  const target = { id: 2, inputs: [{ name: "a", link: 5 }] };
  assert.equal(findLandedInboundLink(graph, { id: 1 }, 0, target, []), null);
});

test("findLandedInboundLink: requires the input's OWN back-reference, not just a stored link", () => {
  const graph = { links: { 5: { id: 5, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 } } };
  const orphaned = { id: 2, inputs: [{ name: "a", link: null }] };
  assert.equal(findLandedInboundLink(graph, { id: 1 }, 0, orphaned, []), null);
  const wired = { id: 2, inputs: [{ name: "a", link: 5 }] };
  // The id comes back RAW — a stringified id fed back to the store would miss.
  assert.deepEqual(findLandedInboundLink(graph, { id: 1 }, 0, wired, []), {
    linkId: 5,
    inputIndex: 0,
  });
});

test("findLandedInboundLink: the wrong ORIGIN SLOT does not count as landed", () => {
  const graph = { links: { 5: { id: 5, origin_id: 1, origin_slot: 1, target_id: 2, target_slot: 0 } } };
  const target = { id: 2, inputs: [{ name: "a", link: 5 }] };
  assert.equal(findLandedInboundLink(graph, { id: 1 }, 0, target, []), null);
});

test("readStoredLink: Map-backed stores, record stores and getLink all resolve", () => {
  const rec = { links: { 3: { id: 3 } } };
  assert.equal(readStoredLinkId(rec, 3), 3);
  const map = { links: new Map([[3, { id: 3 }]]) };
  assert.equal(readStoredLinkId(map, 3), 3);
  const viaGetLink = { getLink: (id) => (id === 3 ? { id: 3 } : null) };
  assert.equal(readStoredLinkId(viaGetLink, 3), 3);
});

test("findLandedRailLink: excluded (pre-existing) ids are never credited to this call", () => {
  const graph = {
    links: { 4: { id: 4, origin_id: 9, origin_slot: 0, target_id: -20, target_slot: 0 } },
  };
  const rail = { linkIds: [4] };
  const node = { id: 9 };
  assert.deepEqual(findLandedRailLink(graph, rail, node, 0, "output", null), { linkId: 4 });
  // Exclusion is by STRING — the one place an id may be stringified — so a numeric
  // id and its string form must both suppress it.
  assert.equal(findLandedRailLink(graph, rail, node, 0, "output", ["4"]), null);
  assert.equal(findLandedRailLink(graph, rail, node, 0, "output", [4]), null);
  assert.equal(findLandedRailLink(graph, rail, node, 0, "output", linkIdExclusionSet([4])), null);
});

// ---------------------------------------------------------------------------
// A caller-supplied Set must be NORMALISED, not trusted.
//
// Both finders used to short-circuit on `excludeIds instanceof Set` and use the
// caller's Set verbatim. Membership is asked as `skip.has(String(linkId))`, so a
// Set of RAW NUMBERS — the shape any caller gets from `new Set(railSlot.linkIds)`
// or `new Set(inputLinkIds(node))`, since both id readers deliberately return raw
// ids — matched NOTHING: the exclusion evaporated and a link that existed BEFORE
// the mutation was credited to the current call. That is the same string/number
// key mismatch this file already recovered from once, arriving from the other
// side; `linkIdExclusionSet` is now the unconditional gate on both paths.
// ---------------------------------------------------------------------------

test("both finders normalise a caller-supplied Set — a RAW-number Set still excludes", () => {
  const rail = { linkIds: [4] };
  const node = { id: 9 };
  const railGraph = {
    links: { 4: { id: 4, origin_id: 9, origin_slot: 0, target_id: -20, target_slot: 0 } },
  };
  // Pre-condition: link 4 IS on the rail and IS found when nothing is excluded.
  assert.deepEqual(findLandedRailLink(railGraph, rail, node, 0, "output", null), { linkId: 4 });
  // Excluding it as a raw-number Set must suppress it exactly as an array does.
  assert.equal(findLandedRailLink(railGraph, rail, node, 0, "output", new Set([4])), null);
  assert.equal(findLandedRailLink(railGraph, rail, node, 0, "output", new Set(["4"])), null);

  // The inbound finder leaks identically without normalisation.
  const inboundGraph = {
    links: { 5: { id: 5, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 } },
  };
  const target = { id: 2, inputs: [{ name: "a", link: 5 }] };
  const origin = { id: 1 };
  assert.deepEqual(findLandedInboundLink(inboundGraph, origin, 0, target, null), {
    linkId: 5,
    inputIndex: 0,
  });
  assert.equal(findLandedInboundLink(inboundGraph, origin, 0, target, new Set([5])), null);
  assert.equal(findLandedInboundLink(inboundGraph, origin, 0, target, new Set(["5"])), null);

  // And the normaliser itself accepts a Set, so there is nothing left for a call
  // site to have to special-case.
  assert.deepEqual([...linkIdExclusionSet(new Set([4, 5]))], ["4", "5"]);
});

test("isRailLinkPersisted: the rail slot must list THAT id and the link must join the node", () => {
  const graph = {
    links: { 4: { id: 4, origin_id: 9, origin_slot: 0, target_id: -20, target_slot: 0 } },
  };
  const node = { id: 9 };
  assert.equal(isRailLinkPersisted(graph, { linkIds: [4] }, node, 0, "output", { id: 4 }), true);
  assert.equal(isRailLinkPersisted(graph, { linkIds: [] }, node, 0, "output", { id: 4 }), false);
  assert.equal(isRailLinkPersisted(graph, { linkIds: [4] }, node, 1, "output", { id: 4 }), false);
  assert.equal(isRailLinkPersisted(graph, { linkIds: [4] }, { id: 8 }, 0, "output", { id: 4 }), false);
});

// ---------------------------------------------------------------------------
// The raw-id contract, and the happy paths a stringified id destroyed.
//
// A first version of the rail helper normalised every link id to a string before
// reading the store. Against the plain-object fixture that used to live above,
// `links["7"]` and `links[7]` are the same key, so every test passed. Against the
// real number-keyed Map the lookup MISSES, `findLandedRailLink` returns null for a
// fully persisted link, and because it is the ONLY verdict on both expose paths,
// panel_expose_subgraph_output / _input tore down the slot and link they had just
// correctly created — on the happy path, every time.
// ---------------------------------------------------------------------------

test("readStoredLink: the store is number-keyed — a raw id resolves, a stringified one does NOT", () => {
  const graph = mkGraph({ subgraph: true });
  const link = { id: 7, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0 };
  graph._links.set(7, link);

  // This asymmetry is the CONTRACT, not a defect: `links.get` is the raw bound
  // Map.get and `getLink` is `_links.get`, so both miss "7". Callers must pass the
  // id exactly as the slot holds it.
  assert.equal(readStoredLink(graph, 7), link);
  assert.equal(readStoredLink(graph, "7"), null);
  // Record-shaped stores (older LiteGraph builds) still resolve by raw id.
  assert.equal(readStoredLink({ links: { 7: link } }, 7), link);
});

test("findLandedRailLink: a persisted rail link is FOUND on the real number-keyed store", () => {
  const graph = mkGraph({ subgraph: true });
  const node = mkNode(graph, 12, [], [{ name: "IMAGE", type: "IMAGE", links: [] }]);
  const rail = mkRailOutput(graph, "image", "IMAGE");
  graph.outputs.push(rail);
  rail.connect(node.outputs[0], node);
  assert.equal(graph._links.size, 1);
  assert.deepEqual(findLandedRailLink(graph, rail, node, 0, "output", null), { linkId: 1 });
});

test("#1272 expose output: a CLEAN, non-throwing expose keeps its slot and its link", () => {
  const graph = mkGraph({ subgraph: true });
  mkNode(graph, 12, [], [{ name: "IMAGE", type: "IMAGE", links: [] }]);
  const executors = buildExecutors(graph);

  const res = executors.graph_expose_subgraph_output({ from_node_id: 12, from_output: "IMAGE" });

  assert.equal(res.exposed.name, "IMAGE");
  assert.equal(res.exposed.slot, 0);
  assert.equal(res.warning, undefined, "a successful expose discloses nothing");
  assert.equal(graph.outputs.length, 1, "the slot this call created SURVIVES");
  assert.equal(graph.outputs[0].linkIds.length, 1);
  assert.equal(graph._links.size, 1, "and no link is orphaned");
});

test("#1272 expose input: a CLEAN, non-throwing expose keeps its slot and its link", () => {
  const graph = mkGraph({ subgraph: true });
  const node = mkNode(graph, 12, [{ name: "image", type: "IMAGE", link: null }], []);
  const executors = buildExecutors(graph);

  const res = executors.graph_expose_subgraph_input({ to_node_id: 12, to_input: "image" });

  assert.equal(res.exposed.name, "image");
  assert.equal(res.warning, undefined);
  assert.equal(graph.inputs.length, 1, "the slot this call created SURVIVES");
  assert.equal(graph.inputs[0].linkIds.length, 1);
  assert.equal(node.inputs[0].link, graph.inputs[0].linkIds[0]);
  assert.equal(graph._links.size, 1);
});

test("#1272 repro 2 end-to-end: connect to the output rail (to_node_id -20) that throws AFTER wiring", () => {
  // The issue's second reproduction, verbatim: inside a subgraph, connect an
  // ImpactSwitch output to the subgraph output rail. SubgraphOutput.connect
  // persists the link, then node.onConnectionsChange throws.
  const graph = mkGraph({ subgraph: true });
  const impact = mkNode(graph, 143, [], [{ name: "selected_value", type: "IMAGE", links: [] }]);
  const rail = mkRailOutput(graph, "image", "IMAGE");
  graph.outputs.push(rail);
  rail.afterWrite = () => {
    throw new Error(SLOTS_THROW);
  };
  const executors = buildExecutors(graph);

  const res = executors.graph_connect({
    from_node_id: 143,
    from_output: "selected_value",
    to_node_id: -20,
    to_input: "image",
  });

  assert.equal(res.connected.from.node_id, 143);
  assert.equal(res.connected.to.subgraph_output, "image");
  // panel_graph_outline would show `143 → -20.0`, exactly as the reporter saw.
  assert.equal(rail.linkIds.length, 1);
  assert.equal(graph._links.get(rail.linkIds[0]).origin_id, 143);
  assert.equal(impact.outputs[0].links.length, 1);
  assert.match(res.warning, /reading 'slots'/);
  assert.match(res.warning, /Do NOT retry/);
});

test("#1272 expose output: cleanup is claimed only when the slot ACTUALLY went away", () => {
  // LGraph.removeOutput dispatches a CANCELABLE "removing-output" event and
  // returns without removing when a listener cancels it. A clean return is not a
  // removal, so the message must not claim one.
  const graph = mkGraph({ subgraph: true });
  mkNode(graph, 12, [], [{ name: "IMAGE", type: "IMAGE", links: [] }]);
  const nativeAddOutput = graph.addOutput.bind(graph);
  graph.addOutput = (name, type) => {
    const slot = nativeAddOutput(name, type);
    slot.connect = () => {
      throw new Error(SLOTS_THROW);
    };
    return slot;
  };
  graph.removeOutput = () => {
    /* a listener cancelled the removal — returns cleanly, removes nothing */
  };
  const executors = buildExecutors(graph);
  assert.throws(
    () => executors.graph_expose_subgraph_output({ from_node_id: 12, from_output: "IMAGE" }),
    (err) => {
      assert.match(err.message, /the frontend threw/);
      assert.doesNotMatch(err.message, /was removed/);
      return true;
    },
  );
  assert.equal(graph.outputs.length, 1, "the slot really is still there");
});

test("#1272 node→node: replaced_link is withheld when the original wire is still on the input", () => {
  const graph = mkGraph();
  const src = mkNode(graph, 140, [], [{ name: "IMAGE", type: "IMAGE", links: [] }]);
  const dst = mkNode(
    graph,
    143,
    [
      { name: "input1", type: "IMAGE", link: 7 },
      { name: "input2", type: "IMAGE", link: null },
    ],
    [],
  );
  graph._links.set(7, { id: 7, origin_id: 100, origin_slot: 0, target_id: 143, target_slot: 0 });
  mkNode(graph, 100, [], [{ name: "IMAGE", type: "IMAGE", links: [7] }]);
  graph.lastLinkId = 7;
  // The node re-slots the NEW link onto input2 and leaves input1's wire alone,
  // then throws — so nothing was replaced.
  src.connect = (outIdx, target) => {
    const id = ++graph.lastLinkId;
    graph._links.set(id, {
      id,
      origin_id: 140,
      origin_slot: outIdx,
      target_id: target.id,
      target_slot: 1,
    });
    target.inputs[1].link = id;
    throw new Error(SLOTS_THROW);
  };
  const executors = buildExecutors(graph);
  const res = executors.graph_connect({
    from_node_id: 140,
    from_output: "IMAGE",
    to_node_id: 143,
    to_input: "input1",
  });
  assert.equal(res.connected.to.input, "input2");
  assert.equal(res.connected.replaced_link, undefined, "input1's wire was never displaced");
  assert.equal(dst.inputs[0].link, 7);
});
