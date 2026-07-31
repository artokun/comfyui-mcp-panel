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
  assertAddNodeResolvableRefreshing,
  assertResolvedTargetRegistered,
} from "../../web/js/lib/node-resolve.js";
// The PRODUCTION graph_set_widget handler body — the executor and these tests
// call it verbatim, so the tested ordering IS the shipped ordering (#458).
import { runSetWidget } from "../../web/js/lib/set-widget.js";

// A registry shaped like LG.registered_node_types once /object_info loaded:
// hundreds of classes; we only need the sentinels + a couple of extras here.
// registerNodesFromDefs stamps the def onto each type-specific class, so a real
// comfy class carries `.nodeData` — mirror that (used by the stale-placeholder
// instance check). Native/defless types (see extraDefless) carry no nodeData.
function loadedRegistry(extra = [], extraDefless = []) {
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
    const ctor = function NodeCtor() {};
    ctor.nodeData = { input: { required: {} } };
    reg[t] = ctor;
  }
  for (const t of extraDefless) reg[t] = function NativeCtor() {};
  return reg;
}

// A GENUINELY-RESOLVED node instance: its own constructor carries the live def
// (nodeData), exactly like a real litegraph node whose type registered from
// /object_info. This is what distinguishes it from a stale placeholder instance.
function regNode(type, widgets = [{ name: "steps", type: "INT", value: 0 }], extra = {}) {
  return {
    id: 3,
    type,
    widgets,
    constructor: { nodeData: { input: { required: {} } } },
    ...extra,
  };
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

test("add_node: unknown-type error points at a LIVE tool, not the retired panel_get_graph (#318)", () => {
  const reg = loadedRegistry();
  try {
    assertAddNodeResolvable(reg, "DefinitelyNotARealNode");
    throw new Error("expected a throw");
  } catch (e) {
    // The retired panel_get_graph must never be recommended.
    assert.doesNotMatch(e.message, /panel_get_graph/);
    // Should steer the caller to the registry-search tool instead.
    assert.match(e.message, /panel_search_nodes/);
  }
});

test("add_node: REAL type on a reachable server ⇒ resolves (no false negative)", () => {
  const reg = loadedRegistry(["KSamplerAdvanced"]);
  assert.doesNotThrow(() => assertAddNodeResolvable(reg, "CheckpointLoaderSimple"));
  assert.doesNotThrow(() => assertAddNodeResolvable(reg, "KSampler"));
  assert.doesNotThrow(() => assertAddNodeResolvable(reg, "KSamplerAdvanced"));
});

// ---- assertAddNodeResolvableRefreshing: authoritative fresh /object_info --------
// The go/no-go is decided against the CURRENT backend /object_info, never the
// mutated add-only registry: it MISSES freshly-installed classes (#289) and KEEPS
// stale positives for uninstalled ones (#458/P1-C). Fail closed on both edges.

// Build a fresh /object_info map (class_type -> def) with the core set + extras.
function objectInfo(extra = []) {
  const info = {};
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
    info[t] = { input: { required: {} } };
  }
  return info;
}

const regCtor = () => {
  const c = function NodeCtor() {};
  c.nodeData = { input: { required: {} } };
  return c;
};

test("#289: a freshly-installed type — in fresh object_info but NOT the stale registry — resolves after a refresh", async () => {
  const reg = loadedRegistry(); // page-load registry: no SeedVR2* yet
  const fresh = objectInfo(["SeedVR2LoadDiTModel"]); // backend now provides it
  let refreshed = 0;
  const opts = {
    getFreshObjectInfo: async () => fresh,
    refresh: async () => {
      refreshed++;
      reg["SeedVR2LoadDiTModel"] = regCtor(); // registerNodesFromDefs adds it
    },
  };
  await assert.doesNotReject(() =>
    assertAddNodeResolvableRefreshing(() => reg, "SeedVR2LoadDiTModel", opts),
  );
  assert.equal(refreshed, 1, "refreshed once to register the newly-installed class");
  assert.ok(isRegisteredNodeType(reg, "SeedVR2LoadDiTModel"), "type registered after refresh");
});

