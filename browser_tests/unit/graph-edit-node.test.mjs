// #572: graph_edit_node is the one undoable presentation edit path. Extract the
// shipped browser method and run it against LiteGraph-shaped doubles, so this verifies
// the real implementation rather than a copy of it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalNodeId, isQualifiedNodeId } from "../../web/js/lib/node-id.js";
import { writePoint, refreshNodeArea } from "../../web/js/lib/group-geometry.js";
import { fileURLToPath } from "node:url";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");
const methodMatch = panelSrc.match(/graph_edit_node\(args = \{\}\) \{[\s\S]*?\n  \},/);
assert.ok(methodMatch, "could not locate graph_edit_node in panel source");
const legacyColorMatch = panelSrc.match(/graph_set_node_color\(\{ node_id, color, bgcolor, preset \}\) \{[\s\S]*?\n  \},/);
assert.ok(legacyColorMatch, "could not locate graph_set_node_color in panel source");
const legacyMoveMatch = panelSrc.match(/graph_move_node\(\{ node_id, pos \}\) \{[\s\S]*?\n  \},/);
assert.ok(legacyMoveMatch, "could not locate graph_move_node in panel source");
const legacyResizeMatch = panelSrc.match(/graph_resize_node\(\{ node_id, size \}\) \{[\s\S]*?\n  \},/);
assert.ok(legacyResizeMatch, "could not locate graph_resize_node in panel source");
const legacyTitleMatch = panelSrc.match(/graph_set_title\(\{ node_id, title \}\) \{[\s\S]*?\n  \},/);
assert.ok(legacyTitleMatch, "could not locate graph_set_title in panel source");
const legacyCollapsedMatch = panelSrc.match(/graph_set_node_collapsed\(\{ node_id, collapsed \}\) \{[\s\S]*?\n  \},/);
assert.ok(legacyCollapsedMatch, "could not locate graph_set_node_collapsed in panel source");
const legacyModeMatch = panelSrc.match(/graph_set_node_mode\(\{ node_id, mode, force \}\) \{[\s\S]*?\n  \},/);
assert.ok(legacyModeMatch, "could not locate graph_set_node_mode in panel source");

function realGraphEditNode(getGraphCtx, resolveNode, refreshNodeArea, unsafeBypassMappings, resolveRailNode, railKindFor) {
  const factory = new Function(
    "getGraphCtx",
    "resolveNode",
    "refreshNodeArea",
    "unsafeBypassMappings",
    "resolveRailNode",
    "railKindFor",
    // #1425 — the REAL helpers, not doubles: injecting a stub here would let the
    // extracted method pass against a canonicalNodeId that always returned NaN.
    "canonicalNodeId",
    "isQualifiedNodeId",
    "writePoint",
    `const executors = { ${methodMatch[0]} }; return executors.graph_edit_node;`,
  );
  return factory(
    getGraphCtx,
    resolveNode,
    refreshNodeArea,
    unsafeBypassMappings,
    resolveRailNode,
    railKindFor,
    canonicalNodeId,
    isQualifiedNodeId,
    writePoint,
  );
}

function realLegacyColor(getGraphCtx, resolveNode, normalizeLegacyNodeId) {
  return new Function(
    "getGraphCtx",
    "resolveNode",
    "normalizeLegacyNodeId",
    `const executors = { ${legacyColorMatch[0]} }; return executors.graph_set_node_color;`,
  )(getGraphCtx, resolveNode, normalizeLegacyNodeId);
}

function realLegacyMotion(getGraphCtx, resolveNode, refreshNodeArea, unsafeBypassMappings, resolveRailNode, railKindFor, normalizeLegacyNodeId) {
  return new Function(
    "getGraphCtx",
    "resolveNode",
    "refreshNodeArea",
    "unsafeBypassMappings",
    "resolveRailNode",
    "railKindFor",
    "normalizeLegacyNodeId",
    "canonicalNodeId",
    "isQualifiedNodeId",
    "writePoint",
    `const GRAPH_TOOL_EXECUTORS = { ${methodMatch[0]} ${legacyMoveMatch[0]} ${legacyResizeMatch[0]} };
     return { move: GRAPH_TOOL_EXECUTORS.graph_move_node, resize: GRAPH_TOOL_EXECUTORS.graph_resize_node };`,
  )(getGraphCtx, resolveNode, refreshNodeArea, unsafeBypassMappings, resolveRailNode, railKindFor, normalizeLegacyNodeId, canonicalNodeId, isQualifiedNodeId, writePoint);
}

