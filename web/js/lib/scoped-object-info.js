/**
 * #1560 — on a LARGE install the whole `/object_info` NEVER lands, so `set_widget` refuses
 * FOR THE LIFE OF THE TAB.
 *
 * Reported on ~1023 models and hundreds of custom packs (ComfyUI 0.33.0 / frontend 1.49.6):
 * both whole-schema probes time out — `api.getNodeDefs()` on its 10s share and
 * `GET /object_info` on its 5s share of the 20s budget — while ComfyUI is idle and healthy,
 * `/system_stats` answers 200, and `GET /object_info/SmartResolution` answers 200 in ~2.7KB.
 * Because no WHOLE map ever lands, #1223's snapshot is never populated either, so every
 * `panel_set_widget` refuses permanently. `panel_disconnect` on the same nodes succeeds,
 * because it does not go through this fence.
 *
 * REPRODUCED BY EXECUTION before anything was written, against the real oracle + real burst
 * cache + real #1223 snapshot + the real `runSetWidget` body: two hung whole-map routes,
 * ZERO per-class requests ever issued, the widget never written, and the identical refusal
 * on the second call 15,015 ms later. That is a PERMANENT refusal on a healthy backend, not
 * the transient busy-backend timeout the budget was designed for.
 *
 * WHY THE OBVIOUS FIX IS FORBIDDEN, and what this does instead.
 *
 * `object-info-oracle.js` records that the per-class `/object_info/<Type>` route `add_node`
 * uses is NOT interchangeable with the whole map here: "`set_widget` authorizes TWO types
 * for a promoted write and fetches BEFORE resolving which target it writes to, so a
 * single-class payload answers one question and READS THE OTHER AS ABSENT (#716/#821)."
 * That is exactly right about a bare single-class payload, and it is the reason this module
 * is not one.
 *
 * MEASURED, not assumed: the ordering the oracle blames is reversible. Driving the REAL
 * resolution helpers with NO schema at all (`resolvePromotedInnerTarget` →
 * `followPromotionToConcrete` → `collectPromotionIntermediates`) on the nested A→B→KSampler
 * shape the #458 suite uses yields the COMPLETE set of types the fence will ask about —
 * `SubgraphA`, `SubgraphB`, `KSampler` — from the GRAPH, with no `/object_info` consulted.
 * Moving the whole-map fetch below that resolution also passes the entire unit suite
 * unchanged (6115 pass / 0 fail, identical to baseline).
 *
 * BUT THE REORDER IS NOT WHAT SHIPPED, and that is a finding rather than a preference. The
 * fetch that must know the target is the FALLBACK, not the first one — and the fallback
 * already sits after the resolution. Moving the primary fetch would make the resolution
 * older by up to a whole 20s budget on EVERY call, including the healthy ones, to buy
 * something only the failing path needs. So `set-widget.js` keeps its fetch exactly where it
 * was and asks THIS module only after the whole-map oracle and the #1223 snapshot have both
 * produced nothing.
 *
 * WHAT MAKES THIS ANSWER THE RIGHT QUESTION. The caller hands in the EXACT, complete set of
 * class types the fence is about to ask about — for a promoted write that is the outer
 * SubgraphNode, every intermediate container, AND the ultimate concrete node, not one of
 * them. Every one of those types is fetched, and the returned map REFUSES to answer for any
 * type outside that set: an out-of-scope read THROWS rather than reading as absent. So the
 * #716/#821 failure mode is removed BY CONSTRUCTION rather than by remembering not to trip
 * it.
 *
 * WHAT THAT TRAP DOES **NOT** COVER, corrected here because the first version of this note
 * claimed it covered the whole of the await `set-widget.js` adds, and it does not. A
 * promotion relinked mid-fetch that resolves deeper to a concrete node of a DIFFERENT type
 * asks about a type this map was never given, so it throws and the write refuses. A relink
 * to a node of the SAME type asks a question this map CAN answer, and nothing throws — which
 * is correct, since the authorization is still true of the node actually driven. The full
 * accounting of that window, including what genuinely does get older and why it is a
 * stale-TARGET hazard rather than a fail-open of the #458 fence, is at the call site.
 *
 * FAIL-CLOSED IS UNCHANGED, IN BOTH DIRECTIONS.
 *
 *   - ALL-OR-NOTHING. Every requested type must come back DEFINITIVE — HTTP 200 with a
 *     parseable object body, which on this route is either the class (present) or `{}`
 *     (absent; `single-node-def.js` verified that ComfyUI answers absence as `{}`/200, not
 *     404). One indefinite answer and the whole scoped map is null and the caller refuses
 *     exactly as it does today. A partial map must never authorize a partial question.
 *   - ABSENCE STILL REFUSES. A type the backend no longer defines comes back `{}`, reads as
 *     definitively absent, and `assertTypeAgainstFreshBackend`'s unchanged #458 ever-seen
 *     gate refuses it as a removed pack. This route only ever adds a way to ASK; it decides
 *     nothing.
 *   - THE SILENCE LICENCE IS THE CALLER'S TO GRANT. This must not be consulted when a
 *     whole-map route ANSWERED something unusable — a frontend client expressing deny-all as
 *     `{}` is an ANSWER, and overruling it with a broader per-class read is the one direction
 *     the oracle's own note forbids. `set-widget.js` never sees the transport outcomes, so
 *     the panel wires this behind the SAME `noBackendAnswerEstablished` test #1223's snapshot
 *     uses, and hands over a null map otherwise.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not populate the #1223 snapshot — that file
 * requires an explicit `whole: true` claim precisely so a per-class payload can never make
 * every OTHER type read as removed — and it does not help `panel_refresh_nodes`, which
 * re-registers the whole schema and is an install-wide question no per-class route can
 * answer. Both stay refused on a backend whose whole map never lands, and that is correct.
 *
 * COST, MEASURED BY THE REPO ALREADY. #767: `GET /object_info` 5,413,770 bytes / 167 ms
 * against `GET /object_info/KSampler` 3,246 bytes / 1.2 ms on a 63-pack install; the #1560
 * reporter measured `/object_info/SmartResolution` at ~2.7 KB / 200 on an install where the
 * whole dump misses a 5,000 ms share. A promoted write asks for at most a handful of these.
 *
 * AND RE-MEASURED HERE, ON THE REPORTER'S VERSION FAMILY, because everything above rests on
 * a route contract #767 established on ComfyUI 0.30.2 and this ships against 0.33.x. A
 * comment that asserts a premise nobody re-checked is how a dormant fix reads as correct, so
 * a live ComfyUI **0.33.2** was stood up and asked directly:
 *
 *     GET /object_info/KSampler                 200   2,994 bytes   0.21 s   {"KSampler": {…}}
 *     GET /object_info/DefinitelyNotARealClass  200       2 bytes   0.21 s   {}
 *     GET /object_info                          200   1,540,926 bytes        853 types
 *
 * Three things that matter, and the second is the one this module's safety actually rests on:
 *
 *   1. ABSENCE IS STILL `{}`/200, not a 404, on 0.33.x — the contract `readOneType` treats as
 *      a definitive absence, now confirmed on the version the reporter runs rather than
 *      inherited from a measurement three minor versions old.
 *   2. THE PER-CLASS DEF IS BYTE-IDENTICAL to the whole map's entry for the same class:
 *      `JSON.stringify(perClass.KSampler) === JSON.stringify(whole.KSampler)` is `true`. So
 *      for the types it covers this is not a narrower or differently-shaped payload that
 *      merely happens to answer membership — it is the same object the whole map would have
 *      handed over, which is what makes the per-type readers downstream (`uploadInputConfig`,
 *      `refreshCombos`, `serverDeclaresEmptyComboOptions`) correct on it and not merely safe.
 *   3. That whole map is 1.5 MB with ZERO custom packs installed. The reporter has hundreds.
 *
 * WHAT THIS STILL DOES NOT ESTABLISH, stated rather than glossed: a PROXY answering 200 with
 * a non-schema JSON object would read as a definitive absence and refuse a type the backend
 * does define. That direction is fail-closed — a refusal, never a wrongful write — and a
 * proxy answering 200 with HTML fails the parse and disqualifies the whole scoped map
 * instead. Anyone who finds a shape that fails the OTHER way should treat this paragraph as
 * the thing that was wrong.
 */

