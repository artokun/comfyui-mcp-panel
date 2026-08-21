// panel#805 — panel_set_widget reported FAILURE for a write that succeeded.
//
//   Widget "max_tokens" on node 1 (OllamaTextDescriber) did not retain the
//   requested value: wrote 4096 but it became 4097.
//
// The mutation happened; the widget snapped the value onto its own declared grid.
// The verification step was a strict `actual === expected`, so normal quantization
// read as a failed write — and "did not retain" invites a retry that normalizes
// identically forever.
//
// The rule these tests pin: ONLY a value the widget's own config explains EXACTLY
// counts as normalization. No tolerance — a tolerance eventually swallows a real
// revert that happens to land nearby.

import assert from "node:assert/strict";
import test from "node:test";

import {
  explainNumericNormalization,
  normalizationNote,
} from "../../web/js/lib/widget-normalization.js";

const widget = (options) => ({ name: "max_tokens", options });

test("#805 the reporter's exact numbers are explained by the declared grid", () => {
  // min 1, step 2 snaps 4096 -> 4097 and 8192 -> 8193, both as reported.
  const w = widget({ min: 1, max: 16384, step: 2 });
  const a = explainNumericNormalization(4096, 4097, w);
  assert.ok(a, "4096 -> 4097 must be recognised as normalization");
  assert.match(a.rule, /step 2/);
  const b = explainNumericNormalization(8192, 8193, w);
  assert.ok(b, "8192 -> 8193 must be recognised too");
});

test("#805 an UNEXPLAINED value stays a failure", () => {
  // The whole safety of this change is that it never guesses. A widget that
  // reverted to something the grid does not produce is still a failed write.
  const w = widget({ min: 1, max: 16384, step: 2 });
  assert.equal(explainNumericNormalization(4096, 512, w), null);
  assert.equal(explainNumericNormalization(4096, 4098, w), null, "even one grid step off-grid");
});

test("#805 no declared config means nothing to explain — still a failure", () => {
  assert.equal(explainNumericNormalization(4096, 4097, widget(undefined)), null);
  assert.equal(explainNumericNormalization(4096, 4097, widget({})), null);
  assert.equal(explainNumericNormalization(4096, 4097, null), null);
});

test("#805 clamping to min/max is normalization", () => {
  const w = widget({ min: 1, max: 8192 });
  assert.ok(explainNumericNormalization(99999, 8192, w), "above max clamps");
  assert.ok(explainNumericNormalization(-5, 1, w), "below min clamps");
});

test("#805 the 10x drag-step reading is accepted, because it is DECLARED", () => {
  // ComfyUI INT/FLOAT widgets have carried a drag step ten times the value step,
  // so a widget declaring step 10 can quantize by 1.
  const w = widget({ min: 0, step: 10 });
  const r = explainNumericNormalization(4096.4, 4096, w);
  assert.ok(r, "step/10 = 1 explains the snap");
  assert.match(r.rule, /declared step 10/);
});

test("#805 non-numeric and equal values are never called normalization", () => {
  const w = widget({ min: 1, step: 2 });
  assert.equal(explainNumericNormalization("a", "b", w), null);
  assert.equal(explainNumericNormalization(4096, "4097", w), null);
  assert.equal(explainNumericNormalization(NaN, 1, w), null);
  assert.equal(explainNumericNormalization(4097, 4097, w), null, "equal is not a normalization");
});

test("#805 the note leads with APPLIED, not with 'did not retain'", () => {
  // The old message's first clause was "did not retain the requested value",
  // whose natural response is a retry that will normalize the same way forever.
  const note = normalizationNote({ name: "max_tokens", requested: 4096, actual: 4097, rule: "step 2, min 1" });
  assert.match(note, /was set and the node normalized the value/);
  assert.match(note, /The write APPLIED/);
  assert.match(note, /not a failed write/);
  assert.match(note, /Use 4097 as the value from here on/);
  assert.doesNotMatch(note, /did not retain/);
});

