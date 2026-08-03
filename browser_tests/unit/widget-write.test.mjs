/**
 * Unit tests for web/js/lib/widget-write.js — run with `node --test`.
 *
 * These drive applyWidgetWrite(), the SAME function graph_set_widget delegates
 * to (resolve target → validate/coerce → write + callback → verify stuck), so
 * the handler's real code path is exercised — not a parallel reimplementation.
 *
 * Covers the graph_set_widget integrity fixes:
 *   #233 — a PROMOTED subgraph widget resolves to the correct INNER widget (even
 *          when the promotion was RENAMED), leaves inner neighbours untouched,
 *          rejects a non-numeric value into a numeric slot, and NEVER falls back
 *          to the shifted parent slot when the promotion can't be resolved.
 *   #240 — a COMBO widget is set by EXACT value; invalid / index / unreadable-
 *          option-list cases are rejected, never silently coerced.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyWidgetWrite,
  coerceWidgetValue,
  comboOptions,
  isComboWidget,
  isCompositeObjectWidget,
  isNumericWidget,
  resolvePromotedInnerTarget,
  WidgetWriteError,
} from "../../web/js/lib/widget-write.js";

// No-op graph hooks so applyWidgetWrite exercises the full write path.
const HOOKS = {};

// ---- #347: empty-string clear vs missing value -----------------------------

test("#347: a text/string widget can be CLEARED with an explicit empty string", () => {
  for (const type of ["customtext", "text", "string", undefined]) {
    const node = {
      id: 39,
      type: "Florence2Run",
      widgets: [{ name: "text_input", type, value: "some prompt" }],
    };
    const set = applyWidgetWrite(node, "text_input", "", HOOKS);
    assert.equal(set.value, "");
    assert.equal(node.widgets[0].value, "");
  }
});

test("#347: a MISSING value (undefined/null) is refused, not silently written", () => {
  const w = { name: "text_input", type: "customtext", value: "x" };
  assert.throws(() => coerceWidgetValue(w, undefined), /No value provided/);
  assert.throws(() => coerceWidgetValue(w, null), /No value provided/);
});

test("#347: clearing to '' does NOT weaken combo/numeric strictness (#240)", () => {
  const combo = { name: "sampler", options: { values: ["euler", "dpmpp_2m"] } };
  assert.throws(() => coerceWidgetValue(combo, ""), WidgetWriteError);
  const num = { name: "steps", type: "INT", value: 20 };
  assert.throws(() => coerceWidgetValue(num, ""), /not a number/);
});

test("#524: exact case wins when two widgets differ only by case", () => {
  const backgroundToggle = { name: "Background", type: "BOOLEAN", value: false };
  const backgroundMode = { name: "background", type: "COMBO", options: { values: ["Alpha", "Color"] }, value: "Alpha" };
  const node = { id: 26, type: "ClothesSegment", widgets: [backgroundToggle, backgroundMode] };

  const set = applyWidgetWrite(node, "background", "Color", HOOKS);

  assert.equal(set.widget, "background");
  assert.equal(backgroundMode.value, "Color");
  assert.equal(backgroundToggle.value, false, "must not write the first case-insensitive match");
});

test("#524: ambiguous case-insensitive widget name refuses before mutation", () => {
  const backgroundToggle = { name: "Background", type: "BOOLEAN", value: false };
  const backgroundMode = { name: "background", type: "COMBO", options: { values: ["Alpha", "Color"] }, value: "Alpha" };
  const node = { id: 26, type: "ClothesSegment", widgets: [backgroundToggle, backgroundMode] };

  assert.throws(
    () => applyWidgetWrite(node, "BACKGROUND", "Color", HOOKS),
    /case-insensitively.*Background, background.*exact widget name/i,
  );
  assert.equal(backgroundToggle.value, false);
  assert.equal(backgroundMode.value, "Alpha");
});

test("#524: a unique case-insensitive widget name remains supported", () => {
  const node = { id: 27, type: "Any", widgets: [{ name: "Prompt", type: "STRING", value: "old" }] };
  const set = applyWidgetWrite(node, "prompt", "new", HOOKS);
  assert.equal(set.widget, "Prompt");
  assert.equal(node.widgets[0].value, "new");
});

// ---- #179: rgthree Power Lora Loader composite widget ----------------------

test("#179: a composite lora_N widget is detected by its object value", () => {
  const w = { name: "lora_10", value: { on: false, lora: null, strength: 1 } };
  assert.equal(isCompositeObjectWidget(w), true);
  assert.equal(isCompositeObjectWidget({ name: "text", value: "hello" }), false);
});

test("#179: setting a Power Lora row from a JSON STRING writes the composite object", () => {
  const node = {
    id: 77,
    type: "Power Lora Loader (rgthree)",
    widgets: [
      { name: "lora_10", value: { on: false, lora: null, strength: 1, strengthTwo: null } },
    ],
  };
  const set = applyWidgetWrite(
    node,
    "lora_10",
    '{"on":true,"lora":"some.safetensors","strength":0.6}',
    HOOKS,
  );
  // The lora filename and strength are preserved (not lora:null / strength:1).
  assert.equal(set.value.on, true);
  assert.equal(set.value.lora, "some.safetensors");
  assert.equal(set.value.strength, 0.6);
  // Unspecified field carried over from the prior value.
  assert.equal(set.value.strengthTwo, null);
  assert.equal(node.widgets[0].value.lora, "some.safetensors");
});

test("#179: an rgthree callback that CLONES the object still verifies as stuck", () => {
  const node = {
    id: 78,
    type: "Power Lora Loader (rgthree)",
    widgets: [
      {
        name: "lora_1",
        value: { on: false, lora: null, strength: 1 },
        // rgthree normalizes by replacing the object reference — must not
        // false-fail the write-stuck check.
        callback(v, _canvas, _node) {
          this.value = { ...v };
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "lora_1", '{"on":true,"lora":"x.safetensors","strength":0.8}', {});
  assert.equal(set.value.lora, "x.safetensors");
  assert.equal(node.widgets[0].value.strength, 0.8);
});

test("#179: a callback that DRIFTS a composite field is still caught (not false-pass)", () => {
  const node = {
    id: 80,
    type: "Power Lora Loader (rgthree)",
    widgets: [
      {
        name: "lora_3",
        value: { on: false, lora: null, strength: 1 },
        // Malicious/buggy callback that mutates the object in place to a WRONG
        // value — must be detected as drift (the expected snapshot is taken
        // before the callback), never reported as retained.
        callback(v) {
          v.lora = "WRONG.safetensors";
        },
      },
    ],
  };
  assert.throws(
    () => applyWidgetWrite(node, "lora_3", '{"on":true,"lora":"right.safetensors","strength":1}', {}),
    /did not.*retain/s,
  );
});

test("#179: a non-JSON string for a composite widget is refused, not written raw", () => {
  const node = {
    id: 79,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_2", value: { on: false, lora: null, strength: 1 } }],
  };
  assert.throws(() => applyWidgetWrite(node, "lora_2", "not-json", {}), /not valid JSON/);
});

// ---- #560: scalar-to-composite corruption is REFUSED; sub-field writes MERGE -----

test("#560: a BARE SCALAR to a composite slot is REFUSED, leaving every field intact", () => {
  const node = {
    id: 128,
    type: "Power Lora Loader (rgthree)",
    widgets: [
      { name: "lora_1", value: { on: true, lora: "motion.safetensors", strength: 1, strengthTwo: null } },
    ],
  };
  // The exact #560 repro: value=false must NOT null the lora / clobber the row.
  assert.throws(
    () => applyWidgetWrite(node, "lora_1", false, {}),
    (err) =>
      err instanceof WidgetWriteError &&
      /composite object widget/.test(err.message) &&
      /bare scalar would corrupt it/.test(err.message) &&
      /"lora_1\.on"/.test(err.message), // points at the sub-field syntax
  );
  // The ORIGINAL value survives verbatim — no partial write happened.
  assert.deepEqual(node.widgets[0].value, {
    on: true,
    lora: "motion.safetensors",
    strength: 1,
    strengthTwo: null,
  });
});

test("#560: a sub-field write (lora_1.on=false) MERGES only that field; lora/strength/strengthTwo SURVIVE", () => {
  const node = {
    id: 128,
    type: "Power Lora Loader (rgthree)",
    widgets: [
      { name: "lora_1", value: { on: true, lora: "motion.safetensors", strength: 1, strengthTwo: 0.5 } },
    ],
  };
  const set = applyWidgetWrite(node, "lora_1.on", false, {});
  assert.equal(set.value.on, false);
  // Every OTHER field is preserved — the core anti-corruption assertion.
  assert.equal(node.widgets[0].value.lora, "motion.safetensors");
  assert.equal(node.widgets[0].value.strength, 1);
  assert.equal(node.widgets[0].value.strengthTwo, 0.5);
});

test("#560: a numeric sub-field write (lora_1.strength=0.8) preserves the filename + toggle", () => {
  const node = {
    id: 128,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: "x.safetensors", strength: 1, strengthTwo: null } }],
  };
  const set = applyWidgetWrite(node, "lora_1.strength", 0.8, {});
  assert.equal(set.value.strength, 0.8);
  assert.equal(node.widgets[0].value.lora, "x.safetensors");
  assert.equal(node.widgets[0].value.on, true);
  assert.equal(node.widgets[0].value.strengthTwo, null);
});

test("#560: a string sub-field write (lora_1.lora=name) preserves on/strength", () => {
  const node = {
    id: 128,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: "old.safetensors", strength: 0.7, strengthTwo: null } }],
  };
  const set = applyWidgetWrite(node, "lora_1.lora", "new.safetensors", {});
  assert.equal(set.value.lora, "new.safetensors");
  assert.equal(node.widgets[0].value.on, true);
  assert.equal(node.widgets[0].value.strength, 0.7);
});

test("#560: sub-field addressing on a NON-composite widget FAILS LOUDLY (never a wrong write)", () => {
  const node = { id: 40, type: "KSampler", widgets: [{ name: "seed", type: "INT", value: 5 }] };
  assert.throws(
    () => applyWidgetWrite(node, "seed.on", 9, {}),
    (err) => err instanceof WidgetWriteError && /not a composite object widget/.test(err.message),
  );
  assert.equal(node.widgets[0].value, 5, "the scalar widget must be untouched");
});

test("#560 EXACT-FIRST: a widget whose OWN name contains a dot is targeted exactly, never split", () => {
  // A (contrived) widget literally named "lora.on" must win over a base "lora" split.
  const node = {
    id: 41,
    type: "CustomNode",
    widgets: [
      { name: "lora", value: { on: true, lora: "keep.safetensors", strength: 1 } },
      { name: "lora.on", type: "text", value: "literal" },
    ],
  };
  const set = applyWidgetWrite(node, "lora.on", "written", {});
  assert.equal(set.value, "written");
  assert.equal(node.widgets[1].value, "written");
  // The composite base was NOT touched.
  assert.deepEqual(node.widgets[0].value, { on: true, lora: "keep.safetensors", strength: 1 });
});

test("#560 EMPTY SUFFIX: 'lora_1.' is refused loudly, base is NOT silently written", () => {
  const node = {
    id: 42,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: "a.safetensors", strength: 1 } }],
  };
  assert.throws(
    () => applyWidgetWrite(node, "lora_1.", false, {}),
    (err) => err instanceof WidgetWriteError && /empty sub-field/.test(err.message),
  );
  assert.deepEqual(node.widgets[0].value, { on: true, lora: "a.safetensors", strength: 1 });
});

test("#560: coerceWidgetValue merges a sub-field onto the CURRENT object", () => {
  const w = { name: "lora_1", value: { on: true, lora: "a.safetensors", strength: 1, strengthTwo: null } };
  const merged = coerceWidgetValue(w, false, w, "on");
  assert.deepEqual(merged, { on: false, lora: "a.safetensors", strength: 1, strengthTwo: null });
});

test("#560: a nested sub-field path is refused (no per-node schema to shape it)", () => {
  const w = { name: "lora_1", value: { on: true, lora: "a", strength: 1 } };
  assert.throws(() => coerceWidgetValue(w, 1, w, "a.b"), /Nested sub-field path/);
});

test("#560 HARDEN: a sub-field write to an UNKNOWN field is refused, never ADDED", () => {
  const node = {
    id: 43,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: "a.safetensors", strength: 1, strengthTwo: null } }],
  };
  assert.throws(
    () => applyWidgetWrite(node, "lora_1.strenght", 1, {}), // typo
    (err) => err instanceof WidgetWriteError && /has no field "strenght"/.test(err.message),
  );
  // No junk member was added and the row is unchanged.
  assert.deepEqual(node.widgets[0].value, { on: true, lora: "a.safetensors", strength: 1, strengthTwo: null });
});

test("#560 HARDEN: a boolean-string ('false') for a boolean field COERCES to boolean, not a string", () => {
  const node = {
    id: 44,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: "a.safetensors", strength: 1 } }],
  };
  const set = applyWidgetWrite(node, "lora_1.on", "false", {});
  assert.strictEqual(set.value.on, false); // boolean false, NOT the string "false"
  assert.equal(node.widgets[0].value.lora, "a.safetensors");
});

test("#560 HARDEN: a non-numeric value for a numeric field is refused", () => {
  const node = {
    id: 45,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: "a.safetensors", strength: 1 } }],
  };
  assert.throws(
    () => applyWidgetWrite(node, "lora_1.strength", "loud", {}),
    (err) => err instanceof WidgetWriteError && /is numeric but value/.test(err.message),
  );
  assert.equal(node.widgets[0].value.strength, 1, "unchanged on reject");
});

test("#560 HARDEN: a number into a STRING field (lora filename) is refused", () => {
  const node = {
    id: 46,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: "a.safetensors", strength: 1 } }],
  };
  assert.throws(
    () => applyWidgetWrite(node, "lora_1.lora", 5, {}),
    (err) => err instanceof WidgetWriteError && /is a string but value/.test(err.message),
  );
});

test("#560 HARDEN: a FULL JSON-object write also rejects unknown fields + mistypes (not just dotted)", () => {
  const node = {
    id: 48,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: "a.safetensors", strength: 1, strengthTwo: null } }],
  };
  // Unknown field in the object payload is refused (no junk added).
  assert.throws(
    () => applyWidgetWrite(node, "lora_1", '{"strenght":2}', {}),
    (err) => err instanceof WidgetWriteError && /has no field "strenght"/.test(err.message),
  );
  // A mistyped known field (string into boolean) COERCES rather than storing "false".
  const set = applyWidgetWrite(node, "lora_1", '{"on":"false"}', {});
  assert.strictEqual(set.value.on, false);
  assert.equal(node.widgets[0].value.lora, "a.safetensors");
  assert.equal(node.widgets[0].value.strength, 1);
});

test("#560 P0: a null-valued field ENFORCES its DECLARED type — number into a null `lora` is refused", () => {
  // Empty rgthree row: lora/strengthTwo are null. Type must come from the schema, NOT
  // the (null) current value — otherwise a wrong-typed scalar is silently accepted.
  const node = {
    id: 50,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: null, strength: 1, strengthTwo: null } }],
  };
  assert.throws(
    () => applyWidgetWrite(node, "lora_1.lora", 5, {}), // number into string|null field
    (err) => err instanceof WidgetWriteError && /is a string but value/.test(err.message),
  );
  assert.throws(
    () => applyWidgetWrite(node, "lora_1", '{"strengthTwo":"bad"}', {}), // string into number|null
    (err) => err instanceof WidgetWriteError && /is numeric but value/.test(err.message),
  );
  assert.deepEqual(node.widgets[0].value, { on: true, lora: null, strength: 1, strengthTwo: null });
});

test("#560 P0: a null-valued field still ACCEPTS a correctly-typed value", () => {
  const node = {
    id: 51,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: null, strength: 1, strengthTwo: null } }],
  };
  const set = applyWidgetWrite(node, "lora_1.lora", "face.safetensors", {});
  assert.equal(set.value.lora, "face.safetensors");
  const set2 = applyWidgetWrite(node, "lora_1.strengthTwo", 0.5, {});
  assert.equal(set2.value.strengthTwo, 0.5);
});

test("#560 P2: clearing a NULLABLE field to null is accepted (lora, strengthTwo)", () => {
  const node = {
    id: 52,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: "x.safetensors", strength: 1, strengthTwo: 0.5 } }],
  };
  const set = applyWidgetWrite(node, "lora_1", '{"lora":null}', {});
  assert.equal(set.value.lora, null);
  assert.equal(node.widgets[0].value.strength, 1); // sibling preserved
  const set2 = applyWidgetWrite(node, "lora_1", '{"strengthTwo":null}', {});
  assert.equal(set2.value.strengthTwo, null);
});

test("#560 P0: an rgthree-KEY-SHAPED row enforces the schema even when a current value is CORRUPT (repair-forward)", () => {
  // The key set is rgthree's, but `on` currently holds a wrong-typed string (from a prior
  // bad write). Classification is by KEY SHAPE, not value validity, so the schema is still
  // ENFORCED: a further wrong-type write to `on` is refused, and a valid boolean REPAIRS it.
  const node = {
    id: 54,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: "yes", lora: "x.safetensors", strength: 1 } }],
  };
  assert.throws(
    () => applyWidgetWrite(node, "lora_1.on", "active", {}), // still a string → refused
    (err) => err instanceof WidgetWriteError && /is boolean but value/.test(err.message),
  );
  const set = applyWidgetWrite(node, "lora_1.on", true, {}); // valid boolean repairs it
  assert.strictEqual(set.value.on, true);
  assert.equal(node.widgets[0].value.lora, "x.safetensors");
});

test("#560 P0: a partially-corrupt row rejects a further wrong-type FULL-OBJECT write, repairs a valid one", () => {
  // `lora` is corruptly numeric (5). The schema (string) must still be enforced from the
  // KEY SHAPE — a further numeric write is refused (would deepen corruption), a string repairs.
  const node = {
    id: 58,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: 5, strength: 1, strengthTwo: null } }],
  };
  assert.throws(
    () => applyWidgetWrite(node, "lora_1", '{"lora":6}', {}),
    (err) => err instanceof WidgetWriteError && /is a string but value/.test(err.message),
  );
  const set = applyWidgetWrite(node, "lora_1", '{"lora":"real.safetensors"}', {});
  assert.equal(set.value.lora, "real.safetensors");
});

test("#560 P1: a foreign composite's UNTYPED (null) field is REFUSED, not accepted with a guessed type", () => {
  const node = {
    id: 56,
    type: "SomeOtherNode",
    widgets: [{ name: "cfg", value: { on: true, lora: null, strength: 1, extra: "x" } }],
  };
  // `extra` is not an rgthree key → schema NOT applied → lora is null → type unknowable →
  // refuse LOUDLY (no silent wrong-typed write).
  assert.throws(
    () => applyWidgetWrite(node, "cfg.lora", "anything", {}),
    (err) => err instanceof WidgetWriteError && /cannot validate the value/.test(err.message),
  );
  // A NON-null field of the same foreign composite is still writable (type inferred).
  const set = applyWidgetWrite(node, "cfg.strength", 0.5, {});
  assert.equal(set.value.strength, 0.5);
});

test("#560 P0: an rgthree-key-shaped row with an undefined field is REPAIRED-FORWARD by the schema", () => {
  // `on: undefined` — the key shape is still rgthree's, so the boolean schema is enforced:
  // a boolean-string 'false' coerces to boolean false (repairing the field), and a foreign
  // value would be refused. Classification never depends on the current value's validity.
  const node = {
    id: 57,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: undefined, lora: null, strength: 1 } }],
  };
  const set = applyWidgetWrite(node, "lora_1.on", "false", {});
  assert.strictEqual(set.value.on, false); // coerced to boolean, not the string "false"
});

test("#560 P2: a DOTTED null clears a nullable field (lora); non-nullable (on) is still refused", () => {
  const node = {
    id: 55,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: "x.safetensors", strength: 1, strengthTwo: 0.5 } }],
  };
  const set = applyWidgetWrite(node, "lora_1.lora", null, {});
  assert.equal(set.value.lora, null);
  assert.equal(node.widgets[0].value.strength, 1);
  assert.throws(
    () => applyWidgetWrite(node, "lora_1.on", null, {}),
    (err) => err instanceof WidgetWriteError && /not nullable/.test(err.message),
  );
});

test("#560 P2: clearing a NON-nullable field to null is refused (on, strength)", () => {
  const node = {
    id: 53,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: "x.safetensors", strength: 1, strengthTwo: null } }],
  };
  assert.throws(
    () => applyWidgetWrite(node, "lora_1", '{"on":null}', {}),
    (err) => err instanceof WidgetWriteError && /not nullable/.test(err.message),
  );
  assert.throws(
    () => applyWidgetWrite(node, "lora_1", '{"strength":null}', {}),
    (err) => err instanceof WidgetWriteError && /not nullable/.test(err.message),
  );
  assert.equal(node.widgets[0].value.on, true);
  assert.equal(node.widgets[0].value.strength, 1);
});

test("#179 REGRESSION: a valid full-object write still merges + preserves unspecified fields", () => {
  const node = {
    id: 49,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: false, lora: null, strength: 1, strengthTwo: null } }],
  };
  const set = applyWidgetWrite(node, "lora_1", '{"on":true,"lora":"x.safetensors","strength":0.6}', {});
  assert.equal(set.value.on, true);
  assert.equal(set.value.lora, "x.safetensors");
  assert.equal(set.value.strength, 0.6);
  assert.equal(set.value.strengthTwo, null); // preserved
});

test("#560 SAFETY: dotted addressing on a SUBGRAPH parent is refused (never a rail-only write)", () => {
  // A subgraph-shaped node whose "lora_1" is NOT resolvable as a promotion alias here:
  // the dotted form must fail closed rather than write the parent rail directly (#366).
  const node = {
    id: 47,
    type: "MySubgraph",
    subgraph: {},
    inputs: [],
    widgets: [{ name: "lora_1", value: { on: true, lora: "a.safetensors", strength: 1 } }],
  };
  assert.throws(
    () => applyWidgetWrite(node, "lora_1.on", false, { resolveSource: () => null }),
    (err) => err instanceof WidgetWriteError && /not supported on subgraph node/.test(err.message),
  );
  assert.deepEqual(node.widgets[0].value, { on: true, lora: "a.safetensors", strength: 1 });
});

// ---- combo classification + exact-value writes (#240) ---------------------

test("combo widget is classified by its option list", () => {
  const combo = { name: "sampler_name", options: { values: ["euler", "dpmpp_2m"] } };
  assert.equal(isComboWidget(combo), true);
  assert.deepEqual(comboOptions(combo), ["euler", "dpmpp_2m"]);
});

test("combo: a valid value writes that EXACT value (via handler path)", () => {
  const node = {
    id: 5,
    type: "AnimaLLLiteApply",
    widgets: [
      {
        name: "lllite_name",
        options: {
          values: [
            "ANIMA\\anima-lllite-pose-1.safetensors",
            "ANIMA\\anima-lllite-any-test-like-v2.safetensors",
          ],
        },
        value: "ANIMA\\anima-lllite-any-test-like-v2.safetensors",
      },
    ],
  };
  const set = applyWidgetWrite(node, "lllite_name", "ANIMA\\anima-lllite-pose-1.safetensors", HOOKS);
  assert.equal(set.value, "ANIMA\\anima-lllite-pose-1.safetensors");
  assert.equal(node.widgets[0].value, "ANIMA\\anima-lllite-pose-1.safetensors");
});

test("combo: an invalid value is REJECTED, not coerced to another enum", () => {
  const node = {
    id: 5,
    type: "AnimaLLLiteApply",
    widgets: [
      { name: "lllite_name", options: { values: ["pose-1.safetensors", "any-test-like-v2.safetensors"] }, value: "pose-1.safetensors" },
    ],
  };
  assert.throws(
    () => applyWidgetWrite(node, "lllite_name", "not-a-real-file.safetensors", HOOKS),
    (err) => err instanceof WidgetWriteError && /not a valid option/.test(err.message),
  );
  assert.equal(node.widgets[0].value, "pose-1.safetensors", "must not have mutated on reject");
});

test("combo: a numeric index is NOT reinterpreted as a dropdown position", () => {
  const node = { id: 1, type: "N", widgets: [{ name: "c", options: { values: ["alpha", "beta", "gamma"] }, value: "alpha" }] };
  assert.throws(() => applyWidgetWrite(node, "c", 1, HOOKS), WidgetWriteError);
  assert.equal(node.widgets[0].value, "alpha");
});

test("combo: numeric-STRING options reject the number 1 (strict, no coercion) but accept \"1\"", () => {
  const mk = () => ({ id: 1, type: "N", widgets: [{ name: "c", options: { values: ["0", "1", "2"] }, value: "0" }] });
  const nNum = mk();
  assert.throws(() => applyWidgetWrite(nNum, "c", 1, HOOKS), WidgetWriteError);
  const nStr = mk();
  assert.equal(applyWidgetWrite(nStr, "c", "1", HOOKS).value, "1");
});

test("combo: numeric options [0,1,2] still accept the number 1", () => {
  const node = { id: 1, type: "N", widgets: [{ name: "c", options: { values: [0, 1, 2] }, value: 0 }] };
  assert.equal(applyWidgetWrite(node, "c", 1, HOOKS).value, 1);
});

test("combo: dynamic (function) option list resolves and validates", () => {
  const mk = () => ({ id: 1, type: "N", widgets: [{ name: "ckpt", type: "combo", options: { values: () => ["a.ckpt", "b.ckpt"] }, value: "a.ckpt" }] });
  assert.equal(applyWidgetWrite(mk(), "ckpt", "b.ckpt", HOOKS).value, "b.ckpt");
  assert.throws(() => applyWidgetWrite(mk(), "ckpt", "c.ckpt", HOOKS), WidgetWriteError);
});

test("combo: declared combo with UNREADABLE options is refused (fail-closed, HIGH #3)", () => {
  // Missing options.values entirely.
  const missing = { id: 1, type: "N", widgets: [{ name: "c", type: "combo", value: "x" }] };
  assert.throws(
    () => applyWidgetWrite(missing, "c", 1, HOOKS),
    (err) => err instanceof WidgetWriteError && /no readable option list/.test(err.message),
  );
  // Dynamic options fn that throws.
  const throwing = {
    id: 1,
    type: "N",
    widgets: [{ name: "c", type: "combo", options: { values: () => { throw new Error("boom"); } }, value: "x" }],
  };
  assert.throws(() => applyWidgetWrite(throwing, "c", 1, HOOKS), WidgetWriteError);
});

// ---- numeric / boolean / string validation --------------------------------

test("numeric widget accepts a number and a numeric string", () => {
  assert.equal(isNumericWidget({ name: "steps", type: "INT" }), true);
  assert.equal(applyWidgetWrite({ id: 1, type: "N", widgets: [{ name: "steps", type: "INT", value: 0 }] }, "steps", 20, HOOKS).value, 20);
  assert.equal(applyWidgetWrite({ id: 1, type: "N", widgets: [{ name: "cfg", type: "number", value: 0 }] }, "cfg", "7.5", HOOKS).value, 7.5);
});

test("numeric widget REJECTS a non-numeric string (no 'euler' into an INT)", () => {
  const node = { id: 1, type: "N", widgets: [{ name: "steps", type: "INT", value: 1 }] };
  assert.throws(
    () => applyWidgetWrite(node, "steps", "euler", HOOKS),
    (err) => err instanceof WidgetWriteError && /not a number/.test(err.message),
  );
  assert.equal(node.widgets[0].value, 1);
});

test("numeric widget REJECTS non-numeric JSON types (array/object/bool/blank), accepts 5 and \"5\"", () => {
  const mk = () => ({ id: 1, type: "N", widgets: [{ name: "steps", type: "INT", value: 1 }] });
  for (const bad of [[], [5], "  ", true, false, {}, null, "", Infinity, NaN]) {
    const n = mk();
    assert.throws(
      () => applyWidgetWrite(n, "steps", bad, HOOKS),
      WidgetWriteError,
      `value ${JSON.stringify(bad)} must be rejected`,
    );
    assert.equal(n.widgets[0].value, 1, `slot untouched after rejecting ${JSON.stringify(bad)}`);
  }
  assert.equal(applyWidgetWrite(mk(), "steps", 5, HOOKS).value, 5);
  assert.equal(applyWidgetWrite(mk(), "steps", "5", HOOKS).value, 5);
});

test("boolean widget coerces true/false strings and rejects garbage", () => {
  assert.equal(applyWidgetWrite({ id: 1, type: "N", widgets: [{ name: "e", type: "toggle", value: false }] }, "e", "true", HOOKS).value, true);
  assert.throws(() => applyWidgetWrite({ id: 1, type: "N", widgets: [{ name: "e", type: "toggle", value: false }] }, "e", "maybe", HOOKS), WidgetWriteError);
});

test("string/text widget passes through unchanged", () => {
  assert.equal(applyWidgetWrite({ id: 1, type: "N", widgets: [{ name: "t", type: "text", value: "" }] }, "t", "hello world", HOOKS).value, "hello world");
});

test("missing widget on a plain node throws", () => {
  assert.throws(
    () => applyWidgetWrite({ id: 1, type: "N", widgets: [{ name: "steps" }] }, "nope", 1, HOOKS),
    (err) => err instanceof WidgetWriteError && /has no widget/.test(err.message),
  );
});

test("stuck-check fails when a widget callback drifts the value (#240)", () => {
  // callback rewrites value to a different enum → applyWidgetWrite must throw.
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "c",
        options: { values: ["a", "b"] },
        value: "a",
        callback() {
          this.value = "b"; // silent drift
        },
      },
    ],
  };
  assert.throws(
    () => applyWidgetWrite(node, "c", "a", HOOKS),
    (err) => err instanceof WidgetWriteError && /did not retain the requested value/.test(err.message),
  );
});

// ---- promoted-subgraph-widget resolution + writes (#233) -------------------

/**
 * Parent SubgraphNode over an inner KSampler. The promotion has been RENAMED:
 * the OUTER promoted widget the caller sees is "sched_alias" but it maps to the
 * inner "scheduler" widget. The parent's AUTHORITATIVE rail widget is the litegraph
 * PROJECTION object linked to the host input via `input._widget` (object identity)
 * and present in `parent.widgets` — that is what serializes at queue time. There is
 * ALSO a decoy own-widget literally named "scheduler" (the inner source name, the
 * shifted-slot corruption vector) — a correct write syncs the rail projection by
 * IDENTITY and never touches the decoy. `input.widget` is only a `{ name }` stub, as
 * in real ComfyUI. `resolveSource` mimics the live subgraph link walk.
 */
