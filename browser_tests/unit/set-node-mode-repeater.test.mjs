/**
 * #2262 — panel_set_node_mode reports bypass on an rgthree Mute / Bypass Repeater
 * (and its SaveVideo target) while a fresh outline still reads mute.
 *
 * The pack stamps connected inputs in `onModeChange`, which only runs when the
 * `mode` ACCESSOR fires. A data-property write (`node.mode = 4`) sticks on the
 * wrapper, so the receipt echoes bypass, but the targets never move — and a
 * later repeater tick copies the wrapper's still-muted `this.mode` back onto
 * them. These tests drive the shipped `applyGraphNodeMode` and the extracted
 * `graph_set_node_mode` body against that fixture.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applyGraphNodeMode,
  NODE_MODE_REPEATER_TYPE,
  NODE_MODE_RELAY_TYPE,
  NodeModeWriteError,
} from "../../web/js/lib/set-node-mode.js";

const REPEATER = NODE_MODE_REPEATER_TYPE;
const RELAY = NODE_MODE_RELAY_TYPE;

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");
const legacyModeMatch = panelSrc.match(/graph_set_node_mode\(\{ node_id, mode, force \}\) \{[\s\S]*?\n  \},/);
assert.ok(legacyModeMatch, "could not locate graph_set_node_mode in panel source");

function normalizeLegacyNodeId(nodeId) {
  if (typeof nodeId === "number" && Number.isInteger(nodeId)) return nodeId;
  if (typeof nodeId === "string" && /^-?(?:0|[1-9]\d*)$/.test(nodeId)) {
    const normalized = Number(nodeId);
    if (Number.isSafeInteger(normalized)) return normalized;
  }
  throw new Error("node_id must be an integer");
}

function realSetNodeMode(getGraphCtx, resolveNode) {
  return new Function(
    "getGraphCtx",
    "resolveNode",
    "unsafeBypassMappings",
    "normalizeLegacyNodeId",
    "applyGraphNodeMode",
    `const executors = { ${legacyModeMatch[0]} }; return executors.graph_set_node_mode;`,
  )(getGraphCtx, resolveNode, () => [], normalizeLegacyNodeId, applyGraphNodeMode);
}

function makeGraph() {
  const byId = new Map();
  const links = {};
  const graph = {
    links,
    _nodes: [],
    _groups: [],
    getNodeById: (id) => byId.get(id) ?? null,
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
  };
  const add = (node) => {
    node.graph = graph;
    byId.set(node.id, node);
    graph._nodes.push(node);
    return node;
  };
  return { graph, add, links };
}

/**
 * Repeater whose `mode` is a DATA field. Assignment does not call onModeChange.
 * That is the unfixed hole: the wrapper reads back bypass, the target stays mute.
 */
function makeDataRepeater(id, mode = 2) {
  const node = {
    id,
    type: REPEATER,
    title: REPEATER,
    mode,
    inputs: [],
    onModeChange(_from, to) {
      for (const slot of node.inputs ?? []) {
        if (typeof slot?.link !== "number") continue;
        const origin = node.graph.getNodeById(node.graph.links[slot.link]?.origin_id);
        if (origin && origin.type !== RELAY) origin.mode = to;
      }
    },
  };
  return node;
}

/** Repeater with rgthree's accessor (stores rgthree_mode, fires onModeChange). */
function makeAccessorRepeater(id, mode = 2) {
  const node = {
    id,
    type: REPEATER,
    title: REPEATER,
    rgthree_mode: mode,
    inputs: [],
    onModeChange(_from, to) {
      for (const slot of node.inputs ?? []) {
        if (typeof slot?.link !== "number") continue;
        const origin = node.graph.getNodeById(node.graph.links[slot.link]?.origin_id);
        if (origin && origin.type !== RELAY) origin.mode = to;
      }
    },
  };
  Object.defineProperty(node, "mode", {
    configurable: true,
    enumerable: true,
    get() {
      return node.rgthree_mode;
    },
    set(value) {
      if (node.rgthree_mode != value) {
        const old = node.rgthree_mode;
        node.rgthree_mode = value;
        node.onModeChange(old, value);
      }
    },
  });
  return node;
}

function naiveAssign(node, target) {
  node.mode = target;
}

test("#2262 unfixed: assigning mode on a data-field repeater does not move SaveVideo", () => {
  const { graph, add } = makeGraph();
  const save = add({ id: 11, type: "SaveVideo", title: "SaveVideo", mode: 2 });
  const repeater = add(makeDataRepeater(17, 2));
  graph.links[1] = { origin_id: 11, target_id: 17 };
  repeater.inputs = [{ link: 1 }];

  naiveAssign(repeater, 4);
  assert.equal(repeater.mode, 4, "the wrapper assignment sticks");
  assert.equal(save.mode, 2, "SaveVideo stays mute — the receipt would lie");
});

