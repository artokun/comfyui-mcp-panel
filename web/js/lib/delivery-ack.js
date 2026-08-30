/**
 * #1995 — delivery acknowledgements must match what actually happened.
 *
 * Two reconnect failures share one mapping bug:
 *   - a run ComfyUI queued is reported as a user-rejected tool result, so the
 *     caller believes nothing is on the GPU while a prompt_id is already live;
 *   - a widget write that already applied is reported as a hard timeout with no
 *     receipt, so the caller re-reads to avoid a double write.
 *
 * A minted prompt id is a receipt the backend issues only after queueing. A
 * `set` object with a value is a receipt the write path issues only after the
 * callback returned. Neither may be rewritten as "rejected" or as a timeout
 * that names no receipt.
 *
 * Dependency-free. Unit-testable with plain values.
 */

const USER_REJECTED_RE =
  /user doesn't want to proceed|tool use was rejected|user rejected/i;

function looksLikeUserRejected(text) {
  return typeof text === "string" && USER_REJECTED_RE.test(text);
}

function normalizeIds(ids) {
  const out = [];
  const raw = Array.isArray(ids) ? ids : ids == null ? [] : [ids];
  for (const value of raw) {
    if (value == null) continue;
    const id = String(value).trim();
    if (id !== "" && !out.includes(id)) out.push(id);
  }
  return out;
}

function idsFrom(result) {
  if (!result || typeof result !== "object") return [];
  if (Array.isArray(result.prompt_ids) && result.prompt_ids.length) {
    return normalizeIds(result.prompt_ids);
  }
  return normalizeIds(result.prompt_id);
}

/**
 * Rewrite a run result so a queued prompt is never a user-rejected outcome.
 *
 * @param {object|null|undefined} result
 * @returns {object|null|undefined}
 */
export function honestRunAck(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const ids = idsFrom(result);
  const rejectedLanguage = looksLikeUserRejected(result.error);

  if (ids.length && rejectedLanguage) {
    const out = { ...result, queued: true, prompt_id: ids[0] };
    delete out.error;
    delete out.error_type;
    delete out.queued_unknown;
    if (ids.length > 1) out.prompt_ids = ids;
    return out;
  }

  if (!ids.length && rejectedLanguage) {
    const out = { ...result };
    delete out.queued;
    delete out.error;
    delete out.error_type;
    out.queued_unknown = true;
    out.error =
      "The queue acknowledgement was lost or incomplete, so the panel cannot confirm or correlate this run.";
    out.retry_guidance =
      "The run may have been accepted. Check the ComfyUI queue or history before retrying; a blind retry can duplicate the render.";
    return out;
  }

  return result;
}

/**
 * Rewrite a widget-write result so an applied mutation is never a hard timeout
 * with no receipt.
 *
 * @param {object|null|undefined} result
 * @param {{ timeout?: boolean }} [opts]
 * @returns {object|null|undefined}
 */
export function honestWidgetAck(result, { timeout = false } = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const set = result.set;
  const applied = !!(set && typeof set === "object" && Object.prototype.hasOwnProperty.call(set, "value"));

  if (applied) {
    const out = { ...result, applied: true };
    if (timeout) {
      out.ack_note =
        "The write applied; a later canvas flush did not settle in time, so this receipt is the widget value itself.";
    }
    delete out.error;
    return out;
  }

  if (timeout) {
    return {
      ...result,
      applied: false,
      error:
        "The widget write did not produce a receipt before the wait ended. Check the canvas before retrying; a blind retry can apply the value twice.",
    };
  }

  return result;
}
