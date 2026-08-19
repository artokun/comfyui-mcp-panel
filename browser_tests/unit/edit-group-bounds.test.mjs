// #1306: `panel_edit_group({bounds})` writes the group BOX only. Contained
// nodes, nested group boxes and reroutes stay at their canvas coordinates.
// Some frontends couple a pos / _bounding write to LGraphGroup.move(), which
// translates the cached `_children` set — the handler must pin those items
// and put them back after the box write.
//
// These tests extract the SHIPPED graph_edit_group (plus resolveGroup /
// setGroupBounds / summarizeGroup) out of the panel source and run it against
// LiteGraph-shaped doubles, so they verify the real implementation rather than
// a copy of it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  groupMemberNodes,
  syncGraphNodeAreas,
  holdGraphItemPositions,
} from "../../web/js/lib/group-geometry.js";
import { clipOutlineTitle } from "../../web/js/lib/graph-read.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const grab = (re, what) => {
  const m = panelSrc.match(re);
  assert.ok(m, `could not locate ${what} in panel source`);
  return m[0];
};

const resolveGroupSrc = grab(/\nfunction resolveGroup\(graph, groupId\) \{[\s\S]*?\n\}/, "resolveGroup");
const setGroupBoundsSrc = grab(/\nfunction setGroupBounds\(group, \[x, y, w, h\]\) \{[\s\S]*?\n\}/, "setGroupBounds");
const summarizeGroupSrc = grab(/\nfunction summarizeGroup\(graph, g\) \{[\s\S]*?\n\}/, "summarizeGroup");
const editGroupSrc = grab(/ {2}graph_edit_group\(\{ group_id, title, color, font_size, bounds \}\) \{[\s\S]*?\n {2}\},/, "graph_edit_group");
const GROUP_NODE_IDS_CAP = Number(
  grab(/\nconst GROUP_NODE_IDS_CAP = (\d+);/, "GROUP_NODE_IDS_CAP").match(/(\d+)/)[1],
);

/** The real shipped handler, wired to the real shipped geometry lib.
 *
 *  `"use strict"` is required: the panel is an ES module, so a write to a frozen
 *  array or a setter-less accessor THROWS. A sloppy `new Function` body would
 *  silently drop those writes and let every "frontend couples pos to move"
 *  test pass against the wrong language. */
function realEditGroup(graph) {
  const getGraphCtx = () => ({ graph });
  return new Function(
    "getGraphCtx",
    "syncGraphNodeAreas",
    "groupMemberNodes",
    "holdGraphItemPositions",
    "clipOutlineTitle",
    "GROUP_NODE_IDS_CAP",
    `"use strict";
     ${resolveGroupSrc}
     ${setGroupBoundsSrc}
     ${summarizeGroupSrc}
     const executors = { ${editGroupSrc} };
     return executors.graph_edit_group;`,
  )(
    getGraphCtx,
    syncGraphNodeAreas,
    groupMemberNodes,
    holdGraphItemPositions,
    clipOutlineTitle,
    GROUP_NODE_IDS_CAP,
  );
}

function node(id, pos, size = [100, 100], rect = null) {
  return {
    id,
    pos: [...pos],
    size: [...size],
    boundingRect: rect ? [...rect] : [pos[0], pos[1] - 30, size[0], size[1] + 30],
  };
}

function group(id, bounding, title = `G${id}`) {
  return { id, title, _bounding: [...bounding], recomputeInsideNodes() {} };
}

function makeGraph({ nodes = [], groups = [], reroutes = null } = {}) {
  return {
    _nodes: nodes,
    _groups: groups,
    ...(reroutes ? { reroutes } : {}),
    beforeChange() { this.beforeCount = (this.beforeCount ?? 0) + 1; },
    afterChange() { this.afterCount = (this.afterCount ?? 0) + 1; },
    setDirtyCanvas() { this.dirty = true; },
  };
}

