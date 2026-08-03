import test from "node:test";
import assert from "node:assert/strict";

import { planRebootResume } from "../../web/js/lib/restart-resume.js";

test("#585: a pre-restart render pending in the completion ledger suppresses the generic resume nudge", () => {
  // The run may have survived the backend restart. Its terminal completion (or
  // conservative reconnect reconciliation) is the signal that may wake the
  // resumed agent; a generic "continue" prompt would invite a duplicate queue.
  assert.equal(planRebootResume({ rebootPending: true, hasPendingRun: true }), "wait_for_run");
});

test("#585: an actual reboot with no pending render retains autonomous resume", () => {
  assert.equal(planRebootResume({ rebootPending: true, hasPendingRun: false }), "resume");
});

test("#585: no reboot marker never injects a restart-resume message", () => {
  assert.equal(planRebootResume({ rebootPending: false, hasPendingRun: true }), "none");
});
