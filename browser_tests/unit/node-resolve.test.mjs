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
  isSubgraphUuidType,
  subgraphTypeIsLoaded,
  subgraphUuidAddRefusal,
  frontendOnlyNotAllowlistedRefusal,
} from "../../web/js/lib/node-resolve.js";
import { createObjectInfoHistory } from "../../web/js/lib/object-info-history.js";
// The PRODUCTION graph_set_widget handler body — the executor and these tests
// call it verbatim, so the tested ordering IS the shipped ordering (#458).
import { runSetWidget } from "../../web/js/lib/set-widget.js";
// The PRODUCTION combo refresh + the authoritative "server says this combo is empty"
// oracle that gates #507's last-resort acceptance.
import { refreshComboOptionsFromDefs } from "../../web/js/lib/asset-staleness.js";
import {
  serverDeclaresEmptyComboOptions,
  serverDeclaresRemoteComboOptions,
} from "../../web/js/lib/input-asset.js";
// #1223 — the REAL snapshot, so the #1126 fallback is driven against the DETACHED name-only
// map production actually hands back, never a hand-rolled full schema.
import { createObjectInfoSnapshot } from "../../web/js/lib/object-info-snapshot.js";
import { TRANSPORT_OUTCOME } from "../../web/js/lib/object-info-oracle.js";

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

test("add_node: unknown-type error points at a LIVE class-type oracle, not a retired or pack-only tool (#318, #741)", () => {
  const reg = loadedRegistry();
  try {
    assertAddNodeResolvable(reg, "DefinitelyNotARealNode");
    throw new Error("expected a throw");
  } catch (e) {
    // The retired panel_get_graph must never be recommended.
    assert.doesNotMatch(e.message, /panel_get_graph/);
    // #741: panel_search_nodes searches installable Manager PACKS, not node classes,
    // so it can never answer "what is the exact class_type" — create_workflow
    // (action:"node_info", the live /object_info) is the oracle that can.
    assert.doesNotMatch(e.message, /panel_search_nodes/);
    assert.match(e.message, /create_workflow \(action:"node_info"\)/);
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

test("#2107: the real runSetWidget refuses a replacement object before mutation", async () => {
  const reg = loadedRegistry();
  const node = regNode("KSampler", [{ name: "steps", type: "INT", value: 0 }]);
  const replacement = regNode("KSampler", [{ name: "steps", type: "INT", value: 99 }]);
  let liveTarget = replacement;
  await assert.rejects(
    () =>
      runSetWidget(node, "steps", 20, {
        registry: reg,
        getFreshObjectInfo: async () => FRESH_ALL,
        resolveSource: () => null,
        ...HOOKS,
        assertTargetStillCurrent: () => {
          if (liveTarget !== node) throw new Error("panel_set_widget target changed before dispatch");
        },
      }),
    /target changed before dispatch/,
  );
  assert.equal(node.widgets[0].value, 0, "the captured stale object was not mutated");
  liveTarget = node;
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
  //     Still refused; only the diagnosis changed (#1296 — see the dedicated block below).
  const reg4 = loadedRegistry();
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg4, "MarkdownNote", ADD_OPTS(fresh)),
    /frontend-only node type|does not provide/i,
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

// ---- mcp#2000: object_info UNAVAILABLE no longer refuses a FRONTEND-ONLY type.
//      Reported against a HEALTHY live canvas: panel_refresh_nodes timed out fetching
//      /object_info, and the very next panel_add_node "MarkdownNote" was refused with
//      "Reconnect ComfyUI and retry" — while ComfyUI was answering fine. The
//      availability guard ran BEFORE the frontend-only exemption, so a fetch that did
//      not answer vetoed a type the fetch could never have answered about: /object_info
//      never lists Note/MarkdownNote/Reroute/PrimitiveNode BY DESIGN.
//
//      The exemption is applied on the SAME terms as the fetched-defs path, and neither
//      of its clauses reads freshDefs — the ever-seen gate reads the session history
//      oracle (which a timeout leaves intact), and isAuthorizedFrontendOnlyType reads
//      the live registry. So this narrows nothing about #458: the block below pins every
//      fail-closed direction, and each case is refused for a DIFFERENT clause. --------

const ADD_OPTS_NO_OBJECT_INFO = (wasTypeEverDefined = () => false) => ({
  getFreshObjectInfo: async () => null, // the bounded fetch timed out / rejected
  refresh: async () => {},
  wasTypeEverDefined,
});

test("mcp#2000 add_node: THE REPORTED CASE — a frontend-only native is ADDABLE when the /object_info fetch did not answer", async () => {
  const reg = registryWithNatives();
  for (const t of ["Note", "MarkdownNote", "Reroute", "PrimitiveNode"]) {
    await assert.doesNotReject(
      () => assertAddNodeResolvableRefreshing(() => reg, t, ADD_OPTS_NO_OBJECT_INFO()),
      `mcp#2000: "${t}" is frontend-only — a fetch that did not answer withheld nothing about it`,
    );
  }
  // The rgthree frontend control nodes ride the same shared allowlist.
  const reg2 = loadedRegistry([], ["Fast Groups Bypasser (rgthree)"]);
  await assert.doesNotReject(() =>
    assertAddNodeResolvableRefreshing(
      () => reg2,
      "Fast Groups Bypasser (rgthree)",
      ADD_OPTS_NO_OBJECT_INFO(),
    ),
  );
});

test("mcp#2000 add_node: driven through the REAL history oracle after a timed-out refresh, not a stub", async () => {
  // Production wiring: the baseline seeded at page load, then a refresh timed out.
  // recordTypes(null) records nothing and a timeout must NEVER arm loseBaseline, so the
  // baseline SURVIVES — which is exactly why the ever-seen gate is still trustworthy on
  // this path. If that ever stops holding, this test is the one that catches it.
  const history = createObjectInfoHistory();
  history.recordTypes({ KSampler: {}, VAEDecode: {}, SaveImage: {} });
  history.markSeeded();
  history.recordTypes(null); // the timed-out refresh
  assert.equal(history.seeded, true, "a timeout must not demote the baseline");
  assert.equal(history.wasTypeEverDefined("MarkdownNote"), false, "verdict must be never-seen");

  const reg = registryWithNatives();
  await assert.doesNotReject(() =>
    assertAddNodeResolvableRefreshing(
      () => reg,
      "MarkdownNote",
      ADD_OPTS_NO_OBJECT_INFO((t) => history.wasTypeEverDefined(t)),
    ),
  );
  // …and a type the SAME surviving baseline DID report is still refused: the trust root
  // is doing real work here, it is not merely present.
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(
        () => loadedRegistry([], ["SaveImage"]),
        "SaveImage",
        ADD_OPTS_NO_OBJECT_INFO((t) => history.wasTypeEverDefined(t)),
      ),
    /cannot verify|object_info is unavailable/i,
  );
});

test("mcp#2000 add_node: object_info UNAVAILABLE still fails closed for everything that is not an authorized frontend-only type", async () => {
  // Each case below trips a DIFFERENT clause, so a mutation that removes any one of
  // them shows up here rather than hiding behind a sibling.
  // (a) not on the allowlist — a genuinely unknown type.
  const reg = registryWithNatives();
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg, "TotallyMadeUpNode", ADD_OPTS_NO_OBJECT_INFO()),
    /cannot verify|object_info is unavailable/i,
  );
  // (b) a REAL backend type: /object_info IS load-bearing for it, so an unanswered
  //     fetch must still veto — this is the #458 case the guard exists for.
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg, "KSampler", ADD_OPTS_NO_OBJECT_INFO()),
    /cannot verify|object_info is unavailable/i,
  );
  // (c) an allowlisted NAME whose registered class carries backend provenance — a
  //     removed pack's stale class squatting a reserved name.
  const regHusk = loadedRegistry(["MarkdownNote"]); // registered WITH nodeData
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => regHusk, "MarkdownNote", ADD_OPTS_NO_OBJECT_INFO()),
    /cannot verify|object_info is unavailable/i,
  );
  // (d) an allowlisted name absent from the LIVE REGISTRY — registry membership is what
  //     LG.createNode needs, so without it the add could only mint a placeholder.
  const regBare = loadedRegistry();
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => regBare, "MarkdownNote", ADD_OPTS_NO_OBJECT_INFO()),
    /cannot verify|object_info is unavailable/i,
  );
  // (e) THE EVER-SEEN GATE, on the unavailable path too: the backend reported this
  //     reserved name earlier this session ⇒ its pack was removed ⇒ refuse.
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(
        () => reg,
        "MarkdownNote",
        ADD_OPTS_NO_OBJECT_INFO((t) => t === "MarkdownNote"),
      ),
    /cannot verify|object_info is unavailable/i,
  );
  // (f) history PENDING (the baseline has not arrived) and (g) UNSEEDED (it never
  //     will) are both TRUTHY sentinels ⇒ not "never-seen" ⇒ refuse.
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(() => reg, "MarkdownNote", ADD_OPTS_NO_OBJECT_INFO(() => HISTORY_PENDING)),
    /cannot verify|object_info is unavailable/i,
  );
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(() => reg, "MarkdownNote", ADD_OPTS_NO_OBJECT_INFO(() => HISTORY_UNSEEDED)),
    /cannot verify|object_info is unavailable/i,
  );
  // (h) NO history oracle wired at all: the exemption REQUIRES the non-forgeable trust
  //     root, so a caller that omits it gets the strict pre-mcp#2000 behaviour.
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(() => reg, "MarkdownNote", {
        getFreshObjectInfo: async () => null,
        refresh: async () => {},
      }),
    /cannot verify|object_info is unavailable/i,
  );
});

