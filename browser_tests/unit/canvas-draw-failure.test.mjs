// #1108 — the screenshot that failed while diagnosing a frozen canvas.
//
// `graph_screenshot` fits the view and calls `canvas.draw(true, true)` — a
// synchronous redraw inside LiteGraph. When that threw, the panel surfaced the raw
// exception: "Cannot read properties of undefined (reading 'name')". The reporter
// was trying to screenshot a canvas that had frozen (pan/zoom/clicks dead during an
// LTX render), so the one tool that could have shown them the state is the one that
// failed, with a message that reads like a panel bug.
//
// It is not one, and it is not the graph or the backend: panel_get_errors and
// panel_graph_outline both answered correctly at that moment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  describeCanvasDrawFailure,
  isCanvasDrawFailure,
} from "../../web/js/lib/canvas-draw-failure.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

const REPORTED = new TypeError("Cannot read properties of undefined (reading 'name')");

test("#1108 the raw exception is preserved, not swallowed", () => {
  // The message is the only clue anyone has about WHICH draw failed; hiding it
  // behind a friendlier sentence would cost the next investigation.
  const text = describeCanvasDrawFailure(REPORTED);
  assert.match(text, /Cannot read properties of undefined \(reading 'name'\)/);
});

test("#1108 it says where the throw came from, and what still works", () => {
  const text = describeCanvasDrawFailure(REPORTED);
  assert.match(text, /threw while REDRAWING itself/);
  assert.match(text, /not from the graph or the backend/);
  // The two tools that DID work for the reporter, named so the next one uses them.
  assert.match(text, /panel_graph_outline/);
  assert.match(text, /panel_get_errors/);
});

test("#1108 it connects the failed screenshot to the frozen canvas", () => {
  // The reporter worked this out themselves, twice, before calling the tool. The
  // tool should not make them.
  const text = describeCanvasDrawFailure(REPORTED, { canvasReportedFrozen: true });
  assert.match(text, /same fault seen from two directions, not two problems/);
  assert.match(text, /That is what was reported here/);

  // …and when nobody has reported a freeze, it offers the connection conditionally
  // rather than asserting it.
  const unreported = describeCanvasDrawFailure(REPORTED);
  assert.match(unreported, /If the user reports that too/);
  assert.doesNotMatch(unreported, /That is what was reported here/);
});

test("#1108 it names the remedy and admits the panel cannot apply it", () => {
  const text = describeCanvasDrawFailure(REPORTED);
  assert.match(text, /hard refresh of the ComfyUI browser tab/);
  assert.match(text, /cannot repair the frontend's render state from here/);
  // Retrying is explicitly ruled out — the reporter would otherwise try it.
  assert.match(text, /will fail the same way until the tab is reloaded/);
  // And a refresh discards unsaved work, which must be said BEFORE they do it.
  assert.match(text, /Unsaved canvas work survives a refresh only if it was saved/);
});

test("#1108 it does not key on the message shape it happened to see", () => {
  // "reading 'name'" is one shape of this. Matching on it would let the next shape
  // through as an opaque TypeError again — which is the whole bug.
  assert.equal(isCanvasDrawFailure(new Error("something else entirely")), true);
  assert.equal(isCanvasDrawFailure("a string throw"), true);
  const other = describeCanvasDrawFailure(new Error("ctx.measureText is not a function"));
  assert.match(other, /ctx\.measureText is not a function/);
  assert.match(other, /threw while REDRAWING itself/);
});

test("#1108 an empty or absent throw still produces a usable message", () => {
  for (const bad of [undefined, null, new Error("")]) {
    const text = describeCanvasDrawFailure(bad);
    assert.match(text, /could not be taken/);
    assert.match(text, /hard refresh/);
  }
});

test("#1108 WIRING: the synchronous redraw is actually wrapped", () => {
  // The message is worthless if graph_screenshot still lets the raw throw out. The
  // behavioural tests above cannot see the call site, so this asserts it.
  const src = readFileSync(PANEL_JS, "utf8");
  const i = src.indexOf("graph_screenshot({ padding } = {}) {");
  assert.ok(i > 0, "graph_screenshot must exist");
  const body = src.slice(i, i + 6000);
  assert.match(body, /try \{\s*\n\s*canvas\.draw\(true, true\);/, "the redraw is inside a try");
  assert.match(body, /throw new Error\(describeCanvasDrawFailure\(err\)\)/, "and its throw is translated");
});
