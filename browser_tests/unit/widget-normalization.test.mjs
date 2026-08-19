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
