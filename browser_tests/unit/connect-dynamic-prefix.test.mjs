/**
 * #2008 — `panel_connect` by dotted Autogrow name (`ref_images.ref_image_4`)
 * can re-address later MiniMaxH3ReferenceToVideo slots.
 *
 * MECHANISM, read from the node schema rather than inferred:
 *
 *   MiniMaxH3ReferenceToVideo (comfy_extras/nodes_minimax_h3.py) declares
 *   four `io.Autogrow.Input` families with TemplatePrefix children:
 *     ref_images.ref_image_N, ref_videos.ref_video_N,
 *     ref_video_audios.ref_video_audio_N, ref_audios.ref_audio_N
 *   plus stable widget inputs prompt / width / height / length.
 *
 *   Connecting to a dotted child runs the family's onConnectionsChange, which
 *   inserts a new sibling and shifts every later input. Logical identity is
 *   the NAME (`ref_images.ref_image_4`), not the index. Index-aligned
 *   `slots_rewritten` / `collateral_changes` then reported later families as
 *   re-addressed, making the next name-based edit hazardous.
 *
 * Two fixtures transcribe the hook rather than paraphrasing it:
 *
 *   - INSERT: splice a new sibling, keep slot objects, bump later target_slot.
 *     This is honest Autogrow growth. The connect must stay silent.
 *   - REBUILD: replace the inputs array with new objects and copy links BY
 *     POSITION, landing later names on the wrong wires. Reconcile must put
 *     each surviving name's original link back.
 *
 * These tests run the REAL shipped `graph_connect`, extracted from
 * web/js/comfyui-mcp-panel.js — same technique as connect-slot-rename.
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
  snapshotInputSlotNames,
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
import {
  isDynamicPrefixSlotName,
  captureNamedSlotLinks,
  findSlotIndexByName,
  reconcileDynamicPrefixSlots,
} from "../../web/js/lib/dynamic-slot-reconcile.js";

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

const railIntent = () => null;
const resolveRail = () => null;
const isEmptyRailSlotRef = (ref) => ref == null || ref === "";
const slotDiagnostic = () => "slot diagnostic";
const loopbackRefusalReason = () => "loopback";
const findSubgraphHostNode = () => null;
const uniqueSubgraphOutputName = (_g, base) => base;
const uniqueSubgraphInputName = (_g, base) => base;

function buildConnect(graph, overrides = {}) {
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
    autoMatchSlots: (origin, target, from_output, to_input) => ({
      outIdx: resolveSlot(origin.outputs, from_output ?? 0, "output"),
      inIdx: resolveSlot(target.inputs, to_input ?? 0, "input"),
      autoMatched: [],
    }),
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
    snapshotInputSlotNames,
    verifyConnect,
    connectCollateralBullets,
    connectCollateralWarning,
    captureNodeTitles,
    describeTitleRewrites,
    titleRewriteWarning,
    captureSlotNames,
    describeSlotRewrites,
    slotRewriteWarning,
    isDynamicPrefixSlotName,
    captureNamedSlotLinks,
    findSlotIndexByName,
    reconcileDynamicPrefixSlots,
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
  const nodes = [];
  const graph = {
    lastLinkId: 0,
    _links: store.map,
    links: store.proxy,
    nodes,
    _nodes: nodes,
    outputs: [],
    inputs: [],
    getNodeById: (id) => nodes.find((n) => String(n.id) === String(id)) ?? null,
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
    getLink: (id) => store.map.get(id) ?? null,
  };
  return graph;
}

const MINIMAX_INPUTS = () => [
  { name: "clip", type: "CLIP", link: null },
  { name: "vae", type: "VAE", link: null },
  { name: "audio_vae", type: "VAE", link: null },
  { name: "prompt", type: "STRING", link: 801 },
  { name: "width", type: "INT", link: null },
  { name: "height", type: "INT", link: null },
  { name: "length", type: "INT", link: null },
  { name: "ref_image_size", type: "COMBO", link: null },
  { name: "ref_images.ref_image_0", type: "IMAGE", link: 802 },
  { name: "ref_images.ref_image_1", type: "IMAGE", link: 803 },
  { name: "ref_images.ref_image_2", type: "IMAGE", link: 804 },
  { name: "ref_images.ref_image_3", type: "IMAGE", link: 805 },
  { name: "ref_images.ref_image_4", type: "IMAGE", link: null },
  { name: "ref_videos.ref_video_0", type: "IMAGE", link: 806 },
  { name: "ref_audios.ref_audio_0", type: "AUDIO", link: 807 },
];

function seedPreexistingLinks(graph, targetId) {
  const rows = [
    [801, 90, 3],
    [802, 91, 8],
    [803, 92, 9],
    [804, 93, 10],
    [805, 94, 11],
    [806, 95, 13],
    [807, 96, 14],
  ];
  for (const [id, originId, targetSlot] of rows) {
    graph._links.set(id, {
      id,
      origin_id: originId,
      origin_slot: 0,
      target_id: targetId,
      target_slot: targetSlot,
    });
  }
}

function familyEnd(inputs, family) {
  let last = -1;
  for (let i = 0; i < inputs.length; i++) {
    if (typeof inputs[i]?.name === "string" && inputs[i].name.startsWith(`${family}.`)) last = i;
  }
  return last;
}

/** Honest Autogrow: splice a new sibling, keep later slot objects, bump target_slot. */
function autogrowInsert(node, graph, { index, connected }) {
  if (!connected) return;
  const name = node.inputs[index]?.name;
  if (!isDynamicPrefixSlotName(name)) return;
  const family = name.slice(0, name.indexOf("."));
  const last = familyEnd(node.inputs, family);
  if (last < 0) return;
  const used = node.inputs
    .filter((s) => typeof s?.name === "string" && s.name.startsWith(`${family}.`))
    .map((s) => Number(String(s.name).split("_").pop()))
    .filter((n) => Number.isFinite(n));
  const next = Math.max(-1, ...used) + 1;
  const child = name.slice(name.indexOf(".") + 1).replace(/\d+$/, "");
  const slot = { name: `${family}.${child}${next}`, type: node.inputs[index].type, link: null };
  node.inputs.splice(last + 1, 0, slot);
  for (const rec of graph._links.values()) {
    if (rec.target_id === node.id && rec.target_slot > last) rec.target_slot += 1;
  }
}