test("mcp#2000 INVARIANT: relaxing the precondition does not change WHICH types are exempt", async () => {
  // THE load-bearing invariant of the whole change, and the one a reviewer can check
  // without re-deriving my reasoning: the exempt SET must be identical whether
  // /object_info answered or not. The change moves a PRECONDITION, it does not widen the
  // permission set. Exactly one verdict may differ between the two paths — a REAL backend
  // type, for which the fetch genuinely is load-bearing.
  //
  // Iterating FRONTEND_ONLY_NODE_TYPES rather than a hand-written list is deliberate: a
  // type added to the allowlist later is covered here automatically, on both paths.
  const addVerdict = async (fresh, type, reg, ever) => {
    try {
      await assertAddNodeResolvableRefreshing(() => reg, type, {
        getFreshObjectInfo: async () => fresh,
        refresh: async () => {},
        wasTypeEverDefined: ever,
      });
      return "ALLOW";
    } catch {
      return "REFUSE";
    }
  };
  const swVerdict = (fresh, type, reg, ever) => {
    try {
      assertTypeAgainstFreshBackend(fresh, type, 1, {
        registry: reg,
        node: { id: 1, type, constructor: reg[type] },
        wasTypeEverDefined: ever,
      });
      return "ALLOW";
    } catch {
      return "REFUSE";
    }
  };
  const healthy = objectInfo(); // a live backend that never lists a frontend-only type
  const never = () => false;

  const cases = [];
  for (const t of FRONTEND_ONLY_NODE_TYPES) {
    cases.push([`${t} (clean, never-seen)`, t, loadedRegistry([], [t]), never, "ALLOW"]);
  }
  cases.push(["unknown type", "TotallyMadeUpNode", loadedRegistry(), never, "REFUSE"]);
  cases.push(["ever-seen ⇒ removed", "MarkdownNote", registryWithNatives(), () => true, "REFUSE"]);
  cases.push(["provenance husk", "MarkdownNote", loadedRegistry(["MarkdownNote"]), never, "REFUSE"]);
  cases.push(["not in the live registry", "MarkdownNote", loadedRegistry(), never, "REFUSE"]);

  for (const [label, type, reg, ever, expected] of cases) {
    const withDefs = await addVerdict(healthy, type, reg, ever);
    const without = await addVerdict(null, type, reg, ever);
    assert.equal(withDefs, expected, `add/${label}: unexpected verdict WITH defs`);
    assert.equal(without, withDefs, `add/${label}: the two paths disagree — the exempt set moved`);
    const swWith = swVerdict(healthy, type, reg, ever);
    const swWithout = swVerdict(null, type, reg, ever);
    assert.equal(swWithout, swWith, `set_widget/${label}: the two paths disagree`);
  }

  // …and the ONE type whose verdict MUST differ: a real backend node genuinely needs the
  // fetch, so an unanswered one still refuses. If this ever stops differing, the
  // relaxation has leaked out of the frontend-only set and into live backend types.
  const reg = loadedRegistry();
  assert.equal(await addVerdict(objectInfo(["KSampler"]), "KSampler", reg, never), "ALLOW");
  assert.equal(await addVerdict(null, "KSampler", reg, never), "REFUSE");
  assert.equal(swVerdict(objectInfo(["KSampler"]), "KSampler", reg, never), "ALLOW");
  assert.equal(swVerdict(null, "KSampler", reg, never), "REFUSE");
});

test("mcp#2000: an exemption that THROWS must not replace the refusal it was checking", async () => {
  // Found by running the review taxonomy against my OWN diff (class 5: what does the
  // change make WORSE?). Before mcp#2000 these guards threw their refusal WITHOUT
  // consulting anything, so nothing on this path could raise. Consulting two predicates
  // first meant a hostile registry or a raising oracle surfaced a RAW error instead of
  // the worded refusal — measured leaking "registry exploded" / "history oracle exploded"
  // from all three guards before the shared helper swallowed it. Any doubt REFUSES.
  const ctor = function MarkdownNoteNative() {};
  const reg = registryWithNatives();
  const node = { id: 1, type: "MarkdownNote", constructor: reg["MarkdownNote"] };
  const BOOM = () => {
    throw new Error("history oracle exploded");
  };
  // A registry whose membership probe throws — the realistic shape is a Proxy.
  const hostileReg = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("registry exploded");
      },
      has() {
        throw new Error("registry exploded");
      },
      get() {
        throw new Error("registry exploded");
      },
    },
  );
  const isWorded = (err) => {
    assert.match(err.message, /cannot verify|object_info is unavailable|no usable/i);
    assert.doesNotMatch(err.message, /exploded/, "the raw error must not reach the caller");
    return true;
  };

  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(() => reg, "MarkdownNote", {
        getFreshObjectInfo: async () => null,
        refresh: async () => {},
        wasTypeEverDefined: BOOM,
      }),
    isWorded,
  );
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(() => hostileReg, "MarkdownNote", {
        getFreshObjectInfo: async () => null,
        refresh: async () => {},
        wasTypeEverDefined: () => false,
      }),
    isWorded,
  );
  assert.throws(
    () => assertTypeAgainstFreshBackend(null, "MarkdownNote", 1, { registry: reg, node, wasTypeEverDefined: BOOM }),
    isWorded,
  );
  assert.throws(() => assertMutatedNodeAuthorized(null, reg, node, "target", BOOM), isWorded);

  // CONTROL: swallowing must not have swallowed the exemption itself.
  await assert.doesNotReject(() =>
    assertAddNodeResolvableRefreshing(() => reg, "MarkdownNote", ADD_OPTS_NO_OBJECT_INFO()),
  );
  void ctor;
});

// ---- mcp#2000 PARITY: the SAME relaxation in the two set_widget guards. All three
//      /object_info-oracle guards had the identical `!freshDefs` early throw, so fixing
//      only add_node would have shipped HALF the documented annotation path — the note
//      appears and its text can never be written. Measured on origin/main before
//      extending the fix: with the fetch unavailable the write REFUSED, and the control
//      (same state, fetch answering) WROTE, so the probe was proving the product and not
//      itself. One copy relaxed alone is the #496 drift again, hence all three. --------

test("mcp#2000 set_widget: assertTypeAgainstFreshBackend exempts an authorized frontend-only type when object_info is unavailable", () => {
  const reg = registryWithNatives();
  const node = { id: 7, type: "MarkdownNote", constructor: reg["MarkdownNote"] };
  assert.doesNotThrow(() =>
    assertTypeAgainstFreshBackend(null, "MarkdownNote", 7, {
      registry: reg,
      node,
      wasTypeEverDefined: () => false,
    }),
  );
  // …and every other direction still fails closed on the SAME unavailable map.
  for (const [why, type, opts] of [
    ["a real backend type", "KSampler", { registry: reg, wasTypeEverDefined: () => false }],
    ["a non-allowlisted type", "TotallyMadeUpNode", { registry: reg, wasTypeEverDefined: () => false }],
    ["an ever-seen (removed) allowlisted name", "MarkdownNote", { registry: reg, node, wasTypeEverDefined: () => true }],
    ["a pending baseline", "MarkdownNote", { registry: reg, node, wasTypeEverDefined: () => HISTORY_PENDING }],
    ["an unseeded baseline", "MarkdownNote", { registry: reg, node, wasTypeEverDefined: () => HISTORY_UNSEEDED }],
    ["no registry wired at all", "MarkdownNote", { node, wasTypeEverDefined: () => false }],
    ["a provenance-bearing husk", "MarkdownNote", { registry: loadedRegistry(["MarkdownNote"]), wasTypeEverDefined: () => false }],
  ]) {
    assert.throws(
      () => assertTypeAgainstFreshBackend(null, type, 7, opts),
      /cannot verify|object_info is unavailable|no usable/i,
      `mcp#2000: ${why} must still fail closed`,
    );
  }
  // A stale backend INSTANCE under a bare native class of the same name is refused by
  // the instance-provenance clause, which only this guard family has.
  assert.throws(
    () =>
      assertTypeAgainstFreshBackend(null, "MarkdownNote", 7, {
        registry: reg,
        node: { id: 7, type: "MarkdownNote", constructor: { comfyClass: "MarkdownNote" } },
        wasTypeEverDefined: () => false,
      }),
    /cannot verify|no usable/i,
  );
});

test("mcp#2000 set_widget: assertMutatedNodeAuthorized keeps the same terms on the unavailable path", () => {
  const reg = registryWithNatives();
  const node = { id: 9, type: "MarkdownNote", constructor: reg["MarkdownNote"] };
  assert.doesNotThrow(() => assertMutatedNodeAuthorized(null, reg, node, "target", () => false));
  assert.throws(
    () => assertMutatedNodeAuthorized(null, reg, node, "target", () => true),
    /cannot verify|object_info is unavailable/i,
    "an ever-seen removal still wins",
  );
  assert.throws(
    () => assertMutatedNodeAuthorized(null, reg, { id: 9, type: "KSampler" }, "target", () => false),
    /cannot verify|object_info is unavailable/i,
    "a real backend type still needs the fetch",
  );
  assert.throws(
    () => assertMutatedNodeAuthorized(null, undefined, node, "target", () => false),
    /cannot verify|object_info is unavailable/i,
    "no registry wired ⇒ no exemption",
  );
});

test("mcp#2000 set_widget e2e: the documented annotation path COMPLETES through the production handler when object_info never answers", async () => {
  // THE WHOLE POINT: add the note, then put the text in it. Driving runSetWidget — the
  // body graph_set_widget delegates to — not a predicate in isolation.
  const history = createObjectInfoHistory();
  history.recordTypes({ KSampler: {}, SaveImage: {} });
  history.markSeeded();
  history.recordTypes(null); // the timed-out refresh

  const ctor = function MarkdownNoteNative() {};
  const reg = loadedRegistry();
  reg["MarkdownNote"] = ctor;
  const node = { id: 42, type: "MarkdownNote", widgets: [{ name: "text", type: "text", value: "" }], constructor: ctor };
  const { set } = await runSetWidget(node, "text", "hello", {
    registry: reg,
    getFreshObjectInfo: async () => null, // the fetch never answers
    wasTypeEverDefined: (t) => history.wasTypeEverDefined(t),
    ...HOOKS,
  });
  assert.equal(set.value, "hello");
  assert.equal(node.widgets[0].value, "hello", "the note is fillable, not just addable");

  // CONTROL: a REAL backend node in the identical state still refuses — the relaxation
  // is scoped to frontend-only types, not to "object_info is down".
  const ksNode = { id: 43, type: "KSampler", widgets: [{ name: "steps", type: "INT", value: 1 }], constructor: reg["KSampler"] };
  await assert.rejects(
    () =>
      runSetWidget(ksNode, "steps", 20, {
        registry: reg,
        getFreshObjectInfo: async () => null,
        wasTypeEverDefined: (t) => history.wasTypeEverDefined(t),
        ...HOOKS,
      }),
    /cannot verify|object_info is unavailable|no usable/i,
  );
  assert.equal(ksNode.widgets[0].value, 1, "the refused write left the node untouched");
});