function realLegacyTitle(getGraphCtx, resolveNode, refreshNodeArea, unsafeBypassMappings, resolveRailNode, railKindFor, normalizeLegacyNodeId) {
  return new Function(
    "getGraphCtx",
    "resolveNode",
    "refreshNodeArea",
    "unsafeBypassMappings",
    "resolveRailNode",
    "railKindFor",
    "normalizeLegacyNodeId",
    "canonicalNodeId",
    "isQualifiedNodeId",
    "writePoint",
    `const GRAPH_TOOL_EXECUTORS = { ${methodMatch[0]} ${legacyTitleMatch[0]} }; return GRAPH_TOOL_EXECUTORS.graph_set_title;`,
  )(getGraphCtx, resolveNode, refreshNodeArea, unsafeBypassMappings, resolveRailNode, railKindFor, normalizeLegacyNodeId, canonicalNodeId, isQualifiedNodeId, writePoint);
}

function realLegacyCollapsed(getGraphCtx, resolveNode, refreshNodeArea, unsafeBypassMappings, resolveRailNode, railKindFor, normalizeLegacyNodeId) {
  return new Function(
    "getGraphCtx",
    "resolveNode",
    "refreshNodeArea",
    "unsafeBypassMappings",
    "resolveRailNode",
    "railKindFor",
    "normalizeLegacyNodeId",
    "canonicalNodeId",
    "isQualifiedNodeId",
    "writePoint",
    `const GRAPH_TOOL_EXECUTORS = { ${methodMatch[0]} ${legacyCollapsedMatch[0]} }; return GRAPH_TOOL_EXECUTORS.graph_set_node_collapsed;`,
  )(getGraphCtx, resolveNode, refreshNodeArea, unsafeBypassMappings, resolveRailNode, railKindFor, normalizeLegacyNodeId, canonicalNodeId, isQualifiedNodeId, writePoint);
}

