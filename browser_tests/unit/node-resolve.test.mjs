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
  assertResolvedTargetRegistered,
} from "../../web/js/lib/node-resolve.js";
import { applyWidgetWrite } from "../../web/js/lib/widget-write.js";

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

// ---- assertResolvedTargetRegistered (the predicate, on a RESOLVED target) ----

test("set_widget guard: unreachable + placeholder target ⇒ ERRORS (unreachable)", () => {
  const reg = unreachableRegistry();
  const placeholder = { id: 1, type: "CheckpointLoaderSimple" };
  assert.throws(() => assertResolvedTargetRegistered(reg, placeholder), /not loaded|unreachable/i);
});

test("set_widget guard: reachable but unregistered target ⇒ ERRORS (missing-node)", () => {
  const reg = loadedRegistry();
  assert.throws(
    () => assertResolvedTargetRegistered(reg, { id: 7, type: "SomeUninstalledCustomNode" }),
    /not registered on this ComfyUI|missing custom node|placeholder/i,
  );
});

test("set_widget guard: type-less target ⇒ ERRORS (fail CLOSED, never open)", () => {
  assert.throws(() => assertResolvedTargetRegistered(loadedRegistry(), { id: 5 }), /not registered/i);
  assert.throws(() => assertResolvedTargetRegistered(loadedRegistry(), {}), /not registered/i);
  // A truthy `subgraph` property must NOT buy an exemption here — only a
  // registered resolved target passes.
  assert.throws(
    () => assertResolvedTargetRegistered(loadedRegistry(), { id: 8, subgraph: {} }),
    /not registered/i,
  );
});

test("set_widget guard: registered target ⇒ passes (no false negative)", () => {
  assert.doesNotThrow(() =>
    assertResolvedTargetRegistered(loadedRegistry(), { id: 3, type: "KSampler" }),
  );
});

// ---- END-TO-END through applyWidgetWrite + the injected registry hook --------
// These prove the guard runs on the ACTUAL RESOLVED target the write mutates,
// which is where the outer-node check failed open (subgraph / promoted paths).

const HOOKS = { beforeChange() {}, afterChange() {}, setDirty() {} };
function hookFor(registry) {
  return {
    ...HOOKS,
    assertTargetWritable: (t) => assertResolvedTargetRegistered(registry, t),
  };
}

// A real SubgraphNode over an inner KSampler whose promoted widget "sched_alias"
// maps to the inner "scheduler". innerType lets us flip the inner node between a
// registered class (authentic) and an unregistered placeholder.
function makeSubgraphFixture(innerType = "KSampler") {
  const inner = {
    id: 54,
    type: innerType,
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "sched_alias", _subgraphSlot: { name: "sched_alias" } }],
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple"] }, value: 999 }],
  };
  const resolveSource = (_n, si) =>
    si?.name === "sched_alias" ? { sourceNodeId: "54", sourceWidgetName: "scheduler" } : null;
  return { parent, inner, resolveSource };
}

test("set_widget e2e: DIRECT registered node ⇒ write succeeds", () => {
  const reg = loadedRegistry();
  const node = { id: 3, type: "KSampler", widgets: [{ name: "steps", type: "INT", value: 0 }] };
  const set = applyWidgetWrite(node, "steps", 20, hookFor(reg));
  assert.equal(set.value, 20);
});

test("set_widget e2e: DIRECT unregistered placeholder (reachable) ⇒ REFUSE, no mutation", () => {
  const reg = loadedRegistry();
  const ghost = { id: 1, type: "GhostNode", widgets: [{ name: "value", type: "number", value: 0 }] };
  assert.throws(() => applyWidgetWrite(ghost, "value", 5, hookFor(reg)), /not registered|placeholder/i);
  assert.equal(ghost.widgets[0].value, 0);
});

test("set_widget e2e (case a): placeholder carrying `subgraph:{}` + generic widget ⇒ REFUSE", () => {
  const reg = loadedRegistry();
  // subgraph:{} is truthy but has no promoted inputs, so it resolves to its OWN
  // generic widget — the exact fail-open the outer-node check allowed.
  const ghost = { id: 2, type: "GhostNode", subgraph: {}, widgets: [{ name: "value", type: "number", value: 0 }] };
  assert.throws(() => applyWidgetWrite(ghost, "value", 7, hookFor(reg)), /not registered|placeholder/i);
  assert.equal(ghost.widgets[0].value, 0);
});

test("set_widget e2e (case b): real subgraph → UNREGISTERED inner placeholder ⇒ REFUSE, inner untouched", () => {
  const reg = loadedRegistry();
  const { parent, inner, resolveSource } = makeSubgraphFixture("GhostSampler");
  assert.throws(
    () => applyWidgetWrite(parent, "sched_alias", "karras", { ...hookFor(reg), resolveSource }),
    /not registered|placeholder/i,
  );
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "simple");
});

test("set_widget e2e (case c): type-less node ⇒ REFUSE", () => {
  const reg = loadedRegistry();
  const node = { id: 5, widgets: [{ name: "value", type: "number", value: 0 }] };
  assert.throws(() => applyWidgetWrite(node, "value", 3, hookFor(reg)), /not registered/i);
});

test("set_widget e2e (keep): real subgraph → REGISTERED inner node ⇒ still succeeds", () => {
  const reg = loadedRegistry();
  const { parent, inner, resolveSource } = makeSubgraphFixture("KSampler");
  const set = applyWidgetWrite(parent, "sched_alias", "karras", { ...hookFor(reg), resolveSource });
  assert.equal(set.value, "karras");
  assert.equal(set.promoted_from.inner_node_id, 54);
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "karras");
});

test("set_widget e2e: unreachable ⇒ REFUSE even for a would-be-core type, no mutation", () => {
  const reg = unreachableRegistry();
  const node = { id: 1, type: "CheckpointLoaderSimple", widgets: [{ name: "ckpt_name", type: "text", value: "" }] };
  assert.throws(() => applyWidgetWrite(node, "ckpt_name", "x.safetensors", hookFor(reg)), /not loaded|unreachable/i);
  assert.equal(node.widgets[0].value, "");
});
