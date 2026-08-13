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
 */

import { CACHE_OUTCOME } from "./object-info-cache.js";
// #1161 — the repo's one bounded-step primitive. A second timeout helper is how this
// repo keeps producing near-duplicate bugs, per that file's own header.
import { withTimeout } from "./bounded-step.js";

/** A payload that can actually answer "does the backend define this type?" */
function usableDefs(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
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
  const raw = err instanceof Error ? err.message : err == null ? "" : String(err);
  const detail = sanitizeDetail(raw);
  const suffix = detail ? `: ${detail}` : "";
  return `${label}${extra}${suffix}`;
}

/**
 * #1161 — how long ONE transport may take before this oracle moves on to the next.
 *
 * The P1: after a ComfyUI restart the tab can hold a half-open connection, so
 * `api.getNodeDefs()` never settles — it does not throw, it simply never answers. Both
 * awaits below were unbounded, so the whole oracle parked on the first transport and the
 * second route, added by #982 for exactly this failure, was never asked. Every command
 * that consults it hung until its caller timed out.
 *
 * This bound is what makes the fallback REACHABLE. It is not a way to fail faster: the
 * point is that the second route usually answers, so the write succeeds. That is why the
 * bound belongs here and not around the cache — a bound there can only choose how to give
 * up, which is what three attempts on #1178 kept rediscovering.
 *
 * PER TRANSPORT, so the worst case is two bounds rather than one. Kept well inside the
 * callers' own budgets (the bridge times a command out at 30s) so trying the second route
 * is still useful, while long enough that a legitimately slow first route is not abandoned
 * while it is still working — /object_info measures ~167ms on a 63-pack install (#767),
 * so seconds of headroom is generous rather than tight.
 */
export const OBJECT_INFO_TRANSPORT_WAIT_MS = 6000;

/** Distinguishes "this transport did not answer in time" from any value it could return. */
const NO_ANSWER = Symbol("object-info-transport-timeout");

/**
 * Run one transport under a bound, preserving the difference between the three outcomes
 * the failure list already distinguishes: it answered, it threw, or it never answered.
 *
 * `withTimeout` NEVER rejects by contract, so a naive wrap would collapse "threw" into
 * "timed out" and the refusal would name the wrong cause — the trap that bit #1178. The
 * outcome is therefore reified before bounding and unwrapped after.
 */
async function runTransport(attempt, waitMs, timers) {
  const settled = await withTimeout(
    Promise.resolve()
      .then(attempt)
      .then((value) => ({ value }), (err) => ({ err })),
    waitMs,
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
  // Injected so a test can drive the bound without waiting on a real clock.
  waitMs = OBJECT_INFO_TRANSPORT_WAIT_MS,
  timers,
} = {}) {
  const failures = [];

  if (typeof getNodeDefs === "function") {
    const outcome = await runTransport(getNodeDefs, waitMs, timers);
    if (outcome === NO_ANSWER) {
      // The #1161 case. Recorded as a failure like any other, and — critically — execution
      // CONTINUES to the second transport, which is what this bound exists to reach.
      failures.push(`api.getNodeDefs() did not answer within ${waitMs}ms`);
    } else if ("err" in outcome) {
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
    const outcome = await runTransport(() => fetchApi("/object_info"), waitMs, timers);
    if (outcome === NO_ANSWER) {
      failures.push(`GET /object_info did not answer within ${waitMs}ms`);
    } else if ("err" in outcome) {
      failures.push(describeFailure("GET /object_info threw", outcome.err));
    } else {
      const res = outcome.value;
      if (!res || res.ok !== true) {
        failures.push(describeFailure("GET /object_info was not OK", null, ` (status ${res?.status ?? "unknown"})`));
      } else {
        // The BODY is a second I/O step, and it was inside the try/catch this bound
        // replaced — an existing #982 test caught the escape. Reading a 5MB schema over a
        // half-open connection can also stall, so it is bounded as well rather than merely
        // re-caught: the response arriving is not the same event as the body arriving.
        const body = await runTransport(() => res.json(), waitMs, timers);
        if (body === NO_ANSWER) {
          failures.push(`GET /object_info answered but its body did not arrive within ${waitMs}ms`);
        } else if ("err" in body) {
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
