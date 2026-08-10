// #887 — a workflow_open reply must report what it OBSERVED to be active, not only what
// was requested.
//
// The reply named the target in `opened` and `routing_key` and said nothing about the
// active slot, so the orchestrator rendered a flat assertion ("the canvas IS bound to X …
// You are NOT on the wrong workflow") while `panel_list_workflows` named a different
// workflow immediately afterwards. A Save-As taken on that assurance writes the LIVE
// canvas, not the one the caller believes it is on.
//
// SCOPE, measured rather than assumed. On 0.11.81 the reporter's scenario does NOT
// reproduce: opening an already-open modified background workflow switches correctly and
// the reply agrees with the workflow list. Stealing the active slot mid-open DOES leave a
// stale reply, but the reply was truthful when composed — the target genuinely was active
// at emission — so no check inside the panel could have caught it. A reply describes a
// moment; it cannot report the future.
//
// What is fixed is that the moment was never reported at all, leaving "the target is
// active" indistinguishable from "the target is what you asked for".
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeOpenActiveBinding } from "../../web/js/lib/open-active-binding.js";

const A = "wf:workflows/A.json";
const B = "wf:workflows/B.json";

test("#887: agreement is reported as agreement", () => {
  const r = describeOpenActiveBinding({ targetRoutingKey: A, activeRoutingKey: A });
  assert.equal(r.active_matches_target, true);
  assert.equal(r.active_routing_key, A);
  assert.ok(!("active_mismatch_hint" in r), "nothing to warn about");
});

test("#887: a different active workflow is reported, and named", () => {
  const r = describeOpenActiveBinding({ targetRoutingKey: A, activeRoutingKey: B });
  assert.equal(r.active_matches_target, false);
  assert.equal(r.active_routing_key, B, "the caller needs to know WHICH workflow is live");
  // The save warning is the point of the issue: the reporter's concern was that a Save-As
  // at this moment writes the wrong canvas.
  assert.match(r.active_mismatch_hint, /do NOT save/i);
  // FIXED WORDING — the routing keys must NOT be interpolated into it (codex). They are
  // workflow-derived (a user names their own files), and splicing them into
  // instruction-shaped prose puts attacker-influenced text inside a sentence a model reads
  // as trusted. They belong in the structured fields, presented as data.
  assert.doesNotMatch(r.active_mismatch_hint, /wf:workflows/);
  assert.match(r.active_mismatch_hint, /active_routing_key/, "it points at the fields instead");
});

test("#887: an unreadable active slot is UNKNOWN, never a mismatch", () => {
  // A false failure costs as much as a false success — that is #886, this issue inverted.
  // Claiming a mismatch we did not observe sends a caller chasing a switch that worked.
  for (const active of [null, undefined, ""]) {
    const r = describeOpenActiveBinding({ targetRoutingKey: A, activeRoutingKey: active });
    assert.equal(r.active_matches_target, null, JSON.stringify(active));
    assert.equal(r.active_routing_key, null);
    assert.ok(!("active_mismatch_hint" in r));
  }
});

test("#887: an unreadable TARGET key is also unknown, not a mismatch", () => {
  const r = describeOpenActiveBinding({ targetRoutingKey: null, activeRoutingKey: B });
  assert.equal(r.active_matches_target, null);
  assert.equal(r.active_routing_key, B, "still report what was seen");
});

test("#887: no arguments is unknown, not agreement", () => {
  // The default must never read as confirmation — that is the whole failure mode.
  const r = describeOpenActiveBinding();
  assert.equal(r.active_matches_target, null);
  assert.equal(r.active_routing_key, null);
});

test("#887: non-string routing keys are not trusted", () => {
  for (const junk of [42, {}, [], true]) {
    const r = describeOpenActiveBinding({ targetRoutingKey: junk, activeRoutingKey: junk });
    assert.equal(r.active_matches_target, null, JSON.stringify(junk));
  }
});
