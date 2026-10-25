// mcp#2988 — panel_set_widget misclassifies ImageFromBatch.length (a core INT) as an
// unrelated duration combo.
//
// On the reporter's canvas an extension keyed on the widget NAME had rebuilt the core
// ImageFromBatch `length` INT widget as a label dropdown (`custom`, `30 seconds`,
// `1 minute`, …). `isComboWidget` saw an `options.values` array, the write of the integer
// 16 was refused as an off-list combo value, and the refusal named duration presets no
// backend input accepts:
//
//   Value 16 is not a valid option for combo widget "length". Valid options: "custom",
//   "30 seconds", "1 minute", "1-2 minutes", "2-3 minutes", "3-4 minutes", "4-5 minutes".
//
// /object_info declares that input `["INT", {...}]`, and the queued prompt is validated
// against THAT, not against the canvas widget's shape. So runSetWidget now reads the freshly
// fetched server schema for the exact class + concrete input and hands it to every write
// attempt: a declared INT/FLOAT means a combo-shaped live widget is coerced and validated
// as a number — on the FIRST attempt, so one of the artifact's own labels is refused rather
// than written as a string into an INT input; anything else leaves the write exactly as it
// was.
//
// These tests drive the SHIPPED runSetWidget (the same async unit graph_set_widget delegates
// to) with the fresh-oracle capability wired the way the handler wires it, plus the two
// helpers it composes. Deleting the branch in set-widget.js, the `serverNumericType` option
// in widget-write.js, or the helper in input-asset.js fails them; the controls pin that a
// real combo (V1 or V2) and a snapshot-only schema still refuse exactly as before (#240).

import test from "node:test";
import assert from "node:assert/strict";

import { runSetWidget } from "../../web/js/lib/set-widget.js";
import { serverDeclaredNumericType } from "../../web/js/lib/input-asset.js";
import { coerceWidgetValue, WidgetWriteError } from "../../web/js/lib/widget-write.js";

const DURATION_LABELS = [
  "custom",
  "30 seconds",
  "1 minute",
  "1-2 minutes",
  "2-3 minutes",
  "3-4 minutes",
  "4-5 minutes",
];

// What /object_info publishes for core ImageFromBatch (ComfyUI 0.33).
const IMAGE_FROM_BATCH_DEFS = {
  ImageFromBatch: {
    input: {
      required: {
        image: ["IMAGE"],
        batch_index: ["INT", { default: 0, min: 0, max: 4095 }],
        length: ["INT", { default: 1, min: 1, max: 4096 }],
      },
    },
  },
};

function registry(types) {
  const reg = {};
  for (const t of types) {
    const ctor = function NodeCtor() {};
    ctor.nodeData = { input: { required: {} } };
    reg[t] = ctor;
  }
  return reg;
}

/** The reporter's node 38: a core INT widget an extension rebuilt as a label combo. */
function reporterNode() {
  return {
    id: 38,
    type: "ImageFromBatch",
    widgets: [
      { name: "batch_index", type: "number", value: 0, options: { min: 0, max: 4095 } },
      { name: "length", type: "combo", value: "custom", options: { values: DURATION_LABELS.slice() } },
    ],
    constructor: { nodeData: { input: { required: {} } } },
  };
}

const HOOKS = { beforeChange() {}, afterChange() {}, setDirty() {} };

function setWidgetOpts(defs, extra = {}) {
  const reg = registry(["ImageFromBatch"]);
  return {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => defs,
    ...HOOKS,
    ...extra,
  };
}

test("mcp#2988 the reporter's write lands: integer 16 into a backend-declared INT rendered as a label combo", async () => {
  const node = reporterNode();
  let refreshCalls = 0;
  const result = await runSetWidget(
    node,
    "length",
    16,
    setWidgetOpts(IMAGE_FROM_BATCH_DEFS, {
      refreshCombos: async () => {
        refreshCalls++;
      },
    }),
  );
  assert.equal(node.widgets[1].value, 16, "the number is what serializes into the queued prompt");
  assert.equal(result.applied, true);
  assert.equal(result.set.backend_declared_type, "INT", "the reply discloses WHICH schema admitted the value");
  assert.equal(result.set.frontend_widget_shape, "combo");
  assert.match(result.set.backend_type_note, /backend declares this input INT/);
  assert.equal(refreshCalls, 0, "the stale-combo ladder is not consulted — no refresh can turn labels into an integer");
});

test("mcp#2988 a numeric STRING is coerced to the number, as on any numeric widget", async () => {
  const node = reporterNode();
  const result = await runSetWidget(node, "length", "16", setWidgetOpts(IMAGE_FROM_BATCH_DEFS));
  assert.equal(node.widgets[1].value, 16);
  assert.equal(typeof node.widgets[1].value, "number");
  assert.equal(result.set.backend_declared_type, "INT");
});

