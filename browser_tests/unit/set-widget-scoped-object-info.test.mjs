/**
 * #1560 — the TYPE-SCOPED `/object_info` last resort. Run with `node --test`.
 *
 * The report: on ~1023 models and hundreds of custom packs both whole-schema probes time
 * out while ComfyUI is idle and healthy, `/object_info/SmartResolution` answers 200 in
 * ~2.7KB, and #1223's snapshot is never populated because no WHOLE map ever lands. So every
 * `panel_set_widget` refuses FOR THE LIFE OF THE TAB — a permanent refusal on a healthy
 * backend, not the transient busy-backend timeout the budget was designed for.
 *
 * These drive the REAL production handler body (`runSetWidget`) with the capability wired
 * exactly as `web/js/comfyui-mcp-panel.js` wires it, and they pin BOTH directions:
 *
 *   A. The large-install write now SUCCEEDS — direct and PROMOTED (two types), fetching only
 *      the types the write resolves to, and never populating the #1223 snapshot.
 *   B. An unverifiable write STILL REFUSES — a removed type, an indefinite per-class answer,
 *      one indefinite answer inside a promoted set, a whole-map route that ANSWERED rather
 *      than going silent, and a promotion relinked across the scoped fetch.
 *
 * The load-bearing property is the one `object-info-oracle.js` forbade the naive fix for: a
 * type the scoped map was NOT asked to cover must THROW, never read as absent (#716/#821).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runSetWidget, scopedAuthorizationTypes } from "../../web/js/lib/set-widget.js";
import {
  fetchTypeScopedObjectInfo,
  MAX_SCOPED_TYPES,
  SCOPED_OBJECT_INFO,
  SCOPED_OBJECT_INFO_DEADLINE_MS,
} from "../../web/js/lib/scoped-object-info.js";
import { resolvePromotedInnerTarget } from "../../web/js/lib/widget-write.js";
import { refreshComboOptionsFromDefs } from "../../web/js/lib/asset-staleness.js";
import { noBackendAnswerEstablished } from "../../web/js/lib/object-info-snapshot.js";
import { createObjectInfoSnapshot } from "../../web/js/lib/object-info-snapshot.js";
import { TRANSPORT_OUTCOME } from "../../web/js/lib/object-info-oracle.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SET_WIDGET_JS = fileURLToPath(new URL("../../web/js/lib/set-widget.js", import.meta.url));
const HOOKS = { beforeChange() {}, afterChange() {}, setDirty() {} };

/** A registry entry that looks like a genuinely-resolved class (registerNodesFromDefs). */
function regEntry() {
  const ctor = function NodeCtor() {};
  ctor.nodeData = { input: { required: {} } };
  return ctor;
}
function loadedRegistry(types) {
  const reg = {};
  for (const t of types) reg[t] = regEntry();
  return reg;
}
function regNode(id, type, widgets, extra = {}) {
  return { id, type, widgets, constructor: { nodeData: { input: { required: {} } } }, ...extra };
}

/**
 * A backend whose WHOLE `/object_info` never lands but which answers per class — the #1560
 * install. `defined` is what the backend actually provides; anything else answers `{}`/200,
 * which is how ComfyUI reports "no such class" on this route (#767).
 */
function largeInstall({ defined = [], perClass } = {}) {
  const calls = [];
  const fetchApi = async (route) => {
    calls.push(route);
    if (route === "/object_info") return new Promise(() => {}); // never settles
    const m = /^\/object_info\/(.+)$/.exec(route);
    if (!m) return { ok: false, status: 404, json: async () => ({}) };
    const type = decodeURIComponent(m[1]);
    if (typeof perClass === "function") {
      const override = await perClass(type);
      if (override !== undefined) return override;
    }
    return {
      ok: true,
      status: 200,
      json: async () => (defined.includes(type) ? { [type]: { input: { required: {} } } } : {}),
    };
  };
  return { fetchApi, calls, perClassCalls: () => calls.filter((c) => c !== "/object_info") };
}

/**
 * The panel's own wiring for the scoped route, reproduced verbatim in shape: the SILENCE
 * LICENCE first, then the bounded type-scoped read, then the "scoped" provenance stamp.
 */
function panelStyleScopedRoute(
  fetchApi,
  outcomes,
  onScoped,
  unlicensedReason = "a whole-schema route ANSWERED rather than going silent",
) {
  return async (types) => {
    if (!noBackendAnswerEstablished(outcomes)) {
      return { defs: null, covered: [], reason: unlicensedReason };
    }
    const scoped = await fetchTypeScopedObjectInfo(types, { fetchApi, deadlineMs: SCOPED_OBJECT_INFO_DEADLINE_MS });
    if (scoped.defs && typeof onScoped === "function") onScoped(scoped);
    return scoped;
  };
}

/** Both whole-map routes went SILENT — the outcome list the oracle records for #1560. */
const SILENT_OUTCOMES = [
  { route: "client", kind: TRANSPORT_OUTCOME.NO_ANSWER },
  { route: "http", kind: TRANSPORT_OUTCOME.NO_ANSWER },
];
/** A client that ANSWERED deny-all — the one outcome a broader read must never overrule. */
const ANSWERED_OUTCOMES = [{ route: "client", kind: TRANSPORT_OUTCOME.ANSWERED_UNUSABLE }];

