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
import { readFileSync } from "node:fs";

import {
  applyWidgetWrite,
  coerceWidgetValue,
  comboOptions,
  isComboWidget,
  isCompositeObjectWidget,
  isNumericWidget,
  readComboOptions,
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

// ---- comfyui-mcp#1711: nested composites inside a JSON widget (Pixaroma) ----

test("comfyui-mcp#1711: a read-modify-write pass-through of a widget holding a nested ARRAY-OF-ARRAYS is accepted", () => {
  // PixaromaSizes' sizes_ui: scalars plus `sizes`, an Array<Array<number>>. The agent
  // reads the value verbatim, changes only scalar leaves, and sends the whole JSON back;
  // the untouched `sizes` field must not be refused as "not a recognized type".
  const node = {
    id: 223,
    type: "PixaromaSizes",
    widgets: [
      {
        name: "sizes_ui",
        value: { selected: 2, w: 480, h: 864, sizes: [[608, 352], [736, 416], [864, 480]] },
      },
    ],
  };
  const set = applyWidgetWrite(
    node,
    "sizes_ui",
    '{"selected":8,"w":768,"h":1344,"sizes":[[608,352],[736,416],[864,480]]}',
    HOOKS,
  );
  assert.equal(set.value.selected, 8);
  assert.equal(set.value.w, 768);
  assert.deepEqual(set.value.sizes, [[608, 352], [736, 416], [864, 480]]);
});

test("comfyui-mcp#1711: a CHANGED but same-shaped nested array is accepted", () => {
  const node = {
    id: 224,
    type: "PixaromaSizes",
    widgets: [
      { name: "sizes_ui", value: { selected: 2, sizes: [[608, 352], [736, 416]] } },
    ],
  };
  // Add one pair and edit another — the shape (array of [number, number]) is unchanged.
  const set = applyWidgetWrite(
    node,
    "sizes_ui",
    '{"sizes":[[608,352],[864,480],[1920,1088]]}',
    HOOKS,
  );
  assert.deepEqual(set.value.sizes, [[608, 352], [864, 480], [1920, 1088]]);
  assert.equal(set.value.selected, 2); // unspecified field preserved
});

test("comfyui-mcp#1711: a same-shaped nested array is accepted via DOTTED sub-field addressing too", () => {
  const node = {
    id: 225,
    type: "PixaromaSizes",
    widgets: [
      { name: "sizes_ui", value: { selected: 2, sizes: [[608, 352]] } },
    ],
  };
  const set = applyWidgetWrite(node, "sizes_ui.sizes", [[1024, 576], [1280, 720]], HOOKS);
  assert.deepEqual(set.value.sizes, [[1024, 576], [1280, 720]]);
  assert.equal(set.value.selected, 2);
});

test("comfyui-mcp#1711: a shape-DIVERGENT value for a nested composite field still FAILS CLOSED", () => {
  const node = {
    id: 226,
    type: "PixaromaSizes",
    widgets: [
      { name: "sizes_ui", value: { selected: 2, sizes: [[608, 352], [736, 416]] } },
    ],
  };
  // A string where the array-of-arrays sits, and an array with a wrong leaf type, are
  // both provable mistypes — refused, and the widget is left untouched.
  assert.throws(
    () => applyWidgetWrite(node, "sizes_ui", '{"sizes":"608x352"}', HOOKS),
    (err) => err instanceof WidgetWriteError && /cannot validate the value/.test(err.message),
  );
  assert.throws(
    () => applyWidgetWrite(node, "sizes_ui", '{"sizes":[["608","352"]]}', HOOKS),
    (err) => err instanceof WidgetWriteError && /cannot validate the value/.test(err.message),
  );
  assert.deepEqual(node.widgets[0].value.sizes, [[608, 352], [736, 416]]);
});

test("comfyui-mcp#1711: an EMPTY existing array stays fail-closed (no element type to infer)", () => {
  const node = {
    id: 227,
    type: "PixaromaSizes",
    widgets: [{ name: "sizes_ui", value: { selected: 2, sizes: [] } }],
  };
  assert.throws(
    () => applyWidgetWrite(node, "sizes_ui", '{"sizes":[[608,352]]}', HOOKS),
    (err) => err instanceof WidgetWriteError && /cannot validate the value/.test(err.message),
  );
  assert.deepEqual(node.widgets[0].value.sizes, []);
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

test("combo: numeric-STRING options accept the number 1 via a LABEL match and write back the original string (#667)", () => {
  // The old strict rule refused the number 1 against ["0","1","2"] so a number
  // could never be reinterpreted as an index. The #667 fallback keeps that
  // guarantee differently: it matches the option's LABEL stringified and writes
  // back the list's ORIGINAL value, so the number itself never lands on the widget.
  const mk = () => ({ id: 1, type: "N", widgets: [{ name: "c", options: { values: ["0", "1", "2"] }, value: "0" }] });
  const nNum = mk();
  const set = applyWidgetWrite(nNum, "c", 1, HOOKS);
  assert.equal(set.value, "1");
  assert.equal(typeof set.value, "string", "the original string option is written, never the incoming number");
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
    (err) => err instanceof WidgetWriteError && /option list could not be READ/.test(err.message),
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

// ---- #1533: VHS_LoadVideo custom_width/custom_height must RETAIN the write ----
//
// Video Helper Suite's VHSINT callback (web/js/VHS.core.js getCustomWidgets.VHSINT)
// snaps with `Math.round((v - mod) / step) * step + mod`. custom_width/custom_height
// declare `disable: 0` and no `step`. When the format preset has not injected a
// dim-step, `step` is undefined, that formula stores NaN, and JSON.stringify(NaN)
// is `"null"` — panel_set_widget reported "applied and immediately became null".
// The callback below is that pack function, not a stand-in that merely sets null.

function vhsIntCallback(v) {
  if (this.options.max && v > this.options.max) {
    v = this.options.max;
  }
  if (this.options.min && v < this.options.min) {
    v = this.options.min;
  }
  if (v == 0) {
    return;
  }
  const s = this.options.step;
  const sh = this.options.mod ?? 0;
  this.value = Math.round((v - sh) / s) * s + sh;
}

function vhsDimensionWidget(name, extra = {}) {
  const { options: extraOptions, ...rest } = extra;
  const options = { default: 0, min: 0, max: 8192, disable: 0, ...extraOptions };
  return {
    name,
    type: "VHS.ANNOTATED",
    value: 0,
    options,
    config: ["INT", options],
    callback: vhsIntCallback,
    ...rest,
  };
}

test("#1533: VHS.ANNOTATED is a numeric widget (custom_width is not litegraph 'int')", () => {
  assert.equal(isNumericWidget(vhsDimensionWidget("custom_width")), true);
  assert.equal(isNumericWidget({ name: "t", type: "VHS.TIMESTAMP", config: ["FLOAT", {}] }), true);
  assert.equal(isNumericWidget({ name: "n", config: ["INT", { min: 0 }] }), true);
});

test("#1533: panel_set_widget retains VHS_LoadVideo custom_width when the VHSINT callback has no step", () => {
  const width = vhsDimensionWidget("custom_width");
  const node = { id: 12, type: "VHS_LoadVideo", widgets: [width] };
  const set = applyWidgetWrite(node, "custom_width", 1280, HOOKS);
  assert.equal(set.value, 1280);
  assert.equal(width.value, 1280);
});

test("#1533: panel_set_widget retains VHS_LoadVideo custom_height the same way", () => {
  const height = vhsDimensionWidget("custom_height");
  const node = { id: 12, type: "VHS_LoadVideo", widgets: [height] };
  const set = applyWidgetWrite(node, "custom_height", 720, HOOKS);
  assert.equal(set.value, 720);
  assert.equal(height.value, 720);
});

test("#1533: a numeric string still lands (VHS.ANNOTATED is coerced as INT)", () => {
  const width = vhsDimensionWidget("custom_width");
  const node = { id: 12, type: "VHS_LoadVideo", widgets: [width] };
  const set = applyWidgetWrite(node, "custom_width", "1920", HOOKS);
  assert.equal(set.value, 1920);
  assert.equal(width.value, 1920);
});

test("#1533: writing 0 (VHS disable sentinel) keeps 0 — the callback returns without snapping", () => {
  const width = vhsDimensionWidget("custom_width");
  width.value = 1280;
  const node = { id: 12, type: "VHS_LoadVideo", widgets: [width] };
  const set = applyWidgetWrite(node, "custom_width", 0, HOOKS);
  assert.equal(set.value, 0);
  assert.equal(width.value, 0);
});

test("#1533: a format-injected step still snaps, and the snap is reported as normalization", () => {
  // AnimateDiff injects step 8. 1281 → 1280 is the pack's own grid, not a failed write.
  const width = vhsDimensionWidget("custom_width", { options: { step: 8 } });
  const node = { id: 12, type: "VHS_LoadVideo", widgets: [width] };
  const set = applyWidgetWrite(node, "custom_width", 1281, HOOKS);
  assert.equal(width.value, 1280);
  assert.equal(set.value, 1280);
  assert.equal(set.normalized, true);
  assert.equal(set.requested_value, 1281);
});

test("#1533: a Vue-style callback that stores null for a finite number is restored too", () => {
  const width = vhsDimensionWidget("custom_width");
  width.callback = function () {
    this.value = null;
  };
  const node = { id: 12, type: "VHS_LoadVideo", widgets: [width] };
  const set = applyWidgetWrite(node, "custom_width", 832, HOOKS);
  assert.equal(set.value, 832);
  assert.equal(width.value, 832);
});

test("#1533: a numeric callback that drifts to a different finite number is still a failed write", () => {
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "n",
        type: "INT",
        value: 1,
        callback() {
          this.value = 99;
        },
      },
    ],
  };
  assert.throws(
    () => applyWidgetWrite(node, "n", 20, HOOKS),
    (err) => err instanceof WidgetWriteError && /did not retain the requested value/.test(err.message),
  );
  assert.equal(node.widgets[0].value, 1, "rolled back to the prior value");
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

test("#1181 FAIL CLOSED with the CORRECTED advice: an outer link from a VIRTUAL PrimitiveNode carries nothing — write inner or use a backend node", () => {
  // The #1181 configuration: the host input's outer link originates at a
  // frontend-only PrimitiveNode, which the prompt compiler drops. The generic
  // "edit from the outermost subgraph node" advice is wrong here — this IS the
  // outermost node and its rail is non-authoritative BECAUSE of that link. The
  // refusal must name the real repairs instead, and must still refuse (#366).
  const inner = { id: 54, type: "CLIPTextEncode", widgets: [{ name: "text", type: "STRING", value: "OLD stored text" }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) };
  const rail = { name: "text", type: "STRING", value: "OLD stored text" };
  const primitiveSource = { id: 85, type: "PrimitiveNode", isVirtualNode: true, widgets: [{ name: "value", value: "a lantern" }] };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "text", link: 7, _widget: rail, _subgraphSlot: { name: "text" } }],
    widgets: [rail],
  };
  const rootGraph = {
    _nodes: [primitiveSource, parent],
    links: { 7: { origin_id: 85, origin_slot: 0 } },
    getNodeById: (id) => (String(id) === "85" ? primitiveSource : String(id) === "66" ? parent : null),
  };
  parent.graph = rootGraph;
  const resolveSource = (_n, si) =>
    si?.name === "text" ? { sourceNodeId: "54", sourceWidgetName: "text" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "text", "a lantern", { resolveSource }),
    (err) =>
      err instanceof WidgetWriteError &&
      /does NOT cross the subgraph boundary/.test(err.message) &&
      /PrimitiveNode #85/.test(err.message) &&
      /inner node directly/.test(err.message) &&
      /BACKEND node/.test(err.message),
  );
  assert.equal(rail.value, "OLD stored text", "rail untouched on refusal");
  assert.equal(inner.widgets[0].value, "OLD stored text", "inner untouched on refusal");
});