function makeSubgraphFixture() {
  const inner = {
    id: 54,
    type: "KSampler",
    widgets: [
      { name: "seed", type: "INT", value: 959948902156062 },
      { name: "steps", type: "INT", value: 1 },
      { name: "cfg", type: "number", value: 1 },
      { name: "sampler_name", type: "combo", options: { values: ["euler", "dpmpp_2m"] }, value: "euler" },
      { name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" },
      { name: "denoise", type: "number", value: 1 },
    ],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) };
  // The AUTHORITATIVE rail projection (identity-linked from the host input).
  const railWidget = { name: "sched_alias", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    inputs: [
      // OUTER alias "sched_alias" (renamed) → inner "scheduler". `_widget` is the
      // OBJECT-IDENTITY link to the parent's authoritative rail projection; `widget`
      // is only a name stub (real ComfyUI shape).
      { name: "sched_alias", _widget: railWidget, widget: { name: "sched_alias" }, _subgraphSlot: { name: "sched_alias" } },
    ],
    widgets: [
      // Decoy own-widget named after the INNER source — must stay untouched (#233).
      { name: "scheduler", type: "combo", options: { values: ["simple"] }, value: 999 },
      // AUTHORITATIVE parent rail projection (===-linked from the host input).
      railWidget,
    ],
  };
  const resolveSource = (_node, subgraphInput) =>
    subgraphInput?.name === "sched_alias"
      ? { sourceNodeId: "54", sourceWidgetName: "scheduler" }
      : null;
  return { parent, inner, railWidget, resolveSource };
}

