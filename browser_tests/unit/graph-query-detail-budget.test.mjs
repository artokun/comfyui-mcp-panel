// #1681 — execute the shipped graph_query handler at its production seam. The test
// extracts the method from the panel bundle, then injects only the unrelated canvas
// binding/read dependencies so the real filtering, projection, capping, and response
// assembly run against a synthetic live graph.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  WIDGET_VALUE_CAP,
  DETAIL_WIDGET_VALUE_CEILING,
  COMPACT_VALUE_CLIP,
  clampDetailWidgetCap,
  capSummaryWidgets,
  clipCompactValue,
  clipLine,
  compactClipNote,
  drivenTag,
  drivenWidgetsFor,
  fitDetailLine,
  isLineProtected,
  truncationTail,
} from "../../web/js/lib/graph-read.js";
import { redactWidgetValue, REDACTED_WIDGET_VALUE } from "../../web/js/lib/widget-secret-redaction.js";

const PANEL_JS = join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js");
const source = readFileSync(PANEL_JS, "utf8");

/** Extract the shipped graph_query method from its object-literal seam. */
function methodSource(src, marker) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `missing shipped method: ${marker}`);
  const nextMethod = src.indexOf("\n  // Domain-aware, READ-ONLY audit", start);
  assert.ok(nextMethod > start, `missing method boundary: ${marker}`);
  const end = src.lastIndexOf("\n  },", nextMethod);
  assert.ok(end > start, `missing method close: ${marker}`);
  // Exclude the object-literal comma; the extracted method is reinserted into a
  // fresh object literal below. This boundary is deliberately anchored on the next
  // shipped executor rather than attempting to parse nested template expressions.
  return src.slice(start, end + 4);
}

const graph = {
  _groups: [],
  _nodes: [
    {
      id: 78,
      type: "MarkdownNote",
      title: "Clothing library",
      widgets: [{ name: "text", value: "prompt-" + "x".repeat(5000) }],
      inputs: [],
      outputs: [],
    },
    {
      id: 79,
      type: "MarkdownNote",
      title: "Second note",
      widgets: [{ name: "text", value: "second-" + "y".repeat(5000) }],
      inputs: [],
      outputs: [],
    },
    {
      id: 80,
      type: "MarkdownNote",
      title: "Ceiling note",
      widgets: [{ name: "text", value: "ceiling-" + "z".repeat(40000) }],
      inputs: [],
      outputs: [],
    },
    {
      id: 81,
      type: "MarkdownNote",
      title: "Escaped note",
      widgets: [{ name: "text", value: { prompt: '"'.repeat(3000), items: ["\\", '"', "\n"] } }],
      inputs: [],
      outputs: [],
    },
    {
      id: 82,
      type: "Credentialed Bypassed Node",
      title: "Credentialed Bypassed Node",
      mode: 4,
      widgets: [
        {
          name: "settings",
          value: {
            visible: "visible setting",
            api_key: "compact-api-key",
            nested: [{ privateKey: "compact-private-key" }, "Bearer abcdefghijklmnop"],
          },
        },
        { name: "prompt", value: "visible prompt" },
      ],
      inputs: [],
      outputs: [],
    },
  ],
};

// summarizeNode is kept deliberately small because its own production dependencies are
// unrelated to this budget seam. The graph_query method itself is the shipped source.
const summarizeNode = (node) => ({
  id: node.id,
  type: node.type,
  title: node.title,
  widgets: Object.fromEntries((node.widgets ?? []).map((w) => [w.name, w.value])),
});

const graphQuerySource = methodSource(source, "graph_query({");
const dependencyNames = [
  "getGraphCtx",
  "syncGraphNodeAreas",
  "readStoredLink",
  "summarizeNode",
  "summarizeGroup",
  "GROUPS_RIDER_CAP",
  "describeActiveGraph",
  "describeRails",
  "manualChangeSupersededRider",
  "clampDetailWidgetCap",
  "WIDGET_VALUE_CAP",
  "COMPACT_VALUE_CLIP",
  "MAX_CHARS_CEILING",
  "drivenWidgetsFor",
  "drivenTag",
  "virtualFedInputs",
  "virtualSourceTag",
  "capSummaryWidgets",
  "fitDetailLine",
  "isLineProtected",
  "truncationTail",
  "clipCompactValue",
  "clipLine",
  "compactClipNote",
  "redactWidgetValue",
];
const graphQuery = new Function(
  ...dependencyNames,
  `return ({ ${graphQuerySource} }).graph_query;`,
)(
  () => ({ graph, rootGraph: graph }),
  () => {},
  () => null,
  summarizeNode,
  () => ({}),
  200,
  () => ({ scope: "root" }),
  () => ({}),
  () => ({}),
  clampDetailWidgetCap,
  WIDGET_VALUE_CAP,
  COMPACT_VALUE_CLIP,
  60000,
  drivenWidgetsFor,
  drivenTag,
  () => ({}),
  () => "",
  capSummaryWidgets,
  fitDetailLine,
  isLineProtected,
  truncationTail,
  clipCompactValue,
  clipLine,
  compactClipNote,
  redactWidgetValue,
);

