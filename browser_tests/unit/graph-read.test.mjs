// Unit tests for the graph read helpers (web/js/lib/graph-read.js) backing
// panel_query_graph / panel_graph_outline.
//
//   #607 — link-driven widgets must be flagged so a read never reports a stale
//          stored value as if it were the value that executes.
//   #609 — one oversized widget blob (or several nodes) must not blow the whole
//          max_chars budget and return shown:0 for a node asked for by id.
import test from "node:test";
import assert from "node:assert/strict";

import {
  WIDGET_VALUE_CAP,
  linkDrivenWidgets,
  drivenWidgetsFor,
  drivenTag,
  capWidgetValue,
  capSummaryWidgets,
  clipLine,
  fitDetailLine,
  isLineProtected,
  truncationTail,
} from "../../web/js/lib/graph-read.js";

// ---- #607: link-driven widget detection -----------------------------------

// A node whose `steps` input is fed by a link from node 85 slot 0, but whose
// stored `steps` widget still says 30 (the classic Primitive/switch-rail case).
function ksamplerDrivenBySteps() {
  const graph = { links: { 7: { origin_id: 85, origin_slot: 0 } } };
  return {
    id: 3,
    type: "KSampler",
    graph,
    widgets: [
      { name: "steps", value: 30 },
      { name: "cfg", value: 4 },
    ],
    inputs: [
      { name: "model", type: "MODEL", link: null },
      { name: "steps", type: "INT", link: 7 }, // converted-to-input, link-driven
    ],
  };
}

test("linkDrivenWidgets names the overridden input and its source (#607)", () => {
  const map = linkDrivenWidgets(ksamplerDrivenBySteps());
  assert.deepEqual(map, { steps: { node_id: 85, output_slot: 0 } });
});

test("linkDrivenWidgets supports array-form links [id, slot, ...] (#607)", () => {
  const node = {
    graph: { links: { 9: [9, 42, 1, 3, 0, "INT"] } }, // [id, origin_id, origin_slot, ...]
    inputs: [{ name: "cfg", link: 9 }],
  };
  assert.deepEqual(linkDrivenWidgets(node), { cfg: { node_id: 42, output_slot: 1 } });
});

test("drivenWidgetsFor keeps only names that are real widgets (#607)", () => {
  const node = ksamplerDrivenBySteps();
  // `model` is a link-connected input but NOT a widget — must not appear.
  node.inputs[0].link = 11;
  node.graph.links[11] = { origin_id: 2, origin_slot: 0 };
  const only = drivenWidgetsFor(node, ["steps", "cfg"]);
  assert.deepEqual(only, { steps: { node_id: 85, output_slot: 0 } });
});

test("drivenWidgetsFor is empty when no widget input is link-connected", () => {
  const node = {
    graph: { links: {} },
    widgets: [{ name: "steps", value: 30 }],
    inputs: [{ name: "steps", type: "INT", link: null }],
  };
  assert.deepEqual(drivenWidgetsFor(node, ["steps"]), {});
});

test("linkDrivenWidgets never throws on malformed nodes", () => {
  assert.deepEqual(linkDrivenWidgets(null), {});
  assert.deepEqual(linkDrivenWidgets({}), {});
  assert.deepEqual(linkDrivenWidgets({ inputs: [{ name: "x", link: 5 }] }), {}); // no graph.links
  assert.deepEqual(linkDrivenWidgets({ graph: { links: {} }, inputs: [{ link: 5 }] }), {}); // no name
});

test("drivenTag renders a concise, honest annotation", () => {
  assert.equal(drivenTag({ node_id: 85, output_slot: 0 }), " [⚠ link-driven #85.0]");
  assert.equal(drivenTag(null), "");
});

// ---- #609: per-value widget cap -------------------------------------------

test("capWidgetValue leaves small values untouched (identity, any type)", () => {
  assert.equal(capWidgetValue(30), 30);
  assert.equal(capWidgetValue("euler"), "euler");
  assert.equal(capWidgetValue(null), null);
  const obj = { a: 1 };
  assert.equal(capWidgetValue(obj), obj, "small objects returned by reference");
});

test("capWidgetValue clips an oversized string and reports the drop (#609)", () => {
  const blob = "x".repeat(20000);
  const out = capWidgetValue(blob);
  assert.ok(out.length < blob.length, "clipped shorter than original");
  assert.ok(out.startsWith("x".repeat(1000)), "keeps the head");
  assert.match(out, /…\(\+\d+ chars, truncated\)$/, "reports how much was dropped");
  assert.ok(JSON.stringify(out).length <= WIDGET_VALUE_CAP, "ESCAPED size within the cap");
});