/** The nested A→B→KSampler promotion shape the #458 suite uses. */
function nestedFixture(reg, concreteType) {
  const concrete = regNode(90, concreteType, [{ name: "steps", type: "INT", value: 20 }]);
  const b = {
    id: 80,
    type: "SubgraphB",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [concrete], getNodeById: (id) => (String(id) === "90" ? concrete : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  const aRail = { name: "steps", type: "INT", value: 20 };
  const a = {
    id: 70,
    type: "SubgraphA",
    widgets: [{ name: "steps_decoy", type: "INT", value: 999 }, aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "steps", _widget: aRail, widget: { name: "steps" }, _subgraphSlot: { name: "steps" } }],
  };
  reg.SubgraphA = function SubgraphA() {};
  reg.SubgraphB = function SubgraphB() {};
  const resolveSource = (subgraphNode, si) => {
    if (subgraphNode === a && si?.name === "steps") return { sourceNodeId: "80", sourceWidgetName: "steps" };
    if (subgraphNode === b && si?.name === "steps") return { sourceNodeId: "90", sourceWidgetName: "steps" };
    return null;
  };
  return { a, b, concrete, resolveSource };
}

// ───────────────────────────── DIRECTION A: the large-install write now succeeds ──────────

test("#1560 A: whole /object_info never lands, per-class answers ⇒ a DIRECT write is authorized", async () => {
  const reg = loadedRegistry(["SmartResolution"]);
  const node = regNode(1976, "SmartResolution", [{ name: "value", type: "INT", value: 512 }]);
  const backend = largeInstall({ defined: ["SmartResolution"] });
  const { set } = await runSetWidget(node, "value", 768, {
    registry: reg,
    getRegistry: () => reg,
    // The whole-map oracle produced NOTHING and #1223's snapshot could not stand in — the
    // exact state the report describes, and today's permanent refusal.
    getFreshObjectInfo: async () => null,
    fetchScopedObjectInfo: panelStyleScopedRoute(backend.fetchApi, SILENT_OUTCOMES),
    wasTypeEverDefined: () => false,
    ...HOOKS,
  });
  assert.equal(set.value, 768, "the write the reporter could never land now lands");
  assert.equal(node.widgets[0].value, 768);
  assert.deepEqual(
    backend.perClassCalls(),
    ["/object_info/SmartResolution"],
    "exactly the ONE type this write resolves to is asked about — not the whole install",
  );
});

test("#2249: an exact type-scoped answer can validate an existing scalar after a non-definitive whole failure", async () => {
  const reg = loadedRegistry(["ImageScale"]);
  const node = regNode(2249, "ImageScale", [{ name: "upscale_factor", type: "FLOAT", value: 1 }]);
  const backend = largeInstall({ defined: ["ImageScale"] });
  const { set } = await runSetWidget(node, "upscale_factor", 2, {
    registry: reg,
    getRegistry: () => reg,
    // The whole oracle has no usable answer; this is deliberately not registry-only auth.
    getFreshObjectInfo: async () => null,
    fetchScopedObjectInfo: async (types) =>
      fetchTypeScopedObjectInfo(types, {
        fetchApi: backend.fetchApi,
        deadlineMs: SCOPED_OBJECT_INFO_DEADLINE_MS,
      }),
    wasTypeEverDefined: () => false,
    ...HOOKS,
  });
  assert.equal(set.value, 2, "the exact live class answer validates the existing scalar widget");
  assert.equal(node.widgets[0].value, 2);
  assert.deepEqual(backend.perClassCalls(), ["/object_info/ImageScale"]);
});

test("#1560 A: a PROMOTED nested write asks about ALL THREE types (#716/#821's 'two types') and succeeds", async () => {
  const reg = loadedRegistry(["KSampler"]);
  const { a, b, resolveSource } = nestedFixture(reg, "KSampler");
  const backend = largeInstall({ defined: ["KSampler"] }); // SubgraphA/B are virtual: `{}`/200
  const { set } = await runSetWidget(a, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => null,
    fetchScopedObjectInfo: panelStyleScopedRoute(backend.fetchApi, SILENT_OUTCOMES),
    wasTypeEverDefined: () => false,
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, 30);
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 30, "the inner promoted widget is written");
  assert.deepEqual(
    backend.perClassCalls().sort(),
    ["/object_info/KSampler", "/object_info/SubgraphA", "/object_info/SubgraphB"].sort(),
    "the OUTER node, the INTERMEDIATE and the CONCRETE target are each asked about — a " +
      "single-class payload would have answered one and read the others as absent",
  );
});

test("#1709: a partial scoped batch reports only definitive classes for proof retirement", async () => {
  const backend = largeInstall({
    perClass: async (type) => {
      if (type === "PresentNode") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ PresentNode: { input: { required: {} } } }),
        };
      }
      if (type === "UnknownNode") throw new Error("timeout");
      return undefined;
    },
  });
  const result = await fetchTypeScopedObjectInfo(["PresentNode", "UnknownNode"], {
    fetchApi: backend.fetchApi,
  });
  assert.equal(result.defs, null, "an incomplete batch remains unauthorized");
  assert.deepEqual(result.covered, ["PresentNode"], "only the definitive class is reported for invalidation");
});

test("#1560 A: the scoped payload is NEVER recorded into the #1223 snapshot", async () => {
  // object-info-snapshot.js requires an explicit `whole: true` claim precisely so a
  // per-class payload cannot make every OTHER type read as a removed pack. This route must
  // never make that claim, so the snapshot stays empty and later calls keep re-asking.
  const snapshot = createObjectInfoSnapshot();
  const reg = loadedRegistry(["SmartResolution"]);
  const node = regNode(1976, "SmartResolution", [{ name: "value", type: "INT", value: 512 }]);
  const backend = largeInstall({ defined: ["SmartResolution"] });
  await runSetWidget(node, "value", 768, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => null,
    fetchScopedObjectInfo: panelStyleScopedRoute(backend.fetchApi, SILENT_OUTCOMES),
    wasTypeEverDefined: () => false,
    ...HOOKS,
  });
  const authorized = snapshot.authorize({ epoch: 0, socketDown: false, outcomes: SILENT_OUTCOMES });
  assert.equal(authorized.defs, null, "no whole map was observed, so the snapshot must still authorize nothing");
});

// ───────────────────────────── DIRECTION B: an unverifiable write still refuses ────────────

test("#1560 B: a REMOVED type answers `{}`/200 per class ⇒ still FAILS CLOSED (#458 unchanged)", async () => {
  const reg = loadedRegistry(["GoneNode"]); // the stale registry positive #458 is about
  const node = regNode(3, "GoneNode", [{ name: "steps", type: "INT", value: 20 }]);
  const backend = largeInstall({ defined: [] }); // the backend no longer provides it
  await assert.rejects(
    () =>
      runSetWidget(node, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null,
        fetchScopedObjectInfo: panelStyleScopedRoute(backend.fetchApi, SILENT_OUTCOMES),
        wasTypeEverDefined: () => false,
        ...HOOKS,
      }),
    (err) => err instanceof Error && /backend does not provide node type "GoneNode"/.test(err.message),
  );
  assert.equal(node.widgets[0].value, 20, "no mutation");
});

test("#1560 B: an EVER-SEEN type now absent per class is still diagnosed as a REMOVED pack", async () => {
  const reg = loadedRegistry(["GoneNode"]);
  const node = regNode(3, "GoneNode", [{ name: "steps", type: "INT", value: 20 }]);
  const backend = largeInstall({ defined: [] });
  await assert.rejects(
    () =>
      runSetWidget(node, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null,
        fetchScopedObjectInfo: panelStyleScopedRoute(backend.fetchApi, SILENT_OUTCOMES),
        wasTypeEverDefined: (t) => t === "GoneNode", // the backend reported it earlier
        ...HOOKS,
      }),
    (err) => err instanceof Error && /its backend was\s+removed \(pack uninstalled\/disabled\)/.test(err.message),
  );
  assert.equal(node.widgets[0].value, 20, "no mutation");
});

