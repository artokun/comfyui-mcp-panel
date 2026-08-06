// Interpret ComfyUI's response to a queue attempt (POST /prompt).
//
// ComfyUI rejects a prompt on TWO channels, and the frontend surfaces them very
// differently:
//
//   • Per-node VALIDATION errors → `node_errors` (a map keyed by node id). The
//     frontend stores these on `app.lastNodeErrors`, so they're readable after
//     the queue call returns.
//
//   • A TOP-LEVEL rejection → `error` (e.g. `{type:"missing_node_type", …}` when
//     a node has no resolvable class_type, or "prompt outputs failed validation").
//     `app.queuePrompt` shows this in a DIALOG and then DISCARDS it — it never
//     lands on `app.lastNodeErrors` (which stays `{}` for a pure top-level
//     rejection). So a caller that only inspects `lastNodeErrors` sees "no
//     errors" and wrongly reports `queued:true` for a prompt ComfyUI refused
//     synchronously (#358). The caller must capture the raw non-200 body's
//     top-level `error` to see it at all.
//
// This module is the pure verdict: given the captured rejection body (if any) and
// the post-attempt `lastNodeErrors`, decide whether the prompt was REFUSED and
// with what detail. Returns `null` when the prompt was genuinely accepted (the
// caller then reports `queued:true`), or a `{queued:false, …}` failure otherwise.

/**
 * @param {object}   args
 * @param {object|null} [args.rejection]  Raw body of a non-200 POST /prompt,
 *   shape `{ error?, node_errors? }`. `null` when the POST returned 200.
 * @param {object|null} [args.lastNodeErrors]  `app.lastNodeErrors` read AFTER the
 *   queue attempt (per-node validation errors; `{}`/null when none).
 * @returns {null | {queued:false, error?:string, error_type?:string, node_errors?:object}}
 *   `null` ⇒ accepted (report queued). Otherwise the failure to return verbatim.
 */
export function summarizePromptRejection({ rejection = null, lastNodeErrors = null } = {}) {
  const topError = rejection && typeof rejection === "object" ? rejection.error ?? null : null;
  // Prefer the node_errors carried on the rejection body itself; fall back to
  // what the frontend stored. Either is authoritative for per-node validation.
  const nodeErrors =
    normalizeNodeErrors(rejection && typeof rejection === "object" ? rejection.node_errors : null) ??
    normalizeNodeErrors(lastNodeErrors);

  // No top-level error AND no per-node errors ⇒ the prompt was accepted.
  if (!hasTopError(topError) && !nodeErrors) return null;

  const result = { queued: false };
  if (hasTopError(topError)) {
    result.error = formatTopError(topError);
    const type = typeof topError === "object" && topError ? topError.type : null;
    if (type) result.error_type = String(type);
  }
  if (nodeErrors) result.node_errors = nodeErrors;
  return result;
}

function hasTopError(err) {
  if (err == null) return false;
  if (typeof err === "string") return err.trim().length > 0;
  if (typeof err === "object") return Object.keys(err).length > 0;
  return Boolean(err);
}

function normalizeNodeErrors(ne) {
  if (ne && typeof ne === "object" && !Array.isArray(ne) && Object.keys(ne).length) return ne;
  return null;
}

/**
 * Build the ACCEPT result for a queued run. Surfaces the queued prompt_id(s) so
 * the agent can correlate/track the run — #370 reconciliation and mcp#531
 * (panel_run must return the prompt_id, even when a render is already running)
 * both depend on this. `prompt_id` is the first accepted id; `prompt_ids` is only
 * added for a batch that queued more than one.
 *
 * @param {object} args
 * @param {number} args.batchCount
 * @param {(string|null)[]} [args.promptIds]  Accepted prompt_ids, in queue order.
 * @param {number|null} [args.ranToNode]      Present for a run-to-node partial run.
 */
export function buildQueueAcceptResult({ batchCount, promptIds = [], ranToNode = null } = {}) {
  // NORMALIZE to strings at this ingestion boundary (drop null/undefined) so the
  // reported prompt_id(s), and everything that later reconciles against them, are
  // string-vs-string — a numeric /prompt id can't slip through as a number (#370).
  // Dedupe AFTER normalization (via Set) so a mixed 0 / "0" batch reports one id.
  const ids = [
    ...new Set(
      (Array.isArray(promptIds) ? promptIds : []).filter((x) => x != null).map((x) => String(x)),
    ),
  ];
  return {
    queued: true,
    batch_count: batchCount,
    ...(ids.length ? { prompt_id: ids[0] } : {}),
    ...(ids.length > 1 ? { prompt_ids: [...ids] } : {}),
    ...(ranToNode != null ? { ran_to_node: ranToNode } : {}),
  };
}

/** Human-readable one-liner for a top-level rejection object. */
export function formatTopError(err) {
  if (err == null) return "prompt rejected";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const msg =
      (typeof err.message === "string" && err.message) ||
      (typeof err.type === "string" && err.type) ||
      "prompt rejected";
    const details = typeof err.details === "string" && err.details ? ` (${err.details})` : "";
    return `${msg}${details}`;
  }
  return String(err);
}
