// Regression coverage for panel#401: panel_canvas "zoom" lost the center set by
// "center_on_node". The zoom branch wrote ds.scale directly, which keeps the
// graph ORIGIN (top-left, at -ds.offset) pinned — so changing scale slides the
// viewport CENTER away, dumping the just-centered node off-screen (reporter saw
// in_view_count=0). The fix holds the graph-space viewport center constant.
//
// graph_canvas lives inline inside the GRAPH_TOOL_EXECUTORS object literal in
// web/js/comfyui-mcp-panel.js (references browser globals, so it can't be
// imported under plain Node). Following the same "real panel source" extraction
// convention as graph-set-node-collapsed.test.mjs, we regex the method's source
// out of the file and evaluate it via `new Function` with getGraphCtx /
// resolveNode / activePanelRoot injected as stubs, driving the ACTUAL shipped
// logic.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const methodMatch = panelSrc.match(/graph_canvas\(\{ action, node_id, dx, dy, scale \}\) \{[\s\S]*?\n {2}\},/);
assert.ok(methodMatch, "could not locate graph_canvas in panel source");

/** Build a fresh graph_canvas bound to injected stubs, evaluating the REAL
 *  method source pulled from the panel file. */
function realGraphCanvas(getGraphCtx, resolveNode, activePanelRoot = null) {
  const factory = new Function(
    "getGraphCtx",
    "resolveNode",
    "activePanelRoot",
    `const executors = { ${methodMatch[0]} };\nreturn executors.graph_canvas;`,
  );
  return factory(getGraphCtx, resolveNode, activePanelRoot);
}

/** A canvas stub whose transform mirrors litegraph's DragAndScale: ds.scale +
 *  ds.offset are CSS pixels, and the element reports its CSS size via
 *  getBoundingClientRect (dpr=1 so the backing store matches). */
function makeCanvas({ scale = 1, offset = [0, 0], width = 1000, height = 800, typedOffset = false } = {}) {
  const calls = { dirty: 0 };
  const el = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    getBoundingClientRect: () => ({ width, height, left: 0, top: 0, right: width, bottom: height }),
  };
  return {
    calls,
    // ComfyUI's LiteGraph DragAndScale stores offset as a Float32Array — exercise
    // that representation so the fix's guard can't silently skip production.
    ds: { scale, offset: typedOffset ? Float32Array.from(offset) : [...offset] },
    canvas: el,
    setDirty() { calls.dirty += 1; },
    // native centerOnNode: place the node's center at the viewport center using
    // the CSS-pixel transform (screenCenter = (graphCenter + offset) * scale).
    centerOnNode(node) {
      const cx = node.pos[0] + (node.size?.[0] ?? 0) / 2;
      const cy = node.pos[1] + (node.size?.[1] ?? 0) / 2;
      this.ds.offset[0] = width / (2 * this.ds.scale) - cx;
      this.ds.offset[1] = height / (2 * this.ds.scale) - cy;
    },
  };
}

/** Graph-space point currently at the viewport center — the exact quantity
 *  graph_view_nodes_in_viewport derives (center = -offset + cssSize/(2*scale)). */
function viewportCenter(canvas) {
  const { ds } = canvas;
  return [
    -ds.offset[0] + canvas.canvas.width / (2 * ds.scale),
    -ds.offset[1] + canvas.canvas.height / (2 * ds.scale),
  ];
}

test("#401 zoom preserves the graph-space viewport center (real panel source)", () => {
  const canvas = makeCanvas({ scale: 1, offset: [37, -12], width: 1000, height: 800 });
  const fn = realGraphCanvas(() => ({ graph: {}, canvas }));

  const before = viewportCenter(canvas);
  fn({ action: "zoom", scale: 0.35 });
  const after = viewportCenter(canvas);

  assert.equal(canvas.ds.scale, 0.35, "scale must be applied");
  assert.ok(Math.abs(after[0] - before[0]) < 1e-6, `center x drifted: ${before[0]} -> ${after[0]}`);
  assert.ok(Math.abs(after[1] - before[1]) < 1e-6, `center y drifted: ${before[1]} -> ${after[1]}`);
});