test("#458/P1-C: a STALE registry positive absent from fresh object_info FAILS CLOSED (removed pack)", async () => {
  // GoneNode's pack was uninstalled + backend restarted: the add-only refresh never
  // purged it, so it survives in the registry — but the fresh /object_info does NOT
  // list it. The go/no-go MUST use the fresh payload and refuse, not the stale reg.
  const reg = loadedRegistry(["GoneNode"]); // stale positive still registered
  assert.ok(isRegisteredNodeType(reg, "GoneNode"), "precondition: stale registry entry present")
  const fresh = objectInfo(); // backend no longer provides GoneNode
  let refreshed = 0;
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(() => reg, "GoneNode", {
        getFreshObjectInfo: async () => fresh,
        refresh: async () => {
          refreshed++;
        },
      }),
    /Unknown node type "GoneNode"|backend does not provide/i,
  );
  assert.equal(refreshed, 0, "never refreshed — the fresh backend simply lacks the type");
});

test("#458: a type absent from BOTH fresh object_info and the registry FAILS CLOSED", async () => {
  const reg = loadedRegistry();
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(() => reg, "TotallyMadeUpNode", {
        getFreshObjectInfo: async () => objectInfo(),
        refresh: async () => {},
      }),
    /Unknown node type "TotallyMadeUpNode"|backend does not provide/i,
  );
});

test("add_node: a type in BOTH fresh object_info and the registry resolves WITHOUT refreshing", async () => {
  const reg = loadedRegistry();
  let refreshed = 0;
  await assert.doesNotReject(() =>
    assertAddNodeResolvableRefreshing(() => reg, "KSampler", {
      getFreshObjectInfo: async () => objectInfo(),
      refresh: async () => {
        refreshed++;
      },
    }),
  );
  assert.equal(refreshed, 0, "no refresh needed when already registered");
});

test("#458: backend defines the type but the refresh CANNOT register it ⇒ FAIL CLOSED (no placeholder)", async () => {
  const reg = loadedRegistry(); // lacks NewNode
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(() => reg, "NewNode", {
        getFreshObjectInfo: async () => objectInfo(["NewNode"]),
        refresh: async () => {
          /* refresh runs but fails to register NewNode into the registry */
        },
      }),
    /could not be registered|Refusing to add an unresolved placeholder/i,
  );
});

test("#458: fresh object_info unavailable (null) ⇒ FAIL CLOSED, does not authorize from the registry", async () => {
  const reg = unreachableRegistry(); // no core sentinels
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(() => reg, "SeedVR2LoadDiTModel", {
        getFreshObjectInfo: async () => null, // fetch failed / unavailable
        refresh: async () => {},
      }),
    /cannot verify node type|object_info is unavailable|backend is unreachable/i,
  );
});

test("#458/P1-2: a REGISTERED type + a REJECTING object_info fetch ⇒ FAIL CLOSED (no stale-registry authorization)", async () => {
  // The exact P1-2 hole: GoneNode is still in the registry (pack removed but not
  // purged), and the fresh /object_info fetch transiently REJECTS. The old fallback
  // authorized from the registry and would construct GoneNode. It must fail closed.
  const reg = loadedRegistry(["GoneNode"]); // registry HIT
  assert.ok(isRegisteredNodeType(reg, "GoneNode"), "precondition: registry still holds GoneNode");
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(() => reg, "GoneNode", {
        getFreshObjectInfo: async () => {
          throw new Error("object_info fetch failed (transient)");
        },
        refresh: async () => {},
      }),
    /cannot verify node type|object_info is unavailable/i,
  );
});