test("capWidgetValue bounds by ESCAPED size for control chars / surrogates (#609)", () => {
  // NUL escapes to 6 chars each (\\u0000); a raw-length cap would blow the budget.
  const nuls = String.fromCharCode(0).repeat(5000);
  const out = capWidgetValue(nuls, 600);
  assert.ok(JSON.stringify(out).length <= 600, `escaped size within cap, got ${JSON.stringify(out).length}`);
  assert.match(out, /truncated\)$/);
});

test("capWidgetValue clips oversized serialized objects (ResolutionMaster presets)", () => {
  const bigObj = { presets: Array.from({ length: 500 }, (_, i) => ({ i, name: `preset ${i}` })) };
  const out = capWidgetValue(bigObj);
  assert.equal(typeof out, "string");
  assert.ok(JSON.stringify(out).length <= WIDGET_VALUE_CAP, "escaped size within the cap");
  assert.match(out, /truncated\)$/);
});

test("capSummaryWidgets bounds every widget value without mutating the input (#609)", () => {
  const summary = { id: 1, type: "ResolutionMaster", widgets: { auto_detect_presets_json: "y".repeat(9000), steps: 20 } };
  const capped = capSummaryWidgets(summary);
  assert.notEqual(capped, summary, "returns a clone when something changed");
  assert.equal(summary.widgets.auto_detect_presets_json.length, 9000, "original untouched");
  assert.ok(capped.widgets.auto_detect_presets_json.length <= WIDGET_VALUE_CAP + 40);
  assert.equal(capped.widgets.steps, 20, "small values preserved");
});

test("capSummaryWidgets bounds the TOTAL widgets size, keeping valid JSON (#609)", () => {
  // 40 oversized widgets: per-value capping alone still yields ~40×2KB. The total
  // cap must drop overflow with an elision marker so one node can't blow the budget.
  const widgets = {};
  for (let i = 0; i < 40; i++) widgets[`w${i}`] = "z".repeat(5000);
  const capped = capSummaryWidgets({ id: 1, widgets }, WIDGET_VALUE_CAP, 3000);
  const json = JSON.stringify(capped);
  assert.doesNotThrow(() => JSON.parse(json), "result is still valid JSON");
  assert.ok(json.length < 3000 * 2, `bounded near totalCap, got ${json.length}`);
  assert.ok("…" in capped.widgets, "carries the elision marker");
  assert.ok(Object.keys(capped.widgets).length >= 2, "at least one real widget survives");
});

test("capSummaryWidgets keeps at least one widget even if it alone exceeds the total cap", () => {
  const capped = capSummaryWidgets({ id: 1, widgets: { blob: "x".repeat(20000), extra: 1 } }, WIDGET_VALUE_CAP, 500);
  assert.ok("blob" in capped.widgets, "the single huge widget still renders (per-value capped)");
  assert.match(capped.widgets.blob, /truncated\)$/);
});

test("capSummaryWidgets tightens the per-value cap to a SMALL total budget (#609)", () => {
  // totalCap 600 < WIDGET_VALUE_CAP: the single retained widget must be clipped to the
  // budget, so the serialized line stays near totalCap, not ~2KB.
  const capped = capSummaryWidgets({ id: 1, widgets: { blob: "q".repeat(5000) } }, WIDGET_VALUE_CAP, 600);
  assert.ok(JSON.stringify(capped).length < 600 * 2, "line bounded near the small budget");
  assert.match(capped.widgets.blob, /truncated\)$/);
});

test("capSummaryWidgets stays bounded on ESCAPE-HEAVY content at a small budget (#609)", () => {
  // Every char JSON-escapes to two; halving the effective cap keeps the escaped line
  // near the budget rather than doubling past it.
  const capped = capSummaryWidgets({ id: 1, widgets: { blob: '"'.repeat(5000) } }, WIDGET_VALUE_CAP, 600);
  assert.ok(JSON.stringify(capped).length < 600 * 2, `escaped line bounded, got ${JSON.stringify(capped).length}`);
});

test("fitDetailLine degrades an over-budget JSON line to a bounded valid-JSON stub (#609)", () => {
  const stub = { id: 42, type: "Hub", title: "x" };
  const huge = JSON.stringify({ id: 42, type: "Hub", widgets: {}, inputs: Array.from({ length: 5000 }, (_, i) => i) });
  const out = fitDetailLine(huge, stub, 800);
  assert.ok(out.length <= 800, `stub within budget, got ${out.length}`);
  assert.doesNotThrow(() => JSON.parse(out), "stub is valid JSON");
  assert.equal(JSON.parse(out).id, 42, "keeps the id so the row still identifies the node");
  assert.match(out, /detail_omitted/);
});

test("fitDetailLine leaves a within-budget line untouched (#609)", () => {
  const line = JSON.stringify({ id: 1, type: "KSampler", widgets: { steps: 20 } });
  assert.equal(fitDetailLine(line, { id: 1, type: "KSampler" }, 2000), line);
  assert.equal(fitDetailLine(line, { id: 1 }, Infinity), line, "no cap ⇒ unchanged");
});

