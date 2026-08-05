/**
 * Payload bounds for `last_execution_error` in graph_get_errors (#664) —
 * extracted from comfyui-mcp-panel.js so the invariant is unit-testable
 * without a browser. No DOM / no ComfyUI globals: every input is passed in.
 *
 * The defect: ComfyUI's execution_error event carries `current_inputs` /
 * `current_outputs` with the LIVE values (latents, images — tensor-sized) and
 * a traceback whose lines can be huge tensor reprs. graph_get_errors emitted
 * that payload VERBATIM, and one sampling failure produced a 41k+ token tool
 * result that overflowed the agent's context. The newer nodes[].reasons[]
 * surface was already token-bounded; this compat surface was not.
 *
 * The shape below keeps every field an existing consumer reads — the scalar
 * identity of the failure (prompt_id / node_id / node_type / exception_type /
 * ts) plus the message, traceback, executed list and current_outputs — but
 * each text surface is capped, and every cut is DISCLOSED in-band with a note
 * rather than dropped silently (a bare `truncated: true` boolean is the worst
 * truncation signal there is: it carries no instruction). `current_inputs` is
 * never shipped: it is the tensor-sized field and the failing node + exception
 * already identify the fault. Naming a lever this view does not have would be
 * the same defect pointing the other way, so the notes say the cap is FIXED.
 *
 * Worst case by construction, measured on the SERIALIZED form (see
 * capSerializedText): EXEC_ERR_MESSAGE_CAP + EXEC_ERR_TRACEBACK_MAX_LINES
 * × EXEC_ERR_TRACEBACK_LINE_CAP + EXEC_ERR_OUTPUTS_JSON_CAP + small scalars and
 * notes ≈ 88k chars — versus megabytes unbounded.
 */

import { coerceMessageText } from "./chat-serialize.js";

/** Cap on the exception message. Field-verified in #664's local fix. */
export const EXEC_ERR_MESSAGE_CAP = 4000;
/** Traceback bounds: line count × per-line chars. Field-verified in #664. */
export const EXEC_ERR_TRACEBACK_MAX_LINES = 40;
export const EXEC_ERR_TRACEBACK_LINE_CAP = 2000;
/** Cap on the `executed` node-id list (scalar ids; only the count can grow). */
export const EXEC_ERR_EXECUTED_CAP = 100;
/** current_outputs ships RAW only when its serialized form fits this cap;
 *  larger (or unserializable) values are omitted with a disclosure note —
 *  partial giant output dumps help no one and reintroduce #664. */
export const EXEC_ERR_OUTPUTS_JSON_CAP = 2000;

/**
 * Text caps are measured on the JSON-SERIALIZED form, not raw JS code units:
 * the tool result crosses the bridge as JSON, and escape-heavy text (control
 * characters, lone surrogates) expands up to 6× on the wire (one byte becomes
 * its six-character escape), which would otherwise multiply every cap past the
 * stated worst case (codex gate round 2). Returns the longest prefix whose
 * serialized length fits.
 *
 * The search runs over CODE POINTS, not code units: serialized-prefix length
 * is only monotonic on code-point boundaries — a code-unit slice can end on a
 * lone high surrogate, whose six-character escape makes a SHORTER prefix
 * serialize LONGER and breaks a code-unit binary search (codex gate round 3).
 */
function capSerializedText(text, cap) {
  const escLen = (t) => JSON.stringify(t).length - 2; // strip the quotes
  if (escLen(text) <= cap) return { text, truncated: false };
  const points = [...text];
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (escLen(points.slice(0, mid).join("")) <= cap) lo = mid;
    else hi = mid - 1;
  }
  return { text: points.slice(0, lo).join(""), truncated: true };
}

/**
 * Bounded form of one captured execution_error detail. `null` in → `null` out
 * (no failure stays "no failure"); a non-object detail is coerced into the
 * message rather than dropped, so a failure is never reported as absent.
 */
export function boundExecFailurePayload(e) {
  if (e == null) return null;
  // The capture path always stores an object ({ ...ev.detail, ts }); the
  // coerce branch is defence against a detail that arrived as a bare string.
  const src = typeof e === "object" ? e : { exception_message: e };

  const out = {
    prompt_id: src.prompt_id ?? null,
    node_id: src.node_id ?? null,
    node_type: src.node_type ?? null,
    exception_type: src.exception_type ?? null,
  };
  if (src.ts != null) out.ts = src.ts;

  const msg = capSerializedText(coerceMessageText(src.exception_message ?? ""), EXEC_ERR_MESSAGE_CAP);
  out.exception_message = msg.text;
  if (msg.truncated) {
    out.exception_message_truncated = true;
    out.exception_message_note =
      `Capped at ${EXEC_ERR_MESSAGE_CAP} chars (fixed cap, no parameter raises it) — ` +
      `the full message is printed in the ComfyUI server console.`;
  }

  const tb = Array.isArray(src.traceback) ? src.traceback : [];
  let tbTruncated = tb.length > EXEC_ERR_TRACEBACK_MAX_LINES;
  out.traceback = tb.slice(0, EXEC_ERR_TRACEBACK_MAX_LINES).map((line) => {
    const capped = capSerializedText(coerceMessageText(line), EXEC_ERR_TRACEBACK_LINE_CAP);
    if (capped.truncated) tbTruncated = true;
    return capped.text;
  });
  if (tbTruncated) {
    out.traceback_truncated = true;
    out.traceback_note =
      `Capped at ${EXEC_ERR_TRACEBACK_MAX_LINES} lines × ${EXEC_ERR_TRACEBACK_LINE_CAP} chars ` +
      `(fixed cap, no parameter raises it) — the full traceback is printed in the ComfyUI server console.`;
  }

  if (Array.isArray(src.executed)) {
    out.executed = src.executed.slice(0, EXEC_ERR_EXECUTED_CAP);
    if (src.executed.length > EXEC_ERR_EXECUTED_CAP) {
      out.executed_truncated = true;
      out.executed_note =
        `Showing the first ${EXEC_ERR_EXECUTED_CAP} executed node ids (fixed cap, no parameter raises it). ` +
        "This list is run-order context only — the failure itself is identified by node_id/node_type/exception above.";
    }
  }

  // Tensor-sized surfaces. current_inputs is withheld unconditionally: it
  // serializes the live input VALUES (latents/images) and is exactly what
  // overflowed the context in #664. current_outputs ships only when small.
  if (src.current_inputs != null) {
    out.current_inputs_omitted = true;
    out.current_inputs_note =
      "Withheld by design: ComfyUI serializes the LIVE input values here (latents/images — " +
      "tensor-sized), which is the payload that overflowed the agent context (#664). The failing " +
      "node_id/node_type and exception above identify the fault; this view never ships the values.";
  }
  if (src.current_outputs != null) {
    let json = null;
    try {
      json = JSON.stringify(src.current_outputs);
    } catch {
      json = null; // circular / BigInt — falls through to the disclosed omission
    }
    if (json != null && json.length <= EXEC_ERR_OUTPUTS_JSON_CAP) {
      out.current_outputs = src.current_outputs;
    } else {
      out.current_outputs_omitted = true;
      out.current_outputs_note =
        `Omitted: exceeds the ${EXEC_ERR_OUTPUTS_JSON_CAP}-char serialized cap, or could not be ` +
        "serialized (fixed cap, no parameter raises it — this view never ships oversized output " +
        "values). Output values can be tensor-sized; the failing node and exception above " +
        "identify the fault without them.";
    }
  }

  return out;
}
