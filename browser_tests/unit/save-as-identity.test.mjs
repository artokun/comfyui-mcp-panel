// #941 — a Save-As must report the identity of the workflow it just made active.
//
// Measured on 0.11.80 before the fix:
//
//   workflow_save({name}) -> { saved:true, saved_as:true, workflow_identity_unavailable:true }
//   graph_outline()       -> "workflow instance mismatch: ... issued for instance b273a69f,
//                             and the active canvas reports 14d699d3"
//
// The panel knew the new identity well enough to refuse the next call with it, and had
// declined to report it one call earlier. `establishedWorkflowReplyIdentity` is a pure read
// by design (#716 — a fence refreshed from a value a read invented agrees with itself), and
// a Save-As activates a brand-new object nothing has established an identity for. So the
// read honestly found nothing while the fence's own minting read immediately found one.
//
// The fix establishes the identity as part of the SAVE, which is a mutation whose job is to
// change which canvas is active — not a read inventing one.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  saveReplyIdentity,
  shouldEstablishIdentityAfterSave,
} from "../../web/js/lib/save-reply-identity.js";

test("#941: a Save-As with nothing established is the case that must establish", () => {
  assert.equal(shouldEstablishIdentityAfterSave({ savedAs: true, alreadyEstablished: false }), true);
});

test("#941: an already-established canvas is left alone", () => {
  // Minting over an established identity would change what the canvas IS as a side effect
  // of saving it — the opposite of the bug, and worse.
  assert.equal(shouldEstablishIdentityAfterSave({ savedAs: true, alreadyEstablished: true }), false);
});

test("#941: an in-place save never establishes", () => {
  // It keeps the same object, whose identity is already established; there is nothing to
  // mint and no caller to strand. Deliberately not widened — measured, an in-place/first
  // save already reports `workflow_uuid` correctly.
  assert.equal(shouldEstablishIdentityAfterSave({ savedAs: false, alreadyEstablished: false }), false);
  assert.equal(shouldEstablishIdentityAfterSave({ savedAs: false, alreadyEstablished: true }), false);
  assert.equal(shouldEstablishIdentityAfterSave({}), false, "unknown shape must not mint");
  assert.equal(shouldEstablishIdentityAfterSave(), false);
});

test("#941: once established, the reply carries what the fence compares against", () => {
  // The whole point: the value published here is the one the next mismatch error names, so
  // a stranded session has something to re-fence to.
  const reply = saveReplyIdentity(
    { uuid: "aafd364e-7093-4daa-b5ed-df8541e696d9", routingKey: "wf:workflows/copy.json" },
    { savedAs: true },
  );
  assert.equal(reply.workflow_uuid, "aafd364e-7093-4daa-b5ed-df8541e696d9");
  assert.equal(reply.routing_key, "wf:workflows/copy.json");
  assert.equal(reply.workflow_instance_changed, true, "the caller must be told its fence is stale");
  assert.ok(!("workflow_identity_unavailable" in reply));
});

test("#941: an unknown identity still says so rather than implying continuity", () => {
  // The establish step is best-effort — it sits behind a try/catch so a bookkeeping failure
  // cannot fail a save that already wrote the file. When it does not produce an identity the
  // reply must keep reporting absence, not silence, which is what stranded the reporter.
  const reply = saveReplyIdentity(null, { savedAs: true });
  assert.equal(reply.workflow_identity_unavailable, true);
  assert.match(reply.workflow_identity_note, /fenced to the workflow that was active BEFORE this save/);
});
