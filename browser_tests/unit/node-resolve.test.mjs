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
  assertTypeAgainstFreshBackend,
  assertMutatedNodeAuthorized,
  isFrontendOnlyRegisteredType,
  // #496: the ONE shared frontend-only allowlist + the predicates every
  // /object_info-oracle guard decides with.
  FRONTEND_ONLY_NODE_TYPES,
  isAuthorizedFrontendOnlyType,
  isRemovedBackendType,
  HISTORY_UNSEEDED,
  HISTORY_PENDING,
  backendHistoryVerdict,
} from "../../web/js/lib/node-resolve.js";
import { createObjectInfoHistory } from "../../web/js/lib/object-info-history.js";
// The PRODUCTION graph_set_widget handler body — the executor and these tests
// call it verbatim, so the tested ordering IS the shipped ordering (#458).
import { runSetWidget } from "../../web/js/lib/set-widget.js";
// The PRODUCTION combo refresh + the authoritative "server says this combo is empty"
// oracle that gates #507's last-resort acceptance.
import { refreshComboOptionsFromDefs } from "../../web/js/lib/asset-staleness.js";
import { serverDeclaresEmptyComboOptions } from "../../web/js/lib/input-asset.js";

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

// ---- #475: FRONTEND-ONLY nodes (rgthree Fast Bypasser, Note, Reroute) are
//            registered but absent from /object_info and must be WRITABLE, without
//            reopening the #458 removed-type hole ---------------------------------

test("#475: isFrontendOnlyRegisteredType — TRUE for a defless registered class, FALSE for a backend class or an unregistered type", () => {
  // Backend classes carry nodeData (registerNodesFromDefs); a frontend-only class does not.
  const reg = loadedRegistry(["Fast Bypasser (rgthree)"], ["Note", "Reroute"]);
  // KSampler & the extra "Fast Bypasser (rgthree)" went through the WITH-nodeData loop.
  assert.equal(isFrontendOnlyRegisteredType(reg, "KSampler"), false, "a backend class carries nodeData");
  // A genuinely frontend-only / native class (registered WITHOUT nodeData).
  assert.equal(isFrontendOnlyRegisteredType(reg, "Note"), true);
  assert.equal(isFrontendOnlyRegisteredType(reg, "Reroute"), true);
  // Not registered at all ⇒ not frontend-only (it is simply unknown).
  assert.equal(isFrontendOnlyRegisteredType(reg, "NopeNode"), false);
  assert.equal(isFrontendOnlyRegisteredType(null, "Note"), false);
});

test("#475: assertTypeAgainstFreshBackend — a frontend-only registered type ABSENT from object_info is ALLOWED when the registry is supplied", () => {
  const reg = loadedRegistry([], ["Fast Bypasser (rgthree)"]); // defless (frontend-only)
  const fresh = objectInfo(); // does NOT list the rgthree frontend node
  // With the registry passed, the frontend-only type is permitted (no throw).
  assert.doesNotThrow(() =>
    assertTypeAgainstFreshBackend(fresh, "Fast Bypasser (rgthree)", 302, { registry: reg }),
  );
  // WITHOUT the registry (strict backend-only mode), it still fails closed — proving
  // the exemption is opt-in via the registry and never a blanket loosening.
  assert.throws(
    () => assertTypeAgainstFreshBackend(fresh, "Fast Bypasser (rgthree)", 302),
    /backend does not provide/i,
  );
});

test("#475: assertTypeAgainstFreshBackend — the exemption does NOT leak to a REMOVED backend type (stale-positive class WITH nodeData still fails closed)", () => {
  // GoneNode's pack was uninstalled but its registered class survives WITH its old
  // nodeData (tab never reloaded). It is NOT frontend-only, so it stays refused even
  // with the registry supplied — the #458 hole stays closed.
  const reg = loadedRegistry(["GoneNode"]); // WITH nodeData
  const fresh = objectInfo(); // backend no longer lists GoneNode
  assert.throws(
    () => assertTypeAgainstFreshBackend(fresh, "GoneNode", 7, { registry: reg }),
    /backend does not provide/i,
  );
});

test("#475: assertTypeAgainstFreshBackend — object_info UNAVAILABLE (null) fails closed EVEN for a frontend-only type (can't verify at all)", () => {
  const reg = loadedRegistry([], ["Fast Bypasser (rgthree)"]);
  assert.throws(
    () => assertTypeAgainstFreshBackend(null, "Fast Bypasser (rgthree)", 302, { registry: reg }),
    /object_info is unavailable|cannot verify/i,
  );
});

// Register a genuinely frontend-only node (defless class) + a matching live instance.
function frontendOnlyNode(reg, type, widgets) {
  const ctor = function FrontendCtor() {}; // NO nodeData — rgthree/native shape
  reg[type] = ctor;
  return { id: 302, type, widgets, constructor: ctor };
}

test("#475 set_widget: a FRONTEND-ONLY rgthree Fast Bypasser toggle IS writable (the exact repro), not falsely refused", async () => {
  const reg = loadedRegistry();
  const node = frontendOnlyNode(reg, "Fast Bypasser (rgthree)", [
    { name: "Enabled", type: "toggle", value: true },
  ]);
  const { set } = await runSetWidget(node, "Enabled", false, {
    registry: reg,
    getRegistry: () => reg,
    // Backend is UP but does NOT enumerate the rgthree frontend node (by design).
    getFreshObjectInfo: async () => objectInfo(),
    ...HOOKS,
  });
  assert.equal(set.value, false);
  assert.equal(node.widgets[0].value, false, "the frontend-only bypass toggle write took effect");
});

test("#475 set_widget: DISTINCTION — a frontend-only node writes while a REMOVED backend node (same absence from object_info) still FAILS CLOSED", async () => {
  const reg = loadedRegistry(["GoneNode"]); // GoneNode registered WITH nodeData (stale positive)
  const fe = frontendOnlyNode(reg, "Fast Muter (rgthree)", [{ name: "Muted", type: "toggle", value: false }]);
  const fresh = objectInfo(); // lists neither the rgthree node nor GoneNode

  // Frontend-only ⇒ writable.
  const { set } = await runSetWidget(fe, "Muted", true, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => fresh,
    ...HOOKS,
  });
  assert.equal(set.value, true);

  // Removed backend type ⇒ still refused (its stale class carries nodeData).
  const gone = regNode("GoneNode", [{ name: "steps", type: "INT", value: 20 }]);
  await assert.rejects(
    () =>
      runSetWidget(gone, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => fresh,
        ...HOOKS,
      }),
    /backend does not provide/i,
  );
  assert.equal(gone.widgets[0].value, 20, "removed backend node still not mutated");
});

