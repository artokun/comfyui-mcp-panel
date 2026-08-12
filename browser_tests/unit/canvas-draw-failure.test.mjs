// #1108 — the screenshot that failed while diagnosing a frozen canvas.
//
// `graph_screenshot` fits the view and calls `canvas.draw(true, true)` — a
// synchronous redraw inside LiteGraph. When that threw, the panel surfaced the raw
// exception: "Cannot read properties of undefined (reading 'name')". The reporter
// was trying to screenshot a canvas that had frozen (pan/zoom/clicks dead during an
// LTX render), so the one tool that could have shown them the state is the one that
// failed, with a message that reads like a panel bug.
//
// It is not obviously a panel bug — though this path sets the canvas transform to a
// computed fit before drawing, so the zoom it chose could be what exposes the fault.
// It is NOT safe to say it is not the graph either: a node
// or widget the renderer cannot draw throws here while panel_graph_outline reads that
// same node perfectly well — which is exactly what the reporter observed, and the
// likeliest lead. The first version of this message excluded the graph outright.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describeCanvasDrawFailure } from "../../web/js/lib/canvas-draw-failure.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

const REPORTED = new TypeError("Cannot read properties of undefined (reading 'name')");

test("#1108 the raw exception is preserved, not swallowed", () => {
  // The message is the only clue anyone has about WHICH draw failed; hiding it
  // behind a friendlier sentence would cost the next investigation.
  const text = describeCanvasDrawFailure(REPORTED);
  assert.match(text, /Cannot read properties of undefined \(reading 'name'\)/);
});

test("#1108 it says where the throw came from WITHOUT excluding the graph", () => {
  // codex review, P1: "not from the graph or the backend" is unsupported — a node or
  // widget the renderer cannot draw throws here while a graph READ of that same node
  // succeeds, which is the likeliest lead and the one that sentence sent you away from.
  const text = describeCanvasDrawFailure(REPORTED);
  assert.match(text, /threw while REDRAWING itself/);
  assert.match(text, /does NOT rule out the graph as its cause/);
  assert.doesNotMatch(text, /not from the graph or the backend/);
  // The two tools that DID work for the reporter, named so the next one uses them.
  assert.match(text, /panel_graph_outline/);
  assert.match(text, /panel_get_errors/);
  // codex round 5, P2: an outline names nodes regardless of fault, so "if either
  // names a node, look at it" pointed at every node in the graph.
  assert.match(text, /an outline names nodes whether or not one is at fault/);
});

test("#1108 it connects the failed screenshot to the frozen canvas", () => {
  // The reporter worked this out themselves, twice, before calling the tool. The
  // tool should not make them.
  const text = describeCanvasDrawFailure(REPORTED, { canvasReportedFrozen: true });
  assert.match(text, /worth treating as one fault rather than two/);
  // codex review, P1: shared timing is not a shared cause, and saying "the same
  // fault" asserted one.
  assert.match(text, /shared timing is not proof of a shared cause/);
  assert.doesNotMatch(text, /not two problems\./);

  const unreported = describeCanvasDrawFailure(REPORTED);
  assert.match(unreported, /If the user reports that too/);
  assert.doesNotMatch(unreported, /That was reported here/);
});

test("#1108 it names the remedy and admits the panel cannot apply it", () => {
  const text = describeCanvasDrawFailure(REPORTED);
  assert.match(text, /hard refresh of the ComfyUI browser tab/);
  assert.match(text, /cannot repair the frontend's render state from here/);
  // codex review, P2: offered as what cleared it, not as a promise — and the case
  // where it does NOT clear is named, because that is the informative one.
  //
  // Asserted on MEANING, not on the sentence. A literal match here ("the one report
  // of this") was tried and removed: a control mutation that changed nothing but
  // "report"→"reports" killed it, which is a test that punishes rewording rather
  // than protecting behaviour.
  assert.doesNotMatch(text, /will clear it|this will fix|guaranteed/i, "no promise is made");
  assert.match(text, /unlikely to succeed before then/, "retrying is discouraged, not forbidden");
  assert.match(text, /If a refresh does NOT clear it/, "and the informative case is named");
  // codex round 2, P1: "then the cause is in the graph" was a false dichotomy — a
  // persistent frontend issue, an extension, or other browser state survives a
  // reload without the graph being at fault.
  // codex round 3, P2: surviving a reload proves less than it looks — a render that
  // is still running can recreate the bad state immediately.
  assert.match(text, /proves less than it looks/);
  assert.match(text, /try it with the queue idle/);
  assert.match(text, /any extension that draws on the canvas/);
  // codex round 4, P2: naming those two as "what is left" was still an exhaustive
  // diagnosis — a stock ComfyUI or browser rendering defect produces this without
  // either being at fault.
  assert.match(text, /none of that is a shortlist, only a place to start/);
  assert.doesNotMatch(text, /are what is left to look at/);
  assert.doesNotMatch(text, /the cause is in the graph rather than/);
  // And a refresh discards unsaved work, which must be said BEFORE they do it.
  // codex round 5, P1: the warning used to sit AFTER the F5 recommendation, so a
  // reader acting top-to-bottom could refresh before reaching it.
  assert.match(text, /SAVE FIRST/);
  assert.ok(
    text.indexOf("SAVE FIRST") < text.indexOf("(F5)"),
    "the data-loss warning must precede the step that causes it",
  );
});

test("#1108 it does not key on the message shape it happened to see", () => {
  // "reading 'name'" is one shape of this. Matching on it would let the next shape
  // through as an opaque TypeError again — which is the whole bug. (A predicate that
  // "classified" throws was written and REMOVED: it returned true for anything and
  // would have misled a reader into thinking something was being distinguished.)
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
  assert.match(
    body,
    /throw new Error\(describeCanvasDrawFailure\(err\), \{ cause: err \}\)/,
    "its throw is translated, and the original is kept as `cause`",
  );
  // codex round 2, P1: the fit above moved the user's view, and the restore that
  // undoes it sits further down — so a throw jumped over it and a FAILED screenshot
  // left them zoomed into the framing it had chosen.
  const catchStart = body.indexOf("} catch (err) {");
  assert.ok(catchStart > 0, "the catch must exist");
  const catchBlock = body.slice(catchStart, catchStart + 900);
  assert.ok(
    catchBlock.includes("ds.scale = saved.scale"),
    "the user's view is restored before the failure is reported",
  );
});
