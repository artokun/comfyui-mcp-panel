// comfyui-mcp#1489 (defect 3) — an UNCONFIRMABLE run is not a failed one.
//
// `onReconcileGiveUp` fires when the tracker could not confirm a prompt's outcome after
// its bounded retries: the server has no `/history` for it. It used to send
// `kind: "run_error"` while its own text said "could not be confirmed … likely cancelled
// … safe to requeue".
//
// The orchestrator routes every run_error through `injectRunError`, which INTERRUPTS the
// live turn, front-queues it ("hey, look at me"), and tells the agent "The user's workflow
// run just ERRORED … diagnose it (panel_get_errors has the details)". Cancelling a
// 26-prompt batch therefore produced 26 interrupts asserting a failure the panel never
// observed. #1507 stopped them compounding across turns; they were still 26 urgent errors
// for 26 unknowns.
//
// The correct pattern is the sibling branch, whose comment already argues this case:
// `executed` with a note is the existing NON-URGENT protocol and claims no output.
// Interrupted KNOWS the run was cancelled; give-up knows only that it cannot tell.
//
// The callback bodies live in the monolith, so these pin the WIRING; the end-to-end
// behaviour is verified against the running ComfyUI after merge.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PANEL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
  "utf8",
).replace(/\r\n/g, "\n");

/**
 * CODE ONLY — comment lines are stripped.
 *
 * The first version of this scan did not, and the comment above the fix quotes the old
 * `kind: "run_error"` while explaining why it is gone. The test then failed against
 * correct code, which is the benign direction of a scanner that reads prose; the
 * dangerous direction is a scan that PASSES because the property it wants happens to be
 * mentioned in a sentence.
 */
function stripComments(src) {
  return src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

/** The give-up callback body, bounded by the close of the handler map that follows it. */
function giveUpBody() {
  const start = PANEL.indexOf("onReconcileGiveUp: ({ promptId }) => {");
  assert.notEqual(start, -1, "the give-up callback must still be recognisable");
  const end = PANEL.indexOf("\n  });", start);
  assert.ok(end > start, "the end of the handler map must still be recognisable");
  return stripComments(PANEL.slice(start, end));
}

function interruptedBody() {
  const start = PANEL.indexOf("onReconcileInterrupted: ({ promptId }) => {");
  assert.notEqual(start, -1, "the interrupted callback must still be recognisable");
  const end = PANEL.indexOf("onReconcileGiveUp:", start);
  assert.ok(end > start);
  return stripComments(PANEL.slice(start, end));
}

test("#1489 give-up delivers a NEUTRAL event, not run_error", () => {
  const body = giveUpBody();
  assert.match(body, /kind: "executed"/, "the non-urgent protocol");
  assert.doesNotMatch(
    body,
    /kind: "run_error"/,
    "run_error interrupts the turn and asserts a failure this path never observed",
  );
});

test("#1489 it carries a NOTE, which is what makes an executed event describe itself", () => {
  // A note-only `executed` replaces the default "produced N output image(s)" wording
  // entirely. Without one, this would announce a finished render that never happened.
  const body = giveUpBody();
  assert.match(body, /note:/, "the event must carry its own wording");
  assert.doesNotMatch(body, /images:/, "and must not attach outputs");
});

test("#1489 the note states the UNKNOWN honestly, in BOTH directions", () => {
  const body = giveUpBody();
  assert.match(body, /could NOT be confirmed/i, "says the outcome is unknown");
  assert.match(body, /NOT a reported failure/i, "and is explicitly not a failure claim");

  // Review, P1 — and this test blessed the defect a moment ago. The first version
  // asserted "no output was produced", which is a claim this path CANNOT substantiate:
  // a run that emitted outputs before the connection dropped, then was cancelled before
  // its terminal status, reaches give-up with real artifacts on disk. Telling the agent
  // nothing was produced invites re-queueing an expensive or side-effecting run.
  //
  // That is the same error the fix is about, pointed the other way: I replaced one
  // unsubstantiated claim ("it ERRORED") with another ("nothing was produced").
  assert.doesNotMatch(body, /no output was produced/i, "must not claim an absence it cannot see");
  assert.match(body, /not proof nothing was produced/i, "says so explicitly");
  assert.match(body, /get_history/, "and names the reader that CAN answer it");
});

test("#1489 everything else on the give-up path is unchanged", () => {
  // The classification was the defect. The bookkeeping around it was not, and silently
  // dropping any of it would trade one bug for a worse one — a run that reads as settled
  // when its only frame was never delivered (#585), or a suppressed restart-resume
  // waiting forever on a run that can never settle.
  const body = giveUpBody();
  assert.match(body, /markDeliveryUnconfirmed\(promptId\)/, "#585 delivery flag intact");
  assert.match(body, /pruneRebootMarker\(\)/, "reboot marker still pruned");
  assert.match(body, /appendSystem\(/, "the one-time panel surfacing is intact");
  assert.match(body, /!sent && !AGENT_MUTED/, "the unsent/muted gate is intact");
});

test("#1489 the sibling INTERRUPTED path is untouched", () => {
  // It was already correct, and is the precedent this change follows.
  const body = interruptedBody();
  assert.match(body, /kind: "executed"/);
  assert.doesNotMatch(body, /kind: "run_error"/);
});

test("#1489 run_error is STILL used where a failure is actually known", () => {
  // The direction that would be catastrophic to lose. `run_error` is the only channel
  // that interrupts the agent, and a real render failure must keep using it — a change
  // that simply deleted the urgent class everywhere would pass every assertion above
  // while making genuine errors silent.
  //
  // STRIPPED, and review had to point that out: the first version scanned the raw
  // monolith, and the comments THIS COMMIT ADDED quote `kind: "run_error"` while
  // explaining why give-up no longer uses it. So the guard would have passed with every
  // executable urgent send downgraded — a test that reads prose and reports PASS, which
  // is the dangerous direction of exactly the mistake it was written to prevent.
  const errorSends = [...stripComments(PANEL).matchAll(/kind: "run_error"/g)].length;
  assert.ok(
    errorSends > 0,
    "at least one path must still report a KNOWN failure as urgent, or errors go unnoticed",
  );
});