test("#401 FAIL-before demo: pinning the origin (old behavior) would move the center", () => {
  // The OLD zoom branch left ds.offset untouched. Show that keeping the origin
  // fixed while changing scale necessarily moves the center — i.e. the fix is
  // load-bearing, not cosmetic.
  const canvas = makeCanvas({ scale: 1, offset: [37, -12], width: 1000, height: 800 });
  const before = viewportCenter(canvas);
  // simulate the old code: scale only, offset untouched
  canvas.ds.scale = 0.35;
  const oldAfter = viewportCenter(canvas);
  assert.ok(
    Math.abs(oldAfter[0] - before[0]) > 100,
    "sanity: origin-pinned zoom should shift the center substantially",
  );
});

test("#401 center_on_node then zoom keeps the node framed (the reporter's scenario)", () => {
  // Node 46 at ~[-4400,-2900] as in the report.
  const node = { id: 46, pos: [-4400, -2900], size: [200, 100] };
  const canvas = makeCanvas({ scale: 1, offset: [0, 0], width: 1000, height: 800 });
  const fn = realGraphCanvas(() => ({ graph: {}, canvas }), () => node);

  fn({ action: "center_on_node", node_id: 46 });
  const nodeCenter = [node.pos[0] + node.size[0] / 2, node.pos[1] + node.size[1] / 2];
  const centeredAt = viewportCenter(canvas);
  assert.ok(Math.abs(centeredAt[0] - nodeCenter[0]) < 1e-6, "center_on_node should center the node");
  assert.ok(Math.abs(centeredAt[1] - nodeCenter[1]) < 1e-6, "center_on_node should center the node");

  fn({ action: "zoom", scale: 0.35 });

  // After zooming out, the node's center must still sit at the viewport center,
  // and the node must fall inside the (now larger) viewport rect.
  const afterZoom = viewportCenter(canvas);
  assert.ok(Math.abs(afterZoom[0] - nodeCenter[0]) < 1e-6, `zoom moved center x off node: ${afterZoom[0]}`);
  assert.ok(Math.abs(afterZoom[1] - nodeCenter[1]) < 1e-6, `zoom moved center y off node: ${afterZoom[1]}`);

  const vx = -canvas.ds.offset[0];
  const vy = -canvas.ds.offset[1];
  const vw = canvas.canvas.width / canvas.ds.scale;
  const vh = canvas.canvas.height / canvas.ds.scale;
  const inView =
    node.pos[0] < vx + vw && node.pos[0] + node.size[0] > vx &&
    node.pos[1] < vy + vh && node.pos[1] + node.size[1] > vy;
  assert.ok(inView, "node 46 must remain inside the viewport after zoom (report saw in_view_count=0)");
});

test("#401 zoom preserves the center with a Float32Array offset (LiteGraph production repr)", () => {
  // The old guard used Array.isArray(ds.offset), which is FALSE for a
  // Float32Array, so the correction was skipped and every real zoom re-pinned
  // the origin. This locks in typed-offset support.
  const canvas = makeCanvas({ scale: 1, offset: [37, -12], width: 1000, height: 800, typedOffset: true });
  assert.ok(canvas.ds.offset instanceof Float32Array, "precondition: offset is typed");
  const fn = realGraphCanvas(() => ({ graph: {}, canvas }));

  const before = viewportCenter(canvas);
  fn({ action: "zoom", scale: 0.35 });
  const after = viewportCenter(canvas);

  assert.equal(canvas.ds.scale, 0.35);
  assert.ok(Math.abs(after[0] - before[0]) < 1e-3, `center x drifted with typed offset: ${before[0]} -> ${after[0]}`);
  assert.ok(Math.abs(after[1] - before[1]) < 1e-3, `center y drifted with typed offset: ${before[1]} -> ${after[1]}`);
});

test("#401 zoom still validates scale bounds (no regression)", () => {
  const canvas = makeCanvas();
  const fn = realGraphCanvas(() => ({ graph: {}, canvas }));
  assert.throws(() => fn({ action: "zoom", scale: 0 }), /scale must be in/);
  assert.throws(() => fn({ action: "zoom", scale: 5 }), /scale must be in/);
});