test("add_node: a THROWING object_info fetch FAILS CLOSED (does not trust the registry)", async () => {
  const reg = loadedRegistry(); // reachable per registry; type unknown
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(() => reg, "StillUnknown", {
        getFreshObjectInfo: async () => {
          throw new Error("object_info fetch failed");
        },
        refresh: async () => {},
      }),
    /cannot verify node type|object_info is unavailable/i,
  );
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

test("set_widget guard: registered target (resolved instance) ⇒ passes (no false negative)", () => {
  assert.doesNotThrow(() => assertResolvedTargetRegistered(loadedRegistry(), regNode("KSampler")));
});

// ---- stale PLACEHOLDER INSTANCE whose type is now registered (#458 r3) --------
// A workflow loaded while ComfyUI was unavailable creates instances on a generic
// fallback constructor (no nodeData). If the backend later registers the type,
// the type-string check passes yet the instance is still a generic placeholder.

test("set_widget guard: registered TYPE but placeholder INSTANCE (no def) ⇒ REFUSE", () => {
  const reg = loadedRegistry(); // KSampler registered WITH nodeData
  // Instance sits on the generic fallback constructor — no nodeData.
  const stale = { id: 9, type: "KSampler", widgets: [{ name: "value", value: 0 }], constructor: { name: "GenericFallback" } };
  assert.throws(() => assertResolvedTargetRegistered(reg, stale), /unresolved placeholder|live definition is missing/i);
});

test("set_widget guard: NATIVE/defless registered type (Note) ⇒ passes (no false negative)", () => {
  // Note is registered but has NO nodeData (litegraph-native), so there is no def
  // to compare against — a real instance with its own 'value' widget must pass.
  const reg = loadedRegistry([], ["Note"]);
  const note = { id: 4, type: "Note", widgets: [{ name: "value", type: "text", value: "hi" }], constructor: { name: "Note" } };
  assert.doesNotThrow(() => assertResolvedTargetRegistered(reg, note));
});

// ---- END-TO-END through the REAL production handler body (runSetWidget) -------
// These prove the guard runs on the ACTUAL RESOLVED target the write mutates,
// which is where the outer-node check failed open (subgraph / promoted paths).

const HOOKS = { beforeChange() {}, afterChange() {}, setDirty() {} };

// Drive the ACTUAL production handler body (runSetWidget) — the same function
// GRAPH_TOOL_EXECUTORS.graph_set_widget delegates to (it wires the assertTargetWritable
// guard internally). So dropping the shipped guard wiring, or reordering
// preflight/reconcile/guarded-write, FAILS these tests.
// A permissive fresh /object_info oracle covering every fixture TARGET type used in
// this file (core sentinels + the custom/ghost/subgraph types). runSetWidget REQUIRES
// the oracle (#458); here it is intentionally a no-op gate — the fresh backend
// "provides" every type — so these tests exercise the REGISTRY guard + handler
// ordering (their subject), while the fresh-gate fail-closed behavior is covered by
// set-widget-fresh-backend.test.mjs. Ghost/unregistered types are present in the
// oracle so the fresh gate passes and the REGISTRY guard (which lacks them) is the
// decider — preserving each test's original refusal message.
const FRESH_ALL = objectInfo([
  "MyRegNode",
  "GhostNode",
  "GhostSampler",
  "SubgraphNode",
  "Note",
]);

function setViaHandler(registry, node, widgetName, value, resolveSource) {
  return runSetWidget(node, widgetName, value, {
    registry,
    getFreshObjectInfo: async () => FRESH_ALL,
    resolveSource,
    ...HOOKS,
  });
}

// A real SubgraphNode over an inner KSampler whose promoted widget "sched_alias"
// maps to the inner "scheduler". innerType lets us flip the inner node between a
// registered class (authentic) and an unregistered placeholder.
function makeSubgraphFixture(innerType = "KSampler") {
  const inner = {
    id: 54,
    type: innerType,
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" }],
    // Genuinely-resolved inner instance carries its live def (nodeData).
    constructor: { nodeData: { input: { required: {} } } },
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) };
  // AUTHORITATIVE rail projection, identity-linked from the host input (#366).
  const railWidget = { name: "sched_alias", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    // Host input carries the OBJECT-IDENTITY link (`_widget`) to the parent's own
    // authoritative rail projection (#366) — what serializes at queue time.
    inputs: [{ name: "sched_alias", _widget: railWidget, _subgraphSlot: { name: "sched_alias" } }],
    widgets: [
      // Decoy own-widget named after the INNER source — must stay untouched (#233).
      { name: "scheduler", type: "combo", options: { values: ["simple"] }, value: 999 },
      railWidget,
    ],
  };
  const resolveSource = (_n, si) =>
    si?.name === "sched_alias" ? { sourceNodeId: "54", sourceWidgetName: "scheduler" } : null;
  return { parent, inner, resolveSource };
}

test("set_widget e2e: DIRECT registered node ⇒ write succeeds", async () => {
  const reg = loadedRegistry();
  const node = regNode("KSampler", [{ name: "steps", type: "INT", value: 0 }]);
  const { set } = await setViaHandler(reg, node, "steps", 20);
  assert.equal(set.value, 20);
});

// FINDING #1: the guard must run BEFORE coerceWidgetValue, which reads (and thus
// may INVOKE) a dynamic combo's options.values(widget) callback. On a placeholder
// that callback must NEVER fire — the write is refused first.
test("set_widget e2e (finding #1): placeholder w/ dynamic-combo widget ⇒ REFUSE before values() callback runs", async () => {
  const reg = loadedRegistry();
  let valuesCalled = false;
  const ghost = {
    id: 2,
    type: "GhostNode", // reachable but unregistered ⇒ refused
    widgets: [
      {
        name: "opt",
        type: "combo",
        options: {
          values: () => {
            valuesCalled = true; // a side-effecting dynamic combo
            return ["a", "b"];
          },
        },
        value: "a",
      },
    ],
  };
  // Through the REAL handler body, so the guard's position ahead of coercion is
  // exercised in production order.
  await assert.rejects(() => setViaHandler(reg, ghost, "opt", "b"), /not registered|placeholder/i);
  assert.equal(valuesCalled, false, "combo values() callback must not run on a refused placeholder");
  assert.equal(ghost.widgets[0].value, "a");
});

