// Coverage for #488: graph_set_node_property (web/js/comfyui-mcp-panel.js) sets a
// node's LiteGraph PROPERTY (right-click → Properties) — the counterpart to
// graph_set_widget, which only reaches `widgets`. Many custom nodes are configured
// entirely through node.properties (e.g. the rgthree Fast Groups Bypasser's
// matchTitle/matchColors/sort/toggleRestriction filters), so an agent could add the
// node but never finish configuring it. The handler must:
//   * REFUSE an unresolvable node id (resolveNode throws) — no fabricated success;
//   * write node.properties[name] inside a beforeChange/afterChange undo envelope and
//     redraw (setDirtyCanvas);
//   * INVOKE onPropertyChanged(name, value, prev) when present so the change takes
//     effect live (rgthree re-filters its groups); and
//   * honor a strict `false` return from that callback by reverting (LiteGraph's own
//     LGraphNode.setProperty semantics), so the reported `to` reflects reality.
//
// graph_set_node_property lives inline inside the GRAPH_TOOL_EXECUTORS object literal
// in comfyui-mcp-panel.js (can't be imported under plain Node — it references
// browser/ComfyUI globals), so this follows the same "real panel source" extraction
// convention used by graph-set-node-collapsed.test.mjs: regex the method's source out
// of the file and evaluate it via `new Function`, with getGraphCtx / resolveNode
// injected as stubs so the test drives the ACTUAL shipped logic.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const methodMatch = panelSrc.match(/graph_set_node_property\(\{ node_id, name, value \}\) \{[\s\S]*?\n  \},/);
assert.ok(methodMatch, "could not locate graph_set_node_property in panel source");

/** Build a fresh graph_set_node_property bound to the given getGraphCtx/resolveNode
 *  stubs, evaluating the REAL method source pulled from the panel file. */
function realGraphSetNodeProperty(getGraphCtx, resolveNode) {
  const factory = new Function(
    "getGraphCtx",
    "resolveNode",
    `const executors = { ${methodMatch[0]} };\nreturn executors.graph_set_node_property;`,
  );
  return factory(getGraphCtx, resolveNode);
}

function makeGraph() {
  const calls = { before: 0, after: 0, dirty: 0 };
  return {
    calls,
    beforeChange() { calls.before += 1; },
    afterChange() { calls.after += 1; },
    setDirtyCanvas() { calls.dirty += 1; },
  };
}

/** A resolveNode stub that mirrors the real one: returns the node for the id it
 *  was built with, throws for anything else. */
function resolverFor(node) {
  return (_graph, id) => {
    if (Number(id) === Number(node.id)) return node;
    throw new Error(`No node with id ${id} in the current graph`);
  };
}

test("#488 sets a property and reports the correct from/to", () => {
  const node = { id: 42, properties: { matchTitle: "old" } };
  const graph = makeGraph();
  const fn = realGraphSetNodeProperty(() => ({ graph }), resolverFor(node));

  const result = fn({ node_id: 42, name: "matchTitle", value: "Loaders" });

  assert.equal(node.properties.matchTitle, "Loaders", "the property must actually be written");
  assert.deepEqual(result.set, { node_id: 42, name: "matchTitle", from: "old", to: "Loaders" });
  assert.equal(graph.calls.before, 1, "must open an undo envelope");
  assert.equal(graph.calls.after, 1, "must close the undo envelope");
  assert.ok(graph.calls.dirty >= 1, "must redraw so the change is visible");
});

test("#488 initializes a missing properties bag rather than throwing", () => {
  const node = { id: 7 }; // no .properties at all
  const graph = makeGraph();
  const fn = realGraphSetNodeProperty(() => ({ graph }), resolverFor(node));

  const result = fn({ node_id: 7, name: "sort", value: "title" });

  assert.equal(node.properties.sort, "title");
  assert.equal(result.set.from, undefined, "from must be undefined when the property was absent");
  assert.equal(result.set.to, "title");
});

test("#488 INVOKES onPropertyChanged so the change takes effect live (rgthree re-filter)", () => {
  const seen = [];
  const node = {
    id: 100,
    type: "Fast Groups Bypasser (rgthree)",
    properties: { matchTitle: "" },
    // rgthree-style: reacts to the property change by re-filtering its group list.
    onPropertyChanged(name, value, prev) {
      seen.push({ name, value, prev });
      this._filteredWith = value; // the "live effect"
    },
  };
  const graph = makeGraph();
  const fn = realGraphSetNodeProperty(() => ({ graph }), resolverFor(node));

  const result = fn({ node_id: 100, name: "matchTitle", value: "Sampler" });

  assert.deepEqual(seen, [{ name: "matchTitle", value: "Sampler", prev: "" }],
    "onPropertyChanged must be called with (name, value, prevValue)");
  assert.equal(node._filteredWith, "Sampler", "the node's reactive side effect must have run");
  assert.equal(result.set.to, "Sampler");
});