test("#1560 B: the per-class route ALSO going silent refuses exactly as today, and SAYS what the third route did", async () => {
  const reg = loadedRegistry(["SmartResolution"]);
  const node = regNode(1976, "SmartResolution", [{ name: "value", type: "INT", value: 512 }]);
  const backend = largeInstall({ perClass: () => new Promise(() => {}) }); // never settles
  await assert.rejects(
    () =>
      runSetWidget(node, "value", 768, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null,
        describeObjectInfoFailure: () => " Tried 2 routes: a; b.",
        fetchScopedObjectInfo: async (types) =>
          fetchTypeScopedObjectInfo(types, { fetchApi: backend.fetchApi, deadlineMs: 20 }),
        wasTypeEverDefined: () => false,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /no usable \/object_info schema was obtained/.test(err.message) &&
      // #1573 — the lead-in reports the OUTCOME; the reason reports the cause. On THIS path
      // requests really were issued, and the reason says so by naming the deadline they
      // missed. The assertion below pins that the requests happened, so the wording and the
      // world are checked against each other rather than the wording alone.
      /A type-scoped \/object_info read did not stand in for the whole-schema routes either — .*did not all answer within/.test(
        err.message,
      ),
  );
  assert.deepEqual(
    backend.perClassCalls(),
    ["/object_info/SmartResolution"],
    "the request the reason blames a deadline for really was issued",
  );
  assert.equal(node.widgets[0].value, 512, "no mutation");
});

test("#1573: an UNLICENSED scoped route issues NOTHING, and the refusal does not claim a read was tried", async () => {
  // #1561's own fourth gate pass: `describeObjectInfoFailureWithScope` appended "A
  // type-scoped /object_info read was tried too" for EVERY non-empty reason, including the
  // ones where the route was never licensed and no request left the panel. The clause after
  // the dash self-corrected, but the lead-in asserted an attempt that did not happen — the
  // #982 shape, in the one sentence a stuck caller reads.
  //
  // Asserts the OUTPUT, not the absence of a phrase: the exact sentence the caller gets,
  // paired with the request list that proves what actually happened.
  const src = readFileSync(PANEL_JS, "utf8");
  const UNLICENSED_REASON =
    "the whole-schema evidence did not qualify for a type-scoped fallback, which " +
    "may not overrule an answer or substitute for a route nobody ran";
  assert.ok(
    src.includes("the whole-schema evidence did not qualify for a type-scoped fallback"),
    "the reason under test is the panel's own, not one invented here",
  );

  const reg = loadedRegistry(["SmartResolution"]);
  const node = regNode(1976, "SmartResolution", [{ name: "value", type: "INT", value: 512 }]);
  const backend = largeInstall({ defined: ["SmartResolution"] });
  await assert.rejects(
    () =>
      runSetWidget(node, "value", 768, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null,
        describeObjectInfoFailure: () => " Tried 2 routes: a; b.",
        // The panel's unlicensed early return, verbatim: no request is issued at all.
        fetchScopedObjectInfo: panelStyleScopedRoute(backend.fetchApi, ANSWERED_OUTCOMES, undefined, UNLICENSED_REASON),
        wasTypeEverDefined: () => false,
        ...HOOKS,
      }),
    (err) => {
      assert.ok(
        err.message.includes(
          `A type-scoped /object_info read did not stand in for the whole-schema routes either — ${UNLICENSED_REASON}.`,
        ),
        `the refusal must state the outcome and the panel's own reason, verbatim. Got: ${err.message}`,
      );
      return true;
    },
  );
  assert.deepEqual(backend.perClassCalls(), [], "not one per-class request was issued — so none may be claimed");
  assert.equal(node.widgets[0].value, 512, "no mutation");
});

test("#1560 B: a NON-200 per-class reply establishes nothing and refuses (a proxy page is not an absence)", async () => {
  const reg = loadedRegistry(["SmartResolution"]);
  const node = regNode(1976, "SmartResolution", [{ name: "value", type: "INT", value: 512 }]);
  const backend = largeInstall({ perClass: async () => ({ ok: false, status: 502, json: async () => ({}) }) });
  await assert.rejects(
    () =>
      runSetWidget(node, "value", 768, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null,
        fetchScopedObjectInfo: panelStyleScopedRoute(backend.fetchApi, SILENT_OUTCOMES),
        wasTypeEverDefined: () => false,
        ...HOOKS,
      }),
    (err) => err instanceof Error && /no usable \/object_info schema was obtained/.test(err.message),
  );
  assert.equal(node.widgets[0].value, 512, "no mutation");
});

test("#1560 B: ALL-OR-NOTHING — one indefinite answer inside a PROMOTED set refuses the whole write", async () => {
  // The concrete target answers perfectly; the INTERMEDIATE container does not. A map that
  // authorized the part it could answer is exactly what #716/#821 were.
  const reg = loadedRegistry(["KSampler"]);
  const { a, b, resolveSource } = nestedFixture(reg, "KSampler");
  const backend = largeInstall({
    defined: ["KSampler"],
    perClass: async (type) => (type === "SubgraphB" ? { ok: false, status: 500, json: async () => ({}) } : undefined),
  });
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null,
        fetchScopedObjectInfo: panelStyleScopedRoute(backend.fetchApi, SILENT_OUTCOMES),
        wasTypeEverDefined: () => false,
        resolveSource,
        ...HOOKS,
      }),
    (err) => err instanceof Error && /no usable \/object_info schema was obtained/.test(err.message),
  );
  assert.equal(b.widgets.find((w) => w.name === "steps").value, 20, "no mutation anywhere in the chain");
});

test("#1560 B: a whole-map route that ANSWERED is never overruled — the scoped route is not even asked", async () => {
  // A frontend client expressing deny-all as `{}` is an ANSWER. Consulting a broader
  // per-class read there is the one direction object-info-oracle.js's note forbids.
  const reg = loadedRegistry(["SmartResolution"]);
  const node = regNode(1976, "SmartResolution", [{ name: "value", type: "INT", value: 512 }]);
  const backend = largeInstall({ defined: ["SmartResolution"] });
  await assert.rejects(
    () =>
      runSetWidget(node, "value", 768, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null,
        fetchScopedObjectInfo: panelStyleScopedRoute(backend.fetchApi, ANSWERED_OUTCOMES),
        wasTypeEverDefined: () => false,
        ...HOOKS,
      }),
    (err) => err instanceof Error && /no usable \/object_info schema was obtained/.test(err.message),
  );
  assert.deepEqual(backend.perClassCalls(), [], "not one per-class request was issued");
  assert.equal(node.widgets[0].value, 512, "no mutation");
});