test("promoted (renamed) widget resolves to the correct INNER node + widget", () => {
  const { parent, inner, resolveSource } = makeSubgraphFixture();
  const res = resolvePromotedInnerTarget(parent, "sched_alias", resolveSource);
  assert.equal(res.promoted, true);
  assert.equal(res.target.node, inner);
  assert.equal(res.target.widget.name, "scheduler");
});

test("writing a RENAMED promoted widget hits the inner target + syncs the rail, not the decoy parent slot (#233 blocker 1)", () => {
  const { parent, inner, resolveSource } = makeSubgraphFixture();
  const before = inner.widgets.map((w) => w.value);

  const set = applyWidgetWrite(parent, "sched_alias", "karras", { resolveSource });

  // Wrote the INNER scheduler, reported as an inner-node write.
  assert.equal(set.value, "karras");
  assert.equal(set.promoted_from.subgraph_node_id, 66);
  assert.equal(set.promoted_from.inner_node_id, 54);
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "karras");
  // The AUTHORITATIVE rail widget "sched_alias" is synced (what serializes at queue).
  assert.equal(parent.widgets.find((w) => w.name === "sched_alias").value, "karras");
  assert.equal(set.promoted_from.parent_widget_synced, true);
  // The decoy parent widget literally named "scheduler" is untouched.
  assert.equal(parent.widgets[0].value, 999);
  // Every OTHER inner widget is unchanged — no positional-shift corruption.
  inner.widgets.forEach((w, i) => {
    if (w.name !== "scheduler") assert.equal(w.value, before[i], `${w.name} must be untouched`);
  });
});

test("#583: promoted write reports the requested OUTER widget's previous value, not the inner implementation value", () => {
  const { parent, inner, railWidget, resolveSource } = makeSubgraphFixture();
  const innerWidget = inner.widgets.find((w) => w.name === "scheduler");
  // A stale/migrated subgraph can expose a different outer rail value from its
  // implementation widget. The tool was addressed to `sched_alias` on `parent`,
  // so this is the value its response must call `previous`.
  railWidget.value = "karras";
  innerWidget.value = "simple";

  const set = applyWidgetWrite(parent, "sched_alias", "simple", { resolveSource });

  assert.equal(set.previous, "karras");
  assert.equal(set.inner_previous, "simple");
  assert.equal(set.value, "simple");
  assert.equal(railWidget.value, "simple", "the visible outer rail is still synchronized");
});

test("promoted numeric slot REJECTS a non-numeric value (silent-corruption signature)", () => {
  const { parent, inner, resolveSource } = makeSubgraphFixture();
  // Re-point the promotion at inner numeric "steps", WITH a valid authoritative
  // rail widget (identity-linked) so the write reaches coercion, not fail-closed.
  const stepsRail = { name: "steps", type: "INT", value: 1 };
  parent.inputs = [{ name: "steps", _widget: stepsRail, _subgraphSlot: { name: "steps" } }];
  parent.widgets.push(stepsRail);
  const rs = (_n, si) => (si?.name === "steps" ? { sourceNodeId: "54", sourceWidgetName: "steps" } : null);
  assert.throws(
    () => applyWidgetWrite(parent, "steps", "euler", { resolveSource: rs }),
    (err) => err instanceof WidgetWriteError && /is numeric/.test(err.message),
  );
  assert.equal(inner.widgets.find((w) => w.name === "steps").value, 1);
  assert.equal(parent.widgets.find((w) => w.name === "steps").value, 1, "rail not mutated on coercion reject");
});

// ---- fail-CLOSED: promoted but unresolvable must NEVER write the parent slot (#233 blocker 2)

test("promoted widget with empty linkIds → THROW, parent slot untouched", () => {
  const { parent } = makeSubgraphFixture();
  // Match the alias but resolver returns null (stale/empty linkIds).
  parent.inputs = [{ name: "scheduler", _subgraphSlot: { name: "scheduler" } }];
  const before = parent.widgets[0].value;
  assert.throws(
    () => applyWidgetWrite(parent, "scheduler", "simple", { resolveSource: () => null }),
    (err) => err instanceof WidgetWriteError && /no resolvable inner link/.test(err.message),
  );
  assert.equal(parent.widgets[0].value, before, "parent slot must not be written on fail-closed");
});

test("promoted widget whose host input LACKS _subgraphSlot → THROW, parent untouched (round-2 HIGH #1)", () => {
  const { parent } = makeSubgraphFixture();
  // Host input matches the requested name but has NO _subgraphSlot — the
  // missing-metadata case that previously fell open to the parent widget.
  parent.inputs = [{ name: "scheduler" /* no _subgraphSlot */ }];
  const before = parent.widgets[0].value;
  assert.throws(
    () => applyWidgetWrite(parent, "scheduler", "simple", { resolveSource: () => null }),
    (err) => err instanceof WidgetWriteError && /no backing subgraph slot/.test(err.message),
  );
  assert.equal(parent.widgets[0].value, before, "parent widget must not be written");
});

test("promoted widget linking to a missing inner node → THROW (no parent fallback)", () => {
  const { parent } = makeSubgraphFixture();
  parent.inputs = [{ name: "scheduler", _subgraphSlot: { name: "scheduler" } }];
  const rs = () => ({ sourceNodeId: "999", sourceWidgetName: "scheduler" });
  assert.throws(
    () => applyWidgetWrite(parent, "scheduler", "simple", { resolveSource: rs }),
    (err) => err instanceof WidgetWriteError && /missing inner node/.test(err.message),
  );
});

test("promoted widget linking to a missing inner widget → THROW", () => {
  const { parent } = makeSubgraphFixture();
  parent.inputs = [{ name: "scheduler", _subgraphSlot: { name: "scheduler" } }];
  const rs = () => ({ sourceNodeId: "54", sourceWidgetName: "ghost_widget" });
  assert.throws(
    () => applyWidgetWrite(parent, "scheduler", "simple", { resolveSource: rs }),
    (err) => err instanceof WidgetWriteError && /missing inner widget/.test(err.message),
  );
});