import { withTimeout } from "./bounded-step.js";

/**
 * The whole scoped set shares ONE deadline, and the requests run concurrently, so this is
 * the wall clock for all of them rather than a per-type bound that multiplies.
 *
 * 5,000 ms is ~4,000x the 1.2 ms this route was measured at (#767) and ~1,800x the
 * reporter's 2.7 KB response. It is deliberately generous: this is only ever reached AFTER a
 * whole-map budget has already been spent, so the useful thing left is to ASK, and the
 * remaining room under the bridge's 30 s command timeout is what actually binds. The caller
 * passes what the COMMAND has left (`budget.bounded`), so this is a ceiling, not a promise.
 */
export const SCOPED_OBJECT_INFO_DEADLINE_MS = 5000;

/**
 * How many distinct class types one write may ask about.
 *
 * A promoted write asks about the outer node, its intermediates and the concrete target. A
 * pathological or hostile promotion chain could otherwise turn one refusal into an unbounded
 * fan-out of requests against a backend that is already struggling — which is the condition
 * this whole path exists for. Above the cap the scoped map is simply not built and the
 * caller refuses as it does today.
 */
export const MAX_SCOPED_TYPES = 8;

/** Marks a map as type-scoped, for anything that needs to know what it is holding. */
export const SCOPED_OBJECT_INFO = Symbol.for("comfyui-mcp.scopedObjectInfo");

