/**
 * Unit tests for web/js/lib/control-after-generate.js (#558) — run with `node --test`.
 *
 * control_after_generate SILENTLY rewrites a seed/INT/COMBO value after each
 * generation, and the ComfyUI frontend adds it as a serialize:false/canvasOnly
 * widget that renders UNASSOCIATED from the seed it governs — so a value the agent
 * explicitly set never holds, with nothing in the read/write surface revealing it.
 * These tests pin the detection that summarizeNode / graph_outline / runSetWidget use.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTROL_AFTER_GENERATE_MODES,
  isControlAfterGenerateWidget,
  controlAfterGenerateEntries,
  controlAfterGenerateModes,
  controlEntryForWidget,
  controlAfterGenerateWarning,
} from "../../web/js/lib/control-after-generate.js";

// A KSampler-shaped node: seed value widget followed by its control combo, exactly
// as the ComfyUI frontend builds it (control widget serialize:false/canvasOnly).
function seedNode(mode = "randomize", { linked = true, prefix = "" } = {}) {
  const seed = { name: "seed", type: "INT", value: 777777 };
  const control = {
    name: `${prefix}control_after_generate`,
    type: "combo",
    value: mode,
    options: { values: [...CONTROL_AFTER_GENERATE_MODES], serialize: false, canvasOnly: true },
  };
  if (linked) seed.linkedWidgets = [control];
  return { id: 30, type: "KSampler", widgets: [seed, control, { name: "steps", type: "INT", value: 20 }] };
}

test("detects the control_after_generate combo by name + option shape", () => {
  const { widgets } = seedNode("randomize");
  assert.equal(isControlAfterGenerateWidget(widgets[1]), true);
  assert.equal(isControlAfterGenerateWidget(widgets[0]), false); // the seed itself
  assert.equal(isControlAfterGenerateWidget({ name: "sampler", options: { values: ["euler"] } }), false);
});

test("detection requires BOTH control markers (serialize:false AND canvasOnly:true) plus the mode options", () => {
  // No marker at all (an unrelated combo that merely shares the option strings) ⇒ NOT a control.
  assert.equal(
    isControlAfterGenerateWidget({ name: "mode", type: "combo", options: { values: [...CONTROL_AFTER_GENERATE_MODES] } }),
    false,
  );
  // Only ONE marker (serialize:false, no canvasOnly) ⇒ NOT a control (P2 false-positive guard).
  assert.equal(
    isControlAfterGenerateWidget({ name: "mode", options: { values: [...CONTROL_AFTER_GENERATE_MODES], serialize: false } }),
    false,
  );
  // Only canvasOnly, no serialize:false ⇒ NOT a control.
  assert.equal(
    isControlAfterGenerateWidget({ name: "mode", options: { values: [...CONTROL_AFTER_GENERATE_MODES], canvasOnly: true } }),
    false,
  );
  // BOTH markers present but options are NOT the modes ⇒ NOT a control.
  assert.equal(
    isControlAfterGenerateWidget({ name: "x", options: { values: ["a", "b"], serialize: false, canvasOnly: true } }),
    false,
  );
  // BOTH markers AND the mode options ⇒ detected (the real frontend shape).
  assert.equal(
    isControlAfterGenerateWidget({
      name: "control_after_generate",
      type: "combo",
      value: "increment",
      options: { values: [...CONTROL_AFTER_GENERATE_MODES], serialize: false, canvasOnly: true },
    }),
    true,
  );
});

test("associates the mode with the seed via linkedWidgets", () => {
  const node = seedNode("randomize", { linked: true });
  assert.deepEqual(controlAfterGenerateModes(node), { seed: "randomize" });
  const entries = controlAfterGenerateEntries(node);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], { widget: "seed", control: "control_after_generate", mode: "randomize" });
});

test("associates the mode with the seed by POSITION when linkedWidgets is absent", () => {
  const node = seedNode("increment", { linked: false });
  assert.deepEqual(controlAfterGenerateModes(node), { seed: "increment" });
});

test("handles a control_prefix-renamed control widget", () => {
  const node = seedNode("decrement", { linked: true, prefix: "Base " });
  const entries = controlAfterGenerateEntries(node);
  assert.equal(entries[0].widget, "seed");
  assert.equal(entries[0].mode, "decrement");
  assert.equal(entries[0].control, "Base control_after_generate");
});

test("P2: a combo-governed control with a 5th 'increment-wrap' option IS detected (superset, not exact)", () => {
  // ComfyUI appends 'increment-wrap' when the governed widget is a combo — detection must
  // accept a SUPERSET of the base modes, else a combo-governed control is missed.
  const w = {
    name: "control_after_generate",
    type: "combo",
    value: "increment",
    options: { values: [...CONTROL_AFTER_GENERATE_MODES, "increment-wrap"], serialize: false, canvasOnly: true },
  };
  assert.equal(isControlAfterGenerateWidget(w), true);
});

test("P2: a coincidental mode-option combo WITHOUT the control marker is NOT a control (no false warn)", () => {
  // A plain combo (no serialize:false/canvasOnly) that happens to list the mode strings
  // after a numeric widget must NOT be treated as a control.
  const seed = { name: "seed", type: "INT", value: 5 };
  const combo = {
    name: "mode",
    type: "combo",
    value: "randomize",
    options: { values: [...CONTROL_AFTER_GENERATE_MODES] }, // NO marker
  };
  const node = { id: 60, type: "SomeNode", widgets: [seed, combo] };
  assert.equal(isControlAfterGenerateWidget(combo), false);
  assert.deepEqual(controlAfterGenerateModes(node), {});
  assert.equal(controlAfterGenerateWarning(node, "seed"), null);
});

test("P2: a real control whose predecessor is INELIGIBLE (text) does not attach its mode there", () => {
  const text = { name: "notes", type: "text", value: "hello" };
  const combo = {
    name: "control_after_generate",
    type: "combo",
    value: "randomize",
    options: { values: [...CONTROL_AFTER_GENERATE_MODES], serialize: false, canvasOnly: true },
  };
  const node = { id: 62, type: "SomeNode", widgets: [text, combo] };
  assert.equal(controlAfterGenerateWarning(node, "notes"), null);
  assert.deepEqual(controlAfterGenerateModes(node), { control_after_generate: "randomize" }); // self-keyed display
});

test("P2: an ELIGIBLE numeric predecessor IS associated (real seed still detected)", () => {
  const seed = { name: "seed", type: "INT", value: 5 };
  const combo = {
    name: "control_after_generate",
    type: "combo",
    value: "randomize",
    options: { values: [...CONTROL_AFTER_GENERATE_MODES], serialize: false, canvasOnly: true },
  };
  const node = { id: 61, type: "KSampler", widgets: [seed, combo] }; // no linkedWidgets
  assert.deepEqual(controlAfterGenerateModes(node), { seed: "randomize" });
  assert.match(controlAfterGenerateWarning(node, "seed"), /randomize/);
});

test("P1: detection is SIDE-EFFECT-FREE — a function-valued options list is NOT invoked (and not classified)", () => {
  // A real control combo always has a STATIC array; detection must never invoke a dynamic
  // values() (it runs AFTER a write is verified and could mutate the graph). Prove the
  // function is NEVER called and such a widget is not treated as a control.
  let called = false;
  const w = {
    name: "seed_control",
    type: "combo",
    value: "randomize",
    options: {
      values: () => {
        called = true;
        return [...CONTROL_AFTER_GENERATE_MODES];
      },
      serialize: false,
      canvasOnly: true,
    },
  };
  assert.equal(isControlAfterGenerateWidget(w), false);
  assert.equal(called, false, "detection must NOT invoke the dynamic values() callback");
});

test("P1: a side-effecting values() on a marker-qualified widget cannot change a written value via detection", () => {
  // Even if a widget carries both markers and a mode-returning function, detection does not
  // invoke it, so entries/warning never trigger the side effect.
  const seed = { name: "seed", type: "INT", value: 77 };
  let sideEffectFired = false;
  const control = {
    name: "control_after_generate",
    type: "combo",
    value: "randomize",
    options: {
      values: () => {
        sideEffectFired = true;
        seed.value = 0; // malicious side effect
        return [...CONTROL_AFTER_GENERATE_MODES];
      },
      serialize: false,
      canvasOnly: true,
    },
  };
  seed.linkedWidgets = [control];
  const node = { id: 70, type: "KSampler", widgets: [seed, control] };
  // Reading entries / computing the warning must not fire the side effect nor change seed.
  controlAfterGenerateModes(node);
  controlAfterGenerateWarning(node, "seed");
  assert.equal(sideEffectFired, false);
  assert.equal(seed.value, 77, "the written seed value must be untouched by detection");
});

test("P1: a control widget with an ARBITRARY name (not 'control_after_generate') is still detected", () => {
  // ComfyUI lets a node def name the control widget freely; detection is by marker +
  // option shape, not name — otherwise a governed seed writes with NO warning.
  const seed = { name: "seed", type: "INT", value: 5 };
  const control = {
    name: "seed_behavior",
    type: "combo",
    value: "randomize",
    options: { values: [...CONTROL_AFTER_GENERATE_MODES], serialize: false, canvasOnly: true },
  };
  seed.linkedWidgets = [control];
  const node = { id: 31, type: "CustomSampler", widgets: [seed, control] };
  assert.equal(isControlAfterGenerateWidget(control), true);
  assert.deepEqual(controlAfterGenerateModes(node), { seed: "randomize" });
  const warn = controlAfterGenerateWarning(node, "seed");
  assert.match(warn, /control_after_generate='randomize'/);
  assert.match(warn, /widget='seed_behavior'/); // points at the ACTUAL control widget name
});

test("controlEntryForWidget matches the governed widget case-insensitively; returns null otherwise", () => {
  const node = seedNode("randomize");
  assert.equal(controlEntryForWidget(node, "seed").mode, "randomize");
  assert.equal(controlEntryForWidget(node, "SEED").mode, "randomize");
  assert.equal(controlEntryForWidget(node, "steps"), null);
  assert.equal(controlEntryForWidget(node, "control_after_generate"), null); // the control widget itself
});

test("warning fires for a NON-fixed mode and points at the control widget + fix", () => {
  const warn = controlAfterGenerateWarning(seedNode("randomize"), "seed");
  assert.match(warn, /control_after_generate='randomize'/);
  assert.match(warn, /automatically CHANGES this value/);
  assert.match(warn, /new random value each run/);
  assert.match(warn, /will NOT persist/);
  assert.match(warn, /'fixed'/);
  assert.match(warn, /widget='control_after_generate'/);
});

test("warning is MODE-ACCURATE: increment/decrement are deterministic, not 're-rolled'", () => {
  const inc = controlAfterGenerateWarning(seedNode("increment"), "seed");
  assert.match(inc, /increased by 1 each run/);
  assert.doesNotMatch(inc, /random/);
  const dec = controlAfterGenerateWarning(seedNode("decrement"), "seed");
  assert.match(dec, /decreased by 1 each run/);
});

test("NO warning when the mode is 'fixed' (the value will hold)", () => {
  assert.equal(controlAfterGenerateWarning(seedNode("fixed"), "seed"), null);
});

test("NO warning when writing an unrelated widget (steps)", () => {
  assert.equal(controlAfterGenerateWarning(seedNode("randomize"), "steps"), null);
});

test("NO warning when writing the control widget itself (it changes the MODE, not a governed value)", () => {
  // Normal node: control governs seed → writing 'control_after_generate' matches no
  // governed entry.
  assert.equal(controlAfterGenerateWarning(seedNode("randomize"), "control_after_generate"), null);
});

test("NO false warning for an ORPHAN control widget with no governed value widget", () => {
  // A control combo with no linked/predecessor value widget keys on itself for DISPLAY,
  // but writing it must not warn that it 'governs itself'.
  const orphan = {
    name: "control_after_generate",
    type: "combo",
    value: "randomize",
    options: { values: [...CONTROL_AFTER_GENERATE_MODES], serialize: false, canvasOnly: true },
  };
  const node = { id: 12, type: "Weird", widgets: [orphan] }; // control is the FIRST widget
  assert.equal(controlEntryForWidget(node, "control_after_generate"), null);
  assert.equal(controlAfterGenerateWarning(node, "control_after_generate"), null);
});

test("two seed widgets (seed + noise_seed) each get their own association", () => {
  const seed = { name: "seed", type: "INT", value: 1 };
  const c1 = { name: "control_after_generate", type: "combo", value: "randomize", options: { values: [...CONTROL_AFTER_GENERATE_MODES], serialize: false, canvasOnly: true } };
  const noise = { name: "noise_seed", type: "INT", value: 2 };
  const c2 = { name: "control_after_generate", type: "combo", value: "fixed", options: { values: [...CONTROL_AFTER_GENERATE_MODES], serialize: false, canvasOnly: true } };
  seed.linkedWidgets = [c1];
  noise.linkedWidgets = [c2];
  const node = { id: 9, type: "SamplerCustom", widgets: [seed, c1, noise, c2] };
  assert.deepEqual(controlAfterGenerateModes(node), { seed: "randomize", noise_seed: "fixed" });
});

test("a node with no control widget yields no entries", () => {
  const node = { id: 5, type: "CLIPTextEncode", widgets: [{ name: "text", value: "hi" }] };
  assert.deepEqual(controlAfterGenerateModes(node), {});
  assert.deepEqual(controlAfterGenerateEntries(node), []);
});
