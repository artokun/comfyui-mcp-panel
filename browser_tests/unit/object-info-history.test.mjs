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

const defs = (...types) => Object.fromEntries(types.map((t) => [t, { input: { required: {} } }]));

test("#458 rule 1: an UNSEEDED history fails CLOSED — every type reads as ever-defined", () => {
  const h = createObjectInfoHistory();
  assert.equal(h.seeded, false);
  // Nothing observed at all.
  assert.equal(h.wasTypeEverDefined("MarkdownNote"), true, "unseeded ⇒ refuse (treat as removed)");
  assert.equal(h.wasTypeEverDefined("AnythingAtAll"), true);
  // Even after RECORDING types, an unseeded history still refuses everything: recording
  // is evidence, promoting it to a baseline is a separate, explicit claim.
  h.recordTypes(defs("KSampler"));
  assert.equal(h.wasTypeEverDefined("MarkdownNote"), true, "recording alone is not a baseline");
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
  assert.equal(
    h.wasTypeEverDefined("MarkdownNote"),
    true,
    "a post-loss history must never authorize the frontend-only exemption",
  );
  assert.equal(h.wasTypeEverDefined("KSampler"), true);
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
  assert.equal(h.wasTypeEverDefined("MarkdownNote"), true, "latched closed for the session");
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