test("#475 set_widget: a frontend-only node with object_info UNAVAILABLE ⇒ FAIL CLOSED (unverifiable), no mutation", async () => {
  const reg = loadedRegistry();
  const node = frontendOnlyNode(reg, "Fast Bypasser (rgthree)", [{ name: "Enabled", type: "toggle", value: true }]);
  await assert.rejects(
    () =>
      runSetWidget(node, "Enabled", false, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null, // backend unreachable
        ...HOOKS,
      }),
    /object_info is unavailable|cannot verify/i,
  );
  assert.equal(node.widgets[0].value, true, "unverifiable ⇒ no write even for a frontend-only type");
});

// ---- #475 P0 (adversarial, #458 fail-closed): absence of nodeData ALONE must NOT
//      authorize a write. A REMOVED backend pack can leave a DEFLESS HUSK registered;
//      it is NOT on the frontend-only allowlist, so it must STILL fail closed. --------

test("#475 P0: isFrontendOnlyRegisteredType — a DEFLESS husk NOT on the allowlist is NOT frontend-only (removed-backend husk stays refused)", () => {
  // A removed backend pack's frontend registration left a bare (defless) class named
  // "RemovedBackendNode". It is defless AND registered — but NOT allowlisted, so it is
  // NOT treated as frontend-only. Only genuinely-known frontend types are.
  const reg = loadedRegistry([], ["RemovedBackendNode", "Note"]);
  assert.equal(isFrontendOnlyRegisteredType(reg, "RemovedBackendNode"), false, "defless husk is NOT frontend-only without a positive allowlist marker");
  assert.equal(isFrontendOnlyRegisteredType(reg, "Note"), true, "an allowlisted native IS frontend-only");
});

test("#475 P0: assertTypeAgainstFreshBackend — a DEFLESS husk absent from object_info STILL fails closed (allowlist is the positive marker, not nodeData-absence)", () => {
  const reg = loadedRegistry([], ["RemovedBackendNode"]); // registered, defless, NOT allowlisted
  const fresh = objectInfo(); // backend no longer provides it
  assert.throws(
    () => assertTypeAgainstFreshBackend(fresh, "RemovedBackendNode", 9, { registry: reg }),
    /backend does not provide/i,
    "a defless husk must not be exempted merely for lacking nodeData (#458)",
  );
});

test("#475 P0 set_widget: a REMOVED backend node left as a DEFLESS HUSK ⇒ FAIL CLOSED (no fabricated success)", async () => {
  // The exact adversarial #458 case the naive `!nodeData` exemption reopened: the pack
  // was uninstalled but its frontend registration survives as a bare defless class, and
  // a live node of that type sits on the canvas. object_info no longer lists it. The
  // write MUST be refused, not authorized+reported as success.
  const reg = loadedRegistry();
  const ctor = function DeflessHusk() {}; // NO nodeData — but also NOT allowlisted
  reg["RemovedBackendNode"] = ctor;
  const node = { id: 405, type: "RemovedBackendNode", widgets: [{ name: "steps", type: "INT", value: 20 }], constructor: ctor };
  await assert.rejects(
    () =>
      runSetWidget(node, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // backend does NOT provide it
        ...HOOKS,
      }),
    (err) => err instanceof Error && /backend does not provide/i.test(err.message),
  );
  assert.equal(node.widgets[0].value, 20, "a removed-backend defless husk is never mutated (#458 stays closed)");
});

test("#475 P0 provenance: an ALLOWLISTED name whose class carries BACKEND provenance (comfyClass, even with no nodeData) is NOT frontend-only (name-collision husk stays refused)", () => {
  // Codex-adversarial: a removed backend pack that used a reserved allowlisted name
  // (e.g. "MarkdownNote") and left a class WITHOUT nodeData but still bearing the
  // registerNodesFromDefs `.comfyClass` marker must NOT be exempted by name alone.
  const reg = loadedRegistry();
  const husk = function MarkdownNoteHusk() {};
  husk.comfyClass = "MarkdownNote"; // backend-registration provenance (no nodeData)
  reg["MarkdownNote"] = husk;
  assert.equal(
    isFrontendOnlyRegisteredType(reg, "MarkdownNote"),
    false,
    "a backend-provenance class is not frontend-only even under an allowlisted name",
  );
  // And end-to-end: the write is refused, not fabricated as success.
  const node = { id: 406, type: "MarkdownNote", widgets: [{ name: "text", type: "string", value: "x" }], constructor: husk };
  return assert.rejects(
    () =>
      runSetWidget(node, "text", "y", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // backend does not provide MarkdownNote
        beforeChange() {},
        afterChange() {},
        setDirty() {},
      }),
    /backend does not provide/i,
  );
});

test("#475 P0 instance-provenance: a STALE BACKEND INSTANCE under an allowlisted name (bare registry class, but the INSTANCE constructor carries a backend def) ⇒ FAIL CLOSED", async () => {
  // Codex round-3 path: the registry entry for "MarkdownNote" is a bare native class
  // (passes the registry-class check), but the actual write-target NODE was created from
  // a backend def and its OWN constructor still carries nodeData/comfyClass. That is a
  // removed backend node, not a frontend-only one — the instance-provenance gate refuses
  // it even though the registry class looks frontend-only.
  const reg = loadedRegistry();
  reg["MarkdownNote"] = function BareNative() {}; // bare registry class (looks frontend-only)
  const backendCtor = function MarkdownNoteBackend() {};
  backendCtor.nodeData = { input: { required: {} } }; // INSTANCE carries backend provenance
  const node = {
    id: 407,
    type: "MarkdownNote",
    widgets: [{ name: "text", type: "string", value: "x" }],
    constructor: backendCtor,
  };
  await assert.rejects(
    () =>
      runSetWidget(node, "text", "y", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // backend does NOT provide MarkdownNote
        ...HOOKS,
      }),
    (err) => err instanceof Error && /backend does not provide/i.test(err.message),
  );
  assert.equal(node.widgets[0].value, "x", "a stale backend instance is never mutated (#458 stays closed)");
});

test("#475 instance-provenance: a GENUINE frontend-only node (bare instance constructor === bare registry class) is STILL writable", async () => {
  // Guard against over-refusal: a real frontend node's instance constructor IS the bare
  // registered class, so the instance-provenance gate passes and the write proceeds.
  const reg = loadedRegistry();
  const ctor = function FastBypasser() {}; // bare — no nodeData/comfyClass
  reg["Fast Bypasser (rgthree)"] = ctor;
  const node = { id: 408, type: "Fast Bypasser (rgthree)", widgets: [{ name: "Enabled", type: "toggle", value: true }], constructor: ctor };
  const { set } = await runSetWidget(node, "Enabled", false, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(),
    ...HOOKS,
  });
  assert.equal(set.value, false);
  assert.equal(node.widgets[0].value, false);
});

// ---- #458 OBSERVED-BACKEND-HISTORY (ever-seen) gate: the non-forgeable trust root.
//      A type ABSENT from CURRENT object_info that was EVER seen this session = a
//      REMOVED backend node ⇒ REFUSE; a NEVER-seen type = genuinely frontend-only. -----

