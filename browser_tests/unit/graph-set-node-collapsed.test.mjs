// Regression coverage for #345: graph_set_node_collapsed (web/js/comfyui-mcp-panel.js)
// was a silent no-op for any node whose `collapsible` is falsy, because
// node.collapse() early-returns for such a node unless a truthy `force` is
// passed, and the panel called it with none — the direct flag-write fallback
// branch was therefore dead code (node.collapse is always a function on a real
// LGraphNode, so the `else` never ran).
//
// graph_set_node_collapsed lives inline inside the GRAPH_TOOL_EXECUTORS object
// literal in comfyui-mcp-panel.js (can't be imported under plain Node — it
// references browser/ComfyUI globals), so this follows the same "real panel
// source" extraction convention already used by manager-install.test.mjs's
// "waitForQueueDrain (real panel source)" test: regex the method's source text
// out of the file and evaluate it via `new Function`, with `getGraphCtx` /
// `resolveNode` injected as stubs so the test drives the ACTUAL shipped logic.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const methodMatch = panelSrc.match(/graph_set_node_collapsed\(\{ node_id, collapsed \}\) \{[\s\S]*?\n  \},/);
assert.ok(methodMatch, "could not locate graph_set_node_collapsed in panel source");

/** Build a fresh graph_set_node_collapsed bound to the given getGraphCtx/resolveNode
 *  stubs, evaluating the REAL method source pulled from the panel file. */
function realGraphSetNodeCollapsed(getGraphCtx, resolveNode) {
  const factory = new Function(
    "getGraphCtx",
    "resolveNode",
    `const executors = { ${methodMatch[0]} };\nreturn executors.graph_set_node_collapsed;`,
  );
  return factory(getGraphCtx, resolveNode);
}

/** A node whose `collapse` mirrors the real ComfyUI frontend's
 *  LGraphNode.prototype.collapse(force): a silent no-op when `collapsible` is
 *  falsy and no truthy `force` is passed, otherwise toggles flags.collapsed. */
function makeNode({ id = 170, collapsible = true, collapsed = false } = {}) {
  return {
    id,
    collapsible,
    flags: { collapsed },
    collapse(force) {
      if (!this.collapsible && !force) return;
      this.flags.collapsed = !this.flags.collapsed;
    },
  };
}

function makeGraph() {
  const calls = { before: 0, after: 0, dirty: 0 };
  return {
    calls,
    beforeChange: () => { calls.before += 1; },
    afterChange: () => { calls.after += 1; },
    setDirtyCanvas: () => { calls.dirty += 1; },
  };
}

test("#345 FAIL-before regression fixture: node.collapse() alone is a no-op when non-collapsible", () => {
  // This is not the panel's fix — it's a direct demonstration of the bug's root
  // cause (LGraphNode.prototype.collapse's own guard), so the fix's necessity is
  // provable independent of the panel source extraction below.
  const node = makeNode({ collapsible: false });
  node.collapse(); // no force — exactly what the OLD panel code called
  assert.equal(node.flags.collapsed, false, "collapse() with no force must not apply on a non-collapsible node");
});

test("#345 graph_set_node_collapsed FORCES collapse on a non-collapsible node (real panel source)", () => {
  const node = makeNode({ collapsible: false, collapsed: false });
  const graph = makeGraph();
  const fn = realGraphSetNodeCollapsed(() => ({ graph }), () => node);

  const result = fn({ node_id: node.id, collapsed: true });

  assert.equal(node.flags.collapsed, true, "the node's actual flag must flip even though collapsible is false");
  assert.equal(result.collapsed, true, "the reported state must match reality, not silently stay false");
  assert.equal(graph.calls.dirty >= 1, true, "must redraw so the collapsed state is visible");
});

test("#345 graph_set_node_collapsed FORCES expand on a non-collapsible, already-collapsed node", () => {
  const node = makeNode({ collapsible: false, collapsed: true });
  const graph = makeGraph();
  const fn = realGraphSetNodeCollapsed(() => ({ graph }), () => node);

  const result = fn({ node_id: node.id, collapsed: false });

  assert.equal(node.flags.collapsed, false);
  assert.equal(result.collapsed, false);
});

test("#345 graph_set_node_collapsed still works normally on an ordinary collapsible node (no regression)", () => {
  const node = makeNode({ collapsible: true, collapsed: false });
  const graph = makeGraph();
  const fn = realGraphSetNodeCollapsed(() => ({ graph }), () => node);

  const result = fn({ node_id: node.id, collapsed: true });
  assert.equal(node.flags.collapsed, true);
  assert.equal(result.collapsed, true);

  const result2 = fn({ node_id: node.id, collapsed: false });
  assert.equal(node.flags.collapsed, false);
  assert.equal(result2.collapsed, false);
});

test("#345 graph_set_node_collapsed is a no-op when already in the requested state (no spurious toggle)", () => {
  const node = makeNode({ collapsible: false, collapsed: true });
  const graph = makeGraph();
  const fn = realGraphSetNodeCollapsed(() => ({ graph }), () => node);

  const result = fn({ node_id: node.id, collapsed: true });
  assert.equal(node.flags.collapsed, true);
  assert.equal(result.collapsed, true);
});

test("#345 falls back to a direct flag write when node.collapse is not a function at all", () => {
  const node = { id: 170, flags: { collapsed: false } }; // no collapse() method whatsoever
  const graph = makeGraph();
  const fn = realGraphSetNodeCollapsed(() => ({ graph }), () => node);

  const result = fn({ node_id: node.id, collapsed: true });
  assert.equal(node.flags.collapsed, true);
  assert.equal(result.collapsed, true);
});
