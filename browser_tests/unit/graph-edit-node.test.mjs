// #572: graph_edit_node is the one undoable presentation edit path. Extract the
// shipped browser method and run it against LiteGraph-shaped doubles, so this verifies
// the real implementation rather than a copy of it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");
const methodMatch = panelSrc.match(/graph_edit_node\(args = \{\}\) \{[\s\S]*?\n  \},/);
assert.ok(methodMatch, "could not locate graph_edit_node in panel source");

function realGraphEditNode(getGraphCtx, resolveNode, refreshNodeArea, unsafeBypassMappings, resolveRailNode, railKindFor) {
  const factory = new Function(
    "getGraphCtx",
    "resolveNode",
    "refreshNodeArea",
    "unsafeBypassMappings",
    "resolveRailNode",
    "railKindFor",
    `const executors = { ${methodMatch[0]} }; return executors.graph_edit_node;`,
  );
  return factory(getGraphCtx, resolveNode, refreshNodeArea, unsafeBypassMappings, resolveRailNode, railKindFor);
}

function makeNode(id, { pos = [0, 0], size = [140, 60], collapsible = true } = {}) {
  return {
    id,
    pos: [...pos],
    size: [...size],
    title: `Node ${id}`,
    flags: {},
    collapsible,
    setSize(next) { this.size = [Math.max(80, next[0]), Math.max(40, next[1])]; },
    collapse(force) {
      if (!this.collapsible && !force) return;
      this.flags.collapsed = !this.flags.collapsed;
    },
  };
}

function setup(nodes, { palette = { blue: { color: "#123456", bgcolor: "#654321" } }, unsafeBypassMappings = () => [], resolveRailNode = () => null, railKindFor = () => null, rootGraph = false } = {}) {
  const events = [];
  const graph = {
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
    setDirtyCanvas: () => events.push("dirty"),
    getNodeById: (id) => nodes.find((candidate) => candidate.id === id) ?? null,
  };
  const resolver = (_graph, id) => {
    const node = nodes.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`No node with id ${id}`);
    return node;
  };
  const fn = realGraphEditNode(
    () => ({ graph, rootGraph: rootGraph ? graph : undefined, LG: { LGraphCanvas: { node_colors: palette } } }),
    resolver,
    () => events.push("area"),
    unsafeBypassMappings,
    resolveRailNode,
    railKindFor,
  );
  return { fn, events };
}

test("#572 applies move, resize, title, color, shape, collapse, and pin in one undo envelope", () => {
  const node = makeNode(7, { collapsible: false });
  const { fn, events } = setup([node]);
  const result = fn({
    node_id: 7,
    pos: [10, 20],
    size: [400, 200],
    title: "Loaders",
    color: "#abc",
    bgcolor: "#1234",
    shape: "round",
    collapsed: true,
    pinned: true,
    mode: "mute",
  });

  assert.deepEqual(node.pos, [10, 20]);
  assert.deepEqual(node.size, [400, 200], "setSize must be used so real nodes can clamp/reflow");
  assert.equal(node.title, "Loaders");
  assert.equal(node.color, "#abc");
  assert.equal(node.bgcolor, "#1234");
  assert.equal(node.shape, "round");
  assert.equal(node.flags.collapsed, true, "forced collapse handles non-collapsible nodes");
  assert.equal(node.flags.pinned, true);
  assert.equal(node.mode, 2);
  assert.deepEqual(events.filter((e) => e === "before" || e === "after"), ["before", "after"]);
  assert.equal(events.at(-1), "dirty");
  assert.equal(result.edited[0].before.title, "Node 7");
  assert.equal(result.edited[0].after.title, "Loaders");
});

test("#572 bulk edits resolve all targets first and share one undo step", () => {
  const first = makeNode(1);
  const second = makeNode(2);
  const { fn, events } = setup([first, second]);
  const result = fn({ node_ids: [1, 2], preset: "blue", pinned: true, mode: "bypass" });

  for (const node of [first, second]) {
    assert.equal(node.color, "#123456");
    assert.equal(node.bgcolor, "#654321");
    assert.equal(node.flags.pinned, true);
    assert.equal(node.mode, 4);
  }
  assert.equal(result.edited.length, 2);
  assert.deepEqual(events.filter((e) => e === "before" || e === "after"), ["before", "after"]);
});

test("#572 rejects ambiguous, incomplete, and unsafe inputs before mutation", () => {
  const node = makeNode(1);
  const { fn, events } = setup([node]);
  assert.throws(() => fn({ node_id: 1, node_ids: [1], title: "x" }), /exactly one/);
  assert.throws(() => fn({ node_id: 1 }), /at least one/);
  assert.throws(() => fn({ node_id: 1, color: "red" }), /hex/);
  assert.throws(() => fn({ node_id: 1, preset: "blue", color: "#abc" }), /cannot be combined/);
  assert.throws(() => fn({ node_ids: [1, 1], title: "x" }), /duplicates/);
  assert.deepEqual(events, []);
});