/** A group whose `pos` setter is LGraphGroup.move() — the #1306 frontend.
 *  No `_bounding`, so setGroupBounds falls through to pos/size. The setter
 *  translates every cached child by the origin delta. */
function groupThatMovesChildrenOnPos(id, bounding, children) {
  const box = [...bounding];
  return {
    id,
    title: `G${id}`,
    _children: new Set(children),
    _nodes: children,
    get pos() { return [box[0], box[1]]; },
    set pos(v) {
      const dx = Number(v[0]) - box[0];
      const dy = Number(v[1]) - box[1];
      box[0] = Number(v[0]);
      box[1] = Number(v[1]);
      for (const n of this._children) {
        n.pos[0] += dx;
        n.pos[1] += dy;
        if (n.boundingRect) {
          n.boundingRect[0] += dx;
          n.boundingRect[1] += dy;
        }
      }
    },
    get size() { return [box[2], box[3]]; },
    set size(v) {
      box[2] = Number(v[0]);
      box[3] = Number(v[1]);
    },
    recomputeInsideNodes() {},
  };
}

/** A group whose `_bounding` write (setGroupBounds' preferred path) translates
 *  cached children — a Proxy over the live quad, the other #1306 frontend. */
function groupThatMovesChildrenOnBounding(id, bounding, children) {
  const raw = [...bounding];
  const g = {
    id,
    title: `G${id}`,
    _children: new Set(children),
    _nodes: children,
    recomputeInsideNodes() {},
  };
  g._bounding = new Proxy(raw, {
    get: (target, prop) => Reflect.get(target, prop, target),
    set(target, prop, value) {
      if (prop === "0" || prop === "1") {
        const idx = Number(prop);
        const delta = Number(value) - target[idx];
        target[idx] = Number(value);
        if (delta) {
          for (const n of g._children) {
            n.pos[idx] += delta;
            if (n.boundingRect) n.boundingRect[idx] += delta;
          }
        }
        return true;
      }
      target[prop] = value;
      return true;
    },
  });
  return g;
}

// ---------------------------------------------------------------------------

test("#1306: editing bounds does not translate contained nodes (plain _bounding)", () => {
  const a = node(7, [1360, 0]);
  const b = node(8, [1360, 200]);
  const away = node(9, [9000, 9000]);
  const g = group(1, [1300, -40, 400, 400]);
  const graph = makeGraph({ nodes: [a, b, away], groups: [g] });

  const out = realEditGroup(graph)({ group_id: 1, bounds: [1400, 50, 800, 600] });

  assert.deepEqual(a.pos, [1360, 0], "member node must stay at its canvas coordinate");
  assert.deepEqual(b.pos, [1360, 200], "the other member must stay put too");
  assert.deepEqual(away.pos, [9000, 9000], "a node outside the box is not a member and must not move");
  assert.deepEqual(out.group.bounding, [1400, 50, 800, 600], "the box itself moved");
  assert.equal(graph.beforeCount, 1);
  assert.equal(graph.afterCount, 1);
});

test("#1306: a pos-setter that is LGraphGroup.move() still leaves nodes put", () => {
  const a = node(7, [1360, 0]);
  const b = node(8, [5800, 0]);
  const g = groupThatMovesChildrenOnPos(1, [1300, -40, 500, 200], [a, b]);
  const graph = makeGraph({ nodes: [a, b], groups: [g] });

  const out = realEditGroup(graph)({ group_id: 1, bounds: [1490, 3, 800, 400] });

  assert.deepEqual(a.pos, [1360, 0], "the move-on-pos frontend must not drag node 7");
  assert.deepEqual(b.pos, [5800, 0], "the move-on-pos frontend must not drag node 8");
  assert.deepEqual(out.group.bounding, [1490, 3, 800, 400]);
});

