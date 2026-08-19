/**
 * Unit tests for web/js/lib/widget-rows.js (#1402) — run with `node --test`.
 *
 * Reported: a Fast Groups Bypasser (rgthree) matching two groups rendered TWO toggle
 * rows on the canvas. rgthree names every one of those rows `RGTHREE_TOGGLE_AND_NAV`,
 * and summarizeNode keys widgets by name, so every `panel_query_graph {fields:'detail'}`
 * returned a single, healthy-looking entry:
 *
 *     "widgets": {"RGTHREE_TOGGLE_AND_NAV": {"toggled": false}},
 *     "widget_labels": {"RGTHREE_TOGGLE_AND_NAV": "Enable MODEL REF"}
 *
 * On the strength of that read the agent told the user the node's data was correct and
 * only the canvas draw was stale — the opposite of the truth — and shipped a fix that
 * could not work. The collapsed map carried no hint that a second row existed, so the
 * wrong state was undetectable short of a screenshot.
 *
 * What is pinned here, in both directions:
 *   - every occurrence of a repeated name is reported, in canvas order, with its OWN
 *     value and label (the reported bug), and
 *   - a node whose widget names are unique reports NOTHING extra. That is what keeps
 *     the common node's payload byte-identical, and it is the half that stops the new
 *     key from becoming noise on every read.
 *
 * The name-keyed `widgets` map is deliberately left alone: it is the identity
 * panel_set_widget addresses, and re-shaping it would break every caller to fix a case
 * most nodes never hit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { duplicateWidgetRows } from "../../web/js/lib/widget-rows.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

/** The reported node: two rgthree group-toggle rows sharing ONE name. */
const rgthreeNode = () => ({
  widgets: [
    { name: "RGTHREE_TOGGLE_AND_NAV", label: "Enable MODEL FL2", value: { toggled: true } },
    { name: "RGTHREE_TOGGLE_AND_NAV", label: "Enable MODEL REF", value: { toggled: false } },
  ],
});

test("#1402: both rgthree toggle rows are reported, not just the one the map kept", () => {
  const dup = duplicateWidgetRows(rgthreeNode());
  assert.deepEqual(dup, {
    RGTHREE_TOGGLE_AND_NAV: [
      { index: 0, label: "Enable MODEL FL2", value: { toggled: true } },
      { index: 1, label: "Enable MODEL REF", value: { toggled: false } },
    ],
  });
  // The precise failure that cost the reporter: the name-keyed read showed toggled:false
  // for the whole node while a row sat toggled:true. Both states are now visible.
  const rows = dup.RGTHREE_TOGGLE_AND_NAV;
  assert.equal(rows.length, 2, "the row COUNT is what the collapsed map could never give");
  assert.deepEqual(
    rows.map((r) => r.value.toggled),
    [true, false],
  );
});

test("#1402: unique widget names report NOTHING — the common node is unchanged", () => {
  // This is what keeps `duplicate_widgets` off an ordinary node's payload entirely.
  assert.deepEqual(
    duplicateWidgetRows({
      widgets: [
        { name: "seed", value: 1 },
        { name: "steps", value: 20 },
        { name: "cfg", value: 8 },
      ],
    }),
    {},
  );
  assert.deepEqual(duplicateWidgetRows({ widgets: [] }), {});
  assert.deepEqual(duplicateWidgetRows({}), {});
  assert.deepEqual(duplicateWidgetRows(null), {});
  assert.deepEqual(duplicateWidgetRows(undefined), {});
});

test("#1402: only the REPEATED names are reported, never the unique ones beside them", () => {
  const dup = duplicateWidgetRows({
    widgets: [
      { name: "seed", value: 1 },
      { name: "RGTHREE_TOGGLE_AND_NAV", value: { toggled: true } },
      { name: "steps", value: 20 },
      { name: "RGTHREE_TOGGLE_AND_NAV", value: { toggled: false } },
    ],
  });
  assert.deepEqual(Object.keys(dup), ["RGTHREE_TOGGLE_AND_NAV"]);
  // `index` is the position in node.widgets — the order the canvas renders the rows —
  // so it stays true across the unique widgets interleaved between the duplicates.
  assert.deepEqual(
    dup.RGTHREE_TOGGLE_AND_NAV.map((r) => r.index),
    [1, 3],
  );
});

test("#1402: occurrences are in CANVAS order, so the last is the one `widgets` kept", () => {
  // The contract a caller reasons with: `widgets[name]` holds the final occurrence, and
  // everything before it is what the map dropped. Order is therefore load-bearing, not
  // incidental — a set or a sorted map would break it.
  const dup = duplicateWidgetRows({
    widgets: [
      { name: "mode", value: "first" },
      { name: "mode", value: "second" },
      { name: "mode", value: "third" },
    ],
  });
  assert.deepEqual(
    dup.mode.map((r) => r.value),
    ["first", "second", "third"],
  );
  // Mirror the name-keyed build summarizeNode runs and confirm the claim holds.
  const widgets = {};
  for (const w of [
    { name: "mode", value: "first" },
    { name: "mode", value: "second" },
    { name: "mode", value: "third" },
  ]) {
    widgets[w.name] = w.value;
  }
  assert.equal(widgets.mode, dup.mode.at(-1).value);
});