// ---- #1296: an allowlisted FRONTEND-ONLY type that is NOT in the live registry is
//      still refused (LiteGraph could only mint a placeholder — that part is
//      correct), but the refusal must stop diagnosing it as "not installed / its
//      pack failed to import" and pointing at create_workflow (action:"node_info").
//      A frontend-only class never comes from /object_info, so no fetch can confirm
//      it, and the reported rig (rgthree-comfy installed, ComfyUI restarted, tab
//      never reloaded) is exactly "pack JS not loaded in this tab". The refusal now
//      names that and prescribes the ONE action that changes it: reload the tab. ---

test('#1296 add_node: "Fast Groups Bypasser (rgthree)" with rgthree installed but the tab never reloaded is refused with a RELOAD-THE-TAB diagnosis, not "not installed"', async () => {
  const fresh = objectInfo(); // healthy backend — never lists a frontend-only type
  const reg = loadedRegistry(); // this tab predates the rgthree install: not registered
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg, "Fast Groups Bypasser (rgthree)", ADD_OPTS(fresh)),
    (err) => {
      assert.match(err.message, /frontend-only node type/);
      assert.match(err.message, /RELOAD the ComfyUI tab/);
      // The old diagnosis — install a pack they already have, then query the live
      // /object_info for a type that is never in it — must be GONE.
      assert.doesNotMatch(err.message, /not installed, its pack was removed/);
      assert.doesNotMatch(err.message, /failed to import/);
      assert.doesNotMatch(err.message, /create_workflow \(action:"node_info"\)/);
      return true;
    },
  );
  // …and once the tab IS reloaded (the pack JS registers the class, defless), the
  // same add succeeds — the refusal above was about this tab, not the type.
  const regReloaded = loadedRegistry([], ["Fast Groups Bypasser (rgthree)"]);
  await assert.doesNotReject(() =>
    assertAddNodeResolvableRefreshing(() => regReloaded, "Fast Groups Bypasser (rgthree)", ADD_OPTS(fresh)),
  );
});

test("#1296 add_node: the reload diagnosis is scoped — provenance-bearing husk, ever-seen removal, and non-allowlisted types keep their own refusals", async () => {
  const fresh = objectInfo();
  // (a) an allowlisted name whose REGISTERED class carries backend provenance (a
  //     removed pack's stale class squatting a reserved name) is NOT told to reload —
  //     it keeps the generic unknown-type refusal.
  const regHusk = loadedRegistry(["MarkdownNote"]); // registered WITH nodeData
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => regHusk, "MarkdownNote", ADD_OPTS(fresh)),
    (err) => {
      assert.match(err.message, /Unknown node type "MarkdownNote"/);
      assert.doesNotMatch(err.message, /RELOAD the ComfyUI tab/);
      return true;
    },
  );
  // (b) the EVER-SEEN gate still wins over the reload diagnosis: a type the backend
  //     reported earlier this session and no longer does is a REMOVED pack.
  const reg = loadedRegistry();
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(
        () => reg,
        "Fast Groups Bypasser (rgthree)",
        ADD_OPTS(fresh, (t) => t === "Fast Groups Bypasser (rgthree)"),
      ),
    (err) => {
      assert.match(err.message, /defined this node type earlier this session|removed/i);
      assert.doesNotMatch(err.message, /RELOAD the ComfyUI tab/);
      return true;
    },
  );
  // (c) a genuinely unknown, non-allowlisted type keeps the generic refusal with the
  //     node_info pointer — nothing about it suggests a not-yet-loaded pack.
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg, "TotallyMadeUpNode", ADD_OPTS(fresh)),
    (err) => {
      assert.match(err.message, /Unknown node type "TotallyMadeUpNode"/);
      assert.match(err.message, /create_workflow \(action:"node_info"\)/);
      assert.doesNotMatch(err.message, /RELOAD the ComfyUI tab/);
      return true;
    },
  );
});

// ---- #1956: a registered frontend-virtual type that is NOT on the addable
//      allowlist (Bookmark (rgthree)) fails closed — correct — but must not
//      claim the pack is missing. rgthree is installed; the type is absent
//      from /object_info BY DESIGN. ------------------------------------------

/** rgthree-style virtual class: base ctor throws on the default title. */
class BookmarkRgthree {
  constructor(title = "__NEED_CLASS_TITLE__") {
    if (title === "__NEED_CLASS_TITLE__") throw new Error("needs overrides");
    this.title = title;
    this.isVirtualNode = true;
  }
}

test('#1956 add_node: "Bookmark (rgthree)" is refused as frontend-only not-addable, not as a missing pack', async () => {
  const fresh = objectInfo();
  const reg = loadedRegistry();
  reg["Bookmark (rgthree)"] = BookmarkRgthree;
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg, "Bookmark (rgthree)", ADD_OPTS(fresh)),
    (err) => {
      assert.match(err.message, /frontend-only type/);
      assert.match(err.message, /deliberately not addable/);
      assert.match(err.message, /Fast Groups Bypasser \(rgthree\)/);
      assert.match(err.message, /Fast Groups Muter \(rgthree\)/);
      assert.match(err.message, /Label \(rgthree\)/);
      assert.match(err.message, /Reroute \(rgthree\)/);
      assert.match(err.message, /Node Collector \(rgthree\)/);
      assert.doesNotMatch(err.message, /Unknown node type/);
      assert.doesNotMatch(err.message, /not installed, its pack was removed/);
      assert.doesNotMatch(err.message, /failed to import/);
      assert.doesNotMatch(err.message, /create_workflow \(action:"node_info"\)/);
      return true;
    },
  );
});

test("#1956 add_node: the not-allowlisted refusal still fails closed — Bookmark is not added", async () => {
  const msg = frontendOnlyNotAllowlistedRefusal("Bookmark (rgthree)");
  assert.match(msg, /Cannot add "Bookmark \(rgthree\)"/);
  assert.match(msg, /deliberately not addable/);
  assert.doesNotMatch(msg, /Unknown node type|not installed|failed to import/);
});

test("#1956 add_node: a defless husk WITHOUT isVirtualNode keeps the generic unknown-type refusal", async () => {
  // The #458 hole stays closed: a leftover class that does not prove virtual
  // is not re-diagnosed as frontend-only.
  const fresh = objectInfo();
  const reg = loadedRegistry([], ["RemovedBackendNode"]);
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg, "RemovedBackendNode", ADD_OPTS(fresh)),
    /Unknown node type "RemovedBackendNode"|backend does not provide/i,
  );
});

test("#1956 add_node: allowlisted Fast Groups Bypasser stays addable", async () => {
  const fresh = objectInfo();
  const reg = loadedRegistry([], ["Fast Groups Bypasser (rgthree)"]);
  await assert.doesNotReject(() =>
    assertAddNodeResolvableRefreshing(() => reg, "Fast Groups Bypasser (rgthree)", ADD_OPTS(fresh)),
  );
});

// ---- #741: the annotation repro end-to-end through the add guard — Note and
//      MarkdownNote (frontend-only virtual types, never in /object_info) must be
//      ADDABLE on a healthy backend, while a genuinely-bogus type is still refused —
//      and the refusal must steer the agent at a tool that can actually resolve an
//      exact class_type (create_workflow action:"node_info", the live
//      /object_info), never panel_search_nodes (which searches installable
//      Manager PACKS). ------------------------------------------------------

test('#741 add_node: Note/MarkdownNote are accepted; a bogus type is refused and points at create_workflow (action:"node_info"), not panel_search_nodes', async () => {
  const reg = registryWithNatives(); // natives registered as LiteGraph registers them
  const fresh = objectInfo(); // healthy backend — never lists the virtual types
  for (const t of ["Note", "MarkdownNote"]) {
    await assert.doesNotReject(
      () => assertAddNodeResolvableRefreshing(() => reg, t, ADD_OPTS(fresh)),
      `#741: "${t}" is a frontend-only virtual type and must be addable`,
    );
  }
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg, "TotallyBogusNode", ADD_OPTS(fresh)),
    (err) => {
      assert.match(err.message, /Unknown node type "TotallyBogusNode"/);
      assert.match(err.message, /create_workflow \(action:"node_info"\)/);
      assert.doesNotMatch(err.message, /panel_search_nodes/);
      return true;
    },
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

test("#496 recurrence: KJNodes' frontend-only SetNode/GetNode are ADDABLE on a healthy backend that never lists them", async () => {
  // The reported recurrence (also seen with rgthree installed): SetNode/GetNode are
  // registered purely by the pack's frontend JS — absent from /object_info BY DESIGN —
  // and both panel_add_node and panel_set_widget refused them as a missing pack.
  // They are on the shared allowlist now; the ever-seen gate + provenance checks
  // below pin that this does not reopen the #458 hole.
  const reg = loadedRegistry([], ["SetNode", "GetNode"]); // registered by pack JS, defless
  const fresh = objectInfo(); // healthy backend — genuinely never lists these types
  for (const t of ["SetNode", "GetNode"]) {
    await assert.doesNotReject(
      () => assertAddNodeResolvableRefreshing(() => reg, t, ADD_OPTS(fresh)),
      `#496: "${t}" is frontend-only and must be addable`,
    );
  }
});

test("#496 recurrence: SetNode's widget is WRITABLE end-to-end via runSetWidget", async () => {
  const reg = loadedRegistry([], ["SetNode"]);
  const node = {
    id: 32,
    type: "SetNode",
    widgets: [{ name: "Constant", type: "string", value: "" }],
    constructor: reg["SetNode"],
  };
  const { set } = await runSetWidget(node, "Constant", "model", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(), // healthy backend, no SetNode
    wasTypeEverDefined: () => false,
    ...HOOKS,
  });
  assert.equal(set.value, "model");
  assert.equal(node.widgets[0].value, "model");
});