test("#488 a strict `false` from onPropertyChanged REVERTS the write (LiteGraph setProperty semantics)", () => {
  const node = {
    id: 101,
    properties: { toggleRestriction: "default" },
    onPropertyChanged() { return false; }, // reject the change
  };
  const graph = makeGraph();
  const fn = realGraphSetNodeProperty(() => ({ graph }), resolverFor(node));

  const result = fn({ node_id: 101, name: "toggleRestriction", value: "max one" });

  assert.equal(node.properties.toggleRestriction, "default", "a rejected change must be reverted on the node");
  assert.equal(result.set.to, "default", "reported `to` must reflect the reverted reality, not the attempted value");
  assert.equal(result.set.from, "default");
});

test("#488 a THROWING onPropertyChanged keeps the raw write but SURFACES the failure (no fabricated clean success)", () => {
  const node = {
    id: 102,
    properties: {},
    onPropertyChanged() { throw new Error("node callback blew up"); },
  };
  const graph = makeGraph();
  const fn = realGraphSetNodeProperty(() => ({ graph }), resolverFor(node));

  const result = fn({ node_id: 102, name: "matchColors", value: "#ff0000" });

  assert.equal(node.properties.matchColors, "#ff0000", "the raw property write is kept");
  assert.equal(result.set.to, "#ff0000");
  assert.match(result.live_effect_error, /node callback blew up/,
    "the live-effect failure must be surfaced, not swallowed into a clean success");
  assert.equal(graph.calls.after, 1, "the undo envelope must still be closed via finally");
});

test("#488 creates the properties bag INSIDE the undo envelope (beforeChange sees no premature bag)", () => {
  const node = { id: 9 }; // no properties bag at all
  let bagAtBeforeChange = "unset";
  const graph = {
    calls: { after: 0, dirty: 0 },
    beforeChange() { bagAtBeforeChange = node.properties; },
    afterChange() { this.calls.after += 1; },
    setDirtyCanvas() { this.calls.dirty += 1; },
  };
  const fn = realGraphSetNodeProperty(() => ({ graph }), resolverFor(node));

  fn({ node_id: 9, name: "sort", value: "title" });

  assert.equal(bagAtBeforeChange, undefined,
    "the properties bag must NOT exist yet when beforeChange snapshots undo state — else Ctrl+Z can't restore the no-bag node");
  assert.equal(node.properties.sort, "title", "the write still lands after the bag is created inside the envelope");
});

test("#488 REFUSES the prototype-polluting property name __proto__ (no bag corruption, no fabricated read-back)", () => {
  const node = { id: 103, properties: {} };
  const graph = makeGraph();
  const fn = realGraphSetNodeProperty(() => ({ graph }), resolverFor(node));

  assert.throws(() => fn({ node_id: 103, name: "__proto__", value: null }), /__proto__/);
  assert.equal(graph.calls.before, 0, "must refuse before opening an undo envelope");
  // The bag's prototype must be untouched (a real Object.prototype), not replaced.
  assert.equal(Object.getPrototypeOf(node.properties), Object.prototype);
});

test("#488 REFUSES an unresolvable node id (no fabricated success)", () => {
  const graph = makeGraph();
  const missingNode = { id: 999 };
  const fn = realGraphSetNodeProperty(() => ({ graph }), resolverFor(missingNode));

  assert.throws(() => fn({ node_id: 5, name: "matchTitle", value: "x" }), /No node with id 5/);
  assert.equal(graph.calls.before, 0, "must not open an undo envelope for a node that doesn't resolve");
  assert.equal(graph.calls.dirty, 0, "must not redraw for a non-existent node");
});

test("#488 refuses an empty/non-string property name", () => {
  const node = { id: 8, properties: {} };
  const graph = makeGraph();
  const fn = realGraphSetNodeProperty(() => ({ graph }), resolverFor(node));

  assert.throws(() => fn({ node_id: 8, name: "", value: "x" }), /non-empty property name/);
});