test("#458 EVER-SEEN: an ALLOWLISTED-name PURE-JS husk (provenance-clean) that was EVER in object_info ⇒ REFUSED (the case client shape/name/provenance cannot catch)", async () => {
  // Codex P0: a backend pack can register a bare frontend class for a reserved
  // allowlisted type (e.g. MarkdownNote) with NO nodeData/comfyClass. After its backend
  // def disappears it passes allowlist + class + instance provenance. The ever-seen gate
  // is exactly what refuses it: the backend reported "MarkdownNote" earlier this session.
  const reg = loadedRegistry();
  const bare = function BareMarkdownNote() {}; // provenance-clean, allowlisted name
  reg["MarkdownNote"] = bare;
  const node = { id: 501, type: "MarkdownNote", widgets: [{ name: "text", type: "string", value: "x" }], constructor: bare };
  const everSeen = new Set(["MarkdownNote"]); // backend reported it earlier this session
  await assert.rejects(
    () =>
      runSetWidget(node, "text", "y", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // CURRENT object_info lacks MarkdownNote
        wasTypeEverDefined: (t) => everSeen.has(t),
        ...HOOKS,
      }),
    (err) => err instanceof Error && /was defined by the ComfyUI backend earlier this session|since-removed/i.test(err.message),
  );
  assert.equal(node.widgets[0].value, "x", "a since-removed allowlisted-name husk is never mutated (#458)");
});

test("#458 EVER-SEEN: a GENUINE native allowlisted type that was NEVER in object_info ⇒ ALLOWED (frontend-only)", async () => {
  const reg = loadedRegistry();
  const bare = function BareMarkdownNote() {};
  reg["MarkdownNote"] = bare;
  const node = { id: 502, type: "MarkdownNote", widgets: [{ name: "text", type: "string", value: "x" }], constructor: bare };
  const everSeen = new Set(); // never reported by the backend this session
  const { set } = await runSetWidget(node, "text", "y", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(),
    wasTypeEverDefined: (t) => everSeen.has(t),
    ...HOOKS,
  });
  assert.equal(set.value, "y");
  assert.equal(node.widgets[0].value, "y", "a genuinely-never-seen native/frontend node is writable");
});

test("#458 EVER-SEEN: a frontend-only rgthree node NEVER in object_info ⇒ still ALLOWED with the gate wired", async () => {
  const reg = loadedRegistry();
  const ctor = function FastBypasser() {};
  reg["Fast Bypasser (rgthree)"] = ctor;
  const node = { id: 503, type: "Fast Bypasser (rgthree)", widgets: [{ name: "Enabled", type: "toggle", value: true }], constructor: ctor };
  const { set } = await runSetWidget(node, "Enabled", false, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(),
    wasTypeEverDefined: () => false, // rgthree control nodes are never in /object_info
    ...HOOKS,
  });
  assert.equal(set.value, false);
});

// ---- #496: ONE shared frontend-only allowlist across the WHOLE /object_info-oracle
//      guard family. The set_widget guards exempted genuine frontend-only types
//      (Note/MarkdownNote/Reroute/…); assertAddNodeResolvableRefreshing did NOT, so a
//      MarkdownNote was writable but not ADDABLE on a perfectly healthy backend — the
//      exact drift #496 reports. All three now decide via isAuthorizedFrontendOnlyType.
//      These lock BOTH halves: the frontend-only types succeed, and every
//      graph-corruption case the guards reject today is still rejected. ---------------

// A live registry in which the frontend-only natives are registered by LiteGraph
// (defless / provenance-clean), exactly as ComfyUI's frontend registers them.
function registryWithNatives(natives = ["Note", "MarkdownNote", "Reroute", "PrimitiveNode"]) {
  return loadedRegistry([], natives);
}
const ADD_OPTS = (fresh, wasTypeEverDefined = () => false) => ({
  getFreshObjectInfo: async () => fresh,
  refresh: async () => {},
  wasTypeEverDefined,
});

test("#496 add_node: frontend-only natives (Note/MarkdownNote/Reroute/PrimitiveNode) are ADDABLE on a healthy backend that does not list them", async () => {
  const reg = registryWithNatives();
  const fresh = objectInfo(); // healthy backend — genuinely never lists these types
  for (const t of ["Note", "MarkdownNote", "Reroute", "PrimitiveNode"]) {
    await assert.doesNotReject(
      () => assertAddNodeResolvableRefreshing(() => reg, t, ADD_OPTS(fresh)),
      `#496: "${t}" is frontend-only and must be addable`,
    );
  }
  // The rgthree frontend control nodes are on the same shared allowlist.
  const reg2 = loadedRegistry([], ["Fast Bypasser (rgthree)"]);
  await assert.doesNotReject(() =>
    assertAddNodeResolvableRefreshing(() => reg2, "Fast Bypasser (rgthree)", ADD_OPTS(fresh)),
  );
});

test("#496 add_node: a genuinely INVALID target still fails closed (unknown type, defless husk, provenance-bearing allowlisted name)", async () => {
  const fresh = objectInfo();
  // (a) never installed / typo — not on the allowlist.
  const reg = registryWithNatives();
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg, "TotallyMadeUpNode", ADD_OPTS(fresh)),
    /Unknown node type|does not provide/i,
  );
  // (b) a REMOVED pack that left a DEFLESS husk registered: defless is NOT the signal —
  //     it is not on the allowlist, so it stays refused (the #458 hole stays closed).
  const reg2 = loadedRegistry([], ["RemovedBackendNode"]);
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg2, "RemovedBackendNode", ADD_OPTS(fresh)),
    /Unknown node type|does not provide/i,
  );
  // (c) a class squatting an ALLOWLISTED name but carrying backend provenance
  //     (nodeData/comfyClass) is NOT frontend-only — refuse.
  const reg3 = loadedRegistry(["MarkdownNote"]); // registered WITH nodeData
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg3, "MarkdownNote", ADD_OPTS(fresh)),
    /Unknown node type|does not provide/i,
  );
  // (d) an allowlisted name that is NOT registered in the live registry at all — the
  //     exemption requires registry membership (which is also what createNode needs).
  const reg4 = loadedRegistry();
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg4, "MarkdownNote", ADD_OPTS(fresh)),
    /Unknown node type|does not provide/i,
  );
});

test("#496 add_node: the EVER-SEEN gate still wins — an allowlisted name whose backend was REMOVED this session fails closed", async () => {
  // A pack registered a backend node literally named "MarkdownNote" and was then
  // uninstalled, leaving a provenance-clean husk. The observed-backend-history trust
  // root refuses it: a client husk cannot un-see what the backend already reported.
  const reg = registryWithNatives();
  const fresh = objectInfo(); // current object_info no longer lists it
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(
        () => reg,
        "MarkdownNote",
        ADD_OPTS(fresh, (t) => t === "MarkdownNote"),
      ),
    /defined this node type earlier this session|removed/i,
  );
  // …and the gate does NOT over-reach: a sibling native never reported stays addable.
  await assert.doesNotReject(() =>
    assertAddNodeResolvableRefreshing(() => reg, "Note", ADD_OPTS(fresh, (t) => t === "MarkdownNote")),
  );
});