test("#1306: a _bounding write that translates children still leaves nodes put", () => {
  const a = node(33, [3050, 450]);
  const g = groupThatMovesChildrenOnBounding(1, [3000, 400, 400, 300], [a]);
  const graph = makeGraph({ nodes: [a], groups: [g] });

  const out = realEditGroup(graph)({ group_id: 1, bounds: [3941, 12, 500, 300] });

  assert.deepEqual(a.pos, [3050, 450], "the _bounding-proxy frontend must not drag the decode node");
  assert.deepEqual(out.group.bounding, [3941, 12, 500, 300]);
});

test("#1306: shrinking the box leaves nodes put and drops them from membership", () => {
  const a = node(7, [50, 50]);
  const b = node(8, [250, 50]);
  const g = group(1, [0, 0, 400, 200]);
  const graph = makeGraph({ nodes: [a, b], groups: [g] });

  const out = realEditGroup(graph)({ group_id: 1, bounds: [0, 0, 120, 200] });

  assert.deepEqual(a.pos, [50, 50]);
  assert.deepEqual(b.pos, [250, 50], "the node that fell outside must not have been translated");
  assert.deepEqual(out.group.node_ids, [7], "membership follows the NEW box from live geometry");
  assert.equal(out.group.node_count, 1);
});

test("#1306: nested group boxes and reroutes stay put when the outer box is resized", () => {
  const inner = group(2, [50, 50, 100, 100], "Inner");
  const outer = group(1, [0, 0, 400, 400], "Outer");
  const a = node(7, [70, 90], [60, 40]);
  const elbow = { id: 11, pos: [100, 100] };
  const graph = makeGraph({
    nodes: [a],
    groups: [outer, inner],
    reroutes: new Map([[11, elbow]]),
  });

  realEditGroup(graph)({ group_id: 1, bounds: [200, 200, 500, 500] });

  assert.deepEqual(a.pos, [70, 90], "the inner node stayed");
  assert.deepEqual(inner._bounding, [50, 50, 100, 100], "the nested group box stayed");
  assert.deepEqual([elbow.pos[0], elbow.pos[1]], [100, 100], "the enclosed reroute stayed");
});

test("#1306: a stale _children cache that still lists a departed node does not drag it", () => {
  const inside = node(7, [50, 50]);
  const departed = node(8, [5000, 5000]);
  const g = groupThatMovesChildrenOnBounding(1, [0, 0, 200, 200], [inside, departed]);
  const graph = makeGraph({ nodes: [inside, departed], groups: [g] });

  realEditGroup(graph)({ group_id: 1, bounds: [100, 100, 200, 200] });

  assert.deepEqual(inside.pos, [50, 50]);
  assert.deepEqual(departed.pos, [5000, 5000], "a stale cached child that left the box must not ride along");
});

test("#1306: title-only edits do not touch node positions or the box", () => {
  const a = node(7, [50, 50]);
  const g = group(1, [0, 0, 200, 200], "Old");
  const graph = makeGraph({ nodes: [a], groups: [g] });

  const out = realEditGroup(graph)({ group_id: 1, title: "New" });

  assert.equal(out.group.title, "New");
  assert.deepEqual(out.group.bounding, [0, 0, 200, 200]);
  assert.deepEqual(a.pos, [50, 50]);
});

test("#1306: non-finite bounds are refused and nothing is written", () => {
  const a = node(7, [50, 50]);
  const g = group(1, [0, 0, 200, 200]);
  const graph = makeGraph({ nodes: [a], groups: [g] });
  const edit = realEditGroup(graph);

  for (const bad of [[Number.NaN, 0, 10, 10], [0, undefined, 10, 10], [10, 10], "0,0,10,10", [0, 0, 10]]) {
    assert.throws(() => edit({ group_id: 1, bounds: bad }), /bounds must be \[x, y, w, h\] finite numbers/);
  }
  assert.deepEqual(a.pos, [50, 50]);
  assert.deepEqual(g._bounding, [0, 0, 200, 200]);
  assert.equal(graph.beforeCount, undefined, "a refused bounds write must not open an undo transaction");
});