test("fitDetailLine clips its OWN stub fields so the stub is ≤ max_chars (#609)", () => {
  // A pathologically long node id/type must not blow even the degraded stub.
  const huge = "y".repeat(20000);
  const out = fitDetailLine(huge, { id: "n".repeat(5000), type: "T".repeat(5000), title: "x".repeat(5000) }, 600);
  assert.ok(out.length <= 600, `stub self-bounded, got ${out.length}`);
  assert.doesNotThrow(() => JSON.parse(out), "still valid JSON");
});

test("clipLine bounds a plain compact line by length, leaving short lines intact (#609)", () => {
  assert.equal(clipLine("#1 KSampler · steps=20", 2000), "#1 KSampler · steps=20", "short line untouched");
  const huge = "#1 Wide · " + "k=v ".repeat(5000);
  const out = clipLine(huge, 2000);
  assert.ok(out.length <= 2000, `clipped to <= maxChars, got ${out.length}`);
  assert.ok(out.endsWith("…"), "carries an ellipsis marker");
  assert.equal(clipLine(huge, Infinity), huge, "no cap ⇒ unchanged");
});

test("capSummaryWidgets returns the same object when nothing needed capping", () => {
  const summary = { id: 1, widgets: { steps: 20, cfg: 4 } };
  assert.equal(capSummaryWidgets(summary), summary);
});

// The concrete #609 symptom: a single node with a huge widget blob must render.
test("a capped detail line for one huge-blob node fits a modest budget (#609)", () => {
  const summary = { id: 164, type: "ResolutionMaster", widgets: { auto_detect_presets_json: "x".repeat(20000) } };
  const before = JSON.stringify(summary);
  const after = JSON.stringify(capSummaryWidgets(summary));
  assert.ok(before.length > 7000, "raw detail exceeds the default single-node budget (reproduces shown:0)");
  assert.ok(after.length < 7000, "capped detail fits, so the requested node renders");
});

// ---- #609: budget protection + truncation message -------------------------

test("isLineProtected protects ONLY the first match (never shown:0), keeping the budget bound (#609)", () => {
  assert.equal(isLineProtected(0), true, "first line always renders, so matched≥1 ⇒ shown≥1");
  assert.equal(isLineProtected(1), false, "later lines stay budget-governed — output stays token-bounded");
  assert.equal(isLineProtected(9), false);
});

test("truncationTail advises raising max_chars when ids were explicit (#609)", () => {
  const withIds = truncationTail(1, 3, true);
  assert.match(withIds, /raise max_chars/);
  assert.doesNotMatch(withIds, /narrow with/, "no dead-end 'narrow with ids' advice");

  const noIds = truncationTail(5, 40, false);
  assert.match(noIds, /narrow with types\/where\/ids\/depth/);
});

// End-to-end shape: mirror the graph_query budget loop with the helpers to prove a
// single-id query with a pathological blob yields shown:1, not shown:0.
test("budget loop with helpers: one requested huge-blob node renders (shown:1) (#609)", () => {
  const matched = [{ id: 164, type: "ResolutionMaster", widgets: { blob: "x".repeat(20000) } }];
  const maxChars = 7000;
  let shown = 0, truncated = false, chars = 20;
  for (const n of matched) {
    const line = JSON.stringify(capSummaryWidgets({ id: n.id, type: n.type, widgets: n.widgets }));
    const protectedLine = isLineProtected(shown);
    if (!protectedLine && chars + line.length + 1 > maxChars) { truncated = true; break; }
    chars += line.length + 1;
    shown++;
  }
  assert.equal(shown, 1, "the node the caller asked for by id renders");
  assert.equal(truncated, false);
});

// The budget stays token-bounded: a large ids list is NOT wholesale-exempted (the
// codex P1 regression). Only the first over-budget line renders; the rest truncate.
test("budget loop stays bounded for a large ids list — only the first overflows (#609)", () => {
  const matched = Array.from({ length: 10 }, (_, i) => ({ id: i, widgets: { note: "y".repeat(1500) } }));
  const maxChars = 4000;
  let shown = 0, truncated = false, chars = 20;
  for (const n of matched) {
    const line = JSON.stringify(capSummaryWidgets({ id: n.id, widgets: n.widgets }));
    if (!isLineProtected(shown) && chars + line.length + 1 > maxChars) { truncated = true; break; }
    chars += line.length + 1;
    shown++;
  }
  assert.ok(shown >= 1 && shown < 10, `bounded: rendered ${shown} of 10, not all`);
  assert.equal(truncated, true, "the rest are honestly marked truncated");
});
