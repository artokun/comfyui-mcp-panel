import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameInstanceRename } from "../../web/js/lib/workflow-route-change.js";

/**
 * #1261 — a rename must not read as a workflow SWITCH.
 *
 * Renaming the active saved workflow moves its route id wf:<old> → wf:<new> on the
 * SAME live workflow object. The panel's poll used to announce every route-id change
 * as "the user switched the open workflow", so a rename read as a switch to a
 * different workflow identity and sent the agent re-reading the canvas it was still
 * bound to. The discriminator is the object, never the path text.
 */

test("the reporter's case: same live object, wf:→wf: id change — a rename, not a switch", () => {
  assert.equal(
    isSameInstanceRename({
      sameWorkflowObject: true,
      previousRouteId: "wf:Untitled 2026-08-15 14-11-07",
      newRouteId: "wf:Krea2",
    }),
    true,
  );
});

test("a genuine tab switch arrives on a DIFFERENT object — never a rename", () => {
  // Two tabs can legitimately show the same file, so the path text cannot decide
  // this. Only the object comparison can, and here it says: different workflow.
  assert.equal(
    isSameInstanceRename({
      sameWorkflowObject: false,
      previousRouteId: "wf:old",
      newRouteId: "wf:new",
    }),
    false,
  );
});

test("an unproven object comparison fails closed — not a rename", () => {
  assert.equal(
    isSameInstanceRename({
      sameWorkflowObject: undefined,
      previousRouteId: "wf:old",
      newRouteId: "wf:new",
    }),
    false,
  );
  assert.equal(
    isSameInstanceRename({ previousRouteId: "wf:old", newRouteId: "wf:new" }),
    false,
  );
});

test("a first save (tmp:→wf:) is NOT a rename — the adopt case owns that shape", () => {
  assert.equal(
    isSameInstanceRename({
      sameWorkflowObject: true,
      previousRouteId: "tmp:6f2c1d4e-9b7a-4c1e-8d3f-2a5b7c9d1e2f",
      newRouteId: "wf:Krea2",
    }),
    false,
  );
});

test("an UNSAVED canvas never renames (tmp:→tmp:)", () => {
  assert.equal(
    isSameInstanceRename({
      sameWorkflowObject: true,
      previousRouteId: "tmp:aaaa",
      newRouteId: "tmp:bbbb",
    }),
    false,
  );
});

test("non-string route ids fail closed", () => {
  for (const [previousRouteId, newRouteId] of [
    [null, "wf:new"],
    ["wf:old", null],
    [undefined, undefined],
    [42, "wf:new"],
  ]) {
    assert.equal(isSameInstanceRename({ sameWorkflowObject: true, previousRouteId, newRouteId }), false);
  }
});