test("#496 add_node: object_info UNAVAILABLE still fails closed, even for a frontend-only type", async () => {
  // The exemption is scoped to "object_info WAS fetched but lacks the type". An
  // unverifiable backend must never authorize anything (#458).
  const reg = registryWithNatives();
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(() => reg, "MarkdownNote", {
        getFreshObjectInfo: async () => null,
        refresh: async () => {},
        wasTypeEverDefined: () => false,
      }),
    /cannot verify|object_info is unavailable/i,
  );
});

test("#496 set_widget: MarkdownNote's text widget is writable end-to-end (the reported repro)", async () => {
  const reg = registryWithNatives();
  const node = {
    id: 11,
    type: "MarkdownNote",
    widgets: [{ name: "text", type: "string", value: "" }],
    constructor: reg["MarkdownNote"],
  };
  const { set } = await runSetWidget(node, "text", "# README", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(), // healthy backend, no MarkdownNote
    wasTypeEverDefined: () => false,
    ...HOOKS,
  });
  assert.equal(set.value, "# README");
  assert.equal(node.widgets[0].value, "# README");
});

// The three guards whose oracle is /object_info. Each is reduced to a boolean
// "would this LEAF node type be authorized?" so they can be compared directly.
// (Container-shaped nodes are excluded on purpose: assertMutatedNodeAuthorized has an
// ADDITIONAL virtual-subgraph-container branch the other two must not have, so parity
// is asserted over LEAF nodes, where the frontend-only allowlist is the only exemption.)
function guardVerdicts(reg, fresh, type, node, wasTypeEverDefined = () => false) {
  const ok = async (fn) => {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  };
  return Promise.all([
    ok(() => assertAddNodeResolvableRefreshing(() => reg, type, ADD_OPTS(fresh, wasTypeEverDefined))),
    ok(() => assertTypeAgainstFreshBackend(fresh, type, node?.id, { registry: reg, node, wasTypeEverDefined })),
    ok(() => assertMutatedNodeAuthorized(fresh, reg, node, "target", wasTypeEverDefined)),
  ]);
}

test("#496 PARITY: all three /object_info-oracle guards reach the SAME verdict for the same leaf node type", async () => {
  const fresh = objectInfo();
  const leaf = (type, ctor) => ({
    id: 42,
    type,
    widgets: [{ name: "text", type: "string", value: "" }],
    constructor: ctor,
  });
  const natives = registryWithNatives();
  const husk = loadedRegistry([], ["RemovedBackendNode"]);
  const squat = loadedRegistry(["MarkdownNote"]); // allowlisted NAME, backend provenance
  const cases = [
    // [label, registry, type, expected verdict, wasTypeEverDefined]
    ["MarkdownNote (frontend-only)", natives, "MarkdownNote", true, () => false],
    ["Note (frontend-only)", natives, "Note", true, () => false],
    ["Reroute (frontend-only)", natives, "Reroute", true, () => false],
    ["KSampler (live backend node)", natives, "KSampler", true, () => false],
    ["TotallyMadeUpNode (unknown)", natives, "TotallyMadeUpNode", false, () => false],
    ["RemovedBackendNode (defless husk, not allowlisted)", husk, "RemovedBackendNode", false, () => false],
    ["MarkdownNote (squatted, backend provenance)", squat, "MarkdownNote", false, () => false],
    ["MarkdownNote (backend REMOVED this session)", natives, "MarkdownNote", false, (t) => t === "MarkdownNote"],
  ];
  for (const [label, reg, type, expected, everSeen] of cases) {
    const [add, freshAuth, mutated] = await guardVerdicts(reg, fresh, type, leaf(type, reg[type]), everSeen);
    assert.deepEqual(
      { add, freshAuth, mutated },
      { add: expected, freshAuth: expected, mutated: expected },
      `#496 guard drift on ${label}: all three guards must agree (expected ${expected})`,
    );
  }
});

test("#496 SINGLE SOURCE OF TRUTH: all three guards read the SAME allowlist Set (no second copy)", async () => {
  // Mutating the ONE exported allowlist must move all three guards together. If a guard
  // ever hard-codes its own copy of the list, its verdict stops tracking this Set and
  // this test fails — which is precisely the regression #496 was.
  const SYNTHETIC = "ZZFrontendOnlyProbe (test)";
  const reg = loadedRegistry([], [SYNTHETIC]);
  const fresh = objectInfo();
  const node = {
    id: 77,
    type: SYNTHETIC,
    widgets: [{ name: "text", type: "string", value: "" }],
    constructor: reg[SYNTHETIC],
  };
  // Not on the allowlist yet ⇒ every guard refuses.
  assert.deepEqual(
    await guardVerdicts(reg, fresh, SYNTHETIC, node),
    [false, false, false],
    "a defless, non-allowlisted type must be refused by all three guards",
  );
  FRONTEND_ONLY_NODE_TYPES.add(SYNTHETIC);
  try {
    assert.deepEqual(
      await guardVerdicts(reg, fresh, SYNTHETIC, node),
      [true, true, true],
      "adding to the ONE allowlist must authorize all three guards — they share it",
    );
    assert.equal(isAuthorizedFrontendOnlyType(reg, SYNTHETIC, node), true);
  } finally {
    FRONTEND_ONLY_NODE_TYPES.delete(SYNTHETIC);
  }
  // Removed again ⇒ back to refused everywhere (no guard cached the membership).
  assert.deepEqual(await guardVerdicts(reg, fresh, SYNTHETIC, node), [false, false, false]);
});

test("#496 add_node (codex SEVERE): the frontend-only exemption REQUIRES the ever-seen oracle — without it, nothing absent from object_info is exempted", async () => {
  // Client-side name + provenance markers are FORGEABLE: a removed pack whose frontend
  // class had .nodeData/.comfyClass stripped and which squats a reserved allowlisted
  // name is indistinguishable from a genuine native by those signals alone. Only the
  // non-forgeable observed-backend-history gate can rule it out, so with NO history
  // oracle wired there is no exemption at all — pre-#496 fail-closed behaviour.
  const reg = registryWithNatives();
  const fresh = objectInfo();
  for (const t of ["Note", "MarkdownNote", "Reroute", "PrimitiveNode"]) {
    await assert.rejects(
      () =>
        assertAddNodeResolvableRefreshing(() => reg, t, {
          getFreshObjectInfo: async () => fresh,
          refresh: async () => {},
          // wasTypeEverDefined deliberately OMITTED
        }),
      /Unknown node type|does not provide/i,
      `#496: "${t}" must NOT be exempted without the observed-backend-history oracle`,
    );
  }
  // Wiring the oracle (and only then) enables the exemption.
  await assert.doesNotReject(() =>
    assertAddNodeResolvableRefreshing(() => reg, "MarkdownNote", ADD_OPTS(fresh)),
  );
});