test("AMBIGUOUS promoted aliases → THROW, no first-match-wins (#233 blocker 2c)", () => {
  const { parent, resolveSource } = makeSubgraphFixture();
  parent.inputs = [
    { name: "scheduler", _subgraphSlot: { name: "scheduler" } },
    { name: "scheduler", _subgraphSlot: { name: "scheduler_2" } },
  ];
  assert.throws(
    () => applyWidgetWrite(parent, "scheduler", "simple", { resolveSource }),
    (err) => err instanceof WidgetWriteError && /ambiguous/.test(err.message),
  );
});

test("subgraph node's OWN non-promoted widget writes normally (case a)", () => {
  const { parent } = makeSubgraphFixture();
  // No input alias matches "scheduler" → not promoted → write parent's own widget.
  parent.inputs = [];
  parent.widgets = [{ name: "scheduler", options: { values: ["simple", "karras"] }, value: "simple" }];
  const set = applyWidgetWrite(parent, "scheduler", "karras", { resolveSource: () => null });
  assert.equal(set.value, "karras");
  assert.equal(set.promoted_from, undefined);
});

// ---- #366: write the AUTHORITATIVE parent rail widget atomically with the inner
//            widget; fail CLOSED (never silent inner-only) when it can't be found -

/**
 * Real LTX-2.3 shape: a SubgraphNode whose OWN promoted rail widget "value_2" is
 * backed by an inner PrimitiveInt (id 257) whose widget is literally named
 * "value". The rail projection is linked to the host input by OBJECT IDENTITY
 * (`input._widget`) and present in `parent.widgets` — that is what serializes into
 * the subgraph INPUT RAIL at queue time. `input.widget` is only a `{ name }` stub
 * (real ComfyUI shape); we authenticate by identity, never by name.
 */
function makePromotedMirrorFixture() {
  const inner = {
    id: 257,
    type: "PrimitiveInt",
    widgets: [{ name: "value", type: "INT", value: 1280 }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  // The parent's OWN promoted rail projection — the authoritative value, stale.
  const railWidget = { name: "value_2", type: "INT", value: 1280 };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value_2", _widget: railWidget, widget: { name: "value_2" }, _subgraphSlot: { name: "value_2" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_node, subgraphInput) =>
    subgraphInput?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;
  return { parent, inner, railWidget, resolveSource };
}

test("#366: a promoted write syncs the AUTHORITATIVE parent rail widget (no stale render)", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();

  const set = applyWidgetWrite(parent, "value_2", 704, { resolveSource });

  // Inner write landed + is reported (unchanged behaviour).
  assert.equal(set.value, 704);
  assert.equal(set.node_id, 257);
  assert.equal(set.widget, "value");
  assert.equal(inner.widgets[0].value, 704);

  // THE FIX: the parent's OWN "value_2" rail widget — what serializes at queue
  // time — now holds the NEW value, not the stale 1280. Before the fix this
  // assertion fails (parent stays 1280 → silent stale render).
  assert.equal(parent.widgets[0].value, 704, "parent rail widget must reflect the new value");
  assert.equal(set.promoted_from.subgraph_node_id, 267);
  assert.equal(set.promoted_from.inner_node_id, 257);
  assert.equal(set.promoted_from.parent_widget_synced, true);
});

test("#366: the rail widget is resolved by the promotion's own NAME — a DIFFERENTLY-named decoy is never selected (#233)", () => {
  // The rail projection is identity-linked from the host input (`_widget`). A decoy
  // own-widget shares NOTHING with the input link. Authentication is by IDENTITY, so
  // only the linked projection is written — never the decoy — regardless of names.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = { name: "value_2", type: "INT", value: 1280 };
  const decoy = { name: "value_2", type: "INT", value: 9999 }; // SAME name — still never chosen (identity)
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value_2", _widget: railWidget, _subgraphSlot: { name: "value_2" } }],
    widgets: [decoy, railWidget], // decoy first + same name, but the input links to railWidget by identity
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  const set = applyWidgetWrite(parent, "value_2", 704, { resolveSource });

  assert.equal(railWidget.value, 704, "authoritative rail projection synced by identity");
  assert.equal(decoy.value, 9999, "a same-named decoy must never be written (identity, not name)");
  assert.equal(set.promoted_from.parent_widget_synced, true);
});

// ---- #435: a promoted write must FIRE the INNER node's own widget callback so
//            callback-driven side effects (LoadImage showImage → node.imgs) run,
//            not merely propagate the value (verified fixed in 0.11.25) ----------

test("#435: a promoted LoadImage 'image' write FIRES the INNER widget's callback (showImage side effect runs; node.imgs no longer stale)", () => {
  // Reporter scenario: subgraph node 76 promotes inner LoadImage (id 68) 'image'.
  // The pre-0.11.25 inline handler fired the PROMOTED VIEW's callback — forwarding the
  // value down but NEVER invoking the inner widget's OWN callback — so showImage() was
  // skipped, node.imgs stayed stale, and MaskEditor opened the OLD image (silent).
  // The extracted applyWidgetWrite resolves to the inner (node, widget) and fires the
  // INNER callback (#244) while syncing the authoritative rail (#366). This locks that
  // the SIDE EFFECT runs — the exact thing #435 needed — not just the value landing.
  const OLD = "clipspace/clipspace-painted-masked-A.png";
  const NEW = "SHOWCASE_11a_cinematic_grade_00012_.png";
  const fired = [];
  const innerImageWidget = {
    name: "image",
    type: "combo",
    options: { values: [OLD, NEW] },
    value: OLD,
    // Models LoadImage's image-widget callback: showImage(this.value) repopulates node.imgs.
    callback(v, _canvas, node) {
      fired.push(v);
      node.imgs = [{ src: v }]; // showImage() side effect MaskEditor reads
    },
  };
  const inner = { id: 68, type: "LoadImage", imgs: [{ src: OLD }], widgets: [innerImageWidget] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "68" ? inner : null) };
  // The parent's OWN promoted rail projection (identity-linked from the host input).
  const railWidget = { name: "image", type: "combo", options: { values: [OLD, NEW] }, value: OLD };
  const parent = {
    id: 76,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "image", _widget: railWidget, widget: { name: "image" }, _subgraphSlot: { name: "image" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_n, si) =>
    si?.name === "image" ? { sourceNodeId: "68", sourceWidgetName: "image" } : null;

  const set = applyWidgetWrite(parent, "image", NEW, { resolveSource });

  // Value landed on the inner widget AND the authoritative rail (no stale render, #366).
  assert.equal(innerImageWidget.value, NEW, "inner LoadImage image widget holds the new value");
  assert.equal(railWidget.value, NEW, "authoritative rail synced (#366)");
  assert.equal(set.promoted_from.inner_node_id, 68);
  assert.equal(set.promoted_from.parent_widget_synced, true);
  // THE #435 FIX: the INNER widget's OWN callback fired EXACTLY ONCE with the new value…
  assert.deepEqual(fired, [NEW], "inner LoadImage callback fires once with the new value");
  // …and its SIDE EFFECT ran — node.imgs repopulated, so MaskEditor reads the NEW image.
  assert.deepEqual(
    inner.imgs,
    [{ src: NEW }],
    "showImage side effect repopulated node.imgs (MaskEditor no longer opens the stale image)",
  );
});

test("#366 FAIL CLOSED runs BEFORE any side-effecting coercion — a dynamic-combo inner is never invoked when the rail is refused", () => {
  // The inner is a DYNAMIC combo whose options.values() has a side effect. With a
  // linked (non-authoritative) host input the write must fail closed BEFORE
  // coercion invokes that callback — otherwise a missing-rail refusal could still
  // leave an uncaptured inner mutation.
  let optionsInvoked = false;
  const innerWidget = {
    name: "sampler",
    type: "combo",
    value: "euler",
    options: {
      values: () => {
        optionsInvoked = true;
        return ["euler", "dpmpp_2m"];
      },
    },
  };
  const inner = { id: 54, type: "KSampler", widgets: [innerWidget] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) };
  const samplerRail = { name: "sampler", type: "combo", value: "euler", options: { values: ["euler", "dpmpp_2m"] } };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    // linked host input ⇒ non-authoritative rail ⇒ fail closed (even though the
    // projection is present, the outer link makes it non-authoritative).
    inputs: [{ name: "sampler", link: 99, _widget: samplerRail, _subgraphSlot: { name: "sampler" } }],
    widgets: [samplerRail],
  };
  const resolveSource = (_n, si) =>
    si?.name === "sampler" ? { sourceNodeId: "54", sourceWidgetName: "sampler" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "sampler", "dpmpp_2m", { resolveSource }),
    (err) => err instanceof WidgetWriteError && /parent rail widget could not be identified/.test(err.message),
  );
  assert.equal(optionsInvoked, false, "no dynamic-combo coercion side effect before the fail-closed refusal");
});

test("#366 FAIL CLOSED: an EXTERNALLY-LINKED host input (nested/further promotion) refuses — the local widget is not the authoritative rail", () => {
  // The host input carries an OUTER link (this promoted widget is further promoted
  // to an enclosing subgraph). Its projection `_widget` is a valid member, but queue
  // compilation ignores it and follows the outer rail — so writing it would be a
  // FALSE success. The link check refuses it.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const localWidget = { name: "value_2", type: "INT", value: 1280 };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    // `link` is NON-NULL ⇒ fed by an enclosing subgraph's rail (non-authoritative).
    inputs: [{ name: "value_2", link: 4242, _widget: localWidget, _subgraphSlot: { name: "value_2" } }],
    widgets: [localWidget],
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /parent rail widget could not be identified/.test(err.message),
  );
  assert.equal(localWidget.value, 1280, "non-authoritative local widget must not be written");
  assert.equal(inner.widgets[0].value, 1280, "inner must not be written on fail-closed");
});

test("#366 SEVERE FAIL CLOSED: a NAME-ONLY `input.widget` stub + an unrelated same-named decoy is REFUSED (identity auth, never a name match)", () => {
  // The exact severe repro: the host input carries ONLY a `{ name }` stub (no
  // identity-linked projection), and the parent has ONE unrelated widget that
  // happens to share that name. A name-based resolver (even unique) would select
  // and write that decoy and report synced:true. Object-identity auth must refuse:
  // the stub is not `===` any node.widgets member, so FAIL CLOSED, write nothing.
  const inner = { id: 54, type: "KSampler", widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) };
  const decoy = { name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    // NAME-ONLY stub (a different object from `decoy`), no `_widget` projection.
    inputs: [{ name: "scheduler", widget: { name: "scheduler" }, _subgraphSlot: { name: "scheduler" } }],
    widgets: [decoy], // unrelated, coincidentally same-named
    // Production litegraph's getWidgetFromSlot resolves BY NAME and would hand back
    // the decoy — the exact trap. The fix must IGNORE this and authenticate by
    // identity only, so the decoy is never written.
    getWidgetFromSlot(input) {
      return this.widgets.find((w) => w.name === input?.widget?.name) ?? null;
    },
  };
  const resolveSource = (_n, si) =>
    si?.name === "scheduler" ? { sourceNodeId: "54", sourceWidgetName: "scheduler" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "scheduler", "karras", { resolveSource }),
    (err) => err instanceof WidgetWriteError && /parent rail widget could not be identified/.test(err.message),
  );
  assert.equal(decoy.value, "simple", "the unrelated same-named decoy must NOT be written (identity, not name)");
  assert.equal(inner.widgets[0].value, "simple", "inner must not be written on fail-closed");
});

test("#366 FAIL CLOSED: a promoted write whose authoritative rail widget cannot be identified THROWS — never writes inner-only", () => {
  // No litegraph backlink and no getWidgetFromSlot → the rail widget cannot be
  // positively identified (the outward/double-promotion or malformed case). Even
  // though a same-named widget exists, matching it by name is forbidden; we FAIL
  // CLOSED so the render can never silently use the OLD value.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value_2", _subgraphSlot: { name: "value_2" } }], // no `widget` backlink
    widgets: [{ name: "value_2", type: "INT", value: 1280 }], // tempting same-named widget
    // no getWidgetFromSlot
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /parent rail widget could not be identified/.test(err.message),
  );
  // Neither the inner widget nor the tempting same-named parent widget was written.
  assert.equal(inner.widgets[0].value, 1280, "inner must not be written on fail-closed");
  assert.equal(parent.widgets[0].value, 1280, "same-named parent widget must not be written on fail-closed");
});

