/**
 * #1873 — `panel_connect` reported links into dynamic-input selector nodes, the
 * live graph showed them, and the queued prompt did not carry the selected input:
 *
 *     NodeInputError: Node 550 says it needs input image0, but there is no
 *     input to that node at all
 *     ImpactSwitch: invalid select index (ignored)
 *
 * MECHANISM, read from source rather than inferred:
 *
 *   - That backend message means the prompt has no KEY by that name.
 *     `comfy_execution/graph.py:123`, `TopologicalSort.make_input_strong_link`:
 *         inputs = self.dynprompt.get_node(to_node_id)["inputs"]
 *         if to_input not in inputs: raise NodeInputError(f"Node {to_node_id} says it needs
 *             input {to_input}, but there is no input to that node at all")
 *     `easy imageIndexSwitch` declares image0..image19 optional+lazy and its
 *     `check_lazy_status` asks for `"image%d" % index`, so it fires on a missing key.
 *
 *   - The prompt is keyed on the LIVE SLOT NAME at serialize time.
 *     `graphToPrompt`, comfyui_frontend_package 1.49.6 (the reporter's version):
 *         for (const [i, slot] of dto.inputs.entries()) {
 *           const resolved = dto.resolveInput(i)
 *           if (resolved) inputs[slot.name] = [String(origin_id), parseInt(origin_slot)]
 *         }
 *     with `dto.inputs = node.inputs.map(s => ({ linkId, name: s.name, type: s.type }))`.
 *     So "image0 is not there at all" means no live slot is CALLED image0.
 *
 *   - The packs rename them from inside the connect. LiteGraph runs
 *     `onConnectionsChange` from within `connectSlots`, and ComfyUI-Impact-Pack
 *     (js/impact-pack.js, verified byte-identical against the installed pack)
 *     rebuilds every name from its POSITION on each change, then clamps `select`.
 *     The fixture below transcribes that hook rather than paraphrasing it.
 *
 * These tests run the REAL shipped `graph_connect`, extracted from
 * web/js/comfyui-mcp-panel.js — the same technique as connect-title-rewrite and
 * connect-throw-verdict. A helper-only test would stay green against an unwired
 * call site, which is the failure mode those files exist to avoid.
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
} from "../../web/js/lib/connect-verify.js";
import { findExistingRailSlot } from "../../web/js/lib/rail-slot.js";
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

// ---------------------------------------------------------------------------
// Doubles for everything AROUND the code under test. The disclosure helpers are
// the REAL modules — stubbing them would let this pass against a describe that
// always said "renamed".
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

const railIntent = () => null;
const resolveRail = () => null;
const isEmptyRailSlotRef = (ref) => ref == null || ref === "";
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

/**
 * Build `graph_connect` from the shipped source.
 *
 * `overrides` is how the mutation check is done: pass a capture that records
 * nothing and the disclosure must vanish, proving these assertions are pinned to
 * THIS mechanism and not to something the fixture would produce anyway.
 */
function buildConnect(graph, overrides = {}) {
  const deps = {
    getGraphCtx: () => ({ graph, canvas: {}, app: {}, rootGraph: graph, LG: {} }),
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
    ...overrides,
  };
  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `const GRAPH_TOOL_EXECUTORS = {
${connectSrc}
};
return GRAPH_TOOL_EXECUTORS.graph_connect;`,
  );
  return factory(...names.map((n) => deps[n]));
}

/** The REAL link store shape: `_links` is a number-keyed Map (see #1425). */
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

function mkGraph() {
  const store = mkLinkStore();
  const graph = {
    lastLinkId: 0,
    _links: store.map,
    links: store.proxy,
    nodes: [],
    outputs: [],
    inputs: [],
    getNodeById: (id) => graph.nodes.find((n) => String(n.id) === String(id)) ?? null,
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
    getLink: (id) => store.map.get(id) ?? null,
  };
  return graph;
}

