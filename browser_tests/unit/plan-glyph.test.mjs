// Unit tests for the "PLAN" box false-activity fix (issue #492).
//
// The reporter loaded a workflow, went off to download models by hand, and the
// agent's PLAN box "showed activity when none was happening" — a circle widget
// that kept turning after the agent had stopped. Root cause: the plan is pushed
// via `set_todo` and PERSISTED on the thread, so the step that was "active" when
// a turn ended stayed "active", and the tray unconditionally painted an "active"
// step with the SPINNING glyph. The spinner must instead reflect whether the
// agent is actually working right now.
import test from "node:test";
import assert from "node:assert/strict";

import { todoItemGlyph } from "../../web/js/lib/plan-glyph.js";

const SPINNER = "pi-spin pi-spinner";
const IDLE_ACTIVE = "pi-circle-fill";

test("active step spins ONLY while the agent is working", () => {
  assert.equal(todoItemGlyph("active", true), SPINNER);
});

test("active step does NOT spin when the agent is idle (the #492 false-activity bug)", () => {
  // This is the core regression: a persisted 'active' step, agent stopped.
  assert.equal(todoItemGlyph("active", false), IDLE_ACTIVE);
  assert.notEqual(todoItemGlyph("active", false), SPINNER);
});

test("done and pending steps never spin, regardless of working state", () => {
  for (const working of [true, false]) {
    assert.equal(todoItemGlyph("done", working), "pi-check-circle");
    assert.equal(todoItemGlyph("pending", working), "pi-circle");
    // Unknown/blank status falls back to the hollow (pending) circle — never a spinner.
    assert.equal(todoItemGlyph(undefined, working), "pi-circle");
    assert.equal(todoItemGlyph("", working), "pi-circle");
  }
});

test("no status ever yields a spinner while idle — the whole box is quiet", () => {
  for (const status of ["active", "done", "pending", undefined, "weird"]) {
    assert.notEqual(todoItemGlyph(status, false), SPINNER);
  }
});