function detailRows(result) {
  return result.text
    .slice(result.text.indexOf("\n") + 1)
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

function query(args) {
  return graphQuery({ max_chars: 20000, ...args });
}

test("#1681 shipped graph_query keeps default detail at 2048 and raises one explicit id", () => {
  const defaultRead = query({ ids: [78], fields: "detail" });
  const raisedRead = query({ ids: [78], fields: "detail", widget_max_chars: 8192 });

  const defaultRow = detailRows(defaultRead)[0];
  const raisedRow = detailRows(raisedRead)[0];
  assert.match(defaultRow.widgets.text, /2048-char per-widget cap/);
  assert.equal(raisedRow.widgets.text, graph._nodes[0].widgets[0].value);
  assert.equal(Object.keys(defaultRead).join(","), Object.keys(raisedRead).join(","), "reply shape is unchanged");
  assert.equal(Object.keys(defaultRow).join(","), Object.keys(raisedRow).join(","), "detail row shape is unchanged");
});

test("#2314 detail rows explicitly classify ordinary and promoted nodes", () => {
  const ordinary = detailRows(query({ ids: [78], fields: "detail" }))[0];
  assert.equal(ordinary.is_subgraph, false);

  const promoted = {
    id: 83,
    type: "SubgraphNode",
    title: "Promoted rail",
    widgets: [{ name: "prompt_alias", value: "old" }],
    inputs: [],
    outputs: [],
    subgraph: { _nodes: [] },
  };
  graph._nodes.push(promoted);
  try {
    const row = detailRows(query({ ids: [83], fields: "detail" }))[0];
    assert.equal(row.is_subgraph, true);
  } finally {
    graph._nodes.pop();
  }
});

test("#1681 shipped graph_query ignores the raised cap for broad and multi-ID detail", () => {
  const broad = query({ fields: "detail", widget_max_chars: 8192 });
  const multi = query({ ids: [78, 79], fields: "detail", widget_max_chars: 8192 });
  assert.match(detailRows(broad)[0].widgets.text, /2048-char per-widget cap/);
  assert.deepEqual(
    detailRows(multi).map((row) => /2048-char per-widget cap/.test(row.widgets.text)),
    [true, true],
  );
});

test("#1681 shipped graph_query normalizes invalid/ceiling caps and keeps max_chars authoritative", () => {
  assert.match(
    detailRows(query({ ids: [78], fields: "detail", widget_max_chars: "bad" }))[0].widgets.text,
    /2048-char per-widget cap/,
  );
  const ceiling = detailRows(query({ ids: [80], fields: "detail", widget_max_chars: 1e9, max_chars: 60000 }))[0].widgets.text;
  assert.match(ceiling, new RegExp(`${DETAIL_WIDGET_VALUE_CEILING}-char per-widget cap`));

  const budgeted = query({ ids: [78], fields: "detail", widget_max_chars: 32768, max_chars: 5000 });
  assert.ok(budgeted.text.length <= 5000, `text must remain within max_chars, got ${budgeted.text.length}`);
  assert.match(budgeted.text, /over the `max_chars` budget/);
  assert.doesNotMatch(budgeted.text, /32768-char per-widget cap/);
});

test("#1681 shipped graph_query preserves a fitting quote-heavy object at the opt-in cap", () => {
  const row = detailRows(query({ ids: [81], fields: "detail", widget_max_chars: 8192 }))[0];
  assert.equal(typeof row.widgets.text, "object");
  assert.deepEqual(row.widgets.text, graph._nodes[3].widgets[0].value);
  assert.equal(JSON.stringify(row.widgets.text), JSON.stringify(graph._nodes[3].widgets[0].value));
});

test("#1729 shipped graph_query compact redacts nested secrets and preserves bypass/ordinary values", () => {
  const result = query({ ids: [82], fields: "compact" });
  const line = result.text.split("\n").find((entry) => entry.startsWith("#82 "));
  assert.ok(line, "the compact query must return the bypassed node");
  assert.match(line, /#82 Credentialed Bypassed Node \[bypass\]/);
  assert.match(line, /visible=|visible setting/);
  assert.match(line, /prompt=visible prompt/);
  assert.match(line, new RegExp(escapeRegex(REDACTED_WIDGET_VALUE)));
  assert.doesNotMatch(line, /compact-api-key|compact-private-key|Bearer abcdefghijklmnop/);
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