test("mcp#2988 a FLOAT-declared input accepts a fraction", async () => {
  const node = reporterNode();
  node.type = "SomeFloatNode";
  const defs = {
    SomeFloatNode: { input: { required: { length: ["FLOAT", { default: 1.0, min: 0, max: 10 }] } } },
  };
  const reg = registry(["SomeFloatNode"]);
  const result = await runSetWidget(node, "length", 0.5, {
    registry: reg,
    getRegistry: () => reg,
    getFreshObjectInfo: async () => defs,
    ...HOOKS,
  });
  assert.equal(node.widgets[1].value, 0.5);
  assert.equal(result.set.backend_declared_type, "FLOAT");
});

test("mcp#2988 a NON-numeric value against a declared INT is refused TERMINALLY, naming the backend type", async () => {
  const node = reporterNode();
  let refreshCalls = 0;
  await assert.rejects(
    runSetWidget(
      node,
      "length",
      "sixteen",
      setWidgetOpts(IMAGE_FROM_BATCH_DEFS, {
        refreshCombos: async () => {
          refreshCalls++;
        },
      }),
    ),
    (err) => {
      assert.match(err.message, /panel_set_widget refused "length" on node 38 \(ImageFromBatch\)/);
      assert.match(err.message, /declared INT by the ComfyUI backend/);
      assert.match(err.message, /"sixteen" is not a number/);
      assert.doesNotMatch(err.message, /not a valid option for combo widget/, "no verdict against the artifact's label list");
      return true;
    },
  );
  assert.equal(node.widgets[1].value, "custom", "nothing was written");
  assert.equal(refreshCalls, 0, "a refresh cannot make a label an integer, so none is attempted");
});

test("mcp#2988 (gate P1) one of the artifact's OWN labels is refused too — it would serialize a string into an INT input", async () => {
  // Before the rework the backend type was consulted only AFTER a combo refusal, and a label
  // that IS on the live list never produces one: `"custom"` was accepted by ordinary combo
  // membership and written as a string into a backend INT. The decision now runs on the
  // first attempt, so the live label list is never the authority for a server-declared number.
  for (const label of ["custom", "30 seconds"]) {
    const node = reporterNode();
    node.widgets[1].value = "1 minute";
    let refreshCalls = 0;
    await assert.rejects(
      runSetWidget(
        node,
        "length",
        label,
        setWidgetOpts(IMAGE_FROM_BATCH_DEFS, {
          refreshCombos: async () => {
            refreshCalls++;
          },
        }),
      ),
      (err) => {
        assert.match(err.message, /declared INT by the ComfyUI backend/);
        assert.match(err.message, new RegExp(`${JSON.stringify(label)} is not a number`));
        return true;
      },
      `label ${label}`,
    );
    assert.equal(node.widgets[1].value, "1 minute", `nothing was written for ${label}`);
    assert.equal(refreshCalls, 0);
  }
});

// ---- CONTROLS: the #240 direction must not move --------------------------------------

test("mcp#2988 CONTROL: a server-declared V1 combo still refuses a number as off-list, wording unchanged", async () => {
  const node = reporterNode();
  const defs = { ImageFromBatch: { input: { required: { length: [DURATION_LABELS.slice(), {}] } } } };
  await assert.rejects(
    runSetWidget(node, "length", 16, setWidgetOpts(defs, { refreshCombos: async () => {} })),
    /not a valid option for combo widget "length"\. Its option list WAS read successfully and holds 7 options/,
  );
  assert.equal(node.widgets[1].value, "custom");
});

test("mcp#2988 CONTROL: a server-declared V2 combo (\"COMBO\", {options}) still refuses a number as off-list", async () => {
  const node = reporterNode();
  const defs = {
    ImageFromBatch: { input: { required: { length: ["COMBO", { options: DURATION_LABELS.slice() }] } } },
  };
  await assert.rejects(
    runSetWidget(node, "length", 16, setWidgetOpts(defs, { refreshCombos: async () => {} })),
    /not a valid option for combo widget "length"/,
  );
  assert.equal(node.widgets[1].value, "custom");
});

test("mcp#2988 CONTROL: a schema that does not describe the input fails CLOSED to the old ladder", async () => {
  // A snapshot-only def carries the type name and no `input` at all (#1223); it can
  // authorize the type but cannot say what the input is, so nothing is reclassified.
  const node = reporterNode();
  const defs = { ImageFromBatch: {} };
  await assert.rejects(
    runSetWidget(node, "length", 16, setWidgetOpts(defs, { refreshCombos: async () => {} })),
    /not a valid option for combo widget "length"/,
  );
  assert.equal(node.widgets[1].value, "custom");
});

test("mcp#2988 CONTROL: an ordinary combo-shaped STRING input (declared STRING) is untouched", async () => {
  const node = reporterNode();
  const defs = { ImageFromBatch: { input: { required: { length: ["STRING", { default: "custom" }] } } } };
  await assert.rejects(
    runSetWidget(node, "length", 16, setWidgetOpts(defs, { refreshCombos: async () => {} })),
    /not a valid option for combo widget "length"/,
  );
  assert.equal(node.widgets[1].value, "custom");
});