// ---------------------------------------------------------------------------
// ImpactSwitch, transcribed from ComfyUI-Impact-Pack js/impact-pack.js.
//
// The `!connected` branch there is guarded by a stack-trace test
// (`!stackTrace.includes('LGraphNode.connect')`) whose purpose is to skip the
// removal when the disconnect is the internal half of a RECONNECT. That guard
// reads a MINIFIED frontend's stack in production, where the class name it looks
// for is not present — so it fails open, which is what `removeOnDisconnect`
// models here. It is a fixture switch, not an assertion about every build.
// ---------------------------------------------------------------------------

const IMPACT_WIDGET_COUNT = 1; // ImpactSwitch / LatentSwitch / SEGSSwitch

function impactOnConnectionsChange(node, { index, connected, inputName = "input", removeOnDisconnect }) {
  if (!connected && node.inputs.length > IMPACT_WIDGET_COUNT + 1 && removeOnDisconnect) {
    if (node.inputs[index].name !== "select") node.inputs.splice(index, 1);
  }
  let slot_i = 1;
  for (let i = 0; i < node.inputs.length; i++) {
    const input_i = node.inputs[i];
    if (input_i.name !== "select" && input_i.name !== "sel_mode") {
      input_i.name = `${inputName}${slot_i}`;
      slot_i++;
    }
  }
  if (connected) {
    node.inputs.push({ name: `${inputName}${slot_i}`, type: node.outputs[0].type, link: null });
  }
  if (node.widgets?.[0]) {
    node.widgets[0].options.max = node.inputs.length - 3;
    node.widgets[0].value = Math.min(node.widgets[0].value, node.widgets[0].options.max);
  }
}

/**
 * The origin's connect(), mirroring `connectSlots` ORDER: the link is written to
 * `graph._links` / `output.links` / `input.link` FIRST, and the nodes'
 * `onConnectionsChange` hooks run only after (see connect-verify.js). A
 * reconnect onto an occupied input drops the old link first, which fires the
 * hook a second time with `connected === false`.
 */
function attachConnect(node, { onChange, throwAfterWrite = false } = {}) {
  node.connect = (outIdx, target, inIdx) => {
    const graph = node.graph;
    const prev = target.inputs[inIdx]?.link;
    if (prev != null) {
      graph._links.delete(prev);
      target.inputs[inIdx].link = null;
      onChange?.({ index: inIdx, connected: false });
    }
    const id = ++graph.lastLinkId;
    const link = { id, origin_id: node.id, origin_slot: outIdx, target_id: target.id, target_slot: inIdx };
    graph._links.set(id, link);
    (node.outputs[outIdx].links ??= []).push(id);
    target.inputs[inIdx].link = id;
    onChange?.({ index: inIdx, connected: true });
    if (throwAfterWrite) throw new Error("Cannot read properties of undefined (reading 'slots')");
    return link;
  };
}

/**
 * A switch node whose dynamic slot names are NOT canonical for their positions.
 *
 * This is the state a LOADED workflow is in: the pack's hook returns early when
 * the stack contains `loadGraphData`, so the saved names survive the load
 * untouched, and the FIRST connect afterwards runs the renumbering loop over all
 * of them. `input3` at index 3 becomes `input2`.
 */
function loadedSwitchFixture({ select = 1, throwAfterWrite = false } = {}) {
  const graph = mkGraph();
  const source = mkNodeWithOutput(graph, 1, "Load Image");
  const sw = {
    id: 2,
    title: "ImpactSwitch",
    graph,
    inputs: [
      { name: "select", type: "INT", link: null },
      { name: "sel_mode", type: "BOOLEAN", link: null },
      { name: "input1", type: "IMAGE", link: 900 },
      { name: "input3", type: "IMAGE", link: null },
    ],
    outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
    widgets: [{ name: "select", value: select, options: { max: 1 } }],
  };
  graph.nodes.push(sw);
  attachConnect(source, {
    throwAfterWrite,
    onChange: ({ index, connected }) =>
      impactOnConnectionsChange(sw, { index, connected, removeOnDisconnect: false }),
  });
  return { graph, source, sw };
}