test("#496: isRemovedBackendType — the shared ever-seen gate is inert without an injected oracle and never guesses", () => {
  assert.equal(isRemovedBackendType("KSampler", () => true), true);
  assert.equal(isRemovedBackendType("KSampler", () => false), false);
  assert.equal(isRemovedBackendType("KSampler", undefined), false, "no oracle wired ⇒ no removal claim");
  assert.equal(isRemovedBackendType(undefined, () => true), false, "a non-string type is never 'removed'");
});

// ---- #507 END-TO-END through the PRODUCTION graph_set_widget body: a dynamic
//      client-populated combo (empty server option list) must become writable, and the
//      empty-list acceptance must be the LAST resort — the authoritative /object_info
//      refresh gets first refusal, so a merely-STALE empty list is refreshed and then
//      validated strictly. ------------------------------------------------------------

// StarNodes' StarOllamaPromptHelper: `"model": ((), {...})` ⇒ /object_info reports
// `[[], {...}]`, and the node's own "Refresh Models" button fills the dropdown.
function starNodesFixture(liveOptions = []) {
  const reg = loadedRegistry(["StarOllamaPromptHelper"]);
  const widget = { name: "model", type: "combo", options: { values: liveOptions }, value: "" };
  const node = { id: 9, type: "StarOllamaPromptHelper", widgets: [widget], constructor: reg["StarOllamaPromptHelper"] };
  return { reg, node, widget };
}
// /object_info in which StarOllamaPromptHelper's `model` input carries `serverOptions`.
function starObjectInfo(serverOptions = []) {
  const info = objectInfo();
  info["StarOllamaPromptHelper"] = { input: { required: { model: [serverOptions, {}] } } };
  return info;
}
// The PRODUCTION combo refresh (the same function the panel injects as refreshCombos),
// so these tests inherit its real semantics — notably that it deliberately NEVER clobbers
// a dynamic (function) option source. A hand-rolled stand-in that overwrote functions
// would hide exactly the path codex round-2 flagged.
const refreshFromServer = (fresh, targetNode, defTypeKey, nameMap) =>
  refreshComboOptionsFromDefs(targetNode, fresh, defTypeKey, nameMap);

test("#507 e2e: a combo whose SERVER option list is empty becomes writable (the StarNodes repro)", async () => {
  const { reg, node, widget } = starNodesFixture([]);
  const res = await runSetWidget(node, "model", "qwen3-vl:8b", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => starObjectInfo([]), // server publishes ZERO options
    wasTypeEverDefined: () => true, // a real backend node, present in object_info
    refreshCombos: refreshFromServer,
    ...HOOKS,
  });
  assert.equal(res.set.value, "qwen3-vl:8b");
  assert.equal(widget.value, "qwen3-vl:8b");
  assert.equal(res.empty_option_list, true, "reported honestly as an unvalidatable empty list");
});

test("#507 e2e: a merely-STALE empty list is REFRESHED first, then validated STRICTLY (not blindly accepted)", async () => {
  // The live widget is empty only because the frontend combo snapshot is stale; the
  // SERVER does publish a real list. The refresh must run and decide — a member is
  // accepted through the normal path (no empty-list fallback), a NON-member is refused.
  const ok = starNodesFixture([]);
  const res = await runSetWidget(ok.node, "model", "llama3.2:3b", {
    registry: ok.reg,
    getRegistry: () => ok.reg,
    getFreshObjectInfo: async () => starObjectInfo(["qwen3-vl:8b", "llama3.2:3b"]),
    wasTypeEverDefined: () => true,
    refreshCombos: refreshFromServer,
    ...HOOKS,
  });
  assert.equal(res.set.value, "llama3.2:3b");
  assert.equal(res.refreshed, true, "the authoritative refresh is what accepted it");
  assert.equal(res.empty_option_list, undefined, "NOT the empty-list path — a real list existed");

  const bad = starNodesFixture([]);
  await assert.rejects(
    () =>
      runSetWidget(bad.node, "model", "not-installed:70b", {
        registry: bad.reg,
        getRegistry: () => bad.reg,
        getFreshObjectInfo: async () => starObjectInfo(["qwen3-vl:8b", "llama3.2:3b"]),
        wasTypeEverDefined: () => true,
        refreshCombos: refreshFromServer,
        ...HOOKS,
      }),
    /not a valid option/i,
    "#240: once the server publishes a real list, an off-list value is still refused",
  );
  assert.equal(bad.widget.value, "", "must not have mutated on reject");
});

test("#507 e2e: an object value into an empty combo still fails closed (no fabricated success)", async () => {
  const { reg, node, widget } = starNodesFixture([]);
  await assert.rejects(
    () =>
      runSetWidget(node, "model", { model: "qwen3-vl:8b" }, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => starObjectInfo([]),
        wasTypeEverDefined: () => true,
        refreshCombos: refreshFromServer,
        ...HOOKS,
      }),
    /refused|only a scalar/i,
  );
  assert.equal(widget.value, "", "must not have mutated on reject");
});

test("#507 e2e: the empty-list fallback does NOT bypass the #458 type authorization", async () => {
  // A since-REMOVED backend node that happens to expose an empty combo must still be
  // refused BEFORE any write — the empty-list path is inside the write, downstream of
  // the fresh-backend gate, and must not become a way around it.
  const { reg, node, widget } = starNodesFixture([]);
  await assert.rejects(
    () =>
      runSetWidget(node, "model", "qwen3-vl:8b", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // backend no longer provides the type
        wasTypeEverDefined: (t) => t === "StarOllamaPromptHelper", // …but it did earlier
        refreshCombos: refreshFromServer,
        ...HOOKS,
      }),
    /removed|since-removed/i,
  );
  assert.equal(widget.value, "", "no write behind a refused authorization");
});

// ---- #507 codex round-2 (SEVERE): the last-resort acceptance is gated on the SERVER
//      declaring the option list empty, never on the LIVE widget alone. -----------------