test("#366: a promotion addressed by its LABEL still syncs the rail widget (relationship, not name)", () => {
  // Renamed promotion: display label "sched_label"; the parent rail widget carries
  // the stable name "scheduler". The caller addresses by the LABEL. The rail widget
  // is found by the promotion backlink regardless of the label.
  const inner = {
    id: 54,
    type: "KSampler",
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) };
  const railWidget = { name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    inputs: [
      { name: "scheduler", label: "sched_label", _widget: railWidget, _subgraphSlot: { name: "scheduler", label: "sched_label" } },
    ],
    widgets: [railWidget],
  };
  const resolveSource = (_n, si) =>
    si?.name === "scheduler" ? { sourceNodeId: "54", sourceWidgetName: "scheduler" } : null;

  // Address by the LABEL, not the stable name.
  const set = applyWidgetWrite(parent, "sched_label", "karras", { resolveSource });

  assert.equal(inner.widgets[0].value, "karras");
  assert.equal(railWidget.value, "karras", "rail widget must be synced when addressed by label");
  assert.equal(set.promoted_from.parent_widget_synced, true);
});

test("#366: the rail write lands INSIDE the undo envelope (before afterChange fires)", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  let parentValueAtAfterChange;
  applyWidgetWrite(parent, "value_2", 704, {
    resolveSource,
    beforeChange: () => {
      // Envelope opened but nothing written yet.
      assert.equal(parent.widgets[0].value, 1280);
    },
    afterChange: () => {
      // BOTH inner and parent must already be written when the envelope closes,
      // so the two mutations are one atomic undo.
      parentValueAtAfterChange = parent.widgets[0].value;
    },
  });
  assert.equal(inner.widgets[0].value, 704);
  assert.equal(parentValueAtAfterChange, 704, "parent must be written before afterChange (single undo op)");
});

test("#366 ATOMIC: an INNER callback that throws rolls BOTH back — no partial write, surfaced as failure", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  // Inner widget callback throws AFTER the inner value is assigned.
  inner.widgets[0].callback = () => {
    throw new Error("inner boom");
  };
  let afterChangeRan = false;
  assert.throws(
    () =>
      applyWidgetWrite(parent, "value_2", 704, {
        resolveSource,
        afterChange: () => {
          afterChangeRan = true;
        },
      }),
    (err) => err instanceof WidgetWriteError && /callback threw|inner boom/.test(err.message),
  );
  // ROLLED BACK: neither inner nor parent rail left at the new value.
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back");
  assert.equal(parent.widgets[0].value, 1280, "parent rolled back — never inner=new/parent=stale");
  assert.equal(afterChangeRan, true, "afterChange still closes the envelope");
});

test("#366: the SEMANTIC widget callback fires EXACTLY ONCE (inner target) — a forwarding parent view is not double-invoked", () => {
  // Real ComfyUI shape: the parent's projected promoted widget is a VIEW whose
  // callback FORWARDS to the inner widget's callback. Firing both would double-run
  // the side effect; the fix fires only the inner callback (with the inner node
  // context) and sets the rail value directly.
  let innerCalls = 0;
  let innerCtx = null;
  const inner = {
    id: 257,
    type: "PrimitiveInt",
    widgets: [
      {
        name: "value",
        type: "INT",
        value: 1280,
        callback(_v, _canvas, node) {
          innerCalls += 1;
          innerCtx = node;
        },
      },
    ],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = {
    name: "value_2",
    type: "INT",
    value: 1280,
    // A view whose callback forwards to the inner widget's callback.
    callback: (...args) => inner.widgets[0].callback(...args),
  };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value_2", _widget: railWidget, _subgraphSlot: { name: "value_2" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  const set = applyWidgetWrite(parent, "value_2", 704, { resolveSource });

  assert.equal(innerCalls, 1, "the semantic callback must fire exactly once");
  assert.equal(innerCtx, inner, "…with the INNER node as context");
  assert.equal(inner.widgets[0].value, 704);
  assert.equal(railWidget.value, 704, "rail value set directly (serializes)");
  assert.equal(set.promoted_from.parent_widget_synced, true);
});

test("#366: a value setter that REJECTS the rollback surfaces an HONEST partial-state failure (never falsely claims 'rolled back')", () => {
  const inner = { id: 257, type: "PrimitiveInt", widgets: [] };
  // A widget whose `value` accepts the forward write but REJECTS the restore.
  const w = {
    name: "value",
    type: "INT",
    _v: 1280,
    _touched: false,
    get value() {
      return this._v;
    },
    set value(x) {
      if (x === 1280 && this._touched) throw new Error("setter refuses restore");
      this._v = x;
      this._touched = true;
    },
    callback() {
      throw new Error("inner boom");
    },
  };
  inner.widgets.push(w);
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = { name: "value_2", type: "INT", value: 1280 };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value_2", _widget: railWidget, _subgraphSlot: { name: "value_2" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /partial state/.test(err.message) && !/rolled back to avoid/.test(err.message),
  );
});

test("#366: a value setter that SILENTLY IGNORES the rollback (keeps the new value) is detected via read-back, not falsely claimed rolled back", () => {
  const inner = { id: 257, type: "PrimitiveInt", widgets: [] };
  // A widget whose setter accepts the forward write but silently REFUSES to go back.
  const w = {
    name: "value",
    type: "INT",
    _v: 1280,
    get value() {
      return this._v;
    },
    set value(x) {
      // Ignore any attempt to restore the old value (silent no-op rollback).
      if (x === 1280 && this._v === 704) return;
      this._v = x;
    },
    callback() {
      throw new Error("inner boom");
    },
  };
  inner.widgets.push(w);
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = { name: "value_2", type: "INT", value: 1280 };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value_2", _widget: railWidget, _subgraphSlot: { name: "value_2" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) =>
      err instanceof WidgetWriteError && /partial state/.test(err.message) && !/rolled back to avoid/.test(err.message),
  );
});

test("#366 ATOMIC: a THROWING afterChange hook does not bypass rollback", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  inner.widgets[0].callback = () => {
    throw new Error("inner boom");
  };
  const afterChange = () => {
    throw new Error("afterChange boom");
  };
  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource, afterChange }),
    (err) => err instanceof WidgetWriteError && /callback threw|inner boom/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back despite a throwing afterChange hook");
  assert.equal(parent.widgets[0].value, 1280, "rail untouched / rolled back");
});

test("#366 HARD FAIL: an afterChange HOOK that re-stales the rail (after all callbacks) is still caught + rolled back", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  // Verification must run AFTER afterChange: a hook that reverts the rail value must
  // not escape detection and report success.
  const afterChange = () => {
    // Re-stale the rail to its OLD value after the write completed.
    if (parent.widgets[0].value === 704) parent.widgets[0].value = 1280;
  };
  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource, afterChange }),
    (err) => err instanceof WidgetWriteError && /did not retain the requested value/.test(err.message),
  );
  // Rolled back: inner restored too (never inner=new/rail=stale reported as success).
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back after afterChange re-stale");
  assert.equal(parent.widgets[0].value, 1280, "rail left at its stale value, not the half-applied new one");
});

test("#366 HARD FAIL: a callback that CHANGES the promotion topology (adds an outer link) fails + rolls back — never a false synced success", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  // The inner (semantic) callback keeps the requested VALUE but mutates the host
  // input to be externally linked — so at queue time litegraph would follow the
  // outer link and ignore this rail. The post-callback re-authentication catches it.
  inner.widgets[0].callback = () => {
    parent.inputs[0].link = 7777; // now non-authoritative
  };
  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /CHANGED during the write/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back on relationship drift");
  assert.equal(parent.widgets[0].value, 1280, "rail rolled back on relationship drift");
});

test("#366 HARD FAIL: a callback that REPLACES node.inputs[i] with a new detached host input fails + rolls back", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  // The inner (semantic) callback swaps the live host input for a NEW object (the
  // captured one is now detached). Re-resolving from live node.inputs detects it.
  inner.widgets[0].callback = () => {
    parent.inputs[0] = { name: "value_2", link: 5, widget: { name: "value_2" }, _subgraphSlot: { name: "value_2" } };
  };
  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /CHANGED during the write/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back on host-input replacement");
  assert.equal(parent.widgets[0].value, 1280, "rail rolled back on host-input replacement");
});

test("#366 HARD FAIL: a callback that installs a LIVE REPLACEMENT rail preloaded with the value is reported as PARTIAL STATE (not a clean rollback)", () => {
  const { parent, inner, railWidget } = makePromotedMirrorFixture();
  // The inner callback swaps in a WHOLE new promotion: a new host input + a new
  // identity-authenticated rail projection already holding the requested value 704.
  // Recheck detects the change; restoring the OLD captured rail does not touch the
  // new live rail (which serializes 704), so this must be surfaced as partial state.
  const newRail = { name: "value_2", type: "INT", value: 704 };
  inner.widgets[0].callback = () => {
    parent.inputs[0] = { name: "value_2", _widget: newRail, _subgraphSlot: { name: "value_2" } };
    parent.widgets = [newRail];
  };
  const rs = (_n, si) => (si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null);
  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource: rs }),
    (err) => err instanceof WidgetWriteError && /partial state/.test(err.message) && /live replacement rail/.test(err.message),
  );
  assert.equal(railWidget.value, 1280, "the detached captured rail is restored");
  assert.equal(newRail.value, 704, "the live replacement rail still holds the value — surfaced as partial state");
});

test("#366 HARD FAIL: a callback that swaps only `input.widgetId` (the serialization binding) is detected + rolled back", () => {
  // Model ComfyUI's store-backed projection: the rail's value reads/writes a STORE
  // by a bound id, but queue compilation reads `input.widgetId`. A callback keeps the
  // same input + projection OBJECTS but re-points widgetId to another store entry
  // holding the OLD value — object-identity checks all pass, yet the render would be
  // stale. Snapshotting + verifying widgetId catches it.
  // Harder case: store entry "b" is PRELOADED with the requested NEW value, so a
  // swap to "b" would silently serialize the new value while we claim rollback.
  const store = { a: { value: 1280 }, b: { value: 704 } };
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = {
    name: "value_2",
    type: "INT",
    get value() {
      return store.a.value; // projection bound to store entry "a" (closure id)
    },
    set value(v) {
      store.a.value = v;
    },
  };
  const hostInput = { name: "value_2", widgetId: "a", _widget: railWidget, _subgraphSlot: { name: "value_2" } };
  const parent = { id: 267, type: "SubgraphNode", subgraph, inputs: [hostInput], widgets: [railWidget] };
  // The inner callback re-points the serialization binding to "b".
  inner.widgets[0].callback = () => {
    hostInput.widgetId = "b";
  };
  const rs = (_n, si) => (si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null);

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource: rs }),
    (err) => err instanceof WidgetWriteError && /CHANGED during the write/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back on widgetId swap");
  // The binding is RESTORED to "a" and its entry to the OLD value, so queue
  // compilation reads the old value — a clean rollback, not the preloaded "b".
  assert.equal(hostInput.widgetId, "a", "serialization binding restored to the original store key");
  assert.equal(store.a.value, 1280, "the serialized store entry holds the OLD value after rollback");
});

test("#366 ATOMIC: an EXCEPTION during the post-afterChange topology recheck triggers full rollback (never escapes with mutated state)", () => {
  const { parent, inner, railWidget } = makePromotedMirrorFixture();
  // The inner callback replaces the host input's _subgraphSlot so the recheck's
  // resolveSource THROWS for the replacement — the recheck exception must drive the
  // full rollback, not escape with inner=new / rail=new.
  inner.widgets[0].callback = () => {
    parent.inputs[0]._subgraphSlot = { name: "REPLACED" };
  };
  const rs = (_n, si) => {
    if (si?.name === "REPLACED") throw new Error("no source for replaced slot");
    return si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;
  };
  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource: rs }),
    (err) => err instanceof WidgetWriteError && /CHANGED during the write/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back after the recheck threw");
  assert.equal(railWidget.value, 1280, "rail rolled back after the recheck threw");
});

test("#366 HARD FAIL: a rollback afterChange that mutates the RESTORED composite IN PLACE is caught by STRUCTURAL verification (Object.is would miss it)", () => {
  const innerW = {
    name: "value",
    value: { on: true, lora: "a.safetensors", strength: 1 },
    callback() {
      throw new Error("inner boom"); // force entry into rollback
    },
  };
  const inner = { id: 300, type: "Power Lora Loader (rgthree)", widgets: [innerW] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "300" ? inner : null) };
  const railWidget = { name: "value", value: { on: true, lora: "a.safetensors", strength: 1 } };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value", _widget: railWidget, _subgraphSlot: { name: "value" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_n, si) => (si?.name === "value" ? { sourceNodeId: "300", sourceWidgetName: "value" } : null);
  // afterChange fires twice (main envelope, then the rollback envelope). On the
  // rollback pass it mutates the RESTORED old objects IN PLACE — Object.is against
  // the same references would pass, but structural comparison against the deep
  // clones detects the corruption.
  let phase = 0;
  const afterChange = () => {
    phase += 1;
    if (phase === 2) {
      innerW.value.strength = 999;
      railWidget.value.strength = 999;
    }
  };
  assert.throws(
    () => applyWidgetWrite(parent, "value", '{"strength":0.6}', { resolveSource, afterChange }),
    (err) => err instanceof WidgetWriteError && /partial state/.test(err.message),
  );
});