test("#496 recurrence: the SetNode/GetNode allowlist entries do NOT weaken the guards", async () => {
  const fresh = objectInfo();
  // (a) A class SQUATTING the allowlisted name but carrying backend provenance
  //     (a real backend def, or a removed pack's unpurged class) is NOT frontend-only.
  const squat = loadedRegistry(["SetNode"]); // registered WITH nodeData
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => squat, "SetNode", ADD_OPTS(fresh)),
    /Unknown node type|does not provide/i,
  );
  // (b) The EVER-SEEN gate still wins: a "GetNode" the backend reported EARLIER this
  //     session and no longer lists is a removed backend node — refused.
  const reg = loadedRegistry([], ["GetNode"]);
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => reg, "GetNode", ADD_OPTS(fresh, (t) => t === "GetNode")),
    /defined this node type earlier this session|removed/i,
  );
  // (c) An allowlisted name that is NOT registered in the live registry at all stays
  //     refused (registry membership is also what createNode needs). #1296 changed only
  //     the DIAGNOSIS: it now names the unloaded pack JS and prescribes a tab reload.
  await assert.rejects(
    () => assertAddNodeResolvableRefreshing(() => loadedRegistry(), "SetNode", ADD_OPTS(fresh)),
    /frontend-only node type|does not provide/i,
  );
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
function remoteComboFixture(liveOptions = []) {
  const reg = loadedRegistry(["LTXVAudioVAELoader"]);
  const widget = { name: "ckpt_name", type: "combo", options: { values: liveOptions }, value: "" };
  const node = { id: 1696, type: "LTXVAudioVAELoader", widgets: [widget], constructor: reg["LTXVAudioVAELoader"] };
  return { reg, node, widget };
}
function remoteComboObjectInfo() {
  const info = objectInfo();
  info["LTXVAudioVAELoader"] = {
    input: {
      required: {
        ckpt_name: ["COMBO", { remote: { route: "/internal/files/checkpoints" } }],
      },
    },
  };
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

test("#1696 e2e: a remote combo refusal names unavailable provenance, not an empty list", async () => {
  const { reg, node, widget } = remoteComboFixture([]);
  const remote = remoteComboObjectInfo();
  assert.equal(
    serverDeclaresRemoteComboOptions(remote, "LTXVAudioVAELoader", "ckpt_name"),
    true,
    "the fixture must identify the separate remote option source",
  );
  assert.equal(
    serverDeclaresEmptyComboOptions(remote, "LTXVAudioVAELoader", "ckpt_name"),
    false,
    "a remote source is not a server-declared empty list",
  );

  await assert.rejects(
    runSetWidget(node, "ckpt_name", "ltx-video.safetensors", {
      registry: reg,
      getRegistry: () => reg,
      getFreshObjectInfo: async () => remote,
      wasTypeEverDefined: () => true,
      refreshCombos: refreshFromServer,
      ...HOOKS,
    }),
    (err) => {
      assert.match(err.message, /combo_source=remote/);
      assert.match(err.message, /option_list=unavailable/);
      assert.match(err.message, /verdict=unknown/);
      assert.match(err.message, /requested value was not validated/);
      assert.match(err.message, /NOTHING WAS WRITTEN/);
      assert.doesNotMatch(err.message, /EMPTY option list/i);
      assert.doesNotMatch(err.message, /may simply be stale|refreshing it before deciding/i);
      return true;
    },
  );
  assert.equal(widget.value, "", "the remote/unreadable path remains fail-closed");
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

// ── #1126 e2e: a combo whose options CANNOT BE ENUMERATED, through the real ladder ──
//
// `options.values` is the node's own callback. When it throws, the panel has compared the
// value to nothing — yet the ladder refused, and the refusal reached the user as a verdict
// about their value. The decision below is made from the panel's OWN observation (the read
// failed) confirmed against the server (it publishes no list for this input either), never
// from an assertion the caller makes about the node.

/** The reported shape: a dynamic file combo whose populate callback fails. */
function unreadableComboFixture(values) {
  const reg = loadedRegistry(["StarOllamaPromptHelper"]);
  const widget = { name: "model", type: "combo", options: { values }, value: "" };
  const node = { id: 9, type: "StarOllamaPromptHelper", widgets: [widget], constructor: reg["StarOllamaPromptHelper"] };
  return { reg, node, widget };
}
const THROWS = () => {
  throw new Error("the node's own populate() failed");
};

test("#1126 e2e: an UNREADABLE option list writes the path and discloses that nothing checked it", async () => {
  const { reg, node, widget } = unreadableComboFixture(THROWS);
  const res = await runSetWidget(node, "model", String.raw`F:\Downloads\Scarlet1.0.fbx`, {
    registry: reg,
    getRegistry: () => reg,
    // The server publishes no list for this input either — so the valid set is not
    // knowable from anywhere the panel can see.
    getFreshObjectInfo: async () => starObjectInfo([]),
    wasTypeEverDefined: () => true,
    refreshCombos: refreshFromServer,
    ...HOOKS,
  });
  assert.equal(res.set.value, String.raw`F:\Downloads\Scarlet1.0.fbx`);
  assert.equal(widget.value, String.raw`F:\Downloads\Scarlet1.0.fbx`);
  assert.equal(res.option_list_unreadable, true, "the caller must be told nothing validated it");
  assert.match(res.option_list_unreadable_note, /could NOT BE READ/);
  assert.match(res.option_list_unreadable_note, /not because the value was checked and passed/);
  // The note states the OBSERVED reason rather than a plausible default: there are three
  // distinct ones and only the read that decided it knows which.
  assert.match(res.option_list_unreadable_note, /options\.values callback threw/);
  assert.match(res.option_list_unreadable_note, /the node's own populate\(\) failed/);
  assert.match(res.set.option_list_unreadable_detail, /callback threw/);
  // It must NOT claim the empty-list path: "the server declared zero options" is a
  // different observation, and reporting one as the other misdescribes the write.
  assert.equal(res.empty_option_list, undefined);
});

test("#1126 e2e: a failed live read is NOT licence to ignore a list the SERVER publishes", async () => {
  // The second condition, and the one that keeps this from becoming "skip validation
  // whenever the callback is flaky". /object_info publishes a real list for this input,
  // so the valid set IS knowable from somewhere — and the panel does not get to write
  // blindly just because the node's own callback failed.
  //
  // The refresh cannot repair this shape (refreshComboOptionsFromDefs deliberately never
  // clobbers a FUNCTION option source — a dynamic list computes its own), so the write
  // stays refused, exactly as it was before this change. That is the deliberate
  // conservative edge: the panel refuses rather than validating against a server list the
  // widget itself has not adopted. The refusal still says which observation it rests on.
  for (const value of ["llama3.2:3b", "not-installed:70b"]) {
    const { reg, node, widget } = unreadableComboFixture(THROWS);
    await assert.rejects(
      runSetWidget(node, "model", value, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => starObjectInfo(["qwen3-vl:8b", "llama3.2:3b"]),
        wasTypeEverDefined: () => true,
        refreshCombos: refreshFromServer,
        ...HOOKS,
      }),
      (err) =>
        /panel_set_widget refused "model" on node 9/.test(err.message) &&
        /option list could not be READ/.test(err.message) &&
        // Never a claim about the value: nothing was compared to anything.
        !/is not a valid option/.test(err.message),
      `a server-published list withholds the acceptance for ${value}`,
    );
    assert.equal(widget.value, "", "no mutation on the refusal");
  }
});

test("#1126 e2e: a list that WAS read still refuses an off-list value, framed and self-describing", async () => {
  // The other direction, end to end. Nothing about the escape reaches a combo the panel
  // could enumerate: the value is simply not one of the choices.
  const { reg, node, widget } = starNodesFixture(["qwen3-vl:8b", "llama3.2:3b"]);
  await assert.rejects(
    runSetWidget(node, "model", "not-installed:70b", {
      registry: reg,
      getRegistry: () => reg,
      getFreshObjectInfo: async () => starObjectInfo(["qwen3-vl:8b", "llama3.2:3b"]),
      wasTypeEverDefined: () => true,
      refreshCombos: refreshFromServer,
      ...HOOKS,
    }),
    (err) =>
      // The frame survives — tool, widget, node — so the refusal is attributable.
      /panel_set_widget refused "model" on node 9/.test(err.message) &&
      /is not a valid option/.test(err.message) &&
      // …and it says WHICH of the two happened, so an agent does not read a rejected
      // value as an unreadable list (or keep retrying a value that will never be valid).
      /option list WAS read successfully/.test(err.message) &&
      /rejected VALUE, not an unreadable list/.test(err.message),
  );
  assert.equal(widget.value, "", "no mutation on the refusal");
});

test("#1126 e2e: an unreadable list REFUSES a non-string, and the refusal keeps its frame", async () => {
  // The last-resort attempt can itself refuse (#240 keeps a number out of a combo whose
  // real list exists but cannot be read). That refusal is raised inside the final write,
  // outside the ladder's try/catch — so without explicit framing it would surface as a
  // bare `Combo widget "model": …` with no tool, node, or widget attached.
  const { reg, node, widget } = unreadableComboFixture(THROWS);
  await assert.rejects(
    runSetWidget(node, "model", 640, {
      registry: reg,
      getRegistry: () => reg,
      getFreshObjectInfo: async () => starObjectInfo([]),
      wasTypeEverDefined: () => true,
      refreshCombos: refreshFromServer,
      ...HOOKS,
    }),
    (err) =>
      /panel_set_widget refused "model" on node 9/.test(err.message) &&
      /option list unreadable/.test(err.message) &&
      /NON-EMPTY STRING/.test(err.message),
  );
  assert.equal(widget.value, "", "no mutation");
});

test("#1126 e2e: the unreadable acceptance is the LAST resort — a refreshable list is fixed first", async () => {
  // Ordering matters: if the acceptance ran before the authoritative refresh it would
  // quietly become "skip validation whenever the callback is flaky", and a transient
  // failure would write an off-list value into a combo the server can enumerate perfectly
  // well. Here the callback fails once and the refresh replaces it with the server's list.
  let calls = 0;
  const flaky = () => {
    calls += 1;
    if (calls === 1) throw new Error("transient");
    return ["qwen3-vl:8b", "llama3.2:3b"];
  };
  const { reg, node, widget } = unreadableComboFixture(flaky);
  const res = await runSetWidget(node, "model", "llama3.2:3b", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => starObjectInfo(["qwen3-vl:8b", "llama3.2:3b"]),
    wasTypeEverDefined: () => true,
    refreshCombos: refreshFromServer,
    ...HOOKS,
  });
  assert.equal(widget.value, "llama3.2:3b");
  assert.equal(res.refreshed, true, "the authoritative retry is what accepted it");
  assert.equal(res.option_list_unreadable, undefined, "nothing went unvalidated");
});

// ── #1223/#716 × #1126: the "server declares it empty" evidence must be LIVE ──────────
//
// A cross-feature hole, opened by changes that are each correct alone. #1223 (v0.14.39) lets
// `getFreshObjectInfo` answer from the LAST-OBSERVED schema snapshot when both live probes go
// silent; #716's burst cache lets it answer from a payload up to 1.5s old. This fallback's
// second condition reads either answer as "the SERVER declares this input's option list
// empty" — but both are what the server said BEFORE, retained across a window in which nobody
// re-asked. Options change without a reconnect AND without a cache drop (a model downloaded
// while this node's own callback keeps failing), so either stale `[]` would authorize an
// unvalidated write. Same defect, two layers.

const snapshotOpts = (reg, extra = {}) => ({
  registry: reg,
  getRegistry: () => reg,
  // The (stale) schema publishes NO list for this input — the shape that would authorize.
  getFreshObjectInfo: async () => starObjectInfo([]),
  wasTypeEverDefined: () => true,
  refreshCombos: refreshFromServer,
  ...HOOKS,
  ...extra,
});

/**
 * The REAL map #1223's fallback hands back — built by driving `record` + `authorize`, never
 * hand-rolled. This matters: the snapshot deliberately stores a DETACHED map of TYPE NAMES,
 * every value the shared frozen EMPTY_DEF with no `input` at all (retaining the payload would
 * let a beforeRegisterNodeDef hook launder frontend-mutated defs back as backend evidence).
 * A test that supplies a full `starObjectInfo([])` here would be testing a shape production
 * never produces — which is how the snapshot branch came to be dead code in the first place.
 */
function detachedSnapshotDefs(fullMap) {
  const snap = createObjectInfoSnapshot();
  assert.equal(
    snap.record(fullMap, {
      observedAtEpoch: 7,
      currentEpoch: 7,
      observedAtGeneration: 0,
      currentGeneration: 0,
      whole: true,
    }),
    true,
    "fixture precondition: the snapshot accepted the whole map",
  );
  const { defs } = snap.authorize({
    epoch: 7,
    socketDown: false,
    // Both transports contacted and silent — the only state that licenses the fallback.
    outcomes: [{ kind: TRANSPORT_OUTCOME.NO_ANSWER }, { kind: TRANSPORT_OUTCOME.NOTHING_RETURNED }],
  });
  assert.ok(defs, "fixture precondition: the snapshot authorized");
  return defs;
}

test("#1223 fixture: the real snapshot map holds NAMES ONLY — it cannot answer an option-list question", () => {
  // Pins the premise the refusal below rests on, so a future change that re-attached payloads
  // to the snapshot fails HERE with a clear reason rather than silently reviving a branch that
  // was reasoned about as unreachable.
  const defs = detachedSnapshotDefs(starObjectInfo([]));
  assert.ok(
    Object.prototype.hasOwnProperty.call(defs, "StarOllamaPromptHelper"),
    "membership survives — that is what the snapshot is for",
  );
  assert.equal(defs["StarOllamaPromptHelper"].input, undefined, "…but the def carries no input");
  assert.equal(
    serverDeclaresEmptyComboOptions(defs, "StarOllamaPromptHelper", "model"),
    false,
    "so the shape test is ALWAYS false against a snapshot, for every input on every node",
  );
});

test("#1223 × #1126: a SNAPSHOT can never authorize the blind write, and says why", async () => {
  // Driven against the REAL detached map, not a hand-built full one. The shape test cannot
  // pass here — a name-only map answers "no" for every input in existence — so the honest
  // outcome is a refusal that names the silent backend rather than the generic end-of-ladder
  // message, which would send the caller to look at their value instead.
  const { reg, node, widget } = unreadableComboFixture(THROWS);
  await assert.rejects(
    runSetWidget(node, "model", String.raw`F:\Downloads\Scarlet1.0.fbx`, {
      ...snapshotOpts(reg),
      getFreshObjectInfo: async () => detachedSnapshotDefs(starObjectInfo([])),
      schemaProvenance: () => "snapshot",
    }),
    (err) =>
      /panel_set_widget refused "model" on node 9 \(StarOllamaPromptHelper\)/.test(err.message) &&
      /LAST-OBSERVED one \(#1223\)/.test(err.message) &&
      /detached map of TYPE NAMES ONLY/.test(err.message) &&
      // It must name WHICH fact is missing. "Reconnect and retry" is only actionable if the
      // caller knows it is the SCHEMA, not their value, that could not be established.
      /holds no option lists at all/.test(err.message) &&
      /Reconnect to ComfyUI/.test(err.message) &&
      // And it must NOT be the cache/stale wording: a map that holds no lists is not a map
      // holding a stale one, and telling the user to "retry in a moment" would be wrong.
      !/burst cache/.test(err.message),
  );
  assert.equal(widget.value, "", "fails closed — a name-only map establishes nothing");
});

test("#1126: a RECONNECT-SPANNING response is not live — the replaced process cannot authorize", async () => {
  // object-info-cache deliberately still hands a retired response to its ORIGINAL waiter, and
  // objectInfoSnapshot.record refuses to file it because observed !== current. The provenance
  // must apply the same test: a schema describing the ComfyUI process that has been replaced
  // must not authorize a blind write against the replacement's option lists — a restart is
  // precisely the event that changes what the server publishes.
  const { reg, node, widget } = unreadableComboFixture(THROWS);
  await assert.rejects(
    runSetWidget(node, "model", String.raw`F:\Downloads\Scarlet1.0.fbx`, {
      ...snapshotOpts(reg),
      schemaProvenance: () => "reconnected",
    }),
    (err) =>
      /backend RECONNECTED while that \/object_info request was in flight/.test(err.message) &&
      /has since been replaced/.test(err.message) &&
      /did not come from the server answering now/.test(err.message),
  );
  assert.equal(widget.value, "", "fails closed — the answer describes a process that is gone");
});

test("#1126: a RETIRED response is not live — the panel's own refresh superseded it", async () => {
  // The fourth way a response turned out not to be live, and the one a healthy backend hits
  // most: registerComfyNodeDefs drops the burst cache on a refresh, a pack install, or a
  // download completing. That bumps the cache GENERATION without moving the reconnect epoch,
  // so an epoch test alone still calls it live — while the very refresh that retired it may
  // be what filled this option list.
  const { reg, node, widget } = unreadableComboFixture(THROWS);
  await assert.rejects(
    runSetWidget(node, "model", String.raw`F:\Downloads\Scarlet1.0.fbx`, {
      ...snapshotOpts(reg),
      schemaProvenance: () => "retired",
    }),
    (err) =>
      /panel REFRESHED the node definitions while that \/object_info request was in flight/.test(err.message) &&
      /may be what filled this list/.test(err.message) &&
      /did not come from the server answering now/.test(err.message),
  );
  assert.equal(widget.value, "", "fails closed — the answer was superseded before it arrived");
});

test("#1126: a NESTED promotion is refused BEFORE any re-fetch is paid for", async () => {
  // The chain shape is already known and no schema can make this writable, so establishing
  // evidence for it is pure cost — and on a non-live provenance that cost is a cache drop
  // plus a multi-megabyte /object_info round trip, spent to answer a question whose answer
  // cannot change the outcome.
  const reg = loadedRegistry(["StarOllamaPromptHelper"]);
  const container = (uuid, id, w, innerNode, innerId) => {
    const ctor = function ComfySubgraphNode() {};
    ctor.nodeData = { input: { required: {} }, name: uuid };
    ctor.comfyClass = uuid;
    reg[uuid] = ctor;
    return {
      id,
      type: uuid,
      constructor: ctor,
      subgraph: { _nodes: [innerNode], getNodeById: (x) => (String(x) === innerId ? innerNode : null) },
      inputs: [{ name: w.name, _widget: w, widget: { name: w.name }, _subgraphSlot: { name: w.name } }],
      widgets: [w],
    };
  };
  const concreteWidget = { name: "model", type: "combo", options: { values: ["qwen3-vl:8b"] }, value: "" };
  const concrete = {
    id: 302,
    type: "StarOllamaPromptHelper",
    widgets: [concreteWidget],
    constructor: reg["StarOllamaPromptHelper"],
  };
  const midWidget = { name: "model_mid", type: "combo", options: { values: THROWS }, value: "" };
  const mid = container("11111111-1111-4111-8111-111111111111", 301, midWidget, concrete, "302");
  const outerWidget = { name: "model_alias", type: "combo", options: { values: THROWS }, value: "" };
  const outer = container("22222222-2222-4222-8222-222222222222", 320, outerWidget, mid, "301");
  let refetched = 0;
  let fetches = 0;
  await assert.rejects(
    runSetWidget(outer, "model_alias", String.raw`F:\Downloads\Scarlet1.0.fbx`, {
      registry: reg,
      getRegistry: () => reg,
      getFreshObjectInfo: async () => {
        fetches += 1;
        return starObjectInfo([]);
      },
      wasTypeEverDefined: (t) => t === "StarOllamaPromptHelper",
      resolveSource: (_n, si) => {
        if (si?.name === "model_alias") return { sourceNodeId: "301", sourceWidgetName: "model_mid" };
        if (si?.name === "model_mid") return { sourceNodeId: "302", sourceWidgetName: "model" };
        return null;
      },
      // A provenance that WOULD trigger the re-ask if the nested check did not come first.
      schemaProvenance: () => "cache",
      // Wired for real, so the assertion below measures something. Stubbing a capability the
      // lib no longer reads would make "it was never called" true by construction.
      refetchObjectInfoLive: async () => {
        refetched += 1;
        return starObjectInfo([]);
      },
      ...HOOKS,
    }),
    (err) => /NESTED promotion/.test(err.message),
  );
  assert.equal(refetched, 0, "no forced reread is paid for a write that cannot succeed");
  assert.equal(fetches, 1, "only the ladder's own authorization fetch — no last-resort re-ask");
});

test("#716 × #1126: a CACHE-HIT empty list does NOT authorize a blind write either", async () => {
  // The layer below the snapshot, and the one a healthy backend actually hits: #716's burst
  // cache answers writes 2..N of a burst without asking the server at all. "Not from a
  // snapshot" is NOT the same as "live". Here the re-ask is impossible (no invalidator
  // wired), so the fallback must fail closed rather than trust a payload nobody refreshed.
  const { reg, node, widget } = unreadableComboFixture(THROWS);
  await assert.rejects(
    runSetWidget(node, "model", String.raw`F:\Downloads\Scarlet1.0.fbx`, {
      ...snapshotOpts(reg),
      schemaProvenance: () => "cache",
    }),
    (err) =>
      /burst cache \(#716\)/.test(err.message) &&
      /did not come from the server answering now/.test(err.message) &&
      // Never blamed on the snapshot: naming the wrong layer sends the user to reconnect
      // when all they had to do was wait out a 1.5s TTL.
      !/LAST-OBSERVED schema snapshot/.test(err.message),
  );
  assert.equal(widget.value, "", "fails closed — a cached [] is not the server answering");
});

test("#716 × #1126: a cache hit is RE-ASKED, and a live empty answer authorizes the write", async () => {
  // Failing closed on every cache hit would refuse writes 2..N of an ordinary burst — the
  // exact multi-widget case this fix exists to serve. So the fallback drops the cache and
  // re-asks ONCE. The re-ask is what must flip the provenance; the write follows from that.
  const { reg, node, widget } = unreadableComboFixture(THROWS);
  let refetched = 0;
  let provenance = "cache";
  const res = await runSetWidget(node, "model", String.raw`F:\Downloads\Scarlet1.0.fbx`, {
    ...snapshotOpts(reg),
    schemaProvenance: () => provenance,
    // ONE capability naming the outcome the ladder needs, so the cache decides how to get a
    // fresh answer without a global invalidation that would disturb concurrent writers.
    refetchObjectInfoLive: async () => {
      refetched += 1;
      provenance = "live";
      return starObjectInfo([]);
    },
  });
  assert.equal(refetched, 1, "the forced reread happens exactly once");
  assert.equal(widget.value, String.raw`F:\Downloads\Scarlet1.0.fbx`);
  assert.equal(res.option_list_unreadable, true);
});

test("#1126: a verdict that EXPIRES during the recovery awaits does not authorize the write", async () => {
  // Round-5's defect, and a different species from rounds 1-4. Those asked "what KIND of
  // response is this"; this asks "is that still TRUE". The initial /object_info read is
  // genuinely live — and then definitions change while `refreshCombos` and the upload probe
  // are AWAITED. A stored "live" string keeps insisting otherwise, so the blind write is
  // authorized from a schema that has since been superseded, bypassing a list that may have
  // become non-empty in exactly that window.
  //
  // The panel therefore threads `provenanceNow`, a QUESTION rather than an answer, and the
  // lib asks it after those awaits. Modelled here by a provenance that is live at the first
  // read and retired by the time the ladder decides.
  const { reg, node, widget } = unreadableComboFixture(THROWS);
  let refreshed = false;
  await assert.rejects(
    runSetWidget(node, "model", String.raw`F:\Downloads\Scarlet1.0.fbx`, {
      ...snapshotOpts(reg),
      // The refresh is what supersedes the schema — exactly what registerComfyNodeDefs does
      // on an install, a download completing, or an explicit refresh.
      refreshCombos: async (...args) => {
        const out = refreshFromServer(...args);
        refreshed = true;
        return out;
      },
      // LIVE at delivery; RETIRED once the refresh above has run. Re-asked, this tells the
      // truth; remembered, it does not.
      schemaProvenance: () => (refreshed ? "retired" : "live"),
      // No re-ask capability wired, so the ladder must fail closed rather than paper over it.
    }),
    (err) =>
      /panel REFRESHED the node definitions while that \/object_info request was in flight/.test(err.message) &&
      /did not come from the server answering now/.test(err.message),
  );
  assert.equal(refreshed, true, "the recovery await really did run before the decision");
  assert.equal(widget.value, "", "fails closed — the verdict had expired by the time it was used");
});

test("#716 × #1126: a re-ask that finds a REAL list refuses instead of writing blind", async () => {
  // The hole the re-ask exists to find: the cached `[]` was stale and the server does publish
  // a list for this input. Good provenance must not become permission to write past the very
  // answer that was just fetched to check it.
  const { reg, node, widget } = unreadableComboFixture(THROWS);
  let provenance = "cache";
  const res = runSetWidget(node, "model", String.raw`F:\Downloads\Scarlet1.0.fbx`, {
    ...snapshotOpts(reg),
    schemaProvenance: () => provenance,
    refetchObjectInfoLive: async () => {
      provenance = "live";
      // The model finished downloading while the node's own callback kept failing.
      return starObjectInfo(["qwen3-vl:8b"]);
    },
  });
  await assert.rejects(
    res,
    (err) =>
      /the live re-read NO LONGER declares it empty/.test(err.message) &&
      // The refusal must state the OBSERVATION and name the possibilities, not pick one.
      // `serverDeclaresEmptyComboOptions` returning false is equally true when the server
      // publishes a real list and when it stops describing this input at all — asserting
      // the first as fact is the same over-claim this PR exists to remove.
      /either it now publishes a real option list for this input, or it no longer/.test(err.message) &&
      !/produced one that DOES publish a list/.test(err.message) &&
      /panel_set_widget refused "model"/.test(err.message),
  );
  assert.equal(widget.value, "", "no blind write once the premise no longer holds");
});

test("#1223 × #1126: the SAME call writes when the schema was fetched LIVE", async () => {
  // The other half: this must fail closed on stale evidence WITHOUT disabling the fallback
  // for the live case it exists to serve. Only the provenance differs between the two tests.
  const { reg, node, widget } = unreadableComboFixture(THROWS);
  const res = await runSetWidget(node, "model", String.raw`F:\Downloads\Scarlet1.0.fbx`, {
    ...snapshotOpts(reg),
    schemaProvenance: () => "live",
  });
  assert.equal(widget.value, String.raw`F:\Downloads\Scarlet1.0.fbx`);
  assert.equal(res.option_list_unreadable, true);
});

test("#1223 × #1126: UNKNOWN provenance fails closed — a throwing probe is not a live one", async () => {
  // A provenance probe that throws has established nothing, and "nothing established" must
  // not read as "live". The default (no probe wired at all) is the pre-#716/#1223 world,
  // where the oracle had neither a cache nor a snapshot branch to take and could only ever
  // have fetched, so it stays permissive — that is the case every other test here exercises.
  const { reg, node, widget } = unreadableComboFixture(THROWS);
  await assert.rejects(
    runSetWidget(node, "model", String.raw`F:\Downloads\Scarlet1.0.fbx`, {
      ...snapshotOpts(reg),
      schemaProvenance: () => {
        throw new Error("provenance unknown");
      },
    }),
    (err) => /provenance could not be established at all/.test(err.message),
  );
  assert.equal(widget.value, "", "no mutation when provenance could not be established");
});

test("#1126: a PARTIAL write is never reworded into a 'refused' frame", async () => {
  // Every `panel_set_widget refused …` message asserts more than the text it wraps: that
  // nothing was applied, so the caller may retry or give up freely. Exactly one
  // WidgetWriteError breaks that — the one raised AFTER the graph was mutated and the
  // rollback failed to restore it. Reporting THAT as a refusal tells the caller "nothing
  // happened" about a graph now in a partial state, which is the class of false report this
  // whole change exists to eliminate.
  //
  // Driven through the REAL ladder: the value is refused by the widget's own callback after
  // the write lands, and the rollback is defeated by a value setter that refuses to restore.
  const reg = loadedRegistry(["StarOllamaPromptHelper"]);
  const widget = { name: "model", type: "combo", options: { values: ["a.fbx"] }, value: "a.fbx" };
  let landed = false;
  Object.defineProperty(widget, "value", {
    configurable: true,
    get: () => (landed ? "STUCK" : "a.fbx"),
    set: () => {
      // Accepts nothing: the write cannot verify, and the rollback cannot restore either.
      landed = true;
    },
  });
  const node = {
    id: 9,
    type: "StarOllamaPromptHelper",
    widgets: [widget],
    constructor: reg["StarOllamaPromptHelper"],
  };
  await assert.rejects(
    runSetWidget(node, "model", "a.fbx", {
      registry: reg,
      getRegistry: () => reg,
      getFreshObjectInfo: async () => starObjectInfo(["a.fbx"]),
      wasTypeEverDefined: () => true,
      ...HOOKS,
    }),
    (err) =>
      // The write's own partial-state warning reaches the caller intact…
      /partial state/.test(err.message) &&
      // …and is NOT dressed up as a refusal, which would claim nothing was applied.
      !/panel_set_widget refused/.test(err.message),
  );
});

test("#1126: a stateful callback that finally answers [] takes #507's acceptance, not a refusal", async () => {
  // `options.values` is a callback and can answer differently per call. If it throws on the
  // initial read and on the refreshed read but returns [] on the FINAL one, only the
  // unreadable acceptance was enabled — so coercion fell through to #507's empty-list branch,
  // raised a RETRYABLE emptyOptions rejection, and refused with "the server's option list may
  // simply be stale, refreshing it before deciding" at the end of a ladder that had already
  // refreshed it. By that point the LIVE server schema has ALREADY confirmed the list empty,
  // which is #507's own precondition, so this is a valid transition being rejected.
  const { reg, node, widget } = unreadableComboFixture(THROWS);
  let reads = 0;
  widget.options.values = () => {
    reads += 1;
    // Throws for every read the ladder makes before the final write attempt.
    if (reads < 3) throw new Error("ollama not reachable");
    return [];
  };
  const res = await runSetWidget(node, "model", String.raw`F:\Downloads\Scarlet1.0.fbx`, {
    ...snapshotOpts(reg),
    schemaProvenance: () => "live",
  });
  assert.equal(widget.value, String.raw`F:\Downloads\Scarlet1.0.fbx`, "the write lands");
  // Pins the ladder shape this test depends on: the list is UNREADABLE for the initial read
  // and for the post-refresh retry — so the #1126 branch is the one reached — and answers []
  // only on the final write attempt. If the ladder ever reads a different number of times,
  // this fails loudly instead of quietly covering the #507 branch instead.
  assert.equal(reads, 3, "throws on the initial read and the post-refresh retry, [] on the final write");
  // Reported as what ACTUALLY admitted it, decided at coercion time — an empty list really
  // was read on the attempt that counted, so this is #507's outcome and says so.
  assert.equal(res.empty_option_list, true, "#507's acceptance, named as #507's");
  assert.equal(res.option_list_unreadable, undefined, "not claimed as an unreadable-list write");
});

test("#1126 e2e: the reply note does not claim 'nothing checked it' when the RAIL did", async () => {
  // End-to-end through the real ladder: a SINGLE-HOP promotion (so the nested refusal below
  // does not apply), inner list unreadable, parent rail's list readable and containing the
  // value. The sibling cross-check compares against that rail and proceeds only on
  // membership — so the reply must scope its "unvalidated" claim to the widget it is about.
  const reg = loadedRegistry(["StarOllamaPromptHelper"]);
  const UUID = "33333333-3333-4333-8333-333333333333";
  const innerWidget = { name: "model", type: "combo", options: { values: THROWS }, value: "" };
  const inner = {
    id: 301,
    type: "StarOllamaPromptHelper",
    widgets: [innerWidget],
    constructor: reg["StarOllamaPromptHelper"],
  };
  const rail = { name: "model_alias", type: "combo", options: { values: ["qwen3-vl:8b"] }, value: "" };
  const ctor = function ComfySubgraphNode() {};
  ctor.nodeData = { input: { required: {} }, name: UUID };
  ctor.comfyClass = UUID;
  reg[UUID] = ctor;
  const outer = {
    id: 320,
    type: UUID,
    constructor: ctor,
    subgraph: { _nodes: [inner], getNodeById: (id) => (String(id) === "301" ? inner : null) },
    inputs: [{ name: "model_alias", _widget: rail, widget: { name: "model_alias" }, _subgraphSlot: { name: "model_alias" } }],
    widgets: [rail],
  };
  const res = await runSetWidget(outer, "model_alias", "qwen3-vl:8b", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => starObjectInfo([]),
    wasTypeEverDefined: (t) => t === "StarOllamaPromptHelper",
    resolveSource: (_n, si) =>
      si?.name === "model_alias" ? { sourceNodeId: "301", sourceWidgetName: "model" } : null,
    ...HOOKS,
  });
  assert.equal(rail.value, "qwen3-vl:8b");
  assert.equal(innerWidget.value, "qwen3-vl:8b");
  assert.equal(res.option_list_unreadable, true, "the inner widget's own list still went unread");
  assert.equal(res.promoted_rail_validated, true, "…but the rail's list vouched for the value");
  assert.match(res.option_list_unreadable_note, /NOT written entirely unchecked/);
  assert.match(res.option_list_unreadable_note, /rail widget, whose option list WAS readable/);
  assert.doesNotMatch(res.option_list_unreadable_note, /Nothing compared your value to anything/);
});

// ── #1126: a NESTED promotion is refused, not blind-written ──────────────────────────
//
// The rejection this fallback answers describes the IMMEDIATE promoted projection. On a
// nested chain the value is driven on into a DEEPER concrete widget this path never read,
// whose own client-populated list may be perfectly readable — so the premise "the valid set
// is not knowable from here" is not established. Refusing is the deliberate choice over
// validating the concrete widget: see the refusal's own comment for why.

test("#1126: the unreadable fallback REFUSES a nested promotion rather than writing blind", async () => {
  // outer SubgraphNode → intermediate SubgraphNode → concrete node. The widget the ladder
  // reads is the intermediate's projection (unreadable); the concrete widget below it has a
  // perfectly readable list that nothing on this path ever consulted.
  const reg = loadedRegistry(["StarOllamaPromptHelper"]);
  // Registered exactly as ComfyUI_frontend's registerSubgraphNodeDef builds them: the type
  // is the subgraph's UUID (never in /object_info) and the class carries the synthesized
  // nodeDef, so the #458/#512 authorization treats them as real containers rather than as
  // an uninstalled pack.
  const container = (uuid, id, widget, innerNode, innerId) => {
    const ctor = function ComfySubgraphNode() {};
    ctor.nodeData = { input: { required: {} }, name: uuid };
    ctor.comfyClass = uuid;
    reg[uuid] = ctor;
    return {
      id,
      type: uuid,
      constructor: ctor,
      subgraph: { _nodes: [innerNode], getNodeById: (x) => (String(x) === innerId ? innerNode : null) },
      inputs: [{ name: widget.name, _widget: widget, widget: { name: widget.name }, _subgraphSlot: { name: widget.name } }],
      widgets: [widget],
    };
  };
  const MID_UUID = "11111111-1111-4111-8111-111111111111";
  const OUTER_UUID = "22222222-2222-4222-8222-222222222222";
  const concreteWidget = { name: "model", type: "combo", options: { values: ["qwen3-vl:8b"] }, value: "" };
  const concrete = {
    id: 302,
    type: "StarOllamaPromptHelper",
    widgets: [concreteWidget],
    constructor: reg["StarOllamaPromptHelper"],
  };
  const midWidget = { name: "model_mid", type: "combo", options: { values: THROWS }, value: "" };
  const mid = container(MID_UUID, 301, midWidget, concrete, "302");
  const outerWidget = { name: "model_alias", type: "combo", options: { values: THROWS }, value: "" };
  const outer = container(OUTER_UUID, 320, outerWidget, mid, "301");
  const resolveSource = (_node, subgraphInput) => {
    if (subgraphInput?.name === "model_alias") return { sourceNodeId: "301", sourceWidgetName: "model_mid" };
    if (subgraphInput?.name === "model_mid") return { sourceNodeId: "302", sourceWidgetName: "model" };
    return null;
  };
  await assert.rejects(
    runSetWidget(outer, "model_alias", String.raw`F:\Downloads\Scarlet1.0.fbx`, {
      registry: reg,
      getRegistry: () => reg,
      getFreshObjectInfo: async () => starObjectInfo([]),
      // A virtual SubgraphNode's type is its subgraph UUID and is NEVER in /object_info by
      // design, so it must not read as a since-REMOVED backend type (#458) — only the
      // concrete node at the end of the chain was ever backend-defined.
      wasTypeEverDefined: (t) => t === "StarOllamaPromptHelper",
      resolveSource,
      ...HOOKS,
    }),
    (err) =>
      /panel_set_widget refused "model_alias" on node 320/.test(err.message) &&
      /NESTED promotion/.test(err.message) &&
      /may be readable/.test(err.message) &&
      /panel_enter_subgraph/.test(err.message),
  );
  assert.equal(concreteWidget.value, "", "the concrete widget is untouched");
  assert.equal(midWidget.value, "", "the intermediate projection is untouched");
  assert.equal(outerWidget.value, "", "the outer rail is untouched");
});

// ---- #1523: panel_add_node of a loaded subgraph UUID is not an unknown backend
//      node, and must never name an unrelated failed pack. ----------------------

const SAM3_UUID = "6e7ab3ea-96aa-470f-9b94-3d9d0e01f481";

function uuidSubgraphCtor(uuid) {
  const ctor = function ComfySubgraphNode() {};
  ctor.nodeData = { input: { required: {} }, name: uuid };
  ctor.comfyClass = uuid;
  return ctor;
}

function addOptsForSubgraph(reg, { rootGraph, readImportFailures } = {}) {
  return {
    getFreshObjectInfo: async () => objectInfo(),
    refresh: async () => {},
    wasTypeEverDefined: () => false,
    getRootGraph: () => rootGraph,
    readImportFailures:
      readImportFailures ?? (async () => ["comfyui-reactor-node"]),
  };
}

test("#1523 isSubgraphUuidType: RFC-4122 only", () => {
  assert.equal(isSubgraphUuidType(SAM3_UUID), true);
  assert.equal(isSubgraphUuidType("KSampler"), false);
  assert.equal(isSubgraphUuidType("SubgraphBlueprint.Image Segmentation (SAM3)"), false);
  assert.equal(isSubgraphUuidType(""), false);
  assert.equal(isSubgraphUuidType(null), false);
});

test("#1523 subgraphTypeIsLoaded: registry Map, nested instance, fail-closed", () => {
  const sub = { id: SAM3_UUID, _nodes: [] };
  const root = { subgraphs: new Map([[SAM3_UUID, sub]]), _nodes: [] };
  assert.equal(subgraphTypeIsLoaded(root, SAM3_UUID), true);

  const nested = {
    _nodes: [{ type: SAM3_UUID, subgraph: { id: SAM3_UUID, _nodes: [] } }],
  };
  assert.equal(subgraphTypeIsLoaded(nested, SAM3_UUID), true);

  assert.equal(subgraphTypeIsLoaded({ _nodes: [] }, SAM3_UUID), false);
  assert.equal(subgraphTypeIsLoaded(null, SAM3_UUID), false);
  assert.equal(subgraphTypeIsLoaded(root, "KSampler"), false);
});

test("#1523 add_node: loaded + registered SAM3 UUID is ADDABLE on a healthy backend that never lists it", async () => {
  const reg = loadedRegistry();
  reg[SAM3_UUID] = uuidSubgraphCtor(SAM3_UUID);
  const rootGraph = {
    subgraphs: new Map([[SAM3_UUID, { id: SAM3_UUID, _nodes: [] }]]),
    _nodes: [{ id: 1, type: SAM3_UUID }],
  };
  await assert.doesNotReject(() =>
    assertAddNodeResolvableRefreshing(() => reg, SAM3_UUID, addOptsForSubgraph(reg, { rootGraph })),
  );
});

test("#1523 add_node: the same UUID without a live definition is refused as a subgraph, not a missing pack", async () => {
  const reg = loadedRegistry();
  const err = await assertAddNodeResolvableRefreshing(
    () => reg,
    SAM3_UUID,
    addOptsForSubgraph(reg, { rootGraph: { _nodes: [] } }),
  ).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "an unloaded subgraph UUID must still be refused");
  assert.equal(
    err.message,
    subgraphUuidAddRefusal(SAM3_UUID, { loaded: false, registered: false }),
  );
  assert.doesNotMatch(err.message, /comfyui-reactor-node/);
  assert.doesNotMatch(err.message, /FAILED TO IMPORT/);
  assert.doesNotMatch(err.message, /Unknown node type/);
  assert.doesNotMatch(err.message, /not installed, its pack was removed/);
});

test("#1523 add_node: loaded but UNREGISTERED UUID is refused with copy-instance advice, never a pack note", async () => {
  const reg = loadedRegistry(); // SAM3 class not registered — createNode would mint a placeholder
  const rootGraph = {
    subgraphs: new Map([[SAM3_UUID, { id: SAM3_UUID, _nodes: [] }]]),
    _nodes: [{ id: 1, type: SAM3_UUID }],
  };
  const err = await assertAddNodeResolvableRefreshing(
    () => reg,
    SAM3_UUID,
    addOptsForSubgraph(reg, { rootGraph }),
  ).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "an unregistered class must still be refused");
  assert.equal(
    err.message,
    subgraphUuidAddRefusal(SAM3_UUID, { loaded: true, registered: false }),
  );
  assert.doesNotMatch(err.message, /comfyui-reactor-node/);
  assert.doesNotMatch(err.message, /FAILED TO IMPORT/);
});

test("#1523 add_node: the exemption requires the ever-seen oracle, like the frontend-only one", async () => {
  const reg = loadedRegistry();
  reg[SAM3_UUID] = uuidSubgraphCtor(SAM3_UUID);
  const rootGraph = {
    subgraphs: new Map([[SAM3_UUID, { id: SAM3_UUID, _nodes: [] }]]),
    _nodes: [],
  };
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(() => reg, SAM3_UUID, {
        getFreshObjectInfo: async () => objectInfo(),
        getRootGraph: () => rootGraph,
        // wasTypeEverDefined deliberately omitted
      }),
    (err) => {
      assert.equal(
        err.message,
        subgraphUuidAddRefusal(SAM3_UUID, { loaded: true, registered: true }),
      );
      return true;
    },
  );
});