// ---- helper: serverDeclaredNumericType -------------------------------------------------

test("mcp#2988 serverDeclaredNumericType reads only the two literal scalar types, from required OR optional", () => {
  const defs = {
    N: {
      input: {
        required: {
          i: ["INT", { default: 1 }],
          f: ["FLOAT", { default: 1 }],
          v1: [["a", "b"], {}],
          v2: ["COMBO", { options: ["a", "b"] }],
          s: ["STRING", {}],
          bare: "INT",
        },
        optional: { oi: ["INT", {}] },
      },
    },
    Snapshot: {},
  };
  assert.equal(serverDeclaredNumericType(defs, "N", "i"), "INT");
  assert.equal(serverDeclaredNumericType(defs, "N", "f"), "FLOAT");
  assert.equal(serverDeclaredNumericType(defs, "N", "oi"), "INT");
  assert.equal(serverDeclaredNumericType(defs, "N", "v1"), null, "V1 combo: an array at spec[0]");
  assert.equal(serverDeclaredNumericType(defs, "N", "v2"), null, "V2 combo: the string COMBO");
  assert.equal(serverDeclaredNumericType(defs, "N", "s"), null);
  assert.equal(serverDeclaredNumericType(defs, "N", "bare"), null, "a non-array spec is not read");
  assert.equal(serverDeclaredNumericType(defs, "N", "missing"), null);
  assert.equal(serverDeclaredNumericType(defs, "Snapshot", "i"), null, "snapshot-only def has no input");
  assert.equal(serverDeclaredNumericType(defs, "Other", "i"), null);
  assert.equal(serverDeclaredNumericType(undefined, "N", "i"), null);
  assert.equal(serverDeclaredNumericType(defs, null, "i"), null);
  assert.equal(serverDeclaredNumericType(defs, "N", null), null);
});

// ---- helper: coerceWidgetValue option -------------------------------------------------

test("mcp#2988 coerceWidgetValue: the option routes a combo-shaped widget to numeric coercion and marks the reply", () => {
  const widget = { name: "length", type: "combo", value: "custom", options: { values: DURATION_LABELS.slice() } };
  const out = {};
  assert.equal(coerceWidgetValue(widget, 16, widget, null, { serverNumericType: "INT", out }), 16);
  assert.equal(out.serverNumericTypeUsed, "INT");
  assert.equal(coerceWidgetValue(widget, "2.5", widget, null, { serverNumericType: "FLOAT" }), 2.5);
  assert.throws(
    () => coerceWidgetValue(widget, "custom", widget, null, { serverNumericType: "INT" }),
    (err) => err instanceof WidgetWriteError && !err.combo && /declared INT by the ComfyUI backend/.test(err.message),
    "a label is refused as NOT A NUMBER — a non-retryable, non-combo refusal",
  );
});

test("mcp#2988 coerceWidgetValue: WITHOUT the option the live combo shape still decides (default unchanged)", () => {
  const widget = { name: "length", type: "combo", value: "custom", options: { values: DURATION_LABELS.slice() } };
  assert.throws(
    () => coerceWidgetValue(widget, 16, widget, null, {}),
    (err) => err instanceof WidgetWriteError && err.combo === true && /not a valid option for combo widget "length"/.test(err.message),
  );
  // And an unrelated value for the option does not loosen anything.
  assert.throws(
    () => coerceWidgetValue(widget, 16, widget, null, { serverNumericType: "STRING" }),
    (err) => err instanceof WidgetWriteError && err.combo === true,
  );
});

test("mcp#2988 coerceWidgetValue: the option touches ONLY a combo-shaped widget", () => {
  // A text widget on a server-declared INT (no such core case, but an extension could make
  // one) is deliberately left to its own shape: this fix is about the combo misclassification
  // and nothing wider.
  const textWidget = { name: "length", type: "text", value: "abc" };
  const out = {};
  assert.equal(coerceWidgetValue(textWidget, "abc", textWidget, null, { serverNumericType: "INT", out }), "abc");
  assert.equal(out.serverNumericTypeUsed, undefined);
  const boolWidget = { name: "length", type: "toggle", value: false };
  assert.equal(coerceWidgetValue(boolWidget, "true", boolWidget, null, { serverNumericType: "INT" }), true);
});

test("mcp#2988 coerceWidgetValue: an ORDINARY numeric widget does not carry the backend marker", () => {
  const widget = { name: "steps", type: "number", value: 20, options: { min: 1, max: 100 } };
  const out = {};
  assert.equal(coerceWidgetValue(widget, 30, widget, null, { serverNumericType: "INT", out }), 30);
  assert.equal(out.serverNumericTypeUsed, undefined, "the two agreed; nothing to disclose");
});
