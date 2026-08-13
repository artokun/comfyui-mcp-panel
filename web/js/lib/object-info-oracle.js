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
 * The fallback changes the TRANSPORT, never the question.
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
 * `deadline - FALLBACK_FLOOR`, which is HALF the deadline (10s of the shipped 20s), so a
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
 * SO 20s IS GENEROUS, NOT TIGHT, and it stays that way once split: the smallest share any
 * single step gets is 10s, which is ~60x the measured download and ~20x the slowest
 * figure actually observed. It remains inside the bridge's 30s command timeout, so the
 * caller sees this oracle's own answer rather than a bare timeout.
 */
export const OBJECT_INFO_DEADLINE_MS = 20000;

/** Distinguishes "this transport did not answer in time" from any value it could return. */
const NO_ANSWER = Symbol("object-info-transport-timeout");
/** Distinguishes "the budget was gone before this route was contacted" from a timeout. */
const NOT_TRIED = Symbol("object-info-transport-not-tried");

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
function outcomeKind(outcome) {
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
 * Fetch the whole `/object_info` schema, trying the frontend client first and the raw
 * HTTP route second.
 *
 * Returns `{ defs, failures }` — `defs` is null unless one route returned a usable
 * payload, and `failures` names every route that did not, in order. An empty `failures`
 * with a null `defs` cannot happen: a route that answers nothing is itself a failure.
 */
export async function fetchWholeObjectInfo({
  getNodeDefs,
  fetchApi,
  // Injected so a test can drive the deadline without waiting on a real clock.
  deadlineMs = OBJECT_INFO_DEADLINE_MS,
  timers,
  now = () => Date.now(),
} = {}) {
  // ONE budget for the whole question, spent down by each step (#1161).
  // A RATCHET, because clamping each reading was not enough. `Date.now()` is this module's
  // default clock and it can step BACKWARDS — an NTP correction, a manual or DST change, a
  // VM suspend/resume. Clamping a single negative reading to 0 stopped one step from
  // getting an over-large budget, but it also silently REFUNDED everything already spent:
  // measured with a -60s jump at t=10s against a 20000ms deadline, the fallback redrew a
  // full budget and the body redrew another, and the call returned at wall t=49900ms.
  //
  // That is worse than the bug it was meant to prevent. `graph_set_widget` waits on the
  // history seed (8s cap) before this even runs, so a 50s oracle overruns the bridge's 30s
  // per-command timeout and the agent gets a bare timeout naming no routes — precisely the
  // #1161 symptom this oracle exists to replace with an answer of its own.
  //
  // Elapsed time therefore only ever moves FORWARD here. A backwards jump stops the clock
  // rather than rewinding it, so the total is bounded by the deadline no matter what the
  // wall clock does.
  // ACCOUNT BY WHAT WAS GRANTED, NOT BY WHAT THE CLOCK SAYS. A high-water ratchet was tried
  // first and is not enough: it only samples at step boundaries, so a jump BETWEEN two
  // samples still refunds everything spent, and a test for it passes either way.
  //
  // The safety property cannot depend on `now()` at all. Each step is handed a grant, and a
  // step cannot outlast its grant because the TIMER enforces that in real time — whatever
  // `now()` believes. So if the grants sum to at most the deadline, the call takes at most
  // the deadline, and no clock behaviour can change it.
  //
  // The clock is then used only to hand BACK time a fast step did not use, which is an
  // optimisation. A reading that is negative or non-finite gives back nothing, so a broken
  // clock costs efficiency and never correctness.
  let consumed = 0;
  const runStep = async (attempt, want) => {
    const grant = Math.max(0, Math.min(want, deadlineMs - consumed));
    const startedStep = now();
    const outcome = await runTransport(attempt, grant, timers);
    if (outcome === NO_ANSWER) {
      // A TIMEOUT IS ITSELF A REAL-TIME MEASUREMENT, and the only one here that cannot lie.
      // The timer fired, so the full grant elapsed in wall time no matter what `now()`
      // believes — and `now()` can believe anything, including that no time passed at all.
      // A clock stalled at a constant (a coarse timer resolution, a frozen VM clock, a test
      // stub) reported 0ms for a step that really hung, so nothing was charged and each
      // later step drew a fresh full grant: three hung steps ran 9000ms against a 6000ms
      // deadline. Charging the grant on timeout closes that without trusting the clock.
      consumed += grant;
    } else {
      const elapsed = now() - startedStep;
      // For a step that ANSWERED, the clock is the only estimate available. Zero is
      // measurable — a step answering inside the same millisecond really used no time, and
      // charging it the full grant made a fast client route plus a fast fallback exhaust
      // the budget between them and leave the body unread. Anything unmeasurable
      // (backwards, NaN) is charged in full, the conservative direction.
      consumed += Number.isFinite(elapsed) && elapsed >= 0 ? Math.min(elapsed, grant) : grant;
    }
    return { outcome, grant };
  };
  // RESERVE A FLOOR FOR THE ROUTE THAT HAS NOT BEEN TRIED YET.
  //
  // The first version of this shared budget did not, and it broke the very thing the whole
  // change exists to do: the client route's bound can only fire AT the deadline, so by the
  // time the fallback was reached `remaining()` was already <= 0 and the raw GET was never
  // issued at all — verified by execution, fetchApi call count 0. A hung client route
  // turned a 30s hang into a 20s refusal, with the #982 fallback still unreachable, and
  // the refusal then named a route that was never contacted.
  //
  // So each step may spend at most what is left MINUS a reserve for the steps after it.
  // The fallback is the point of this oracle; it must be guaranteed a chance to answer.
  // The client route may use at most half, so the other half is still there when the
  // fallback is reached. Half of the shipped budget is 10s against a 167ms measured
  // download (#767) and a ~450ms live measurement — see the header for why the ~14.5s
  // figure that once sat here measures a different operation entirely.
  //
  // AND THE FLOOR NOW HOLDS BY CONSTRUCTION rather than by a `max()` that has to argue with
  // the clock. The client route is granted at most `deadline - consumed - FLOOR`, and
  // `consumed` grows by at most that grant, so when the fallback is reached
  // `deadline - consumed >= FLOOR` is arithmetic, not a hope. No clock jump, throttled
  // timer or overrun can starve the route this oracle exists to reach.
  const FALLBACK_FLOOR = Number.isFinite(deadlineMs) && deadlineMs > 0 ? Math.floor(deadlineMs / 2) : 0;
  const clientRouteWant = () => deadlineMs - consumed - FALLBACK_FLOOR;
  const fallbackWant = () => deadlineMs - consumed;
  const failures = [];

  if (typeof getNodeDefs === "function") {
    const { outcome, grant: clientMs } = await runStep(getNodeDefs, clientRouteWant());
    const kind = outcomeKind(outcome);
    if (kind === "not-tried") {
      // Cannot happen while this is the FIRST step (it holds the full budget minus the
      // fallback's floor), but it is stated rather than assumed.
      failures.push("api.getNodeDefs() was not attempted — the budget was already spent");
    } else if (kind === "no-answer") {
      // The #1161 case. Recorded as a failure like any other, and — critically — execution
      // CONTINUES to the second transport, which is what this bound exists to reach.
      // THE STEP'S OWN BUDGET, not the whole deadline. Browser-verified against a live
      // 4304-type install: the client route is capped at half, so quoting `deadlineMs`
      // here told the reader it had waited 20000ms when it had waited 10000ms. Naming a
      // number that was never spent is the same defect as #982's "unreachable or the
      // fetch failed" — a refusal asserting something it did not establish.
      failures.push(`api.getNodeDefs() did not answer within its ${Math.round(clientMs)}ms share of the ${deadlineMs}ms budget`);
    } else if (kind === "threw") {
      failures.push(describeFailure("api.getNodeDefs() threw", outcome.err));
    } else {
      const defs = outcome.value;
      if (usableDefs(defs)) return { [CACHE_OUTCOME]: true, defs, failures };
      // AN EMPTY MAP IS AN ANSWER, NOT AN ABSENCE (codex). A client that deliberately
      // filters could express deny-all as `{}`, and consulting the raw route would then
      // overrule it with a broader schema — the one direction this fallback must never
      // move. Only a client that returned NOTHING (null/undefined/non-object) or threw
      // leaves the question unanswered, and only that may be asked again elsewhere.
      if (defs && typeof defs === "object" && !Array.isArray(defs)) {
        failures.push("api.getNodeDefs() returned an EMPTY schema — treated as its answer, not as an absence");
        return { [CACHE_OUTCOME]: true, defs: null, failures };
      }
      failures.push(
        describeFailure(
          "api.getNodeDefs() returned no usable schema",
          null,
          ` (${defs === null ? "null" : Array.isArray(defs) ? "an array" : typeof defs})`,
        ),
      );
    }
  } else {
    failures.push("api.getNodeDefs is not a function on this frontend");
  }

  // SECOND TRANSPORT, same question. The reporter proved this route answers when the
  // client call does not — it is the one they ran by hand to show the backend was fine.
  if (typeof fetchApi === "function") {
    const { outcome, grant: fallbackMs } = await runStep(() => fetchApi("/object_info"), fallbackWant());
    const kind = outcomeKind(outcome);
    if (kind === "not-tried") {
      // TRUTHFUL ABOUT WHAT WAS NOT DONE. Saying this route "did not answer" when no
      // request was ever sent is #982's original defect — a refusal asserting a cause it
      // never established. The reserve above exists so this stays unreachable in practice.
      failures.push("GET /object_info was not attempted — the budget was spent before it was reached");
    } else if (kind === "no-answer") {
      failures.push(`GET /object_info did not answer within its ${Math.round(fallbackMs)}ms share of the ${deadlineMs}ms budget`);
    } else if (kind === "threw") {
      failures.push(describeFailure("GET /object_info threw", outcome.err));
    } else {
      const res = outcome.value;
      // #1161 — reading `ok`/`status` off the response is itself an operation that can
      // throw: an extension may monkey-patch fetchApi and hand back a lazily-evaluated or
      // proxied object. These reads used to sit inside this route's try/catch, and
      // replacing that with a bound left them exposed — verified against main, where the
      // same input produced a failures entry and here produced a rejection.
      let responseOk = false;
      let responseStatus = "unknown";
      try {
        responseOk = !!res && res.ok === true;
        // SANITIZE INSIDE THE GUARD. Reading `.status` is not the only operation that can
        // throw — INTERPOLATING it does too (`Object.create(null)` cannot convert to a
        // primitive), and that interpolation sits below this try. Verified against main,
        // which returned a failures entry where this rejected.
        responseStatus = sanitizeDetail(res?.status ?? "unknown") || "unknown";
      } catch (err) {
        failures.push(describeFailure("GET /object_info returned an unreadable response", err));
        return { [CACHE_OUTCOME]: true, defs: null, failures };
      }
      if (!responseOk) {
        failures.push(describeFailure("GET /object_info was not OK", null, ` (status ${responseStatus})`));
      } else {
        // The BODY is a second I/O step, and it was inside the try/catch this bound
        // replaced — an existing #982 test caught the escape. Reading a 5MB schema over a
        // half-open connection can also stall, so it is bounded as well rather than merely
        // re-caught: the response arriving is not the same event as the body arriving.
        const { outcome: body, grant: bodyMs } = await runStep(() => res.json(), fallbackWant());
        const bodyKind = outcomeKind(body);
        if (bodyKind === "not-tried") {
          failures.push("GET /object_info answered but its body was not read — the budget was spent");
        } else if (bodyKind === "no-answer") {
          failures.push(`GET /object_info answered but its body did not arrive within its ${Math.round(bodyMs)}ms share of the ${deadlineMs}ms budget`);
        } else if (bodyKind === "threw") {
          // Deliberately the SAME wording as before. A parse failure used to surface
          // through this route's catch, and an existing #982 test pins the sentence a user
          // reads. This change is about bounding the waits, not about rewording refusals —
          // improving the phrasing here would be a separate, reviewable decision.
          failures.push(describeFailure("GET /object_info threw", body.err));
        } else {
          const defs = body.value;
          if (usableDefs(defs)) return { [CACHE_OUTCOME]: true, defs, failures };
          failures.push("GET /object_info returned no usable schema (an empty or non-object body)");
        }
      }
    }
  } else {
    failures.push("no fetchApi is wired for the fallback route");
  }

  return { [CACHE_OUTCOME]: true, defs: null, failures };
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
