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
 * reproducible by re-running the frontend's own quantization on the request, and
 * if no declared reading reproduces it, this stays the failure it was.
 *
 * ---------------------------------------------------------------------------
 * comfyui-mcp#1130 (recurrence, 2026-08-21) — the SAME failure on a FLOAT grid:
 *
 *     panel_set_widget AdjustContrast.factor = 1.12 → widget stored 1.1
 *     → "did not retain the requested value"
 *
 * The first fix modelled quantization as ONE formula — `min + round((v - min) /
 * step) * step`, clamped — because that is what the integer case looks like. It
 * is not what the frontend does, and it is not even one formula. Read off the
 * running build (ComfyUI 0.33.2 / frontend 1.49.6) the number widget has TWO
 * callbacks, and the float one shares no term with the integer one:
 *
 *     // INT — onValueChange
 *     const t = options.step2 || 1;
 *     if (t === 1) value = Math.round(e);
 *     else { const n = (options.min ?? 0) % t; value = Math.round((e - n) / t) * t + n; }
 *
 *     // FLOAT — onFloatValueChange
 *     const t = options.round;
 *     if (t) {
 *       const n = options.precision ?? Math.max(0, -Math.floor(Math.log10(t)));
 *       const r = Math.round(e / t) * t;
 *       value = clamp(Number(r.toFixed(n)), options.min ?? -Inf, options.max ?? Inf);
 *     } else value = e;
 *
 * Three differences, each on its own enough to make the old model miss:
 *
 *  - **The float grid is `options.round`, not `options.step`.** `AdjustContrast.factor`
 *    declares no step at all, so the frontend fills in `step: 5, step2: 0.5,
 *    round: 0.1, precision: 1`. The grid that quantized 1.12 to 1.1 is `round`
 *    — a value neither `step` (5) nor the 10x reading of it (0.5) produces.
 *  - **The float grid is anchored at ZERO, not at `min`.** Usually invisible —
 *    `toFixed` re-rounds onto the zero grid and hides the shift — but not always:
 *    `NormalizeImages.std` (min 0.001, round 0.1) stores 0.1 for a request of
 *    0.0500223, where anchoring at min yields 0.001. Measured, not reasoned: the
 *    two models were swept against each other for a disagreement and the
 *    disagreement was then run on the rig.
 *  - **`toFixed(precision)` is part of the arithmetic, not presentation.** It is
 *    what makes the stored value the exact double `1.1` rather than the
 *    `1.1000000000000000888` that `Math.round(1.12 / 0.1) * 0.1` leaves behind.
 *
 * That last one is why this file replicates the callbacks verbatim instead of
 * reaching for an epsilon. The comparison stays a strict `===`; the fix is to
 * compute the SAME number the frontend computes, `toFixed` included, so exactness
 * is achievable rather than approximate. A tolerance wide enough to accept
 * 1.12 → 1.1 would also accept a widget that quietly kept 1.14, and "the write
 * was refused" is the one verdict this module must never get wrong in the
 * optimistic direction.
 *
 * Measured on the live rig before and after: of 74 real widget writes that the
 * frontend quantized (80 numeric widgets sampled across the installed packs),
 * the single-formula model explained 52 and reported 22 as failed writes. The
 * replicated callbacks explain all 74.
 *
 * The pre-`step2` readings below are KEPT, not replaced. Older frontends put only
 * `step` on the widget, and packs inject a bare `{ step: 8 }` of their own
 * (AnimateDiff's dimension step, #1533) with no `round`/`step2` beside it. Those
 * are still declared config, and dropping them would re-break the case this file
 * was written for.
 */

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

/** The widget's declared numeric config, wherever this build keeps it. */
function numericConfig(widget) {
  const o = widget?.options ?? widget?.config ?? null;
  if (!o || typeof o !== "object") return null;
  const num = (v) => (isFiniteNumber(v) ? v : null);
  return {
    min: num(o.min),
    max: num(o.max),
    step: num(o.step),
    // The frontend's own split: `step` is the DRAG step (10x), `step2` the value
    // step the INT callback actually quantizes by.
    step2: num(o.step2),
    // The FLOAT callback's grid. Nothing else in this config is it.
    round: num(o.round),
    precision: Number.isInteger(o.precision) ? o.precision : null,
  };
}

function clampTo(value, min, max) {
  let out = value;
  if (isFiniteNumber(min)) out = Math.max(min, out);
  if (isFiniteNumber(max)) out = Math.min(max, out);
  return out;
}

/**
 * `onFloatValueChange`, verbatim — including the `toFixed(precision)` that makes
 * the stored number an exact decimal rather than the raw product.
 *
 * Returns null when this build's config cannot drive it, so the candidate is
 * SKIPPED rather than contributing a value the frontend would never produce.
 */
function snapFloat(value, { round, precision, min, max }) {
  if (!isFiniteNumber(round) || round <= 0) return null;
  const digits = precision ?? Math.max(0, -Math.floor(Math.log10(round)));
  // `toFixed` throws outside 0..100. A config that would throw is a config the
  // frontend never quantized with, so explain nothing rather than guess.
  if (!Number.isInteger(digits) || digits < 0 || digits > 100) return null;
  const raw = Math.round(value / round) * round;
  if (!Number.isFinite(raw)) return null;
  const fixed = Number(raw.toFixed(digits));
  if (!Number.isFinite(fixed)) return null;
  return clampTo(fixed, min, max);
}

/**
 * `onValueChange` (the INT callback), verbatim.
 *
 * Note the anchor: `min % step`, not `min`. Both generate the same lattice, but
 * this is the arithmetic the frontend runs, and matching it exactly is the whole
 * contract of this module.
 *
 * And note what is NOT here: a clamp. The float callback clamps its own result;
 * this one does not, and the clamp that would otherwise cover it lives in
 * `NumberWidget.setValue`, which `applyWidgetWrite` does not go through — it
 * assigns `widget.value` and invokes the callback directly. Measured on the rig
 * rather than argued: `EmptyLatentImage.width` (min 16, max 16384, step2 8)
 * stores **20000** for a request of 20001 and **-32** for -33. Clamping here
 * would predict 16384 and 16, miss both, and report two applied writes as
 * refused — the very failure this module exists to prevent, and one the
 * min-anchored model had too. The standalone `clamp` reading below still covers
 * the paths that DO clamp.
 */
function snapIntNoClamp(value, { step2, min }) {
  if (!isFiniteNumber(step2) || step2 <= 0) return null;
  let out;
  if (step2 === 1) {
    out = Math.round(value);
  } else {
    const offset = (min ?? 0) % step2;
    out = Math.round((value - offset) / step2) * step2 + offset;
  }
  return Number.isFinite(out) ? out : null;
}

/**
 * The pre-`step2` reading: a min-anchored grid taken from `step` alone. Kept for
 * older frontends and for pack-injected steps (#1533) that carry no `round`.
 */
function snapLegacy(value, { min, max, step }) {
  const base = min ?? 0;
  let out = value;
  if (isFiniteNumber(step) && step > 0) {
    out = base + Math.round((value - base) / step) * step;
  }
  // Snapping can push a value back outside the grid after clamping; the widget
  // clamps last, so mirror that order rather than re-snapping.
  return clampTo(out, min, max);
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
  const { min, max, step, step2, round, precision } = cfg;
  if (min === null && max === null && step === null && step2 === null && round === null) return null;

  const bounds = [min !== null ? `min ${min}` : null, max !== null ? `max ${max}` : null].filter(
    Boolean,
  );
  const describe = (why, grid) => ({
    rule: [why, ...bounds].join(", "),
    min,
    max,
    step: grid,
  });

  // EXACTLY ONE grid reading is admissible, chosen the way the frontend chooses
  // its callback — `round` present means `onFloatValueChange` ran, and nothing
  // else can have. Offering every reading at once is how a tolerance gets in by
  // the back door: measured over 428 adversarial non-normalizations on the live
  // corpus, an any-candidate-may-match explainer accepted 8 outright REVERTS,
  // because a float widget's unrelated drag step happens to reproduce the value
  // the widget fell back to. Tiering drops that to 0 while still explaining all
  // 74 real quantizations. Every one of those 8 is a write the caller would have
  // been told applied when it had not — the one direction this module must never
  // get wrong.
  const candidates = [];
  if (round !== null) {
    // The frontend's FLOAT path — `onFloatValueChange`.
    const digits = precision ?? Math.max(0, -Math.floor(Math.log10(round)));
    candidates.push({
      value: () => snapFloat(expected, cfg),
      why: `round ${round}${Number.isInteger(digits) ? ` at ${digits} dp` : ""}`,
      grid: round,
    });
  } else if (step2 !== null && precision > 0) {
    // A widget carrying `step2` and a NON-ZERO precision but no `round` is a
    // FLOAT whose rounding is switched off (`Comfy.DisableFloatRounding`), not an
    // integer. `onFloatValueChange` then stores the value UNCHANGED — so no grid
    // explains a change here, and only the clamp reading below may speak.
    //
    // Deliberately NO fall-through to the `step` readings: an else-if chain hands
    // a blocked tier to the NEXT tier, and that is worse than the int reading it
    // replaced. Simulated over the corpus with `round` stripped, counting genuine
    // drifts wrongly explained: origin/main 58, int reading 40, falling through to
    // `step` 58, this branch **1**. Measuring the obvious guard is the only reason
    // this is not the obvious guard.
  } else if (step2 !== null) {
    // The frontend's INT path — `onValueChange`.
    const offset = step2 === 1 ? 0 : (min ?? 0) % step2;
    candidates.push({
      value: () => snapIntNoClamp(expected, cfg),
      why: step2 === 1 ? "whole numbers (step 1)" : `step ${step2} offset ${offset}`,
      grid: step2,
    });
  } else if (step !== null && step > 0) {
    // Pre-`step2` builds and pack-injected steps (#1533): the declared `step`, and
    // the historical drag-step-is-10x reading of that SAME declared value.
    candidates.push({ value: () => snapLegacy(expected, cfg), why: `step ${step}`, grid: step });
    candidates.push({
      value: () => snapLegacy(expected, { ...cfg, step: step / 10 }),
      why: `step ${step / 10} (declared step ${step})`,
      grid: step / 10,
    });
  }
  // Pure clamping, with no grid at all.
  candidates.push({
    value: () => snapLegacy(expected, { ...cfg, step: null }),
    why: "clamp",
    grid: null,
  });

  for (const c of candidates) {
    const produced = c.value();
    // Strict equality, deliberately. See the header: the fix for the float case
    // was to compute the frontend's number exactly, never to widen the compare.
    if (produced !== null && produced === actual) return describe(c.why, c.grid);
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