// FINDING #2 (e2e): a stale placeholder INSTANCE whose type is now registered
// must be refused rather than accept a write to its generic 'value' widget.
test("set_widget e2e (finding #2): registered TYPE but placeholder INSTANCE ⇒ REFUSE, no mutation", async () => {
  const reg = loadedRegistry(); // KSampler registered WITH nodeData
  const stale = {
    id: 9,
    type: "KSampler",
    widgets: [{ name: "value", type: "number", value: 0 }], // generic placeholder widget
    constructor: { name: "GenericFallback" }, // no nodeData ⇒ unresolved instance
  };
  // Through the REAL handler body (preflight → reconcile → guarded write).
  await assert.rejects(() => setViaHandler(reg, stale, "value", 5), /unresolved placeholder|live definition is missing/i);
  assert.equal(stale.widgets[0].value, 0);
});

test("set_widget e2e: DIRECT unregistered placeholder (reachable) ⇒ REFUSE, no mutation", async () => {
  const reg = loadedRegistry();
  const ghost = { id: 1, type: "GhostNode", widgets: [{ name: "value", type: "number", value: 0 }] };
  await assert.rejects(() => setViaHandler(reg, ghost, "value", 5), /not registered|placeholder/i);
  assert.equal(ghost.widgets[0].value, 0);
});

// case a/b/keep go through the REAL handler (setViaHandler): the REFUSAL/PASS is
// decided by the guard HOOK inside runSetWidget (these paths bypass outer
// preflight), so dropping the shipped guard wiring FAILS these tests.
test("set_widget e2e (case a): placeholder carrying `subgraph:{}` + generic widget ⇒ REFUSE (via handler)", async () => {
  const reg = loadedRegistry();
  // subgraph:{} is truthy but has no promoted inputs, so it resolves to its OWN
  // generic widget — the exact fail-open the outer-node check allowed. Refusal
  // here comes from the guard hook, not outer preflight.
  const ghost = { id: 2, type: "GhostNode", subgraph: {}, widgets: [{ name: "value", type: "number", value: 0 }] };
  await assert.rejects(() => setViaHandler(reg, ghost, "value", 7), /not registered|placeholder/i);
  assert.equal(ghost.widgets[0].value, 0);
});

test("set_widget e2e (case b): real subgraph → UNREGISTERED inner placeholder ⇒ REFUSE (via handler), inner untouched", async () => {
  const reg = loadedRegistry();
  const { parent, inner, resolveSource } = makeSubgraphFixture("GhostSampler");
  await assert.rejects(
    () => setViaHandler(reg, parent, "sched_alias", "karras", resolveSource),
    /not registered|placeholder/i,
  );
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "simple");
});

test("set_widget e2e (case c): type-less node ⇒ REFUSE", async () => {
  const reg = loadedRegistry();
  const node = { id: 5, widgets: [{ name: "value", type: "number", value: 0 }] };
  await assert.rejects(() => setViaHandler(reg, node, "value", 3), /not registered/i);
});

test("set_widget e2e (keep): real subgraph → REGISTERED inner node ⇒ still succeeds (via handler)", async () => {
  const reg = loadedRegistry();
  const { parent, inner, resolveSource } = makeSubgraphFixture("KSampler");
  const { set } = await setViaHandler(reg, parent, "sched_alias", "karras", resolveSource);
  assert.equal(set.value, "karras");
  assert.equal(set.promoted_from.inner_node_id, 54);
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "karras");
});

test("set_widget e2e: unreachable ⇒ REFUSE even for a would-be-core type, no mutation", async () => {
  const reg = unreachableRegistry();
  const node = { id: 1, type: "CheckpointLoaderSimple", widgets: [{ name: "ckpt_name", type: "text", value: "" }] };
  await assert.rejects(() => setViaHandler(reg, node, "ckpt_name", "x.safetensors"), /not loaded|unreachable/i);
  assert.equal(node.widgets[0].value, "");
});

// ---- HANDLER ORDERING through the REAL runSetWidget (#458) -------------------
// reconcileUnknownWidgetNames RENAMES widgets in place. The handler must preflight
// (refuse a placeholder) BEFORE reconcile, and reconcile only a resolved direct
// node. These drive the ACTUAL production runSetWidget so a reorder or a dropped
// guard fails a test — not a locally-recreated prelude.