test("#507 SEVERE: a DYNAMIC (function) source returning [] while the SERVER publishes a real list is still REFUSED", () => {
  // The exact fail-open codex found: refreshComboOptionsFromDefs deliberately never
  // clobbers a function option source, so a dynamic combo that currently returns []
  // stays "empty" through the refresh. If the empty-list fallback keyed on the LIVE
  // widget it would then write an OFF-LIST value against a real server list (#240).
  const reg = loadedRegistry(["StarOllamaPromptHelper"]);
  const widget = { name: "model", type: "combo", options: { values: () => [] }, value: "" };
  const node = { id: 9, type: "StarOllamaPromptHelper", widgets: [widget], constructor: reg["StarOllamaPromptHelper"] };
  const fresh = starObjectInfo(["allowed:1b"]); // the SERVER does publish a list
  // Precondition: the production refresh leaves a function source alone.
  refreshComboOptionsFromDefs(node, fresh, "StarOllamaPromptHelper");
  assert.equal(typeof widget.options.values, "function", "production refresh must not clobber a dynamic source");
  // And the authoritative oracle correctly says the server list is NOT empty.
  assert.equal(serverDeclaresEmptyComboOptions(fresh, "StarOllamaPromptHelper", "model"), false);
  return assert.rejects(
    () =>
      runSetWidget(node, "model", "off-list:70b", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => fresh,
        wasTypeEverDefined: () => true,
        refreshCombos: refreshFromServer,
        ...HOOKS,
      }),
    /not a valid option|EMPTY option list/i,
  ).then(() => {
    assert.equal(widget.value, "", "must not have mutated — the server list is real");
  });
});

test("#507: a dynamic source returning [] AND a server-declared empty list DOES write", () => {
  // The legitimate StarNodes shape, dynamic-source variant: both the live source and
  // /object_info agree there is nothing to validate against.
  const reg = loadedRegistry(["StarOllamaPromptHelper"]);
  const widget = { name: "model", type: "combo", options: { values: () => [] }, value: "" };
  const node = { id: 9, type: "StarOllamaPromptHelper", widgets: [widget], constructor: reg["StarOllamaPromptHelper"] };
  return runSetWidget(node, "model", "qwen3-vl:8b", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => starObjectInfo([]),
    wasTypeEverDefined: () => true,
    refreshCombos: refreshFromServer,
    ...HOOKS,
  }).then((res) => {
    assert.equal(res.set.value, "qwen3-vl:8b");
    assert.equal(res.empty_option_list, true);
  });
});

test("#507: with NO server def for the type (or a non-combo input), the empty list is NOT accepted", async () => {
  const reg = loadedRegistry(["StarOllamaPromptHelper"]);
  // (a) the type IS in object_info but declares `model` as a plain STRING input.
  const stringInput = objectInfo();
  stringInput["StarOllamaPromptHelper"] = { input: { required: { model: ["STRING", {}] } } };
  const a = starNodesFixture([]);
  await assert.rejects(
    () =>
      runSetWidget(a.node, "model", "qwen3-vl:8b", {
        registry: a.reg,
        getRegistry: () => a.reg,
        getFreshObjectInfo: async () => stringInput,
        wasTypeEverDefined: () => true,
        refreshCombos: refreshFromServer,
        ...HOOKS,
      }),
    /EMPTY option list|refused/i,
  );
  assert.equal(a.widget.value, "", "no write without an authoritative empty-combo declaration");
  // (b) the def exists but has no such input at all.
  const noInput = objectInfo();
  noInput["StarOllamaPromptHelper"] = { input: { required: {} } };
  const b = starNodesFixture([]);
  await assert.rejects(
    () =>
      runSetWidget(b.node, "model", "qwen3-vl:8b", {
        registry: b.reg,
        getRegistry: () => b.reg,
        getFreshObjectInfo: async () => noInput,
        wasTypeEverDefined: () => true,
        refreshCombos: refreshFromServer,
        ...HOOKS,
      }),
    /EMPTY option list|refused/i,
  );
  assert.equal(b.widget.value, "");
  void reg;
});

test("#507: serverDeclaresEmptyComboOptions — TRUE only for an explicitly EMPTY declared combo list", () => {
  const defs = {
    T: {
      input: {
        required: { empty: [[], {}], full: [["a"], {}], str: ["STRING", {}] },
        optional: { optEmpty: [[], {}] },
      },
    },
  };
  assert.equal(serverDeclaresEmptyComboOptions(defs, "T", "empty"), true);
  assert.equal(serverDeclaresEmptyComboOptions(defs, "T", "optEmpty"), true, "optional inputs count too");
  assert.equal(serverDeclaresEmptyComboOptions(defs, "T", "full"), false);
  assert.equal(serverDeclaresEmptyComboOptions(defs, "T", "str"), false);
  assert.equal(serverDeclaresEmptyComboOptions(defs, "T", "nope"), false);
  assert.equal(serverDeclaresEmptyComboOptions(defs, "Missing", "empty"), false);
  assert.equal(serverDeclaresEmptyComboOptions(null, "T", "empty"), false);
  assert.equal(serverDeclaresEmptyComboOptions(defs, "T", undefined), false);
});

test("#507 codex round-2 (MODERATE): a real failure on the FINAL attempt propagates, not the earlier combo rejection", async () => {
  // The empty-list attempt is a genuine write. If it fails for a REAL reason (here the
  // value does not stick), that error must surface — it must not be swallowed and
  // replaced by the stale "EMPTY option list" rejection.
  const reg = loadedRegistry(["StarOllamaPromptHelper"]);
  const widget = Object.defineProperty(
    { name: "model", type: "combo", options: { values: [] } },
    "value",
    { get: () => "frozen", set: () => {}, enumerable: true, configurable: true },
  );
  const node = { id: 9, type: "StarOllamaPromptHelper", widgets: [widget], constructor: reg["StarOllamaPromptHelper"] };
  await assert.rejects(
    () =>
      runSetWidget(node, "model", "qwen3-vl:8b", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => starObjectInfo([]),
        wasTypeEverDefined: () => true,
        refreshCombos: refreshFromServer,
        ...HOOKS,
      }),
    /did not retain the requested value/i,
  );
});

// ---- #496 / #458: an UNSEEDED history must refuse with an HONEST diagnosis. Previously
//      every refusal in that state claimed "its backend was removed (pack uninstalled)",
//      which for a MarkdownNote is false and misdiagnoses a transient backend problem as
//      a broken install — the same misleading-error complaint #496 was filed about. -----

// The oracle the panel injects when it has no trustworthy baseline.
const NO_BASELINE = () => HISTORY_UNSEEDED;

test("#496: all three guards refuse an unseeded history with a RELOAD-THE-TAB diagnosis, never a false 'pack removed'", async () => {
  const reg = registryWithNatives();
  const fresh = objectInfo();
  const node = { id: 11, type: "MarkdownNote", widgets: [{ name: "text", type: "string", value: "" }], constructor: reg["MarkdownNote"] };
  const honest = /no trustworthy record|Reload the ComfyUI tab/i;
  const falseClaim = /pack uninstalled|its backend was removed/i;

  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg, "MarkdownNote", ADD_OPTS(fresh, NO_BASELINE)),
    (err) => honest.test(err.message) && !falseClaim.test(err.message),
  );
  assert.throws(
    () => assertTypeAgainstFreshBackend(fresh, "MarkdownNote", 11, { registry: reg, node, wasTypeEverDefined: NO_BASELINE }),
    (err) => honest.test(err.message) && !falseClaim.test(err.message),
  );
  assert.throws(
    () => assertMutatedNodeAuthorized(fresh, reg, node, "target", NO_BASELINE),
    (err) => honest.test(err.message) && !falseClaim.test(err.message),
  );
});

