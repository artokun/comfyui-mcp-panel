/**
 * panel#805 — `panel_set_widget` reported FAILURE for a write that succeeded.
 *
 *     Widget "max_tokens" on node 1 (OllamaTextDescriber) did not retain the
 *     requested value: wrote 4096 but it became 4097.
 *
 * The mutation happened. The widget simply snapped the value onto its own
 * declared grid, which is what a numeric widget is supposed to do — and the
 * verification step, a strict `actual === expected`, called that a failed write.
 *
 * That is the mirror image of the defects this file's neighbours exist to prevent.
 * Elsewhere the danger is claiming success for work that did not happen; here the
 * tool claimed failure for work that DID. Both leave the caller with a false model
 * of the graph, and this one is worse in one respect: the natural response to
 * "did not retain" is to retry, and the retry normalizes identically forever.
 *
 * WHAT COUNTS AS NORMALIZATION. Only a value the widget's OWN declared config
 * explains exactly. We do not accept "close enough": a tolerance would eventually
 * swallow a real revert that happened to land nearby. The observed value must be
 * reproducible by snapping the request onto the widget's grid —
 *
 *     snap(v) = clamp(min + round((v - min) / step) * step, min, max)
 *
 * — and if no declared grid reproduces it, this stays the failure it was.
 *
 * Reported for the issue's own numbers: a widget declaring `min: 1, step: 2`
 * snaps 4096 to 4097 and 8192 to 8193, both exactly as reported.
 *
 * The `step / 10` candidate is deliberate, not a fudge: ComfyUI's INT/FLOAT
 * widgets have historically carried a drag-step that is ten times the value step,
 * so a widget can declare `step: 10` and quantize by 1. Trying both DECLARED
 * readings is still explaining the value from the config; inventing a third
 * arbitrary grid would not be.
 */

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

/** The widget's declared numeric config, wherever this build keeps it. */
function numericConfig(widget) {
  const o = widget?.options ?? widget?.config ?? null;
  if (!o || typeof o !== "object") return null;
  const num = (v) => (isFiniteNumber(v) ? v : null);
  return { min: num(o.min), max: num(o.max), step: num(o.step) };
}

function snap(value, { min, max, step }) {
  const base = min ?? 0;
  let out = value;
  if (isFiniteNumber(step) && step > 0) {
    out = base + Math.round((value - base) / step) * step;
  }
  if (isFiniteNumber(min)) out = Math.max(min, out);
  if (isFiniteNumber(max)) out = Math.min(max, out);
  // Snapping can push a value back outside the grid after clamping; the widget
  // clamps last, so mirror that order rather than re-snapping.
  return out;
}

/**
 * Did the widget's own declared config produce `actual` from `expected`?
 *
 * @returns {{rule: string, min: number|null, max: number|null, step: number|null}|null}
 *   null when nothing in the config explains it — which keeps it a failure.
 */
export function explainNumericNormalization(expected, actual, widget) {
  if (!isFiniteNumber(expected) || !isFiniteNumber(actual)) return null;
  if (expected === actual) return null; // nothing to explain
  const cfg = numericConfig(widget);
  if (!cfg) return null;
  const { min, max, step } = cfg;
  if (min === null && max === null && step === null) return null;

  const candidates = [];
  if (isFiniteNumber(step) && step > 0) {
    candidates.push({ ...cfg, step, why: `step ${step}` });
    // The historical drag-step-is-10x reading of the SAME declared value.
    candidates.push({ ...cfg, step: step / 10, why: `step ${step / 10} (declared step ${step})` });
  }
  // Pure clamping, with no grid at all.
  candidates.push({ ...cfg, step: null, why: "clamp" });

  for (const c of candidates) {
    if (snap(expected, c) === actual) {
      const bounds = [
        c.min !== null ? `min ${c.min}` : null,
        c.max !== null ? `max ${c.max}` : null,
      ].filter(Boolean);
      return {
        rule: [c.why, ...bounds].join(", "),
        min: c.min,
        max: c.max,
        step: c.step,
      };
    }
  }
  return null;
}

/**
 * What the reply says when a write was normalized. Leads with the fact the caller
 * most needs — the write APPLIED — because the previous message led with "did not
 * retain", which reads as "nothing happened, try again".
 */
export function normalizationNote({ name, requested, actual, rule }) {
  return (
    `Widget "${name}" was set and the node normalized the value: requested ` +
    `${JSON.stringify(requested)}, stored ${JSON.stringify(actual)} (${rule}). The write ` +
    `APPLIED — this is the widget's own declared quantization, not a failed write, and ` +
    `re-sending ${JSON.stringify(requested)} will normalize to ${JSON.stringify(actual)} ` +
    `again. Use ${JSON.stringify(actual)} as the value from here on.`
  );
}