/**
 * Hostile rebuild: new slot objects, links copied BY POSITION so later names
 * inherit the previous index's wire. This is the scramble reconcile must undo.
 */
function autogrowRebuild(node, graph, { index, connected }) {
  if (!connected) return;
  const name = node.inputs[index]?.name;
  if (!isDynamicPrefixSlotName(name)) return;
  const family = name.slice(0, name.indexOf("."));
  const last = familyEnd(node.inputs, family);
  const used = node.inputs
    .filter((s) => typeof s?.name === "string" && s.name.startsWith(`${family}.`))
    .map((s) => Number(String(s.name).split("_").pop()))
    .filter((n) => Number.isFinite(n));
  const next = Math.max(-1, ...used) + 1;
  const child = name.slice(name.indexOf(".") + 1).replace(/\d+$/, "");
  const names = node.inputs.map((s) => s.name);
  names.splice(last + 1, 0, `${family}.${child}${next}`);
  const types = node.inputs.map((s) => s.type);
  types.splice(last + 1, 0, node.inputs[index].type);
  const oldLinks = node.inputs.map((s) => s.link);
  node.inputs = names.map((n, i) => ({
    name: n,
    type: types[i],
    link: i < oldLinks.length ? oldLinks[i] : null,
  }));
  for (const rec of graph._links.values()) {
    if (rec.target_id === node.id && rec.target_slot > last) rec.target_slot += 1;
  }
}

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
    if (throwAfterWrite) throw new Error("autogrow hook threw");
    return link;
  };
}

