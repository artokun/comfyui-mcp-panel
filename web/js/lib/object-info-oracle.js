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
 */

/** A payload that can actually answer "does the backend define this type?" */
function usableDefs(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

/** One attempt's outcome, in the words of what happened rather than a category. */
function describeFailure(label, err, extra = "") {
  const detail = err instanceof Error ? err.message : err == null ? "" : String(err);
  const suffix = detail ? `: ${detail}` : "";
  return `${label}${extra}${suffix}`;
}

/**
 * Fetch the whole `/object_info` schema, trying the frontend client first and the raw
 * HTTP route second.
 *
 * Returns `{ defs, failures }` — `defs` is null unless one route returned a usable
 * payload, and `failures` names every route that did not, in order. An empty `failures`
 * with a null `defs` cannot happen: a route that answers nothing is itself a failure.
 */
export async function fetchWholeObjectInfo({ getNodeDefs, fetchApi } = {}) {
  const failures = [];

  if (typeof getNodeDefs === "function") {
    try {
      const defs = await getNodeDefs();
      if (usableDefs(defs)) return { defs, failures };
      failures.push(
        describeFailure(
          "api.getNodeDefs() returned no usable schema",
          null,
          defs && typeof defs === "object" ? " (an empty object)" : ` (${defs === null ? "null" : typeof defs})`,
        ),
      );
    } catch (err) {
      failures.push(describeFailure("api.getNodeDefs() threw", err));
    }
  } else {
    failures.push("api.getNodeDefs is not a function on this frontend");
  }

  // SECOND TRANSPORT, same question. The reporter proved this route answers when the
  // client call does not — it is the one they ran by hand to show the backend was fine.
  if (typeof fetchApi === "function") {
    try {
      const res = await fetchApi("/object_info");
      if (!res || res.ok !== true) {
        failures.push(describeFailure("GET /object_info was not OK", null, ` (status ${res?.status ?? "unknown"})`));
      } else {
        const defs = await res.json();
        if (usableDefs(defs)) return { defs, failures };
        failures.push("GET /object_info returned no usable schema (an empty or non-object body)");
      }
    } catch (err) {
      failures.push(describeFailure("GET /object_info threw", err));
    }
  } else {
    failures.push("no fetchApi is wired for the fallback route");
  }

  return { defs: null, failures };
}

/**
 * The sentence a refusal appends: what was actually tried, and what each attempt did.
 *
 * Empty when nothing was recorded, so a caller that never ran this helper reads exactly
 * as it did before rather than gaining a hollow "no failures" clause.
 */
export function objectInfoOracleFailureNote(failures) {
  if (!Array.isArray(failures) || !failures.length) return "";
  const which = failures.map((f) => String(f)).filter(Boolean);
  if (!which.length) return "";
  return ` Tried ${which.length === 1 ? "one route" : `${which.length} routes`}: ${which.join("; ")}.`;
}
