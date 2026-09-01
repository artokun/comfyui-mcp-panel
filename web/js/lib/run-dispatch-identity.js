/**
 * Identity observed around a panel_run dispatch.
 *
 * A prompt_id proves that ComfyUI accepted a request at one instant. It does
 * not prove that the same backend, workflow target, or bridge route remained
 * in place while the panel was waiting for the frontend queue wrapper.
 * Keep this comparison dependency-free so the executor can fail closed and
 * the production-path tests can drive the exact boundary.
 */

function text(value) {
  if (typeof value !== "string") return value == null ? null : String(value);
  const trimmed = value.trim();
  return trimmed || null;
}

function epoch(value) {
  return Number.isFinite(value) ? value : null;
}

export function captureRunDispatchIdentity({
  routeId = null,
  routeReady = true,
  workflowUuid = null,
  reconnectEpoch = null,
  targetId = null,
} = {}) {
  return {
    routeId: text(routeId),
    routeReady: routeReady === true,
    workflowUuid: text(workflowUuid),
    reconnectEpoch: epoch(reconnectEpoch),
    targetId: text(targetId),
  };
}

/**
 * Compare two observations. Null is an identity value, not a wildcard: an
 * identity that becomes unreadable or appears late cannot authorize a run.
 */
export function compareRunDispatchIdentity(before, after) {
  const left = captureRunDispatchIdentity(before);
  const right = captureRunDispatchIdentity(after);
  const changed = [];
  if (left.reconnectEpoch !== right.reconnectEpoch) changed.push("reconnect");
  if (left.routeId !== right.routeId) changed.push("bridge route");
  if (left.workflowUuid !== right.workflowUuid) changed.push("workflow");
  if (left.targetId !== right.targetId) changed.push("run target");
  if (!left.routeReady || !right.routeReady) changed.push("route readiness");
  return { stable: changed.length === 0, changed, before: left, after: right };
}

/**
 * Keep accepted prompt receipts, but remove a positive queued claim when the
 * dispatch crossed an identity boundary. The receipt still lets reconciliation
 * check the exact prompt instead of inviting a blind duplicate retry.
 */
export function downgradeUnstableRunResult(result, comparison) {
  if (comparison?.stable || !result || typeof result !== "object") return result;
  const ids = [
    ...(Array.isArray(result.prompt_ids) ? result.prompt_ids : []),
    ...(Array.isArray(result.queued_prompt_ids) ? result.queued_prompt_ids : []),
    ...(result.prompt_id != null ? [result.prompt_id] : []),
  ]
    .map((id) => String(id).trim())
    .filter((id, index, all) => id && all.indexOf(id) === index);
  // A result with no accepted receipt is already fail-closed. Only rewrite a
  // positive/partially-positive result: the prompt_id(s) remain valuable for
  // reconciliation, but queued:true would overstate survival across the change.
  if (result.queued !== true && !ids.length) return result;
  const out = { ...result };
  delete out.queued;
  out.queued_unknown = true;
  if (ids.length) {
    out.prompt_id = ids[0];
    out.queued_count = ids.length;
    if (ids.length > 1) out.prompt_ids = ids;
  }
  out.dispatch_identity = { stable: false, changed: comparison.changed };
  out.error =
    `ComfyUI returned a prompt receipt, but the ${comparison.changed.join(", ")} ` +
    `changed during dispatch. The receipt proves acceptance at the earlier instant, ` +
    `not that this run survived the reconnect/target handoff.`;
  out.retry_guidance =
    `Check the ComfyUI queue or history for ${ids.length ? `prompt_id${ids.length > 1 ? "s" : ""} ${ids.join(", ")} ` : "this run "}` +
    `before retrying. An empty queue/history during a handoff is ambiguous, and a blind retry can duplicate the render.`;
  return out;
}