test("#1181 the generic advice is KEPT when the outer link's origin is a REAL backend node", () => {
  // Same linked host input, but the origin is a backend node whose value DOES
  // cross the boundary — the #366 message ("edit from the outermost subgraph
  // node") is the true one there and must not be displaced.
  const inner = { id: 54, type: "CLIPTextEncode", widgets: [{ name: "text", type: "STRING", value: "old" }] };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "54" ? inner : null) };
  const rail = { name: "text", type: "STRING", value: "old" };
  const backendSource = { id: 85, type: "PrimitiveStringMultiline", constructor: { nodeData: {} } };
  const parent = {
    id: 66,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "text", link: 7, _widget: rail, _subgraphSlot: { name: "text" } }],
    widgets: [rail],
  };
  parent.graph = {
    _nodes: [backendSource, parent],
    links: { 7: { origin_id: 85, origin_slot: 0 } },
  };
  const resolveSource = (_n, si) =>
    si?.name === "text" ? { sourceNodeId: "54", sourceWidgetName: "text" } : null;

  assert.throws(
    () => applyWidgetWrite(parent, "text", "new", { resolveSource }),
    (err) =>
      err instanceof WidgetWriteError &&
      /parent rail widget could not be identified/.test(err.message) &&
      !/does NOT cross the subgraph boundary/.test(err.message),
  );
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