test("#1560 B: a promotion RELINKED across the scoped fetch resolves outside the covered set ⇒ refuses", async () => {
  // The scoped read adds an await between the resolution and the write. A deeper relink in
  // that window makes the write land on a type the map was never asked to cover — and the
  // map throws for it rather than reading it as absent, which is the whole guarantee.
  const reg = loadedRegistry(["KSampler"]);
  const { a, b, concrete, resolveSource } = nestedFixture(reg, "KSampler");
  const swapped = regNode(91, "OtherSampler", [{ name: "steps", type: "INT", value: 20 }]);
  reg.OtherSampler = regEntry();
  b.subgraph.getNodeById = (id) => (String(id) === "90" ? concrete : String(id) === "91" ? swapped : null);
  const backend = largeInstall({ defined: ["KSampler", "OtherSampler"] });
  let relinked = false;
  const movingResolveSource = (subgraphNode, si) => {
    if (subgraphNode === b && si?.name === "steps") {
      return relinked ? { sourceNodeId: "91", sourceWidgetName: "steps" } : { sourceNodeId: "90", sourceWidgetName: "steps" };
    }
    return resolveSource(subgraphNode, si);
  };
  await assert.rejects(
    () =>
      runSetWidget(a, "steps", 30, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null,
        fetchScopedObjectInfo: async (types) => {
          const scoped = await fetchTypeScopedObjectInfo(types, { fetchApi: backend.fetchApi });
          relinked = true; // the user re-wired the promotion while the request was in flight
          return scoped;
        },
        wasTypeEverDefined: () => false,
        resolveSource: movingResolveSource,
        ...HOOKS,
      }),
    (err) =>
      err instanceof Error &&
      /Refusing to read an unfetched type as ABSENT \(#716\/#821\)/.test(err.message) &&
      /"OtherSampler"/.test(err.message),
  );
  assert.equal(swapped.widgets[0].value, 20, "the swapped-in node was never written");
  assert.equal(concrete.widgets[0].value, 20, "and neither was the original");
});

// ───────────────────────── the scoped map itself: it refuses the OTHER question ────────────

test("#1560: a type OUTSIDE the covered set THROWS rather than reading as absent (#716/#821)", async () => {
  const backend = largeInstall({ defined: ["KSampler"] });
  const { defs, covered } = await fetchTypeScopedObjectInfo(["KSampler"], { fetchApi: backend.fetchApi });
  assert.deepEqual(covered, ["KSampler"]);
  assert.equal(Object.prototype.hasOwnProperty.call(defs, "KSampler"), true, "the asked type answers");
  assert.throws(
    () => Object.prototype.hasOwnProperty.call(defs, "VAELoader"),
    /Refusing to read an unfetched type as ABSENT/,
    "the UNASKED type must not read as `false` — that is exactly the #716/#821 defect",
  );
  assert.throws(() => defs.VAELoader, /Refusing to read an unfetched type as ABSENT/);
  assert.throws(() => "VAELoader" in defs, /Refusing to read an unfetched type as ABSENT/);
  // Symbol brands (CACHE_OUTCOME and friends) are never class types and must pass through.
  assert.equal(defs[Symbol.for("comfyui-mcp.objectInfoOutcome")], undefined);
  assert.deepEqual(Object.keys(defs), ["KSampler"], "enumeration stays honest and small");
});

test("#1560: a type that is COVERED but absent reads as a plain absence, not a throw", async () => {
  const backend = largeInstall({ defined: [] });
  const { defs } = await fetchTypeScopedObjectInfo(["SubgraphA"], { fetchApi: backend.fetchApi });
  assert.equal(Object.prototype.hasOwnProperty.call(defs, "SubgraphA"), false, "asked, and definitively absent");
  assert.deepEqual(Object.keys(defs), []);
});

test("#1560: fetchTypeScopedObjectInfo fails closed on every indefinite answer", async () => {
  const cases = [
    ["non-200", async () => ({ ok: false, status: 404, json: async () => ({}) })],
    ["unparseable body", async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } })],
    ["array body", async () => ({ ok: true, status: 200, json: async () => [] })],
    ["non-object def value", async () => ({ ok: true, status: 200, json: async () => ({ KSampler: "yes" }) })],
    ["a throwing fetchApi", async () => { throw new Error("boom"); }],
    ["an unreadable response", async () => ({ get ok() { throw new Error("hostile"); } })],
  ];
  for (const [label, perClass] of cases) {
    const backend = largeInstall({ perClass });
    const res = await fetchTypeScopedObjectInfo(["KSampler"], { fetchApi: backend.fetchApi });
    assert.equal(res.defs, null, `${label} must not produce a usable map`);
    assert.ok(res.reason, `${label} must say why`);
  }
});

test("#1560: fetchTypeScopedObjectInfo refuses an empty set, an unwired fetchApi and a runaway chain", async () => {
  const backend = largeInstall({ defined: ["KSampler"] });
  assert.equal((await fetchTypeScopedObjectInfo([], { fetchApi: backend.fetchApi })).defs, null);
  assert.equal((await fetchTypeScopedObjectInfo(["KSampler"], {})).defs, null);
  const many = Array.from({ length: MAX_SCOPED_TYPES + 1 }, (_, i) => `Type${i}`);
  const capped = await fetchTypeScopedObjectInfo(many, { fetchApi: backend.fetchApi });
  assert.equal(capped.defs, null, "a pathological promotion chain is not turned into a request storm");
  assert.deepEqual(backend.perClassCalls(), [], "and nothing was issued");
  // THE VALUE, not just the existence of a cap. `MAX_SCOPED_TYPES + 1` above is
  // self-referential — it passes for any number the constant happens to hold, so a change to
  // 1 (refusing every promoted write) or to 500 (a request storm against a backend that is
  // already struggling) would sail through it. Pin the number and both sides of the boundary.
  assert.equal(MAX_SCOPED_TYPES, 8, "the cap is a deliberate number, not whatever it drifted to");
  const atCap = Array.from({ length: MAX_SCOPED_TYPES }, (_, i) => `Type${i}`);
  const allowed = await fetchTypeScopedObjectInfo(atCap, { fetchApi: backend.fetchApi });
  assert.ok(allowed.defs, "exactly MAX_SCOPED_TYPES is still ANSWERED — the cap is off-by-one-safe");
  assert.equal(backend.perClassCalls().length, MAX_SCOPED_TYPES, "one request per type, no more");
});

