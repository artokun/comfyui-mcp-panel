/**
 * #982 — the write fence refused with "object_info is unavailable — the backend is
 * unreachable or the fetch failed" while the reporter's ComfyUI was healthy and
 * `/object_info/VAELoader` answered on the same machine. Two separate problems in one
 * sentence:
 *
 *   1. ONE TRANSPORT. The oracle only ever asked `api.getNodeDefs()`. When that call
 *      fails — and after a restart the frontend's client can fail while the HTTP route
 *      answers perfectly well — there was no second way to ask, so a reachable backend
 *      read as an unreachable one.
 *   2. A DISJUNCTION INSTEAD OF AN OBSERVATION. "unreachable or the fetch failed" names
 *      two causes and establishes neither, and the first half is what sent the reporter
 *      checking a backend that was fine.
 *
 * This asks the SAME question by a second route before giving up, and records what each
 * attempt actually did so the refusal can say it.
 *
 * WHOLE SCHEMA BOTH TIMES, deliberately. The per-class `/object_info/<Type>` route that
 * `add_node` uses is NOT interchangeable here: `set_widget` authorizes two types for a
 * promoted write and fetches BEFORE resolving which target it writes to, so a
 * single-class payload answers one question and reads the other as absent (#716/#821).
 * The fallback changes the TRANSPORT, never the question. Both routes THIS module offers
 * are still whole-schema, and nothing below has been relaxed.
 *
 * #1560 RE-EXAMINED THAT PARAGRAPH AND FOUND HALF OF IT LOAD-BEARING AND HALF OF IT AN
 * ARTEFACT OF WHERE THE FETCH SITS. Recorded here because this comment is what a later
 * reader will trust, and it foreclosed the fix for a real P2 for as long as it stood alone.
 *
 * The report: on ~1023 models and hundreds of packs BOTH routes above time out — the client
 * on its 10s share, the raw GET on its 5s share — while ComfyUI is idle, `/system_stats`
 * answers 200 and `/object_info/SmartResolution` answers 200 in ~2.7KB. No whole map ever
 * lands, so #1223's snapshot is never populated, so EVERY `set_widget` refuses for the life
 * of the tab. Reproduced by execution against this module, the real burst cache, the real
 * snapshot and the real `runSetWidget`: zero per-class requests ever issued, the widget never
 * written, the identical refusal 15,015 ms later on the second call.
 *
 * WHAT IS TRUE: a BARE single-class payload cannot serve this fence. "Two types" is real, and
 * a map that answers one of them and reads the other as absent is #821 exactly.
 *
 * WHAT WAS AN ARTEFACT: "fetches BEFORE resolving which target it writes to" describes THIS
 * fetch, and this fetch is the one that does not need to know. MEASURED — driving
 * `resolvePromotedInnerTarget` → `followPromotionToConcrete` → `collectPromotionIntermediates`
 * with NO schema at all on a nested A→B→KSampler write yields the COMPLETE type set
 * (SubgraphA, SubgraphB, KSampler) from the graph, with nothing fetched. So a type-scoped
 * read issued BELOW the resolution can name every type the fence will ask about.
 *
 * `scoped-object-info.js` is that read, and it is NOT this module's third transport: it is a
 * LAST RESORT the fence itself reaches for, only after this oracle has returned nothing AND
 * the #1223 snapshot has refused, and only when no route here ANSWERED — a client expressing
 * deny-all as `{}` is still never overruled. The map it returns THROWS for any type it was
 * not asked to cover, so "reads the other as absent" is impossible by construction rather
 * than by this paragraph being obeyed.
 *
 * WHAT REMAINS A TRADE, stated rather than glossed. That map is genuinely PARTIAL: it can
 * authorize a node type and it cannot answer anything that ranges over the install
 * (`registeredSocketTypes` is #821's own example), which is why it never reaches the #1223
 * snapshot, never reaches the ever-seen history, and does not license the #1126 blind write.
 * `panel_refresh_nodes` is unhelped for the same reason and still refuses on such a backend.
 * The honest fix for all of that is still a whole `/object_info` that lands.
 *
 * FAIL-CLOSED IS UNCHANGED. Only a usable, non-empty payload authorizes anything; every
 * failure path returns `defs: null`, which the fence already refuses on.
 *
 * DOES THE SECOND ROUTE AUTHORIZE MORE THAN THE FIRST? (codex). If `api.getNodeDefs()`
 * filtered or narrowed the schema, falling back to the raw route would quietly widen what
 * a write may be authorized against. MEASURED on ComfyUI 0.31.1 / frontend 1.48.7, both
 * routes fetched back to back on a 4183-type install:
 *
 *   api.getNodeDefs()      4183 types
 *   GET /object_info       4183 types
 *   types in only one      none, either direction
 *   per-type field sets    identical for the sampled types
 *
 * So on the build this was written against the two answer the same question. That is
 * evidence, not a contract: a frontend that starts filtering would make the fallback
 * broader than the client route, and this comment is where that would need re-checking.
 * The fallback is only ever consulted when the client route returned NOTHING usable, so
 * it can never override a narrower answer the client actually gave.
 *
 * #1161 WIDENS THAT LAST SENTENCE, and it is recorded here rather than waved past. The
 * deadline below treats a client route that does not answer IN TIME as one that answered
 * nothing — so a client which would have replied with a deliberately narrow schema, and is
 * merely SLOW rather than broken, now has the raw route consulted over it. Reproduced in
 * review: a `getNodeDefs` resolving the deny-all `{}` just after the budget expires is
 * abandoned, and the fallback's full schema is used.
 *
 * The alternative is to refuse whenever the client route does not answer, which is exactly
 * the P1 this exists to remove — three attempts on #1178 established that a bound which can
 * only choose HOW TO FAIL leaves the reported hang in place under a different name. So the
 * trade is deliberate: an install whose client route filters AND is slower than the budget
 * can have a write authorized against a type it meant to withhold.
 *
 * The exposure is bounded by the same direction the original note relies on. An INSTALL is
 * harmless (a type missing from the answer is refused, which fails closed); only a
 * deliberate NARROWING can be overridden, and only for a write to a type it withheld.
 *
 * HOW SLOW IS "TOO SLOW" — stated exactly, because the window is WIDER than this note first
 * claimed. It is not the whole deadline. The client route is granted at most
 * CLIENT_ROUTE_SHARE of the budget, which is HALF (10s of the shipped 20s), so a
 * filtering client is overridden once it takes longer than that — twice as readily as
 * "slower than the budget" implied. The floor is what makes the fallback reachable at all,
 * so the two properties are in direct tension and this is the side that was chosen.
 *
 * Anyone revisiting this should know it was a decision and not an oversight, that the
 * number to check is the client route's SHARE rather than the deadline, and that the honest
 * fix is a client route which fails fast rather than one which is merely waited on longer.
 */

