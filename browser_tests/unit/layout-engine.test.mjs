/**
 * Unit tests for web/js/lib/layout-engine.js — run with `node --test`.
 *
 * Pure-module coverage (no browser, no ComfyUI): column assignment, cycle
 * safety, reroute half-columns, barycenter ordering, cluster rigidity, the
 * no-edge fallback, the spacing multiplier, and a no-two-rects-overlap property
 * check over random DAGs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeLayout, BASE_GAP } from "../../web/js/lib/layout-engine.js";

const N = (id, over = {}) => ({
  id,
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ...over,
});

/** Rectangle for a node id from a positions Map (uses the node's own size). */
function rectFor(positions, node) {
  const [x, y] = positions.get(node.id);
  return { x, y, w: node.width, h: node.height };
}

function overlaps(a, b) {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

test("diamond graph: column (depth) assignment A→{B,C}→D", () => {
  const nodes = [N(1), N(2), N(3), N(4)];
  const edges = [
    { from: 1, to: 2 },
    { from: 1, to: 3 },
    { from: 2, to: 4 },
    { from: 3, to: 4 },
  ];
  const { positions, columns, columnOf } = computeLayout(
    { nodes, edges },
    { anchor: "origin" },
  );
  assert.equal(columns, 3, "three depth levels: {1}, {2,3}, {4}");
  assert.equal(columnOf.get(1), 0);
  assert.equal(columnOf.get(2), 1);
  assert.equal(columnOf.get(3), 1);
  assert.equal(columnOf.get(4), 2);
  // Monotone left→right X ordering by column.
  const x = (id) => positions.get(id)[0];
  assert.ok(x(1) < x(2), "source is left of middle");
  assert.ok(x(2) < x(4), "middle is left of sink");
  assert.equal(x(2), x(3), "same-column nodes share an X");
});

test("cycle does not hang and still returns positions for every node", () => {
  const nodes = [N(1), N(2), N(3)];
  const edges = [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 3, to: 1 }, // back edge -> cycle
  ];
  const { positions } = computeLayout({ nodes, edges }, { anchor: "origin" });
  assert.equal(positions.size, 3);
  for (const id of [1, 2, 3]) assert.ok(positions.has(id));
});

test("reroute gets a slim half-column between its endpoints", () => {
  // 1 (200w) -> R (reroute, 40w) -> 2 (200w)
  const nodes = [
    N(1),
    N(2, { id: 2 }),
    N("R", { id: "R", type: "Reroute", width: 40, height: 20 }),
  ];
  const edges = [
    { from: 1, to: "R" },
    { from: "R", to: 2 },
  ];
  const { positions, columnOf } = computeLayout(
    { nodes, edges },
    { anchor: "origin" },
  );
  const xR = positions.get("R")[0];
  const x1 = positions.get(1)[0];
  const x2 = positions.get(2)[0];
  assert.ok(x1 < xR && xR < x2, "reroute sits between endpoints in X");
  // Half-column: the gap the reroute consumes is smaller than a normal column.
  // Distance from source-right-edge to reroute is at most a full gap, and the
  // reroute→sink advance is tighter than a full 200-wide column + full gap.
  const normalAdvance = 200 + BASE_GAP.h; // a non-reroute column step
  assert.ok(
    x2 - xR < normalAdvance,
    "reroute→sink advance is tighter than a full column",
  );
  // Reroute is a distinct fractional-depth level between the integer columns.
  assert.ok(columnOf.get("R") > columnOf.get(1));
  assert.ok(columnOf.get("R") < columnOf.get(2));
  // Vertically centered between its (equal-Y) endpoints.
  const cy = (id, h) => positions.get(id)[1] + h / 2;
  assert.ok(
    Math.abs(cy("R", 20) - cy(1, 100)) < 1,
    "reroute center aligns with its endpoints",
  );
});

test("barycenter ordering untangles a fixed crossing fixture", () => {
  // Sources 1,2 (col 0). Sinks 3,4 (col 1). Wire 1→4 and 2→3 so that keeping
  // the source order (1 above 2) in col 1 would cross the links; barycenter
  // should instead order col 1 as [4, 3] (4 pulled up by 1, 3 pulled down by 2).
  const nodes = [
    N(1, { y: 0 }),
    N(2, { y: 200 }),
    N(3),
    N(4),
  ];
  const edges = [
    { from: 1, to: 4 },
    { from: 2, to: 3 },
  ];
  const { positions } = computeLayout({ nodes, edges }, { anchor: "origin" });
  const y3 = positions.get(3)[1];
  const y4 = positions.get(4)[1];
  assert.ok(
    y4 < y3,
    "node 4 (fed by top source 1) is stacked above node 3 (fed by bottom source 2)",
  );
});

