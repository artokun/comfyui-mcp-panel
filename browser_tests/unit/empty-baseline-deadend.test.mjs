// comfyui-mcp#803 — after a ComfyUI reconnect the agent was left with NO working
// recovery path.
//
//   panel_graph_outline  -> "the workflow reports 0 node(s), but the canvas is bound to
//                            a different graph ... Re-open the active workflow tab"
//   panel_list_workflows -> healthy: active_confirmed: true, active: true, persisted: true
//   panel_open_workflow  -> "could not prove that the active canvas was rebound"
//
// One tool says broken, one says fine, and the repair the error recommends is refused.
// The loop is documented in graph-binding.js for #701: the captured state is refreshed
// only after a command SUCCEEDS, so the refusal blocks the thing that would clear it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isEmptyBaselineMismatch,
  emptyBaselineNote,
  emptyBaselineRemedy,
} from "../../web/js/lib/empty-baseline-deadend.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("#803 the reporter's shape is recognised", () => {
  assert.equal(isEmptyBaselineMismatch({ expected: 0, live: 14 }), true);
});

test("#803 a NON-empty baseline is not this case", () => {
  // A real size disagreement between two populated graphs keeps the existing wording;
  // this fix must not swallow it.
  assert.equal(isEmptyBaselineMismatch({ expected: 3, live: 14 }), false);
  assert.equal(isEmptyBaselineMismatch({ expected: 14, live: 3 }), false);
});

test("#803 an empty CANVAS is not this case either", () => {
  // 0 live nodes means the canvas is empty; that is the opposite situation and the
  // empty-baseline reasoning does not apply.
  assert.equal(isEmptyBaselineMismatch({ expected: 0, live: 0 }), false);
  assert.equal(isEmptyBaselineMismatch({ expected: 5, live: 0 }), false);
});

test("#803 unmeasured sizes never trigger it", () => {
  for (const bad of [
    { expected: undefined, live: 14 },
    { expected: 0, live: undefined },
    { expected: null, live: 14 },
    { expected: 0, live: Number.NaN },
    {},
    undefined,
  ]) {
    assert.equal(isEmptyBaselineMismatch(bad), false, JSON.stringify(bad));
  }
});

test("#803 the note does NOT assert a different canvas", () => {
  // The whole defect: "cannot determine" was being rendered as "is not the case".
  const n = emptyBaselineNote(14);
  assert.doesNotMatch(n, /bound to a different graph/);
  assert.match(n, /does NOT establish a different canvas/);
  assert.match(n, /indistinguishable from here/);
});

test("#803 the note still says the command was not applied", () => {
  // Softening the claim must not soften the OUTCOME — nothing ran.
  assert.match(emptyBaselineNote(14), /was NOT applied/);
});

test("#803 the note names the real cause and the live count", () => {
  const n = emptyBaselineNote(14);
  assert.match(n, /14 node\(s\)/);
  assert.match(n, /captures a workflow's ?\n? ?state on user input/);
  assert.match(n, /reconnect or a ComfyUI restart/);
});

test("#803 the remedy names the step that WORKS", () => {
  const r = emptyBaselineRemedy();
  assert.match(r, /reload the panel/i);
  assert.match(r, /known to clear this/);
});

test("#803 the remedy warns that re-opening may not clear it", () => {
  // Recommending only that is what made this a dead end.
  const r = emptyBaselineRemedy();
  assert.match(r, /Re-opening the workflow may NOT/);
  assert.match(r, /only after a command SUCCEEDS/);
  assert.match(r, /the repair\s+that would refresh it is itself blocked/);
});

test("#803 the remedy warns about unsaved work BEFORE advising a reload", () => {
  // Review caught this as a data-loss risk, and it is: a reload discards unsaved graph
  // edits, and this is a READ refusing — nothing here is worth losing work over.
  const r = emptyBaselineRemedy();
  assert.match(r, /SAVE ANY UNSAVED CANVAS WORK FIRST/);
  assert.match(r, /discards unsaved graph edits/);
  // The warning must come before the instruction, not as a trailing footnote.
  assert.ok(r.indexOf("SAVE ANY UNSAVED") < r.indexOf("reload the panel"));
});

test("#803 the remedy does not swap one over-claim for another", () => {
  // The first cut removed "bound to a different graph" and then asserted "the canvas
  // really IS bound elsewhere" if a reload did not help — the same defect, in the fix
  // for it. A reload can fail to re-capture for other reasons.
  const r = emptyBaselineRemedy();
  assert.doesNotMatch(r, /really is bound elsewhere/);
  assert.match(r, /no longer\s+the likely explanation/);
  assert.match(r, /does not prove the canvas is bound elsewhere/);
});

test("#803 WIRING: the empty-baseline branch replaces claim AND remedy", () => {
  const src = readFileSync(join(ROOT, "web/js/lib/graph-binding.js"), "utf8");
  assert.match(src, /import \{[\s\S]*?isEmptyBaselineMismatch,[\s\S]*?\} from "\.\/empty-baseline-deadend\.js";/);
  assert.match(src, /const emptyBaseline = sizesDisagree && isEmptyBaselineMismatch\(\{ expected, live \}\)/);
  assert.match(src, /emptyBaseline\s*\n?\s*\? emptyBaselineNote\(live\)/);
  // The remedy must be REPLACED, not appended — the standing advice is the dead end.
  assert.match(src, /const finalRemedy = emptyBaseline \? emptyBaselineRemedy\(\) : remedy;/);
});

test("#803 WIRING: the ordinary size-disagreement wording survives", () => {
  // This fix is scoped to expected === 0. A real mismatch between two populated graphs
  // must still say what it always said.
  const src = readFileSync(join(ROOT, "web/js/lib/graph-binding.js"), "utf8");
  assert.match(src, /it is bound to a `? ?\+?\s*`?different graph/);
});

test("#803 WIRING: interpolated content is not reflowed", () => {
  // The empty `cause` in this branch was absorbed with a global whitespace collapse,
  // which also rewrote verdict.reason and the existing remedy — a disclosure regression
  // outside this change's stated scope (review). Non-empty parts are joined instead.
  //
  // Asserted with plain string containment: a regex spanning a line break here is how
  // this test got written wrong twice.
  const src = readFileSync(join(ROOT, "web/js/lib/graph-binding.js"), "utf8");
  assert.ok(
    !src.includes('.replace(\n    /\\s+/g,'),
    "the whole-message whitespace collapse must be gone",
  );
  assert.ok(src.includes("const parts = [emptyBaseline ? expectation :"));
  assert.ok(src.includes('parts.join(" ")'));
});