// ───────────────────────────────── the CALL SITE, not just the helper ─────────────────────

test("#1560: scopedAuthorizationTypes names EVERY type the fence asks about, from the graph alone", () => {
  const reg = loadedRegistry(["KSampler"]);
  const { a, resolveSource } = nestedFixture(reg, "KSampler");
  const resolution = resolvePromotedInnerTarget(a, "steps", resolveSource);
  const types = scopedAuthorizationTypes(a, resolution, true, resolveSource);
  assert.deepEqual(
    [...types].sort(),
    ["KSampler", "SubgraphA", "SubgraphB"],
    "the outer node, the intermediate and the concrete target — computed with NO schema",
  );
  // A DIRECT write asks about exactly one type.
  assert.deepEqual(scopedAuthorizationTypes(regNode(1, "KSampler", []), null, false, undefined), ["KSampler"]);
  // A resolver that throws must yield NOTHING rather than a partial list, so the scoped read
  // is simply not attempted and the write refuses on the unchanged path.
  assert.deepEqual(
    scopedAuthorizationTypes(a, resolution, true, () => {
      throw new Error("malformed promotion");
    }),
    [],
  );
});

test("#1560/#2249: the panel wires scoped authority after a non-definitive whole failure", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /fetchScopedObjectInfo:\s*async \(types\) => \{/, "the capability reaches runSetWidget");
  // The licence is DECIDED beside the snapshot's own verdict, on the SAME `outcome.outcomes`,
  // in the same statement — and merely READ at the gate. A second reading of a fact
  // established at a moment is how the two could disagree, and this handler enters
  // `readObjectInfo` more than once (the #1126 live re-ask).
  const oracle = src.slice(src.indexOf("const fallback = objectInfoSnapshot.authorize"));
  assert.match(oracle, /outcomes: outcome\?\.outcomes,\s*\}\);/, "uses the oracle's outcome list");
  assert.match(
    oracle,
    /schemaResponseIsCurrent && authoritativeEmpty !== true && noBackendAnswerEstablished\(outcome\?\.outcomes\)/,
    "uses the shared fail-closed silence predicate and rejects authoritative answers",
  );
  assert.match(src, /if \(!scopedReadLicensed\) \{/, "an authoritative whole answer is never overruled");
  assert.match(src, /let scopedReadLicensed = false;/, "and it licenses nothing until a read establishes it");
  assert.match(src, /fetchTypeScopedObjectInfo\(types, \{/, "the panel calls the type-scoped reader");
  assert.match(src, /deadlineMs: budget\.remaining\(\)/, "the scoped check gets the command's entire remaining time");
  assert.match(src, /const scopedGeneration = verifiedNodeDefCache\.generation\(\)/, "fences the scoped request at issuance");
  assert.match(src, /scopedGeneration !== verifiedNodeDefCache\.generation\(\)/, "rejects a scoped answer after schema invalidation");
  assert.match(src, /setWidgetSchemaProvenance = \(\) => "scoped"/, "the reply is told which route answered");
  // The scoped payload must never be filed as a whole observation, in either store.
  const wiring = src.slice(src.indexOf("fetchScopedObjectInfo: async (types)"), src.indexOf("fetchScopedObjectInfo: async (types)") + 1800);
  assert.equal(/objectInfoSnapshot\.record/.test(wiring), false, "never recorded into the #1223 snapshot");
  assert.equal(/recordObjectInfoTypes/.test(wiring), false, "never filed into the ever-seen history");
});

test("#1560: the shared handler asks the scoped route only AFTER the whole map produced nothing", () => {
  const src = readFileSync(SET_WIDGET_JS, "utf8");
  assert.match(src, /if \(!freshDefs && !promotedButUnresolvable && typeof fetchScopedObjectInfo === "function"\)/);
  // Placement is the whole fix: the fetch must sit BELOW the promotion resolution, or the
  // type set is not known and the payload answers the wrong question (#716/#821).
  const resolvedAt = src.indexOf("const promotedButUnresolvable =");
  const scopedAt = src.indexOf("typeof fetchScopedObjectInfo === \"function\"");
  const authAt = src.indexOf("assertTypeAgainstFreshBackend(freshDefs");
  assert.ok(resolvedAt > 0 && scopedAt > resolvedAt, "the scoped read is issued after the promotion is resolved");
  assert.ok(authAt > scopedAt, "and before the type authorization that consumes it");
});

// ─────────────── the scoped map must not become a hazard of its own (self-review) ─────────

// AN EXPLICIT TIMEOUT, because the failure mode this pins is a HANG. Delete the guard and
// `withTimeout` treats the 0 as NO bound, so the hanging fetch below never settles and
// `node --test` waits forever — a mutation that hangs the runner is indistinguishable from
// one that survived. With a bound it fails, loudly and by name.
test("#1560: a NON-POSITIVE budget attempts NOTHING — it must never become NO bound", { timeout: 15000 }, async () => {
  // `withTimeout` treats `ms <= 0` as no bound at all, so passing an exhausted budget
  // through would remove the bound at exactly the moment the command has already run out —
  // #1161 arriving through the mechanism meant to prevent it.
  let issued = 0;
  const hangingFetch = async () => {
    issued += 1;
    return new Promise(() => {});
  };
  for (const deadlineMs of [0, -5]) {
    const res = await fetchTypeScopedObjectInfo(["KSampler"], { fetchApi: hangingFetch, deadlineMs });
    assert.equal(res.defs, null, `deadlineMs ${deadlineMs} must authorize nothing`);
    assert.match(res.reason, /no time was left/);
  }
  assert.equal(issued, 0, "and not one request may be issued on a spent budget");
});

test("#1560: a budget a timer cannot express takes the SHIPPED default, never a 24.8-day grant", async () => {
  const backend = largeInstall({ defined: ["KSampler"] });
  for (const deadlineMs of [NaN, Infinity, 5e9, "soon", undefined]) {
    const res = await fetchTypeScopedObjectInfo(["KSampler"], { fetchApi: backend.fetchApi, deadlineMs });
    assert.ok(res.defs, `deadlineMs ${String(deadlineMs)} must fall back to ${SCOPED_OBJECT_INFO_DEADLINE_MS}ms and answer`);
  }
});

test("#1560: the scoped map is a well-behaved object — branding, freezing and enumeration do not throw", async () => {
  // A Proxy that answers `has` for a property its NON-EXTENSIBLE target does not own is an
  // invariant violation and throws TypeError, out of a module whose job is to answer.
  const backend = largeInstall({ defined: ["KSampler"] });
  const { defs } = await fetchTypeScopedObjectInfo(["KSampler"], { fetchApi: backend.fetchApi });
  assert.equal(SCOPED_OBJECT_INFO in defs, true, "the brand is readable");
  assert.equal(defs[SCOPED_OBJECT_INFO], true);
  assert.doesNotThrow(() => Object.freeze(defs), "object-info-cache.js freezes its payload; this must survive the same");
  assert.deepEqual(Object.keys(defs), ["KSampler"]);
  assert.equal(defs[Symbol.iterator], undefined, "an unrelated symbol is not a class type and passes through");
});

test("#1573: ENUMERATION of the scoped map does not throw — a SERIALIZER does, and the header now says so", async () => {
  // #1561's header claimed that "anything that ranges over the map (`Object.keys(defs).length`,
  // a serializer) sees a small, honest object rather than a throw". The first half is true;
  // the serializer half never was. `JSON.stringify` looks up `toJSON` and `String` looks up
  // `toString` — neither is a class type in `covered`, so the scope trap refuses both.
  //
  // This pins the MEASUREMENT the header now records, in both directions, so the header
  // cannot drift back into a claim nobody re-checked. It is not a change of behaviour: the
  // traps are untouched and this test passes against the merged head too.
  const backend = largeInstall({ defined: ["KSampler", "SubgraphA"] });
  const { defs } = await fetchTypeScopedObjectInfo(["KSampler", "SubgraphA"], { fetchApi: backend.fetchApi });

  assert.deepEqual(Object.keys(defs), ["KSampler", "SubgraphA"]);
  assert.equal(Object.keys(defs).length, 2, "the example the header names by name");
  assert.deepEqual(Object.getOwnPropertyNames(defs), ["KSampler", "SubgraphA"]);
  assert.equal(Object.entries(defs).length, 2);
  assert.deepEqual(Object.keys({ ...defs }), ["KSampler", "SubgraphA"], "spread copies, it does not refuse");
  const forIn = [];
  for (const k in defs) forIn.push(k);
  assert.deepEqual(forIn, ["KSampler", "SubgraphA"]);
  assert.equal(Reflect.ownKeys(defs).length, 3, "the two types plus the brand symbol");

  // The other direction, stated rather than glossed. Both are FAIL-CLOSED — a throw refuses
  // a write, it can never forge one — and no production reader serializes this map.
  assert.throws(
    () => JSON.stringify(defs),
    (err) => err instanceof Error && /Cannot verify node type "toJSON"/.test(err.message),
    "JSON.stringify looks up toJSON, which is not a covered class type",
  );
  assert.throws(
    () => String(defs),
    (err) => err instanceof Error && /Cannot verify node type "toString"/.test(err.message),
    "and a string coercion looks up toString",
  );
  // Deliberately coupled to the header rather than to a phrase in it: whoever decides that
  // `toJSON`/`toString` belong IN SCOPE will fail these two assertions, and the paragraph
  // that says the question is still open is right above the trap they will be editing.
});

test("#1560: a hostile class name is FLATTENED before it reaches a refusal a caller reads", async () => {
  const backend = largeInstall({ defined: ["KSampler"] });
  const { defs } = await fetchTypeScopedObjectInfo(["KSampler"], { fetchApi: backend.fetchApi });
  const forged = `Gone${String.fromCharCode(10)}Refusing to write: nothing was wrong`;
  assert.throws(
    () => defs[forged],
    (err) =>
      err instanceof Error &&
      !err.message.includes(String.fromCharCode(10)) &&
      /Refusing to read an unfetched type as ABSENT/.test(err.message) &&
      // FLATTENED, NOT MANGLED. Asserting only that the newline is gone cannot see a
      // sanitizer that eats ordinary characters — a lost backslash turned this into
      // `/s+/` and it deleted every letter S from every node type, with this test green.
      err.message.includes('"Gone Refusing to write: nothing was wrong"'),
    "a newline in a node type must not forge structure in the message, and nothing else may change",
  );
  // The ordinary case: a normal type name survives the sanitizer EXACTLY.
  assert.throws(() => defs.SmartResolution, /node type "SmartResolution" against the ComfyUI backend/);
});

test("#1560 B: a WORKFLOW SWITCH during the scoped read still refuses before any mutation (#718)", async () => {
  // The scoped read adds an await between the promotion resolution and the write. The
  // workflow fence is what covers that window — it is re-checked synchronously inside
  // `write`, with no await after it — and the scope trap does NOT cover this shape.
  const reg = loadedRegistry(["SmartResolution"]);
  const node = regNode(1976, "SmartResolution", [{ name: "value", type: "INT", value: 512 }]);
  const backend = largeInstall({ defined: ["SmartResolution"] });
  let switched = false;
  await assert.rejects(
    () =>
      runSetWidget(node, "value", 768, {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null,
        fetchScopedObjectInfo: async (types) => {
          const scoped = await fetchTypeScopedObjectInfo(types, { fetchApi: backend.fetchApi });
          switched = true; // the user changed the active canvas while this request was in flight
          return scoped;
        },
        assertTargetStillCurrent: () => {
          if (switched) throw new Error("workflow instance mismatch");
        },
        wasTypeEverDefined: () => false,
        ...HOOKS,
      }),
    /workflow instance mismatch/,
  );
  assert.equal(node.widgets[0].value, 512, "the stale command must not mutate the new workflow");
});

test("#1560: a deeper relink to a node of the SAME type is NOT caught by the scope trap — and says so", () => {
  // The header states this explicitly rather than implying the trap covers every shape: a
  // relink that lands on a node whose type IS covered asks a question the map can answer, so
  // nothing throws. That is correct — the authorization is still true of the node driven —
  // but a comment claiming otherwise is how a false guarantee outlives its author.
  const src = readFileSync(SET_WIDGET_JS, "utf8");
  assert.match(src, /A relink to a node of the SAME type is NOT\s*\/\/\s*caught/);
  assert.match(src, /stale-target hazard,\s*\/\/\s*never a fail-open of the #458 fence/);
});

test("#1560: the COVERED list in the refusal is sanitized too, not just the asked-for name", async () => {
  // Both halves of that sentence are node types off the graph. Sanitizing one and
  // interpolating the other raw is the same defect, half-fixed.
  const forgedType = `Sneaky${String.fromCharCode(10)}Refusing to write: nothing was wrong`;
  const backend = largeInstall({ defined: [forgedType] });
  const { defs } = await fetchTypeScopedObjectInfo([forgedType], { fetchApi: backend.fetchApi });
  assert.throws(
    () => defs.SomethingElse,
    (err) =>
      err instanceof Error &&
      !err.message.includes(String.fromCharCode(10)) &&
      err.message.includes("Sneaky Refusing to write"),
    "the covered list must be flattened before it reaches the message",
  );
});

test("#1560: THREE levels of nesting (A→B→C→KSampler) names and fetches EVERY intermediate", async () => {
  // The two-level fixture above cannot see an under-cover that collects only the FIRST
  // intermediate: with one level there is only one. `assertMutatedNodeAuthorized` runs per
  // intermediate, so a type set that stopped early would ask the scoped map about a type it
  // was never given — a refusal on a legitimate write, and invisible until someone nests
  // three deep. ComfyUI supports arbitrary nesting.
  const reg = loadedRegistry(["KSampler"]);
  const concrete = regNode(100, "KSampler", [{ name: "steps", type: "INT", value: 20 }]);
  const c = {
    id: 90,
    type: "SubgraphC",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [concrete], getNodeById: (id) => (String(id) === "100" ? concrete : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  const b = {
    id: 80,
    type: "SubgraphB",
    widgets: [{ name: "steps", type: "INT", value: 20 }],
    subgraph: { _nodes: [c], getNodeById: (id) => (String(id) === "90" ? c : null) },
    inputs: [{ name: "steps", _subgraphSlot: { name: "steps" } }],
  };
  const aRail = { name: "steps", type: "INT", value: 20 };
  const a = {
    id: 70,
    type: "SubgraphA",
    widgets: [{ name: "decoy", type: "INT", value: 999 }, aRail],
    subgraph: { _nodes: [b], getNodeById: (id) => (String(id) === "80" ? b : null) },
    inputs: [{ name: "steps", _widget: aRail, widget: { name: "steps" }, _subgraphSlot: { name: "steps" } }],
  };
  for (const t of ["SubgraphA", "SubgraphB", "SubgraphC"]) reg[t] = function Virtual() {};
  const resolveSource = (n, si) => {
    if (n === a && si?.name === "steps") return { sourceNodeId: "80", sourceWidgetName: "steps" };
    if (n === b && si?.name === "steps") return { sourceNodeId: "90", sourceWidgetName: "steps" };
    if (n === c && si?.name === "steps") return { sourceNodeId: "100", sourceWidgetName: "steps" };
    return null;
  };

  const resolution = resolvePromotedInnerTarget(a, "steps", resolveSource);
  assert.deepEqual(
    scopedAuthorizationTypes(a, resolution, true, resolveSource).sort(),
    ["KSampler", "SubgraphA", "SubgraphB", "SubgraphC"],
    "BOTH intermediates are named, not just the first",
  );

  const backend = largeInstall({ defined: ["KSampler"] });
  const { set } = await runSetWidget(a, "steps", 30, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => null,
    fetchScopedObjectInfo: panelStyleScopedRoute(backend.fetchApi, SILENT_OUTCOMES),
    wasTypeEverDefined: () => false,
    resolveSource,
    ...HOOKS,
  });
  assert.equal(set.value, 30);
  assert.equal(b.widgets[0].value, 30, "the promoted write lands on the immediate inner node");
  assert.deepEqual(
    backend.perClassCalls().sort(),
    ["/object_info/KSampler", "/object_info/SubgraphA", "/object_info/SubgraphB", "/object_info/SubgraphC"],
    "and every one of the four was actually asked about",
  );
});

// ── The blind-write ladder: the scoped map must not be mistaken for "nothing established" ──
//
// Found by an adversarial gate, not by the author, and it is the shape this repo has shipped
// before: #1223's own snapshot branch was dead code until a test drove the REAL detached map
// through it. Here the branch keyed on `provenance === "scoped"` could never fire, because
// the ladder re-asks for a live map and the re-ask re-enters the panel's shared
// `readObjectInfo`, which re-stamps the provenance on every exit path it has. So the stamp
// said "none" while the map in hand was the scoped one, and what fired instead told the
// caller the provenance could not be established AT ALL and to reconnect — false twice over.

/** A combo whose own `options.values` callback THROWS: the valid set is unreadable client-side. */
const OPTIONS_THROW = () => {
  throw new Error("the node's own populate() failed");
};

/**
 * The panel's provenance stamp, reproduced with the property that made the branch dead: the
 * shared `readObjectInfo` re-stamps on EVERY exit path, so a FAILED live re-ask overwrites
 * whatever the scoped read stamped. A test that stubbed a constant `"scoped"` here would
 * pass against the broken code and prove nothing.
 */
function panelStyleStamp() {
  let stamp = () => "none";
  return {
    schemaProvenance: () => stamp(),
    onScoped: () => {
      stamp = () => "scoped";
    },
    // The panel's own failed-read exit: `setWidgetSchemaProvenance = () => "none"`.
    refetchObjectInfoLive: async () => {
      stamp = () => "none";
      return null;
    },
  };
}

function scopedLadderFixture(serverOptions) {
  const reg = loadedRegistry(["StarOllamaPromptHelper"]);
  const widget = { name: "model", type: "combo", options: { values: OPTIONS_THROW }, value: "" };
  const node = regNode(9, "StarOllamaPromptHelper", [widget]);
  const backend = largeInstall({
    defined: ["StarOllamaPromptHelper"],
    perClass: async (type) =>
      type === "StarOllamaPromptHelper"
        ? {
            ok: true,
            status: 200,
            json: async () => ({ StarOllamaPromptHelper: { input: { required: { model: [serverOptions, {}] } } } }),
          }
        : undefined,
  });
  const stamp = panelStyleStamp();
  return {
    widget,
    run: () =>
      runSetWidget(node, "model", "qwen3-vl:8b", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null,
        fetchScopedObjectInfo: panelStyleScopedRoute(backend.fetchApi, SILENT_OUTCOMES, stamp.onScoped),
        refetchObjectInfoLive: stamp.refetchObjectInfoLive,
        schemaProvenance: stamp.schemaProvenance,
        refreshCombos: (fresh, targetNode, defTypeKey, nameMap) =>
          refreshComboOptionsFromDefs(targetNode, fresh, defTypeKey, nameMap),
        wasTypeEverDefined: () => true,
        ...HOOKS,
      }),
  };
}

test("#1560: an unreadable combo on a scoped map refuses by NAMING the scoped read — server publishes a list", async () => {
  // The server's list is NON-empty, so the empty-list shape test is false and the ladder used
  // to fall through to the generic end-of-ladder refusal — which reports only that the combo
  // could not be read, sending the caller to look at their value while the actual cause is a
  // backend whose whole /object_info never lands.
  const { widget, run } = scopedLadderFixture(["qwen3-vl:8b", "llama3"]);
  await assert.rejects(run(), (err) => {
    assert.match(err.message, /TYPE-SCOPED read \(#1560\)/, "the refusal must name the route that DID answer");
    assert.doesNotMatch(err.message, /provenance could not be established at all/);
    return true;
  });
  assert.equal(widget.value, "", "fails closed — a partial view of the schema licenses nothing");
});

test("#1560: …and when the scoped map declares the list EMPTY, it still does not say 'reconnect'", async () => {
  // The direction that actually shipped a FALSE cause. An empty list makes the shape test
  // true, so the pre-fix code refused with "the schema provenance could not be established at
  // all … Reconnect to ComfyUI and retry" — while a type-scoped read had answered, live,
  // moments earlier, and on this install reconnecting cannot help at all.
  const { widget, run } = scopedLadderFixture([]);
  await assert.rejects(run(), (err) => {
    assert.match(err.message, /TYPE-SCOPED read \(#1560\)/);
    assert.doesNotMatch(
      err.message,
      /provenance could not be established at all/,
      "a type-scoped read ANSWERED — claiming nothing was established is the #982 misattribution",
    );
    assert.match(err.message, /reconnecting need not help/, "and the remedy must be the one that can work");
    return true;
  });
  assert.equal(widget.value, "", "fails closed");
});

test("#1560: a LIVE re-ask that SUCCEEDS is used — the brand follows the payload, not a flag", async () => {
  // The other direction of the same fix. A stamp captured when the scoped map was adopted
  // would still read "scoped" after the re-ask replaced it with a whole live map; the brand
  // is a property of the payload, so it answers for the NEW one with nothing to reset.
  const reg = loadedRegistry(["StarOllamaPromptHelper"]);
  const widget = { name: "model", type: "combo", options: { values: OPTIONS_THROW }, value: "" };
  const node = regNode(9, "StarOllamaPromptHelper", [widget]);
  const backend = largeInstall({
    defined: ["StarOllamaPromptHelper"],
    perClass: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ StarOllamaPromptHelper: { input: { required: { model: [[], {}] } } } }),
    }),
  });
  let stamp = () => "none";
  const res = await runSetWidget(node, "model", "qwen3-vl:8b", {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => null,
    fetchScopedObjectInfo: panelStyleScopedRoute(backend.fetchApi, SILENT_OUTCOMES, () => {
      stamp = () => "scoped";
    }),
    // The whole map lands on the re-ask — a WHOLE payload, so it carries no scoped brand.
    refetchObjectInfoLive: async () => {
      stamp = () => "live";
      return { StarOllamaPromptHelper: { input: { required: { model: [[], {}] } } } };
    },
    schemaProvenance: () => stamp(),
    refreshCombos: (fresh, targetNode, defTypeKey, nameMap) =>
      refreshComboOptionsFromDefs(targetNode, fresh, defTypeKey, nameMap),
    wasTypeEverDefined: () => true,
    ...HOOKS,
  });
  assert.equal(res.set.value, "qwen3-vl:8b", "a LIVE whole map declaring the list empty licenses the write");
  // Which acceptance admitted it is decided at COERCION time: this callback throws on every
  // read, so the disclosure is the UNREADABLE one. What matters here is that the write landed
  // at all — the live re-ask licensed it, and the scoped refusal did not pre-empt that.
  assert.equal(res.option_list_unreadable, true, "the caller is still told nothing validated the value");
});

test("#1573: a LIVE type-scoped map that declared the list empty is never reported as 'not fetched live'", async () => {
  // The third inaccuracy #1561's own gate left behind. The re-ask branch is gated on
  // `provenance !== "live"`, and "scoped" is not "live" — so a type-scoped map reaches this
  // refusal, which told the caller the schema "was not fetched live". It WAS: per class,
  // moments earlier, on the very route this whole change exists to add. A scoped map is
  // about FEWER types, never about older ones.
  //
  // Drives the real ladder to the real refusal and asserts the OUTPUT — plus the request
  // list, which is what makes "fetched live" a measurement here rather than a reading.
  const reg = loadedRegistry(["StarOllamaPromptHelper"]);
  const widget = { name: "model", type: "combo", options: { values: OPTIONS_THROW }, value: "" };
  const node = regNode(9, "StarOllamaPromptHelper", [widget]);
  // The SCOPED map declares this input's option list EMPTY…
  const backend = largeInstall({
    defined: ["StarOllamaPromptHelper"],
    perClass: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ StarOllamaPromptHelper: { input: { required: { model: [[], {}] } } } }),
    }),
  });
  let stamp = () => "none";
  await assert.rejects(
    () =>
      runSetWidget(node, "model", "qwen3-vl:8b", {
        registry: reg,
        getRegistry: () => reg,
        getFreshObjectInfo: async () => null,
        fetchScopedObjectInfo: panelStyleScopedRoute(backend.fetchApi, SILENT_OUTCOMES, () => {
          stamp = () => "scoped";
        }),
        // …and the whole-map re-ask lands, publishing a REAL list. That disagreement is the
        // hole the re-ask exists to find, and it routes to this message.
        refetchObjectInfoLive: async () => {
          stamp = () => "live";
          return { StarOllamaPromptHelper: { input: { required: { model: [["qwen3-vl:8b", "llama3"], {}] } } } };
        },
        schemaProvenance: () => stamp(),
        refreshCombos: (fresh, targetNode, defTypeKey, nameMap) =>
          refreshComboOptionsFromDefs(targetNode, fresh, defTypeKey, nameMap),
        wasTypeEverDefined: () => true,
        ...HOOKS,
      }),
    (err) => {
      assert.ok(
        err.message.includes(
          "The schema that appeared to declare this input's option list empty has since been " +
            "REPLACED, and the live re-read NO LONGER declares it empty",
        ),
        `the refusal must claim only the replacement it observed. Got: ${err.message}`,
      );
      assert.ok(
        err.message.includes("either it now publishes a real option list for this input, or it no longer describes"),
        "and it must still name both possibilities rather than choosing one",
      );
      return true;
    },
  );
  assert.deepEqual(
    backend.perClassCalls(),
    ["/object_info/StarOllamaPromptHelper"],
    "the schema that said EMPTY was fetched live, per class — which is why the old wording was false",
  );
  assert.equal(widget.value, "", "fails closed either way; only the wording changed");
});
