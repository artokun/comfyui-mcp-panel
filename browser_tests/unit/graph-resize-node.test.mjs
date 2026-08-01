// #530: graph_resize_node (web/js/comfyui-mcp-panel.js) sets a node's [width, height]
// on the live canvas so Note/MarkdownNote nodes (created at LiteGraph's unreadable
// 140×60 default) can be enlarged — panel_move_node only repositions.
//
// graph_resize_node lives inline inside the GRAPH_TOOL_EXECUTORS object literal in
// comfyui-mcp-panel.js (it references browser/ComfyUI globals, so it can't be imported
// under plain Node). This follows the same "real panel source" extraction convention as
// graph-set-node-collapsed.test.mjs: regex the method's source text out of the file and
// evaluate it via `new Function`, injecting getGraphCtx / resolveNode stubs so the test
// drives the ACTUAL shipped logic.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const methodMatch = panelSrc.match(/graph_resize_node\(\{ node_id, size \}\) \{[\s\S]*?\n  \},/);
assert.ok(methodMatch, "could not locate graph_resize_node in panel source");

/** Build a fresh graph_resize_node bound to the given stubs, evaluating the REAL method
 *  source pulled from the panel file. */
function realGraphResizeNode(getGraphCtx, resolveNode) {
  const factory = new Function(
    "getGraphCtx",
    "resolveNode",
    `const executors = { ${methodMatch[0]} };\nreturn executors.graph_resize_node;`,
  );
  return factory(getGraphCtx, resolveNode);
}

/** A node mirroring a real LGraphNode: setSize() clamps width/height to a computed min. */
function makeNode({ id = 5, size = [140, 60], min = [80, 40] } = {}) {
  const calls = { setSize: 0 };
  return {
    id,
    size: [...size],
    setSizeCalledWith: null,
    setSize(s) {
      calls.setSize += 1;
      this.setSizeCalledWith = [...s];
      this.size = [Math.max(s[0], min[0]), Math.max(s[1], min[1])];
    },
    _calls: calls,
  };
}

function makeCtx(node) {
  const events = [];
  const graph = {
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
    setDirtyCanvas: () => events.push("dirty"),
  };
  return {
    getGraphCtx: () => ({ graph }),
    resolveNode: () => node,
    events,
  };
}

test("graph_resize_node uses setSize and reports from/to", () => {
  const node = makeNode({ size: [140, 60] });
  const ctx = makeCtx(node);
  const resize = realGraphResizeNode(ctx.getGraphCtx, ctx.resolveNode);

  const res = resize({ node_id: 5, size: [400, 300] });
  assert.deepEqual(node.setSizeCalledWith, [400, 300], "setSize preferred over raw node.size");
  assert.equal(node._calls.setSize, 1);
  assert.deepEqual(res.resized.from, [140, 60]);
  assert.deepEqual(res.resized.to, [400, 300]);
  assert.equal(res.resized.node_id, 5);
});

test("graph_resize_node reflects a min-size clamp in the reported 'to'", () => {
  const node = makeNode({ size: [140, 60], min: [200, 100] });
  const ctx = makeCtx(node);
  const resize = realGraphResizeNode(ctx.getGraphCtx, ctx.resolveNode);

  const res = resize({ node_id: 5, size: [50, 20] });
  // The node clamped up to its minimum; the result reports the ACTUAL post-clamp size.
  assert.deepEqual(res.resized.to, [200, 100]);
});

test("graph_resize_node wraps the write in a beforeChange/afterChange undo envelope + dirties", () => {
  const node = makeNode();
  const ctx = makeCtx(node);
  const resize = realGraphResizeNode(ctx.getGraphCtx, ctx.resolveNode);
  resize({ node_id: 5, size: [400, 300] });
  assert.deepEqual(ctx.events, ["before", "after", "dirty"]);
});

test("graph_resize_node falls back to node.size when setSize is absent", () => {
  const node = { id: 9, size: [140, 60] };
  const ctx = makeCtx(node);
  const resize = realGraphResizeNode(ctx.getGraphCtx, ctx.resolveNode);
  const res = resize({ node_id: 9, size: [321, 222] });
  assert.deepEqual(node.size, [321, 222]);
  assert.deepEqual(res.resized.to, [321, 222]);
});

test("graph_resize_node rejects malformed sizes", () => {
  const node = makeNode();
  const ctx = makeCtx(node);
  const resize = realGraphResizeNode(ctx.getGraphCtx, ctx.resolveNode);
  assert.throws(() => resize({ node_id: 5, size: [400] }), /size must be \[width, height\]/);
  assert.throws(() => resize({ node_id: 5, size: "big" }), /size must be \[width, height\]/);
  assert.throws(() => resize({ node_id: 5, size: [0, 300] }), /two positive numbers/);
  assert.throws(() => resize({ node_id: 5, size: [-10, 300] }), /two positive numbers/);
  assert.throws(() => resize({ node_id: 5, size: [400, NaN] }), /two positive numbers/);
});
