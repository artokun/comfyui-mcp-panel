// #2139 — the refusal recommended the one recovery that loses the work.
//
// The reporter had unsaved rewiring on a SAVED workflow, save already refused by
// the tracker-behind guard, and every panel mutation fenced off by a root-shape
// mismatch. The instance-mismatch refusal told them to "re-select the intended
// workflow with panel_open_workflow" — which re-reads from disk and discards the
// unsaved canvas. They called it a forbidden recovery path, and they were right.
//
// #1019 already special-cases the ACTIVE tab being UNSAVED (no path, so it cannot
// be re-opened at all). That is a different question: "can it?" rather than "what
// does it cost?". A saved tab with unsaved drift re-opens fine and loses the drift
// on the way, and nothing said so.
//
// The message is a pure function of its arguments (#968 pins that, because it is
// rebuilt with `new Function`), so it can be driven directly.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
);

/** Brace-balanced extraction, same approach the sibling suites use. */
function namedFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

const build = () => {
  const body = namedFunctionSource(SRC, "workflowInstanceMismatchMessage");
  assert.ok(body, "the message function is extractable");
  return new Function(`${body}; return workflowInstanceMismatchMessage;`)();
};

const base = { commandUuid: "aaa", activeUuid: "bbb" };

test("#2139 an active tab with unsaved changes warns that re-opening discards them", () => {
  const msg = build()({ ...base, activeIsModified: true });
  assert.match(msg, /UNSAVED changes/);
  assert.match(msg, /discarded/);
  // And points at the deadlock the reporter was actually in, by name.
  assert.match(msg, /panel#2139/);
});

test("#2139 it says nothing when the tab is not KNOWN to be modified", () => {
  // The negative reading is worthless: ComfyUI derives `isModified` from USER INPUT
  // captures, so a value a NODE wrote leaves it false while the canvas already
  // differs (#882). `false` is therefore not evidence that re-opening is safe, and
  // implying it would be the same defect pointing the other way.
  for (const activeIsModified of [null, undefined, false]) {
    const msg = build()({ ...base, activeIsModified });
    assert.ok(!/UNSAVED changes/.test(msg), `silent for ${String(activeIsModified)}`);
  }
});

test("#2139 the #1019 unsaved-tab note is untouched, and the two can co-occur", () => {
  const both = build()({ ...base, activeIsUnsaved: true, activeIsModified: true });
  assert.match(both, /cannot re-select/); // #1019's note
  assert.match(both, /UNSAVED changes/); // #2139's
  const onlyUnsaved = build()({ ...base, activeIsUnsaved: true });
  assert.match(onlyUnsaved, /cannot re-select/);
  assert.ok(!/UNSAVED changes/.test(onlyUnsaved));
});

test("#2139 the recommendation itself still stands for the ordinary case", () => {
  // The warning must not swallow the advice — for a saved, unmodified tab
  // panel_open_workflow IS the right recovery, which is why this is a note rather
  // than a removal.
  const msg = build()(base);
  assert.match(msg, /panel_open_workflow/);
  assert.ok(!/UNSAVED changes/.test(msg));
});

test("#2139 the reading is POSITIVE-only and takes no capture", () => {
  // A capture inside an error message is a mutation on a path that is already
  // failing. #882's capture helper exists for callers about to DISCARD a canvas;
  // this is not one.
  // The read now lives in the SHARED probe, because the primary dispatch fence
  // needed the same reading and was passing neither flag — see the wiring test below.
  const at = SRC.indexOf("function activeWorkflowSaveState()");
  assert.ok(at > -1, "the read moved — re-point this test");
  const block = SRC.slice(at, at + 900);
  assert.match(block, /active\.isModified === true \? true : null/);
  assert.ok(!/captureCanvasIntoTracker/.test(block), "the message path must not capture");
});