/**
 * Read one class's def from a `/object_info/<Type>` reply, DISTINGUISHING the three answers
 * that matter: it is defined, it is definitively NOT defined, or nothing definitive came
 * back.
 *
 * `single-node-def.js` collapses the middle case into null — correct for its caller, which
 * only wants a confirmation and falls through to the full fetch on every doubt. Here the
 * difference is load-bearing: an absent type must reach the #458 ever-seen gate as an
 * ABSENCE, while an unreadable reply must disqualify the whole scoped map.
 */
async function readOneType(type, fetchApi) {
  let res;
  try {
    res = await fetchApi(`/object_info/${encodeURIComponent(type)}`);
  } catch (err) {
    return { definitive: false, why: describe(`GET /object_info/${type} threw`, err) };
  }
  // Reading `ok`/`status` is itself an operation that can throw — an extension may
  // monkey-patch `fetchApi` and hand back a proxied or getter-backed response. The oracle
  // learned this the hard way (#1161); the same guard applies here.
  let ok = false;
  let status = "unknown";
  try {
    ok = !!res && res.ok === true;
    status = String(res?.status ?? "unknown");
  } catch (err) {
    return { definitive: false, why: describe(`GET /object_info/${type} returned an unreadable response`, err) };
  }
  if (!ok) {
    // A non-2xx establishes nothing about the TYPE. An older ComfyUI without this route
    // answers 404 and a proxy sign-in page answers 200 with HTML — neither is evidence the
    // backend lacks the class (`single-node-def.js` says the same about its own fast path).
    return { definitive: false, why: `GET /object_info/${type} was not OK (status ${status})` };
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { definitive: false, why: describe(`GET /object_info/${type} body did not parse`, err) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { definitive: false, why: `GET /object_info/${type} returned a non-object body` };
  }
  let def;
  try {
    def = Object.prototype.hasOwnProperty.call(body, type) ? body[type] : undefined;
  } catch (err) {
    return { definitive: false, why: describe(`GET /object_info/${type} body could not be inspected`, err) };
  }
  if (def === undefined) {
    // ComfyUI answers "no such class" as `{}` with HTTP 200 (verified in #767 against a type
    // the install did not have). THIS is the definitive absence the ever-seen gate needs.
    return { definitive: true, present: false };
  }
  if (!def || typeof def !== "object" || Array.isArray(def)) {
    // The key is there but the value is not a def. Nothing definitive was established about
    // the class, and a shape the readers below cannot use must not read as "defined".
    return { definitive: false, why: `GET /object_info/${type} returned a non-def value for the class` };
  }
  return { definitive: true, present: true, def };
}

/** Control characters, so a newline in an untrusted message cannot forge structure in a reply. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * Flatten and cap a class NAME that came off the graph before it rides into a message a
 * caller reads. Separate from `describe` because that one prefixes a label, and a refusal
 * reading `node type ": Foo"` is a defect of its own.
 */
function sanitizeName(value) {
  let text = "";
  try {
    text = String(value ?? "");
  } catch {
    return "(an unprintable value)";
  }
  // `/\s+/`, NOT `/s+/`. A backslash lost in transit made this delete every LETTER S from
  // every node type in a refusal — "SmartResolution" reading back as "SmartRe olution" — and
  // the test that was supposed to cover it only asserted that a NEWLINE was gone, so it
  // passed. The assertions below now pin the name itself, not just the absence of a newline.
  const flat = text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (!flat) return "(an unnamed type)";
  return flat.length > 120 ? `${flat.slice(0, 120)}… (truncated)` : flat;
}

/** Bounded, flattened description of an untrusted throw, for a message a caller reads. */
function describe(label, err) {
  let raw = "";
  try {
    raw = err instanceof Error ? err.message : err == null ? "" : err;
  } catch {
    raw = "(an unprintable value)";
  }
  let text = "";
  try {
    text = String(raw ?? "");
  } catch {
    return `${label}: (an unprintable value)`;
  }
  const flat = text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  const capped = flat.length > 160 ? `${flat.slice(0, 160)}… (truncated)` : flat;
  return capped ? `${label}: ${capped}` : label;
}

/**
 * Wrap the fetched defs so a question this map was never asked to answer THROWS instead of
 * reading as an absence.
 *
 * This is the whole #716/#821 defence. `freshBackendDefinesType` is
 * `hasOwnProperty(defs, type)`, which cannot tell "the backend does not define it" from "we
 * never asked" — on a whole map those coincide, on a scoped one they emphatically do not.
 * So the map itself refuses the second question rather than trusting every present and
 * future reader to avoid asking it.
 *
 * SYMBOLS PASS THROUGH. Callers brand and test payloads with symbol keys
 * (`CACHE_OUTCOME`), and those are never class types.
 */
function scopedView(present, covered) {
  const target = Object.create(null);
  for (const [type, def] of present) target[type] = def;
  // BRANDED ON THE TARGET, not answered by a trap. A `has`/`get` trap that reports a
  // property the NON-EXTENSIBLE target below does not own violates a Proxy invariant and
  // throws TypeError — from a module whose job is to answer a question, not to explode.
  target[SCOPED_OBJECT_INFO] = true;
  // FROZEN, and the traps below deliberately do NOT override mutation. object-info-cache.js
  // freezes the whole-map payload for the same reason — the level the fence reads is
  // `hasOwnProperty(defs, type)`, and a consumer that added a key would authorize a type
  // nobody installed. Freezing the TARGET rather than trapping writes also keeps
  // `Object.freeze(defs)` working on the proxy; a hand-written `defineProperty: false` makes
  // that a TypeError instead.
  Object.freeze(target);
  // Built ONCE, and sanitized: every one of these names came off the graph too, and a
  // newline inside one would forge structure in the refusal just as the asked-for name would.
  const coveredNames = [...covered].map((t) => sanitizeName(t)).join(", ");
  const inScope = (prop) => typeof prop === "symbol" || covered.has(prop);
  const refuse = (prop) => {
    // The name came off the GRAPH and rides into a message someone reads, so it is flattened
    // and capped exactly like every other untrusted string in this family.
    const name = sanitizeName(prop);
    throw new Error(
      `Cannot verify node type "${name}" against the ComfyUI backend: the whole ` +
        `/object_info never answered, so only the types this write resolves to were fetched ` +
        `per class (${coveredNames}) — and "${name}" is not one of them. ` +
        `Refusing to read an unfetched type as ABSENT (#716/#821). Reconnect ComfyUI, or wait ` +
        `for /object_info to answer again, and retry.`,
    );
  };
  return new Proxy(target, {
    get(t, prop, recv) {
      if (!inScope(prop)) refuse(prop);
      return Reflect.get(t, prop, recv);
    },
    has(t, prop) {
      if (!inScope(prop)) refuse(prop);
      return Reflect.has(t, prop);
    },
    getOwnPropertyDescriptor(t, prop) {
      if (!inScope(prop)) refuse(prop);
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
    // Only the types actually PRESENT are enumerated, so ENUMERATING the map sees a small,
    // honest object rather than a throw. It still cannot see the install, which is why the
    // scope trap above exists.
    //
    // MEASURED against this module as merged (#1561, `a1844f68`) on node v24.16.0, driving a
    // two-type scoped map: `Object.keys` → 2 names, `Object.getOwnPropertyNames`,
    // `Object.entries`, `for…in` and spread `{...defs}` all succeed, and `Reflect.ownKeys`
    // returns 3 (the two types plus the brand symbol).
    //
    // A SERIALIZER IS NOT COVERED, and an earlier version of this note said it was. That was
    // never true and is corrected here rather than reworded (#1573): `JSON.stringify(defs)`
    // looks up `toJSON` and `String(defs)` looks up `toString`, neither is a class type in
    // `covered`, so the `get` trap above REFUSES both and each THROWS — with a message that
    // reads as though `toJSON` were a node type. Measured on the same run.
    //
    // It is a documented edge and not a fault today: nothing reads this map by serializing
    // it. Checked, not assumed — every consumer of the map `set-widget.js` holds
    // (`freshBackendDefinesType`, `assertTypeAgainstFreshBackend`, `serverDeclaresEmptyComboOptions`,
    // `uploadInputConfig`, `refreshCombos`, `isTypeScopedObjectInfo`) reads it by KEY, and a
    // search of `web/js` finds no `JSON.stringify` of, and no string coercion of, an
    // `/object_info` defs map. The scope of that check is the whole scope there is: this map
    // is built here and consumed inside the panel, it never crosses the bridge, so no
    // orchestrator reader can reach it to serialize. The direction is fail-closed anyway — a
    // throw refuses a write, it cannot forge one — but do not ADD a reader that serializes
    // this map without reading the paragraph below first.
    //
    // Whether `toJSON`/`toString`/`Symbol.toPrimitive` should simply be IN SCOPE — none of
    // them is a class type, and symbols already pass through — is a real question and it is
    // a BEHAVIOUR change, so it is deliberately NOT decided here. #1573 left it open.
    ownKeys(t) {
      return Reflect.ownKeys(t);
    },
  });
}

/**
 * Ask the backend about EXACTLY the class types this write will be authorized against.
 *
 * @param {string[]} types  the complete set the fence will ask about — for a promoted write
 *   the outer SubgraphNode, every intermediate, AND the concrete target. A set that is
 *   missing one of them does not produce a wrong answer; it produces a refusal, because the
 *   returned map throws on the type it was not asked to cover.
 * @param {object} opts
 * @param {(route: string) => Promise<any>} opts.fetchApi
 * @param {number} [opts.deadlineMs]  wall clock for the whole set (requests run concurrently)
 * @param {object} [opts.timers]      test seam, same shape `bounded-step.js` takes
 * @returns {Promise<{defs: object|null, covered: string[], reason: string}>}
 *   `defs` is non-null ONLY when EVERY requested type was answered definitively.
 */
export async function fetchTypeScopedObjectInfo(
  types,
  { fetchApi, deadlineMs = SCOPED_OBJECT_INFO_DEADLINE_MS, timers } = {},
) {
  const wanted = [];
  const seen = new Set();
  for (const t of Array.isArray(types) ? types : []) {
    if (typeof t !== "string" || t === "" || seen.has(t)) continue;
    seen.add(t);
    wanted.push(t);
  }
  if (wanted.length === 0) {
    return { defs: null, covered: [], reason: "no node type could be resolved to ask the backend about" };
  }
  if (wanted.length > MAX_SCOPED_TYPES) {
    return {
      defs: null,
      covered: [],
      reason:
        `this write resolves through ${wanted.length} node types, more than the ` +
        `${MAX_SCOPED_TYPES} a type-scoped /object_info read will issue`,
    };
  }
  if (typeof fetchApi !== "function") {
    return { defs: null, covered: [], reason: "no fetchApi is wired for the type-scoped route" };
  }

  // ONE effective bound, decided here and reported here.
  //
  // A NON-NUMBER, a NaN/Infinity, or a value `setTimeout` cannot express takes the shipped
  // default — none of those is a budget a caller can have meant, and clamping an over-range
  // one to 2^31-1 turns nonsense into a ~24.8-day grant (object-info-oracle.js measured that
  // trap). A non-positive NUMBER is a REAL choice and is obeyed by attempting nothing:
  // `withTimeout` treats `ms <= 0` as NO BOUND, so passing it through would remove the bound
  // at exactly the moment the command has already run out, which is #1161 arriving through
  // the mechanism meant to prevent it. (`budget.bounded` floors at 1 ms for this reason, so
  // the panel never reaches this arm — a direct caller can.)
  const requested = typeof deadlineMs === "number" ? deadlineMs : NaN;
  const effectiveMs =
    Number.isFinite(requested) && requested <= 2 ** 31 - 1 ? requested : SCOPED_OBJECT_INFO_DEADLINE_MS;
  if (!(effectiveMs > 0)) {
    return {
      defs: null,
      covered: [],
      reason: `no time was left to ask about ${wanted.join(", ")} per class`,
    };
  }

  const TIMED_OUT = Symbol("scoped-object-info-timeout");
  const settled = await withTimeout(
    Promise.all(wanted.map((t) => readOneType(t, fetchApi))).then(
      (value) => ({ value }),
      (err) => ({ err }),
    ),
    effectiveMs,
    () => TIMED_OUT,
    timers ?? undefined,
  );
  if (settled === TIMED_OUT) {
    return {
      defs: null,
      covered: [],
      reason: `the type-scoped /object_info reads (${wanted.join(", ")}) did not all answer within ${effectiveMs}ms`,
    };
  }
  if (settled?.err) {
    return { defs: null, covered: [], reason: describe("the type-scoped /object_info reads failed", settled.err) };
  }
  const results = settled.value;
  const present = [];
  for (let i = 0; i < wanted.length; i += 1) {
    const r = results[i];
    if (!r?.definitive) {
      // ALL OR NOTHING. One type this write needs is unestablished, so the map cannot
      // authorize the write — and a map that answers some of the question is precisely what
      // #716/#821 were.
      return { defs: null, covered: [], reason: r?.why || `GET /object_info/${wanted[i]} established nothing` };
    }
    if (r.present) present.push([wanted[i], r.def]);
  }
  return { defs: scopedView(present, new Set(wanted)), covered: wanted, reason: "" };
}

/**
 * Is THIS the map `fetchTypeScopedObjectInfo` handed back?
 *
 * Asked of the payload itself rather than of a stored stamp, and that is the whole point.
 * `set-widget.js` re-reads its schema provenance AFTER a live re-ask, and the panel's shared
 * `readObjectInfo` re-stamps that provenance on every one of its exit paths — so a "the
 * schema is type-scoped" fact recorded at the moment the map was adopted is overwritten
 * before the ladder reads it, and the branch keyed on it becomes dead code that never fires
 * while a message asserting a DIFFERENT, false cause fires in its place. That is not
 * hypothetical: it is exactly how #1223's own snapshot branch came to be dead
 * (`node-resolve.test.mjs` records it), and it happened again here one field over.
 *
 * A brand carried by the object cannot drift, because it is a property of the very payload
 * being ruled on: if the re-ask replaces that payload with a whole map, this answers false
 * for the new one without anybody having to remember to clear a flag.
 *
 * A foreign object that THROWS on a symbol read is not this module's map, so false is the
 * right answer for it — and a throw out of a provenance question would replace a refusal
 * with a crash.
 */
export function isTypeScopedObjectInfo(defs) {
  if (!defs || typeof defs !== "object") return false;
  try {
    return defs[SCOPED_OBJECT_INFO] === true;
  } catch {
    return false;
  }
}