test("#366 HARD FAIL + ROLLBACK: a rail VALUE SETTER that DRIFTS (reverts) the value fails loudly AND rolls both back (never inner=new/parent=stale)", () => {
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  // The rail widget's value SETTER silently reverts a forward write to the old value
  // (a drift signature) — the rail is authoritative, so this must be caught.
  const railWidget = {
    name: "value_2",
    type: "INT",
    _v: 1280,
    get value() {
      return this._v;
    },
    set value(x) {
      this._v = x === 704 ? 1280 : x; // drift: refuse the new value
    },
  };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value_2", _widget: railWidget, _subgraphSlot: { name: "value_2" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /did not\s+retain the requested value/.test(err.message),
  );
  // Both restored — never inner=new / rail=stale reported as success.
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back on rail drift");
  assert.equal(railWidget.value, 1280, "rail at its (stale) value, not half-applied");
});

test("#366 FAIL CLOSED: a NAME-only backlink pointing at a decoy (real rail absent) is refused, never written by name", () => {
  // Host input has a `widget` NAME stub (not an object in node.widgets) and there
  // is NO getWidgetFromSlot. A widget named "value_2" exists but is a DECOY — the
  // true rail widget is absent. A name-based lookup would select the decoy and
  // report success; identity/relationship authentication refuses and FAILS CLOSED.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const decoy = { name: "value_2", type: "INT", value: 9999 };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    // `widget` is a NAME STUB, not one of node.widgets by identity.
    inputs: [{ name: "value_2", widget: { name: "value_2" }, _subgraphSlot: { name: "value_2" } }],
    widgets: [decoy],
    // no getWidgetFromSlot
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /parent rail widget could not be identified/.test(err.message),
  );
  assert.equal(decoy.value, 9999, "decoy must NOT be written by name");
  assert.equal(inner.widgets[0].value, 1280, "inner must not be written on fail-closed");
});

test("#366: a promoted STRING widget also syncs the parent rail (prompt text)", () => {
  const inner = {
    id: 266,
    type: "PrimitiveStringMultiline",
    widgets: [{ name: "value", type: "customtext", value: "old landscape prompt" }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "266" ? inner : null) };
  const railWidget = { name: "value", type: "customtext", value: "old landscape prompt" };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value", _widget: railWidget, _subgraphSlot: { name: "value" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_n, si) =>
    si?.name === "value" ? { sourceNodeId: "266", sourceWidgetName: "value" } : null;

  const set = applyWidgetWrite(parent, "value", "new vertical prompt", { resolveSource });

  assert.equal(inner.widgets[0].value, "new vertical prompt");
  assert.equal(railWidget.value, "new vertical prompt", "parent prompt rail widget must reflect the new text");
  assert.equal(set.promoted_from.parent_widget_synced, true);
});

test("#366×#179: a promoted COMPOSITE write merges onto the RAIL's current object — the rail's unspecified fields are NOT clobbered by the stale inner", () => {
  // Inner (non-authoritative) and rail (authoritative) hold DIVERGENT composite
  // values. A partial write {strength:0.6} must preserve the RAIL's `lora`
  // ("current"), not resurrect the inner's stale `lora` ("old").
  const inner = {
    id: 300,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: { on: true, lora: "old.safetensors", strength: 1 } }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "300" ? inner : null) };
  const railWidget = { name: "lora_1", value: { on: true, lora: "current.safetensors", strength: 0.8 } };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "lora_1", _widget: railWidget, _subgraphSlot: { name: "lora_1" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_n, si) =>
    si?.name === "lora_1" ? { sourceNodeId: "300", sourceWidgetName: "lora_1" } : null;

  const set = applyWidgetWrite(parent, "lora_1", '{"strength":0.6}', { resolveSource });

  assert.equal(railWidget.value.lora, "current.safetensors", "rail's authoritative lora must be preserved, not clobbered by the stale inner");
  assert.equal(railWidget.value.strength, 0.6, "requested field applied to the rail");
  assert.equal(railWidget.value.on, true, "rail's other unspecified field preserved");
  // Inner is written to the SAME authoritative merged value (read-consistency).
  assert.equal(inner.widgets[0].value.lora, "current.safetensors");
  assert.equal(inner.widgets[0].value.strength, 0.6);
  assert.equal(set.promoted_from.parent_widget_synced, true);
});

test("#560 P1: a promoted composite whose INNER value went STALE-SCALAR is still detected via the RAIL (no raw-string clobber)", () => {
  // The inner widget value is a stale SCALAR while the authoritative rail still holds the
  // composite object. A JSON payload must be recognized as composite via the rail and
  // MERGED onto it — never fall through as a raw string that clobbers the rail (#179/#366).
  const inner = {
    id: 301,
    type: "Power Lora Loader (rgthree)",
    widgets: [{ name: "lora_1", value: "STALE" }], // scalar, not an object
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "301" ? inner : null) };
  const railWidget = { name: "lora_1", value: { on: true, lora: "current.safetensors", strength: 0.8, strengthTwo: null } };
  const parent = {
    id: 268,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "lora_1", _widget: railWidget, _subgraphSlot: { name: "lora_1" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_n, si) =>
    si?.name === "lora_1" ? { sourceNodeId: "301", sourceWidgetName: "lora_1" } : null;

  const set = applyWidgetWrite(parent, "lora_1", '{"strength":0.6}', { resolveSource });

  // Rail merged onto its object — NOT overwritten by the raw string "{\"strength\":0.6}".
  assert.equal(typeof railWidget.value, "object");
  assert.equal(railWidget.value.strength, 0.6);
  assert.equal(railWidget.value.lora, "current.safetensors");
  assert.equal(railWidget.value.on, true);
  assert.equal(railWidget.value.strengthTwo, null);
  assert.equal(inner.widgets[0].value.strength, 0.6);
});

// ---- #477: a promoted write must also sync the parent-facing DISPLAY PROXY
//            widget (a SECOND identity-authenticated projection), not just the
//            serializing rail — else the outer node queries/renders the OLD value.
//            Resolved by IDENTITY (host-input references), never by name, so a
//            same-named decoy is never touched (preserves #233/#366). ------------

/**
 * ComfyUI 0.29.2 shape where a single promoted host input references TWO distinct
 * authenticated widgets that are BOTH live members of parent.widgets:
 *   - `_widget`  → the serializing RAIL projection (what #366 already synced), and
 *   - `widget`   → the parent-facing DISPLAY PROXY (what the outer node shows and a
 *                  query reads) — left stale by #366, the #477 bug.
 * A same-named DECOY that the host input references by NEITHER handle must never be
 * written (identity authentication).
 */
function makeDualProjectionFixture() {
  const inner = {
    id: 257,
    type: "PrimitiveInt",
    widgets: [{ name: "value", type: "INT", value: 1280 }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = { name: "value_2", type: "INT", value: 1280 }; // serializes (_widget)
  const displayProxy = { name: "value_2", type: "INT", value: 1280 }; // outer-facing (widget)
  const decoy = { name: "value_2", type: "INT", value: 9999 }; // same name, referenced by neither handle
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    // The host input references the rail projection (_widget) AND the display proxy
    // (widget) — BOTH real widget objects, both live members of parent.widgets.
    inputs: [{ name: "value_2", _widget: railWidget, widget: displayProxy, _subgraphSlot: { name: "value_2" } }],
    widgets: [decoy, railWidget, displayProxy],
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;
  return { parent, inner, railWidget, displayProxy, decoy, resolveSource };
}

test("#477: a promoted write syncs BOTH the serializing rail AND the parent-facing display proxy (outer no longer stale)", () => {
  const { parent, inner, railWidget, displayProxy, decoy, resolveSource } = makeDualProjectionFixture();

  const set = applyWidgetWrite(parent, "value_2", 704, { resolveSource });

  // Inner + rail behaviour is unchanged (#366).
  assert.equal(inner.widgets[0].value, 704, "inner widget written");
  assert.equal(railWidget.value, 704, "serializing rail synced (#366)");
  // THE #477 FIX: the display proxy the outer node shows/queries reflects the write.
  assert.equal(displayProxy.value, 704, "parent-facing display proxy synced (#477) — no stale outer widget");
  // A same-named decoy the host input references by NEITHER handle is never touched.
  assert.equal(decoy.value, 9999, "same-named decoy untouched (identity, not name)");
  assert.equal(set.promoted_from.parent_widget_synced, true);
  assert.equal(set.promoted_from.display_widgets_synced, 1, "one extra display proxy was synced");
});

test("#477: a display proxy that DRIFTS after the write fails CLOSED and rolls BOTH rail + proxy + inner back", () => {
  const { parent, inner, railWidget, displayProxy, resolveSource } = makeDualProjectionFixture();
  // Model a proxy whose setter refuses to hold the value (a drifting view). It must be
  // caught as a stale parent-facing widget and the whole write rolled back.
  Object.defineProperty(displayProxy, "value", {
    configurable: true,
    get() {
      return this._v ?? 1280;
    },
    set(_v) {
      this._v = 1280; // ignores the new value → drift
    },
  });
  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /display widget .*did not retain|#477/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back on the display-proxy failure");
  assert.equal(railWidget.value, 1280, "rail rolled back on the display-proxy failure");
});

test("#477 REGRESSION: the single-projection shape (only _widget) still works and reports NO extra display sync", () => {
  // The common case (existing #366 fixtures): the host input references only the rail
  // projection; `input.widget` is a name stub. displayWidgets must be empty so the path
  // is byte-identical to #366 — no display_widgets_synced key.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = { name: "value_2", type: "INT", value: 1280 };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "value_2", _widget: railWidget, widget: { name: "value_2" }, _subgraphSlot: { name: "value_2" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  const set = applyWidgetWrite(parent, "value_2", 704, { resolveSource });
  assert.equal(railWidget.value, 704);
  assert.equal(set.promoted_from.parent_widget_synced, true);
  assert.equal(set.promoted_from.display_widgets_synced, undefined, "no extra display proxy in the single-projection shape");
});

test("#477 HARD FAIL: a callback that swaps `input.widget` to a NEW live same-named display proxy holding the OLD value is caught as drift + rolled back (not false success)", () => {
  // The codex-found P1: rail-only revalidation would pass while the CURRENT outer-facing
  // proxy renders stale. The full-projection-set identity recheck must catch it.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = { name: "value_2", type: "INT", value: 1280 };
  const oldProxy = { name: "value_2", type: "INT", value: 1280 };
  // A NEW live proxy preloaded with the OLD value — installed by the callback.
  const newProxy = { name: "value_2", type: "INT", value: 1280 };
  const hostInput = { name: "value_2", _widget: railWidget, widget: oldProxy, _subgraphSlot: { name: "value_2" } };
  const parent = {
    id: 267,
    type: "SubgraphNode",
    subgraph,
    inputs: [hostInput],
    widgets: [railWidget, oldProxy, newProxy],
  };
  // The inner widget's callback swaps the host input's display proxy to newProxy (which
  // still holds 1280) and leaves _widget / inner / oldProxy at the new value.
  inner.widgets[0].callback = () => {
    hostInput.widget = newProxy;
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /CHANGED during the write|partial state|replacement display proxy/.test(err.message),
  );
  // The current outer-facing proxy still holds the OLD value — reported, never a false success.
  assert.equal(newProxy.value, 1280, "the swapped-in live display proxy still renders the OLD value (surfaced, not masked)");
  // Inner + captured rail/proxy were rolled back.
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back");
  assert.equal(railWidget.value, 1280, "rail rolled back");
});

test("#477 P1: after a rolled-back proxy-swap, the promotion TOPOLOGY (hostInput.widget) is restored to the ORIGINAL proxy (not left with the replacement wired)", () => {
  // Atomic-rollback contract: a callback that swaps hostInput.widget to a replacement
  // proxy is detected + thrown, AND the rollback must re-wire the original proxy — the
  // replacement must not stay installed after a "clean" rollback.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = { name: "value_2", type: "INT", value: 1280 };
  const oldProxy = { name: "value_2", type: "INT", value: 1280 };
  const newProxy = { name: "value_2", type: "INT", value: 1280 }; // replacement preloaded with OLD value
  const hostInput = { name: "value_2", _widget: railWidget, widget: oldProxy, _subgraphSlot: { name: "value_2" } };
  const parent = { id: 267, type: "SubgraphNode", subgraph, inputs: [hostInput], widgets: [railWidget, oldProxy, newProxy] };
  inner.widgets[0].callback = () => {
    hostInput.widget = newProxy; // swap the display proxy mid-write
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /CHANGED during the write|partial state|promotion topology/.test(err.message),
  );
  // THE #477 P1 FIX: the host input's display-proxy reference is restored to oldProxy —
  // the replacement is no longer wired to the outer node.
  assert.equal(hostInput.widget, oldProxy, "hostInput.widget restored to the original proxy after rollback");
  assert.equal(oldProxy.value, 1280, "original proxy holds its pre-write value");
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back");
  assert.equal(railWidget.value, 1280, "rail rolled back");
});

test("#477 P1: a callback that swaps hostInput.widget AND replaces parent.widgets is caught as drift AND rolled back to the ORIGINAL widget list (no detached proxy, honest state)", () => {
  // Coordinator-adversarial: the inner callback substitutes a live replacement proxy —
  // swapping hostInput.widget to newProxy AND replacing parent.widgets = [rail, newProxy]
  // (the natural cleanup). The full-set recheck correctly fails, but without restoring
  // node.widgets the rollback would leave oldProxy DETACHED and newProxy live while
  // claiming a clean rollback. The P1 fix restores the widget-list membership + order.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = { name: "value_2", type: "INT", value: 1280 };
  const oldProxy = { name: "value_2", type: "INT", value: 1280 };
  const newProxy = { name: "value_2", type: "INT", value: 1280 };
  const hostInput = { name: "value_2", _widget: railWidget, widget: oldProxy, _subgraphSlot: { name: "value_2" } };
  const originalWidgets = [railWidget, oldProxy];
  const parent = { id: 267, type: "SubgraphNode", subgraph, inputs: [hostInput], widgets: originalWidgets };
  inner.widgets[0].callback = () => {
    hostInput.widget = newProxy;
    parent.widgets = [railWidget, newProxy]; // replace the array wholesale (cleanup)
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    (err) => err instanceof WidgetWriteError && /CHANGED during the write|partial state|topology|parent widget list/.test(err.message),
  );
  // THE P1 FIX: node.widgets is restored to the ORIGINAL membership + order.
  assert.equal(parent.widgets.length, 2, "widget list restored to original length");
  assert.equal(parent.widgets[0], railWidget, "rail restored in place");
  assert.equal(parent.widgets[1], oldProxy, "original proxy re-attached (not the replacement)");
  assert.ok(!parent.widgets.includes(newProxy), "the swapped-in replacement proxy is dropped from the widget list");
  assert.equal(hostInput.widget, oldProxy, "host ref restored to the original proxy");
  assert.equal(inner.widgets[0].value, 1280, "inner rolled back");
  assert.equal(railWidget.value, 1280, "rail rolled back");
});

test("#477 P1: a callback that REPLACES the host input (same rail proxy, different widgetId) is reported as PARTIAL STATE — the captured input we restored is detached, never a clean rollback", () => {
  // Codex-adversarial: rather than swapping input.widget, the callback replaces
  // parent.inputs[0] with a NEW host input referencing the SAME rail projection but a
  // CHANGED widgetId — the new input stays live and serializes from a different store
  // key while the OLD (captured) input we restore is detached. Read-back must require
  // the LIVE host input to be the captured one, else report partial state.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = { name: "value_2", type: "INT", value: 1280 };
  const hostInput = { name: "value_2", widgetId: "a", _widget: railWidget, _subgraphSlot: { name: "value_2" } };
  const parent = { id: 267, type: "SubgraphNode", subgraph, inputs: [hostInput], widgets: [railWidget] };
  inner.widgets[0].callback = () => {
    // Replace the host input entirely — same rail projection, DIFFERENT widgetId.
    parent.inputs[0] = { name: "value_2", widgetId: "b", _widget: railWidget, _subgraphSlot: { name: "value_2" } };
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource }),
    // Must be an HONEST partial-state report naming the host input — NOT a plain
    // "CHANGED during the write" clean-rollback claim (which is all the pre-fix code
    // produced, since the same rail projections make the widget-set look unchanged).
    (err) =>
      err instanceof WidgetWriteError &&
      /partial state/.test(err.message) &&
      /host input/.test(err.message),
  );
  assert.equal(railWidget.value, 1280, "the captured rail value is restored");
});

