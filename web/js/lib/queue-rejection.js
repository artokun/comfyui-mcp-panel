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
 * @param {{nodeId:(string|number), nodeType?:string}|null} [args.runToNode]  Set only
 *   for a run-to-node partial run, naming the target the panel ALREADY verified
 *   advertises `output_node:true`. Used to explain a `prompt_no_outputs` refusal
 *   (#699) instead of passing the bare backend string through.
 * @param {(string|number)[]} [args.acceptedPromptIds]  Every prompt_id ComfyUI MINTED
 *   during this run, read out of a 200 POST /prompt body (#1504). A minted id is a
 *   receipt of acceptance, not a flag the panel set, so it decides the verdict over
 *   any per-node errors that accompany it.
 * @returns {null | {queued:false, error?:string, error_type?:string, node_errors?:object,
 *   prompt_id?:string, prompt_ids?:string[]}}
 *   `null` ⇒ accepted (report queued). Otherwise the failure to return verbatim.
 */
export function summarizePromptRejection({
  rejection = null,
  lastNodeErrors = null,
  runToNode = null,
  acceptedPromptIds = [],
} = {}) {
  const topError = rejection && typeof rejection === "object" ? rejection.error ?? null : null;
  // Prefer the node_errors carried on the rejection body itself; fall back to
  // what the frontend stored. Either is authoritative for per-node validation.
  const nodeErrors =
    normalizeNodeErrors(rejection && typeof rejection === "object" ? rejection.node_errors : null) ??
    normalizeNodeErrors(lastNodeErrors);

  // No top-level error AND no per-node errors ⇒ the prompt was accepted.
  if (!hasTopError(topError) && !nodeErrors) return null;

  // #1504 — A MINTED PROMPT ID OUTRANKS node_errors.
  //
  // ComfyUI validates each output independently. When some fail but at least one
  // survives, `validate_prompt` returns True, server.py queues the prompt, and the
  // reply is a **200** carrying `prompt_id` AND the `node_errors` for the outputs it
  // dropped. The frontend records those on `app.lastNodeErrors` just the same, so the
  // per-node channel alone cannot tell "refused" from "accepted, minus two branches".
  //
  // Reported as a refusal it produced the exact mismatch of #1504: six bypassed
  // VAEDecode branches were surfaced as "ComfyUI refused to queue the workflow" while
  // the render was on the GPU, and every subsequent graph call came back QUEUE BUSY —
  // the caller was told nothing had been queued by the very run that was blocking it.
  //
  // The asymmetry that makes this safe is the same one mcp#944 relies on: `queued` is a
  // flag the panel sets, but a prompt_id is an identifier ComfyUI MINTED, and server.py
  // mints one only inside the `if valid[0]:` branch, after `prompt_queue.put(...)`. So
  // an id present ⇒ work was accepted. #358 does not regress: a pure top-level rejection
  // is a 400 that mints nothing, leaving this list empty.
  //
  // A top-level error still wins, because the two claims then contradict each other and
  // this module must not pick a side — it reports BOTH (the ids ride along on the result)
  // and lets the orchestrator send the caller to the queue to settle it.
  const acceptedIds = normalizeAcceptedIds(acceptedPromptIds);
  if (acceptedIds.length && !hasTopError(topError)) return null;

  const result = { queued: false };
  if (acceptedIds.length) {
    result.prompt_id = acceptedIds[0];
    if (acceptedIds.length > 1) result.prompt_ids = [...acceptedIds];
  }
  if (hasTopError(topError)) {
    result.error = formatTopError(topError);
    const type = typeof topError === "object" && topError ? topError.type : null;
    if (type) result.error_type = String(type);
    const hint = noOutputsHint(result.error_type, runToNode);
    if (hint) result.error = `${result.error} ${hint}`;
  }
  if (nodeErrors) result.node_errors = nodeErrors;
  return result;
}

/**
 * #699 — explain a `prompt_no_outputs` refusal of a run-to-node whose target the
 * panel ALREADY verified is an output node.
 *
 * The reporter's contradiction was real and unexplained: `panel_query_graph` said
 * `is_output:true` for the target, run-to-node accepted it on the same evidence,
 * and ComfyUI then refused with "Prompt has no outputs". Passing that string
 * through gives an agent nothing to act on — it reads as "your output node is not
 * an output node".
 *
 * The two systems genuinely disagree, and ComfyUI's own source shows how. The
 * flag the panel reads comes from `/object_info`, built in server.py with an
 * EQUALITY test:
 *
 *     if hasattr(obj_class, 'OUTPUT_NODE') and obj_class.OUTPUT_NODE == True:
 *         info['output_node'] = True
 *
 * while execution.py decides what counts as an output with an IDENTITY test:
 *
 *     if hasattr(class_, 'OUTPUT_NODE') and class_.OUTPUT_NODE is True:
 *         if partial_execution_list is None or x in partial_execution_list:
 *             outputs.add(x)
 *     if len(outputs) == 0:  ->  "Prompt has no outputs"
 *
 * In Python `1 == True` but `1 is not True`. So a pack whose class sets
 * `OUTPUT_NODE = 1` (or any value equal-but-not-identical to `True`, e.g. a numpy
 * bool) is ADVERTISED as an output node and REFUSED at execution. The panel
 * cannot detect this in advance — `/object_info` has already normalized the value
 * to a JSON boolean by the time it arrives — so the only honest place to say it is
 * here, after the backend has disagreed.
 *
 * The hint therefore states possibilities, not a verdict: the other way to get an
 * empty output set is for the target to be absent from the submitted prompt at
 * all (muted or bypassed nodes are dropped during serialization). Naming one cause
 * as though it were established would be the same over-claiming this text exists to
 * replace.
 *
 * Only fires for a run-to-node. A FULL run that reports no outputs means the
 * workflow genuinely has none, which the plain message already says correctly.
 */
function noOutputsHint(errorType, runToNode) {
  if (errorType !== "prompt_no_outputs" || !runToNode) return "";
  const id = runToNode.nodeId;
  const type = runToNode.nodeType ? ` (${runToNode.nodeType})` : "";
  return (
    `The panel targeted node ${id}${type}, which ComfyUI's /object_info advertises as an ` +
    `output node — so this refusal is a DISAGREEMENT between what was advertised and what ` +
    `the executor accepted, not a mistake in your node id. Two known causes: (1) the node is ` +
    `muted or bypassed, so it is dropped during prompt serialization and never reaches the ` +
    `executor; (2) the node pack sets OUTPUT_NODE to a value that EQUALS True without BEING ` +
    `True (e.g. 1) — ComfyUI advertises output_node with an equality test but selects outputs ` +
    `with an identity test, so such a node is listed as an output and then refused. Cause (2) ` +
    `is a defect in the node pack and cannot be worked around from here. Either way, running ` +
    `the FULL workflow (omit to_node_id) executes this node normally.`
  );
}

function hasTopError(err) {
  if (err == null) return false;
  if (typeof err === "string") return err.trim().length > 0;
  if (typeof err === "object") return Object.keys(err).length > 0;
  return Boolean(err);
}

/** Accepted prompt ids as a deduped, order-preserving list of non-blank strings. */
function normalizeAcceptedIds(ids) {
  const out = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    if (raw == null) continue; // but 0 is a real id — only null/undefined are dropped
    const id = String(raw).trim();
    if (id !== "" && !out.includes(id)) out.push(id);
  }
  return out;
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
 * #1504 — an accepted run may have DROPPED some outputs. ComfyUI reports those on the
 * 200 body's `node_errors`, and they are reported here verbatim, on an otherwise normal
 * accept. This is deliberately loud rather than silent: the failure it replaces claimed
 * the whole run was refused, and staying quiet would be the opposite error — the caller
 * would wait for a file that will never be written. The orchestrator renders it as the
 * mcp#944 "[PARTIAL] … the remaining outputs ARE executing" disclosure, which until now
 * was unreachable from the panel because the panel never sent a prompt_id alongside them.
 *
 * @param {object} args
 * @param {number} args.batchCount
 * @param {(string|null)[]} [args.promptIds]  Accepted prompt_ids, in queue order.
 * @param {number|null} [args.ranToNode]      Present for a run-to-node partial run.
 * @param {object|null} [args.droppedOutputs] `node_errors` from the ACCEPTED 200 reply.
 */
export function buildQueueAcceptResult({
  batchCount,
  promptIds = [],
  ranToNode = null,
  droppedOutputs = null,
} = {}) {
  // NORMALIZE to strings at this ingestion boundary (drop null/undefined) so the
  // reported prompt_id(s), and everything that later reconciles against them, are
  // string-vs-string — a numeric /prompt id can't slip through as a number (#370).
  // Dedupe AFTER normalization (via Set) so a mixed 0 / "0" batch reports one id.
  const ids = [
    ...new Set(
      (Array.isArray(promptIds) ? promptIds : []).filter((x) => x != null).map((x) => String(x)),
    ),
  ];
  const dropped = normalizeNodeErrors(droppedOutputs);
  return {
    queued: true,
    batch_count: batchCount,
    ...(ids.length ? { prompt_id: ids[0] } : {}),
    ...(ids.length > 1 ? { prompt_ids: [...ids] } : {}),
    ...(ranToNode != null ? { ran_to_node: ranToNode } : {}),
    ...(dropped ? { node_errors: dropped } : {}),
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