test("#2262: applyGraphNodeMode bypasses a data-field repeater AND its SaveVideo", () => {
  const { graph, add } = makeGraph();
  const save = add({ id: 11, type: "SaveVideo", title: "SaveVideo", mode: 2 });
  const repeater = add(makeDataRepeater(17, 2));
  graph.links[1] = { origin_id: 11, target_id: 17 };
  repeater.inputs = [{ link: 1 }];

  const result = applyGraphNodeMode(repeater, 4, graph);
  assert.equal(repeater.mode, 4);
  assert.equal(save.mode, 4);
  assert.equal(result.actual, 4);
  assert.equal(result.previous, 2);
  assert.equal(result.propagated.length, 1);
  assert.equal(result.propagated[0].node_id, 11);
});

test("#2262: setting SaveVideo also moves the owning mute repeater so a later tick cannot re-mute", () => {
  const { graph, add } = makeGraph();
  const save = add({ id: 11, type: "SaveVideo", title: "SaveVideo", mode: 2 });
  const repeater = add(makeDataRepeater(17, 2));
  graph.links[1] = { origin_id: 11, target_id: 17 };
  repeater.inputs = [{ link: 1 }];

  applyGraphNodeMode(save, 4, graph);
  assert.equal(save.mode, 4);
  assert.equal(repeater.mode, 4);

  // Pack onConnectionsChange: changeModeOfNodes(inputNode, this.mode)
  save.mode = repeater.mode;
  assert.equal(save.mode, 4, "a later repeater tick must not copy mute back onto SaveVideo");
});

test("#2262: an accessor repeater still bypasses its wired target", () => {
  const { graph, add } = makeGraph();
  const save = add({ id: 11, type: "SaveVideo", title: "SaveVideo", mode: 2 });
  const repeater = add(makeAccessorRepeater(18, 2));
  graph.links[2] = { origin_id: 11, target_id: 18 };
  repeater.inputs = [{ link: 2 }];

  applyGraphNodeMode(repeater, 4, graph);
  assert.equal(repeater.mode, 4);
  assert.equal(repeater.rgthree_mode, 4);
  assert.equal(save.mode, 4);
});

test("#2262: a group-mode repeater (no inputs) stamps the other group members", () => {
  const { graph, add } = makeGraph();
  const save = add({ id: 11, type: "SaveVideo", title: "SaveVideo", mode: 2 });
  const repeater = add(makeDataRepeater(17, 2));
  const group = { _children: new Set([save, repeater]), recomputeInsideNodes() {} };
  graph._groups = [group];

  applyGraphNodeMode(repeater, 4, graph);
  assert.equal(repeater.mode, 4);
  assert.equal(save.mode, 4);
});

test("#2262: ordinary nodes still change in isolation", () => {
  const { graph, add } = makeGraph();
  const ksampler = add({ id: 1, type: "KSampler", title: "KSampler", mode: 0 });
  const other = add({ id: 2, type: "CLIPTextEncode", title: "CLIP", mode: 0 });
  const result = applyGraphNodeMode(ksampler, 4, graph);
  assert.equal(ksampler.mode, 4);
  assert.equal(other.mode, 0);
  assert.deepEqual(result.propagated, []);
});

test("#2262: a mismatched target is refused and the journal is restored", () => {
  const { graph, add } = makeGraph();
  const save = add({ id: 11, type: "SaveVideo", title: "SaveVideo", mode: 2 });
  Object.defineProperty(save, "mode", {
    configurable: true,
    enumerable: true,
    get() {
      return 2;
    },
    set() {},
  });
  const repeater = add(makeDataRepeater(17, 2));
  graph.links[1] = { origin_id: 11, target_id: 17 };
  repeater.inputs = [{ link: 1 }];

  assert.throws(
    () => applyGraphNodeMode(repeater, 4, graph),
    (error) =>
      error instanceof NodeModeWriteError &&
      /still reads "mute"/.test(error.message) &&
      /Nothing is being reported as changed/.test(error.message),
  );
  assert.equal(repeater.mode, 2, "the repeater is restored");
});

test("#2262: shipped graph_set_node_mode bypasses repeater + SaveVideo together", () => {
  const { graph, add } = makeGraph();
  const save = add({ id: 11, type: "SaveVideo", title: "SaveVideo", mode: 2 });
  const r17 = add(makeDataRepeater(17, 2));
  const r18 = add(makeDataRepeater(18, 2));
  graph.links[1] = { origin_id: 11, target_id: 17 };
  graph.links[2] = { origin_id: 11, target_id: 18 };
  r17.inputs = [{ link: 1 }];
  r18.inputs = [{ link: 2 }];

  const fn = realSetNodeMode(
    () => ({ graph }),
    (_graph, id) => {
      const node = graph.getNodeById(id);
      if (!node) throw new Error(`No node with id ${id}`);
      return node;
    },
  );

  const a = fn({ node_id: 17, mode: "bypass" });
  assert.equal(a.mode, "bypass");
  assert.equal(a.previous_mode, "mute");
  assert.equal(r17.mode, 4);
  assert.equal(save.mode, 4);
  assert.equal(r18.mode, 4, "the sibling owning repeater is moved so it cannot re-mute SaveVideo");

  const b = fn({ node_id: 11, mode: "bypass" });
  assert.equal(b.mode, "bypass");
  assert.equal(save.mode, 4);
  assert.equal(r17.mode, 4);
  assert.equal(r18.mode, 4);
});
