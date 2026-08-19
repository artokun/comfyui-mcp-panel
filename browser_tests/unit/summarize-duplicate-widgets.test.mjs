/**
 * #1402 — summarizeNode last-wins-collapses widgets that share a name.
 *
 * Reported: rgthree's Fast Groups Bypasser names every toggle row
 * `RGTHREE_TOGGLE_AND_NAV`. A node rendering two rows both labelled
 * "Enable MODEL FL2" and both on was read by panel_query_graph
 * {fields:'detail'} as a single healthy-looking
 * `widgets: { RGTHREE_TOGGLE_AND_NAV: { toggled: false } }` — the last
 * row only. The duplicate was invisible, so the agent told the user the
 * node's data was correct when it was not.
 *
 * The name-keyed `widgets` map stays last-wins for addressing/back-compat.
 * When a name actually repeats, `duplicate_widgets` lists every occurrence
 * in canvas order. An unaffected node's payload omits the key entirely.
 *
 * Drives the shipped summarizeNode extracted from the panel, with the same
 * helpers it closes over in production — not a reimplementation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { displayLabel, boundaryInputLabel, widgetLabelMap } from "../../web/js/lib/slot-labels.js";
import { duplicateWidgetRows } from "../../web/js/lib/widget-rows.js";
import { virtualFedInputs } from "../../web/js/lib/virtual-source-promotion.js";
import { controlAfterGenerateModes } from "../../web/js/lib/control-after-generate.js";
import { drivenWidgetsFor } from "../../web/js/lib/graph-read.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const TOGGLE = "RGTHREE_TOGGLE_AND_NAV";
const BYPASSER = "Fast Groups Bypasser (rgthree)";

/** Brace-balanced extract so a later nested block cannot truncate the function. */
function namedFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const open = src.indexOf(") {", start) + 2;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

const summarizeNode = (() => {
  const src = readFileSync(PANEL_JS, "utf8");
  const fn = namedFunctionSource(src, "summarizeNode");
  assert.ok(fn, "summarizeNode not found in panel source");
  return new Function(
    "virtualFedInputs",
    "boundaryInputLabel",
    "displayLabel",
    "widgetLabelMap",
    "duplicateWidgetRows",
    "controlAfterGenerateModes",
    "drivenWidgetsFor",
    `${fn}; return summarizeNode;`,
  )(
    virtualFedInputs,
    boundaryInputLabel,
    displayLabel,
    widgetLabelMap,
    duplicateWidgetRows,
    controlAfterGenerateModes,
    drivenWidgetsFor,
  );
})();

/** The reporter's Fast Groups node: two toggle rows sharing one name. */
function bypasser(widgets) {
  return {
    id: 47,
    type: BYPASSER,
    title: BYPASSER,
    widgets,
    inputs: [],
    outputs: [],
  };
}

test("#1402 both Fast Groups toggle rows are visible, not last-wins collapsed", () => {
  const fl2 = { name: TOGGLE, label: "Enable MODEL FL2", value: { toggled: true } };
  const ref = { name: TOGGLE, label: "Enable MODEL REF", value: { toggled: false } };
  const node = bypasser([
    { name: "matchTitle", value: "^MODEL (FL2|REF)$" },
    fl2,
    ref,
  ]);

  const summary = summarizeNode(node);

  // Addressing map stays last-wins so existing callers still key by name.
  assert.equal(summary.widgets[TOGGLE], ref.value);

  const listed = summary.duplicate_widgets?.[TOGGLE];
  assert.ok(Array.isArray(listed), "a repeating name is signalled, not silently dropped");
  assert.equal(listed.length, 2, "every same-named row is listed");
  assert.equal(listed[0].value, fl2.value, "the first row's value is the widget's own value");
  assert.equal(listed[1].value, ref.value, "the last row's value is still listed, not only in the map");
  assert.equal(listed[0].label, fl2.label);
  assert.equal(listed[1].label, ref.label);
  // Canvas-order indices into node.widgets, so a reader can tell the rows apart.
  assert.equal(listed[0].index, 1);
  assert.equal(listed[1].index, 2);
});

test("#1402 a name that does not repeat omits duplicate_widgets entirely", () => {
  const node = bypasser([
    { name: "matchTitle", value: "^MODEL" },
    { name: "matchColors", value: "" },
  ]);
  const summary = summarizeNode(node);
  assert.equal("duplicate_widgets" in summary, false);
  assert.equal(summary.widgets.matchTitle, node.widgets[0].value);
  assert.equal(summary.widgets.matchColors, node.widgets[1].value);
});

test("#1402 index is the live widgets[] slot, not a filtered-name compact index", () => {
  const a = { name: TOGGLE, value: { toggled: true } };
  const b = { name: TOGGLE, value: { toggled: false } };
  const node = bypasser([
    { name: "matchTitle", value: "^MODEL" },
    { value: "unnamed preview" },
    a,
    b,
  ]);
  const listed = summarizeNode(node).duplicate_widgets[TOGGLE];
  assert.equal(listed.length, 2);
  assert.equal(node.widgets[listed[0].index], a);
  assert.equal(node.widgets[listed[1].index], b);
  assert.equal("label" in listed[0], false, "no invented label when the widget carries none");
  assert.equal("label" in listed[1], false);
});

test("#1402 a widget named __proto__ is reported, not thrown on", () => {
  // A widget name is arbitrary third-party data. Accumulating occurrences into a plain
  // object reads `bucket["__proto__"]` back as Object.prototype rather than a missing
  // key, so `(out[name] ??= []).push(…)` THROWS — and a throw here takes the WHOLE
  // node's detail with it, strictly worse than the collapsed read this field replaced.
  for (const name of ["__proto__", "constructor", "toString"]) {
    const node = bypasser([{ name, value: 1 }, { name, value: 2 }]);
    let summary;
    assert.doesNotThrow(() => {
      summary = summarizeNode(node);
    }, `summarizeNode must not throw on a widget named ${name}`);
    assert.deepEqual(
      summary.duplicate_widgets[name].map((r) => r.value),
      [1, 2],
      `${name} must come back as ordinary data`,
    );
    // It must survive the trip the payload actually makes — the detail line is
    // JSON.stringify'd before it is sent.
    assert.deepEqual(JSON.parse(JSON.stringify(summary.duplicate_widgets))[name].map((r) => r.value), [1, 2]);
  }
  assert.equal({}.polluted, undefined, "nothing leaked onto Object.prototype");
});
