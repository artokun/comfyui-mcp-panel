// panel#754 part (3) — `panel_center_on_node` accepted `scale` and silently ignored it,
// so "centre on node 42 at 1.5x" centred at whatever zoom happened to be set.
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
