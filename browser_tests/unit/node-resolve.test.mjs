/**
 * Unit tests for web/js/lib/node-resolve.js — run with `node --test`.
 *
 * Models the REAL bug from #458: with ComfyUI's backend unreachable the node
 * definitions never load, so graph_add_node let LiteGraph mint a generic
 * placeholder node (in0/out0/'*', {value:0,text:""}) and reported it as a real
 * add, and graph_set_widget then "set" a widget that placeholder does not have.
 * Every signal said success while the workflow did not exist.
 *
 * These drive the SAME guard predicates the graph_add_node / graph_set_widget
 * handlers call (assertAddNodeResolvable / assertNodeWidgetWritable) against the
 * raw LiteGraph registry object (LG.registered_node_types).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isRegisteredNodeType,
  comfyNodeDefsLoaded,
  assertAddNodeResolvable,
  assertNodeWidgetWritable,
} from "../../web/js/lib/node-resolve.js";

// A registry shaped like LG.registered_node_types once /object_info loaded:
// hundreds of classes; we only need the sentinels + a couple of extras here.
function loadedRegistry(extra = []) {
  const reg = {};
  for (const t of [
    "KSampler",
    "CheckpointLoaderSimple",
    "CLIPTextEncode",
    "VAEDecode",
    "VAELoader",
    "EmptyLatentImage",
    "LoadImage",
    "SaveImage",
    ...extra,
  ]) {
    reg[t] = function NodeCtor() {};
  }
  return reg;
}

// Backend unreachable: /object_info never fetched, so no Comfy classes are
// registered. (LiteGraph may still have a handful of its own builtins, but none
// of the Comfy core sentinels.)
function unreachableRegistry() {
  return { "Note": function () {}, "Reroute": function () {} };
}

test("isRegisteredNodeType: hit / miss / bad input", () => {
  const reg = loadedRegistry();
  assert.equal(isRegisteredNodeType(reg, "KSampler"), true);
  assert.equal(isRegisteredNodeType(reg, "NopeNode"), false);
  assert.equal(isRegisteredNodeType(null, "KSampler"), false);
  assert.equal(isRegisteredNodeType(reg, undefined), false);
});

test("comfyNodeDefsLoaded: true when sentinels present, false when unreachable/empty", () => {
  assert.equal(comfyNodeDefsLoaded(loadedRegistry()), true);
  assert.equal(comfyNodeDefsLoaded(unreachableRegistry()), false);
  assert.equal(comfyNodeDefsLoaded({}), false);
  assert.equal(comfyNodeDefsLoaded(null), false);
});

test("add_node: ComfyUI unreachable ⇒ ERRORS (no synthetic node), names unreachable", () => {
  const reg = unreachableRegistry();
  assert.throws(
    () => assertAddNodeResolvable(reg, "CheckpointLoaderSimple"),
    /node definitions are not loaded|backend is unreachable/i,
  );
  // KSampler too — the repro added both and got byte-identical placeholders.
  assert.throws(
    () => assertAddNodeResolvable(reg, "KSampler"),
    /unreachable|not loaded/i,
  );
});

test("add_node: unknown type on a REACHABLE server ⇒ ERRORS with unknown-type", () => {
  const reg = loadedRegistry();
  assert.throws(
    () => assertAddNodeResolvable(reg, "DefinitelyNotARealNode"),
    /Unknown node type "DefinitelyNotARealNode"/,
  );
  // Must NOT be mislabeled as unreachable when defs are clearly loaded.
  assert.doesNotThrow(() => {
    try {
      assertAddNodeResolvable(reg, "DefinitelyNotARealNode");
    } catch (e) {
      assert.doesNotMatch(e.message, /unreachable|not loaded/i);
      return;
    }
    throw new Error("expected a throw");
  });
});

test("add_node: REAL type on a reachable server ⇒ resolves (no false negative)", () => {
  const reg = loadedRegistry(["KSamplerAdvanced"]);
  assert.doesNotThrow(() => assertAddNodeResolvable(reg, "CheckpointLoaderSimple"));
  assert.doesNotThrow(() => assertAddNodeResolvable(reg, "KSampler"));
  assert.doesNotThrow(() => assertAddNodeResolvable(reg, "KSamplerAdvanced"));
});

test("set_widget: unreachable + placeholder node ⇒ ERRORS (no fake set)", () => {
  const reg = unreachableRegistry();
  const placeholder = { id: 1, type: "CheckpointLoaderSimple", widgets: [] };
  assert.throws(
    () => assertNodeWidgetWritable(reg, placeholder),
    /not loaded|unreachable/i,
  );
});

test("set_widget: reachable but unregistered (missing custom node) ⇒ ERRORS with missing-node", () => {
  const reg = loadedRegistry();
  const node = { id: 7, type: "SomeUninstalledCustomNode", widgets: [] };
  assert.throws(
    () => assertNodeWidgetWritable(reg, node),
    /not registered on this ComfyUI|missing custom node/i,
  );
});

test("set_widget: registered node ⇒ passes the guard (no false negative)", () => {
  const reg = loadedRegistry();
  const node = { id: 3, type: "KSampler", widgets: [{ name: "seed", value: 0 }] };
  assert.doesNotThrow(() => assertNodeWidgetWritable(reg, node));
});

test("set_widget: subgraph node is exempt (carries its own inner graph, no registered class)", () => {
  const reg = loadedRegistry();
  const subgraphNode = { id: 9, type: "MyLocalSubgraph", subgraph: { _nodes: [] } };
  assert.doesNotThrow(() => assertNodeWidgetWritable(reg, subgraphNode));
});