test("#477 P1: a STATEFUL afterChange that RE-ADDS a replacement proxy every fire is reported as PARTIAL STATE (exact widget-list identity, not just membership)", () => {
  // Coordinator-adversarial: captured proxies stay members and the host input/projection
  // still point to the captured objects, so membership/set checks pass — but an extra
  // (reordered/added) widget stays live. The EXACT-list check catches it: node.widgets
  // must be the SAME array with the SAME members in the SAME order as the snapshot.
  const inner = { id: 257, type: "PrimitiveInt", widgets: [{ name: "value", type: "INT", value: 1280 }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "257" ? inner : null) };
  const railWidget = { name: "value_2", type: "INT", value: 1280 };
  const oldProxy = { name: "value_2", type: "INT", value: 1280 };
  const newProxy = { name: "value_2", type: "INT", value: 1280 };
  const hostInput = { name: "value_2", _widget: railWidget, widget: oldProxy, _subgraphSlot: { name: "value_2" } };
  const parent = { id: 267, type: "SubgraphNode", subgraph, inputs: [hostInput], widgets: [railWidget, oldProxy] };
  // Inner callback throws → forces rollback.
  inner.widgets[0].callback = () => {
    throw new Error("inner callback boom");
  };
  const resolveSource = (_n, si) =>
    si?.name === "value_2" ? { sourceNodeId: "257", sourceWidgetName: "value" } : null;
  // Stateful afterChange re-adds newProxy every time it fires (incl. inside the rollback
  // envelope, AFTER our restore) — so a membership-only read-back would pass falsely.
  const afterChange = () => {
    if (!parent.widgets.includes(newProxy)) parent.widgets.push(newProxy);
  };

  assert.throws(
    () => applyWidgetWrite(parent, "value_2", 704, { resolveSource, afterChange }),
    (err) =>
      err instanceof WidgetWriteError &&
      /did not take effect|partial state/.test(err.message) &&
      /widget list|node\.inputs\/widgets/.test(err.message),
  );
  // The captured proxies are still members (membership alone would falsely pass), but
  // the extra replacement stays live — surfaced as partial state, never a clean rollback.
  assert.ok(parent.widgets.includes(newProxy), "the stateful afterChange keeps the replacement live — honestly reported, not masked");
});

// ---- #507: a DYNAMIC, CLIENT-POPULATED combo whose option list is EMPTY.
//      `comboOptions()` returns `[]`, which is TRUTHY, so the "no readable option list"
//      guard never fired and `[].includes(value)` rejected EVERY value — the widget was
//      permanently unwritable. Zero options means the option set is not KNOWABLE, not
//      that nothing is valid. But an empty LIVE list can also be merely STALE, so
//      applyWidgetWrite refuses RETRYABLY by default and only accepts once the caller
//      (runSetWidget, after its authoritative refresh) opts in. -----------------------

// StarNodes' StarOllamaPromptHelper declares `"model": ((), {...})`, so /object_info
// reports `"model": [[], {...}]` and the node's own "Refresh Models" button fills the
// dropdown client-side.
const emptyComboNode = (value = "") => ({
  id: 9,
  type: "StarOllamaPromptHelper",
  widgets: [{ name: "model", type: "combo", options: { values: [] }, value }],
});
const ACCEPT_EMPTY = { ...HOOKS, acceptEmptyComboOptions: true };

test("#507: an EMPTY option list is a RETRYABLE combo rejection by default (a stale list must be refreshed first)", () => {
  const node = emptyComboNode("orig");
  assert.throws(
    () => applyWidgetWrite(node, "model", "qwen3-vl:8b", HOOKS),
    (err) => err instanceof WidgetWriteError && err.combo === true && /EMPTY option list/.test(err.message),
  );
  assert.equal(node.widgets[0].value, "orig", "no mutation while the list is still being resolved");
});

test("#507: once the list is confirmed STILL empty, the write PROCEEDS with the exact value", () => {
  const node = emptyComboNode();
  const set = applyWidgetWrite(node, "model", "qwen3-vl:8b", ACCEPT_EMPTY);
  assert.equal(set.value, "qwen3-vl:8b");
  assert.equal(node.widgets[0].value, "qwen3-vl:8b", "the exact value is written, uncoerced");
});

test("#507: an empty DYNAMIC (function) option list behaves exactly like an empty array", () => {
  const mk = () => ({
    id: 9,
    type: "StarOllamaPromptHelper",
    widgets: [{ name: "model", type: "combo", options: { values: () => [] }, value: "" }],
  });
  assert.throws(() => applyWidgetWrite(mk(), "model", "llama3.2:3b", HOOKS), WidgetWriteError);
  assert.equal(applyWidgetWrite(mk(), "model", "llama3.2:3b", ACCEPT_EMPTY).value, "llama3.2:3b");
});

test("#507: a NON-EMPTY list still refuses an off-list value even with acceptEmptyComboOptions (#240 intact)", () => {
  // The opt-in is scoped to the EMPTY case only — it is not a blanket 'skip validation'.
  const node = {
    id: 9,
    type: "StarOllamaPromptHelper",
    widgets: [{ name: "model", type: "combo", options: { values: ["qwen3-vl:8b", "llama3.2:3b"] }, value: "qwen3-vl:8b" }],
  };
  assert.throws(
    () => applyWidgetWrite(node, "model", "not-installed:70b", ACCEPT_EMPTY),
    (err) => err instanceof WidgetWriteError && /not a valid option/.test(err.message),
  );
  assert.equal(node.widgets[0].value, "qwen3-vl:8b", "must not have mutated on reject");
  // …and a valid member of that same non-empty list still succeeds.
  assert.equal(applyWidgetWrite(node, "model", "llama3.2:3b", ACCEPT_EMPTY).value, "llama3.2:3b");
});

test("#507: the LIVE client-populated list is what gets validated (richer than the server's empty one)", () => {
  // comboOptions reads the LIVE widget, so once the node's own "Refresh Models" button
  // has filled the dropdown, that list is authoritative for membership.
  const node = {
    id: 9,
    type: "StarOllamaPromptHelper",
    widgets: [{ name: "model", type: "combo", options: { values: ["qwen3-vl:8b"] }, value: "" }],
  };
  assert.equal(applyWidgetWrite(node, "model", "qwen3-vl:8b", ACCEPT_EMPTY).value, "qwen3-vl:8b");
  assert.throws(() => applyWidgetWrite(node, "model", "ghost:1b", ACCEPT_EMPTY), WidgetWriteError);
});

test("#507: an UNREADABLE option list is STILL refused — empty is not the same as unreadable", () => {
  // The pre-existing fail-closed guard is untouched: a missing options.values and a
  // throwing dynamic fn both still refuse, even with the opt-in — they may be hiding a
  // real, non-empty list.
  const missing = { id: 9, type: "N", widgets: [{ name: "model", type: "combo", value: "x" }] };
  assert.throws(
    () => applyWidgetWrite(missing, "model", "anything", ACCEPT_EMPTY),
    (err) => err instanceof WidgetWriteError && /no readable option list/.test(err.message),
  );
  const throwing = {
    id: 9,
    type: "N",
    widgets: [{ name: "model", type: "combo", options: { values: () => { throw new Error("boom"); } }, value: "x" }],
  };
  assert.throws(() => applyWidgetWrite(throwing, "model", "anything", ACCEPT_EMPTY), WidgetWriteError);
});

test("#507: an empty option list accepts only a SCALAR — objects/arrays fail closed and are NOT retryable", () => {
  for (const bad of [{ a: 1 }, ["a"]]) {
    const node = emptyComboNode("orig");
    assert.throws(
      () => applyWidgetWrite(node, "model", bad, ACCEPT_EMPTY),
      (err) => err instanceof WidgetWriteError && err.combo !== true,
      `#507: ${JSON.stringify(bad)} must not be written to a combo, and a refresh cannot help`,
    );
    assert.equal(node.widgets[0].value, "orig", "must not have mutated on reject");
  }
  // A MISSING value is still refused by the pre-existing #347 guard, before the combo branch.
  assert.throws(() => applyWidgetWrite(emptyComboNode("orig"), "model", undefined, ACCEPT_EMPTY), WidgetWriteError);
  // Non-string scalars are fine — a dynamic combo may legitimately hold a number/boolean.
  assert.equal(applyWidgetWrite(emptyComboNode(), "model", 7, ACCEPT_EMPTY).value, 7);
  assert.equal(applyWidgetWrite(emptyComboNode(), "model", true, ACCEPT_EMPTY).value, true);
});