function minimaxFixture({ mode = "insert", throwAfterWrite = false } = {}) {
  const graph = mkGraph();
  const source = {
    id: 1,
    title: "LoadImage",
    graph,
    inputs: [],
    outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
  };
  graph.nodes.push(source);
  const mm = {
    id: 136,
    type: "MiniMaxH3ReferenceToVideo",
    title: "MiniMax H3 Reference to Video",
    graph,
    inputs: MINIMAX_INPUTS(),
    outputs: [{ name: "positive", type: "CONDITIONING", links: [] }],
  };
  graph.nodes.push(mm);
  seedPreexistingLinks(graph, 136);
  const hook = mode === "rebuild" ? autogrowRebuild : autogrowInsert;
  attachConnect(source, {
    throwAfterWrite,
    onChange: ({ index, connected }) => hook(mm, graph, { index, connected }),
  });
  return { graph, source, mm };
}

function nameLink(node, name) {
  const slot = node.inputs.find((s) => s.name === name);
  return slot?.link ?? null;
}

test("#2008 dotted-name helper is the Autogrow child shape, not positional packs", () => {
  assert.equal(isDynamicPrefixSlotName("ref_images.ref_image_4"), true);
  assert.equal(isDynamicPrefixSlotName("input3"), false);
  assert.equal(isDynamicPrefixSlotName("prompt"), false);
  assert.equal(isDynamicPrefixSlotName(null), false);
});

test("#2008 INSERT: connecting to ref_images.ref_image_4 keeps later names and stays silent", () => {
  const { graph, mm } = minimaxFixture({ mode: "insert" });
  const videoLink = nameLink(mm, "ref_videos.ref_video_0");
  const audioLink = nameLink(mm, "ref_audios.ref_audio_0");
  const promptLink = nameLink(mm, "prompt");
  const graph_connect = buildConnect(graph);

  const res = graph_connect({
    from_node_id: 1,
    from_output: 0,
    to_node_id: 136,
    to_input: "ref_images.ref_image_4",
  });

  assert.equal(res.connected.to.node_id, 136);
  assert.equal(res.connected.to.input, "ref_images.ref_image_4");
  assert.ok(nameLink(mm, "ref_images.ref_image_4") != null, "the requested dotted slot holds the new wire");
  assert.ok(mm.inputs.some((s) => s.name === "ref_images.ref_image_5"), "Autogrow grew a sibling");
  assert.equal(nameLink(mm, "ref_videos.ref_video_0"), videoLink);
  assert.equal(nameLink(mm, "ref_audios.ref_audio_0"), audioLink);
  assert.equal(nameLink(mm, "prompt"), promptLink);
  assert.equal(res.slots_rewritten, undefined, "an index shift of intact names is not a rewrite");
  assert.ok(!("collateral_changes" in res), "nor collateral");
  assert.equal(res.warning, undefined);
});

test("#2008 REBUILD: later names that inherited the wrong link are restored", () => {
  const { graph, mm } = minimaxFixture({ mode: "rebuild" });
  const videoLink = nameLink(mm, "ref_videos.ref_video_0");
  const audioLink = nameLink(mm, "ref_audios.ref_audio_0");
  const promptLink = nameLink(mm, "prompt");
  const image3 = nameLink(mm, "ref_images.ref_image_3");
  const graph_connect = buildConnect(graph);

  const res = graph_connect({
    from_node_id: 1,
    from_output: 0,
    to_node_id: 136,
    to_input: "ref_images.ref_image_4",
  });

  assert.equal(res.connected.to.input, "ref_images.ref_image_4");
  assert.ok(nameLink(mm, "ref_images.ref_image_4") != null);
  assert.equal(nameLink(mm, "ref_videos.ref_video_0"), videoLink, "video family must keep its wire");
  assert.equal(nameLink(mm, "ref_audios.ref_audio_0"), audioLink);
  assert.equal(nameLink(mm, "prompt"), promptLink);
  assert.equal(nameLink(mm, "ref_images.ref_image_3"), image3);
  assert.ok(!("collateral_changes" in res), "restored names must not read as bystander damage");
});