/** A canonically-named switch with one empty trailing slot — the ordinary case. */
function canonicalSwitchFixture() {
  const graph = mkGraph();
  const source = mkNodeWithOutput(graph, 1, "Load Image");
  const sw = {
    id: 2,
    title: "ImpactSwitch",
    graph,
    inputs: [
      { name: "select", type: "INT", link: null },
      { name: "sel_mode", type: "BOOLEAN", link: null },
      { name: "input1", type: "IMAGE", link: null },
    ],
    outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
    widgets: [{ name: "select", value: 1, options: { max: 1 } }],
  };
  graph.nodes.push(sw);
  attachConnect(source, {
    onChange: ({ index, connected }) =>
      impactOnConnectionsChange(sw, { index, connected, removeOnDisconnect: false }),
  });
  return { graph, source, sw };
}

/**
 * A fully-wired switch, reconnected onto an already-occupied input — the path
 * where the pack drops a slot and re-clamps `select`.
 */
function reconnectSwitchFixture() {
  const graph = mkGraph();
  const source = mkNodeWithOutput(graph, 1, "Load Image");
  const sw = {
    id: 2,
    title: "ImpactSwitch",
    graph,
    inputs: [
      { name: "select", type: "INT", link: null },
      { name: "sel_mode", type: "BOOLEAN", link: null },
      { name: "input1", type: "IMAGE", link: 901 },
      { name: "input2", type: "IMAGE", link: 902 },
      { name: "input3", type: "IMAGE", link: 903 },
      { name: "input4", type: "IMAGE", link: null },
    ],
    outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
    widgets: [{ name: "select", value: 3, options: { max: 3 } }],
  };
  graph.nodes.push(sw);
  for (const id of [901, 902, 903]) {
    graph._links.set(id, { id, origin_id: 99, origin_slot: 0, target_id: 2, target_slot: 0 });
  }
  attachConnect(source, {
    onChange: ({ index, connected }) =>
      impactOnConnectionsChange(sw, { index, connected, removeOnDisconnect: true }),
  });
  return { graph, source, sw };
}

function mkNodeWithOutput(graph, id, title) {
  const node = { id, title, inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }], graph };
  graph.nodes.push(node);
  return node;
}

// ---------------------------------------------------------------------------
// The reported path
// ---------------------------------------------------------------------------

test("#1873 shipped graph_connect: a slot the pack RENAMES is disclosed", () => {
  const { graph, sw } = loadedSwitchFixture();
  const graph_connect = buildConnect(graph);

  const res = graph_connect({ from_node_id: 1, from_output: 0, to_node_id: 2, to_input: "input3" });

  // The wire is real — a rename must never be reported as a connect failure.
  assert.equal(res.connected.to.node_id, 2);
  // The pack really did renumber it: the slot the caller addressed as "input3"
  // is called "input2" now, and it is the name the queued prompt will carry.
  assert.equal(sw.inputs[3].name, "input2");

  assert.deepEqual(res.slots_rewritten, [
    { node_id: 2, slots: [{ kind: "input", index: 3, from: "input3", to: "input2" }], widgets: [] },
  ]);
  assert.match(res.warning, /RE-ADDRESSED/);
  assert.match(res.warning, /"input3" → "input2"/);
  assert.match(res.warning, /no input to that node at all/);
  assert.match(res.warning, /panel_query_graph/);
});

test("#1873 the appended trailing slot is NOT reported — an ordinary connect is unchanged", () => {
  const { graph, sw } = canonicalSwitchFixture();
  const graph_connect = buildConnect(graph);

  const res = graph_connect({ from_node_id: 1, from_output: 0, to_node_id: 2, to_input: "input1" });

  // The pack DID materialise the next empty input — this is the state the
  // suppression has to stay silent about, not an absence of pack behaviour.
  assert.deepEqual(
    sw.inputs.map((s) => s.name),
    ["select", "sel_mode", "input1", "input2"],
  );
  assert.equal(res.connected.to.input, "input1");
  assert.equal(res.slots_rewritten, undefined, "a new trailing slot is not a rewrite");
  assert.equal(res.warning, undefined);
});