test("#805 WIRING: normalization suppresses the failure AND is disclosed on the result", async () => {
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/lib/widget-write.js"),
    "utf8",
  )
  assert.match(src, /import \{ explainNumericNormalization, normalizationNote \} from "\.\/widget-normalization\.js"/)
  // The failure branch must be gated on it — otherwise a normalized write still errors.
  // `valueWidget` is the widget the write ASSIGNED (comfyui-mcp#1707): the node's own
  // widget, the promoted inner widget, or — on an instance-scoped promoted write — the
  // wrapper's own rail. The read-back and the normalization explanation must be taken
  // from the SAME widget, or a normalizing rail is reported as a failed write.
  assert.match(src, /const normalization = matchesExpected\(valueWidget\.value\)/)
  assert.match(src, /explainNumericNormalization\(expected, valueWidget\.value, valueWidget\)/)
  assert.match(src, /if \(!matchesExpected\(valueWidget\.value\) && !normalization\) \{/)
  // …and the caller must be TOLD, or a silently-changed value is its own defect.
  assert.match(src, /normalized: true/)
  assert.match(src, /requested_value: expected/)
  assert.match(src, /normalization_note: normalizationNote\(/)
})

// ---------------------------------------------------------------------------
// comfyui-mcp#1130 (recurrence, 2026-08-21) — the same failure on a FLOAT grid.
//
//   panel_set_widget AdjustContrast.factor = 1.12 → widget stored 1.1
//   → "did not retain the requested value"
//
// Every widget config and every stored value below was MEASURED on the live rig
// (ComfyUI 0.33.2 / frontend 1.49.6) by creating the real node, assigning the
// request and invoking the widget's own callback — the same two steps
// applyWidgetWrite performs. None of them is derived from the code under test.
//
// The frontend's number widget has TWO callbacks and they share no term:
//
//   onValueChange (INT)     t = options.step2 || 1
//                           t === 1 ? Math.round(e)
//                                   : Math.round((e - min % t) / t) * t + min % t
//   onFloatValueChange      t = options.round
//                           r = Math.round(e / t) * t
//                           clamp(Number(r.toFixed(precision)), min, max)
//
// The first fix modelled only the integer one, min-anchored, from `step`.
// ---------------------------------------------------------------------------

// AdjustContrast declares `{ default: 1, min: 0, max: 2 }` and NO step at all,
// so the frontend fills in the rest.
const ADJUST_CONTRAST_FACTOR = { min: 0, max: 2, step: 5, step2: 0.5, round: 0.1, precision: 1 };

test("#1130 the reporter's exact case: 1.12 -> 1.1 is the widget's own grid, not a failed write", () => {
  const w = widget(ADJUST_CONTRAST_FACTOR);
  const r = explainNumericNormalization(1.12, 1.1, w);
  assert.ok(r, "AdjustContrast.factor 1.12 -> 1.1 must be recognised as normalization");
  assert.match(r.rule, /round 0\.1/);
});

test("#1130 the float grid is `round`, and NEITHER reading of `step` is it", () => {
  // This is the whole miss. `step` is 5 and the 10x reading of it is 0.5; the
  // grid that produced 1.1 is `round` = 0.1. Pin it by asserting the values the
  // OLD model would have produced are still refused — 1.12 on a step-5 grid
  // gives 0, on a 0.5 grid gives 1.0.
  const w = widget(ADJUST_CONTRAST_FACTOR);
  assert.equal(explainNumericNormalization(1.12, 0, w), null, "step 5 is not the grid");
  assert.equal(explainNumericNormalization(1.12, 1, w), null, "step 0.5 is not the grid either");
});

test("#1130 the float grid is anchored at ZERO, not at min", () => {
  // The anchor is usually invisible — `toFixed(precision)` re-rounds onto the
  // zero grid and hides it — so these are the requests where it is NOT, found by
  // sweeping the two models against each other and then MEASURED on the rig.
  // Each pair is (what the widget stored, what a min-anchored model predicts).
  const std = widget({ min: 0.001, max: 1, step: 5, step2: 0.5, round: 0.1, precision: 1 });
  assert.ok(explainNumericNormalization(0.0500223, 0.1, std), "measured: 0.0500223 stores 0.1");
  assert.equal(explainNumericNormalization(0.0500223, 0.001, std), null, "min-anchored says 0.001 — it never happened");

  const duration = widget({ min: 0.01, max: 2048, step: 5, step2: 0.5, round: 0.1, precision: 1 });
  assert.ok(explainNumericNormalization(0.05137, 0.1, duration), "measured: 0.05137 stores 0.1");
  assert.equal(explainNumericNormalization(0.05137, 0.01, duration), null, "min-anchored says 0.01");

  const alpha = widget({ min: -10000, max: 10000, step: 1, step2: 0.1, round: 0.01, precision: 1 });
  assert.ok(explainNumericNormalization(-9999.554863, -9999.6, alpha), "measured: -9999.554863 stores -9999.6");
  assert.equal(explainNumericNormalization(-9999.554863, -9999.5, alpha), null, "min-anchored says -9999.5");
});

test("#1130 `toFixed(precision)` is arithmetic, not presentation", () => {
  // KSampler.cfg declares step 0.1 → round 0.01, precision 1. Measured: 7.777
  // stores 7.8, NOT the 7.78 the grid alone gives. A model without the toFixed
  // term cannot produce this number at all.
  const w = widget({ min: 0, max: 100, step: 1, step2: 0.1, round: 0.01, precision: 1 });
  assert.ok(explainNumericNormalization(7.777, 7.8, w), "7.777 -> 7.8 (round 0.01 then 1 dp)");
  assert.equal(explainNumericNormalization(7.777, 7.78, w), null, "the un-fixed grid value never happened");
  assert.ok(explainNumericNormalization(8.06, 8.1, w), "8.06 -> 8.1, measured");
});

test("#1130 the fix is exactness, NOT a tolerance — the raw product is refused", () => {
  // `Math.round(0.3381 / 0.1) * 0.1` leaves 0.30000000000000004; the frontend's
  // toFixed makes it the exact double 0.3. Those two differ by 5.5e-17 and only
  // ONE of them is what the widget stored. If this assertion ever fails, an
  // epsilon has crept in — and an epsilon here accepts writes that never landed.
  const w = widget({ min: 0.001, max: 1, step: 5, step2: 0.5, round: 0.1, precision: 1 });
  assert.notEqual(0.30000000000000004, 0.3);
  assert.equal(explainNumericNormalization(0.3381, 0.30000000000000004, w), null);
  assert.ok(explainNumericNormalization(0.3381, 0.3, w));
});

test("#1130 negative values quantize on the same zero-anchored grid", () => {
  // StereoImageNode.stereo_balance, measured: -0.91629 stores -0.92.
  const w = widget({ min: -0.95, max: 0.95, step: 0.5, step2: 0.05, round: 0.01, precision: 2 });
  assert.ok(explainNumericNormalization(-0.91629, -0.92, w));
  // LoraLoader.strength_model, measured: 0.755 stores 0.76.
  const lora = widget({ min: -100, max: 100, step: 0.1, step2: 0.01, round: 0.01, precision: 2 });
  assert.ok(explainNumericNormalization(0.755, 0.76, lora));
});

test("#1130 the INT callback's min-OFFSET anchor is still explained on a modern build", () => {
  // #805's own numbers, in the shape a current frontend actually presents them:
  // a declared `step: 64, min: 1` arrives as step 640 / step2 64, and the
  // callback anchors at `min % step2` = 1. 2048 -> 2049 and 4096 -> 4097.
  const w = widget({ min: 1, max: 1000000000, step: 640, step2: 64, precision: 0 });
  const a = explainNumericNormalization(2048, 2049, w);
  assert.ok(a, "2048 -> 2049 (= 1 + 32*64)");
  assert.match(a.rule, /step 64/);
  assert.ok(explainNumericNormalization(4096, 4097, w), "4096 -> 4097");
  // EmptyLatentImage.width, measured: min 16, step2 8 — 1281 stores 1280.
  assert.ok(
    explainNumericNormalization(1281, 1280, widget({ min: 16, max: 16384, step: 80, step2: 8, precision: 0 })),
  );
  // KSampler.steps, measured: step2 1 — 20.4 stores 20.
  assert.ok(explainNumericNormalization(20.4, 20, widget({ min: 1, max: 10000, step: 10, step2: 1, precision: 0 })));
});

test("#1130 REVERSE: a genuine revert is still a failed write", () => {
  const w = widget(ADJUST_CONTRAST_FACTOR);
  assert.equal(explainNumericNormalization(1.12, 1, w), null, "reverted to its default 1.0");
  assert.equal(explainNumericNormalization(1.12, 0, w), null, "reverted to min");
  assert.equal(explainNumericNormalization(1.12, 1.2, w), null, "one grid step off");
  assert.equal(explainNumericNormalization(1.12, 1.14, w), null, "a value the grid cannot produce");
  assert.equal(
    explainNumericNormalization(1.12, 1.1000000001, w),
    null,
    "a near-miss the widget never stored is not 'close enough'",
  );
});

test("#1130 REVERSE: only the callback the config selects may explain the value", () => {
  // Measured on the rig: ThinkingLLM_QwenVL_Advanced.temperature (min 0.1,
  // round 0.1, step2 0.5, default 0.6) stores 0.4 for a request of 0.4371.
  // A widget that instead REVERTED to its 0.6 default must stay a failure — and
  // it did not, before this change: 0.6 is exactly what the unrelated `step2`
  // 0.5 grid produces from 0.4371, so an explainer that tries every reading at
  // once reports a write that never landed as normalized. Offering one reading
  // per config is what makes the optimistic direction safe.
  const w = widget({ min: 0.1, max: 1, step: 5, step2: 0.5, round: 0.1, precision: 1 });
  assert.ok(explainNumericNormalization(0.4371, 0.4, w), "the round-0.1 grid is what ran");
  assert.equal(explainNumericNormalization(0.4371, 0.6, w), null, "a revert to the default is NOT normalization");
  // Same shape, another measured case from that sweep: PrimitiveFloat.value.
  const primitiveFloat = widget({ step: 1, step2: 1, round: 0.1, precision: 1 });
  assert.ok(explainNumericNormalization(0.3371, 0.3, primitiveFloat));
  assert.equal(explainNumericNormalization(0.3371, 0, primitiveFloat), null, "a revert to 0 is NOT normalization");
});

// ---- WIRING: the real applyWidgetWrite path, driven by the frontend's own
// callback rather than a stand-in for it. ------------------------------------

// Transcribed from the running build (frontend 1.49.6), `NumberWidget`'s
// onFloatValueChange. Kept verbatim so the test cannot drift into agreeing with
// the module by construction.
function onFloatValueChange(v) {
  const t = this.options.round;
  if (t) {
    const n = this.options.precision ?? Math.max(0, -Math.floor(Math.log10(t)));
    const r = Math.round(v / t) * t;
    this.value = Math.min(
      Math.max(Number(r.toFixed(n)), this.options.min ?? -Infinity),
      this.options.max ?? Infinity,
    );
  } else {
    this.value = v;
  }
}

test("#1130 WIRING: a float-quantized write comes back as a SUCCESS through applyWidgetWrite", async () => {
  const { applyWidgetWrite } = await import("../../web/js/lib/widget-write.js");
  const factor = {
    name: "factor",
    type: "number",
    value: 1,
    options: { ...ADJUST_CONTRAST_FACTOR },
    callback: onFloatValueChange,
  };
  const node = { id: 7, type: "AdjustContrast", widgets: [factor] };
  const set = applyWidgetWrite(node, "factor", 1.12, {});
  assert.equal(factor.value, 1.1, "the canvas holds the quantized value");
  assert.equal(set.value, 1.1);
  assert.equal(set.normalized, true, "reported as normalization, not as a failed write");
  assert.equal(set.requested_value, 1.12);
  assert.match(set.normalization_rule, /round 0\.1/);
  assert.match(set.normalization_note, /The write APPLIED/);
  assert.doesNotMatch(set.normalization_note, /did not retain/);
});

test("#1130 WIRING: a write the widget REFUSED still fails and still rolls back", async () => {
  const { applyWidgetWrite, WidgetWriteError } = await import("../../web/js/lib/widget-write.js");
  const factor = {
    name: "factor",
    type: "number",
    value: 1,
    options: { ...ADJUST_CONTRAST_FACTOR },
    // The honest-failure case: a node that snaps the value back to its default.
    // 1.0 is ALSO what this widget's unrelated step2 grid produces from 1.12, so
    // this is the exact write an over-broad explainer would call a success.
    callback() {
      this.value = 1;
    },
  };
  const node = { id: 7, type: "AdjustContrast", widgets: [factor] };
  assert.throws(
    () => applyWidgetWrite(node, "factor", 1.12, {}),
    (err) => err instanceof WidgetWriteError && /did not retain the requested value/.test(err.message),
  );
  assert.equal(factor.value, 1, "rolled back to the prior value");
});

test("#1130 the INT callback does NOT clamp on the panel's write path", () => {
  // applyWidgetWrite assigns `widget.value` and invokes the callback directly,
  // so `NumberWidget.setValue`'s clamp never runs. Measured on the rig:
  // EmptyLatentImage.width (min 16, max 16384, step2 8) stores 20000 for 20001
  // and -32 for -33 — NOT 16384 and 16. A model that clamps here reports both
  // of those applied writes as refused.
  const w = widget({ min: 16, max: 16384, step: 80, step2: 8, precision: 0 });
  assert.ok(explainNumericNormalization(20001, 20000, w), "above max: snapped, not clamped");
  assert.ok(explainNumericNormalization(-33, -32, w), "below min: snapped, not clamped");
  // KSampler.steps (step2 1, max 10000), measured: 20001.4 stores 20001.
  assert.ok(explainNumericNormalization(20001.4, 20001, widget({ min: 1, max: 10000, step: 10, step2: 1, precision: 0 })));
  // The FLOAT callback is the one that DOES clamp, and it still must.
  // AdjustContrast.factor, measured: 7.77 stores 2 and -3.33 stores 0.
  const f = widget(ADJUST_CONTRAST_FACTOR);
  assert.ok(explainNumericNormalization(7.77, 2, f), "float clamps to max");
  assert.ok(explainNumericNormalization(-3.33, 0, f), "float clamps to min");
});

test("#1130 a FLOAT widget with rounding DISABLED is not mistaken for an integer", () => {
  // grok's residual on PR #1550. With `Comfy.DisableFloatRounding` the frontend
  // leaves `round` unset; `onFloatValueChange` then stores the value UNCHANGED,
  // so the explainer is only ever reached when something else moved it — a
  // genuine drift. The config that remains is shape-identical to an integer's,
  // and the int grid would happily "explain" that drift.
  //
  // AdjustContrast.factor's measured options, minus `round`.
  const w = widget({ min: 0, max: 2, step: 5, step2: 0.5, precision: 1 });
  assert.equal(explainNumericNormalization(1.12, 1, w), null, "1.0 is the step2 0.5 grid — but that grid never ran");
  assert.equal(explainNumericNormalization(1.12, 1.5, w), null);
  assert.equal(explainNumericNormalization(1.12, 0, w), null, "and it must not fall through to the `step` readings either");
  // Clamping still applies — it is the one thing that happens regardless.
  assert.ok(explainNumericNormalization(7.77, 2, w), "above max still clamps");
  assert.ok(explainNumericNormalization(-3.33, 0, w), "below min still clamps");
  // A real INT widget (precision 0) is untouched by the guard.
  assert.ok(explainNumericNormalization(1281, 1280, widget({ min: 16, max: 16384, step: 80, step2: 8, precision: 0 })));
  // …and so is a widget with no precision at all (older builds, injected steps).
  assert.ok(explainNumericNormalization(1281, 1280, widget({ min: 16, max: 16384, step2: 8 })));
});