test("#1523 add_node: an EVER-SEEN (removed) UUID still fails closed — the trust root is not bypassed", async () => {
  const reg = loadedRegistry();
  reg[SAM3_UUID] = uuidSubgraphCtor(SAM3_UUID);
  const rootGraph = {
    subgraphs: new Map([[SAM3_UUID, { id: SAM3_UUID, _nodes: [] }]]),
    _nodes: [],
  };
  await assert.rejects(
    () =>
      assertAddNodeResolvableRefreshing(() => reg, SAM3_UUID, {
        getFreshObjectInfo: async () => objectInfo(),
        wasTypeEverDefined: (t) => t === SAM3_UUID,
        getRootGraph: () => rootGraph,
      }),
    /defined this node type earlier this session|removed/i,
  );
});

test("#1523 add_node: isLoadedSubgraphType override is the positive proof, even without a graph", async () => {
  const reg = loadedRegistry();
  reg[SAM3_UUID] = uuidSubgraphCtor(SAM3_UUID);
  await assert.doesNotReject(() =>
    assertAddNodeResolvableRefreshing(() => reg, SAM3_UUID, {
      getFreshObjectInfo: async () => objectInfo(),
      wasTypeEverDefined: () => false,
      isLoadedSubgraphType: (t) => t === SAM3_UUID,
      readImportFailures: async () => ["comfyui-reactor-node"],
    }),
  );
});