import { CACHE_OUTCOME } from "./object-info-cache.js";
// #1161 — the repo's one bounded-step primitive. A second timeout helper is how this
// repo keeps producing near-duplicate bugs, per that file's own header.
import { withTimeout } from "./bounded-step.js";

/** A payload that can actually answer "does the backend define this type?" */
function usableDefs(value) {
  // #1161 — `Object.keys` INVOKES a Proxy's ownKeys trap, which can throw. This module
  // promises that "every failure path returns `defs: null`", and a diagnostic that raises
  // an exception of its own breaks that for callers which (correctly) do not wrap it. A
  // payload whose own shape cannot be inspected is not usable, which is the same answer
  // this returns for every other unusable value.
  try {
    return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
  } catch {
    return false;
  }
}

function authoritativeEmptyDefs(value) {
  // Keep the existing answer classification: a non-array object response is an answer even
  // when its keys cannot be inspected. The oracle already fails closed on that response; the
  // marker only lets callers retire other verified proofs instead of treating it as silence.
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** How much of a thrown value's own words may ride into a refusal message. */
const MAX_DETAIL_CHARS = 200;

/**
 * Flatten and cap any UNTRUSTED text before it can reach a caller-visible message
 * (codex). It comes from a backend, a frontend client, or any installed extension, and
 * it is interpolated into an error a caller reads: control characters are collapsed so a
 * newline cannot forge structure in the reply, and the length is capped so an
 * arbitrarily large message cannot become the response. Applied at BOTH boundaries — the
 * per-attempt description and the note builder — because a caller can hand the latter
 * strings this module never produced.
 */
function sanitizeDetail(value) {
  // `String(value)` can itself THROW — a hostile object with a throwing toString does it
  // — and a diagnostic path must never raise an exception of its own
  // (codex).
  let text = "";
  try {
    text = String(value ?? "");
  } catch {
    return "(an unprintable value)";
  }
  const flattened = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flattened.length > MAX_DETAIL_CHARS
    ? `${flattened.slice(0, MAX_DETAIL_CHARS)}… (truncated)`
    : flattened;
}

function describeFailure(label, err, extra = "") {
  // #1161 — `String(err)` HERE was outside every guard, so a rejection value with a
  // throwing toString escaped as a rejection from a module that documents the opposite two
  // screens up. `sanitizeDetail` already handles exactly this; the bug was stringifying
  // before reaching it. Reading `.message` off an Error is safe (own data property), but a
  // getter-backed subclass is not, so that read is guarded too.
  let raw = "";
  try {
    raw = err instanceof Error ? err.message : err == null ? "" : err;
  } catch {
    raw = "(an unprintable value)";
  }
  const detail = sanitizeDetail(raw);
  const suffix = detail ? `: ${detail}` : "";
  return `${label}${extra}${suffix}`;
}

/**
 * #1161 — the TOTAL time this oracle may spend before it answers with what it has.
 *
 * The P1: after a ComfyUI restart the tab can hold a half-open connection, so
 * `api.getNodeDefs()` never settles — it does not throw, it simply never answers. Every
 * await here was unbounded, so the oracle parked on the first transport and the second
 * route, added by #982 for exactly this failure, was never asked. Every command that
 * consults it hung until its caller timed out.
 *
 * A DEADLINE, NOT A PER-STEP BOUND. There are three I/O steps (client route, response,
 * body), and giving each its own budget multiplies: three 6s bounds is an 18s worst case
 * that nobody chose, stacked on top of the 8s startup seed wait. A single deadline makes
 * the worst case one number, and lets a fast first step hand its unused time to a slow
 * second one — which is what actually happens when the client route fails instantly and
 * the fallback has a 5MB payload to move.
 *
 * WHAT THE MEASUREMENT ACTUALLY IS, because a wrong one was written here and then reasoned
 * from twice. This repo has measured the thing being bounded — ONE GET of the whole
 * document — on a 63-pack install: **5,413,770 bytes / 167 ms** (#767). The same pair of
 * numbers is cited independently in `object-info-cache.js`, `single-node-def.js` and the
 * panel's own add_node path. Measured again live while fixing this issue, on a 4304-type
 * install: `api.getNodeDefs()` 366ms, the raw GET plus its JSON parse ~450ms.
 *
 * ~14.5s (#610) IS A DIFFERENT OPERATION and must not be used to size this. That issue
 * measured "the forced /object_info + combo refresh" — the download PLUS
 * registerNodesFromDefs plus rebuilding every combo widget in the graph. This oracle does
 * none of that; it fetches a document and reads it. An earlier revision of this comment
 * cited 14.5s as the download time, and later reviews then cited THIS COMMENT back as the
 * repo's measurement — a loop that turned an unmeasured number into a fact. Anyone
 * re-sizing this bound should re-measure rather than trust either figure secondhand.
 *
 * SO 20s IS GENEROUS, NOT TIGHT, and it stays that way once split three ways: 10s for the
 * client route, then 5s for the fallback's response and 5s for its body. The SMALLEST of
 * those is 5s — about 30x the measured download and 10x the slowest figure actually
 * observed. (An earlier revision of this sentence still said 10s after the body was given
 * its own share, which is the same stale-number trap the ~14.5s figure came from; the
 * arithmetic is spelled out here so a later change to the shares has to update it.)
 *
 * WHY A SIBLING FILE LEGITIMATELY USES 14.5s. `get-errors-budget.js` sizes
 * GET_ERRORS_REFRESH_CAP_MS at 15000 citing that same #610 figure, and it is CORRECT to:
 * it bounds the forced refresh — the download plus registerNodesFromDefs plus rebuilding
 * every combo in the graph. This module bounds only the fetch. Two files, two operations,
 * two right answers; noticing that they disagree is what produced the wrong number here.
 *
 * It remains inside the bridge's 30s command timeout, so the caller sees this oracle's own
 * answer rather than a bare timeout.
 */
export const OBJECT_INFO_DEADLINE_MS = 20000;

/** Distinguishes "this transport did not answer in time" from any value it could return. */
const NO_ANSWER = Symbol("object-info-transport-timeout");
/** Distinguishes "the budget was gone before this route was contacted" from a timeout. */
const NOT_TRIED = Symbol("object-info-transport-not-tried");

/**
 * The two non-value outcomes, EXPORTED so the demux below can be tested against them
 * directly. Both are Symbols, and a Symbol reaching the `in` test is a TypeError out of a
 * module documented to always resolve — so this is the one place a missed branch throws
 * rather than misbehaving quietly, and it must be coverable without depending on some
 * public-API path happening to reach it.
 */
export const TRANSPORT_SENTINELS = Object.freeze([NO_ANSWER, NOT_TRIED]);

/**
 * Name which of the four things a transport outcome IS, in ONE place.
 *
 * The sentinels are Symbols, so `"err" in outcome` is a TypeError rather than a false —
 * the branch order is load-bearing, not stylistic. Hand-writing that order at each of the
 * three call sites shipped exactly that bug once already during this issue: a patch
 * replaced the NO_ANSWER branch instead of adding beside it, and every fallback timeout
 * began throwing out of a module which documents that it always resolves.
 *
 * Callers switch on the returned tag, so each keeps its own control flow — two of the
 * three return early from the whole function on a usable payload — while the one
 * dangerous test lives here.
 */
export function outcomeKind(outcome) {
  if (outcome === NOT_TRIED) return "not-tried";
  if (outcome === NO_ANSWER) return "no-answer";
  return "err" in outcome ? "threw" : "value";
}

/**
 * Run one I/O step against the SHARED deadline, preserving the difference between the
 * three outcomes the failure list already distinguishes: it answered, it threw, or it
 * never answered in time.
 *
 * `withTimeout` NEVER rejects by contract, so a naive wrap would collapse "threw" into
 * "timed out" and the refusal would name the wrong cause. The outcome is therefore
 * reified before bounding and unwrapped after.
 */
async function runTransport(attempt, remainingMs, timers) {
  // Out of budget before we even start. Reported as its OWN outcome, never as a timeout:
  // saying a route "did not answer" when it was never contacted is the #982 defect of
  // asserting a cause that was never established.
  if (!(remainingMs > 0)) return NOT_TRIED;
  const settled = await withTimeout(
    Promise.resolve()
      .then(attempt)
      .then((value) => ({ value }), (err) => ({ err })),
    remainingMs,
    () => NO_ANSWER,
    timers,
  );
  return settled;
}

/**
 * #1223 — the MACHINE-READABLE half of `failures`, and the reason it exists.
 *
 * `failures` is prose, written to be read by a person in a refusal. A caller that needs to
 * DECIDE something from what the transports did cannot parse those sentences (they are
 * rewritten whenever the wording improves — twice already in #982 and #1161), so each
 * attempt is also recorded as a tag here.
 *
 * The distinction the tags exist to carry: SILENCE is not the same evidence as an ANSWER.
 * A route that times out establishes only that nothing came back in time; a route that
 * THREW, returned a non-OK status, or handed back an unusable body establishes that
 * something on the other end responded. `object-info-snapshot.js` licenses its fallback on
 * exactly that difference, so the tags must stay a faithful record of the outcome rather
 * than a summary of it. One tag per attempted route, in order, mirroring `failures`.
 */
export const TRANSPORT_OUTCOME = Object.freeze({
  /** Ran out its whole grant without settling. Nothing was established. */
  NO_ANSWER: "no-answer",
  /** Never contacted — the budget was gone, or no transport was wired. */
  NOT_ATTEMPTED: "not-attempted",
  /**
   * It settled with nothing — resolved null/undefined/a non-object.
   *
   * SEPARATE FROM ANSWERED_UNUSABLE, and the distinction is this file's own, stated five
   * screens down: "Only a client that returned NOTHING (null/undefined/non-object) or threw
   * LEAVES THE QUESTION UNANSWERED". Tagging it as an answer contradicted that and made the
   * #1223 fallback dead on any frontend whose `getNodeDefs` swallows its own failure and
   * resolves `undefined` — it fails closed, so it was not dangerous, merely inert.
   *
   * Note this is NOT the empty-`{}` case, which IS an answer (a client expressing deny-all)
   * and keeps ANSWERED_UNUSABLE.
   */
  NOTHING_RETURNED: "nothing-returned",
  /** It threw. Something answered, or the connection was actively refused. */
  THREW: "threw",
  /** It answered, and the answer could not authorize anything (non-OK, empty, unusable). */
  ANSWERED_UNUSABLE: "answered-unusable",
});

/**
 * Statuses that are the PROXY speaking, not ComfyUI.
 *
 * #1223 — ComfyUI behind nginx/Caddy is the standard remote and RunPod shape, and a proxy
 * answers a hung upstream with a synthetic gateway error after its own read timeout. That
 * is the SAME event as a bare timeout — the backend never answered — but it arrives as an
 * HTTP response, so tagging it ANSWERED_UNUSABLE both disabled the fallback for every
 * proxied install and blamed the backend for a message it never sent (#982's exact defect).
 *
 * 504 ONLY, and the exclusions are the whole point:
 *
 *   - 502 Bad Gateway is what nginx and Caddy emit IMMEDIATELY when they cannot CONNECT to
 *     the upstream — a stopped or restarting ComfyUI. That is evidence the process is GONE,
 *     which is the opposite of the evidence this is looking for. Including it was a real
 *     defect caught in review: on a frontend whose `getNodeDefs()` swallows its network
 *     error and returns nothing, a 502 arriving BEFORE the websocket-down event produced an
 *     all-silent outcome list, and the pre-restart schema would then authorize — and report
 *     as successful — a write to a type the restart had removed.
 *   - 503 can be served by ComfyUI itself, so it is not unambiguously the proxy.
 *
 * 504 Gateway Timeout is the one that means what this needs: the proxy CONNECTED and the
 * upstream did not answer within its read timeout. Connected-but-quiet is a running
 * process, which is the same event as a bare client-side timeout.
 */
const GATEWAY_STATUSES = Object.freeze([504]);

/**
 * #1739 — a request this oracle has STOPPED LISTENING TO must stop OCCUPYING the backend.
 *
 * `bounded-step.js` says in its own header that it "does not CANCEL the work it bounds",
 * and for every other caller that is the right contract — the caller is composing a reply,
 * not managing a pipeline's lifetime. This route is the one place where it is not, and the
 * reason is in ComfyUI's own `server.py`:
 *
 *     @routes.get("/object_info")
 *     async def get_object_info(request):
 *         asset_seeder.start(...)
 *         with folder_paths.cache_helper:
 *             out = {}
 *             for x in nodes.NODE_CLASS_MAPPINGS:   # 8534 types on the report
 *                 out[x] = node_info(x)
 *             return web.json_response(out)         # json.dumps of ~52 MB
 *
 * There is NO `await` anywhere in that body. It is a coroutine that blocks aiohttp's single
 * event loop for as long as it runs — measured at 16.08 s on the reporting install — and
 * while it runs the backend cannot answer ANY other request, including the per-class
 * `/object_info/{node_class}` route defined twelve lines below it.
 *
 * That is what made #1560's type-scoped last resort — the one route that CAN answer a
 * backend this size — report a timeout on a URL the reporter measured at 1.2 ms by hand.
 * It was not slow. It was queued behind two whole-map computations THIS MODULE had left
 * running on a single-threaded server after abandoning both of them.
 *
 * The second one is pure cost and is provably unreachable on such a backend: it is only
 * issued after the client route has already spent its whole share, so on a backend that
 * serializes it starts behind a computation of the IDENTICAL document that is still
 * running, and its own share is smaller than the one that just expired. It cannot answer;
 * it can only add another full computation to the loop, and the type-scoped read issued
 * moments later is what pays for it.
 *
 * WHY THE CLIENT ROUTE IS NOT ALSO CANCELLED: `api.getNodeDefs()` is the frontend's own
 * method and takes no signal. Nothing here can reach the request it made. That route is
 * FIRST, so it is not the one blocking the fallback — it is the work the fallback is
 * queued behind — and cancelling the fallback is what frees the loop for the next question.
 *
 * ABORTING IS BEST-EFFORT AND NEVER LOAD-BEARING. A runtime with no `AbortController`
 * (`live-combo-availability.js` guards for the same one) simply passes no init and behaves
 * exactly as before, and every failure of the cancel itself is swallowed: a module that
 * documents "every failure path returns `defs: null`" must not start throwing out of its
 * own cleanup.
 */
function createRouteCancellation() {
  let controller = null;
  try {
    if (typeof AbortController === "function") controller = new AbortController();
  } catch {
    controller = null;
  }
  let init;
  try {
    init = controller ? { signal: controller.signal } : undefined;
  } catch {
    init = undefined;
  }
  return {
    // `undefined` rather than `{}` so a `fetchApi` that never took a second argument — every
    // test double in this repo, and the panel's own wiring before this change — is called
    // exactly as it was.
    init,
    cancel() {
      try {
        controller?.abort();
      } catch {
        // A cancellation that throws must never replace the answer this route produced.
      }
    },
  };
}

/**
 * Fetch the whole `/object_info` schema, trying the frontend client first and the raw
 * HTTP route second.
 *
 * Returns `{ defs, failures, outcomes }` — `defs` is null unless one route returned a
 * usable payload, `failures` names every route that did not, in order, and `outcomes`
 * carries the same list as TRANSPORT_OUTCOME tags (#1223). An empty authoritative response
 * also carries `authoritativeEmpty: true`, so callers can distinguish deny-all from a timeout
 * while preserving the fail-closed `defs: null` shape.
 */
export async function fetchWholeObjectInfo({
  getNodeDefs,
  fetchApi,
  // Injected so a test can drive the deadline without waiting on a real clock.
  deadlineMs = OBJECT_INFO_DEADLINE_MS,
  timers,
  // MONOTONIC BY DEFAULT, and that is the whole reason a clock is admissible here again.
  now,
} = {}) {
  // WHY THIS READS `performance.now()` AND NOT `Date.now()`.
  //
  // Three earlier designs were broken by a clock, and every scenario that broke them —
  // an NTP step correction, a DST or manual change, a VM suspend/resume, a frozen reading
  // — is a WALL-CLOCK hazard. `Date.now()` was the default, so all of them landed:
  // measured at 49,998ms and 46,091ms against a 20,000ms deadline.
  //
  // `performance.now()` is monotonic by specification. It does not step backwards and is
  // not repointed by the system clock, which is why this repo already measures its other
  // elapsed-time windows on it — see `monotonicNow()` in the panel, `session-rebind.js`
  // and `reconnect-staleness.js`, all of which say so in as many words.
  //
  // The reaction to those three rounds was to stop measuring entirely and charge every
  // step its full grant. That bounded the total, but it stranded the unused time and
  // REFUSED payloads both the parent and main delivered. The defect was never measurement;
  // it was measuring with the one clock in the platform that is allowed to lie.
  //
  // A reading that is still somehow unusable (negative, non-finite — reachable only on the
  // `Date.now` fallback where `performance` is absent) charges the FULL grant, so the
  // budget can only ever be over-spent in the conservative direction.
  const clockSource =
    typeof now === "function"
      ? now
      : typeof performance !== "undefined" && typeof performance.now === "function"
        ? () => performance.now()
        : () => Date.now();
  // READING THE CLOCK MUST NOT BE ABLE TO THROW OUT OF THIS MODULE. `now` is an injected
  // option, and this module's header promises every failure path returns `defs: null` to
  // two callers that await it with no catch. An unreadable clock yields NaN, which the
  // accounting below already treats as "unmeasurable" and charges in full.
  const readClock = () => {
    // COERCE, don't just typecheck. Guarding the CALL is not enough — the ARITHMETIC below
    // is its own operation, and `readClock() - startedStep` throws for a Symbol ("Cannot
    // convert a Symbol value to a number") and for a null-prototype object. That was the
    // third time in this issue a guarded READ was undone by an unguarded USE of the same
    // value, after `${responseStatus}` and `String(err)`.
    //
    // But the first fix for it demanded `typeof === "number"`, which REJECTED every clock
    // the subtraction would have accepted — a `now` returning a Date, or a numeric string,
    // reads as unmeasurable, charges the full grant, and so silently disables the reclaim:
    // measured grants fell back to 10000/5000/5000, which is the round-8 regression shape
    // reintroduced by a fix for something else. Coercing exactly as the subtraction would,
    // inside the guard, accepts what worked before and rejects only what actually throws.
    try {
      const value = Number(clockSource());
      return Number.isFinite(value) ? value : NaN;
    } catch {
      return NaN;
    }
  };
  // ONE budget for the whole question, DIVIDED IN ADVANCE, with each step CAPPED at a share
  // of what is left and charged only for what it actually used. Five designs were tried to
  // get here; each is recorded because each looked correct and had a green suite.
  //
  //   1. Measure with `Date.now()`, clamping each negative READING to zero. It refunded
  //      everything already spent, so one call ran ~50s against a 20s deadline — past the
  //      bridge's 30s command timeout, so the agent got a bare timeout naming no routes.
  //      That IS the #1161 symptom, produced by the fix for it.
  //   2. A high-water RATCHET over the same clock. It samples only at step boundaries, so a
  //      jump between two samples still refunds — and the test written for it passed with
  //      AND without the ratchet, which is how it was caught.
  //   3. Charge the grant on timeout, measured elapsed otherwise, still on `Date.now()`. A
  //      frozen clock then ran a call 49,998ms against 20,000ms, and the "unmeasurable" arm
  //      charged a whole remaining grant for one bad reading, starving the step after it.
  //   4. STOP MEASURING — charge every step its full grant. That bounded the total but
  //      stranded the time a fast step never used, and it REFUSED payloads both the parent
  //      and `main` delivered: a client route answering in 200ms was still charged 10s, so
  //      a 5.4MB body served at 7.5s elsewhere was refused here at 5.5s.
  //
  // The first three failed to a clock and the fourth failed by avoiding one, which is the
  // actual lesson: every scenario that broke 1–3 is a WALL-CLOCK hazard, and the default
  // was `Date.now()`. The available conclusion was never "do not measure" — it was "do not
  // measure with the one clock in the platform that is allowed to lie." `performance.now()`
  // is monotonic by specification, and this repo already measures its other elapsed windows
  // on it (`monotonicNow()` in the panel, `session-rebind.js`, `reconnect-staleness.js`).
  //
  // SO: a step that TIMES OUT is charged its full grant with nothing measured — the timer
  // is real-time truth. A step that ANSWERS is charged what the monotonic clock says it
  // used, clamped to its grant, so the remainder goes back to the steps after it. The CAP
  // is what stops a hung route starving the fallback; the RECLAIM is what stops a fast one
  // spending time it never used. Both halves are load-bearing, and each was broken on its
  // own in the rounds above.
  //
  // WHERE THIS STILL DEPENDS ON THE CLOCK, stated rather than glossed: the reclaim believes
  // a clock that ADVANCES. One that under-reports without going backwards (a stub, or the
  // `Date.now` fallback on a platform with no `performance`) charges an answering step too
  // little, and real elapsed can then exceed the budget. `performance.now()` cannot do this,
  // which is exactly why it is the default and why `now` is a test seam rather than a
  // configuration knob.
  //
  // A NON-FINITE BUDGET IS NORMALISED ONCE, HERE. `deadlineMs: Infinity` used to make
  // `consumed` infinite, `budget - consumed` NaN, and every later grant NaN — and since
  // `Math.max(0, NaN)` is NaN rather than 0, the fallback was skipped entirely (call count
  // 0) on an input the unbounded original handled. Normalising at the boundary keeps every
  // later number finite by construction.
  // A NON-NUMBER FALLS BACK TO THE DEFAULT; AN EXPLICIT ZERO IS OBEYED. Normalising a
  // non-finite budget to 0 was the first attempt and it is wrong in its own way: it makes a
  // caller who passes garbage get an oracle that attempts NOTHING, which is a worse answer
  // than the unbounded original gave. NaN and Infinity are not budgets a caller can have
  // meant, so they take the shipped default. A non-positive NUMBER is a real choice and is
  // obeyed — every step is then unattempted, and says so.
  // …and a budget a TIMER CANNOT EXPRESS is treated exactly like one that is not a number.
  //
  // `setTimeout` coerces a delay above 2^31-1 to 1ms, so an over-range budget hands every
  // step a grant whose timer fires immediately — the bound silently becoming no bound.
  // CLAMPING to 2^31-1 was tried first and is worse: it turns the nonsense input into a
  // ~24.8-DAY grant, so a hung client route parks instead of failing fast. Measured on real
  // timers at deadlineMs 5e9 — the unclamped version answered in 3ms with the fallback
  // issued, the clamped one never returned at all, fetchApi call count 0. That is the
  // canonical #1161 signature, reintroduced by a guard written to prevent it.
  //
  // Neither behaviour is what a caller meant by a nine-digit millisecond count, so it takes
  // the shipped default like any other unusable value.
  const MAX_EXPRESSIBLE_MS = 2 ** 31 - 1;
  const budget =
    Number.isFinite(deadlineMs) && deadlineMs <= MAX_EXPRESSIBLE_MS
      ? Math.max(0, deadlineMs)
      : OBJECT_INFO_DEADLINE_MS;
  let consumed = 0;
  /**
   * Run one step CAPPED at `share` of what is LEFT, charging it for what it used — its
   * whole grant if it timed out, the measured elapsed if it answered early.
   *
   * The fractional share is what reserves room for the steps after it. The client route
   * takes half, so the fallback always has half; the fallback's RESPONSE takes half of what
   * remains, so its BODY always has the rest. Reserving for the fallback but not for the
   * body was the same starvation defect one level down — a response that used everything
   * left the body unreadable, and a body that cannot be read authorizes nothing.
   */
  const runStep = async (attempt, share) => {
    const left = budget - consumed;
    // AT LEAST A MILLISECOND WHILE ANY BUDGET REMAINS. Plain `Math.floor(left * share)`
    // truncates to 0 on a tiny budget, and a zero grant is not a small wait — it is the
    // step never being attempted: at deadlineMs=2 the fallback was never issued (fetchApi
    // call count 0), the exact signature this change exists to remove, reproduced by the
    // arithmetic meant to prevent it.
    //
    // Two earlier revisions of this comment got the tiny-budget case wrong in opposite
    // directions — first claiming the floor made every budget reachable, then claiming it
    // could not rescue deadlineMs=1. Measured: at deadlineMs of 1 and 2 the fallback IS
    // issued and DOES answer, because a client route that returns instantly hands its grant
    // back and the next step draws from what is left. Neither claim was checked before it
    // was written, which is how a comment becomes the thing a later reader trusts.
    // `share` is never above 1 for any step here, so `floor(left * share) <= left` already;
    // the min() is a guard for a future share, not something that binds today.
    const grant = left > 0 ? Math.max(1, Math.min(left, Math.floor(left * share))) : 0;
    const startedStep = readClock();
    // `timers: null` is not `timers: undefined`, and only the latter reaches `withTimeout`'s
    // own default — an explicit null read `.setTimer` off null and REJECTED out of a module
    // that documents it always resolves, which two callers await with no catch of their own.
    const outcome = await runTransport(attempt, grant, timers ?? undefined);
    if (outcome === NO_ANSWER) {
      // It ran out its whole grant — certain without measuring anything.
      //
      // A LATE TIMER IS DELIBERATELY NOT CHARGED, and this was tried the other way first.
      // Chrome clamps hidden-tab timers to ~1/min after five minutes backgrounded, and a
      // laptop resume does the same, so real elapsed can exceed the budget however this
      // accounts for it — that is the environment, not the arithmetic. Charging the true
      // overrun makes the accounting honest and the OUTCOME worse: a tab backgrounded for
      // ten minutes reaches the fallback with a zero budget, so the write is refused
      // outright instead of being retried by the route that still works. The command has
      // already blown its 30s budget in that world; the useful thing left is to ASK, and
      // the fallback usually answers in ~450ms. Preserving a number the environment has
      // already broken, at the cost of the one route that can still answer, is exactly the
      // trade that produced the earlier "refuses what main serves" regressions.
      consumed += grant;
    } else {
      // IT ANSWERED EARLY, so the time it did not use goes back. Charging the full grant
      // here was a real shipped regression, reproduced against both the parent and main: a
      // client route that answers `null` in 200ms was still charged 10s, leaving the
      // fallback 5s + 5s instead of ~19.8s, so a 5.4MB payload over a tunnel that BOTH
      // other trees delivered at 7.5s was refused at 5.5s with most of the budget never
      // granted to anything. The fallback is the entire reason this oracle exists; starving
      // it to satisfy a bound is the wrong trade.
      const spent = readClock() - startedStep;
      consumed += Number.isFinite(spent) && spent >= 0 ? Math.min(spent, grant) : grant;
    }
    return { outcome, grant };
  };
  // On the shipped 20s budget: 10s for the client route, 5s for the response, 5s for the
  // body. Every one of those is more than an order of magnitude above what this actually
  // measures at.
  const CLIENT_ROUTE_SHARE = 0.5;
  const FALLBACK_RESPONSE_SHARE = 0.5;
  const BODY_SHARE = 1;
  const failures = [];
  // #1223 — kept in lockstep with `failures` by pushing through ONE helper. Two arrays
  // appended at eleven call sites drift the first time a branch is added to one of them,
  // and a tag list that silently omits an attempt would license the snapshot fallback on
  // evidence that route never gave.
  const outcomes = [];
  // The route is passed, never DERIVED FROM THE SENTENCE. Sniffing the prose for a prefix
  // is the very coupling the tags exist to remove — it would re-break the moment a message
  // is reworded, which is a thing this file's history shows happening.
  const record = (route, kind, sentence) => {
    failures.push(sentence);
    outcomes.push({ route, kind });
  };

  if (typeof getNodeDefs === "function") {
    const { outcome, grant: clientMs } = await runStep(getNodeDefs, CLIENT_ROUTE_SHARE);
    const kind = outcomeKind(outcome);
    if (kind === "not-tried") {
      // TRUE OF THE FIRST STEP, WHICH HAS SPENT NOTHING. "the budget was already spent" is
      // a false cause here: on a degenerate budget nothing had been drawn when this ran.
      // Naming a cause that did not happen is #982's original defect, and it is no more
      // acceptable in a branch that is hard to reach than in one that is not.
      record(
        "client",
        TRANSPORT_OUTCOME.NOT_ATTEMPTED,
        `api.getNodeDefs() was not attempted — the ${budget}ms budget leaves it no time`,
      );
    } else if (kind === "no-answer") {
      // The #1161 case. Recorded as a failure like any other, and — critically — execution
      // CONTINUES to the second transport, which is what this bound exists to reach.
      // THE STEP'S OWN BUDGET, not the whole deadline. Browser-verified against a live
      // 4304-type install: the client route is capped at half, so quoting `deadlineMs`
      // here told the reader it had waited 20000ms when it had waited 10000ms. Naming a
      // number that was never spent is the same defect as #982's "unreachable or the
      // fetch failed" — a refusal asserting something it did not establish.
      record(
        "client",
        TRANSPORT_OUTCOME.NO_ANSWER,
        `api.getNodeDefs() did not answer within its ${Math.round(clientMs)}ms share of the ${budget}ms budget`,
      );
    } else if (kind === "threw") {
      record("client", TRANSPORT_OUTCOME.THREW, describeFailure("api.getNodeDefs() threw", outcome.err));
    } else {
      const defs = outcome.value;
      if (usableDefs(defs)) return { [CACHE_OUTCOME]: true, defs, failures, outcomes };
      // AN EMPTY MAP IS AN ANSWER, NOT AN ABSENCE (codex). A client that deliberately
      // filters could express deny-all as `{}`, and consulting the raw route would then
      // overrule it with a broader schema — the one direction this fallback must never
      // move. Only a client that returned NOTHING (null/undefined/non-object) or threw
      // leaves the question unanswered, and only that may be asked again elsewhere.
      if (authoritativeEmptyDefs(defs)) {
        record(
          "client",
          TRANSPORT_OUTCOME.ANSWERED_UNUSABLE,
          "api.getNodeDefs() returned an EMPTY schema — treated as its answer, not as an absence",
        );
        return { [CACHE_OUTCOME]: true, defs: null, authoritativeEmpty: true, failures, outcomes };
      }
      record(
        "client",
        // NOTHING_RETURNED, not ANSWERED_UNUSABLE — this branch IS the "returned NOTHING"
        // case the note above reserves, so it leaves the question unanswered (#1223).
        TRANSPORT_OUTCOME.NOTHING_RETURNED,
        describeFailure(
          "api.getNodeDefs() returned no usable schema",
          null,
          ` (${defs === null ? "null" : Array.isArray(defs) ? "an array" : typeof defs})`,
        ),
      );
    }
  } else {
    // NOT_ATTEMPTED, not ANSWERED_UNUSABLE: a transport this frontend does not have is a
    // route that was never asked. Tagging an absent client as though it had answered would
    // make "no transport is wired" read as evidence the backend responded (#1223).
    record("client", TRANSPORT_OUTCOME.NOT_ATTEMPTED, "api.getNodeDefs is not a function on this frontend");
  }

  // SECOND TRANSPORT, same question. The reporter proved this route answers when the
  // client call does not — it is the one they ran by hand to show the backend was fine.
  if (typeof fetchApi === "function") {
    // #1739 — see `createRouteCancellation`. The init is threaded through `fetchApi` so a
    // caller that forwards it (the panel does, to `api.fetchApi(route, init)`) can have this
    // request dropped the moment the oracle stops waiting on it.
    const httpRoute = createRouteCancellation();
    const { outcome, grant: fallbackMs } = await runStep(
      () => fetchApi("/object_info", httpRoute.init),
      FALLBACK_RESPONSE_SHARE,
    );
    const kind = outcomeKind(outcome);
    if (kind === "not-tried") {
      // TRUTHFUL ABOUT WHAT WAS NOT DONE. Saying this route "did not answer" when no
      // request was ever sent is #982's original defect — a refusal asserting a cause it
      // never established. The reserve above exists so this stays unreachable in practice.
      record(
        "http",
        TRANSPORT_OUTCOME.NOT_ATTEMPTED,
        "GET /object_info was not attempted — the budget was spent before it was reached",
      );
    } else if (kind === "no-answer") {
      record(
        "http",
        TRANSPORT_OUTCOME.NO_ANSWER,
        `GET /object_info did not answer within its ${Math.round(fallbackMs)}ms share of the ${budget}ms budget`,
      );
    } else if (kind === "threw") {
      record("http", TRANSPORT_OUTCOME.THREW, describeFailure("GET /object_info threw", outcome.err));
    } else {
      const res = outcome.value;
      // #1161 — reading `ok`/`status` off the response is itself an operation that can
      // throw: an extension may monkey-patch fetchApi and hand back a lazily-evaluated or
      // proxied object. These reads used to sit inside this route's try/catch, and
      // replacing that with a bound left them exposed — verified against main, where the
      // same input produced a failures entry and here produced a rejection.
      let responseOk = false;
      let responseStatus = "unknown";
      // The NUMERIC status, kept apart from the sanitized display string: the gateway test
      // is a decision and must not be made by pattern-matching a string built for a human.
      let statusCode = null;
      try {
        responseOk = !!res && res.ok === true;
        // READ THE STATUS EXACTLY ONCE, and derive BOTH the decision and the display text
        // from that one value (#1223). This code deliberately supports a monkey-patched
        // fetchApi returning a proxied or getter-backed response — the two screens above
        // say so — and such a response can answer differently on each read. Two reads let a
        // first value of 504 classify the route as silence while the second, 502, is what
        // the message reports: the fallback would then be licensed by a status that exists
        // only in the classification, against a reply that names the status meant to
        // disqualify it.
        const raw = res?.status;
        statusCode = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
        // SANITIZE INSIDE THE GUARD. Reading `.status` is not the only operation that can
        // throw — INTERPOLATING it does too (`Object.create(null)` cannot convert to a
        // primitive), and that interpolation sits below this try. Verified against main,
        // which returned a failures entry where this rejected.
        responseStatus = sanitizeDetail(raw ?? "unknown") || "unknown";
      } catch (err) {
        record(
          "http",
          TRANSPORT_OUTCOME.ANSWERED_UNUSABLE,
          describeFailure("GET /object_info returned an unreadable response", err),
        );
        // #1739 — the ONE early return out of this branch that leaves a body unread. The
        // two below it return after `res.json()` has already settled, where the cancel the
        // end of this block performs is a no-op; this one would otherwise leave a 52 MB
        // download running against a backend the caller is about to ask another question of.
        httpRoute.cancel();
        return { [CACHE_OUTCOME]: true, defs: null, failures, outcomes };
      }
      if (!responseOk) {
        const gateway = statusCode !== null && GATEWAY_STATUSES.includes(statusCode);
        record(
          "http",
          // A gateway error is the PROXY reporting that ComfyUI did not answer it — the
          // same event as a bare timeout, arriving over HTTP (#1223).
          gateway ? TRANSPORT_OUTCOME.NO_ANSWER : TRANSPORT_OUTCOME.ANSWERED_UNUSABLE,
          describeFailure(
            gateway
              ? "GET /object_info got a GATEWAY error — a proxy in front of ComfyUI reporting the backend did not answer it"
              : "GET /object_info was not OK",
            null,
            ` (status ${responseStatus})`,
          ),
        );
      } else {
        // The BODY is a second I/O step, and it was inside the try/catch this bound
        // replaced — an existing #982 test caught the escape. Reading a 5MB schema over a
        // half-open connection can also stall, so it is bounded as well rather than merely
        // re-caught: the response arriving is not the same event as the body arriving.
        const { outcome: body, grant: bodyMs } = await runStep(() => res.json(), BODY_SHARE);
        const bodyKind = outcomeKind(body);
        if (bodyKind === "not-tried") {
          // ANSWERED_UNUSABLE, not NOT_ATTEMPTED: the RESPONSE arrived — the backend
          // demonstrably answered — and only the body read was skipped. The tag records
          // what the backend did, not which of our own steps ran (#1223).
          record(
            "http",
            TRANSPORT_OUTCOME.ANSWERED_UNUSABLE,
            "GET /object_info answered but its body was not read — the budget was spent",
          );
        } else if (bodyKind === "no-answer") {
          // Same reasoning: the response headers came back, so something is alive on the
          // other end. A stalled BODY is not the silence the snapshot fallback licenses on.
          record(
            "http",
            TRANSPORT_OUTCOME.ANSWERED_UNUSABLE,
            `GET /object_info answered but its body did not arrive within its ${Math.round(bodyMs)}ms share of the ${budget}ms budget`,
          );
        } else if (bodyKind === "threw") {
          // Deliberately the SAME wording as before. A parse failure used to surface
          // through this route's catch, and an existing #982 test pins the sentence a user
          // reads. This change is about bounding the waits, not about rewording refusals —
          // improving the phrasing here would be a separate, reviewable decision.
          record("http", TRANSPORT_OUTCOME.THREW, describeFailure("GET /object_info threw", body.err));
        } else {
          const defs = body.value;
          if (usableDefs(defs)) return { [CACHE_OUTCOME]: true, defs, failures, outcomes };
          if (authoritativeEmptyDefs(defs)) {
            record(
              "http",
              TRANSPORT_OUTCOME.ANSWERED_UNUSABLE,
              "GET /object_info returned an EMPTY schema — treated as its answer, not as an absence",
            );
            return { [CACHE_OUTCOME]: true, defs: null, authoritativeEmpty: true, failures, outcomes };
          }
          record(
            "http",
            TRANSPORT_OUTCOME.ANSWERED_UNUSABLE,
            "GET /object_info returned no usable schema (an empty or non-object body)",
          );
        }
      }
    }
    // #1739 — ONE unconditional cancel covering every path that reaches here: the response
    // that never came, the body that never came, the body that was never attempted, the
    // non-OK reply whose body is never read, and the parse that failed. Written as a single
    // statement AFTER the chain rather than repeated inside each arm, so a branch added
    // later cannot forget it — the failure this fixes is precisely a request nobody
    // remembered to stop.
    //
    // A no-op on every path where the body WAS consumed, which is why the two early returns
    // above it need nothing: `abort()` after a response is fully read does nothing at all.
    httpRoute.cancel();
  } else {
    record("http", TRANSPORT_OUTCOME.NOT_ATTEMPTED, "no fetchApi is wired for the fallback route");
  }

  return { [CACHE_OUTCOME]: true, defs: null, failures, outcomes };
}

/**
 * The sentence a refusal appends: what was actually tried, and what each attempt did.
 *
 * Empty when nothing was recorded, so a caller that never ran this helper reads exactly
 * as it did before rather than gaining a hollow "no failures" clause.
 */
/** At most this many attempts are named, however long the list a caller hands in. */
const MAX_FAILURES_REPORTED = 4;

export function objectInfoOracleFailureNote(failures) {
  if (!Array.isArray(failures) || !failures.length) return "";
  // BOUNDED AT THE PUBLIC BOUNDARY (codex): each entry is capped, and so is the number
  // of entries — a caller may hand this an arbitrarily long array this module never
  // produced, and the result goes into an error someone reads.
  // SLICE FIRST (codex): sanitizing every entry of an arbitrarily long array is
  // unbounded work even though the string it produces is bounded. The dropped count
  // comes from the ORIGINAL length, so truncation is still reported honestly.
  //
  // NO TEST PINS THIS ORDER, and that is stated rather than papered over. For the inputs
  // this module produces the two orders are output-identical — every attempt it records
  // is non-empty — so mutation testing shows the swap surviving, and a later edit that
  // reverses it will not be caught by the suite.
  //
  // They are NOT identical for arbitrary caller input (codex): a list whose first four
  // entries are blank yields no note this way, and a note naming the fifth the other way.
  // Slicing first is still the right order — it is what bounds the work — and this is the
  // one case where the two differ, recorded so nobody has to rediscover it.
  const shown = failures.slice(0, MAX_FAILURES_REPORTED).map((f) => sanitizeDetail(f)).filter(Boolean);
  if (!shown.length) return "";
  const dropped = failures.length - Math.min(failures.length, MAX_FAILURES_REPORTED);
  const more = dropped > 0 ? ` (and ${dropped} more not shown)` : "";
  const label = failures.length === 1 ? "one route" : `${failures.length} routes`;
  return ` Tried ${label}: ${shown.join("; ")}${more}.`;
}
