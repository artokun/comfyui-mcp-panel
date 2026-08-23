// #1678 — graph_find_nodes must search the values that the live node exposes,
// while returning the normal summarizeNode-shaped result.
//
// This deliberately extracts and runs the shipped executor method. Testing a
// safe-stringify helper alone would miss the production seam where the method
// gets widget values from summarizeNode and projects the match into `matches`.
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

/** Brace-balanced extraction of a top-level function from the shipped panel. */
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

/** Extract one executor method, stopping at the next sibling method. */
function handlerBody(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) return null;
  const after = start + signature.length;
  const next = src.slice(after).match(/\n {2}(?:async )?[A-Za-z_][A-Za-z0-9_]*\s*\(/);
  const end = next ? after + next.index : src.length;
  return src.slice(start, end);
}

const PANEL_SOURCE = readFileSync(PANEL_JS, "utf8");

const summarizeNode = (() => {
  const source = namedFunctionSource(PANEL_SOURCE, "summarizeNode");
  assert.ok(source, "summarizeNode must remain present in the shipped panel");
  // eslint-disable-next-line no-new-func -- this runs the shipped production function.
  return new Function(
    "virtualFedInputs",
    "boundaryInputLabel",
    "displayLabel",
    "widgetLabelMap",
    "duplicateWidgetRows",
    "controlAfterGenerateModes",
    "drivenWidgetsFor",
    `${source}; return summarizeNode;`,
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

const graphFindNodes = (() => {
  const source = handlerBody(PANEL_SOURCE, "  graph_find_nodes({");
  assert.ok(source, "graph_find_nodes executor method must remain present");
  // eslint-disable-next-line no-new-func -- this runs the shipped production method.
  return new Function(
    "getGraphCtx",
    "LIMIT_CEILING",
    "summarizeNode",
    "nodeDescription",
    "describeActiveGraph",
    `return ({ ${source} }).graph_find_nodes;`,
  );
})();

function makeNode(id, value, { description = "", type = "MiniMaxH3Director" } = {}) {
  return {
    id,
    type,
    title: type,
    widgets: [{ name: "timeline_data", value }],
    inputs: [],
    outputs: [],
    constructor: { nodeData: { description } },
  };
}

function runFind(nodes, args) {
  const graph = { _nodes: nodes };
  const method = graphFindNodes(
    () => ({ graph }),
    200,
    summarizeNode,
    (node) => String(node?.constructor?.nodeData?.description ?? node?.description ?? ""),
    () => ({ scope: "root" }),
  );
  return method(args);
}

test("#1678 searches a raw STRING widget for a quoted substring", () => {
  const raw = '{"clips":[{"slot":2,"name":"Picture 2"}]}';
  const result = runFind([makeNode(1, raw)], {
    query: 'slot":2',
    widget_value: 'slot":2',
  });

  assert.equal(result.count, 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].widgets.timeline_data, raw);
  assert.deepEqual(
    result.matches[0].matched_on,
    [
      `widget_value:timeline_data=${raw}`,
      `widget_value:timeline_data=${raw}`,
    ],
  );
});

test("#1678 keeps JSON object and array widget values searchable", () => {
  const objectValue = { slot: 2, name: "object" };
  const arrayValue = [{ slot: 2, name: "array" }];
  const objectResult = runFind([makeNode(2, objectValue)], { query: 'slot":2' });
  const arrayResult = runFind([makeNode(3, arrayValue)], { widget_value: 'slot":2' });

  assert.equal(objectResult.count, 1);
  assert.deepEqual(objectResult.matches[0].widgets.timeline_data, objectValue);
  assert.equal(arrayResult.count, 1);
  assert.deepEqual(arrayResult.matches[0].widgets.timeline_data, arrayValue);
});

test("#1678 searches the complete large STRING before projecting the result", () => {
  const needle = '"slot":2';
  const raw = `${"x".repeat(9000)}${needle}`;
  const result = runFind(
    [makeNode(4, raw, { description: "d".repeat(400) })],
    { query: needle },
  );

  assert.equal(result.count, 1, "a match after the large-value prefix must not be lost");
  assert.equal(result.matches[0].description.length, 240, "description projection remains bounded");
  assert.deepEqual(
    result.matches[0].matched_on,
    [`widget_value:timeline_data=${"x".repeat(60)}`],
    "matched_on remains a short projection even when the full value was searched",
  );
});