function realLegacyMode(getGraphCtx, resolveNode, unsafeBypassMappings, normalizeLegacyNodeId) {
  return new Function(
    "getGraphCtx",
    "resolveNode",
    "unsafeBypassMappings",
    "normalizeLegacyNodeId",
    `const executors = { ${legacyModeMatch[0]} }; return executors.graph_set_node_mode;`,
  )(getGraphCtx, resolveNode, unsafeBypassMappings, normalizeLegacyNodeId);
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

function normalizeLegacyNodeId(nodeId) {
  if (typeof nodeId === "number" && Number.isInteger(nodeId)) return nodeId;
  if (typeof nodeId === "string" && /^-?(?:0|[1-9]\d*)$/.test(nodeId)) {
    const normalized = Number(nodeId);
    if (Number.isSafeInteger(normalized)) return normalized;
  }
  throw new Error("node_id must be an integer");
}

function setup(nodes, { palette = { blue: { color: "#123456", bgcolor: "#654321" } }, unsafeBypassMappings = () => [], resolveRailNode = () => null, railKindFor = () => null, rootGraph = false, onResolve = () => {} } = {}) {
  const events = [];
  const graph = {
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
    setDirtyCanvas: () => events.push("dirty"),
    getNodeById: (id) => nodes.find((candidate) => candidate.id === id) ?? null,
  };
  const resolver = (_graph, id) => {
    onResolve(id);
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

function setupLegacyColor(node, palette = { blue: { color: "#123456", bgcolor: "#654321" } }) {
  const events = [];
  const graph = {
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
    setDirtyCanvas: () => events.push("dirty"),
  };
  const fn = realLegacyColor(
    () => ({ graph, LG: { LGraphCanvas: { node_colors: palette } } }),
    (_graph, id) => {
      if (id !== node.id) throw new Error(`No node with id ${id}`);
      return node;
    },
    normalizeLegacyNodeId,
  );
  return { fn, events };
}

function setupLegacyMotion(nodes, { resolveRailNode = () => null } = {}) {
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
  const fns = realLegacyMotion(
    () => ({ graph, LG: { LGraphCanvas: { node_colors: {} } } }),
    resolver,
    () => events.push("area"),
    () => [],
    resolveRailNode,
    () => null,
    normalizeLegacyNodeId,
  );
  return { ...fns, events };
}

function setupLegacyTitle(node) {
  const events = [];
  const graph = {
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
    setDirtyCanvas: () => events.push("dirty"),
    getNodeById: (id) => id === node.id ? node : null,
  };
  const fn = realLegacyTitle(
    () => ({ graph, LG: { LGraphCanvas: { node_colors: {} } } }),
    (_graph, id) => {
      if (id !== node.id) throw new Error(`No node with id ${id}`);
      return node;
    },
    () => events.push("area"),
    () => [],
    () => null,
    () => null,
    normalizeLegacyNodeId,
  );
  return { fn, events };
}

function setupLegacyCollapsed(node) {
  const events = [];
  const graph = {
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
    setDirtyCanvas: () => events.push("dirty"),
    getNodeById: (id) => id === node.id ? node : null,
  };
  const fn = realLegacyCollapsed(
    () => ({ graph, LG: { LGraphCanvas: { node_colors: {} } } }),
    (_graph, id) => {
      if (id !== node.id) throw new Error(`No node with id ${id}`);
      return node;
    },
    () => events.push("area"),
    () => [],
    () => null,
    () => null,
    normalizeLegacyNodeId,
  );
  return { fn, events };
}

function setupLegacyMode(node, unsafeBypassMappings = () => []) {
  const events = [];
  const graph = {
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
    setDirtyCanvas: () => events.push("dirty"),
  };
  const fn = realLegacyMode(
    () => ({ graph }),
    (_graph, id) => {
      if (id !== node.id) throw new Error(`No node with id ${id}`);
      return node;
    },
    unsafeBypassMappings,
    normalizeLegacyNodeId,
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
  assert.throws(() => fn({ node_id: 1, title: null }), /title must be a string/);
  assert.throws(() => fn({ node_id: 1, title: { text: "x" } }), /title must be a string/);
  assert.throws(() => fn({ node_ids: [1, 1], title: "x" }), /duplicates/);
  assert.deepEqual(events, []);
});

test("#538 rejects non-integer target IDs before resolving or mutating", () => {
  const zero = makeNode(0);
  const one = makeNode(1);
  const resolved = [];
  const { fn, events } = setup([zero, one], { onResolve: (id) => resolved.push(id) });

  for (const nodeId of [true, "1", 1.5, null]) {
    assert.throws(() => fn({ node_id: nodeId, title: "wrong target" }), /node_id must be an integer/);
  }
  for (const nodeIds of [[null], [true], ["1"], [1.5]]) {
    assert.throws(() => fn({ node_ids: nodeIds, title: "wrong target" }), /node_ids must contain only integers/);
  }

  assert.equal(zero.title, "Node 0");
  assert.equal(one.title, "Node 1");
  assert.deepEqual(resolved, []);
  assert.deepEqual(events, []);
});

test("#538 rejects inherited mode names without mutating the node", () => {
  const node = makeNode(1);
  const { fn, events } = setup([node]);
  assert.throws(() => fn({ node_id: 1, mode: "toString" }), /mode must be/);
  assert.equal(node.mode, undefined);
  assert.deepEqual(events, []);
});

test("#538 rejects inherited palettes and non-boolean presentation flags before mutation", () => {
  const node = makeNode(1);
  const { fn, events } = setup([node]);
  assert.throws(() => fn({ node_id: 1, preset: "toString" }), /unknown color preset/);
  assert.throws(() => fn({ node_id: 1, collapsed: null }), /collapsed must be a boolean/);
  assert.throws(() => fn({ node_id: 1, pinned: "yes" }), /pinned must be a boolean/);
  assert.equal(node.color, undefined);
  assert.equal(node.bgcolor, undefined);
  assert.deepEqual(node.flags, {});
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

test("#538 requires a real boolean force for new and legacy unsafe-bypass paths", () => {
  const mismatch = [{ output_name: "mask", output_type: "MASK", input_name: "image", input_type: "IMAGE" }];
  const coreNode = { ...makeNode(1), subgraph: {}, inputs: [{ name: "image", type: "IMAGE" }], outputs: [{ name: "mask", type: "MASK", links: [9] }] };
  const { fn: edit, events: editEvents } = setup([coreNode], { unsafeBypassMappings: () => mismatch });
  assert.throws(() => edit({ node_id: 1, mode: "bypass", force: "false" }), /force must be a boolean/);
  assert.equal(coreNode.mode, undefined);
  assert.deepEqual(editEvents, []);

  const legacyNode = { ...makeNode(2), subgraph: {}, inputs: [{ name: "image", type: "IMAGE" }], outputs: [{ name: "mask", type: "MASK", links: [9] }] };
  const { fn: legacyMode, events: modeEvents } = setupLegacyMode(legacyNode, () => mismatch);
  assert.throws(() => legacyMode({ node_id: 2, mode: "bypass", force: "false" }), /force must be a boolean/);
  assert.equal(legacyNode.mode, undefined);
  assert.deepEqual(modeEvents, []);
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

test("#538 legacy title wrapper preserves nullish-title compatibility", () => {
  assert.match(
    panelSrc,
    /graph_set_title\(\{ node_id, title \}\) \{[\s\S]*?graph_edit_node\(\{ node_id: normalizeLegacyNodeId\(node_id\), title: title == null \? "" : String\(title\) \}\)/,
    "legacy titles must clear nullish values and retain historical coercion while direct graph_edit_node stays strict",
  );
});

test("#538 legacy colors retain preset:null no-op and permissive CSS values", () => {
  const node = makeNode(1);
  node.color = "#old";
  node.bgcolor = "#body";
  const { fn, events } = setupLegacyColor(node);

  const unchanged = fn({ node_id: 1, preset: null });
  assert.deepEqual(unchanged, { node_id: 1, color: "#old", bgcolor: "#body" });
  assert.equal(node.color, "#old");
  assert.equal(node.bgcolor, "#body");
  assert.deepEqual(events, ["before", "after", "dirty"]);

  const changed = fn({ node_id: 1, preset: null, color: "red", bgcolor: null });
  assert.deepEqual(changed, { node_id: 1, color: "red", bgcolor: null });
  assert.equal(node.color, "red", "legacy callers may use non-hex CSS colors");
  assert.equal(Object.hasOwn(node, "bgcolor"), false, "null clears a legacy body color");

  const presetWins = fn({ node_id: 1, preset: "blue", color: "red", bgcolor: "orange" });
  assert.deepEqual(presetWins, { node_id: 1, color: "#123456", bgcolor: "#654321" });
  assert.equal(node.color, "#123456", "legacy preset takes precedence over a supplied CSS color");
  assert.equal(node.bgcolor, "#654321");
});

test("#538 legacy color and mode normalize canonical numeric node-id strings before resolveNode", () => {
  const colorNode = makeNode(1);
  const { fn: color } = setupLegacyColor(colorNode);
  assert.deepEqual(color({ node_id: "1", color: "red" }), { node_id: 1, color: "red", bgcolor: null });

  const modeNode = makeNode(2);
  const { fn: mode } = setupLegacyMode(modeNode);
  assert.deepEqual(mode({ node_id: "2", mode: "mute" }), { node_id: 2, mode: "mute", previous_mode: "active" });

  const badColorNode = makeNode(0);
  const { fn: badColor, events: colorEvents } = setupLegacyColor(badColorNode);
  assert.throws(() => badColor({ node_id: "01", color: "red" }), /node_id must be an integer/);
  assert.equal(badColorNode.color, undefined);
  assert.deepEqual(colorEvents, []);

  const badModeNode = makeNode(1);
  const { fn: badMode, events: modeEvents } = setupLegacyMode(badModeNode);
  assert.throws(() => badMode({ node_id: true, mode: "mute" }), /node_id must be an integer/);
  assert.equal(badModeNode.mode, undefined);
  assert.deepEqual(modeEvents, []);
});

test("#538 legacy color and collapsed commands reject invalid values without mutating", () => {
  const colorNode = makeNode(1);
  colorNode.color = "#old";
  colorNode.bgcolor = "#body";
  const { fn: color, events: colorEvents } = setupLegacyColor(colorNode);
  assert.throws(() => color({ node_id: 1, preset: "toString" }), /unknown color preset/);
  assert.equal(colorNode.color, "#old");
  assert.equal(colorNode.bgcolor, "#body");
  assert.deepEqual(colorEvents, ["before", "after"]);

  const collapsedNode = makeNode(2);
  const { fn: collapsed, events: collapsedEvents } = setupLegacyCollapsed(collapsedNode);
  assert.throws(() => collapsed({ node_id: 2, collapsed: "false" }), /collapsed must be a boolean/);
  assert.deepEqual(collapsedNode.flags, {});
  assert.deepEqual(collapsedEvents, []);
});

test("#538 legacy move preserves rail responses and numeric-string geometry", () => {
  const node = makeNode(1, { pos: [1, 2], size: [140, 60] });
  const railNode = makeNode(-10, { pos: [3, 4] });
  const { move, resize } = setupLegacyMotion([node], {
    resolveRailNode: (_graph, id) => id === -10 || id === "input" ? { node: railNode, rail: "input" } : null,
  });

  assert.deepEqual(move({ node_id: -10, pos: ["30", "40"] }), {
    moved: { node_id: -10, rail: "input", from: [3, 4], to: [30, 40] },
  });
  assert.deepEqual(move({ node_id: "input", pos: ["50", "60"] }), {
    moved: { node_id: -10, rail: "input", from: [30, 40], to: [50, 60] },
  }, "legacy input alias resolves to the rail's numeric id before strict graph_edit_node dispatch");
  assert.deepEqual(resize({ node_id: 1, size: ["300", "150"] }), {
    resized: { node_id: 1, from: [140, 60], to: [300, 150] },
  });
  assert.deepEqual(node.size, [300, 150]);
});

test("#538 legacy wrappers normalize canonical numeric node-id strings without weakening graph_edit_node", () => {
  const motionNode = makeNode(7, { pos: [1, 2], size: [140, 60] });
  const { move, resize } = setupLegacyMotion([motionNode]);
  assert.deepEqual(move({ node_id: "7", pos: ["30", "40"] }), {
    moved: { node_id: 7, from: [1, 2], to: [30, 40] },
  });
  assert.deepEqual(resize({ node_id: "7", size: ["300", "150"] }), {
    resized: { node_id: 7, from: [140, 60], to: [300, 150] },
  });

  const titleNode = makeNode(8);
  const { fn: title } = setupLegacyTitle(titleNode);
  assert.deepEqual(title({ node_id: "8", title: "Legacy title" }), {
    node_id: 8, previous: "Node 8", title: "Legacy title",
  });

  const collapsedNode = makeNode(9);
  const { fn: collapsed } = setupLegacyCollapsed(collapsedNode);
  assert.deepEqual(collapsed({ node_id: "9", collapsed: true }), { node_id: 9, collapsed: true });

  assert.throws(() => move({ node_id: "07", pos: [1, 2] }), /node_id must be an integer/);
  assert.throws(() => title({ node_id: "8.0", title: "wrong" }), /node_id must be an integer/);
  assert.equal(titleNode.title, "Legacy title", "invalid legacy forms are rejected before the strict editor mutates");
});

/** ComfyUI-shaped node: pos and size are views into one [x, y, w, h] Rectangle.
 *  updateArea writes [x, y, x2, y2] into that same buffer — the #1444 inflation
 *  (height becomes y+h, then the next stack/move compounds to tens of thousands). */
function makeRectBackedNode(id, { pos = [100, 200], size = [210, 80] } = {}) {
  const rect = new Float64Array([pos[0], pos[1], size[0], size[1]]);
  return {
    id,
    title: `Node ${id}`,
    flags: {},
    get pos() { return rect.subarray(0, 2); },
    set pos(v) {
      if (!v || v.length < 2) return;
      rect[0] = v[0];
      rect[1] = v[1];
    },
    get size() { return rect.subarray(2, 4); },
    set size(v) {
      if (!v || v.length < 2) return;
      rect[2] = v[0];
      rect[3] = v[1];
    },
    setSize(s) { this.size = s; },
    boundingRect: rect,
    updateArea() {
      const x = this.pos[0];
      const y = this.pos[1];
      const w = this.size[0];
      const h = this.size[1];
      rect[0] = x;
      rect[1] = y;
      rect[2] = x + w;
      rect[3] = y + h;
    },
  };
}

test("#1444 a move does not inflate size when pos/size share a Rectangle buffer", () => {
  const node = makeRectBackedNode(1, { pos: [100, 200], size: [210, 80] });
  const startedWidth = node.size[0];
  const startedHeight = node.size[1];
  const events = [];
  const graph = {
    beforeChange: () => events.push("before"),
    afterChange: () => events.push("after"),
    setDirtyCanvas: () => events.push("dirty"),
    getNodeById: (id) => (id === 1 ? node : null),
  };
  // Real refreshNodeArea so updateArea actually runs after the pos write, like
  // the shipped GRAPH_TOOL_EXECUTORS path.
  const edit = realGraphEditNode(
    () => ({ graph, LG: { LGraphCanvas: { node_colors: {} } } }),
    (_g, id) => {
      if (id !== 1) throw new Error(`No node with id ${id}`);
      return node;
    },
    refreshNodeArea,
    () => [],
    () => null,
    () => null,
  );

  const result = edit({ node_id: 1, pos: [400, 500] });
  assert.equal(node.pos[0], 400);
  assert.equal(node.pos[1], 500);
  assert.equal(node.size[0], startedWidth, "width must stay the pre-move size, not x+w");
  assert.equal(node.size[1], startedHeight, "height must stay the pre-move size, not y+h");
  assert.equal(result.edited[0].after.size.length, 2);
  assert.deepEqual(result.edited[0].after.size, [startedWidth, startedHeight]);
  assert.deepEqual(result.edited[0].after.pos, [400, 500]);
});

test("#1444 rejects a tens-of-thousands size without mutating the node", () => {
  const node = makeNode(1, { pos: [40, 60], size: [210, 80] });
  const { fn, events } = setup([node]);
  const beforeSize = [node.size[0], node.size[1]];
  const beforePos = [node.pos[0], node.pos[1]];
  // Reporter's LoadImage height. Must refuse before any write.
  assert.throws(() => fn({ node_id: 1, size: [210, 49135.84375] }), /size/);
  assert.deepEqual([node.size[0], node.size[1]], beforeSize);
  assert.deepEqual([node.pos[0], node.pos[1]], beforePos);
  assert.deepEqual(events, []);
});

test("#1444 rejects a billion-pixel position without mutating the node", () => {
  const node = makeNode(1, { pos: [40, 60], size: [210, 80] });
  const { fn, events } = setup([node]);
  const beforePos = [node.pos[0], node.pos[1]];
  assert.throws(() => fn({ node_id: 1, pos: [100, 1e9] }), /pos/);
  assert.deepEqual([node.pos[0], node.pos[1]], beforePos);
  assert.deepEqual(events, []);
});

test("#1444 setSize/onResize inflation is rolled back, not reported as success", () => {
  const node = makeNode(1, { pos: [40, 60], size: [210, 80] });
  const beforeSize = [node.size[0], node.size[1]];
  node.setSize = () => {
    // Image-preview / computeSize path that writes the reporter's LoadImage height.
    node.size = [210, 49135.84375];
  };
  const { fn, events } = setup([node]);
  assert.throws(() => fn({ node_id: 1, size: [400, 200] }), /size/);
  assert.deepEqual([node.size[0], node.size[1]], beforeSize);
  assert.deepEqual(events.filter((e) => e === "before" || e === "after"), ["before", "after"]);
});
