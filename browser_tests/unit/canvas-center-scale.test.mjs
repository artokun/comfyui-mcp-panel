// panel#754 part (3) — `panel_canvas` with action:"center_on_node" accepted `scale` and
// silently ignored it, so "centre on node 42 at 1.5x" centred at whatever zoom happened
// to be set.
//
// (An earlier draft of this header named a per-action tool that does not exist. The
// vocabulary gate caught it and was right to: every panel_* identifier is scanned, not
// just ones in string literals, because a wrong name in a comment or hint is read by the
// MODEL and becomes a tool-not-found it cannot diagnose. Naming it even to deny it still
// trips the gate — correctly, since the gate cannot know the intent.)
//
// ORDER IS THE FIX. The centring math divides by `ds.scale` (and litegraph's own
// centerOnNode reads it too), so applying the zoom AFTER centring slides the node back
// off-centre — that is #401's hazard, one branch over. The zoom therefore goes first.
//
// These drive the SHIPPED graph_canvas body, extracted from the panel source, so the
// assertion is on what the code does rather than on what it contains.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeCanvasDsInPlace } from "../../web/js/lib/canvas-ds.js";

const src = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)), "utf8");
const body = src.match(/\n {2}graph_canvas\(\{ action, node_id, dx, dy, scale \}\) \{[\s\S]*?\n {2}\},/);
assert.ok(body, "could not locate graph_canvas");

function makeCanvas({ scale = 1, centerOnNode = true } = {}) {
  const calls = [];
  const ds = { scale, offset: [0, 0] };
  const canvas = {
    ds,
    setDirty: () => {},
    canvas: { width: 1000, height: 800, clientWidth: 1000, clientHeight: 800,
      getBoundingClientRect: () => ({ width: 1000, height: 800 }) },
    // litegraph's own centring records the scale it saw, which is what proves ordering.
    ...(centerOnNode ? { centerOnNode: (n) => calls.push({ scaleAtCentre: ds.scale, node: n.id }) } : {}),
  };
  return { canvas, ds, calls };
}

function run({ canvas, ds }, args) {
  const node = { id: 42, pos: [500, 400], size: [200, 100] };
  const graph = { _nodes: [node] };
  const deps = {
    getGraphCtx: () => ({ graph, canvas }),
    resolveNode: () => node,
    normalizeCanvasDsInPlace,
  };
  const names = Object.keys(deps);
  const fn = new Function(...names, `const e = {${body[0]}}; return e.graph_canvas;`);
  return fn(...names.map((n) => deps[n]))(args);
}

test("#754 center_on_node APPLIES a supplied scale", () => {
  const c = makeCanvas({ scale: 1 });
  run(c, { action: "center_on_node", node_id: 42, scale: 1.5 });
  assert.equal(c.ds.scale, 1.5);
});

test("#754 the zoom is applied BEFORE centring, not after", () => {
  // The whole defect class: centring reads ds.scale, so a later zoom undoes it.
  const c = makeCanvas({ scale: 1 });
  run(c, { action: "center_on_node", node_id: 42, scale: 2 });
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].scaleAtCentre, 2, "centerOnNode must see the NEW scale");
});

test("#754 the manual fallback also centres at the new scale", () => {
  // No canvas.centerOnNode: the inline math divides by ds.scale, so ordering shows up
  // directly in the resulting offset.
  const withZoom = makeCanvas({ scale: 1, centerOnNode: false });
  run(withZoom, { action: "center_on_node", node_id: 42, scale: 2 });
  const noZoom = makeCanvas({ scale: 2, centerOnNode: false });
  run(noZoom, { action: "center_on_node", node_id: 42 });
  assert.deepEqual(
    [...withZoom.ds.offset],
    [...noZoom.ds.offset],
    "zoom-then-centre must equal centring that was already at that zoom",
  );
});

test("#754 omitting scale leaves the zoom untouched", () => {
  const c = makeCanvas({ scale: 1.25 });
  run(c, { action: "center_on_node", node_id: 42 });
  assert.equal(c.ds.scale, 1.25);
});

test("#754 an out-of-range scale is REFUSED, matching action:'zoom'", () => {
  // One tool must not accept a scale its sibling refuses.
  for (const bad of [0, -1, 0.05, 5, Number.NaN]) {
    const c = makeCanvas({ scale: 1 });
    assert.throws(
      () => run(c, { action: "center_on_node", node_id: 42, scale: bad }),
      /scale must be in \(0\.05, 4\]/,
      `scale ${bad} should be refused`,
    );
    assert.equal(c.ds.scale, 1, "a refused scale must not be applied");
  }
});

test("#754 center_on_node and zoom accept EXACTLY the same scale range", () => {
  // The range literal is duplicated between the two branches rather than shared, so this
  // pins the invariant the duplication risks: one tool must never accept a scale its
  // sibling refuses. If someone widens one branch, this fails rather than the drift
  // shipping silently.
  const probe = (action, scale) => {
    const c = makeCanvas({ scale: 1 });
    try {
      run(c, { action, node_id: 42, scale });
      return "accepted";
    } catch (e) {
      return /scale must be in/.test(e.message) ? "refused" : `other:${e.message}`;
    }
  };
  for (const s of [0.05, 0.06, 1, 4, 4.01, 0, -1, Number.NaN]) {
    assert.equal(
      probe("center_on_node", s),
      probe("zoom", s),
      `center_on_node and zoom disagree on scale ${s}`,
    );
  }
});

test("#754 coercion matches action:'zoom' — null and NaN refused, numeric string accepted", () => {
  // Both branches use the identical `Number(scale)` idiom, so behaviour on non-numbers is
  // shared rather than newly invented here. null -> 0 -> refused; "1.5" -> 1.5 -> applied.
  const c1 = makeCanvas({ scale: 1 });
  assert.throws(() => run(c1, { action: "center_on_node", node_id: 42, scale: null }), /scale must be in/);
  assert.equal(c1.ds.scale, 1, "a refused scale is not applied");

  const c2 = makeCanvas({ scale: 1 });
  run(c2, { action: "center_on_node", node_id: 42, scale: "1.5" });
  assert.equal(c2.ds.scale, 1.5);
});
