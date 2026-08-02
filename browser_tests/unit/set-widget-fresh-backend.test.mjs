/**
 * Unit tests for the FRESH-BACKEND type authorization in web/js/lib/set-widget.js
 * — run with `node --test`.
 *
 * The #458 set_widget gap (found in review of #375): graph_set_widget authorized
 * the target node's type SOLELY from the mutable LiteGraph registry. That registry
 * keeps a STALE POSITIVE for an uninstalled pack when the browser tab was never
 * reloaded after a ComfyUI restart, so a since-removed type ("GoneNode") sailed
 * through every registry guard and the write reported a fabricated SUCCESS against
 * a backend that no longer defines it. graph_add_node already authorizes its
 * class_type against the CURRENT /object_info; these tests prove graph_set_widget
 * now authorizes the RESOLVED write target's type against the same fresh oracle.
 *
 * They drive the REAL production handler body (runSetWidget) — the SAME async unit
 * GRAPH_TOOL_EXECUTORS.graph_set_widget delegates to — with the fresh-oracle
 * capability wired exactly as the handler wires it (getRegistry / getFreshObjectInfo
 * / refreshCombos). So dropping the fresh gate, or letting it fall back to the stale
 * registry, fails a test.
 *
 * Invariants under test:
 *   1. REMOVED type (stale registry positive, ABSENT from fresh /object_info)
 *      ⇒ FAIL CLOSED, no mutation — even though every registry-only guard passes.
 *   2. Backend UNREACHABLE (fresh /object_info returns null) ⇒ FAIL CLOSED.
 *   3. Transient fetch REJECTION ⇒ FAIL CLOSED (never trust the stale registry).
 *   4. A LIVE VALID type (present in fresh /object_info + registry) ⇒ still succeeds,
 *      fetching /object_info exactly once (hot path).
 *   5. The stale-combo refresh retry (#338/#317/#299/#288) still works with the
 *      fresh oracle wired, WITHOUT a second /object_info fetch.
 *   6. No fresh-oracle wired ⇒ degrades to the registry guard (back-compat).
 *   7. A subgraph PROMOTED write authorizes the INNER target's type (removed/
 *      unreachable ⇒ fail closed; live ⇒ succeeds), and the promoted target is
 *      resolved exactly ONCE so the write can't re-resolve to a swapped-in node.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import { refreshComboOptionsFromDefs } from "../../web/js/lib/asset-staleness.js";

// A registry shaped like LG.registered_node_types once /object_info loaded. Each
// entry carries a `.nodeData` def (registerNodesFromDefs stamps one per class), so
// a genuinely-resolved instance passes the stale-placeholder-instance cross-check.
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
    const ctor = function NodeCtor() {};
    ctor.nodeData = { input: { required: {} } };
    reg[t] = ctor;
  }
  return reg;
}

// Fresh /object_info map (class_type -> def), the authoritative oracle.
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

// A GENUINELY-RESOLVED node instance: its own constructor carries the live def, so
// the registry-only placeholder-instance guard is satisfied. This is deliberate —
// it proves ONLY the fresh oracle catches a removed type, not any registry check.
function regNode(type, widgets, extra = {}) {
  return {
    id: 3,
    type,
    widgets,
    constructor: { nodeData: { input: { required: {} } } },
    ...extra,
  };
}

const HOOKS = { beforeChange() {}, afterChange() {}, setDirty() {} };

test("#458 set_widget: REMOVED type (stale registry positive, absent from fresh object_info) ⇒ FAIL CLOSED, no mutation", async () => {
  // GoneNode's pack was uninstalled + ComfyUI restarted WITHOUT a tab reload: the
  // registry still holds it (with a def) AND the instance is genuinely-resolved, so
  // every registry-only guard passes. The fresh /object_info no longer lists it.
  const reg = loadedRegistry(["GoneNode"]);
  const node = regNode("GoneNode", [{ name: "steps", type: "INT", value: 20 }]);
  await assert.rejects(
    () =>
      runSetWidget(node, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // backend no longer provides GoneNode
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 3 \("GoneNode"\)/.test(err.message) &&
      /backend does not provide/i.test(err.message),
  );
  assert.equal(node.widgets[0].value, 20, "value must NOT be mutated on a removed type");
});

test("#458 set_widget: REMOVED type carrying a truthy `subgraph` field (no promoted match) ⇒ FAIL CLOSED (subgraph-shaped bypass)", async () => {
  // The subgraph-shaped bypass: a stale GoneNode survives in the registry (with a
  // matching instance def) AND carries a truthy `subgraph:{}` field, but the write
  // targets its OWN widget (resolvePromotedInnerTarget → {promoted:false}). A truthy
  // `subgraph` field must NOT exempt it from fresh authorization — otherwise authTarget
  // would be null, preflight would skip (subgraph parents skip the registry preflight),
  // and only the STALE registry guard would run, fabricating success on a removed type.
  const reg = loadedRegistry(["GoneNode"]);
  const node = regNode("GoneNode", [{ name: "steps", type: "INT", value: 20 }], { subgraph: {} });
  await assert.rejects(
    () =>
      runSetWidget(node, "steps", 7, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => ({ KSampler: {} }), // backend does NOT provide GoneNode
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 3 \("GoneNode"\)/.test(err.message) &&
      /backend does not provide/i.test(err.message),
  );
  assert.equal(node.widgets[0].value, 20, "removed subgraph-shaped node must NOT be mutated");
});

test("#458 set_widget: backend UNREACHABLE (fresh object_info null) ⇒ FAIL CLOSED, no mutation", async () => {
  const reg = loadedRegistry();
  const node = regNode("KSampler", [{ name: "steps", type: "INT", value: 20 }]);
  await assert.rejects(
    () =>
      runSetWidget(node, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null, // fetch unavailable
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 3 \("KSampler"\)/.test(err.message) &&
      /cannot verify node type|object_info is unavailable|backend is unreachable/i.test(err.message),
  );
  assert.equal(node.widgets[0].value, 20, "value must NOT be mutated when the backend is unverifiable");
});

test("#458 set_widget: transient fetch REJECTION ⇒ FAIL CLOSED (never trust the stale registry)", async () => {
  const reg = loadedRegistry(["GoneNode"]); // registry HIT survives
  const node = regNode("GoneNode", [{ name: "steps", type: "INT", value: 20 }]);
  await assert.rejects(
    () =>
      runSetWidget(node, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => {
          throw new Error("object_info fetch failed (transient)");
        },
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /cannot verify (the )?node type|object_info is unavailable/i.test(err.message),
  );
  assert.equal(node.widgets[0].value, 20);
});

test("#458 set_widget: LIVE VALID type (in fresh object_info + registry) ⇒ still succeeds", async () => {
  const reg = loadedRegistry();
  const node = regNode("KSampler", [{ name: "steps", type: "INT", value: 20 }]);
  let objectInfoFetches = 0;
  const res = await runSetWidget(node, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => {
      objectInfoFetches++;
      return objectInfo();
    },
    ...HOOKS,
  });
  assert.equal(res.set.value, 30);
  assert.equal(node.widgets[0].value, 30);
  assert.equal(objectInfoFetches, 1, "hot path fetches fresh object_info exactly once");
});

test("#458 set_widget: stale-combo refresh retry STILL works with the fresh oracle wired (#338)", async () => {
  // The type is LIVE (passes the fresh oracle) but the combo option list is stale —
  // the just-staged value is accepted only after refreshCombos pulls the fresh list.
  const reg = loadedRegistry();
  const widget = { name: "image", type: "combo", options: { values: ["old_a.png"] }, value: "old_a.png" };
  const node = regNode("LoadImage", [widget]);
  let objectInfoFetches = 0;
  let comboRefreshes = 0;
  const res = await runSetWidget(node, "image", "just_staged.png", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => {
      objectInfoFetches++;
      return objectInfo();
    },
    refreshCombos: async () => {
      comboRefreshes++;
      widget.options.values = ["old_a.png", "just_staged.png"];
    },
    ...HOOKS,
  });
  assert.equal(res.set.value, "just_staged.png");
  assert.equal(res.refreshed, true, "combo refresh retry path still runs");
  assert.equal(comboRefreshes, 1, "combo refresh attempted exactly once");
  assert.equal(objectInfoFetches, 1, "type authorization fetches fresh object_info exactly once (hot path)");
});

test("#458 P2: combo retry reuses the AUTH /object_info via the PRODUCTION refreshCombos — exactly ONE getNodeDefs total", async () => {
  // Drives the REAL production refreshCombos wiring (refreshComboOptionsFromDefs from
  // the already-fetched defs, with a full-refresh FALLBACK) rather than a stub, so it
  // proves the auth fetch + combo recovery make a SINGLE api.getNodeDefs() call. The
  // fresh /object_info encodes LoadImage's combo INCLUDING the just-staged value, so
  // the retry refreshes the widget's options from that payload — no second fetch.
  const reg = loadedRegistry();
  const widget = { name: "image", type: "combo", options: { values: ["old_a.png"] }, value: "old_a.png" };
  const node = regNode("LoadImage", [widget]);

  const FRESH = objectInfo();
  FRESH.LoadImage = { input: { required: { image: [["old_a.png", "just_staged.png"], {}] } } };

  let getNodeDefsCalls = 0;
  // The single backend fetch primitive — BOTH the auth oracle and the production
  // fallback refresh route through it, so this counter is the total /object_info hits.
  const getNodeDefs = async () => {
    getNodeDefsCalls++;
    return FRESH;
  };
  let fallbackRefreshes = 0;
  const refreshComfyNodeDefs = async (defs) => {
    fallbackRefreshes++;
    if (!defs) await getNodeDefs(); // the real fallback re-fetches /object_info
  };

  const res = await runSetWidget(node, "image", "just_staged.png", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: () => getNodeDefs(),
    // EXACT production wiring from comfyui-mcp-panel.js: when defs are present, refresh
    // this target's combo options in place (keyed on the concrete type) and NEVER
    // re-fetch; only a missing payload falls back to the full (re-fetching) refresh.
    refreshCombos: (defs, target, concreteType, nameMap) => {
      if (defs) {
        refreshComboOptionsFromDefs(target, defs, concreteType, nameMap);
        return;
      }
      return refreshComfyNodeDefs();
    },
    ...HOOKS,
  });

  assert.equal(res.set.value, "just_staged.png");
  assert.equal(res.refreshed, true, "combo recovery ran and the retry succeeded");
  assert.equal(fallbackRefreshes, 0, "no full-refresh fallback — combos came from the cached defs");
  assert.equal(getNodeDefsCalls, 1, "exactly ONE /object_info fetch across auth + combo retry (#458 P2)");
  assert.equal(widget.value, "just_staged.png");
});

test("#458 P2: defs present but nothing refreshable (dynamic/non-array combo) ⇒ STILL no second fetch, fails closed", async () => {
  // Codex regression guard: when refreshComboOptionsFromDefs updates 0 widgets (the
  // fresh def exposes no array-backed option list for this widget), the production
  // callback must NOT fall back to the re-fetching full refresh just because the
  // update count was 0 — a present payload means single-fetch, period. A genuinely
  // invalid value then stays rejected on the retry.
  const reg = loadedRegistry();
  const widget = { name: "image", type: "combo", options: { values: ["old_a.png"] }, value: "old_a.png" };
  const node = regNode("LoadImage", [widget]);

  const FRESH = objectInfo();
  // LoadImage present (auth passes) but its `image` input is a TYPE, not an option
  // array — so refreshComboOptionsFromDefs finds nothing to refresh (returns 0).
  FRESH.LoadImage = { input: { required: { image: ["IMAGE", {}] } } };

  let getNodeDefsCalls = 0;
  const getNodeDefs = async () => {
    getNodeDefsCalls++;
    return FRESH;
  };
  let fallbackRefreshes = 0;

  await assert.rejects(
    () =>
      runSetWidget(node, "image", "never_valid.png", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: () => getNodeDefs(),
        refreshCombos: (defs, target, concreteType, nameMap) => {
          if (defs) {
            refreshComboOptionsFromDefs(target, defs, concreteType, nameMap);
            return;
          }
          fallbackRefreshes++;
          return getNodeDefs(); // the re-fetching fallback — must NOT run here
        },
        ...HOOKS,
      }),
    (err) => err instanceof Error && /not a valid option/.test(err.message),
  );
  assert.equal(fallbackRefreshes, 0, "present payload must never trigger the re-fetching fallback");
  assert.equal(getNodeDefsCalls, 1, "exactly ONE /object_info fetch even when nothing was refreshable (#458 P2)");
  assert.equal(widget.value, "old_a.png", "no mutation on a genuinely-invalid value");
});

test("#458 set_widget: NO fresh-oracle wired ⇒ FAIL CLOSED (never authorize from the stale registry)", async () => {
  // P1-A: a caller that omits getFreshObjectInfo must NOT fall back to the stale
  // registry — that would reopen the exact #458 false-success hole (a stale-positive
  // GoneNode would write + report success). Even a registered live type is refused
  // when the backend can't be consulted; the panel always wires the oracle.
  const reg = loadedRegistry(["GoneNode"]);
  const node = regNode("GoneNode", [{ name: "steps", type: "INT", value: 20 }]);
  await assert.rejects(
    () => runSetWidget(node, "steps", 30, { registry: reg, ...HOOKS }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 3 \("GoneNode"\)/.test(err.message) &&
      /no \/object_info oracle is wired|cannot verify/i.test(err.message),
  );
  assert.equal(node.widgets[0].value, 20, "must not mutate when the backend can't be verified");
});

// A real SubgraphNode whose promoted "sched_alias" input maps to an inner node's
// "scheduler" widget. innerType flips the inner node between a live type and a
// since-removed one so the fresh oracle can be exercised on the RESOLVED target.
function makeSubgraphFixture(innerType) {
  const inner = {
    id: 54,
    type: innerType,
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  // #366: the AUTHORITATIVE parent rail projection — object-identity linked from the
  // host input (`_widget`) and a live member of parent.widgets. Required so a promoted
  // write can identify + sync the rail; without it the write fails closed.
  const railWidget = { name: "sched_alias", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph: { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) },
    inputs: [{ name: "sched_alias", _widget: railWidget, widget: { name: "sched_alias" }, _subgraphSlot: { name: "sched_alias" } }],
    widgets: [
      { name: "scheduler", type: "combo", options: { values: ["simple"] }, value: 999 }, // decoy own-widget (#233)
      railWidget,
    ],
  };
  const resolveSource = (_n, si) =>
    si?.name === "sched_alias" ? { sourceNodeId: "54", sourceWidgetName: "scheduler" } : null;
  return { parent, inner, railWidget, resolveSource };
}

test("#458 set_widget: SUBGRAPH promoted write to a LIVE inner type ⇒ succeeds (inner type fresh-authorized)", async () => {
  const reg = loadedRegistry();
  const { parent, inner, resolveSource } = makeSubgraphFixture("KSampler");
  const { set } = await runSetWidget(parent, "sched_alias", "karras", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(), // backend defines KSampler
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, "karras");
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "karras");
});

test("#458 set_widget: SUBGRAPH promoted write to a REMOVED inner type ⇒ FAIL CLOSED, inner untouched", async () => {
  // The inner GoneNode survives in the stale registry (with a def + resolved
  // instance) so every registry-only guard passes — but the fresh /object_info no
  // longer lists it. The promoted write must be refused, not fabricated as success.
  const reg = loadedRegistry(["GoneNode"]);
  const { parent, inner, resolveSource } = makeSubgraphFixture("GoneNode");
  await assert.rejects(
    () =>
      runSetWidget(parent, "sched_alias", "karras", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // backend no longer provides GoneNode
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 54 \("GoneNode"\)/.test(err.message) &&
      /Unknown node type "GoneNode"|backend does not provide/i.test(err.message),
  );
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "simple", "inner widget untouched");
});

test("#458 set_widget: SUBGRAPH promoted write with UNREACHABLE backend ⇒ FAIL CLOSED, inner untouched", async () => {
  const reg = loadedRegistry();
  const { parent, inner, resolveSource } = makeSubgraphFixture("KSampler");
  await assert.rejects(
    () =>
      runSetWidget(parent, "sched_alias", "karras", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => {
          throw new Error("object_info fetch failed (transient)");
        },
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 54 \("KSampler"\)/.test(err.message) &&
      /cannot verify (the )?node type|object_info is unavailable/i.test(err.message),
  );
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "simple", "inner widget untouched");
});

// A TWO-LEVEL nested promotion: outer subgraph A promotes "steps" from inner subgraph
// B, which promotes "steps" from a concrete node. ComfyUI supports this. The immediate
// resolved target of A's promotion is the VIRTUAL node B (subgraph id not in
// /object_info); fresh-auth must TRAVERSE A→B→concrete and authorize the concrete type.
function makeNestedSubgraphFixture(reg, concreteType) {
  const concrete = {
    id: 90,
    type: concreteType,
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const b = {
    id: 80,
    type: "SubgraphB", // virtual subgraph id — absent from /object_info
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [concrete], getNodeById: (id) => (String(id) === "90" ? concrete : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  // #366 rail projection on the OUTER node A (the write resolves A→B one level, so A's
  // host input must carry the authoritative rail widget present in A.widgets).
  const aRail = { name: "steps", type: "INT", value: 20 };
  const a = {
    id: 70,
    type: "SubgraphA", // virtual
    widgets: [{ name: "steps_decoy", type: "INT", value: 999 }, aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "steps", _widget: aRail, widget: { name: "steps" }, _subgraphSlot: { name: "steps" } }],
  };
  // Virtual subgraph nodes register as native/defless types (no nodeData) — the write's
  // registry guard trusts them, exactly like real litegraph subgraph instances.
  reg.SubgraphA = function SubgraphA() {};
  reg.SubgraphB = function SubgraphB() {};
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "steps") return { sourceNodeId: "80", sourceWidgetName: "steps" };
    if (subgraphNode === b && si?.name === "steps") return { sourceNodeId: "90", sourceWidgetName: "steps" };
    return null;
  };
  return { a, b, concrete, resolveSource };
}

test("#458 set_widget: NESTED promotion (A→B→KSampler) authorizes the CONCRETE type ⇒ succeeds (not falsely refused)", async () => {
  // The false-failure: authorizing the immediate inner target (virtual SubgraphB,
  // absent from /object_info) would refuse a valid write. Following the chain to the
  // concrete KSampler (present in fresh defs) lets the write proceed.
  const reg = loadedRegistry();
  const { a, b, resolveSource } = makeNestedSubgraphFixture(reg, "KSampler");
  const { set } = await runSetWidget(a, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(), // KSampler present; SubgraphA/B are NOT
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, 30, "nested promoted write is authorized via the concrete type and succeeds");
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 30);
});

test("#458 set_widget: NESTED promotion whose ULTIMATE CONCRETE type is REMOVED ⇒ FAIL CLOSED", async () => {
  // The chain A→B→GoneNode resolves to a concrete node the backend no longer provides
  // — traversal reaches GoneNode and fresh-auth refuses it (removed pack stays closed).
  const reg = loadedRegistry(["GoneNode"]);
  const { a, b, resolveSource } = makeNestedSubgraphFixture(reg, "GoneNode");
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // backend does NOT provide GoneNode
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 90 \("GoneNode"\)/.test(err.message) &&
      /backend does not provide/i.test(err.message),
  );
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 20, "nested write refused — no mutation");
});

test("#458 set_widget: NESTED promotion to a STALE concrete INSTANCE (registered type, no instance def) ⇒ FAIL CLOSED", async () => {
  // The stale-INSTANCE bypass: A→B(virtual)→KSampler, where the concrete KSampler
  // instance is a STALE generic placeholder (constructor carries NO nodeData — the
  // workflow was loaded while ComfyUI was down). Its TYPE is live in /object_info, so
  // fresh TYPE auth passes; but applyWidgetWrite only instance-checks the IMMEDIATE
  // virtual node B (defless/trusted), so without the concrete-instance guard the stale
  // KSampler would be mutated through B's forwarding callback. Must fail closed.
  const reg = loadedRegistry();
  const { a, b, concrete, resolveSource } = makeNestedSubgraphFixture(reg, "KSampler");
  concrete.constructor = { name: "GenericFallback" }; // stale placeholder: no nodeData
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // KSampler live on the backend
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error && /unresolved placeholder|live definition is missing/i.test(err.message),
  );
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 20, "stale concrete instance never mutated");
});

test("#458 set_widget: NESTED chain with an UNRESOLVABLE deeper link ⇒ FAIL CLOSED (no write through the registry guard)", async () => {
  // A→B resolves, but B's deeper promotion is stale/unresolvable. The chain can't reach
  // a concrete node, so the ultimate type is unverifiable — must fail closed rather than
  // mutate the immediate virtual node B behind only the (defless-trusting) registry guard.
  const reg = loadedRegistry();
  const { a, b, resolveSource } = makeNestedSubgraphFixture(reg, "KSampler");
  // Break B's deeper link: resolveSource returns nothing for B.
  const brokenSource = (subgraphNode, si) =>
    subgraphNode === a && si?.name === "steps" ? { sourceNodeId: "80", sourceWidgetName: "steps" } : null;
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(),
        resolveSource: brokenSource,
        ...HOOKS,
      }),
    (err) => err instanceof Error && /could not be resolved to a concrete backend node/.test(err.message),
  );
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 20, "no mutation on an unresolvable deeper link");
});

test("#458 set_widget: NESTED chain ending on a terminal VIRTUAL own-widget ⇒ FAIL CLOSED (virtual type never treated as concrete)", async () => {
  // A→B resolves, but B's "steps" is B's OWN (non-promoted) widget — the chain ends on a
  // virtual node. A virtual subgraph type is never in /object_info, so treating it as a
  // verified concrete node would be wrong; fail closed.
  const reg = loadedRegistry();
  const { a, b, resolveSource } = makeNestedSubgraphFixture(reg, "KSampler");
  b.inputs = []; // B no longer promotes "steps" — it becomes B's own virtual widget
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(),
        resolveSource,
        ...HOOKS,
      }),
    (err) => err instanceof Error && /could not be resolved to a concrete backend node/.test(err.message),
  );
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 20, "no mutation on a terminal virtual own-widget");
});

test("#458 set_widget: NESTED chain ending on a concrete node with NO string type ⇒ FAIL CLOSED", async () => {
  // A→B→{type: undefined}: the terminal node has no `.subgraph` but also no real type,
  // so it cannot be authorized against /object_info. It must NOT slip through the
  // "no string type ⇒ skip auth" gap and mutate the immediate virtual node B.
  const reg = loadedRegistry();
  const { a, b, concrete, resolveSource } = makeNestedSubgraphFixture(reg, "KSampler");
  concrete.type = undefined; // malformed terminal — no backend type to verify
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(),
        resolveSource,
        ...HOOKS,
      }),
    (err) => err instanceof Error && /could not be resolved to a concrete backend node/.test(err.message),
  );
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 20, "no mutation on a typeless concrete terminal");
});

test("#458 set_widget: NESTED promotion CYCLE ⇒ FAIL CLOSED (terminates, no mutation)", async () => {
  // A→B→A cycle: followPromotionToConcrete's seen-set breaks the loop and reports no
  // concrete node, so the write fails closed instead of spinning or authorizing a virtual.
  const reg = loadedRegistry();
  const { a, b, resolveSource } = makeNestedSubgraphFixture(reg, "KSampler");
  // Make B promote back to A (id 70), and let A be reachable from B's subgraph.
  b.subgraph.getNodeById = (id) => (String(id) === "70" ? a : String(id) === "90" ? b.subgraph._nodes[0] : null);
  const cyclicSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "steps") return { sourceNodeId: "80", sourceWidgetName: "steps" };
    if (subgraphNode === b && si?.name === "steps") return { sourceNodeId: "70", sourceWidgetName: "steps" };
    return null;
  };
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(),
        resolveSource: cyclicSource,
        ...HOOKS,
      }),
    (err) => err instanceof Error && /could not be resolved to a concrete backend node/.test(err.message),
  );
});

test("#458 set_widget: NESTED promoted COMBO recovery keys on the CONCRETE type ⇒ just-staged value accepted (not falsely rejected)", async () => {
  // A promotes B's `image`; B promotes LoadImage.image. B's exposed combo is stale
  // (missing a just-uploaded image), but fresh /object_info lists it under the CONCRETE
  // LoadImage def. The retry must refresh B's widget from LoadImage's options (keyed on
  // the concrete type), NOT the virtual SubgraphB (absent from /object_info) — otherwise
  // a legit just-uploaded image on a nested-promoted combo is wrongly rejected.
  const reg = loadedRegistry();
  reg.SubgraphA = function SubgraphA() {};
  reg.SubgraphB = function SubgraphB() {};
  const loadImage = {
    id: 90,
    type: "LoadImage",
    widgets: [{ name: "image", type: "combo", options: { values: ["old.png"] }, value: "old.png" }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const b = {
    id: 80,
    type: "SubgraphB",
    widgets: [{ name: "image", type: "combo", options: { values: ["old.png"] }, value: "old.png" }],
    subgraph: { _nodes: [loadImage], getNodeById: (id) => (String(id) === "90" ? loadImage : null) },
    inputs: [{ name: "image", _subgraphSlot: { name: "image" } }],
  };
  // #366 rail projection on the OUTER node A (the write resolves A→B one level).
  const aRail = { name: "image", type: "combo", options: { values: ["old.png"] }, value: "old.png" };
  const a = {
    id: 70,
    type: "SubgraphA",
    widgets: [aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "image", _widget: aRail, widget: { name: "image" }, _subgraphSlot: { name: "image" } }],
  };
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "image") return { sourceNodeId: "80", sourceWidgetName: "image" };
    if (subgraphNode === b && si?.name === "image") return { sourceNodeId: "90", sourceWidgetName: "image" };
    return null;
  };

  // Fresh /object_info: LoadImage's `image` combo now lists the just-uploaded file;
  // SubgraphA/B are virtual and absent (as they always are).
  const FRESH = objectInfo();
  FRESH.LoadImage = { input: { required: { image: [["old.png", "new_upload.png"], {}] } } };

  let getNodeDefsCalls = 0;
  const getNodeDefs = async () => {
    getNodeDefsCalls++;
    return FRESH;
  };

  const res = await runSetWidget(a, "image", "new_upload.png", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: () => getNodeDefs(),
    // Production wiring: refresh the write-target node's combos keyed on the CONCRETE type.
    refreshCombos: (defs, target, concreteType, nameMap) => {
      if (defs) {
        refreshComboOptionsFromDefs(target, defs, concreteType, nameMap);
        return;
      }
      return getNodeDefs();
    },
    resolveSource,
    ...HOOKS,
  });

  assert.equal(res.set.value, "new_upload.png", "nested promoted combo accepts the just-staged value after concrete refresh");
  assert.equal(res.refreshed, true);
  assert.equal(b.widgets.find((w) => w.name === "image").value, "new_upload.png");
  assert.equal(getNodeDefsCalls, 1, "single /object_info fetch across auth + nested combo retry");
});

test("#458×#366 set_widget: RENAMED nested promoted COMBO recovery bridges the widget name ⇒ value accepted", async () => {
  // #366 supports RENAMED promotions: A exposes "img_a" → B's "img_b" → LoadImage's
  // "image". The stale combo lives on B's "img_b" widget, but its authoritative options
  // live under the CONCRETE def's "image" input. The retry must bridge img_b → image
  // (the ultimate concrete widget name) — keying by the mutated widget's own name would
  // find nothing in LoadImage's def and reject a valid just-staged value.
  const reg = loadedRegistry();
  reg.SubgraphA = function SubgraphA() {};
  reg.SubgraphB = function SubgraphB() {};
  const loadImage = {
    id: 90,
    type: "LoadImage",
    widgets: [{ name: "image", type: "combo", options: { values: ["old.png"] }, value: "old.png" }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const b = {
    id: 80,
    type: "SubgraphB",
    widgets: [{ name: "img_b", type: "combo", options: { values: ["old.png"] }, value: "old.png" }],
    subgraph: { _nodes: [loadImage], getNodeById: (id) => (String(id) === "90" ? loadImage : null) },
    inputs: [{ name: "img_b", _subgraphSlot: { name: "img_b" } }],
  };
  const aRail = { name: "img_a", type: "combo", options: { values: ["old.png"] }, value: "old.png" };
  const a = {
    id: 70,
    type: "SubgraphA",
    widgets: [aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "img_a", _widget: aRail, widget: { name: "img_a" }, _subgraphSlot: { name: "img_a" } }],
  };
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "img_a") return { sourceNodeId: "80", sourceWidgetName: "img_b" };
    if (subgraphNode === b && si?.name === "img_b") return { sourceNodeId: "90", sourceWidgetName: "image" };
    return null;
  };

  const FRESH = objectInfo();
  FRESH.LoadImage = { input: { required: { image: [["old.png", "new_upload.png"], {}] } } };
  let getNodeDefsCalls = 0;
  const getNodeDefs = async () => {
    getNodeDefsCalls++;
    return FRESH;
  };

  const res = await runSetWidget(a, "img_a", "new_upload.png", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: () => getNodeDefs(),
    refreshCombos: (defs, target, concreteType, nameMap) => {
      if (defs) {
        refreshComboOptionsFromDefs(target, defs, concreteType, nameMap);
        return;
      }
      return getNodeDefs();
    },
    resolveSource,
    ...HOOKS,
  });

  assert.equal(res.set.value, "new_upload.png", "renamed nested promoted combo accepts the just-staged value");
  assert.equal(res.refreshed, true);
  assert.equal(b.widgets.find((w) => w.name === "img_b").value, "new_upload.png");
  assert.equal(getNodeDefsCalls, 1, "single /object_info fetch across auth + renamed nested combo retry");
});

test("#458×#366 set_widget: promoted write reuses the THREADED resolution AND syncs the authoritative rail (composed)", async () => {
  // #423 threads the resolution the fresh-auth gate used into applyWidgetWrite, so the
  // write targets the authorized inner node; #366 syncs the authoritative parent rail
  // atomically. A decoy sibling node (GoneNode) sits in the same subgraph and must
  // NEVER be the write target. Together: the write lands on the authorized live inner
  // node + the rail, and the decoy is untouched.
  const reg = loadedRegistry(["GoneNode"]);
  const live = {
    id: 54,
    type: "KSampler",
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const gone = {
    id: 77,
    type: "GoneNode",
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const subgraph = {
    _nodes: [live, gone],
    getNodeById: (id) => (String(id) === "54" ? live : String(id) === "77" ? gone : null),
  };
  // #366 authoritative rail projection identity-linked from the host input.
  const railWidget = { name: "sched_alias", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "sched_alias", _widget: railWidget, widget: { name: "sched_alias" }, _subgraphSlot: { name: "sched_alias" } }],
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple"] }, value: 999 }, railWidget],
  };
  // Deterministic promotion → the LIVE inner (KSampler); GoneNode is only a decoy
  // sibling, never linked by the promotion.
  const resolveSource = (_n, si) =>
    si?.name === "sched_alias" ? { sourceNodeId: "54", sourceWidgetName: "scheduler" } : null;

  const { set } = await runSetWidget(parent, "sched_alias", "karras", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(), // KSampler live, GoneNode absent
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, "karras");
  assert.equal(live.widgets.find((w) => w.name === "scheduler").value, "karras", "write landed on the authorized live inner node");
  assert.equal(railWidget.value, "karras", "#366: authoritative parent rail synced");
  assert.equal(gone.widgets.find((w) => w.name === "scheduler").value, "simple", "the decoy sibling was never touched");
});

// ---- #458 NESTED-INTERMEDIATE (adversarial review of #475): a nested promotion must
//      authorize the INTERMEDIATE node whose widget is actually mutated, not only the
//      terminal traversal target. A removed-backend husk sitting as the intermediate
//      must be REFUSED (never "defless + subgraph metadata" = trusted). --------------

// Outer subgraph A promotes "val" through an INTERMEDIATE node to a terminal KSampler
// widget. `intermediate` is parameterized so the test can make it a genuine virtual
// container OR a removed-backend husk. `reg` is mutated to register the intermediate.
function makeNestedIntermediateFixture(reg, { intermediateType, intermediateBackend, intermediateRealSubgraph = true }) {
  const terminal = {
    id: 90,
    type: "KSampler",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const midSubgraph = intermediateRealSubgraph
    ? { _nodes: [terminal], getNodeById: (id) => (String(id) === "90" ? terminal : null) }
    : {}; // FAKE subgraph marker — not a real container
  const mid = {
    id: 80,
    type: intermediateType,
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: midSubgraph,
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  // The intermediate's registered class + instance provenance.
  const midCtor = function MidCtor() {};
  if (intermediateBackend) {
    midCtor.nodeData = { input: { required: {} } }; // BACKEND provenance (removed pack's stale class)
    mid.constructor = midCtor;
  }
  reg[intermediateType] = midCtor;

  const aRail = { name: "steps", type: "INT", value: 20 };
  const a = {
    id: 70,
    type: "SubgraphA",
    widgets: [aRail],
    subgraph: { _nodes: [mid], getNodeById: (id) => (String(id) === "80" ? mid : null) },
    inputs: [{ name: "steps", _widget: aRail, widget: { name: "steps" }, _subgraphSlot: { name: "steps" } }],
  };
  reg.SubgraphA = function SubgraphA() {}; // A is a genuine virtual container (defless, no backend provenance)
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "steps") return { sourceNodeId: "80", sourceWidgetName: "steps" };
    if (subgraphNode === mid && si?.name === "steps") return { sourceNodeId: "90", sourceWidgetName: "steps" };
    return null;
  };
  return { a, mid, terminal, resolveSource };
}

test("#458 NESTED-INTERMEDIATE: a REMOVED-BACKEND husk intermediate (backend provenance, real subgraph, absent from object_info) ⇒ FAIL CLOSED — no fabricated success", async () => {
  // Exact trigger: outer A promotes through a stale removed-backend `GoneNode` (which
  // still carries a real subgraph + promotion metadata AND backend provenance) to a
  // genuine terminal KSampler. Fresh object_info lacks GoneNode. The terminal passes,
  // but the write MUTATES GoneNode's own widget — it must be refused on GoneNode.
  const reg = loadedRegistry(["GoneNode"]); // GoneNode registered WITH nodeData (backend provenance)
  const { a, mid, resolveSource } = makeNestedIntermediateFixture(reg, {
    intermediateType: "GoneNode",
    intermediateBackend: true,
  });
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // KSampler present, GoneNode absent
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 80 \("GoneNode"\)/.test(err.message) &&
      /not a verifiable frontend-only \/ virtual-subgraph node|masquerading/i.test(err.message),
  );
  assert.equal(mid.widgets.find((w) => w.name === "steps").value, 20, "the removed-backend intermediate is never mutated (#458)");
});

test("#458 NESTED-INTERMEDIATE: a defless husk intermediate with a FAKE `subgraph:{}` (no real nested graph) ⇒ FAIL CLOSED", async () => {
  // A bare husk (no backend provenance) carrying only a truthy `subgraph:{}` marker is
  // NOT a real virtual container (no _nodes/getNodeById), so it must not be trusted.
  const reg = loadedRegistry();
  // Build with a REAL subgraph first so followPromotionToConcrete can traverse to the
  // terminal, then swap the intermediate's subgraph to a fake marker to model the husk.
  const { a, mid, resolveSource } = makeNestedIntermediateFixture(reg, {
    intermediateType: "BareHusk",
    intermediateBackend: false,
  });
  mid.subgraph = {}; // fake marker — not a real container
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(),
        resolveSource,
        ...HOOKS,
      }),
    // Refused — either by the new intermediate guard or the pre-existing
    // concrete-resolution guard (a fake subgraph can't be traversed to a concrete node).
    (err) => err instanceof Error && /refusing to write|could not be resolved to a concrete backend node|not a verifiable frontend-only/i.test(err.message),
  );
  assert.equal(mid.widgets.find((w) => w.name === "steps").value, 20, "a fake-subgraph husk intermediate is never mutated");
});

test("#458 NESTED-INTERMEDIATE REGRESSION: a GENUINE virtual-container intermediate (real subgraph, no backend provenance) ⇒ still SUCCEEDS", async () => {
  const reg = loadedRegistry();
  const { a, mid, resolveSource } = makeNestedIntermediateFixture(reg, {
    intermediateType: "SubgraphB",
    intermediateBackend: false,
  });
  const { set } = await runSetWidget(a, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(),
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, 30, "a genuine nested promotion through a virtual container still writes");
  assert.equal(mid.widgets.find((w) => w.name === "steps").value, 30);
});

test("#458 NESTED-INTERMEDIATE (3-level A→B→C→concrete): a REMOVED-BACKEND husk as the DEEPER intermediate C ⇒ FAIL CLOSED (every driven-through container is authorized, not just the immediate inner)", async () => {
  // The value is driven A→B→C→KSampler. B is a genuine virtual container, but C is a
  // removed-backend node (backend provenance) carrying a real subgraph. The terminal
  // KSampler passes; the immediate inner B passes; C must STILL be authorized and refused.
  const reg = loadedRegistry(["GoneNode"]);
  const terminal = {
    id: 90,
    type: "KSampler",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  // C — removed-backend husk with a REAL nested graph AND backend provenance.
  const cCtor = function GoneNodeCtor() {};
  cCtor.nodeData = { input: { required: {} } }; // backend provenance (class + instance)
  const c = {
    id: 85,
    type: "GoneNode",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [terminal], getNodeById: (id) => (String(id) === "90" ? terminal : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
    constructor: cCtor,
  };
  reg["GoneNode"] = cCtor;
  // B — genuine virtual container (defless, no backend provenance).
  const b = {
    id: 80,
    type: "SubgraphB",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [c], getNodeById: (id) => (String(id) === "85" ? c : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  reg.SubgraphB = function SubgraphB() {};
  const aRail = { name: "steps", type: "INT", value: 20 };
  const a = {
    id: 70,
    type: "SubgraphA",
    widgets: [aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "steps", _widget: aRail, widget: { name: "steps" }, _subgraphSlot: { name: "steps" } }],
  };
  reg.SubgraphA = function SubgraphA() {};
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "steps") return { sourceNodeId: "80", sourceWidgetName: "steps" };
    if (subgraphNode === b && si?.name === "steps") return { sourceNodeId: "85", sourceWidgetName: "steps" };
    if (subgraphNode === c && si?.name === "steps") return { sourceNodeId: "90", sourceWidgetName: "steps" };
    return null;
  };
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // KSampler present; GoneNode/SubgraphA/B absent
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 85 \("GoneNode"\)/.test(err.message) &&
      /not a verifiable frontend-only \/ virtual-subgraph node|masquerading/i.test(err.message),
  );
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 20, "no mutation when a deeper intermediate is a removed-backend node");
  assert.equal(c.widgets.find((w) => w.name === "steps").value, 20);
});

test("#458 NESTED-INTERMEDIATE (3-level): all-genuine virtual containers A→B→C→KSampler ⇒ still SUCCEEDS", async () => {
  const reg = loadedRegistry();
  const terminal = {
    id: 90,
    type: "KSampler",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const c = {
    id: 85,
    type: "SubgraphC",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [terminal], getNodeById: (id) => (String(id) === "90" ? terminal : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  reg.SubgraphC = function SubgraphC() {};
  const b = {
    id: 80,
    type: "SubgraphB",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [c], getNodeById: (id) => (String(id) === "85" ? c : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  reg.SubgraphB = function SubgraphB() {};
  const aRail = { name: "steps", type: "INT", value: 20 };
  const a = {
    id: 70,
    type: "SubgraphA",
    widgets: [aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "steps", _widget: aRail, widget: { name: "steps" }, _subgraphSlot: { name: "steps" } }],
  };
  reg.SubgraphA = function SubgraphA() {};
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "steps") return { sourceNodeId: "80", sourceWidgetName: "steps" };
    if (subgraphNode === b && si?.name === "steps") return { sourceNodeId: "85", sourceWidgetName: "steps" };
    if (subgraphNode === c && si?.name === "steps") return { sourceNodeId: "90", sourceWidgetName: "steps" };
    return null;
  };
  const { set } = await runSetWidget(a, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(),
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, 30, "a fully-virtual 3-level promotion still writes");
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 30);
});

test("#458 EVER-SEEN INTERMEDIATE: a PROVENANCE-CLEAN, real-subgraph intermediate whose type was EVER in object_info ⇒ REFUSED (forged-container concern closed by observed history)", async () => {
  // The forged-virtual-container concern: a removed-backend node can be made
  // provenance-clean (generic placeholder) with a real `.subgraph`, passing every
  // client-side shape/provenance check. The ever-seen gate refuses it: the backend
  // reported this type earlier this session, so its absence now = removed.
  const reg = loadedRegistry();
  const { a, mid, resolveSource } = makeNestedIntermediateFixture(reg, {
    intermediateType: "WasBackendContainer",
    intermediateBackend: false, // provenance-clean, real subgraph (looks like a virtual container)
  });
  const everSeen = new Set(["WasBackendContainer"]); // backend reported it earlier this session
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // KSampler present; WasBackendContainer absent now
        wasTypeEverDefined: (t) => everSeen.has(t),
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 80 \("WasBackendContainer"\)/.test(err.message) &&
      /was defined by the ComfyUI backend earlier this session|since-removed/i.test(err.message),
  );
  assert.equal(mid.widgets.find((w) => w.name === "steps").value, 20, "a since-removed container intermediate is never driven-through");
});

test("#458 EVER-SEEN INTERMEDIATE: a genuine virtual container (type NEVER in object_info) ⇒ still SUCCEEDS with the gate wired", async () => {
  const reg = loadedRegistry();
  const { a, mid, resolveSource } = makeNestedIntermediateFixture(reg, {
    intermediateType: "SubgraphB",
    intermediateBackend: false,
  });
  const { set } = await runSetWidget(a, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(),
    wasTypeEverDefined: () => false, // virtual subgraph ids are never in /object_info
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, 30);
  assert.equal(mid.widgets.find((w) => w.name === "steps").value, 30);
});

// ---- #512: outer UUID subgraph node whose class carries the frontend's SYNTHESIZED
//      def markers. Current ComfyUI_frontend's registerSubgraphNodeDef stamps static
//      nodeData + comfyClass on EVERY subgraph node's registered class (registered
//      under the subgraph's UUID), so the #458 provenance heuristic false-fired on the
//      genuine container and refused a CORRECT promoted write as an "unverifiable
//      virtual-subgraph node". The container must instead be authorized through its
//      RESOLVED, fresh-authorized concrete inner target — while a promotion that does
//      NOT resolve (or an ever-seen/removed container type) must still fail closed. ----

// The bundled ltx-2.3-img2vid repro: outer node 320, type is the subgraph's UUID.
const SUBGRAPH_UUID = "2454ad83-157c-40dd-9f19-5daaf4041ce0";

// A SubgraphNode shaped the way current ComfyUI_frontend actually builds one: the type
// is the subgraph's UUID (never in /object_info), and BOTH the registered class and the
// instance's own constructor carry the synthesized nodeDef (nodeData + comfyClass) that
// registerSubgraphNodeDef stamps BY DESIGN. `innerType` flips the inner node between a
// live and a removed backend type. Returns null resolveSource when `resolvable` is
// false to model a stale/empty promoted link.
function makeUuidSubgraphFixture(reg, innerType, { resolvable = true } = {}) {
  const inner = {
    id: 301,
    type: innerType,
    widgets: [{ name: "value_4", type: "INT", value: 20 }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  // #366: the AUTHORITATIVE parent rail projection — identity-linked from the host
  // input (`_widget`) and a live member of parent.widgets.
  const railWidget = { name: "value_4", type: "INT", value: 20 };
  const parent = {
    id: 320,
    type: SUBGRAPH_UUID,
    subgraph: { _nodes: [inner], getNodeById: (id) => (String(id) === "301" ? inner : null) },
    inputs: [{ name: "value_4", _widget: railWidget, widget: { name: "value_4" }, _subgraphSlot: { name: "value_4" } }],
    widgets: [railWidget],
  };
  // registerSubgraphNodeDef: the synthesized def is stamped on the class, which is
  // registered under the subgraph's UUID — the "backend provenance" that false-fired.
  const ctor = function ComfySubgraphNode() {};
  ctor.nodeData = { input: { required: {} }, name: SUBGRAPH_UUID };
  ctor.comfyClass = SUBGRAPH_UUID;
  parent.constructor = ctor;
  reg[SUBGRAPH_UUID] = ctor;
  const resolveSource = (_n, si) =>
    resolvable && si?.name === "value_4" ? { sourceNodeId: "301", sourceWidgetName: "value_4" } : null;
  return { parent, inner, railWidget, resolveSource };
}

test("#512: promoted write on an outer UUID subgraph node (synthesized-def provenance) ⇒ SUCCEEDS via the resolved inner target", async () => {
  // The exact reported repro: the guard refused this as "not a verifiable frontend-only
  // / virtual-subgraph node" purely because the class carries the frontend-stamped def.
  // The promotion resolves to a live, fresh-authorized inner node — the write is correct
  // and must proceed, landing on the inner node + syncing the authoritative rail.
  const reg = loadedRegistry();
  const { parent, inner, railWidget, resolveSource } = makeUuidSubgraphFixture(reg, "KSampler");
  const { set } = await runSetWidget(parent, "value_4", 42, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(), // KSampler present; the UUID never is
    wasTypeEverDefined: () => false, // UUID subgraph types are never backend-defined
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, 42);
  assert.equal(inner.widgets.find((w) => w.name === "value_4").value, 42, "write landed on the resolved inner node");
  assert.equal(railWidget.value, 42, "#366: authoritative parent rail synced");
});

test("#512: promoted write on a UUID subgraph node whose inner type is REMOVED ⇒ still FAIL CLOSED", async () => {
  // The relaxation authorizes the CONTAINER through the resolved inner target — it says
  // nothing about the target itself. A removed inner type is still refused by the fresh
  // oracle, exactly as before.
  const reg = loadedRegistry(["GoneNode"]);
  const { parent, inner, railWidget, resolveSource } = makeUuidSubgraphFixture(reg, "GoneNode");
  await assert.rejects(
    () =>
      runSetWidget(parent, "value_4", 42, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // backend no longer provides GoneNode
        wasTypeEverDefined: () => false,
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 301 \("GoneNode"\)/.test(err.message) &&
      /backend does not provide/i.test(err.message),
  );
  assert.equal(inner.widgets.find((w) => w.name === "value_4").value, 20, "inner untouched");
  assert.equal(railWidget.value, 20, "rail untouched");
});

test("#512: UNRESOLVABLE promotion on a UUID subgraph node ⇒ still REFUSED (no concrete target, no write)", async () => {
  // The exemption is scoped to a POSITIVELY-resolved, concrete-authorized promotion. A
  // promoted widget whose inner link is stale/empty never earns it — fail closed.
  const reg = loadedRegistry();
  const { parent, inner, railWidget, resolveSource } = makeUuidSubgraphFixture(reg, "KSampler", { resolvable: false });
  await assert.rejects(
    () =>
      runSetWidget(parent, "value_4", 42, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(),
        wasTypeEverDefined: () => false,
        resolveSource, // stale/empty linkIds — the promotion cannot be resolved
        ...HOOKS,
      }),
    (err) => err instanceof Error && /refused.*no resolvable inner link|no resolvable inner link/i.test(err.message),
  );
  assert.equal(inner.widgets.find((w) => w.name === "value_4").value, 20, "inner untouched");
  assert.equal(railWidget.value, 20, "rail untouched");
});

test("#512: the EVER-SEEN gate still REFUSES a container type the backend reported earlier (the flag never bypasses the trust root)", async () => {
  // If the backend DID report this type earlier this session and it is now absent, the
  // node is a removed backend node masquerading as a subgraph container — refused before
  // the resolved-promotion exemption is ever consulted (#458 stays closed).
  const reg = loadedRegistry();
  const { parent, inner, railWidget, resolveSource } = makeUuidSubgraphFixture(reg, "KSampler");
  await assert.rejects(
    () =>
      runSetWidget(parent, "value_4", 42, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => objectInfo(), // the type is ABSENT now…
        wasTypeEverDefined: (t) => t === SUBGRAPH_UUID, // …but was reported EARLIER this session
        resolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Cannot set widget on node 320/.test(err.message) &&
      /was defined by the ComfyUI backend earlier this session|since-removed/i.test(err.message),
  );
  assert.equal(inner.widgets.find((w) => w.name === "value_4").value, 20, "inner untouched");
  assert.equal(railWidget.value, 20, "rail untouched");
});

test("#512: NESTED promotion through a provenance-stamped UUID intermediate ⇒ SUCCEEDS (every driven-through container authorized via the chain)", async () => {
  // On current frontends EVERY subgraph node in the chain carries the synthesized def,
  // not just the outer one — a nested A→B→KSampler promotion must authorize the
  // intermediate B through the same resolved-chain evidence or it false-refuses too.
  const reg = loadedRegistry();
  const INNER_UUID = "bbbbbbbb-1111-4222-8333-cccccccccccc";
  const concrete = {
    id: 90,
    type: "KSampler",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    constructor: { nodeData: { input: { required: {} } } },
  };
  const stamp = (node, uuid) => {
    const ctor = function ComfySubgraphNode() {};
    ctor.nodeData = { input: { required: {} }, name: uuid };
    ctor.comfyClass = uuid;
    node.constructor = ctor;
    reg[uuid] = ctor;
  };
  const b = {
    id: 80,
    type: INNER_UUID,
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [concrete], getNodeById: (id) => (String(id) === "90" ? concrete : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  stamp(b, INNER_UUID);
  const aRail = { name: "steps", type: "INT", value: 20 };
  const a = {
    id: 70,
    type: SUBGRAPH_UUID,
    widgets: [aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "steps", _widget: aRail, widget: { name: "steps" }, _subgraphSlot: { name: "steps" } }],
  };
  stamp(a, SUBGRAPH_UUID);
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "steps") return { sourceNodeId: "80", sourceWidgetName: "steps" };
    if (subgraphNode === b && si?.name === "steps") return { sourceNodeId: "90", sourceWidgetName: "steps" };
    return null;
  };
  const { set } = await runSetWidget(a, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => objectInfo(), // KSampler present; both UUIDs absent
    wasTypeEverDefined: () => false,
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, 30, "nested promoted write authorized via the resolved concrete chain");
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 30, "the intermediate forwarded the write");
  assert.equal(aRail.value, 30, "#366: authoritative outer rail synced");
});