test("#1523 add_node: a throwing isLoadedSubgraphType fails closed rather than authorizing", async () => {
  const reg = loadedRegistry();
  reg[SAM3_UUID] = uuidSubgraphCtor(SAM3_UUID);
  const err = await assertAddNodeResolvableRefreshing(() => reg, SAM3_UUID, {
    getFreshObjectInfo: async () => objectInfo(),
    wasTypeEverDefined: () => false,
    isLoadedSubgraphType: () => {
      throw new Error("graph unreadable");
    },
    readImportFailures: async () => ["comfyui-reactor-node"],
  }).then(
    () => null,
    (e) => e,
  );
  assert.equal(
    err.message,
    subgraphUuidAddRefusal(SAM3_UUID, { loaded: false, registered: true }),
  );
  assert.doesNotMatch(err.message, /graph unreadable/);
  assert.doesNotMatch(err.message, /comfyui-reactor-node/);
});

// ── mcp#1940 ─────────────────────────────────────────────────────────────────
// The V2 combo spec. Everything above declares combos in the V1 shape
// `[[opt, ...], config]`, where the option array IS `spec[0]`. A live ComfyUI 0.33
// /object_info publishes 676 inputs in the V2 shape instead —
// `["COMBO", { options: [...] }]` — with the literal type string "COMBO" at
// `spec[0]` and the list under the config object. `serverDeclaresEmptyComboOptions`
// tested `Array.isArray(spec[0])`, so every V2 combo was filed as "not a combo" and
// the #507 accept could never be reached: measured 0 of 11 server-declared-empty V2
// inputs recognised, against 30 of 30 V1.
//
// The reported node is verbatim from that rig:
//     "choice": ["COMBO", { "multiselect": false, "options": [] }]
// which made `CustomCombo.choice` permanently unwritable, blamed on a STALE list that
// no refresh could ever change.
function customComboFixture(liveOptions = []) {
  const reg = loadedRegistry(["CustomCombo"]);
  const widget = { name: "choice", type: "combo", options: { values: liveOptions }, value: "" };
  const node = { id: 816, type: "CustomCombo", widgets: [widget], constructor: reg["CustomCombo"] };
  return { reg, node, widget };
}
// /object_info in which CustomCombo's `choice` is declared in the V2 shape.
function customComboObjectInfo(config) {
  const info = objectInfo(["CustomCombo"]);
  info["CustomCombo"] = { input: { required: { choice: ["COMBO", config] } } };
  return info;
}