test("#366×#639: an INNER callback that throws AFTER the value landed is DISCLOSED, not rolled back — the write already took effect", () => {
  // #639 changed the contract this test pinned: a throw from the callback fires
  // AFTER both values are assigned, so inner=new / parent=stale — the partial
  // state #366's atomicity guards — cannot arise from the throw. Rolling a
  // verified write back and refusing would report failure for work that succeeded
  // and invite a destructive retry, so the result is success + write_warning.
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  // Inner widget callback throws AFTER the inner value is assigned.
  inner.widgets[0].callback = () => {
    throw new Error("inner boom");
  };
  let afterChangeRan = false;
  const set = applyWidgetWrite(parent, "value_2", 704, {
    resolveSource,
    afterChange: () => {
      afterChangeRan = true;
    },
  });
  // NOT rolled back: both inner and parent rail hold the new value (verified).
  assert.equal(inner.widgets[0].value, 704, "inner write stays — it took effect before the throw");
  assert.equal(parent.widgets[0].value, 704, "rail synced — never reported failed while applied");
  assert.match(
    set.write_warning ?? "",
    /The exception \(inner boom\) came from this \s*write's attempt to invoke the widget's own callback/,
    "the throw is disclosed, not hidden — and #976 says which construct it came out of",
  );
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
      // #639: a callback THROW no longer forces rollback (a verified write is
      // disclosed, not refused) — drift the value so verification fails and the
      // rollback path under test actually runs.
      this._v = 999;
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
      if (x === 1280 && this._v !== 1280) return;
      this._v = x;
    },
    callback() {
      // #639: a callback THROW no longer forces rollback (a verified write is
      // disclosed, not refused) — drift the value so verification fails and the
      // rollback path under test actually runs.
      this._v = 999;
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

test("#366×#639: a THROWING afterChange hook does not bypass verification — a verified write is still disclosed, not refused", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  inner.widgets[0].callback = () => {
    throw new Error("inner boom");
  };
  const afterChange = () => {
    throw new Error("afterChange boom");
  };
  const set = applyWidgetWrite(parent, "value_2", 704, { resolveSource, afterChange });
  // Verification ran to completion despite BOTH hooks throwing: the write took
  // effect and is disclosed, never reported as a clean failure (#639).
  assert.equal(inner.widgets[0].value, 704, "inner write stays");
  assert.equal(parent.widgets[0].value, 704, "rail synced");
  assert.match(set.write_warning ?? "", /\(inner boom\) came from this write's attempt to invoke/);
  assert.equal(
    set.write_warning_source,
    "widget_callback",
    "a throwing afterChange hook does not steal the attribution from the callback that actually threw",
  );
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
      // #639: a callback THROW no longer forces rollback (a verified write is
      // disclosed, not refused) — drift the written composite in place so
      // verification fails and the rollback path under test actually runs.
      this.value.strength = 12345;
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
  // Inner callback DRIFTS the value → verification fails → forces rollback. (#639:
  // a callback THROW no longer forces rollback — a verified write is disclosed,
  // not refused — so this fixture drives the rollback path with a real failure.)
  inner.widgets[0].callback = function () {
    this.value = 999;
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
    (err) => err instanceof WidgetWriteError && /option list could not be READ/.test(err.message),
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

// ---- #667: combo options whose LABEL is numeric (VHS ProRes profile "4444",
//      ffv1 level ["0","1","3"]). The tool's value param is string|number|boolean,
//      so a numeric-looking label can arrive as the NUMBER 4444 after upstream JSON
//      coercion; strict typed membership then refused it even though the label sits
//      right there in the option list — the option was unreachable via the panel.
//      The fallback matches the option's LABEL stringified and writes back the
//      option's ORIGINAL value from the list — never the incoming scalar — so no
//      mistyped value lands on the widget and no number is ever reinterpreted as
//      an INDEX (#240 intact). -----------------------------------------------

test("#667: a numeric-labelled combo option is reachable when the value arrives as a NUMBER (VHS ProRes '4444')", () => {
  const mk = () => ({
    id: 226,
    type: "VHS_VideoCombine",
    widgets: [
      {
        name: "profile",
        type: "combo",
        options: { values: ["lt", "standard", "hq", "4444", "4444xq"] },
        value: "hq",
      },
    ],
  });
  const node = mk();
  const set = applyWidgetWrite(node, "profile", 4444, HOOKS);
  assert.equal(set.value, "4444");
  assert.equal(typeof set.value, "string", "the list's ORIGINAL string option is written, not the incoming number");
  assert.equal(node.widgets[0].value, "4444");
  // The exact string still takes the strict-membership path (unchanged).
  assert.equal(applyWidgetWrite(mk(), "profile", "4444", HOOKS).value, "4444");
  // A non-numeric label is untouched by the fallback.
  assert.equal(applyWidgetWrite(mk(), "profile", "4444xq", HOOKS).value, "4444xq");
});

test("#667: string-valued numeric enum labels (ffv1 level ['0','1','3']) accept the number, write back the string", () => {
  const node = { id: 1, type: "N", widgets: [{ name: "level", options: { values: ["0", "1", "3"] }, value: "0" }] };
  const set = applyWidgetWrite(node, "level", 3, HOOKS);
  assert.equal(set.value, "3");
  assert.equal(typeof set.value, "string");
  assert.equal(node.widgets[0].value, "3");
});

test("#667: the fallback writes back the ORIGINAL option — string '1' into numeric options [0,1,2] writes the NUMBER 1", () => {
  const node = { id: 1, type: "N", widgets: [{ name: "c", options: { values: [0, 1, 2] }, value: 0 }] };
  const set = applyWidgetWrite(node, "c", "1", HOOKS);
  assert.equal(set.value, 1);
  assert.equal(typeof set.value, "number", "the list's original numeric option, not the incoming string");
});

test("#667: an OFF-list numeric value is still refused — no label match, no index semantics (#240)", () => {
  const mk = () => ({
    id: 1,
    type: "N",
    widgets: [{ name: "c", options: { values: ["lt", "standard", "hq", "4444", "4444xq"] }, value: "hq" }],
  });
  // 1 is not a LABEL in this list — it must NOT be read as a dropdown position.
  assert.throws(
    () => applyWidgetWrite(mk(), "c", 1, HOOKS),
    (err) => err instanceof WidgetWriteError && /not a valid option/.test(err.message),
  );
  assert.throws(
    () => applyWidgetWrite(mk(), "c", 9999, HOOKS),
    (err) => err instanceof WidgetWriteError && /not a valid option/.test(err.message),
  );
  const untouched = mk();
  assert.throws(() => applyWidgetWrite(untouched, "c", 1, HOOKS), WidgetWriteError);
  assert.equal(untouched.widgets[0].value, "hq", "must not have mutated on reject");
});

// ---- #639: a throwing widget callback does NOT void a write that already took
//      effect. The value assignments run BEFORE the callback fires, so when the
//      callback throws (MiniMaxH3Director's `duration`: the DaSiWa extension's
//      lengthWidget callback throws on `options` of undefined on ANY programmatic
//      invocation) the write may ALREADY be in effect. Rolling it back and
//      refusing would report failure for work that succeeded and invite a
//      destructive retry — so a VERIFIED write is reported as applied with a
//      `write_warning` disclosure; only a write that ALSO fails verification
//      fails + rolls back. ---------------------------------------------------

test("#639: a throwing callback on a verified write is DISCLOSED (write_warning), not refused — the value stays", () => {
  const node = {
    id: 2693,
    type: "MiniMaxH3Director",
    widgets: [
      {
        name: "duration",
        type: "INT",
        value: 5,
        callback() {
          throw new TypeError("Cannot read properties of undefined (reading 'options')");
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "duration", 10, HOOKS);
  assert.equal(node.widgets[0].value, 10, "the write took effect and is NOT rolled back");
  assert.equal(set.value, 10);
  assert.ok(typeof set.write_warning === "string", "the throw is disclosed, never hidden");
  assert.match(set.write_warning, /reading 'options'/, "carries the original error message");
  assert.match(set.write_warning, /IS in effect/, "says the requested value is present — never a clean-failure report");
  // #976: the reporter read the old unattributed lede as "the panel failed to apply
  // your write" and filed it here as a panel defect. The disclosure now leads with the
  // write having SUCCEEDED and names whose code threw.
  assert.match(set.write_warning, /^the write itself SUCCEEDED/, "leads with the outcome, not with the exception");
  assert.match(set.write_warning, /came from this write's attempt to invoke the widget's own callback/, "says WHERE the exception came from");
  assert.match(
    set.write_warning,
    /the assignment itself did not throw/,
    "the distinction that stops this being read as a failed write",
  );
  // codex NO-SHIP round 2: a non-callable value, a class constructor, a revoked Proxy
  // and a throwing `apply` trap all throw at the invocation without entering a body,
  // so the text must never say the callback executed.
  assert.doesNotMatch(set.write_warning, /callback threw|the callback ran|callback executed/);
  assert.equal(set.write_warning_source, "widget_callback", "the attribution is DATA, not only prose");
  // codex NO-SHIP round 1: the first draft said the node supplies the callback and the
  // fault is the node's. Neither is establishable — a pack, an extension, a prototype
  // or the frontend may have installed it, and a programmatic invocation can be the
  // whole reason it threw. Overshooting the attribution just relocates the wrong blame.
  assert.doesNotMatch(set.write_warning, /fault/, "assigns no fault");
  assert.doesNotMatch(set.write_warning, /the node supplies/, "does not claim who installed the callback");
  assert.match(set.write_warning, /invokes callbacks programmatically/, "names the one thing that could make it our doing");
});

// ---- #976 frame: until now the throw left NO evidence of where it surfaced. The
//      Error was caught inside the lib, only its message was rendered, and nothing
//      reached the console — so the maintainer twice had to ask the reporter for a
//      stack the panel itself had destroyed, and the recurrence on 0.13.7 arrived
//      with no more information than the first report. `write_warning_frame` carries
//      the innermost non-panel frame as scrubbed DATA, on EITHER attribution branch
//      (a stack frame is an observation, not an attribution claim). -----

test("#976 frame: the envelope names the FILE the throw surfaced from, with the origin scrubbed", () => {
  // A browser-shaped stack, as V8 renders it in ComfyUI — the reporter's own
  // host:port included, which is exactly what must NOT survive into a public issue.
  const packErr = new TypeError("Cannot read properties of undefined (reading 'options')");
  packErr.stack =
    "TypeError: Cannot read properties of undefined (reading 'options')\n" +
    "    at Object.callback (http://127.0.0.1:8188/extensions/WhatDreamsCost-ComfyUI/js/minimax_h3_director.js:42:17)\n" +
    "    at applyWidgetWrite (http://127.0.0.1:8188/extensions/comfyui-mcp-panel/js/lib/widget-write.js:1470:11)";
  const node = {
    id: 2693,
    type: "MiniMaxH3Director",
    widgets: [
      {
        name: "duration",
        type: "INT",
        value: 5,
        callback() {
          throw packErr;
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "duration", 10, HOOKS);
  assert.equal(set.write_warning_source, "widget_callback", "attribution unchanged");
  assert.equal(
    set.write_warning_frame,
    "at Object.callback (/extensions/WhatDreamsCost-ComfyUI/js/minimax_h3_director.js:42:17)",
    "the innermost frame, path kept, origin stripped",
  );
  assert.doesNotMatch(set.write_warning_frame, /127\.0\.0\.1|8188/, "nothing identifying the reporter's machine");
});

test("#976 frame: a REAL engine stack yields the callback's own frame — the mechanism is not fixture-shaped", () => {
  // No crafted `stack` string: whatever V8 actually produces for a callback defined
  // in THIS file must name THIS file (the pack stand-in), never the write path's.
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "n",
        type: "INT",
        value: 1,
        callback() {
          throw new TypeError("boom-976-real-stack");
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(set.write_warning_source, "widget_callback");
  assert.ok(
    typeof set.write_warning_frame === "string" && set.write_warning_frame.includes("widget-write.test.mjs"),
    `the innermost frame is the callback's own file, got: ${set.write_warning_frame}`,
  );
});

test("#976 frame: frames inside the write path itself are stepped past", () => {
  // A throw whose stack STARTS in the panel (a non-callable callback throws at the
  // Reflect.apply site, inside widget-write.js) must not report the panel's own
  // frame — that would name widget-write.js for every throw and say nothing.
  const err = new TypeError("widgetCallback is not a function");
  err.stack =
    "TypeError: widgetCallback is not a function\n" +
    "    at applyWidgetWrite (http://host:8188/extensions/comfyui-mcp-panel/js/lib/widget-write.js:1470:11)\n" +
    "    at runSetWidget (http://host:8188/extensions/comfyui-mcp-panel/js/lib/set-widget.js:545:20)\n" +
    "    at execute (http://host:8188/assets/index-BbD9p18C.js:90001:5)";
  const node = {
    id: 2,
    type: "N",
    widgets: [
      {
        name: "n",
        type: "INT",
        value: 1,
        callback() {
          throw err;
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(
    set.write_warning_frame,
    "at execute (/assets/index-BbD9p18C.js:90001:5)",
    "both lib frames skipped; the first non-write-path frame reported",
  );
});

test("#976 frame: the UNATTRIBUTED branch carries the frame too — an observation, not an attribution", () => {
  // A throwing `node.pos` getter is NOT the callback failing (the boundary tests
  // above pin that no source is claimed) — but the frame still says where the throw
  // surfaced, because that fact claims nothing about which construct failed.
  const posErr = new Error("pos boom");
  posErr.stack =
    "Error: pos boom\n" +
    "    at LGraphNode.get pos (http://192.168.1.20:8188/assets/index-BbD9p18C.js:82519:11)\n" +
    "    at applyWidgetWrite (http://192.168.1.20:8188/extensions/comfyui-mcp-panel/js/lib/widget-write.js:1468:40)";
  const node = {
    id: 1,
    type: "N",
    get pos() {
      throw posErr;
    },
    widgets: [
      {
        name: "n",
        type: "INT",
        value: 1,
        callback() {},
      },
    ],
  };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(set.write_warning_source, undefined, "still no attribution — the callback never ran");
  assert.equal(
    set.write_warning_frame,
    "at LGraphNode.get pos (/assets/index-BbD9p18C.js:82519:11)",
    "the observation is emitted anyway",
  );
});

test("#976 frame: a throwing `stack` accessor yields no frame — and breaks nothing", () => {
  // Same totality contract as describeThrown: the reporting path that exists to
  // report a throw must not itself throw, whatever the thrown value does.
  const weird = {
    get message() {
      return "odd boom";
    },
    get stack() {
      throw new Error("stack boom");
    },
  };
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "n",
        type: "INT",
        value: 1,
        callback() {
          throw weird;
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.match(set.write_warning, /odd boom/, "the message still renders");
  assert.equal(set.write_warning_frame, undefined, "no frame — and the report itself survived");
});

test("#976 frame: a non-Error throw has no stack — the warning stands, no frame claimed", () => {
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "n",
        type: "INT",
        value: 1,
        callback() {
          throw "string boom"; // eslint-disable-line no-throw-literal — the point
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.match(set.write_warning, /string boom/);
  assert.equal(set.write_warning_frame, undefined, "its absence means 'no readable stack', never 'no throw'");
});

test("#976 frame: SpiderMonkey's fn@url shape is accepted and scrubbed the same way", () => {
  const err = new TypeError("ff boom");
  err.stack = "callback@http://127.0.0.1:8188/extensions/pack/file.js:7:13";
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "n",
        type: "INT",
        value: 1,
        callback() {
          throw err;
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(set.write_warning_frame, "callback@/extensions/pack/file.js:7:13");
});

test("#976 frame: a minified single-line frame is capped, not emitted whole", () => {
  const err = new Error("minified boom");
  err.stack = `Error: minified boom\n    at ${"x".repeat(400)} (http://h:8188/extensions/p/b.js:1:1)`;
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "n",
        type: "INT",
        value: 1,
        callback() {
          throw err;
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(set.write_warning_frame.length, 240, "capped");
  assert.ok(set.write_warning_frame.endsWith("..."), "the truncation is visible");
});

// ---- #976 boundary: attribution is claimed ONLY for the invocation itself. The
//      lookup of `w.callback` and the evaluation of the callback's arguments happen
//      OUTSIDE the attributed span, because a throwing accessor and a throwing
//      `node.pos` getter are not the callback failing — and blaming the node's
//      callback for them is precisely the unestablishable claim #639 forbids.
//
//      Several of these hold behaviour that ALREADY held before #976 (they pass
//      against the old source too, which codex checked and said so). They are here as
//      the boundary's regression fence, not as proof of the fix — the tests that prove
//      the fix are the attributed ones above and the poisoned-`.call` pair below. -----

test("#976 boundary: a throwing `callback` ACCESSOR is NOT attributed to the callback — it never ran", () => {
  const w = {
    name: "n",
    type: "INT",
    value: 1,
    get callback() {
      throw new Error("accessor boom");
    },
  };
  const node = { id: 1, type: "N", widgets: [w] };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(node.widgets[0].value, 5, "the value assignment ran before the accessor was read");
  assert.match(set.write_warning ?? "", /^an exception was thrown while applying the write \(accessor boom\)/);
  assert.equal(set.write_warning_source, undefined, "no source claimed — the callback function never executed");
  assert.doesNotMatch(set.write_warning ?? "", /OWN callback/, "must not blame a callback that never ran");
});

test("#976 boundary: a throwing `node.pos` GETTER is NOT attributed to the callback — the args failed, not the node's code", () => {
  let callbackRan = false;
  const node = {
    id: 1,
    type: "N",
    get pos() {
      throw new Error("pos boom");
    },
    widgets: [
      {
        name: "n",
        type: "INT",
        value: 1,
        callback() {
          callbackRan = true;
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(callbackRan, false, "the argument list is evaluated before the call, so the callback never ran");
  assert.equal(node.widgets[0].value, 5);
  assert.match(set.write_warning ?? "", /^an exception was thrown while applying the write \(pos boom\)/);
  assert.equal(set.write_warning_source, undefined, "no source claimed");
});

test("#976 (codex NO-SHIP 1): with NO callback, a throwing `node.pos` getter is never read — the write stays clean", () => {
  // The optional-call form short-circuited: no callback meant no argument evaluation.
  // Building the argument list before the nullish guard turned a clean verified write
  // into a post-write exception warning for any node with a throwing `pos` getter.
  let posReads = 0;
  const node = {
    id: 1,
    type: "N",
    get pos() {
      posReads += 1;
      throw new Error("pos boom");
    },
    widgets: [{ name: "n", type: "INT", value: 1 }], // no callback at all
  };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(posReads, 0, "`node.pos` is not touched when there is nothing to pass it to");
  assert.equal(node.widgets[0].value, 5);
  assert.equal(set.write_warning, undefined, "a clean write — nothing threw");
  assert.equal(set.write_warning_source, undefined);
});

test("#976 (codex NO-SHIP 1): a poisoned `.call` on the callback neither throws nor steals the attribution", () => {
  // Invoking via `widgetCallback.call(w, …)` reads `.call` OFF the callback, inside
  // the attributed span — so a poisoned getter (or a Proxy `get` trap) threw where
  // the callback had not run, and got reported as the callback's exception.
  let ran = 0;
  const cb = function () {
    ran += 1;
  };
  Object.defineProperty(cb, "call", {
    get() {
      throw new Error("call getter boom");
    },
  });
  const node = { id: 1, type: "N", widgets: [{ name: "n", type: "INT", value: 1, callback: cb }] };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(ran, 1, "the callback itself ran — its `.call` property is irrelevant to invoking it");
  assert.equal(node.widgets[0].value, 5);
  assert.equal(set.write_warning, undefined, "nothing threw, so nothing is disclosed");
});

test("#976 (codex NO-SHIP 2): a callback that throws `undefined` is still disclosed — a falsy throw is not a clean write", () => {
  // `if (threw)` tested the thrown VALUE for truthiness, so `throw undefined` (also
  // null, 0, "", false) produced no warning at all: the write reported clean while the
  // callback's side effects had not run. Pre-existing, and it silently defeated the
  // whole attribution for a callback that really did throw.
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "n",
        type: "INT",
        value: 1,
        callback() {
          throw undefined; // eslint-disable-line no-throw-literal
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(node.widgets[0].value, 5, "the value is in effect");
  assert.ok(typeof set.write_warning === "string", "a falsy throw is STILL a throw and is disclosed");
  assert.match(set.write_warning, /a non-Error value was thrown: undefined/, "describes it instead of printing nothing");
  assert.equal(set.write_warning_source, "widget_callback");
});

test("#976 (codex NO-SHIP 2): `throw null` is disclosed too — null was the old sentinel value for 'nothing was thrown'", () => {
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "n",
        type: "INT",
        value: 1,
        callback() {
          throw null; // eslint-disable-line no-throw-literal
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.ok(typeof set.write_warning === "string", "the sentinel collision must not read as 'nothing was thrown'");
  assert.match(set.write_warning, /a non-Error value was thrown: null/);
  assert.equal(set.write_warning_source, "widget_callback");
});

test("#976 (codex NO-SHIP 3): the detail text renders exactly what it rendered before for real Errors and odd shapes", () => {
  // describeThrown replaced `${threw?.message ?? threw}`. Round 3 caught a first draft
  // that labelled `new Error("")` as a non-Error value — factually false — and
  // stringified `{ message: 0 }` whole. These pin the equivalence.
  const detailFor = (thrown) => {
    const node = {
      id: 1,
      type: "N",
      widgets: [
        {
          name: "n",
          type: "INT",
          value: 1,
          callback() {
            throw thrown;
          },
        },
      ],
    };
    return applyWidgetWrite(node, "n", 5, HOOKS).write_warning ?? "";
  };
  assert.match(detailFor(new Error("")), /The exception \(\) came from/, "an empty Error message stays empty");
  assert.doesNotMatch(detailFor(new Error("")), /non-Error/, "an Error is never labelled a non-Error value");
  assert.match(detailFor({ message: 0 }), /The exception \(0\) came from/, "a non-string message renders as before");
  assert.match(detailFor("boom"), /The exception \(boom\) came from/, "a thrown string renders as itself");
  // codex round 4: the ONE place it is deliberately NOT equivalent. Implicit coercion
  // of a Symbol throws, so the old `${threw?.message ?? threw}` blew up inside the
  // reporting path — the throw that reports a throw. `String()` is explicit and does
  // not, so this is now describable instead of fatal.
  assert.match(detailFor(Symbol("sym boom")), /The exception \(Symbol\(sym boom\)\) came from/);
  assert.match(detailFor({ message: Symbol("msg boom") }), /The exception \(Symbol\(msg boom\)\) came from/);
});

test("#976 (codex NO-SHIP 3): a HOSTILE thrown value cannot break the report that exists to disclose it", () => {
  // A Proxy whose `message` getter throws AND whose `getPrototypeOf` trap throws:
  // `describeThrown` must not throw, and `instanceof WidgetWriteError` must not either
  // — that classification runs while composing a failure we ALREADY know, and letting
  // it escape would lose the failure entirely.
  const hostile = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "message" || prop === "combo" || prop === "emptyOptions") throw new Error("getter boom");
        return undefined;
      },
      getPrototypeOf() {
        throw new Error("proto boom");
      },
    },
  );
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "c",
        options: { values: ["a", "b", "c"] },
        value: "b",
        callback() {
          this.value = "c"; // drift so verification FAILS and the composition branch runs
          throw hostile;
        },
      },
    ],
  };
  assert.throws(
    () => applyWidgetWrite(node, "c", "a", HOOKS),
    (err) =>
      err instanceof WidgetWriteError &&
      /a thrown value that could not be described/.test(err.message) &&
      /did not retain the requested value/.test(err.message),
    "the structural failure survives a thrown value that fights back",
  );
  assert.equal(node.widgets[0].value, "b", "still rolled back");
});

test("#976 (codex NO-SHIP 2): a CLASS constructor callback is attributed to the invocation, never described as having run", () => {
  // `typeof class {} === "function"`, so this passes the callability check and then
  // throws inside Reflect.apply ("Class constructor cannot be invoked without 'new'").
  // Nothing of the class body executed — the wording must survive that.
  let constructed = 0;
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "n",
        type: "INT",
        value: 1,
        callback: class {
          constructor() {
            constructed += 1;
          }
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(constructed, 0, "no body ran");
  assert.match(set.write_warning ?? "", /came from this write's attempt to invoke the widget's own callback/);
  assert.doesNotMatch(set.write_warning ?? "", /callback threw|the callback ran/, "never claims a body executed");
  assert.equal(set.write_warning_source, "widget_callback");
});

test("#976 (codex NO-SHIP 2): a REVOKED Proxy callback is attributed to the invocation, and the write still verifies", () => {
  const { proxy, revoke } = Proxy.revocable(function () {}, {});
  revoke();
  const node = { id: 1, type: "N", widgets: [{ name: "n", type: "INT", value: 1, callback: proxy }] };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(node.widgets[0].value, 5, "the value landed before the invocation was attempted");
  assert.match(set.write_warning ?? "", /came from this write's attempt to invoke the widget's own callback/);
  assert.doesNotMatch(
    set.write_warning ?? "",
    /callback threw|the callback ran|which runs AFTER/,
    "a revoked Proxy passes `typeof === 'function'` and then throws before any target code — nothing ran",
  );
  assert.equal(set.write_warning_source, "widget_callback");
});

test("#976 (codex NO-SHIP 2): a callable Proxy whose `apply` trap throws is attributed — the trap IS the callback's invocation", () => {
  let targetRan = 0;
  const proxy = new Proxy(
    function () {
      targetRan += 1;
    },
    {
      apply() {
        throw new Error("trap boom");
      },
    },
  );
  const node = { id: 1, type: "N", widgets: [{ name: "n", type: "INT", value: 1, callback: proxy }] };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(targetRan, 0, "the trap replaced the target — its body never ran");
  assert.match(set.write_warning ?? "", /trap boom/);
  assert.equal(set.write_warning_source, "widget_callback", "the trap IS this callback's invocation behaviour");
});

test("#976 (codex NO-SHIP 2): a NON-CALLABLE callback plus a throwing `node.pos` reports the pos error, unattributed", () => {
  // Precedence: the arguments are built before the invocation, so `pos` throws first
  // and the callability of the callback is never reached. The disclosure must follow
  // what actually threw, not what would have thrown next.
  const node = {
    id: 1,
    type: "N",
    get pos() {
      throw new Error("pos boom");
    },
    widgets: [{ name: "n", type: "INT", value: 1, callback: { call() {} } }],
  };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.match(set.write_warning ?? "", /^an exception was thrown while applying the write \(pos boom\)/);
  assert.equal(set.write_warning_source, undefined, "the invocation was never attempted");
});

test("#976 (codex NO-SHIP 1): a NON-CALLABLE callback carrying its own `.call` method still throws, as it always did", () => {
  // The real regression behind the poisoned-`.call` finding: `{ call() {} }` is not
  // callable, and `w.callback?.(…)` threw for it. Invoking through `.call` would have
  // run that object's method instead and reported a clean write.
  let impostorRan = 0;
  const w = {
    name: "n",
    type: "INT",
    value: 1,
    callback: {
      call() {
        impostorRan += 1;
      },
    },
  };
  const node = { id: 1, type: "N", widgets: [w] };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(impostorRan, 0, "a `.call` method on a non-function is NOT an invocation path");
  assert.match(
    set.write_warning ?? "",
    /callback is of type "object", not a function, so it could not be invoked at all/,
    "#976 round 2: says the establishable thing — it could not be entered, so nothing of it ran",
  );
  assert.doesNotMatch(set.write_warning ?? "", /assume a click/, "the programmatic-invocation caveat is irrelevant here");
  assert.ok(typeof set.write_warning === "string", "a non-callable callback still throws, and is still disclosed");
  assert.equal(set.write_warning_source, "widget_callback", "attributed: the callback the widget carries is unusable");
});

test("#976: a callback that RETURNS normally leaves no attribution behind for a later throw", () => {
  // The flag is raised around the invocation and cleared when it returns. If it were
  // only ever raised, every subsequent throw in the envelope would be mis-blamed on a
  // callback that completed successfully. Nothing in this envelope throws after the
  // callback today; this pins the clear so that stays true when something does.
  let callbackRan = false;
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "n",
        type: "INT",
        value: 1,
        callback() {
          callbackRan = true;
        },
      },
    ],
  };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(callbackRan, true);
  assert.equal(set.write_warning, undefined, "a clean write discloses nothing");
  assert.equal(set.write_warning_source, undefined);
});

test("#976: the callback is still invoked with the widget as `this` and the same five arguments", () => {
  // The attributed call binds explicitly (`cb.call(w, …)`) where the original used
  // `w.callback?.(…)`. Both bind `this` to the widget and callbacks read `this.value`
  // — a regression here would silently break every node that does.
  let seenThis = null;
  let seenArgs = null;
  const canvas = { marker: "canvas" };
  const w = {
    name: "n",
    type: "INT",
    value: 1,
    callback(...args) {
      seenThis = this;
      seenArgs = args;
    },
  };
  const node = { id: 7, type: "N", pos: [10, 20], widgets: [w] };
  applyWidgetWrite(node, "n", 5, { canvas });
  assert.equal(seenThis, w, "`this` is the widget");
  assert.equal(seenArgs.length, 5);
  assert.equal(seenArgs[0], 5, "the coerced value");
  assert.equal(seenArgs[1], canvas);
  assert.equal(seenArgs[2], node);
  assert.deepEqual(seenArgs[3], [10, 20], "node.pos");
  assert.equal(seenArgs[4], undefined);
});

test("#976: the panel's own graph_set_widget summary reads the attribution DATA, and still has its unattributed fallback", () => {
  // The lib's prose is what an AGENT reads; the summary line is what the USER reads,
  // and it repeated the same "an exception was thrown while applying it" lede. This
  // asserts the SHIPPED panel source (the summariser lives inside the monolith's
  // switch and is not importable), so deleting either branch fails here.
  const panelSrc = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(
    panelSrc,
    /r\.set\?\.write_warning_source === "widget_callback"/,
    "reads the structured field — never pattern-matches the warning prose",
  );
  assert.match(
    panelSrc,
    /the exception came from invoking the widget's own callback, so its side effects may not have run/,
    "the attributed summary line",
  );
  assert.match(
    panelSrc,
    /an exception was thrown while applying it; side effects may not have run or completed/,
    "the unattributed line SURVIVES — an unrecognised source must degrade to it, not mis-attribute",
  );
});

test("#639: a promoted write whose inner callback throws still discloses success when inner + rail both verify", () => {
  const { parent, inner, resolveSource } = makePromotedMirrorFixture();
  inner.widgets[0].callback = () => {
    throw new Error("inner boom");
  };
  const set = applyWidgetWrite(parent, "value_2", 704, { resolveSource });
  assert.equal(inner.widgets[0].value, 704);
  assert.equal(parent.widgets[0].value, 704, "rail synced — the write genuinely took effect");
  assert.equal(set.promoted_from.parent_widget_synced, true);
  assert.match(set.write_warning ?? "", /inner boom/);
});

test("#639: a callback that throws AND leaves the write unverified still FAILS + rolls back, naming the throw", () => {
  // Three DISTINCT values so each leg is proven independently (codex round-1):
  // seenAtCallback==="a" proves the assignment ran BEFORE the callback; the drift
  // to "c" is what verification rejects; the final "b" proves rollback restored
  // the ORIGINAL — not the drifted value, not the requested one.
  let seenAtCallback;
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "c",
        options: { values: ["a", "b", "c"] },
        value: "b",
        callback() {
          seenAtCallback = this.value;
          this.value = "c"; // drift to a THIRD value, THEN throw
          throw new Error("combo boom");
        },
      },
    ],
  };
  assert.throws(
    () => applyWidgetWrite(node, "c", "a", HOOKS),
    (err) =>
      err instanceof WidgetWriteError &&
      // #976: the failure branch is attributed too — the structural verdict is the
      // panel's, the exception that preceded it is the node's, and both are named.
      /came from attempting to invoke the widget's OWN callback while applying the write \(combo boom\)/.test(err.message) &&
      /did not retain the requested value/.test(err.message),
  );
  assert.equal(seenAtCallback, "a", "the requested value WAS assigned before the callback fired");
  assert.equal(node.widgets[0].value, "b", "rolled back to the ORIGINAL — not the drift, not the request");
});

test("#639: a thrown WidgetWriteError on an unverified write keeps BOTH causes and its retry flags", () => {
  const node = {
    id: 1,
    type: "N",
    widgets: [
      {
        name: "c",
        options: { values: ["a", "b", "c"] },
        value: "b",
        callback() {
          this.value = "c"; // drift so verification fails
          throw new WidgetWriteError("combo list went stale", { combo: true });
        },
      },
    ],
  };
  assert.throws(
    () => applyWidgetWrite(node, "c", "a", HOOKS),
    (err) =>
      err instanceof WidgetWriteError &&
      err.combo === true && // the refresh-retry signal survives the composition
      /came from attempting to invoke the widget's OWN callback while applying the write \(combo list went stale\)/.test(err.message) &&
      /did not retain the requested value/.test(err.message),
  );
  assert.equal(node.widgets[0].value, "b", "rolled back");
});

test("#639: a throwing value SETTER on a verified write is disclosed without unestablishable attribution", () => {
  const w = {
    name: "n",
    type: "INT",
    _v: 1,
    get value() {
      return this._v;
    },
    set value(x) {
      this._v = x; // applies FIRST…
      throw new Error("setter boom"); // …then throws
    },
    callback() {
      throw new Error("must not be blamed — this never fired");
    },
  };
  const node = { id: 1, type: "N", widgets: [w] };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(node.widgets[0].value, 5, "the setter applied before throwing — the write is in effect");
  assert.match(set.write_warning ?? "", /thrown while applying the write/);
  assert.match(set.write_warning ?? "", /setter boom/);
  assert.match(set.write_warning ?? "", /IS in effect/);
  assert.doesNotMatch(
    set.write_warning ?? "",
    /never ran|after applying|callback threw|setter threw|OWN callback/,
    "names NO construct — the mechanism cannot establish which one threw (codex delta-gate)",
  );
  assert.equal(set.write_warning_source, undefined, "#976: no source claimed for a throw outside the invocation");
});

test("#639: a REENTRANT setter (one that invokes the callback, which throws) gets the same attribution-free wording", () => {
  // codex round-2/3: a value setter can invoke `this.callback()` itself and let
  // its exception propagate — then the callback DID run and threw, but the throw
  // surfaced from the ASSIGNMENT. The disclosure never asserts which construct
  // threw or whether the callback ran.
  const w = {
    name: "n",
    type: "INT",
    _v: 1,
    get value() {
      return this._v;
    },
    set value(x) {
      this._v = x;
      this.callback(); // reentrant: the callback runs INSIDE the setter and throws
    },
    callback() {
      throw new Error("reentrant boom");
    },
  };
  const node = { id: 1, type: "N", widgets: [w] };
  const set = applyWidgetWrite(node, "n", 5, HOOKS);
  assert.equal(node.widgets[0].value, 5, "the write is in effect");
  assert.match(set.write_warning ?? "", /thrown while applying the write/);
  assert.match(set.write_warning ?? "", /reentrant boom/);
  assert.doesNotMatch(set.write_warning ?? "", /callback never ran|after applying|callback threw|setter threw/);
  // #976: the callback DID run and DID throw here — but the throw surfaced from the
  // ASSIGNMENT, before the attributed span was entered, so nothing may be claimed.
  // This is the case that keeps the attribution honest rather than merely plausible.
  assert.doesNotMatch(set.write_warning ?? "", /OWN callback/);
  assert.equal(set.write_warning_source, undefined);
});

test("#667×#507: a numeric request against a numeric-LABELLED rail option is ADOPTED on the empty-inner-list path (codex round-3)", () => {
  // The promoted empty-list acceptance writes a value nothing validated; the
  // sibling rail cross-check is the only validator — and it applied STRICT typed
  // membership, so a numeric 4444 against the rail's string "4444" was refused
  // even though the rail itself publishes that option (#667 on the #507 path).
  const { parent, inner, railWidget, resolveSource } = makeEmptyInnerPromotedFixture({
    values: ["lt", "standard", "hq", "4444", "4444xq"],
  });
  const set = applyWidgetWrite(parent, "model_alias", 4444, {
    ...HOOKS,
    resolveSource,
    acceptEmptyComboOptions: true,
  });
  assert.equal(set.value, "4444");
  assert.equal(typeof set.value, "string", "the rail list's ORIGINAL option is written, not the incoming number");
  assert.equal(inner.widgets[0].value, "4444");
  assert.equal(railWidget.value, "4444", "the rail is synced with its own original option");
});

test("#667×#507: a numeric request matching NO rail label is still refused on the empty-inner-list path", () => {
  const { parent, inner, railWidget, resolveSource } = makeEmptyInnerPromotedFixture({ values: ["lt", "hq"] });
  assert.throws(
    () => applyWidgetWrite(parent, "model_alias", 4444, { ...HOOKS, resolveSource, acceptEmptyComboOptions: true }),
    (err) => err instanceof WidgetWriteError && /not a valid option for the parent subgraph/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, "", "untouched — refused before any mutation");
  assert.equal(railWidget.value, "", "rail untouched");
});

// A promoted EMPTY-inner combo whose rail AND a parent-facing display proxy both
// carry option lists — the multi-sibling shape the delta-gate finding exercised.
const makeEmptyInnerRailProxyFixture = (railValues, proxyValues) => {
  const inner = {
    id: 301,
    type: "StarOllamaPromptHelper",
    widgets: [{ name: "model", type: "combo", options: { values: [] }, value: "" }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "301" ? inner : null) };
  const railWidget = { name: "model_alias", type: "combo", options: { values: railValues }, value: "" };
  const proxyWidget = { name: "model_alias", type: "combo", options: { values: proxyValues }, value: "" };
  const parent = {
    id: 320,
    type: "SubgraphNode",
    subgraph,
    inputs: [
      { name: "model_alias", _widget: railWidget, widget: proxyWidget, _subgraphSlot: { name: "model_alias" } },
    ],
    widgets: [railWidget, proxyWidget],
  };
  const resolveSource = (_node, subgraphInput) =>
    subgraphInput?.name === "model_alias" ? { sourceNodeId: "301", sourceWidgetName: "model" } : null;
  return { parent, inner, railWidget, proxyWidget, resolveSource };
};

test("#667×#507: sibling lists that AGREE on the label's type adopt once and write the original everywhere", () => {
  const { parent, inner, railWidget, proxyWidget, resolveSource } = makeEmptyInnerRailProxyFixture(
    ["lt", "4444"],
    ["4444", "hq"],
  );
  const set = applyWidgetWrite(parent, "model_alias", 4444, {
    ...HOOKS,
    resolveSource,
    acceptEmptyComboOptions: true,
  });
  assert.equal(set.value, "4444");
  assert.equal(typeof set.value, "string");
  assert.equal(inner.widgets[0].value, "4444");
  assert.equal(railWidget.value, "4444");
  assert.equal(proxyWidget.value, "4444", "every mutated sibling holds the SAME original option");
});

test("#667×#507 (delta-gate): sibling lists that DISAGREE on a numeric label's type fail closed — never a flip-flopped write", () => {
  // Rail lists the label as the STRING "4444"; the display proxy lists the NUMBER
  // 4444. Adopting the rail's original and then the proxy's would end with the
  // numeric value written into the rail whose list only holds the string — the
  // final value must be re-validated against EVERY sibling, and here no single
  // value satisfies both lists, so the write refuses without mutating anything.
  const { parent, inner, railWidget, proxyWidget, resolveSource } = makeEmptyInnerRailProxyFixture(["4444"], [4444]);
  assert.throws(
    () =>
      applyWidgetWrite(parent, "model_alias", 4444, {
        ...HOOKS,
        resolveSource,
        acceptEmptyComboOptions: true,
      }),
    (err) => err instanceof WidgetWriteError && /DISAGREE/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, "", "inner untouched");
  assert.equal(railWidget.value, "", "rail untouched — never holds a value its list does not contain");
  assert.equal(proxyWidget.value, "", "proxy untouched");
});

test("#639 (delta-gate 2): a FROZEN widget already holding the requested value reports 'IS in effect', never that this write caused it", () => {
  // Assigning to a frozen widget's `value` throws in strict mode with NO user
  // code involved; read-back then finds the requested value already present.
  // The disclosure must claim presence, not causation.
  const w = Object.freeze({ name: "n", type: "INT", value: 10 });
  const node = { id: 1, type: "N", widgets: [w] };
  const set = applyWidgetWrite(node, "n", 10, HOOKS);
  assert.equal(node.widgets[0].value, 10);
  assert.match(set.write_warning ?? "", /thrown while applying the write/);
  assert.match(set.write_warning ?? "", /IS in effect/);
  assert.doesNotMatch(set.write_warning ?? "", /DID take effect/);
  assert.equal(set.write_warning_source, undefined, "#976: a frozen widget throws with no node code involved");
});

test("#667×#507 (delta-gate 2): re-validation checks the SAME list snapshot as admission — a stateful non-function source cannot cause a false DISAGREE", () => {
  // A buggy-but-in-scope accessor answers differently per read. Admission reads
  // the list exactly once per sibling (isComboWidget, the function-type probe,
  // then comboOptions); a FOURTH read only happens if re-validation re-reads the
  // source instead of checking the admission snapshot — which must not happen.
  let reads = 0;
  const railWidget = {
    name: "model_alias",
    type: "combo",
    value: "",
    options: {
      get values() {
        reads += 1;
        return reads <= 3 ? ["lt", "4444"] : ["changed-after-admission"];
      },
    },
  };
  const inner = {
    id: 301,
    type: "StarOllamaPromptHelper",
    widgets: [{ name: "model", type: "combo", options: { values: [] }, value: "" }],
  };
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "301" ? inner : null) };
  const parent = {
    id: 320,
    type: "SubgraphNode",
    subgraph,
    inputs: [{ name: "model_alias", _widget: railWidget, widget: { name: "model_alias" }, _subgraphSlot: { name: "model_alias" } }],
    widgets: [railWidget],
  };
  const resolveSource = (_n, si) =>
    si?.name === "model_alias" ? { sourceNodeId: "301", sourceWidgetName: "model" } : null;
  const set = applyWidgetWrite(parent, "model_alias", 4444, {
    ...HOOKS,
    resolveSource,
    acceptEmptyComboOptions: true,
  });
  assert.equal(set.value, "4444");
  assert.equal(railWidget.value, "4444", "admitted against the admission-time list, not a later answer");
});

test("#667×#507 (final gate): a sibling list with a THROWING later-index getter still admits an exact early member (no-adoption path unchanged)", () => {
  // includes() finds the exact match at index 0 and never touches the throwing
  // getter at index 1 — but a full-array snapshot copy WOULD. The snapshot must
  // be exception-safe so this legitimate write behaves exactly as before.
  const tricky = ["llama3.2:3b"];
  Object.defineProperty(tricky, "1", {
    get() {
      throw new Error("late getter boom");
    },
  });
  const { parent, inner, railWidget, resolveSource } = makeEmptyInnerPromotedFixture({ values: tricky });
  const set = applyWidgetWrite(parent, "model_alias", "llama3.2:3b", {
    ...HOOKS,
    resolveSource,
    acceptEmptyComboOptions: true,
  });
  assert.equal(set.value, "llama3.2:3b");
  assert.equal(railWidget.value, "llama3.2:3b");
  assert.equal(inner.widgets[0].value, "llama3.2:3b");
});

test("#667×#507 (final gate): an adoption that cannot be re-validated against a sibling (unreadable tail) fails closed — no false success", () => {
  // The rail strictly contains the requested "4444" at index 0, but its list
  // cannot be fully copied (throwing getter at index 1). The proxy then label-
  // adopts the NUMBER 4444, changing the write value — and the rail can no
  // longer be re-validated against it. Refuse, mutating nothing.
  const trickyRail = ["4444"];
  Object.defineProperty(trickyRail, "1", {
    get() {
      throw new Error("late getter boom");
    },
  });
  const { parent, inner, railWidget, proxyWidget, resolveSource } = makeEmptyInnerRailProxyFixture(trickyRail, [4444]);
  assert.throws(
    () =>
      applyWidgetWrite(parent, "model_alias", "4444", {
        ...HOOKS,
        resolveSource,
        acceptEmptyComboOptions: true,
      }),
    (err) => err instanceof WidgetWriteError && /could not be fully read/.test(err.message),
  );
  assert.equal(inner.widgets[0].value, "", "inner untouched");
  assert.equal(railWidget.value, "", "rail untouched");
  assert.equal(proxyWidget.value, "", "proxy untouched");
});

// ── #1126: "could not enumerate" is not "invalid value" ─────────────────────
//
// A dynamic combo's options come from `options.values(widget)` — the NODE's own callback.
// It can mutate the widget, and it can fail. When it fails, the panel has compared the
// value to NOTHING; the old code answered that with a refusal, and after set-widget.js's
// ladder gave up, the user read it as a verdict on their value. The reported shape was a
// custom node whose runtime handler takes an absolute .fbx path: the path was refused,
// and the only workaround was copying the file into ComfyUI's input directory.
//
// Both directions are load-bearing and both are decided from what was OBSERVED:
//   * list UNREADABLE → the valid set is not knowable here, so an opt-in LAST resort
//     writes it (non-empty string only) and says so.
//   * list READ, value absent → still refused. A typo'd model name must not become
//     writable just because the escape exists.
// No inference from option NAMES, no caller assertion about the node: the panel acts on
// whether its own read succeeded.

const ACCEPT_UNREADABLE = { ...HOOKS, acceptUnreadableComboOptions: true };

/** A combo whose options callback fails — the #1126 observation, in each shape it takes. */
function unreadableCombo(kind) {
  const values =
    kind === "threw"
      ? () => {
          throw new Error("node's own populate() blew up");
        }
      : kind === "not_a_list"
        ? () => undefined
        : undefined;
  return { name: "fbx_file", type: "combo", value: "", ...(values ? { options: { values } } : {}) };
}

test("#1126: an UNREADABLE option list accepts the path, and says the list could not be READ", () => {
  for (const kind of ["threw", "not_a_list", "absent"]) {
    const node = { id: 4, type: "FbxRenderer", widgets: [unreadableCombo(kind)] };
    // Default: still refused — and the refusal states the observation, never a verdict
    // about the value. That distinction is the whole bug: an agent that reads "not a
    // valid option" retries with different values forever.
    assert.throws(
      () => applyWidgetWrite(node, "fbx_file", String.raw`F:\Downloads\Scarlet1.0.fbx`, HOOKS),
      (err) =>
        err instanceof WidgetWriteError &&
        /option list could not be READ/.test(err.message) &&
        /nothing was compared/.test(err.message) &&
        !/is not a valid option/.test(err.message),
      `refusal must name the observation for the ${kind} shape`,
    );
    assert.equal(node.widgets[0].value, "", "the refusal must not have mutated the widget");

    // With the last-resort opt-in the write lands, and the reply discloses that NOTHING
    // validated it — a caller must not read this success as "the panel checked it".
    const out = applyWidgetWrite(
      node,
      "fbx_file",
      String.raw`F:\Downloads\Scarlet1.0.fbx`,
      ACCEPT_UNREADABLE,
    );
    assert.equal(out.value, String.raw`F:\Downloads\Scarlet1.0.fbx`);
    assert.equal(node.widgets[0].value, String.raw`F:\Downloads\Scarlet1.0.fbx`);
    assert.equal(out.option_list_unreadable, true, `unvalidated write disclosed for ${kind}`);
    // …and it reports WHICH observation, so a reply built from it cannot assert the
    // wrong reason. Three shapes, three distinct answers.
    assert.match(
      out.option_list_unreadable_detail,
      kind === "threw" ? /callback threw/ : kind === "not_a_list" ? /did not return a list/ : /could not be READ/,
      `the disclosed reason must match the ${kind} shape`,
    );
  }
});

test("#1126: a list that WAS read still refuses an off-list value — and says which happened", () => {
  // The direction that must not move. This combo's options were read successfully, so
  // the value is genuinely wrong: a model that is not installed, caught here instead of
  // 40 seconds into a run. The escape does not reach it, because the escape is keyed on
  // the panel's own failed read and this read succeeded.
  const mk = () => ({
    id: 9,
    type: "StarOllamaPromptHelper",
    widgets: [
      { name: "model", type: "combo", options: { values: () => ["qwen3-vl:8b", "llama3.2:3b"] }, value: "qwen3-vl:8b" },
    ],
  });
  for (const opts of [HOOKS, ACCEPT_EMPTY, ACCEPT_UNREADABLE]) {
    const node = mk();
    assert.throws(
      () => applyWidgetWrite(node, "model", "not-installed:70b", opts),
      (err) =>
        err instanceof WidgetWriteError &&
        /is not a valid option/.test(err.message) &&
        // …and it says the list WAS read, so the two failures never read alike.
        /option list WAS read successfully/.test(err.message) &&
        /rejected VALUE, not an unreadable list/.test(err.message),
    );
    assert.equal(node.widgets[0].value, "qwen3-vl:8b", "no mutation on the refusal");
  }
});

test("#1126: the options callback is INVOKED EXACTLY ONCE per write attempt", () => {
  // It is the node's own code and it commonly mutates the widget (repopulating the
  // dropdown), so a decision that re-reads to re-derive its own verdict both risks side
  // effects and can be answered differently the second time.
  let calls = 0;
  const node = {
    id: 11,
    type: "FbxRenderer",
    widgets: [
      {
        name: "fbx_file",
        type: "combo",
        value: "a.fbx",
        options: {
          values: () => {
            calls += 1;
            return ["a.fbx", "b.fbx"];
          },
        },
      },
    ],
  };
  applyWidgetWrite(node, "fbx_file", "b.fbx", HOOKS);
  assert.equal(calls, 1, "an accepted write reads the list once");

  calls = 0;
  assert.throws(() => applyWidgetWrite(node, "fbx_file", "nope.fbx", HOOKS), WidgetWriteError);
  assert.equal(calls, 1, "a refusal reads the list once — the message is built from that read");

  // And the UNREADABLE path does not probe a second time to work out why it failed.
  let failCalls = 0;
  const failing = {
    id: 12,
    type: "FbxRenderer",
    widgets: [
      {
        name: "fbx_file",
        type: "combo",
        value: "",
        options: {
          values: () => {
            failCalls += 1;
            throw new Error("boom");
          },
        },
      },
    ],
  };
  applyWidgetWrite(failing, "fbx_file", "C:/models/x.fbx", ACCEPT_UNREADABLE);
  assert.equal(failCalls, 1, "the failed read is described from the caught error, not re-run");
});

test("#1126: an unreadable list still refuses a NUMBER and an empty string", () => {
  // The list EXISTS on this widget; we simply could not read it. So #240's reason for
  // strict membership survives — a number could be reinterpreted as an index into the
  // list nobody could see — and #347's rule that clearing a combo to "" is refused must
  // not be reopened through a new door. No file path or model name is a number.
  for (const bad of [1, 0, 4444, true, false, ""]) {
    const node = { id: 5, type: "FbxRenderer", widgets: [unreadableCombo("threw")] };
    assert.throws(
      () => applyWidgetWrite(node, "fbx_file", bad, ACCEPT_UNREADABLE),
      (err) => err instanceof WidgetWriteError && /NON-EMPTY STRING/.test(err.message),
      `must stay refused even on the last resort: ${JSON.stringify(bad)}`,
    );
    assert.equal(node.widgets[0].value, "", "no mutation");
  }
  // An object was already refused as a non-scalar and stays so.
  const objNode = { id: 5, type: "FbxRenderer", widgets: [unreadableCombo("threw")] };
  assert.throws(() => applyWidgetWrite(objNode, "fbx_file", { p: "x" }, ACCEPT_UNREADABLE), WidgetWriteError);
});

test("#1126: a readable list wins first — the opt-in does not make every write unchecked", () => {
  // A caller that passes the last-resort flag defensively must not lose the guard for a
  // list the panel CAN read, nor be told the value went unvalidated when it did not.
  const node = {
    id: 6,
    type: "FbxRenderer",
    widgets: [{ name: "fbx_file", type: "combo", options: { values: () => ["a.fbx", "b.fbx"] }, value: "a.fbx" }],
  };
  const out = applyWidgetWrite(node, "fbx_file", "b.fbx", ACCEPT_UNREADABLE);
  assert.equal(out.value, "b.fbx");
  assert.equal(out.option_list_unreadable, undefined, "a listed value was validated normally");
});

test("#1126: the two acceptances are separate — neither implies the other", () => {
  // acceptEmptyComboOptions must not admit an unreadable list (it may be hiding a real,
  // non-empty one), and acceptUnreadableComboOptions must not admit an empty one (that
  // case has its own server-declaration gate in set-widget.js).
  const unreadable = { id: 7, type: "N", widgets: [unreadableCombo("threw")] };
  assert.throws(
    () => applyWidgetWrite(unreadable, "fbx_file", "x.fbx", ACCEPT_EMPTY),
    (err) => err instanceof WidgetWriteError && /option list could not be READ/.test(err.message),
  );
  const empty = { id: 8, type: "N", widgets: [{ name: "model", type: "combo", options: { values: [] }, value: "" }] };
  assert.throws(
    () => applyWidgetWrite(empty, "model", "x", ACCEPT_UNREADABLE),
    (err) => err instanceof WidgetWriteError && err.emptyOptions === true,
  );
});

test("#1126: the unreadable acceptance ARMS the rail cross-check but NEVER adopts a rail label", () => {
  // A promoted write assigns the same value to the parent's authoritative RAIL widget,
  // whose own list can be real and closed — so the #507 cross-check must run here too, or
  // an unvalidated value lands in the serialized parent graph.
  //
  // What it must NOT inherit is #667's label ADOPTION. That rule is justified by "the
  // inner list was EMPTY, so any scalar was admissible and the rail's own option is at
  // least as valid" — false when the inner list exists and merely could not be read.
  // Adopting there would write the rail's NUMBER 4444 onto a widget whose real, unread
  // list may not contain it, and would silently replace the string the caller sent.
  const inner = { id: 301, type: "FbxRenderer", widgets: [unreadableCombo("threw")] };
  inner.widgets[0].name = "model";
  const subgraph = { _nodes: [inner], getNodeById: (id) => (String(id) === "301" ? inner : null) };
  const railWidget = { name: "model_alias", type: "combo", options: { values: [4444] }, value: "" };
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

  assert.throws(
    () => applyWidgetWrite(parent, "model_alias", "4444", { ...ACCEPT_UNREADABLE, resolveSource }),
    (err) =>
      err instanceof WidgetWriteError &&
      /not a valid option for the parent subgraph/.test(err.message) &&
      // The message must describe the INNER observation truthfully. The empty-list
      // wording asserted "the inner widget's option list is empty" about a list nobody
      // had read — a statement the reader cannot act on because it is false.
      /inner widget's option list could not be READ/.test(err.message) &&
      !/inner widget's option list is empty/.test(err.message),
  );
  assert.equal(railWidget.value, "", "rail untouched — refused before any mutation");
  assert.equal(inner.widgets[0].value, "", "inner untouched");

  // The same shape lands when the rail's own list DOES contain the value: the rail
  // validated it, so the cross-check is satisfied rather than bypassed.
  const inner2 = { id: 301, type: "FbxRenderer", widgets: [unreadableCombo("threw")] };
  inner2.widgets[0].name = "model";
  const rail2 = { name: "model_alias", type: "combo", options: { values: ["4444"] }, value: "" };
  const parent2 = {
    id: 320,
    type: "SubgraphNode",
    subgraph: { _nodes: [inner2], getNodeById: (id) => (String(id) === "301" ? inner2 : null) },
    inputs: [
      { name: "model_alias", _widget: rail2, widget: { name: "model_alias" }, _subgraphSlot: { name: "model_alias" } },
    ],
    widgets: [rail2],
  };
  const out = applyWidgetWrite(parent2, "model_alias", "4444", { ...ACCEPT_UNREADABLE, resolveSource });
  assert.equal(out.value, "4444");
  assert.equal(rail2.value, "4444");
  assert.equal(inner2.widgets[0].value, "4444", "the caller's STRING, never a rail number");
  // …and that IS a validation, so it must be reported as one. See the dedicated test below.
  assert.equal(out.promoted_rail_validated, true);
});

test("#1126: a rail that VALIDATED the value is reported as having done so — the disclosure must not over-claim", () => {
  // The write is disclosed as "unvalidated" because the TARGET widget's own list could not
  // be read. On a promoted write that is only half the story: the sibling cross-check
  // compares the value against the parent rail's list when that list is readable and
  // non-empty, and proceeds ONLY on membership. So in exactly the case where the most
  // checking happened, a flat "nothing checked the value" is false — and on a change whose
  // entire value is telling the truth about what was and was not validated, an over-claimed
  // disclosure is worse than a missing one.
  const mkInner = () => {
    const w = unreadableCombo("threw");
    w.name = "model";
    return { id: 301, type: "FbxRenderer", widgets: [w] };
  };
  const mkParent = (inner, rail) => ({
    id: 320,
    type: "SubgraphNode",
    subgraph: { _nodes: [inner], getNodeById: (id) => (String(id) === "301" ? inner : null) },
    inputs: [
      { name: "model_alias", _widget: rail, widget: { name: "model_alias" }, _subgraphSlot: { name: "model_alias" } },
    ],
    widgets: [rail],
  });
  const resolveSource = (_node, subgraphInput) =>
    subgraphInput?.name === "model_alias" ? { sourceNodeId: "301", sourceWidgetName: "model" } : null;

  // Rail list READ, NON-EMPTY, CONTAINS the value ⇒ it validated it.
  const innerA = mkInner();
  const railA = { name: "model_alias", type: "combo", options: { values: ["a.fbx", "b.fbx"] }, value: "" };
  const outA = applyWidgetWrite(mkParent(innerA, railA), "model_alias", "b.fbx", {
    ...ACCEPT_UNREADABLE,
    resolveSource,
  });
  assert.equal(outA.option_list_unreadable, true, "the target widget's own list still could not be read");
  assert.equal(outA.promoted_rail_validated, true, "but the rail's list DID vouch for the value");

  // Rail list EMPTY ⇒ skipped by the cross-check, so it vouched for nothing. The field must
  // be ABSENT, not false: a reader that does not know it sees exactly what it saw before.
  const innerB = mkInner();
  const railB = { name: "model_alias", type: "combo", options: { values: [] }, value: "" };
  const outB = applyWidgetWrite(mkParent(innerB, railB), "model_alias", "b.fbx", {
    ...ACCEPT_UNREADABLE,
    resolveSource,
  });
  assert.equal(outB.option_list_unreadable, true);
  assert.equal(outB.promoted_rail_validated, undefined, "an empty rail list validates nothing");

  // A DIRECT (non-promoted) write has no rail at all — nothing checked it, and the
  // unqualified disclosure is the correct one.
  const direct = { id: 4, type: "FbxRenderer", widgets: [unreadableCombo("threw")] };
  direct.widgets[0].name = "model";
  const outC = applyWidgetWrite(direct, "model", "x.fbx", ACCEPT_UNREADABLE);
  assert.equal(outC.option_list_unreadable, true);
  assert.equal(outC.promoted_rail_validated, undefined, "no rail exists, so none validated anything");
});

test("#1126: a DISPLAY PROXY match does not claim the serializing RAIL validated the value", () => {
  // #477: one host input can reference TWO authenticated widgets — the AUTHORITATIVE rail
  // (`_widget`, what serializes at queue time) and a parent-facing DISPLAY proxy
  // (`input.widget`, a read-only mirror). The cross-check walks both. If it credited ANY
  // sibling match, a promotion whose rail list is empty but whose proxy list holds the value
  // would emit promoted_rail_validated — and the reply and the activity summary would both
  // say the serializing rail vouched for a value it never listed. Nothing that gets QUEUED
  // was checked, so the honest disclosure is the unqualified one.
  const inner = unreadableCombo("threw");
  inner.name = "model";
  const innerNode = { id: 301, type: "FbxRenderer", widgets: [inner] };
  // Rail: readable but EMPTY ⇒ the cross-check skips it, so it validated nothing.
  const rail = { name: "model_alias", type: "combo", options: { values: [] }, value: "" };
  // Display proxy: readable, non-empty, and it DOES contain the value.
  const proxy = { name: "model_alias", type: "combo", options: { values: ["b.fbx"] }, value: "" };
  const parent = {
    id: 320,
    type: "SubgraphNode",
    subgraph: { _nodes: [innerNode], getNodeById: (id) => (String(id) === "301" ? innerNode : null) },
    inputs: [{ name: "model_alias", _widget: rail, widget: proxy, _subgraphSlot: { name: "model_alias" } }],
    // BOTH must be live members of node.widgets, or identity authentication rejects them.
    widgets: [rail, proxy],
  };
  const out = applyWidgetWrite(parent, "model_alias", "b.fbx", {
    ...ACCEPT_UNREADABLE,
    resolveSource: (_n, si) =>
      si?.name === "model_alias" ? { sourceNodeId: "301", sourceWidgetName: "model" } : null,
  });
  // The write still lands and still syncs both projections — only the CLAIM is narrowed.
  assert.equal(
    out.promoted_from.display_widgets_synced,
    1,
    "the proxy is a real display projection, and was synced",
  );
  assert.equal(proxy.value, "b.fbx");
  assert.equal(rail.value, "b.fbx");
  assert.equal(out.option_list_unreadable, true);
  assert.equal(
    out.promoted_rail_validated,
    undefined,
    "a proxy match proves nothing about what gets queued — the rail listed nothing",
  );
});

test("#1126: readComboOptions reports WHICH observation, and comboOptions is unchanged", () => {
  // The verdict callers act on is data, not a prose match. `comboOptions` keeps its
  // null-means-unreadable contract so every pre-existing caller is untouched.
  const threw = unreadableCombo("threw");
  assert.deepEqual(
    { unreadable: readComboOptions(threw).unreadable, reason: readComboOptions(threw).reason },
    { unreadable: true, reason: "threw" },
  );
  assert.equal(readComboOptions(unreadableCombo("not_a_list")).reason, "not_a_list");
  assert.equal(readComboOptions(unreadableCombo("absent")).reason, "absent");
  const real = { name: "c", type: "combo", options: { values: () => ["a", "b"] }, value: "a" };
  assert.deepEqual(readComboOptions(real).options, ["a", "b"]);
  assert.equal(readComboOptions(real).unreadable, false);
  assert.equal(comboOptions(threw), null);
  assert.deepEqual(comboOptions(real), ["a", "b"]);
});