// A node whose UNKNOWN/UNKNOWN_1 widgets WOULD be renamed by reconcile: its
// constructor.nodeData exposes exactly two widget inputs (steps, cfg) matching the
// two positional widgets. This is the mutation the guard must prevent on a
// placeholder.
function nodeWithUnknownWidgets(type) {
  return {
    id: 42,
    ...(type === undefined ? {} : { type }),
    widgets: [
      { name: "UNKNOWN", type: "INT", value: 0 },
      { name: "UNKNOWN_1", type: "number", value: 0 },
    ],
    constructor: {
      nodeData: {
        input: { required: { steps: ["INT", {}], cfg: ["FLOAT", {}] } },
        input_order: { required: ["steps", "cfg"] },
      },
    },
  };
}

test("handler: a REGISTERED node's UNKNOWN widgets are reconciled THEN written", async () => {
  const reg = loadedRegistry(["MyRegNode"]);
  const node = nodeWithUnknownWidgets("MyRegNode");
  // reconcile renames UNKNOWN→steps, UNKNOWN_1→cfg, then the write lands on "cfg".
  const { set } = await setViaHandler(reg, node, "cfg", 7.5);
  assert.deepEqual(node.widgets.map((w) => w.name), ["steps", "cfg"]);
  assert.equal(set.value, 7.5);
});

test("handler: UNREGISTERED placeholder w/ UNKNOWN widgets ⇒ REFUSE, names UNCHANGED (reconcile never ran)", async () => {
  const reg = loadedRegistry(); // reachable, but type not registered
  const node = nodeWithUnknownWidgets("GhostNode");
  await assert.rejects(() => setViaHandler(reg, node, "steps", 5), /not registered|placeholder/i);
  // The load-bearing assertion: reconcile never ran, so the UNKNOWN names stand.
  assert.deepEqual(node.widgets.map((w) => w.name), ["UNKNOWN", "UNKNOWN_1"]);
});

test("handler: TYPE-LESS node w/ UNKNOWN widgets ⇒ REFUSE, names UNCHANGED", async () => {
  const reg = loadedRegistry();
  const node = nodeWithUnknownWidgets(undefined);
  await assert.rejects(() => setViaHandler(reg, node, "steps", 5), /not registered/i);
  assert.deepEqual(node.widgets.map((w) => w.name), ["UNKNOWN", "UNKNOWN_1"]);
});

test("handler: unreachable placeholder w/ UNKNOWN widgets ⇒ REFUSE, names UNCHANGED", async () => {
  const reg = unreachableRegistry();
  const node = nodeWithUnknownWidgets("CheckpointLoaderSimple");
  await assert.rejects(() => setViaHandler(reg, node, "steps", 5), /not loaded|unreachable/i);
  assert.deepEqual(node.widgets.map((w) => w.name), ["UNKNOWN", "UNKNOWN_1"]);
});

test("handler: stale placeholder INSTANCE (registered type, no instance def) ⇒ REFUSE before reconcile", async () => {
  const reg = loadedRegistry(); // KSampler registered WITH nodeData
  const stale = {
    id: 42,
    type: "KSampler",
    widgets: [{ name: "UNKNOWN", type: "number", value: 0 }],
    constructor: { name: "GenericFallback" }, // no nodeData ⇒ unresolved instance
  };
  await assert.rejects(() => setViaHandler(reg, stale, "steps", 5), /unresolved placeholder|live definition is missing/i);
  assert.deepEqual(stale.widgets.map((w) => w.name), ["UNKNOWN"]);
});

test("handler: SUBGRAPH parent ⇒ reconcile SKIPPED (parent's own UNKNOWN widgets untouched), inner write lands", async () => {
  const reg = loadedRegistry();
  const { parent, inner, resolveSource } = makeSubgraphFixture("KSampler");
  // Give the parent its OWN UNKNOWN widgets + a def, so IF reconcile wrongly ran it
  // would rename them — it must not (reconcile is skipped for subgraph parents).
  parent.widgets.push({ name: "UNKNOWN", type: "number", value: 0 });
  parent.constructor = { nodeData: { input: { required: { foo: ["FLOAT", {}] } } } };
  const { set } = await setViaHandler(reg, parent, "sched_alias", "karras", resolveSource);
  assert.equal(set.value, "karras");
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "karras");
  // Parent's own UNKNOWN widget name is untouched — reconcile did not run.
  assert.ok(parent.widgets.some((w) => w.name === "UNKNOWN"));
});