test("#1402: identical rows are NOT collapsed — two of them IS the reported symptom", () => {
  // The user's canvas rendered two rows that looked the same. De-duplicating equal
  // occurrences here would hide exactly the state this exists to surface.
  const dup = duplicateWidgetRows({
    widgets: [
      { name: "RGTHREE_TOGGLE_AND_NAV", label: "Enable MODEL FL2", value: { toggled: true } },
      { name: "RGTHREE_TOGGLE_AND_NAV", label: "Enable MODEL FL2", value: { toggled: true } },
    ],
  });
  assert.equal(dup.RGTHREE_TOGGLE_AND_NAV.length, 2);
});

test("#1402: each occurrence carries its OWN label, under #636's rules", () => {
  const dup = duplicateWidgetRows({
    widgets: [
      // No label carried ⇒ no `label` key. Never invented, same as #636.
      { name: "dup", value: 1 },
      // A label equal to the name is not a rename and is not emitted.
      { name: "dup", label: "dup", value: 2 },
      // Surrounding whitespace is trimmed; a real rename survives.
      { name: "dup", label: "  Real Rename  ", value: 3 },
    ],
  });
  assert.deepEqual(dup.dup, [
    { index: 0, value: 1 },
    { index: 1, value: 2 },
    { index: 2, label: "Real Rename", value: 3 },
  ]);
});

test("#1402: malformed widgets are skipped, matching the name-keyed map's own filter", () => {
  // The map summarizeNode builds keeps `typeof w.name === "string"` and nothing else, so
  // this must report duplicates of exactly the names that map can collapse. A nameless
  // widget can never collide, and counting one would report a duplicate that is not one.
  const dup = duplicateWidgetRows({
    widgets: [
      null,
      { value: "no name at all" },
      { name: 42, value: "non-string name" },
      { name: "dup", value: "a" },
      undefined,
      { name: "dup", value: "b" },
    ],
  });
  assert.deepEqual(Object.keys(dup), ["dup"]);
  // Indices still point into node.widgets, past the malformed entries.
  assert.deepEqual(
    dup.dup.map((r) => r.index),
    [3, 5],
  );
});

test("#1402: a widget named `__proto__` is reported, not thrown on", () => {
  // A widget name is arbitrary third-party data. Bucketing into a plain object reads
  // `bucket["__proto__"]` back as Object.prototype rather than a missing key, so the
  // obvious `(out[name] ??= []).push(…)` throws — and a throw here takes the WHOLE
  // node's detail with it, which is strictly worse than the collapsed read this
  // replaces. Every one of these must come back as ordinary data.
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    const node = { widgets: [{ name, value: 1 }, { name, value: 2 }] };
    let dup;
    assert.doesNotThrow(() => {
      dup = duplicateWidgetRows(node);
    }, `duplicateWidgetRows must not throw on a widget named ${name}`);
    assert.deepEqual(Object.keys(dup), [name], `${name} must be an OWN key`);
    assert.deepEqual(dup[name].map((r) => r.value), [1, 2]);
    // It must survive the trip the payload actually makes, as data and not as a
    // prototype mutation — the detail line is JSON.stringify'd before it is sent.
    assert.deepEqual(JSON.parse(JSON.stringify(dup))[name].map((r) => r.value), [1, 2]);
  }
  // …and no such name leaks onto the prototype of anything.
  assert.equal({}.polluted, undefined);
  assert.deepEqual(duplicateWidgetRows({ widgets: [{ name: "__proto__", value: 1 }] }), {});
});

test("#1402: summarizeNode ACTUALLY emits this — the helper must not sit unwired", () => {
  // Without this the helper above could be perfectly correct and reach no caller, which
  // is indistinguishable from the bug. summarizeNode backs panel_query_graph
  // (fields:'detail') and panel_get_subgraph — the reads the report was filed against.
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /import \{ duplicateWidgetRows \} from "\.\/lib\/widget-rows\.js"/);
  assert.match(
    src,
    /const duplicateWidgets = duplicateWidgetRows\(node\);/,
    "summarizeNode computes the duplicate rows",
  );
  assert.match(
    src,
    /duplicate_widgets: duplicateWidgets/,
    "summarizeNode emits them on the payload",
  );
});

test("#1402: the OUTLINE labels each widget from the widget, not from a last-wins map", () => {
  // graph_outline renders one token per entry of the widgets ARRAY, so it always showed
  // both rgthree rows — but it looked their label up in `widgetLabelMap(n)[w.name]`,
  // which is last-wins. Two different group toggles were therefore both annotated
  // `[renamed "Enable MODEL REF"]`: the outline stated they were the same toggle.
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(
    src,
    /const label = displayLabel\(w\);/,
    "the outline reads the label off the widget itself",
  );
  assert.doesNotMatch(
    src,
    /widgetLabelMap\(n\)/,
    "no per-widget outline lookup may go back through the name-keyed map",
  );
  // summarizeNode's own `widget_labels` map is name-keyed BY CONTRACT (#636) and stays —
  // duplicate_widgets is what carries the labels it cannot hold.
  assert.match(src, /const widgetLabels = widgetLabelMap\(node\);/);
});
