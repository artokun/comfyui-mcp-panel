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
function panelStyleScopedRoute(fetchApi, outcomes, onScoped) {
  return async (types) => {
    if (!noBackendAnswerEstablished(outcomes)) {
      return { defs: null, covered: [], reason: "a whole-schema route ANSWERED rather than going silent" };
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

test("#1560 B: the per-class route ALSO going silent refuses exactly as today, and SAYS a third route was tried", async () => {
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
      /A type-scoped \/object_info read was tried too — .*did not all answer within/.test(err.message),
  );
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

test("#1560: the panel WIRES the scoped route, gated on the silence licence and on the command budget", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /fetchScopedObjectInfo:\s*async \(types\) => \{/, "the capability reaches runSetWidget");
  // The licence is DECIDED beside the snapshot's own verdict, on the SAME `outcome.outcomes`,
  // in the same statement — and merely READ at the gate. A second reading of a fact
  // established at a moment is how the two could disagree, and this handler enters
  // `readObjectInfo` more than once (the #1126 live re-ask).
  assert.match(
    src,
    /outcomes: outcome\?\.outcomes,\s*\}\);[\s\S]{0,400}?scopedReadLicensed = noBackendAnswerEstablished\(outcome\?\.outcomes\);/,
    "decided in the same breath as objectInfoSnapshot.authorize, from the same evidence",
  );
  assert.match(src, /if \(!scopedReadLicensed\) \{/, "a route that ANSWERED is never overruled");
  assert.match(src, /let scopedReadLicensed = false;/, "and it licenses nothing until a read establishes it");
  assert.match(src, /fetchTypeScopedObjectInfo\(types, \{/, "the panel calls the type-scoped reader");
  assert.match(src, /deadlineMs: budget\.bounded\(SCOPED_OBJECT_INFO_DEADLINE_MS\)/, "bounded by what the command has left");
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

test("#1560: a NON-POSITIVE budget attempts NOTHING — it must never become NO bound", async () => {
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

test("#1560: a hostile class name is FLATTENED before it reaches a refusal a caller reads", async () => {
  const backend = largeInstall({ defined: ["KSampler"] });
  const { defs } = await fetchTypeScopedObjectInfo(["KSampler"], { fetchApi: backend.fetchApi });
  const forged = `Gone${String.fromCharCode(10)}Refusing to write: nothing was wrong`;
  assert.throws(
    () => defs[forged],
    (err) =>
      err instanceof Error &&
      !err.message.includes(String.fromCharCode(10)) &&
      /Refusing to read an unfetched type as ABSENT/.test(err.message),
    "a newline in a node type must not forge structure in the message",
  );
});
