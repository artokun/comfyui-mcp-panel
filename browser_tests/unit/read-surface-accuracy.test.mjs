/**
 * #1957 — read-surface accuracy: promised fields that never appear, write-only
 * attributes, and descriptions that undersell actual behaviour.
 *
 * Five gaps from a QA sweep (panel 0.15.114). None change fail-closed outcomes.
 * Each test fails on the unfixed wording/missing field and passes on the shipped
 * one. Drives the REAL summarizeNode / graph_serialize / graph_paste_nodes /
 * graph_auto_layout seams, not a reimplementation.
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
import { redactWidgetValue } from "../../web/js/lib/widget-secret-redaction.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const PANEL_SOURCE = readFileSync(PANEL_JS, "utf8");

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

function handlerBody(src, signature, { lead = 0 } = {}) {
  const start = src.indexOf(signature);
  if (start === -1) return null;
  const from = Math.max(0, start - lead);
  const after = start + signature.length;
  const next = src.slice(after).match(/\n {2}(?:async )?[A-Za-z_][A-Za-z0-9_]*\s*\(/);
  const end = next ? after + next.index : src.length;
  return src.slice(from, end);
}

const summarizeNode = (() => {
  const fn = namedFunctionSource(PANEL_SOURCE, "summarizeNode");
  assert.ok(fn, "summarizeNode not found in panel source");
  return new Function(
    "virtualFedInputs",
    "boundaryInputLabel",
    "displayLabel",
    "widgetLabelMap",
    "duplicateWidgetRows",
    "controlAfterGenerateModes",
    "drivenWidgetsFor",
    "redactWidgetValue",
    `${fn}; return summarizeNode;`,
  )(
    virtualFedInputs,
    boundaryInputLabel,
    displayLabel,
    widgetLabelMap,
    duplicateWidgetRows,
    controlAfterGenerateModes,
    drivenWidgetsFor,
    redactWidgetValue,
  );
})();

function node(over = {}) {
  return {
    id: 1,
    type: "KSampler",
    title: "KSampler",
    widgets: [],
    inputs: [],
    outputs: [],
    pos: [10, 20],
    size: [200, 100],
    ...over,
  };
}

test("#1957 detail rows always emit mode, including active (not omitted-as-default)", () => {
  // The unfixed emit was `...(node.mode ? { mode } : {})`, so mode 0 (active)
  // produced no field — the QA sweep never saw `mode` on any row.
  const src = namedFunctionSource(PANEL_SOURCE, "summarizeNode");
  assert.doesNotMatch(
    src,
    /\.\.\.\(node\.mode \? \{ mode:/,
    "mode must not be omitted when the node is active",
  );

  const active = summarizeNode(node({ mode: 0 }));
  assert.equal(active.mode, "active", "an ordinary node must name its mode");
  assert.equal(Object.prototype.hasOwnProperty.call(active, "mode"), true);

  const unset = summarizeNode(node());
  assert.equal(unset.mode, "active", "a missing LiteGraph mode is active, not absent");

  assert.equal(summarizeNode(node({ mode: 2 })).mode, "mute");
  assert.equal(summarizeNode(node({ mode: 4 })).mode, "bypass");
});

test("#1957 pinned and shape surface on the same reads collapsed does", () => {
  // view_selected / view_nodes_in_viewport / query_graph detail all map through
  // summarizeNode. collapsed already rode on that payload; pinned and shape did not,
  // so verifying a pin required a screenshot.
  assert.match(
    PANEL_SOURCE,
    /nodes: picked\.slice\(0, MAX_STATE_NODES\)\.map\(summarizeNode\)/,
    "view_selected must keep going through summarizeNode",
  );
  assert.match(
    PANEL_SOURCE,
    /const cap = visible\.slice\(0, MAX_STATE_NODES\)\.map\(summarizeNode\)/,
    "view_nodes_in_viewport must keep going through summarizeNode",
  );
  assert.match(
    PANEL_SOURCE,
    /\.\.\.capSummaryWidgets\(summarizeNode\(n\), detailWidgetCap, maxChars\)/,
    "query_graph detail must keep going through summarizeNode",
  );

  const pinned = summarizeNode(node({ flags: { pinned: true } }));
  assert.equal(pinned.pinned, true);
  const unpinned = summarizeNode(node({ flags: {} }));
  assert.equal(
    Object.prototype.hasOwnProperty.call(unpinned, "pinned"),
    false,
    "unpinned is omitted like collapsed:false, not a write-only hole",
  );

  const both = summarizeNode(node({ flags: { collapsed: true, pinned: true } }));
  assert.equal(both.collapsed, true);
  assert.equal(both.pinned, true);

  assert.equal(summarizeNode(node({ shape: "round" })).shape, "round");
  assert.equal(summarizeNode(node({ shape: "card" })).shape, "card");
  assert.equal(summarizeNode(node({ shape: 2 })).shape, "round", "numeric LiteGraph ROUND maps");
  assert.equal(summarizeNode(node({ shape: 4 })).shape, "card", "numeric LiteGraph CARD maps");
  assert.equal(
    Object.prototype.hasOwnProperty.call(summarizeNode(node()), "shape"),
    false,
    "default shape is omitted like collapsed:false",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(summarizeNode(node({ shape: "default" })), "shape"),
    false,
  );
});

test("#1957 outline and compact rows tag a pinned node so a pin is visible without detail", () => {
  const outline = handlerBody(PANEL_SOURCE, "graph_outline({");
  const query = handlerBody(PANEL_SOURCE, "graph_query({");
  assert.ok(outline, "graph_outline must exist");
  assert.ok(query, "graph_query must exist");
  const pinTag = /n\.flags && n\.flags\.pinned \? " \[pinned\]"/;
  assert.match(outline, pinTag, "outline modeTag must mark pinned nodes");
  assert.match(query, pinTag, "query compact modeTag must mark pinned nodes");
});

test("#1957 paste documents preserved internal wires — not a clean disconnected copy", () => {
  const body = handlerBody(PANEL_SOURCE, "graph_paste_nodes({", { lead: 500 });
  assert.ok(body, "graph_paste_nodes must exist");
  assert.doesNotMatch(
    body,
    /drops a disconnected copy/,
    "the unfixed wording told agents to re-wire internals that already survived",
  );
  assert.match(
    body,
    /Internal wires among the copied nodes are preserved/,
    "the comment must name the actual behaviour",
  );
  assert.match(
    body,
    /note:\s*\n?\s*"Internal wires among the copied nodes are preserved/,
    "the reply must carry the same claim so a description-only fix cannot silently regress",
  );
  assert.match(body, /connect_inputs: connect_inputs === true/, "echo the lever the note names");
});

test("#1957 graph_serialize is one JSON object, not two summary-then-graph blocks", () => {
  // panel_strip_workflow converts this capture. The command itself returns a
  // single `{ workflow, node_count }` — not the TWO text blocks the strip
  // description used to promise. Pin the shipped contract so a later edit
  // cannot reintroduce a two-block claim here.
  const body = handlerBody(PANEL_SOURCE, "graph_serialize()", { lead: 600 });
  assert.ok(body, "graph_serialize must exist");
  assert.match(body, /ONE JSON object/, "the capture must be documented as one JSON object");
  assert.match(body, /Not two blocks \(summary then graph\)/);
  assert.doesNotMatch(
    body,
    /TWO blocks — the summary/,
    "this command must not promise the strip tool's old two-block presentation",
  );
  assert.match(
    body,
    /return \{ workflow, node_count: workflow\?\.nodes\?\.length \?\? 0 \}/,
    "the payload is one object with workflow + node_count",
  );
});

test("#1957 auto-layout re-fit excludes pinned members rather than stretching the group", () => {
  const body = handlerBody(PANEL_SOURCE, "graph_auto_layout({", { lead: 600 });
  assert.ok(body, "graph_auto_layout must exist");
  assert.match(
    body,
    /excluded from group re-fit/,
    "the executor comment must name the pinned-outlier rule",
  );
  assert.match(
    body,
    /const movable = members\.filter\(\(n\) => !\(n\.flags && n\.flags\.pinned\)\)/,
    "re-fit must drop pinned members when any unpinned member remains",
  );
  assert.match(
    body,
    /re_fit_excluded_pinned: excludedPinned/,
    "the reply must name the pinned ids the box no longer wraps",
  );
});