test("#538 rejects inherited mode names without mutating the node", () => {
  const node = makeNode(1);
  const { fn, events } = setup([node]);
  assert.throws(() => fn({ node_id: 1, mode: "toString" }), /mode must be/);
  assert.equal(node.mode, undefined);
  assert.deepEqual(events, []);
});

test("#572 preserves the subgraph bypass preflight and force warning", () => {
  const node = { ...makeNode(1), subgraph: {}, inputs: [{ name: "image", type: "IMAGE" }], outputs: [{ name: "mask", type: "MASK", links: [9] }] };
  const mismatch = [{ output_name: "mask", output_type: "MASK", input_name: "image", input_type: "IMAGE" }];
  const { fn, events } = setup([node], { unsafeBypassMappings: () => mismatch });

  assert.throws(() => fn({ node_id: 1, mode: "bypass" }), /Refusing to bypass/);
  assert.equal(node.mode, undefined);
  assert.deepEqual(events, []);

  const result = fn({ node_id: 1, mode: "bypass", force: true });
  assert.equal(node.mode, 4);
  assert.equal(result.warnings[0].node_id, 1);
  assert.match(result.warnings[0].warning, /unsafe boundary mapping/);
});

test("#572 keeps panel_move_node compatibility for a subgraph boundary rail", () => {
  const railNode = makeNode(-10, { pos: [4, 5] });
  const { fn, events } = setup([], {
    resolveRailNode: (_graph, id) => id === -10 ? { node: railNode, rail: "input" } : null,
  });

  const result = fn({ node_id: -10, pos: [40, 50] });
  assert.deepEqual(railNode.pos, [40, 50]);
  assert.equal(result.edited[0].after.node_id, -10);
  assert.deepEqual(events.filter((e) => e === "before" || e === "after"), ["before", "after"]);
  assert.throws(() => fn({ node_id: -10, pos: [1, 2], size: [100, 60] }), /only supports pos/);
});

test("#572 does not mistake a real root-graph node id for a boundary rail", () => {
  const node = makeNode(-10);
  const { fn } = setup([node], { rootGraph: true, railKindFor: () => "input" });
  fn({ node_id: -10, title: "real node" });
  assert.equal(node.title, "real node");
});

test("#572 restores all presentation state when a later target throws", () => {
  const first = makeNode(1, { pos: [1, 2] });
  const second = makeNode(2, { pos: [3, 4] });
  const firstSetSizes = [];
  first.setSize = (next) => {
    firstSetSizes.push([...next]);
    first.size = [...next];
    first.widgetLayoutSize = [...next];
  };
  second.setSize = () => { throw new Error("reject resize"); };
  const { fn, events } = setup([first, second]);

  assert.throws(() => fn({ node_ids: [1, 2], pos: [50, 60], size: [300, 150], title: "changed" }), /reject resize/);
  assert.deepEqual(first.pos, [1, 2]);
  assert.deepEqual(first.size, [140, 60]);
  assert.deepEqual(first.widgetLayoutSize, [140, 60], "rollback must restore setSize-driven widget/layout state");
  assert.deepEqual(firstSetSizes, [[300, 150], [140, 60]], "rollback reuses setSize for an already-applied node");
  assert.equal(first.title, "Node 1");
  assert.deepEqual(second.pos, [3, 4]);
  assert.equal(second.title, "Node 2");
  assert.deepEqual(events.filter((e) => e === "before" || e === "after"), ["before", "after"]);
  assert.equal(events.at(-1), "dirty", "a failed atomic edit redraws its restored state before surfacing the error");
});

test("#538 retains every legacy presentation bridge command for old MCP servers", () => {
  for (const command of ["graph_move_node", "graph_resize_node", "graph_set_title", "graph_set_node_collapsed", "graph_set_node_color", "graph_set_node_mode"]) {
    assert.match(panelSrc, new RegExp(`\\n  ${command}\\(`));
  }
});

test("#538 legacy title and color wrappers preserve their null compatibility behavior", () => {
  assert.match(
    panelSrc,
    /graph_set_title\(\{ node_id, title \}\) \{[\s\S]*?graph_edit_node\(\{ node_id, title: title \?\? "" \}\)/,
    "nullish legacy titles must clear to an empty title, not become literal text",
  );
  assert.match(
    panelSrc,
    /graph_set_node_color\(\{ node_id, color, bgcolor, preset \}\) \{[\s\S]*?if \(preset != null\) args\.preset = preset;[\s\S]*?else \{[\s\S]*?if \(color !== undefined\) args\.color = color;[\s\S]*?if \(bgcolor !== undefined\) args\.bgcolor = bgcolor;/,
    "preset:null must retain the legacy explicit color/clear path",
  );
});