test("#496: the unseeded sentinel still FAILS CLOSED — it is truthy and never authorizes", async () => {
  const reg = registryWithNatives();
  const fresh = objectInfo();
  const node = { id: 11, type: "MarkdownNote", widgets: [{ name: "text", type: "string", value: "" }], constructor: reg["MarkdownNote"] };
  // The SAME fixture succeeds with a real baseline — only the oracle differs, so the
  // refusal below is attributable to the missing baseline and nothing else.
  await assert.doesNotReject(() => assertAddNodeResolvableRefreshing(() => reg, "MarkdownNote", ADD_OPTS(fresh)));
  assert.doesNotThrow(() =>
    assertTypeAgainstFreshBackend(fresh, "MarkdownNote", 11, { registry: reg, node, wasTypeEverDefined: () => false }),
  );
  await assert.rejects(
    () =>
      runSetWidget(node, "text", "# README", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => fresh,
        wasTypeEverDefined: NO_BASELINE,
        ...HOOKS,
      }),
    /no trustworthy record|Reload the ComfyUI tab/i,
  );
  assert.equal(node.widgets[0].value, "", "no write without a baseline");
});

test("#496: a REAL removed pack still gets the removed-pack diagnosis (the honest message did not replace it)", () => {
  const reg = registryWithNatives();
  const fresh = objectInfo();
  const node = { id: 11, type: "MarkdownNote", widgets: [{ name: "text", type: "string", value: "" }], constructor: reg["MarkdownNote"] };
  assert.throws(
    () =>
      assertTypeAgainstFreshBackend(fresh, "MarkdownNote", 11, {
        registry: reg,
        node,
        wasTypeEverDefined: (t) => t === "MarkdownNote", // a genuine ever-seen positive
      }),
    /its backend was removed|pack uninstalled/i,
  );
});

test("#496: backendHistoryVerdict — the one classifier all three guards share", () => {
  assert.equal(backendHistoryVerdict("X", () => HISTORY_UNSEEDED), "unseeded");
  assert.equal(backendHistoryVerdict("X", () => true), "removed");
  assert.equal(backendHistoryVerdict("X", () => false), "never-seen");
  assert.equal(backendHistoryVerdict("X", undefined), "no-oracle", "no oracle wired");
  assert.equal(backendHistoryVerdict(undefined, () => true), "no-oracle", "a non-string type");
  // isRemovedBackendType is the NARROW "REMOVED" claim only — an unseeded history is a
  // refusal, but it is not a claim that the pack was removed.
  assert.equal(isRemovedBackendType("X", () => HISTORY_UNSEEDED), false);
  assert.equal(isRemovedBackendType("X", () => true), true);
});

// ---- #496 REGRESSION (coordinator review): a merely SLOW /object_info must not burn the
//      session. A caller's bounded wait can expire while the fetch is still in flight;
//      that is the ABSENCE of evidence, not evidence, so it yields a TEMPORARY refusal
//      and a late-arriving seed restores normal operation with no tab reload. Latching
//      there would make ordinary latency a permanent false refusal — the same bug class
//      as #496 and #507 themselves. -----------------------------------------------------

test("#496 REGRESSION: a seed that resolves AFTER the bound ⇒ the next MarkdownNote add SUCCEEDS", async () => {
  // Drives the REAL history object through the real guard, so the state machine and the
  // guard's reading of it are exercised together.
  const history = createObjectInfoHistory();
  const reg = registryWithNatives();
  const fresh = objectInfo(); // healthy backend; never lists MarkdownNote (by design)
  const opts = ADD_OPTS(fresh, (t) => history.wasTypeEverDefined(t));

  // t = 0..bound — the startup getNodeDefs() is still in flight and the tool gave up
  // waiting. Refused, but TEMPORARILY: the message must say "retry in a moment" and must
  // NOT blame a removed pack or tell the user to reload.
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg, "MarkdownNote", opts),
    (err) =>
      /still loading|retry in a moment/i.test(err.message) &&
      !/pack uninstalled|its backend was removed/i.test(err.message) &&
      !/Reload the ComfyUI tab/i.test(err.message),
  );
  assert.equal(history.baselineLost, false, "a bounded wait must not latch the session");

  // t = bound+ε — the slow response lands and seeds the baseline (this is what
  // seedObjectInfoHistory does when its in-flight fetch finally returns).
  history.recordTypes(fresh);
  assert.equal(history.markSeeded(), true);

  // The very SAME add now succeeds. No tab reload, nothing burned.
  await assert.doesNotReject(
    () => assertAddNodeResolvableRefreshing(() => reg, "MarkdownNote", opts),
    "a late seed must restore normal operation",
  );
  // …and so does the write path, on the same recovered baseline.
  const node = { id: 11, type: "MarkdownNote", widgets: [{ name: "text", type: "string", value: "" }], constructor: reg["MarkdownNote"] };
  const { set } = await runSetWidget(node, "text", "# README", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => fresh,
    wasTypeEverDefined: (t) => history.wasTypeEverDefined(t),
    ...HOOKS,
  });
  assert.equal(set.value, "# README");
  // The recovered baseline is a REAL one, not a blanket allow: a type it DID observe is
  // still refused once it disappears from /object_info.
  const gone = objectInfo(); // KSampler is in `fresh` (observed) but we drop it here
  delete gone["KSampler"];
  assert.throws(
    () =>
      assertTypeAgainstFreshBackend(gone, "KSampler", 12, {
        registry: reg,
        wasTypeEverDefined: (t) => history.wasTypeEverDefined(t),
      }),
    /its backend was removed|pack uninstalled/i,
  );
});