test("mcp#1940 e2e: a V2 combo whose SERVER option list is empty becomes writable", async () => {
  const { reg, node, widget } = customComboFixture([]);
  const res = await runSetWidget(node, "choice", "Default", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => customComboObjectInfo({ multiselect: false, options: [] }),
    wasTypeEverDefined: () => true,
    refreshCombos: refreshFromServer,
    ...HOOKS,
  });
  assert.equal(res.set.value, "Default");
  assert.equal(widget.value, "Default", "the write reached the live widget");
  assert.equal(res.empty_option_list, true, "reported honestly as an unvalidatable empty list");
});

test("mcp#1940 e2e: a V2 combo with a REAL server list is still validated STRICTLY", async () => {
  // The fix must not turn "V2" into a blanket accept. A V2 spec that publishes a real
  // list is refreshed and enforced exactly like V1: a member lands, a non-member is
  // refused and nothing is written.
  const config = { multiselect: false, options: ["Quality", "Default", "Turbo"] };
  const ok = customComboFixture([]);
  const res = await runSetWidget(ok.node, "choice", "Turbo", {
    registry: ok.reg,
    getRegistry: () => ok.reg,
    getFreshObjectInfo: async () => customComboObjectInfo(config),
    wasTypeEverDefined: () => true,
    refreshCombos: refreshFromServer,
    ...HOOKS,
  });
  assert.equal(ok.widget.value, "Turbo");
  assert.notEqual(res.empty_option_list, true, "a real list is not the empty-list path");

  const bad = customComboFixture([]);
  await assert.rejects(
    () =>
      runSetWidget(bad.node, "choice", "Nonexistent", {
        registry: bad.reg,
        getRegistry: () => bad.reg,
        getFreshObjectInfo: async () => customComboObjectInfo(config),
        wasTypeEverDefined: () => true,
        refreshCombos: refreshFromServer,
        ...HOOKS,
      }),
    /not a valid option|refused/i,
  );
  assert.equal(bad.widget.value, "", "an off-list value is still refused (#240 intact)");
});