test("#507: an UNRESOLVED widget/node still gets no fabricated success (#281/#458)", () => {
  // No such widget at all: the empty-list path must never be reached by inventing one.
  const none = { id: 9, type: "StarOllamaPromptHelper", widgets: [] };
  assert.throws(
    () => applyWidgetWrite(none, "model", "qwen3-vl:8b", ACCEPT_EMPTY),
    (err) => err instanceof WidgetWriteError && /has no widget/.test(err.message),
  );
  // The injected #458 target guard still runs before any empty-list handling.
  assert.throws(
    () =>
      applyWidgetWrite(emptyComboNode(), "model", "qwen3-vl:8b", {
        ...ACCEPT_EMPTY,
        assertTargetWritable: () => {
          throw new Error("unresolved placeholder node");
        },
      }),
    /unresolved placeholder node/,
  );
  // A write that does not STICK is reported as a failure, never a success.
  const frozen = {
    id: 9,
    type: "StarOllamaPromptHelper",
    widgets: [
      Object.defineProperty({ name: "model", type: "combo", options: { values: [] } }, "value", {
        get: () => "frozen",
        set: () => {},
        enumerable: true,
        configurable: true,
      }),
    ],
  };
  assert.throws(
    () => applyWidgetWrite(frozen, "model", "qwen3-vl:8b", ACCEPT_EMPTY),
    (err) => err instanceof WidgetWriteError && /did not retain the requested value/i.test(err.message),
  );
});

// ---- #507 codex round-3 (MODERATE): a PROMOTED write also mutates the parent's rail /
//      display-proxy combos, whose option lists can DIFFER from the inner's. The
//      empty-list acceptance must not push an off-list value into one of those. --------

// Same shape as makeSubgraphFixture above (identity-linked rail via input._widget), but
// the INNER combo is EMPTY — the StarNodes-style dynamic input promoted out of a subgraph.
function makeEmptyInnerPromotedFixture(railOptions) {
  const inner = {
    id: 301,
    type: "StarOllamaPromptHelper",
    widgets: [{ name: "model", type: "combo", options: { values: [] }, value: "" }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "301" ? inner : null) };
  const railWidget = { name: "model_alias", type: "combo", options: railOptions, value: "" };
  const parent = {
    id: 320,
    type: "SubgraphNode",
    subgraph,
    inputs: [
      { name: "model_alias", _widget: railWidget, widget: { name: "model_alias" }, _subgraphSlot: { name: "model_alias" } },
    ],
    widgets: [railWidget],
  };
  const resolveSource = (_node, subgraphInput) =>
    subgraphInput?.name === "model_alias" ? { sourceNodeId: "301", sourceWidgetName: "model" } : null;
  return { parent, inner, railWidget, resolveSource };
}

test("#507 round-3: an empty INNER combo must not write an off-list value into a NON-EMPTY parent rail", () => {
  const { parent, inner, railWidget, resolveSource } = makeEmptyInnerPromotedFixture({
    values: ["qwen3-vl:8b", "llama3.2:3b"],
  });
  assert.throws(
    () =>
      applyWidgetWrite(parent, "model_alias", "off-list:70b", {
        ...HOOKS,
        resolveSource,
        acceptEmptyComboOptions: true,
      }),
    (err) => err instanceof WidgetWriteError && /not a valid option for the parent subgraph/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, "", "inner untouched — refused before any mutation");
  assert.equal(railWidget.value, "", "rail untouched");
});

test("#507 round-3: the SAME promoted shape writes fine when the value IS on the parent rail's list", () => {
  const { parent, inner, railWidget, resolveSource } = makeEmptyInnerPromotedFixture({
    values: ["qwen3-vl:8b", "llama3.2:3b"],
  });
  const set = applyWidgetWrite(parent, "model_alias", "llama3.2:3b", {
    ...HOOKS,
    resolveSource,
    acceptEmptyComboOptions: true,
  });
  assert.equal(set.value, "llama3.2:3b");
  assert.equal(inner.widgets[0].value, "llama3.2:3b");
  assert.equal(railWidget.value, "llama3.2:3b", "the rail is synced (#366/#477)");
});

test("#507 round-3: a parent rail whose list is EMPTY or ABSENT adds no constraint", () => {
  for (const railOptions of [{ values: [] }, {}]) {
    const { parent, inner, resolveSource } = makeEmptyInnerPromotedFixture(railOptions);
    const set = applyWidgetWrite(parent, "model_alias", "qwen3-vl:8b", {
      ...HOOKS,
      resolveSource,
      acceptEmptyComboOptions: true,
    });
    assert.equal(set.value, "qwen3-vl:8b");
    assert.equal(inner.widgets[0].value, "qwen3-vl:8b");
  }
});

test("#507 round-3: the rail cross-check is SCOPED to the empty-list path (ordinary promoted writes unchanged)", () => {
  // Pre-existing behaviour: the INNER list is authoritative, so a value on the inner list
  // but NOT on the rail's still writes. The new cross-check must not tighten this.
  const { parent, inner, railWidget, resolveSource } = makeSubgraphFixture();
  railWidget.options.values = ["simple"]; // rail list now EXCLUDES "karras"
  const set = applyWidgetWrite(parent, "sched_alias", "karras", { ...HOOKS, resolveSource });
  assert.equal(set.value, "karras");
  assert.equal(inner.widgets.find((w) => w.name === "scheduler").value, "karras");
});

test("#507 round-5: a DYNAMIC parent-rail option source is UNVERIFIABLE on the empty-list path ⇒ fail closed", () => {
  // codex round-5: a one-shot read of a function source proves nothing — it can return []
  // during the cross-check and a real list immediately afterwards, so the off-list value
  // would still land on the mutated, serializing rail. Refuse instead.
  let call = 0;
  const { parent, inner, railWidget, resolveSource } = makeEmptyInnerPromotedFixture({
    values: () => (call++ === 0 ? [] : ["allowed"]), // [] first, real list after
  });
  assert.throws(
    () =>
      applyWidgetWrite(parent, "model_alias", "off-list:70b", {
        ...HOOKS,
        resolveSource,
        acceptEmptyComboOptions: true,
      }),
    (err) => err instanceof WidgetWriteError && /computed dynamically/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, "", "inner untouched");
  assert.equal(railWidget.value, "", "rail untouched — no value assigned behind an unverifiable list");
  // A stable dynamic source is refused too: the rule is about verifiability, not about
  // catching this particular stateful source.
  const stable = makeEmptyInnerPromotedFixture({ values: () => ["allowed"] });
  assert.throws(
    () =>
      applyWidgetWrite(stable.parent, "model_alias", "allowed", {
        ...HOOKS,
        resolveSource: stable.resolveSource,
        acceptEmptyComboOptions: true,
      }),
    (err) => err instanceof WidgetWriteError && /computed dynamically/.test(err.message),
  );
});

test("#507 round-5: the dynamic-rail refusal is SCOPED to the empty-list path", () => {
  // An ordinary promoted write against a dynamic rail is untouched — the inner list is
  // authoritative there, so nothing about the rail needs verifying.
  const inner = {
    id: 301,
    type: "N",
    widgets: [{ name: "scheduler", type: "combo", options: { values: ["simple", "karras"] }, value: "simple" }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "301" ? inner : null) };
  const railWidget = { name: "sched_alias", type: "combo", options: { values: () => ["simple", "karras"] }, value: "simple" };
  const parent = {
    id: 320,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "sched_alias", _widget: railWidget, widget: { name: "sched_alias" }, _subgraphSlot: { name: "sched_alias" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_node, si) =>
    si?.name === "sched_alias" ? { sourceNodeId: "301", sourceWidgetName: "scheduler" } : null;
  const set = applyWidgetWrite(parent, "sched_alias", "karras", { ...HOOKS, resolveSource });
  assert.equal(set.value, "karras");
  assert.equal(inner.widgets[0].value, "karras");
});

test("#507 final round: when the INNER list validated the value normally, the dynamic-rail refusal does not fire", () => {
  // The inner list is non-empty and CONTAINS the value, so ordinary membership admitted it
  // and the empty-list acceptance was never used — a dynamic parent rail then needs no
  // extra scrutiny and must not be refused, which would be the same "guard rejects a
  // legitimate case" bug #496/#507 are about. The flag being set is not itself the trigger.
  const inner = {
    id: 301,
    type: "StarOllamaPromptHelper",
    widgets: [{ name: "model", type: "combo", options: { values: () => ["qwen3-vl:8b"] }, value: "" }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "301" ? inner : null) };
  const railWidget = { name: "model_alias", type: "combo", options: { values: () => ["qwen3-vl:8b"] }, value: "" };
  const parent = {
    id: 320,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "model_alias", _widget: railWidget, widget: { name: "model_alias" }, _subgraphSlot: { name: "model_alias" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_node, si) =>
    si?.name === "model_alias" ? { sourceNodeId: "301", sourceWidgetName: "model" } : null;
  const set = applyWidgetWrite(parent, "model_alias", "qwen3-vl:8b", {
    ...HOOKS,
    resolveSource,
    acceptEmptyComboOptions: true,
  });
  assert.equal(set.value, "qwen3-vl:8b");
  assert.equal(inner.widgets[0].value, "qwen3-vl:8b");
  assert.equal(railWidget.value, "qwen3-vl:8b");
});

test("#507 final round: an OFF-list value against a non-empty inner list is still refused with the flag set", () => {
  // The narrowing must not become an escape hatch: if the inner list is non-empty and
  // does NOT contain the value, coerceWidgetValue already refuses (before the rail check).
  const inner = {
    id: 301,
    type: "StarOllamaPromptHelper",
    widgets: [{ name: "model", type: "combo", options: { values: ["qwen3-vl:8b"] }, value: "" }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "301" ? inner : null) };
  const railWidget = { name: "model_alias", type: "combo", options: { values: () => ["anything"] }, value: "" };
  const parent = {
    id: 320,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "model_alias", _widget: railWidget, widget: { name: "model_alias" }, _subgraphSlot: { name: "model_alias" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_node, si) =>
    si?.name === "model_alias" ? { sourceNodeId: "301", sourceWidgetName: "model" } : null;
  assert.throws(
    () => applyWidgetWrite(parent, "model_alias", "off-list:70b", { ...HOOKS, resolveSource, acceptEmptyComboOptions: true }),
    (err) => err instanceof WidgetWriteError && /not a valid option/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, "");
  assert.equal(railWidget.value, "");
});

test("#507 confirmation round: a STATEFUL inner options fn cannot be used to skip the parent-rail check", () => {
  // The escape hatch codex found: if the sibling cross-check decided by RE-READING the
  // inner list after coercion, a function that returns [] at coercion time (so the
  // empty-list acceptance is what admitted the value) and a NON-EMPTY list containing the
  // value on the next read would look "normally validated" — and an off-list value would
  // then land on a static parent rail and be reported as success. The verdict must come
  // from COERCION TIME, so this must still be refused.
  let call = 0;
  const inner = {
    id: 301,
    type: "StarOllamaPromptHelper",
    // 1st call (coercion): empty ⇒ the empty-list acceptance admits the value.
    // Every later call: a list that CONTAINS the value, which a re-read would trust.
    widgets: [{ name: "model", type: "combo", options: { values: () => (call++ === 0 ? [] : ["off-list:70b"]) }, value: "" }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "301" ? inner : null) };
  const railWidget = { name: "model_alias", type: "combo", options: { values: ["allowed:1b"] }, value: "" };
  const parent = {
    id: 320,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "model_alias", _widget: railWidget, widget: { name: "model_alias" }, _subgraphSlot: { name: "model_alias" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_node, si) =>
    si?.name === "model_alias" ? { sourceNodeId: "301", sourceWidgetName: "model" } : null;
  assert.throws(
    () => applyWidgetWrite(parent, "model_alias", "off-list:70b", { ...HOOKS, resolveSource, acceptEmptyComboOptions: true }),
    (err) => err instanceof WidgetWriteError && /not a valid option for the parent subgraph/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, "", "inner untouched");
  assert.equal(railWidget.value, "", "the off-list value never reached the rail");
});

test("#507 confirmation round: coerceWidgetValue reports empty-list acceptance ONLY when it was used", () => {
  // The signal the cross-check keys on, asserted directly so a future refactor that stops
  // setting it (silently disabling the rail check) fails here.
  const empty = { name: "model", type: "combo", options: { values: [] }, value: "" };
  const outEmpty = {};
  assert.equal(coerceWidgetValue(empty, "anything", empty, null, { acceptEmptyComboOptions: true, out: outEmpty }), "anything");
  assert.equal(outEmpty.emptyAcceptanceUsed, true, "the empty-list acceptance admitted it");

  const full = { name: "model", type: "combo", options: { values: ["a", "b"] }, value: "a" };
  const outFull = {};
  assert.equal(coerceWidgetValue(full, "b", full, null, { acceptEmptyComboOptions: true, out: outFull }), "b");
  assert.equal(outFull.emptyAcceptanceUsed, undefined, "ordinary membership admitted it — acceptance unused");

  // And with the flag OFF an empty list is still a retryable refusal, never an acceptance.
  const outOff = {};
  assert.throws(
    () => coerceWidgetValue(empty, "anything", empty, null, { out: outOff }),
    (err) => err instanceof WidgetWriteError && err.emptyOptions === true && err.combo === true,
  );
  assert.equal(outOff.emptyAcceptanceUsed, undefined);
});