test("cluster translates rigidly — members keep relative offsets", () => {
  const nodes = [
    N("a", { id: "a", x: 1000, y: 1000, width: 100, height: 60 }),
    N("b", { id: "b", x: 1140, y: 1000, width: 100, height: 60 }),
    N(9, { id: 9 }),
  ];
  const edges = [{ from: "a", to: 9 }];
  const before = { ax: 1000, ay: 1000, bx: 1140, by: 1000 };
  const { positions } = computeLayout(
    { nodes, edges },
    { anchor: "origin", clusters: [{ id: "grp", memberIds: ["a", "b"] }] },
  );
  const [ax, ay] = positions.get("a");
  const [bx, by] = positions.get("b");
  // Relative geometry inside the cluster is preserved exactly.
  assert.equal(bx - ax, before.bx - before.ax);
  assert.equal(by - ay, before.by - before.ay);
});

test("no-edge fallback lays nodes out as a spread sequence (no pile-up)", () => {
  const nodes = [N(1), N(2, { id: 2 }), N(3, { id: 3 }), N(4, { id: 4 })];
  const { positions } = computeLayout(
    { nodes, edges: [] },
    { anchor: "origin" },
  );
  const xs = [1, 2, 3, 4].map((id) => positions.get(id)[0]);
  const uniq = new Set(xs);
  assert.equal(uniq.size, 4, "each node gets its own column (no overlap in col 0)");
  // All share the same Y (a single row).
  const ys = new Set([1, 2, 3, 4].map((id) => positions.get(id)[1]));
  assert.equal(ys.size, 1);
});

test("spacing multiplier widens the gaps", () => {
  const nodes = [N(1), N(2, { id: 2 })];
  const edges = [{ from: 1, to: 2 }];
  const tight = computeLayout({ nodes, edges }, { anchor: "origin", spacing: 1 });
  const loose = computeLayout({ nodes, edges }, { anchor: "origin", spacing: 2 });
  const gapTight = tight.positions.get(2)[0] - tight.positions.get(1)[0];
  const gapLoose = loose.positions.get(2)[0] - loose.positions.get(1)[0];
  assert.equal(gapTight, 200 + BASE_GAP.h);
  assert.equal(gapLoose, 200 + BASE_GAP.h * 2);
  assert.ok(gapLoose > gapTight);
});

test("pinned nodes are reported skipped and never positioned", () => {
  const nodes = [N(1), N(2, { id: 2, pinned: true }), N(3, { id: 3 })];
  const edges = [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
  ];
  const { positions, skipped } = computeLayout(
    { nodes, edges },
    { anchor: "origin" },
  );
  assert.ok(!positions.has(2), "pinned node is not moved");
  assert.deepEqual(skipped, [{ node_id: 2, reason: "pinned" }]);
});

test("grid mode uses ceil(sqrt(n)) columns", () => {
  const nodes = [1, 2, 3, 4, 5].map((id) => N(id, { id }));
  const { positions, columns } = computeLayout(
    { nodes, edges: [] },
    { anchor: "origin", mode: "grid" },
  );
  assert.equal(columns, 3, "ceil(sqrt(5)) = 3 columns");
  assert.equal(positions.size, 5);
});

test("obstacle push-apart shifts the whole block below untouched nodes", () => {
  const nodes = [N(1), N(2, { id: 2 })];
  const edges = [{ from: 1, to: 2 }];
  // Untouched obstacle sitting exactly where the block would anchor.
  const { positions } = computeLayout(
    { nodes, edges },
    {
      anchor: [0, 0],
      obstacles: [{ x: 0, y: 0, width: 400, height: 150 }],
    },
  );
  for (const id of [1, 2]) {
    assert.ok(
      positions.get(id)[1] >= 150,
      "block pushed below the obstacle's bottom edge",
    );
  }
});

// ---- Property: no two laid-out rectangles overlap, over random DAGs --------

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const mode of ["flow_horizontal", "flow_vertical"]) {
  test(`property: no two rects overlap over random DAGs (${mode})`, () => {
    for (let trial = 0; trial < 40; trial++) {
      const rng = mulberry32(1000 + trial);
      const n = 3 + Math.floor(rng() * 10);
      const nodes = [];
      for (let i = 0; i < n; i++) {
        nodes.push(
          N(i, {
            id: i,
            width: 120 + Math.floor(rng() * 200),
            height: 60 + Math.floor(rng() * 160),
          }),
        );
      }
      const edges = [];
      // Only i<j edges -> guaranteed acyclic (a DAG).
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (rng() < 0.25) edges.push({ from: i, to: j });
        }
      }
      const { positions } = computeLayout(
        { nodes, edges },
        { anchor: "origin", mode },
      );
      // Exclude reroutes (none here) — every node is a normal box.
      const rects = nodes.map((node) => rectFor(positions, node));
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          assert.ok(
            !overlaps(rects[i], rects[j]),
            `trial ${trial}: rects ${i} and ${j} overlap in ${mode}`,
          );
        }
      }
    }
  });
}
