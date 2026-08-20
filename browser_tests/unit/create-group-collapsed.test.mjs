// mcp#1877 — the SHIPPED graph_create_group must not build a box around a node
// and then report that node as missing.
//
// This drives the REAL executor extracted from the panel source, not a
// re-implementation: the geometry fix lives in group-geometry.js, but the
// postcondition that turns it into a correct tool RESULT (which ids are
// reported, and what the warning says) lives entirely at this call site, where a
// helper-level test cannot see it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  boundsAroundNodes,
  groupMemberNodes,
  classifyRequestedMembership,
  describeGroupMembershipGap,
  syncNodeArea,
  syncGraphNodeAreas,
} from "../../web/js/lib/group-geometry.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const grab = (re, what) => {
  const m = panelSrc.match(re);
  assert.ok(m, `could not locate ${what} in panel source`);
  return m[0];
};

const createGroupSrc = grab(
  / {2}graph_create_group\(\{[\s\S]*?\n {2}\},/,
  "graph_create_group",
);
const summarizeGroupSrc = grab(
  /\nfunction summarizeGroup\(graph, g\) \{[\s\S]*?\n\}/,
  "summarizeGroup",
);
const setGroupBoundsSrc = grab(
  /\nfunction setGroupBounds\(group, \[x, y, w, h\]\) \{[\s\S]*?\n\}/,
  "setGroupBounds",
);
const nextGroupIdSrc = grab(
  /\nfunction nextGroupId\(graph\) \{[\s\S]*?\n\}/,
  "nextGroupId",
);

/** A LiteGraph-shaped LGraphGroup double: a real _bounding quad and the
 *  frontend behaviour the panel exists to work around — recomputeInsideNodes
 *  leaves _nodes stale/empty, so the reported membership must come from live
 *  geometry. */
class LGraphGroupDouble {
  constructor(title) {
    this.title = title;
    this._bounding = [0, 0, 140, 80];
    this._nodes = [];
  }
  recomputeInsideNodes() {
    this._nodes.length = 0;
  }
}

function realCreateGroup(graph) {
  const getGraphCtx = () => ({ graph, LG: { LGraphGroup: LGraphGroupDouble } });
  return new Function(
    "getGraphCtx",
    "tr",
    "syncGraphNodeAreas",
    "syncNodeArea",
    "boundsAroundNodes",
    "groupMemberNodes",
    "classifyRequestedMembership",
    "describeGroupMembershipGap",
    "placementFor",
    "clipOutlineTitle",
    "GROUP_NODE_IDS_CAP",
    `"use strict";
     ${setGroupBoundsSrc}
     ${nextGroupIdSrc}
     ${summarizeGroupSrc}
     const executors = { ${createGroupSrc} };
     return executors.graph_create_group;`,
  )(
    getGraphCtx,
    (_key, fallback) => fallback,
    syncGraphNodeAreas,
    syncNodeArea,
    boundsAroundNodes,
    groupMemberNodes,
    classifyRequestedMembership,
    describeGroupMembershipGap,
    () => [0, 0],
    (t) => ({ text: String(t ?? ""), clipped: false }),
    200,
  );
}

function graphOf(...nodes) {
  const graph = {
    _nodes: nodes,
    _groups: [],
    getNodeById: (id) => nodes.find((n) => n.id === Number(id)) ?? null,
    beforeChange() {},
    afterChange() {},
    add(g) {
      graph._groups.push(g);
    },
    setDirtyCanvas() {},
  };
  return graph;
}

/** Node 81 exactly as #1877 reports it: a COLLAPSED VAEDecode whose size the
 *  frontend gives as the collapsed pill width and a ZERO body height, with a
 *  stale cached rect from the graph load. */
function collapsedNode81() {
  return {
    id: 81,
    type: "VAEDecode",
    title: "VAE Decode",
    flags: { collapsed: true },
    pos: [9750, 5410],
    size: [225, 0],
    boundingRect: [0, 0, 0, 0],
  };
}

test("mcp#1877 create_group(node_ids) INCLUDES the requested collapsed node", () => {
  const n = collapsedNode81();
  const create = realCreateGroup(graphOf(n));

  const { group } = create({ title: "Decode", node_ids: [81] });

  // The whole report in one place: before the fix this was node_count 0,
  // node_ids [], missing_node_ids [81] — with bounds that visibly covered
  // [9750, 5410].
  assert.equal(group.node_count, 1, "the requested node must be a member");
  assert.deepEqual(group.node_ids, [81]);
  assert.equal(group.missing_node_ids, undefined, "nothing is missing");
  assert.equal(group.warning, undefined, "an exact result carries no warning");

  // And the box really does cover the node it claims as a member.
  const [gx, gy, gw, gh] = group.bounding;
  assert.ok(
    n.pos[0] >= gx && n.pos[0] < gx + gw && n.pos[1] >= gy && n.pos[1] < gy + gh,
    `bounds ${group.bounding} must cover the node at ${n.pos}`,
  );
});

test("mcp#1877 a group of collapsed AND expanded nodes keeps every requested id", () => {
  const collapsed = collapsedNode81();
  const expanded = {
    id: 82,
    type: "SaveImage",
    flags: {},
    pos: [10120, 5410],
    size: [300, 270],
    boundingRect: [0, 0, 0, 0],
  };
  const create = realCreateGroup(graphOf(collapsed, expanded));

  const { group } = create({ node_ids: [81, 82] });

  assert.deepEqual(group.node_ids.slice().sort((a, b) => a - b), [81, 82]);
  assert.equal(group.node_count, 2);
  assert.equal(group.warning, undefined);
});

test("mcp#1877 an unresolvable id is still reported, and named as unknown", () => {
  // The honesty contract from #297 must survive the fix: a requested id that is
  // not in the graph is still listed as missing — and now says WHY, instead of
  // being folded into a dense-layout complaint.
  const create = realCreateGroup(graphOf(collapsedNode81()));

  const { group } = create({ node_ids: [81, 999] });

  assert.deepEqual(group.node_ids, [81]);
  assert.deepEqual(group.missing_node_ids, [999]);
  assert.match(group.warning, /do not exist in this graph/);
  assert.ok(
    !/captures 0 unrelated/.test(group.warning),
    `must not report a zero-node capture: ${group.warning}`,
  );
});

test("mcp#1877 a rect that REFUSES the resync is named, not blamed on the layout", () => {
  // The call site must keep syncNodeArea's verdict. A frozen cached rect leaves
  // the node judged on geometry the panel could not refresh; dropping that
  // boolean is what made the tool blame a dense layout for a node it had itself
  // failed to reconcile.
  const n = collapsedNode81();
  n.boundingRect = Object.freeze([0, 0, 10, 10]); // silently rejects element writes
  const create = realCreateGroup(graphOf(n));

  const { group } = create({ node_ids: [81] });

  assert.deepEqual(group.missing_node_ids, [81], "the node is honestly reported as missing");
  assert.match(group.warning, /could not be reconciled/, group.warning);
  assert.ok(
    !/contiguous region/.test(group.warning),
    `a stuck rect is not a layout problem: ${group.warning}`,
  );
});