test("#1873 the select widget the pack CLAMPS is disclosed", () => {
  const { graph, sw } = reconnectSwitchFixture();
  const graph_connect = buildConnect(graph);

  const res = graph_connect({ from_node_id: 1, from_output: 0, to_node_id: 2, to_input: "input1" });

  // This is the reporter's second symptom: "ImpactSwitch: invalid select index".
  // The pack re-clamped `select` from inside the connect, so the value the
  // caller chose now selects a different input than the one they meant.
  assert.equal(sw.widgets[0].value, 2, "the pack really did clamp it");
  assert.equal(res.slots_rewritten.length, 1);
  assert.deepEqual(res.slots_rewritten[0].widgets, [{ name: "select", from: 3, to: 2 }]);
  assert.match(res.warning, /widget "select" 3 → 2/);
});

test("#1873 the disclosure survives the THROW path", () => {
  const { graph } = loadedSwitchFixture({ throwAfterWrite: true });
  const graph_connect = buildConnect(graph);

  // #1272: the link is written before the hooks run, so a throw still leaves a
  // landed wire — and a node left mid-reshape is exactly when the caller most
  // needs to be told its slot names moved.
  const res = graph_connect({ from_node_id: 1, from_output: 0, to_node_id: 2, to_input: "input3" });

  assert.equal(res.connected.to.node_id, 2);
  assert.deepEqual(res.slots_rewritten, [
    { node_id: 2, slots: [{ kind: "input", index: 3, from: "input3", to: "input2" }], widgets: [] },
  ]);
  assert.match(res.warning, /RE-ADDRESSED/);
  // The throw-path warning is not REPLACED by the new rider.
  assert.match(res.warning, /Do NOT retry this connect/);
});

// ---------------------------------------------------------------------------
// Mutation check — the assertions above must come from the FIX
// ---------------------------------------------------------------------------

test("#1873 the disclosure is produced by the FIX, not by the fixture", () => {
  const { graph, sw } = loadedSwitchFixture();
  // Neuter only the capture. The fixture's rename is untouched: if the
  // assertions above could pass without the call site reading the snapshot,
  // they would pass here too.
  const graph_connect = buildConnect(graph, { captureSlotNames: () => [] });

  const res = graph_connect({ from_node_id: 1, from_output: 0, to_node_id: 2, to_input: "input3" });

  assert.equal(sw.inputs[3].name, "input2", "the pack still renamed it");
  assert.equal(res.connected.to.node_id, 2, "the connect itself is unaffected");
  assert.equal(res.slots_rewritten, undefined);
  assert.equal(res.warning, undefined);
});

test("#1873 a node that becomes unreadable mid-connect does not fail a LANDED wire", () => {
  const { graph, sw } = loadedSwitchFixture();
  // The pack breaks its own `widgets` accessor from inside the connect. This is
  // the one property `describeSlotRewrites` reads that `graph_connect` does not,
  // so a throw here can ONLY escape through the disclosure rider — which is
  // exactly the contract its header promises it never does. The capture already
  // happened, so the BEFORE snapshot exists and the read-back is what throws.
  let broken = false;
  const original = sw.widgets;
  Object.defineProperty(sw, "widgets", {
    configurable: true,
    get() {
      if (broken) throw new TypeError("widgets accessor removed by the pack");
      return original;
    },
  });
  const source = graph.getNodeById(1);
  const prior = source.connect;
  source.connect = (outIdx, target, inIdx) => {
    const link = prior(outIdx, target, inIdx);
    broken = true;
    return link;
  };
  const graph_connect = buildConnect(graph);

  const res = graph_connect({ from_node_id: 1, from_output: 0, to_node_id: 2, to_input: "input3" });

  // The wire landed; the unreadable node must cost the caller nothing but the
  // disclosure it could not compute.
  assert.equal(res.connected.to.node_id, 2);
  assert.equal(res.slots_rewritten, undefined);
});

