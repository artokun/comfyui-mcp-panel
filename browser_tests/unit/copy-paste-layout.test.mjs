/**
 * #1294: panel_copy_nodes + panel_paste_nodes lost every group and collapsed
 * same-type branch rows onto one coordinate.
 *
 * Repro shape: five "Power Lora Loader (rgthree)" nodes at y=-20/640/1300/1960/2620
 * plus a group around each row. LiteGraph only serializes groups that are IN the
 * selection (a node_ids copy selects nodes only), and clone/configure drops unique
 * pos on those loaders — paste reported copied:121 / pasted_count:121 / group_count:0
 * with all five loaders at [2288, 1320].
 *
 * Pure helpers are tested directly. The shipped graph_copy_nodes / graph_paste_nodes
 * bodies are extracted and run against a LiteGraph double that reproduces BOTH
 * bugs, so deleting the group collect, the clipboard patch, or the post-paste
 * restore turns these red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CLIPBOARD_KEY,
  withInMemoryClipboard,
  getInMemoryClipboard,
  getEffectiveClipboard,
  clearInMemoryClipboard,
} from "../../web/js/lib/clipboard-store.js";
import {
  recordCopiedNodes,
  getVerifiedSnapshot,
  parseClipboardNodes,
  diffCopiedVsPasted,
  formatDroppedWarning,
  unregisteredCopiedTypes,
  registryTypePredicate,
  formatUnpasteableCopyWarning,
} from "../../web/js/lib/paste-report.js";
import { sanitizeNodesAuxId } from "../../web/js/lib/aux-id-sanitize.js";
import {
  finitePoint,
  isGraphNode,
  isGraphGroup,
  partitionSelection,
  groupsFullyCoveredBy,
  snapshotNodeLayout,
  snapshotGroupLayout,
  collectCopySelection,
  snapshotCopyLayout,
  patchClipboardLayout,
  parseClipboardLayout,
  recordCopiedLayout,
  getVerifiedLayout,
  clearCopiedLayout,
  pairCopiedToPasted,
  layoutOrigin,
  resolvePasteDest,
  translateBounding,
  applyPastedLayout,
} from "../../web/js/lib/copy-paste-layout.js";
import { groupMemberNodes, groupBoundsOf } from "../../web/js/lib/group-geometry.js";

const LORA = "Power Lora Loader (rgthree)";
const BRANCH_YS = [-20, 640, 1300, 1960, 2620];

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const grab = (re, what) => {
  const m = panelSrc.match(re);
  assert.ok(m, `could not locate ${what} in panel source`);
  return m[0];
};

const copySrc = grab(/ {2}graph_copy_nodes\(\{ node_ids \} = \{\}\) \{[\s\S]*?\n {2}\},/, "graph_copy_nodes");
const pasteSrc = grab(/ {2}graph_paste_nodes\(\{ pos, connect_inputs \} = \{\}\) \{[\s\S]*?\n {2}\},/, "graph_paste_nodes");
const setGroupBoundsSrc = grab(/\nfunction setGroupBounds\(group, \[x, y, w, h\]\) \{[\s\S]*?\n\}/, "setGroupBounds");
const nextGroupIdSrc = grab(/\nfunction nextGroupId\(graph\) \{[\s\S]*?\n\}/, "nextGroupId");

function summarizeNode(n) {
  return {
    id: n.id,
    type: n.type,
    pos: n.pos ? [Math.round(n.pos[0]), Math.round(n.pos[1])] : null,
    ...(n.flags?.collapsed ? { collapsed: true } : {}),
  };
}

function summarizeGroup(graph, g) {
  const b = g._bounding ?? [g.pos?.[0] ?? 0, g.pos?.[1] ?? 0, g.size?.[0] ?? 0, g.size?.[1] ?? 0];
  return {
    id: g.id,
    title: g.title,
    bounding: b.map((n) => Math.round(n)),
    node_ids: groupMemberNodes(graph, g).map((n) => n.id),
  };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
  };
}

function LGraphGroup(title) {
  this.title = title;
  this._bounding = [0, 0, 0, 0];
  this.flags = {};
}

/** Frontend double that reproduces both #1294 bugs. */
function makeFrontend({ loseLoraPos = true, pasteGroups = true } = {}) {
  let nextNodeId = 1;
  let nextGroupId = 1;
  const graph = {
    _nodes: [],
    _groups: [],
    beforeChange() {},
    afterChange() {},
    setDirtyCanvas() {},
    getNodeById(id) {
      return this._nodes.find((n) => n.id === Number(id)) ?? null;
    },
    add(item) {
      if (item && typeof item.type === "string") {
        if (item.id == null) item.id = nextNodeId++;
        this._nodes.push(item);
      } else if (item) {
        if (item.id == null) item.id = nextGroupId++;
        this._groups.push(item);
      }
    },
  };
  const canvas = {
    graph,
    selectedItems: new Set(),
    selectItems(items) {
      this.selectedItems = new Set(items);
    },
    selectNodes(items) {
      this.selectedItems = new Set(items);
    },
    storage: null,
    copyToClipboard(items) {
      const nodes = [];
      const groups = [];
      for (const it of items ?? this.selectedItems) {
        if (it && typeof it.type === "string") {
          // BUG: clone/serialize loses unique pos on Power Lora Loader.
          const pos = loseLoraPos && it.type === LORA ? [0, 0] : [...it.pos];
          nodes.push({ id: it.id, type: it.type, pos, flags: { ...(it.flags || {}) } });
        } else if (it && (it._bounding || it.bounding)) {
          const b = it._bounding || it.bounding;
          groups.push({
            title: it.title,
            bounding: [...b],
            color: it.color,
            flags: { ...(it.flags || {}) },
          });
        }
      }
      this.storage.setItem(CLIPBOARD_KEY, JSON.stringify({ nodes, groups, links: [] }));
    },
    pasteFromClipboard(options = {}) {
      const raw = this.storage.getItem(CLIPBOARD_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      const position = options.position ?? [2288, 1320];
      let offsetX = Infinity;
      let offsetY = Infinity;
      for (const n of data.nodes ?? []) {
        if (!n.pos) continue;
        if (n.pos[0] < offsetX) offsetX = n.pos[0];
        if (n.pos[1] < offsetY) offsetY = n.pos[1];
      }
      for (const g of data.groups ?? []) {
        if (!g.bounding) continue;
        if (g.bounding[0] < offsetX) offsetX = g.bounding[0];
        if (g.bounding[1] < offsetY) offsetY = g.bounding[1];
      }
      if (!Number.isFinite(offsetX)) {
        offsetX = 0;
        offsetY = 0;
      }
      const dx = position[0] - offsetX;
      const dy = position[1] - offsetY;
      for (const info of data.nodes ?? []) {
        const node = {
          id: nextNodeId++,
          type: info.type,
          pos: [...(info.pos ?? [0, 0])],
          size: [200, 80],
          flags: { ...(info.flags || {}) },
        };
        // BUG: configure ignores pos on Power Lora Loader — they keep the
        // createNode default, then the same translation stacks them.
        if (loseLoraPos && info.type === LORA) node.pos = [0, 0];
        node.pos = [node.pos[0] + dx, node.pos[1] + dy];
        graph._nodes.push(node);
      }
      if (pasteGroups) {
        for (const info of data.groups ?? []) {
          const g = new LGraphGroup(info.title);
          g._bounding = [
            info.bounding[0] + dx,
            info.bounding[1] + dy,
            info.bounding[2],
            info.bounding[3],
          ];
          g.color = info.color;
          g.flags = { ...(info.flags || {}) };
          g.id = nextGroupId++;
          graph._groups.push(g);
        }
      }
    },
  };
  return { graph, canvas, LG: { LGraphGroup, registered_node_types: { [LORA]: {}, KSampler: {} } } };
}

function addBranch(graph, index, y) {
  const lora = {
    id: index * 2 + 1,
    type: LORA,
    pos: [100, y],
    size: [225, 80],
    flags: {},
  };
  const sampler = {
    id: index * 2 + 2,
    type: "KSampler",
    pos: [400, y],
    size: [200, 80],
    flags: {},
  };
  const group = new LGraphGroup(`Branch ${index + 1}`);
  group.id = index + 1;
  group._bounding = [50, y - 70, 600, 180];
  graph._nodes.push(lora, sampler);
  graph._groups.push(group);
  return { lora, sampler, group };
}

function makeBranchedGraph() {
  const { graph, canvas, LG } = makeFrontend();
  const branches = BRANCH_YS.map((y, i) => addBranch(graph, i, y));
  return { graph, canvas, LG, branches };
}

function shippedCopyPaste(srcGraph, srcCanvas, srcLG) {
  const storage = makeStorage();
  srcCanvas.storage = storage;
  const window = { localStorage: storage };
  const setGroupBounds = new Function(`${setGroupBoundsSrc}; return setGroupBounds;`)();
  const nextGroupId = new Function(`${nextGroupIdSrc}; return nextGroupId;`)();

  const copy = new Function(
    "getGraphCtx",
    "collectCopySelection",
    "snapshotCopyLayout",
    "withInMemoryClipboard",
    "getInMemoryClipboard",
    "patchClipboardLayout",
    "CLIPBOARD_KEY",
    "recordCopiedNodes",
    "recordCopiedLayout",
    "registryTypePredicate",
    "unregisteredCopiedTypes",
    "formatUnpasteableCopyWarning",
    "window",
    `"use strict"; const e = { ${copySrc} }; return e.graph_copy_nodes;`,
  )(
    () => ({ graph: srcGraph, canvas: srcCanvas, LG: srcLG }),
    collectCopySelection,
    snapshotCopyLayout,
    withInMemoryClipboard,
    getInMemoryClipboard,
    patchClipboardLayout,
    CLIPBOARD_KEY,
    recordCopiedNodes,
    recordCopiedLayout,
    registryTypePredicate,
    unregisteredCopiedTypes,
    formatUnpasteableCopyWarning,
    window,
  );

  function makePaster(dstGraph, dstCanvas, dstLG) {
    dstCanvas.storage = storage;
    return new Function(
      "getGraphCtx",
      "getEffectiveClipboard",
      "getVerifiedLayout",
      "parseClipboardLayout",
      "withInMemoryClipboard",
      "resolvePasteDest",
      "applyPastedLayout",
      "setGroupBounds",
      "nextGroupId",
      "summarizeNode",
      "summarizeGroup",
      "parseClipboardNodes",
      "getVerifiedSnapshot",
      "diffCopiedVsPasted",
      "formatDroppedWarning",
      "sanitizeNodesAuxId",
      "window",
      `"use strict"; const e = { ${pasteSrc} }; return e.graph_paste_nodes;`,
    )(
      () => ({ graph: dstGraph, canvas: dstCanvas, LG: dstLG }),
      getEffectiveClipboard,
      getVerifiedLayout,
      parseClipboardLayout,
      withInMemoryClipboard,
      resolvePasteDest,
      applyPastedLayout,
      setGroupBounds,
      nextGroupId,
      summarizeNode,
      summarizeGroup,
      parseClipboardNodes,
      getVerifiedSnapshot,
      diffCopiedVsPasted,
      formatDroppedWarning,
      sanitizeNodesAuxId,
      window,
    );
  }

  return { copy, makePaster, storage, window };
}

// ---- pure helpers ----------------------------------------------------------

test("partitionSelection keeps nodes and groups apart", () => {
  const node = { id: 1, type: LORA, pos: [0, 0] };
  const group = { title: "G", _bounding: [0, 0, 10, 10] };
  const { nodes, groups } = partitionSelection([node, group, { id: 2 }]);
  assert.deepEqual(nodes, [node]);
  assert.deepEqual(groups, [group]);
  assert.equal(isGraphNode(node), true);
  assert.equal(isGraphGroup(group), true);
  assert.equal(isGraphGroup(node), false);
});

test("groupsFullyCoveredBy requires every member to be selected", () => {
  const { graph, branches } = makeBranchedGraph();
  const allIds = graph._nodes.map((n) => n.id);
  assert.equal(groupsFullyCoveredBy(graph, allIds).length, 5);
  const firstBranchOnly = [branches[0].lora.id, branches[0].sampler.id];
  const covered = groupsFullyCoveredBy(graph, firstBranchOnly);
  assert.equal(covered.length, 1);
  assert.equal(covered[0].title, "Branch 1");
  assert.equal(groupsFullyCoveredBy(graph, [branches[0].lora.id]).length, 0);
});

test("patchClipboardLayout restores live pos and injects missing groups", () => {
  const raw = JSON.stringify({
    nodes: [
      { id: 1, type: LORA, pos: [0, 0] },
      { id: 2, type: "KSampler", pos: [400, -20] },
    ],
    groups: [],
    links: [],
  });
  const patched = patchClipboardLayout(raw, {
    nodes: [{ id: 1, type: LORA, pos: [100, -20] }, { id: 2, type: "KSampler", pos: [400, -20] }],
    groups: [{ title: "Branch 1", bounding: [50, -90, 600, 180] }],
  });
  const layout = parseClipboardLayout(patched);
  assert.deepEqual(layout.nodes[0].pos, [100, -20]);
  assert.equal(layout.groups.length, 1);
  assert.equal(layout.groups[0].title, "Branch 1");
});

test("pairCopiedToPasted matches same-type rows in order and skips drops", () => {
  const copied = BRANCH_YS.map((y, i) => ({ id: i + 1, type: LORA, pos: [100, y] }));
  copied.push({ id: 99, type: "AudioCrop", pos: [0, 0] });
  const pasted = BRANCH_YS.map((y, i) => ({ id: 100 + i, type: LORA, pos: [2288, 1320] }));
  const pairs = pairCopiedToPasted(copied, pasted);
  assert.equal(pairs.length, 5);
  assert.deepEqual(pairs.map((p) => p.copied.pos[1]), BRANCH_YS);
  assert.deepEqual(pairs.map((p) => p.pasted.id), [100, 101, 102, 103, 104]);
});

test("applyPastedLayout uncollapses same-type rows with one translation", () => {
  const copied = BRANCH_YS.map((y, i) => ({ id: i + 1, type: LORA, pos: [100, y] }));
  const pasted = BRANCH_YS.map((_, i) => ({ id: 100 + i, type: LORA, pos: [2288, 1320] }));
  const dest = [2288, 1320];
  const { translation, restored_positions } = applyPastedLayout({
    pastedNodes: pasted,
    pastedGroups: [],
    layout: { nodes: copied, groups: [] },
    dest,
  });
  assert.equal(restored_positions, 5);
  assert.deepEqual(translation, [2288 - 100, 1320 - BRANCH_YS[0]]);
  const ys = pasted.map((n) => n.pos[1]);
  assert.deepEqual(ys, BRANCH_YS.map((y) => y + translation[1]));
  assert.equal(new Set(ys).size, 5, "every branch row kept a distinct y");
});

test("applyPastedLayout recreates a group the frontend dropped", () => {
  const node = { id: 10, type: "KSampler", pos: [400, 100], size: [200, 80] };
  const created = [];
  const layout = {
    nodes: [{ id: 2, type: "KSampler", pos: [400, 0] }],
    groups: [{ title: "Sampler", bounding: [350, -70, 300, 180] }],
  };
  const dest = [400, 100];
  applyPastedLayout({
    pastedNodes: [node],
    pastedGroups: [],
    layout,
    dest,
    hooks: {
      createGroup(spec) {
        const g = { title: spec.title, _bounding: [...spec.bounding] };
        created.push(g);
        return g;
      },
    },
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].title, "Sampler");
  const origin = layoutOrigin(layout.nodes, layout.groups);
  assert.deepEqual(created[0]._bounding, translateBounding(layout.groups[0].bounding, [dest[0] - origin[0], dest[1] - origin[1]]));
});

test("getVerifiedLayout is fingerprint-guarded like the node snapshot", () => {
  clearCopiedLayout();
  recordCopiedLayout({ nodes: [{ id: 1, type: LORA, pos: [1, 2] }], groups: [] }, "fp-a");
  assert.deepEqual(getVerifiedLayout("fp-a").nodes[0].pos, [1, 2]);
  assert.equal(getVerifiedLayout("fp-b"), null);
  assert.equal(getVerifiedLayout(null), null);
  clearCopiedLayout();
});

test("layoutOrigin is the top-left of nodes and groups", () => {
  assert.deepEqual(
    layoutOrigin(
      [{ pos: [100, 50] }, { pos: [400, -20] }],
      [{ bounding: [10, 80, 20, 20] }],
    ),
    [10, -20],
  );
  assert.deepEqual(resolvePasteDest([5, 6], []), [5, 6]);
  assert.deepEqual(finitePoint(["nope", 1]), null);
});

test("snapshotNodeLayout records collapsed flags", () => {
  const snap = snapshotNodeLayout({ id: 1, type: LORA, pos: [8, 9], flags: { collapsed: true } });
  assert.deepEqual(snap.flags, { collapsed: true });
  assert.deepEqual(snapshotGroupLayout(null, { title: "G", _bounding: [1, 2, 3, 4], flags: { collapsed: true } }).flags, {
    collapsed: true,
  });
});

// ---- shipped handlers ------------------------------------------------------

test("#1294 shipped copy+paste keeps groups and distinct branch y-positions", () => {
  clearInMemoryClipboard();
  clearCopiedLayout();
  const src = makeBranchedGraph();
  const { copy, makePaster } = shippedCopyPaste(src.graph, src.canvas, src.LG);

  const nodeIds = src.graph._nodes.map((n) => n.id);
  const copied = copy({ node_ids: nodeIds });
  assert.equal(copied.copied, 10, "copied reports NODE count, not nodes+groups");
  assert.equal(copied.copied_groups, 5, "fully-selected groups are counted");

  const payload = JSON.parse(getInMemoryClipboard());
  assert.equal(payload.groups.length, 5, "clipboard itself carries the groups");
  const loraInClip = payload.nodes.filter((n) => n.type === LORA);
  assert.deepEqual(
    loraInClip.map((n) => n.pos[1]).sort((a, b) => a - b),
    [...BRANCH_YS],
    "clipboard pos is the LIVE y, not the collapsed clone pos",
  );

  const dst = makeFrontend();
  const paste = makePaster(dst.graph, dst.canvas, dst.LG);
  const result = paste({ pos: [2288, 1320], connect_inputs: false });

  assert.equal(result.pasted_count, 10);
  assert.equal(result.copied_groups, 5);
  assert.equal(result.pasted_groups, 5, "groups survived paste");
  assert.equal(dst.graph._groups.length, 5);

  const loraYs = result.pasted.filter((n) => n.type === LORA).map((n) => n.pos[1]);
  assert.equal(new Set(loraYs).size, 5, "Power Lora rows did not collapse onto one y");
  const deltas = loraYs.slice(1).map((y, i) => y - loraYs[i]);
  const expected = BRANCH_YS.slice(1).map((y, i) => y - BRANCH_YS[i]);
  assert.deepEqual(deltas, expected, "one consistent translation — relative branch spacing held");
});

test("#1294 still recreates groups when LiteGraph paste drops them", () => {
  clearInMemoryClipboard();
  clearCopiedLayout();
  const src = makeBranchedGraph();
  const { copy, makePaster } = shippedCopyPaste(src.graph, src.canvas, src.LG);
  copy({ node_ids: src.graph._nodes.map((n) => n.id) });

  const dst = makeFrontend({ pasteGroups: false });
  const paste = makePaster(dst.graph, dst.canvas, dst.LG);
  const result = paste({ pos: [1000, 500], connect_inputs: false });
  assert.equal(result.pasted_groups, 5);
  assert.equal(dst.graph._groups.length, 5);
  assert.ok(dst.graph._groups.every((g) => String(g.title).startsWith("Branch")));
});

test("#1294 a partial node_ids copy does not invent a half-selected group", () => {
  clearInMemoryClipboard();
  clearCopiedLayout();
  const src = makeBranchedGraph();
  const { copy } = shippedCopyPaste(src.graph, src.canvas, src.LG);
  const onlyLoras = src.branches.map((b) => b.lora.id);
  const copied = copy({ node_ids: onlyLoras });
  assert.equal(copied.copied, 5);
  assert.equal(copied.copied_groups, 0, "group whose sampler was not selected is not copied");
});

test("#1294 native clipboard replacement is not overwritten by the layout snapshot", () => {
  clearInMemoryClipboard();
  clearCopiedLayout();
  const src = makeBranchedGraph();
  const { copy, storage } = shippedCopyPaste(src.graph, src.canvas, src.LG);
  copy({ node_ids: src.graph._nodes.map((n) => n.id) });
  const native = JSON.stringify({ nodes: [{ id: 9, type: "KSampler", pos: [1, 2] }], groups: [], links: [] });
  storage.setItem(CLIPBOARD_KEY, native);
  assert.equal(getVerifiedLayout(native), null, "changed clipboard invalidates the layout snapshot");
  assert.deepEqual(parseClipboardLayout(getEffectiveClipboard(storage)).nodes[0].type, "KSampler");
});

test("#1294 collapsed flags ride along with the restored positions", () => {
  clearInMemoryClipboard();
  clearCopiedLayout();
  const src = makeBranchedGraph();
  src.branches[0].lora.flags.collapsed = true;
  src.branches[2].lora.flags.collapsed = true;
  const { copy, makePaster } = shippedCopyPaste(src.graph, src.canvas, src.LG);
  copy({ node_ids: src.graph._nodes.map((n) => n.id) });
  const dst = makeFrontend();
  const paste = makePaster(dst.graph, dst.canvas, dst.LG);
  const result = paste({ pos: [0, 0], connect_inputs: false });
  const collapsed = result.pasted.filter((n) => n.type === LORA && n.collapsed);
  assert.equal(collapsed.length, 2);
  const ys = result.pasted.filter((n) => n.type === LORA).map((n) => n.pos[1]);
  assert.equal(new Set(ys).size, 5, "collapsed loaders still keep their branch y");
});

test("shipped copy still fails loud on a missing node_id", () => {
  clearInMemoryClipboard();
  clearCopiedLayout();
  const src = makeBranchedGraph();
  const { copy } = shippedCopyPaste(src.graph, src.canvas, src.LG);
  assert.throws(() => copy({ node_ids: [src.graph._nodes[0].id, 99999] }), /not found/);
});
