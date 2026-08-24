// #1729 — execute the production graph_outline rendering fragment. A helper-only
// test would miss the direct outline path, which formats live widget values itself
// instead of going through summarizeNode.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { displayLabel } from "../../web/js/lib/slot-labels.js";
import { redactWidgetValue, REDACTED_WIDGET_VALUE } from "../../web/js/lib/widget-secret-redaction.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

function handlerBody(src, sig) {
  const start = src.indexOf(sig);
  assert.notEqual(start, -1, `${sig} must exist`);
  const after = start + sig.length;
  const next = src.slice(after).match(/\n {2}(?:async )?[A-Za-z_][A-Za-z0-9_]*\s*\(/);
  return src.slice(start, next ? after + next.index : src.length);
}

function productionFormatter(body) {
  const start = body.indexOf("const fmtVal = (v, node, widgetName) => {");
  const end = body.indexOf("const modeTag", start);
  assert.ok(start >= 0 && end > start, "the outline formatter must remain in the production handler");
  const source = body.slice(start, end);
  return new Function(
    "redactWidgetValue",
    "NOTE_NODE_TYPES",
    `let outlineClipped = 0; let outlineClippedNoteIds = []; ${source}; return fmtVal;`,
  )(redactWidgetValue, new Set(["Note", "MarkdownNote"]));
}

function productionRenderNodeLines(body, fmtVal, node) {
  const start = body.indexOf("const renderNodeLines = (level) => {");
  const end = body.indexOf("// The FLOOR rung", start);
  assert.ok(start >= 0 && end > start, "the outline node renderer must remain in the production handler");
  const source = body.slice(start, end);
  const sorted = [node];
  const byId = new Map([[node.id, node]]);
  const render = new Function(
    "sorted",
    "byId",
    "groupOf",
    "title_",
    "controlAfterGenerateEntries",
    "drivenWidgetsFor",
    "virtualFedInputs",
    "displayLabel",
    "virtualSourceTag",
    "drivenTag",
    "fmtVal",
    "modeTag",
    "outTag",
    "readStoredLink",
    "liveLinkTargetInput",
    "graph",
    `${source}; return renderNodeLines;`,
  )(
    sorted,
    byId,
    new Map(),
    (value) => String(value ?? ""),
    () => [],
    () => ({}),
    () => ({}),
    displayLabel,
    () => "",
    () => "",
    fmtVal,
    (n) => ({ 2: " [mute]", 4: " [bypass]" }[n.mode] ?? ""),
    (n) => (n.constructor?.nodeData?.output_node ? " [OUTPUT]" : ""),
    () => null,
    () => null,
    { links: {} },
  );
  return render("full");
}

test("#1729 graph_outline redacts a bypassed API-key widget in its live node renderer", () => {
  const body = handlerBody(readFileSync(PANEL_JS, "utf8"), "graph_outline({");
  assert.match(body, /fmtVal\(w\.value, n, w\.name\)/, "the outline passes the widget name to its formatter");

  const secret = "live-api-key-should-never-reach-the-outline-1234567890";
  const node = {
    id: 1729,
    type: "GPT Image",
    title: "GPT Image",
    mode: 4,
    widgets: [
      { name: "api_key", value: secret },
      { name: "prompt", value: "visible prompt" },
    ],
    inputs: [],
    outputs: [],
  };
  const lines = productionRenderNodeLines(body, productionFormatter(body), node);
  assert.equal(lines.length, 1, "the bypassed node remains in the outline");
  assert.match(lines[0], /1729  GPT Image \[bypass\]/, "bypass semantics remain visible");
  assert.match(lines[0], new RegExp(`api_key="?${escapeRegex(REDACTED_WIDGET_VALUE)}"?`));
  assert.match(lines[0], /prompt=visible prompt/, "ordinary visible widget values remain intact");
  assert.ok(!lines.join("\n").includes(secret), "the credential is absent from the outline text");
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