test("#496 REGRESSION: PENDING and LATCHED are reported DIFFERENTLY by all three guards", async () => {
  // "hasn't loaded yet, retry" and "never loaded, reload the tab" are different problems
  // with different user actions. Both refuse; only the diagnosis differs.
  const reg = registryWithNatives();
  const fresh = objectInfo();
  const node = { id: 11, type: "MarkdownNote", widgets: [{ name: "text", type: "string", value: "" }], constructor: reg["MarkdownNote"] };
  const PENDING = () => HISTORY_PENDING;
  const LATCHED = () => HISTORY_UNSEEDED;
  const temporary = (m) => /still loading|retry in a moment/i.test(m) && !/Reload the ComfyUI tab/i.test(m);
  const permanent = (m) => /Reload the ComfyUI tab/i.test(m) && !/retry in a moment/i.test(m);

  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg, "MarkdownNote", ADD_OPTS(fresh, PENDING)),
    (err) => temporary(err.message),
  );
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg, "MarkdownNote", ADD_OPTS(fresh, LATCHED)),
    (err) => permanent(err.message),
  );
  assert.throws(
    () => assertTypeAgainstFreshBackend(fresh, "MarkdownNote", 11, { registry: reg, node, wasTypeEverDefined: PENDING }),
    (err) => temporary(err.message),
  );
  assert.throws(
    () => assertTypeAgainstFreshBackend(fresh, "MarkdownNote", 11, { registry: reg, node, wasTypeEverDefined: LATCHED }),
    (err) => permanent(err.message),
  );
  assert.throws(
    () => assertMutatedNodeAuthorized(fresh, reg, node, "target", PENDING),
    (err) => temporary(err.message),
  );
  assert.throws(
    () => assertMutatedNodeAuthorized(fresh, reg, node, "target", LATCHED),
    (err) => permanent(err.message),
  );
});

test("#496 REGRESSION: the PENDING sentinel still FAILS CLOSED — it never authorizes anything", async () => {
  // The recoverable state must not become a hole: while pending, NOTHING is exempted.
  const reg = registryWithNatives();
  const fresh = objectInfo();
  const node = { id: 11, type: "MarkdownNote", widgets: [{ name: "text", type: "string", value: "" }], constructor: reg["MarkdownNote"] };
  assert.equal(backendHistoryVerdict("MarkdownNote", () => HISTORY_PENDING), "pending");
  assert.notEqual(backendHistoryVerdict("MarkdownNote", () => HISTORY_PENDING), "never-seen");
  await assert.rejects(
    () =>
      runSetWidget(node, "text", "# README", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => fresh,
        wasTypeEverDefined: () => HISTORY_PENDING,
        ...HOOKS,
      }),
    /still loading|retry in a moment/i,
  );
  assert.equal(node.widgets[0].value, "", "no write while the baseline is pending");
});

// ---- #512: assertMutatedNodeAuthorized authorizes a genuine UUID SubgraphNode through
//      its RESOLVED, fresh-authorized concrete inner target
//      (opts.promotionResolvedToAuthorizedConcrete) — because current ComfyUI_frontend
//      stamps a synthesized def (nodeData + comfyClass) on every subgraph node's class
//      BY DESIGN, so the provenance-clean check false-fires on the genuine container.
//      The ever-seen gate and the container-shape check are NOT relaxed. -------------

const SUBGRAPH_UUID = "2454ad83-157c-40dd-9f19-5daaf4041ce0";

// A SubgraphNode as current ComfyUI_frontend builds it (registerSubgraphNodeDef): type
// is the subgraph's UUID (never in /object_info); the registered class AND the
// instance's own constructor carry the synthesized nodeDef (nodeData + comfyClass).
function uuidSubgraphContainer(reg) {
  const inner = { id: 301, type: "KSampler", widgets: [{ name: "value_4", type: "INT", value: 20 }] };
  const node = {
    id: 320,
    type: SUBGRAPH_UUID,
    widgets: [{ name: "value_4", type: "INT", value: 20 }],
    subgraph: { _nodes: [inner], getNodeById: (id) => (String(id) === "301" ? inner : null) },
    inputs: [{ name: "value_4", _subgraphSlot: { name: "value_4" } }],
  };
  const ctor = function ComfySubgraphNode() {};
  ctor.nodeData = { input: { required: {} }, name: SUBGRAPH_UUID };
  ctor.comfyClass = SUBGRAPH_UUID;
  node.constructor = ctor;
  reg[SUBGRAPH_UUID] = ctor;
  return node;
}
const RESOLVED = { promotionResolvedToAuthorizedConcrete: true };

test("#512: provenance-stamped UUID container + resolved-authorized promotion ⇒ authorized (the reported false refusal)", () => {
  const reg = loadedRegistry();
  const node = uuidSubgraphContainer(reg);
  const fresh = objectInfo(); // the UUID is never in /object_info
  assert.doesNotThrow(() =>
    assertMutatedNodeAuthorized(fresh, reg, node, "outer subgraph", () => false, RESOLVED),
  );
});

test("#512: the SAME container WITHOUT the resolved-promotion evidence ⇒ still refused (no general relaxation)", () => {
  // A bare container whose class carries def markers but whose promotion was NOT
  // positively resolved + authorized keeps the pre-#512 verdict — the flag is the only
  // thing that changed, so this pins the exemption's scope.
  const reg = loadedRegistry();
  const node = uuidSubgraphContainer(reg);
  const fresh = objectInfo();
  assert.throws(
    () => assertMutatedNodeAuthorized(fresh, reg, node, "outer subgraph", () => false),
    /not a verifiable frontend-only \/ virtual-subgraph node/i,
  );
});

test("#512: the exemption requires POSITIVE never-seen history — an UNWIRED oracle fails closed even with the flag", () => {
  // "no-oracle" is NOT never-seen: without the observed-backend-history trust root
  // there is no non-forgeable evidence the type was never backend-defined, so the
  // resolved-promotion exemption must not engage (the panel always wires the oracle).
  const reg = loadedRegistry();
  const node = uuidSubgraphContainer(reg);
  const fresh = objectInfo();
  assert.throws(
    () => assertMutatedNodeAuthorized(fresh, reg, node, "outer subgraph", undefined, RESOLVED),
    /not a verifiable frontend-only \/ virtual-subgraph node/i,
  );
});

test("#512: an EVER-SEEN (removed) container type is refused even with the flag — the trust root is not bypassed", () => {
  const reg = loadedRegistry();
  const node = uuidSubgraphContainer(reg);
  const fresh = objectInfo(); // type ABSENT now…
  assert.throws(
    () =>
      assertMutatedNodeAuthorized(fresh, reg, node, "outer subgraph", (t) => t === SUBGRAPH_UUID, RESOLVED), // …but seen EARLIER
    /was defined by the ComfyUI backend earlier this session|since-removed/i,
  );
});

test("#512: the flag does not authorize a provenance-bearing NON-container leaf", () => {
  // The exemption is for virtual-subgraph CONTAINERS only: a leaf node whose class
  // carries def markers and whose type is absent from /object_info is still refused.
  const reg = loadedRegistry();
  const ctor = function ComfyNode() {};
  ctor.nodeData = { input: { required: {} } };
  ctor.comfyClass = "SomeBackendishType";
  reg["SomeBackendishType"] = ctor;
  const leaf = {
    id: 9,
    type: "SomeBackendishType",
    widgets: [{ name: "steps", type: "INT", value: 0 }],
    constructor: ctor,
  };
  const fresh = objectInfo();
  assert.throws(
    () => assertMutatedNodeAuthorized(fresh, reg, leaf, "outer subgraph", () => false, RESOLVED),
    /not a verifiable frontend-only \/ virtual-subgraph node/i,
  );
});