test("#2008 REBUILD restore is produced by reconcile, not by the fixture", () => {
  const { graph, mm } = minimaxFixture({ mode: "rebuild" });
  const videoLink = nameLink(mm, "ref_videos.ref_video_0");
  const graph_connect = buildConnect(graph, { reconcileDynamicPrefixSlots: () => null });

  const res = graph_connect({
    from_node_id: 1,
    from_output: 0,
    to_node_id: 136,
    to_input: "ref_images.ref_image_4",
  });

  assert.equal(res.connected.to.node_id, 136, "the wire still lands");
  assert.notEqual(
    nameLink(mm, "ref_videos.ref_video_0"),
    videoLink,
    "without reconcile the positional copy leaves the video family on the wrong wire",
  );
});

test("#2008 positional ImpactSwitch names are not reconciled", () => {
  const before = captureNamedSlotLinks({
    inputs: [{ name: "input3", link: 1 }],
  });
  const node = { id: 2, inputs: [{ name: "input2", link: 9 }] };
  const res = reconcileDynamicPrefixSlots({
    graph: { links: new Map() },
    node,
    before: { ...before, node },
    intendedName: "input3",
    intendedLinkId: 9,
    replacedLinkId: null,
  });
  assert.equal(res, null);
  assert.equal(node.inputs[0].name, "input2", "positional packs keep the pack's names");
});

test("#2008 INSERT disclosure uses object identity — a helper-only pin", () => {
  const { mm } = minimaxFixture({ mode: "insert" });
  const snap = captureSlotNames([mm]);
  autogrowInsert(mm, mm.graph, { index: 12, connected: true });
  const rewrites = describeSlotRewrites(snap);
  assert.deepEqual(rewrites, [], "surviving objects that kept their names are not rewrites");
});

test("#2008 the throw path still reports a landed dotted-prefix wire", () => {
  const { graph, mm } = minimaxFixture({ mode: "insert", throwAfterWrite: true });
  const videoLink = nameLink(mm, "ref_videos.ref_video_0");
  const graph_connect = buildConnect(graph);

  const res = graph_connect({
    from_node_id: 1,
    from_output: 0,
    to_node_id: 136,
    to_input: "ref_images.ref_image_4",
  });

  assert.equal(res.connected.to.node_id, 136);
  assert.equal(res.connected.to.input, "ref_images.ref_image_4");
  assert.equal(nameLink(mm, "ref_videos.ref_video_0"), videoLink);
  assert.match(res.warning, /Do NOT retry this connect/);
  assert.ok(!("collateral_changes" in res));
});

test("#2008 reconcile never throws — a hostile slot cannot fail a landed wire", () => {
  const node = {
    id: 136,
    inputs: [
      {
        get name() {
          throw new Error("hostile name");
        },
        get link() {
          throw new Error("hostile link");
        },
      },
    ],
  };
  assert.equal(isDynamicPrefixSlotName("ref_images.ref_image_4"), true);
  assert.doesNotThrow(() => captureNamedSlotLinks(node));
  assert.doesNotThrow(() =>
    reconcileDynamicPrefixSlots({
      graph: {
        get links() {
          throw new Error("hostile store");
        },
      },
      node,
      before: { node, pairable: true, slots: [{ name: "ref_images.ref_image_4", index: 0, link: 1 }] },
      intendedName: "ref_images.ref_image_4",
      intendedLinkId: 2,
      replacedLinkId: null,
    }),
  );
});

test("#2008 an ordinary non-dotted connect is unchanged", () => {
  const graph = mkGraph();
  const source = {
    id: 1,
    graph,
    inputs: [],
    outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
  };
  const dst = {
    id: 2,
    graph,
    inputs: [{ name: "images", type: "IMAGE", link: null }],
    outputs: [],
  };
  graph.nodes.push(source, dst);
  attachConnect(source, {});
  const graph_connect = buildConnect(graph);
  const res = graph_connect({ from_node_id: 1, from_output: 0, to_node_id: 2, to_input: "images" });
  assert.equal(res.connected.to.input, "images");
  assert.equal(res.slots_rewritten, undefined);
  assert.equal(res.warning, undefined);
});
