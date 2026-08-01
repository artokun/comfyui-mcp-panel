/**
 * Unit tests for web/js/lib/object-info-history.js — run with `node --test`.
 *
 * This is the OBSERVED-BACKEND-HISTORY trust root the whole #458 guard family rests on
 * (node-resolve.js's isRemovedBackendType / the frontend-only exemption). Its two
 * fail-closed rules are what stop a removed backend pack from being written to or added:
 *
 *   1. UNSEEDED ⇒ CLOSED — until a trustworthy baseline exists, "never seen" proves
 *      nothing, so every absent-from-current type reads as removed.
 *   2. BASELINE LOST ⇒ LATCHED CLOSED — once the startup baseline is missed, no LATER
 *      observation may re-establish it, because the removal could have happened inside
 *      the window we never observed.
 *
 * Rule 2 is the sequence adversarial review flagged twice: startup fetch hangs/fails →
 * a pack is removed → a later fetch succeeds → without the latch that POST-removal map
 * becomes the baseline, the removed type reads "never seen", and a provenance-stripped
 * husk squatting a reserved allowlisted name (MarkdownNote) is exempted.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createObjectInfoHistory } from "../../web/js/lib/object-info-history.js";
// The guard-side contract this oracle feeds: an unseeded history returns a TRUTHY
// sentinel, which the shared classifier reports as "unseeded" (refuse, but diagnose it
// as a missing baseline rather than a removed pack).
import { HISTORY_UNSEEDED, backendHistoryVerdict, isRemovedBackendType } from "../../web/js/lib/node-resolve.js";

// Assert the FULL fail-closed contract for a type in a no-baseline history.
const assertUnseededClosed = (h, type, msg) => {
  const verdict = h.wasTypeEverDefined(type);
  assert.equal(verdict, HISTORY_UNSEEDED, msg);
  assert.ok(verdict, "the sentinel must be TRUTHY so a truth-testing consumer still fails closed");
  assert.equal(backendHistoryVerdict(type, (t) => h.wasTypeEverDefined(t)), "unseeded");
  assert.equal(isRemovedBackendType(type, (t) => h.wasTypeEverDefined(t)), false, "not a REMOVED claim — it is an unknown-baseline claim");
};

const defs = (...types) => Object.fromEntries(types.map((t) => [t, { input: { required: {} } }]));

test("#458 rule 1: an UNSEEDED history fails CLOSED — every type reads as ever-defined", () => {
  const h = createObjectInfoHistory();
  assert.equal(h.seeded, false);
  // Nothing observed at all.
  assertUnseededClosed(h, "MarkdownNote", "unseeded ⇒ refuse");
  assertUnseededClosed(h, "AnythingAtAll");
  // Even after RECORDING types, an unseeded history still refuses everything: recording
  // is evidence, promoting it to a baseline is a separate, explicit claim.
  h.recordTypes(defs("KSampler"));
  assertUnseededClosed(h, "MarkdownNote", "recording alone is not a baseline");
});

test("#458 rule 1: once SEEDED, only genuinely-observed types read as ever-defined", () => {
  const h = createObjectInfoHistory();
  h.recordTypes(defs("KSampler", "CLIPTextEncode"));
  assert.equal(h.markSeeded(), true);
  assert.equal(h.wasTypeEverDefined("KSampler"), true, "observed ⇒ removed if now absent");
  assert.equal(h.wasTypeEverDefined("MarkdownNote"), false, "never observed ⇒ genuinely frontend-only");
});

test("#458 rule 2 (SEVERE): a LOST baseline is LATCHED — a later successful observation cannot restore it", () => {
  // The exact hole: the startup seed fails / times out, the pack is removed during the
  // gap, and a later fetch returns the POST-removal /object_info.
  const h = createObjectInfoHistory();
  h.loseBaseline(); // a graph tool gave up waiting for the startup seed
  h.recordTypes(defs("KSampler", "CLIPTextEncode")); // a later, post-removal payload
  assert.equal(h.markSeeded(), false, "the latch refuses to promote a post-loss observation");
  assert.equal(h.seeded, false);
  assert.equal(h.baselineLost, true);
  // "MarkdownNote" was NEVER in the late payload — but we cannot conclude it never
  // existed, so it must still read as ever-defined and stay refused by the guards.
  assertUnseededClosed(h, "MarkdownNote", "a post-loss history must never authorize the frontend-only exemption");
  assertUnseededClosed(h, "KSampler");
});

test("#458 rule 2 (SEVERE, production ordering): a post-gap observation recorded BEFORE any guard runs does not establish a baseline", () => {
  // The ordering codex round-4 flagged: the startup seed hangs (so nothing has latched
  // yet), the pack is removed, and a RECONNECT / refresh_nodes / download refresh lands a
  // current /object_info. That payload is RECORDED — recording only ever adds evidence —
  // but it must NOT be promoted to a baseline, because it cannot support the claim
  // "anything absent here was never backend-defined this session".
  const h = createObjectInfoHistory();
  h.recordTypes(defs("KSampler", "CLIPTextEncode")); // post-removal payload, no markSeeded
  assert.equal(h.seeded, false, "recording alone never seeds — only the startup seed may");
  assertUnseededClosed(h, "MarkdownNote", "with no startup baseline, nothing can be concluded");
  // The guard that eventually runs latches the loss, and it stays latched afterwards.
  h.loseBaseline();
  h.recordTypes(defs("KSampler"));
  assert.equal(h.markSeeded(), false);
  assertUnseededClosed(h, "MarkdownNote");
});

test("#458 rule 2: losing the baseline AFTER it was legitimately established also closes the gate", () => {
  const h = createObjectInfoHistory();
  h.recordTypes(defs("KSampler"));
  h.markSeeded();
  assert.equal(h.wasTypeEverDefined("MarkdownNote"), false, "precondition: exemption available");
  h.loseBaseline();
  // markSeeded is now inert, so a subsequent re-register cannot re-open the exemption.
  assert.equal(h.markSeeded(), false);
  assert.equal(h.seeded, false);
  assertUnseededClosed(h, "MarkdownNote", "latched closed for the session");
});

test("#458: recordTypes is NOT latched — recording can only ever ADD evidence (refuse more)", () => {
  const h = createObjectInfoHistory();
  h.recordTypes(defs("GoneNode"));
  h.markSeeded();
  assert.equal(h.wasTypeEverDefined("GoneNode"), true, "observed ⇒ its later absence means REMOVED");
  // A brand-new type observed later is likewise remembered, so its later absence is
  // caught too. This direction can never open a hole.
  h.recordTypes(defs("LaterPackNode"));
  assert.equal(h.has("LaterPackNode"), true);
  assert.equal(h.wasTypeEverDefined("LaterPackNode"), true);
});

test("#458: recordTypes is defensive and returns its argument (so it can wrap a fetch inline)", () => {
  const h = createObjectInfoHistory();
  assert.equal(h.recordTypes(null), null);
  assert.equal(h.recordTypes(undefined), undefined);
  const payload = defs("KSampler");
  assert.equal(h.recordTypes(payload), payload, "returns the payload unchanged");
  h.markSeeded();
  assert.equal(h.wasTypeEverDefined("KSampler"), true);
  // A null payload recorded nothing, so an unobserved type is still 'never seen'.
  assert.equal(h.wasTypeEverDefined("MarkdownNote"), false);
});