test("#1873 hostile widget VALUES are safe in the full bridge envelope (gate P1)", () => {
  // A widget value is whatever the pack put there. The bridge serializes the
  // FULL reply envelope after the executor returns, so protecting only the
  // warning sentence is insufficient: raw values in slots_rewritten would still
  // turn a landed wire into a missing reply.
  const circular = { name: "loop" };
  circular.self = circular;
  const throwingGetter = {};
  Object.defineProperty(throwingGetter, "secret", {
    enumerable: true,
    get() {
      throw new Error("hostile getter");
    },
  });
  const oversized = { payload: "x".repeat(1000) };
  const giantBigIntDigits = "9".repeat(100_000);
  const giantBigInt = BigInt(giantBigIntDigits);
  for (const [label, hostile, expected] of [
    ["BigInt", 2n, "2n"],
    ["giant BigInt", giantBigInt, null],
    ["circular", circular, "(unrenderable)"],
    ["oversized", oversized, null],
    ["throwing getter", throwingGetter, "(unrenderable)"],
    ["symbol", Symbol("secret"), "(symbol)"],
    ["function", () => "secret", "(function)"],
  ]) {
    const graph = mkGraph();
    const source = mkNodeWithOutput(graph, 1, "Load Image");
    const node = {
      id: 2,
      title: "Switch",
      graph,
      inputs: [{ name: "input1", type: "IMAGE", link: null }],
      outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
      widgets: [{ name: "select", value: 1, options: { max: 1 } }],
    };
    graph.nodes.push(node);
    attachConnect(source, {
      onChange: () => {
        node.widgets[0].value = hostile;
      },
    });
    const graph_connect = buildConnect(graph);

    const res = graph_connect({ from_node_id: 1, from_output: 0, to_node_id: 2, to_input: "input1" });
    const rewrite = res.slots_rewritten?.[0]?.widgets?.[0];
    const reply = { rid: `${label}-rid`, ok: true, result: res };
    let encoded;
    assert.doesNotThrow(() => {
      encoded = JSON.stringify(reply);
    }, `${label}: the production bridge envelope must serialize`);

    assert.equal(res.connected.to.node_id, 2, `${label}: the wire landed`);
    assert.equal(res.slots_rewritten.length, 1, `${label}: the change is still disclosed`);
    assert.notEqual(rewrite?.to, hostile, `${label}: the raw value is not returned`);
    if (expected) assert.equal(rewrite?.to, expected, `${label}: hostile value has a fixed safe form`);
    else {
      assert.equal(typeof rewrite?.to, "string", `${label}: oversized value is represented as text`);
      assert.ok(rewrite.to.length <= 121, `${label}: disclosure value is bounded`);
      assert.equal(rewrite.to.endsWith("…"), true, `${label}: truncation is disclosed`);
      const rawValue = label === "giant BigInt" ? `${giantBigIntDigits}n` : "x".repeat(1000);
      assert.equal(encoded.includes(rawValue), false, `${label}: raw value is not leaked`);
    }
  }
});

test("#1873 warning rendering bounds a direct giant BigInt too", () => {
  const giantDigits = "9".repeat(100_000);
  const giant = BigInt(giantDigits);
  const warning = slotRewriteWarning([
    { node_id: 2, slots: [], widgets: [{ name: "select", from: 1, to: giant }] },
  ]);
  const reply = { rid: "giant-warning-rid", ok: true, result: { warning } };

  assert.doesNotThrow(() => JSON.stringify(reply), "the direct warning envelope must serialize");
  assert.ok(warning.length < 2000, "the warning stays bounded");
  assert.equal(warning.includes(`${giantDigits}n`), false, "the giant BigInt is not leaked");
  assert.match(warning, /widget "select" 1 → 9+…/);
});

test("#1873 a connect that changes nothing addressable stays byte-identical", () => {
  const graph = mkGraph();
  const source = mkNodeWithOutput(graph, 1, "Load Image");
  const plain = {
    id: 2,
    title: "SaveImage",
    graph,
    inputs: [{ name: "images", type: "IMAGE", link: null }],
    outputs: [],
  };
  graph.nodes.push(plain);
  attachConnect(source, {});
  const graph_connect = buildConnect(graph);

  const res = graph_connect({ from_node_id: 1, from_output: 0, to_node_id: 2, to_input: "images" });

  assert.equal(res.connected.to.input, "images");
  assert.equal(res.slots_rewritten, undefined);
  assert.equal(res.title_rewritten, undefined);
  assert.equal(res.warning, undefined);
});