test("mcp#1940: serverDeclaresEmptyComboOptions reads the V2 shape, and still refuses to guess", () => {
  const defs = {
    T: {
      input: {
        required: {
          v2empty: ["COMBO", { multiselect: false, options: [] }],
          v2full: ["COMBO", { options: ["a", "b"] }],
          // The list is a SEPARATE fetch that has not landed. Unread is not empty.
          v2remote: ["COMBO", { remote: { route: "/internal/files/output" } }],
          // The keys select SUB-INPUTS to materialize; they are not an option list.
          v3dynamic: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "png" }] }],
          v1empty: [[], {}],
          v1full: [["a"], {}],
          notacombo: ["STRING", {}],
        },
        optional: { v2optEmpty: ["COMBO", { options: [] }] },
      },
    },
  };
  assert.equal(serverDeclaresEmptyComboOptions(defs, "T", "v2empty"), true);
  assert.equal(serverDeclaresEmptyComboOptions(defs, "T", "v2optEmpty"), true, "optional inputs count too");
  assert.equal(serverDeclaresEmptyComboOptions(defs, "T", "v2full"), false);
  // Both of these are "could not read the list", which must fail CLOSED — never be
  // mistaken for the server declaring the list empty.
  assert.equal(serverDeclaresEmptyComboOptions(defs, "T", "v2remote"), false, "an unlanded remote list is not an empty one");
  assert.equal(serverDeclaresEmptyComboOptions(defs, "T", "v3dynamic"), false, "dynamic V3 keys are not an option list");
  // V1 and non-combo behaviour is unchanged.
  assert.equal(serverDeclaresEmptyComboOptions(defs, "T", "v1empty"), true);
  assert.equal(serverDeclaresEmptyComboOptions(defs, "T", "v1full"), false);
  assert.equal(serverDeclaresEmptyComboOptions(defs, "T", "notacombo"), false);
});

// The REPORTED shape end-to-end: a subgraph instance promoting a V2 empty COMBO.
// mcp#1940 was filed as a promoted-widget bug — "cannot set ANY promoted COMBO on a
// subgraph node" — so a fix for the combo SHAPE has to be shown to clear the actual
// reported scenario, not just a bare node. The promotion resolves to the concrete
// inner CustomCombo (`followPromotionToConcrete`), which is the type whose def the
// empty-list gate reads; before the fix that read said "not a combo" and the write
// was refused with a stale-list message no refresh could clear.
function promotedCustomComboFixture() {
  const inner = {
    id: 795,
    type: "CustomCombo",
    // Empty live list — nothing for the parent rail to project either.
    widgets: [{ name: "choice", type: "combo", options: { values: [] }, value: "" }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "795" ? inner : null) };
  const railWidget = { name: "mode", type: "combo", options: { values: [] }, value: "" };
  const parent = {
    id: 816,
    // The synthetic subgraph UUID from the report — never in /object_info, and never
    // looked up: the promotion is traversed to the inner type instead.
    type: "6c697765-ebd7-4e1e-8af0-d84d620be471",
    subgraph,
    inputs: [{ name: "mode", _widget: railWidget, _subgraphSlot: { name: "mode" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_n, si) =>
    si?.name === "mode" ? { sourceNodeId: "795", sourceWidgetName: "choice" } : null;
  return { parent, inner, resolveSource };
}

test("mcp#1940 e2e: a PROMOTED V2 empty combo on a subgraph instance is settable from the parent", async () => {
  const reg = loadedRegistry(["CustomCombo"]);
  reg["6c697765-ebd7-4e1e-8af0-d84d620be471"] = reg["SubgraphNode"] ?? function SubgraphNode() {};
  const { parent, inner, resolveSource } = promotedCustomComboFixture();
  const fresh = objectInfo(["CustomCombo"]);
  fresh["CustomCombo"] = { input: { required: { choice: ["COMBO", { multiselect: false, options: [] }] } } };
  const res = await runSetWidget(parent, "mode", "Default", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => fresh,
    // The UUID was NEVER a backend type — it is a subgraph. Answering `true` here
    // would claim its absence from /object_info means an uninstalled pack (#458).
    wasTypeEverDefined: (t) => t === "CustomCombo",
    refreshCombos: refreshFromServer,
    resolveSource,
    ...HOOKS,
  });
  assert.equal(res.set.value, "Default");
  assert.equal(res.set.promoted_from.inner_node_id, 795, "resolved through the promotion, not the UUID");
  assert.equal(
    inner.widgets.find((w) => w.name === "choice").value,
    "Default",
    "the value reached the inner widget the rail projects",
  );
});
