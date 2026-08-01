/**
 * Unit tests for web/js/lib/object-info-history.js — run with `node --test`.
 *
 * This is the OBSERVED-BACKEND-HISTORY trust root the whole #458 guard family rests on
 * (node-resolve.js's backendHistoryVerdict / the frontend-only exemption). It has THREE
 * states, and keeping two of them apart is the whole point of the module:
 *
 *   SEEDED   — a page-load-anchored /object_info was observed. "Never seen" is meaningful,
 *              so the frontend-only exemption may be considered.
 *   PENDING  — no baseline YET (the fetch is in flight, or a caller bounded its wait).
 *              Refuse, but TEMPORARILY and RECOVERABLY: a late response still seeds and
 *              the next call authorizes normally, with no tab reload.
 *   LATCHED  — the observation window POSITIVELY closed with no data. Refuse for the whole
 *              session; no later observation may re-establish a baseline.
 *
 * PENDING vs LATCHED is an evidence distinction, not a convenience. A TIMEOUT is the
 * ABSENCE of evidence: latching on one turns an /object_info fetch that merely took a
 * moment too long into a permanent, session-long refusal of every legitimate add and
 * write — a third false refusal on top of the two (#496, #507) this work fixes. Only a
 * seed whose attempt sequence has FINISHED empty has the evidence to latch.
 *
 * SCOPE NOTE: these tests cover this module's POLICY. They do NOT — and cannot — cover the
 * residual race in which a pack is removed inside the window between page load and the
 * panel's first successful /object_info response, since the baseline can only ever come
 * from an asynchronous fetch. See the KNOWN, ACCEPTED RESIDUAL note in
 * web/js/lib/object-info-history.js for why that is bounded and out of scope.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createObjectInfoHistory, awaitHistoryBaseline } from "../../web/js/lib/object-info-history.js";
// The guard-side contract this oracle feeds: both no-baseline states return a TRUTHY
// sentinel (so a truth-testing consumer still fails closed) and the shared classifier
// turns them into distinct, honest diagnoses.
import {
  HISTORY_PENDING,
  HISTORY_UNSEEDED,
  backendHistoryVerdict,
  isRemovedBackendType,
} from "../../web/js/lib/node-resolve.js";

const defs = (...types) => Object.fromEntries(types.map((t) => [t, { input: { required: {} } }]));
const oracle = (h) => (t) => h.wasTypeEverDefined(t);

// Assert the full fail-closed contract for a type in a given no-baseline state.
const assertClosed = (h, type, sentinel, verdict, msg) => {
  const answer = h.wasTypeEverDefined(type);
  assert.equal(answer, sentinel, msg);
  assert.ok(answer, "the sentinel must be TRUTHY so a truth-testing consumer fails closed");
  assert.equal(backendHistoryVerdict(type, oracle(h)), verdict);
  assert.equal(
    isRemovedBackendType(type, oracle(h)),
    false,
    "no baseline is not a REMOVED claim — it is an unknown-baseline claim",
  );
};
const assertPending = (h, type, msg) => assertClosed(h, type, HISTORY_PENDING, "pending", msg);
const assertLatched = (h, type, msg) => assertClosed(h, type, HISTORY_UNSEEDED, "unseeded", msg);

test("#458 rule 1: a history with no baseline yet is PENDING and fails CLOSED", () => {
  const h = createObjectInfoHistory();
  assert.equal(h.seeded, false);
  assert.equal(h.baselineLost, false);
  assertPending(h, "MarkdownNote", "no baseline yet ⇒ refuse");
  assertPending(h, "AnythingAtAll");
  // Even after RECORDING types, an unseeded history still refuses: recording is evidence,
  // promoting it to a baseline is a separate, explicit claim.
  h.recordTypes(defs("KSampler"));
  assertPending(h, "MarkdownNote", "recording alone is not a baseline");
});

test("#458 rule 1: once SEEDED, only genuinely-observed types read as ever-defined", () => {
  const h = createObjectInfoHistory();
  h.recordTypes(defs("KSampler", "CLIPTextEncode"));
  assert.equal(h.markSeeded(), true);
  assert.equal(h.wasTypeEverDefined("KSampler"), true, "observed ⇒ removed if now absent");
  assert.equal(h.wasTypeEverDefined("MarkdownNote"), false, "never observed ⇒ genuinely frontend-only");
  assert.equal(backendHistoryVerdict("MarkdownNote", oracle(h)), "never-seen");
  assert.equal(backendHistoryVerdict("KSampler", oracle(h)), "removed");
});

test("#496 REGRESSION: a LATE seed (arriving after a caller's bounded wait) restores normal operation", () => {
  // The exact scenario a bounded wait creates: api.getNodeDefs() takes longer than the
  // bound, a graph tool gives up waiting and refuses THIS call, and the response then
  // lands with perfectly healthy definitions. The next call MUST authorize normally.
  // Latching at the timeout instead would refuse every legitimate add/write for the rest
  // of the session — ordinary latency causing permanent breakage, which is the very
  // false-refusal bug class #496/#507 are about.
  const h = createObjectInfoHistory();
  // t = 0..bound: the tool gives up waiting. It must NOT latch — it learned nothing.
  assertPending(h, "MarkdownNote", "still loading ⇒ a TEMPORARY refusal");
  assert.equal(h.baselineLost, false, "a bounded wait must never latch the session");
  // t = bound+ε: the slow response lands and seeds the baseline.
  h.recordTypes(defs("KSampler", "CLIPTextEncode"));
  assert.equal(h.markSeeded(), true, "a late seed is still a valid page-load-anchored baseline");
  // The very next authorization succeeds — no tab reload, nothing burned.
  assert.equal(h.seeded, true);
  assert.equal(h.wasTypeEverDefined("MarkdownNote"), false, "MarkdownNote is addable/writable again");
  assert.equal(backendHistoryVerdict("MarkdownNote", oracle(h)), "never-seen");
  // …and the recovered baseline is a REAL one: a type it did observe still reads removed.
  assert.equal(backendHistoryVerdict("KSampler", oracle(h)), "removed");
});

test("#458 rule 2 (SEVERE): a LATCHED baseline cannot be restored by a later successful observation", () => {
  // The evidence case: the seed's whole attempt sequence finished with nothing, so the
  // page-load-anchored window is positively closed. A later fetch may be POST-removal, so
  // it must never become the baseline.
  const h = createObjectInfoHistory();
  h.loseBaseline(); // the startup seed exhausted every attempt
  h.recordTypes(defs("KSampler", "CLIPTextEncode")); // a later, possibly post-removal payload
  assert.equal(h.markSeeded(), false, "the latch refuses to promote a post-loss observation");
  assert.equal(h.seeded, false);
  assert.equal(h.baselineLost, true);
  // "MarkdownNote" was never in the late payload — but we cannot conclude it never
  // existed, so it stays refused, and with the reload-the-tab diagnosis rather than the
  // temporary one.
  assertLatched(h, "MarkdownNote", "a post-loss history must never authorize the exemption");
  assertLatched(h, "KSampler");
});

test("#458 rule 2 (SEVERE, production ordering): a post-gap observation recorded BEFORE any guard runs does not establish a baseline", () => {
  // The ordering adversarial review flagged: nothing has latched yet, a pack is removed,
  // and a RECONNECT / refresh_nodes / download refresh lands a current /object_info. That
  // payload is RECORDED — recording only ever adds evidence — but it must NOT be promoted
  // to a baseline, because only the startup seed may call markSeeded().
  const h = createObjectInfoHistory();
  h.recordTypes(defs("KSampler", "CLIPTextEncode")); // post-removal payload, no markSeeded
  assert.equal(h.seeded, false, "recording alone never seeds — only the startup seed may");
  assertPending(h, "MarkdownNote", "with no startup baseline, nothing can be concluded");
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
  assertLatched(h, "MarkdownNote", "latched closed for the session");
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


// ---- awaitHistoryBaseline: the PRODUCTION bounded wait. These are the load-bearing
//      tests for the coordinator-found HIGH — reintroducing a loseBaseline() call inside
//      this helper must FAIL here, not merely be caught by review. ---------------------

const never = () => new Promise(() => {}); // a getNodeDefs() that never settles

test("#496 HIGH: a bounded wait that EXPIRES must not mutate the history (no latch, no seed)", async () => {
  const h = createObjectInfoHistory();
  const seeded = await awaitHistoryBaseline(h, never(), 5);
  assert.equal(seeded, false, "reports 'not seeded' so the caller refuses this one call");
  assert.equal(h.baselineLost, false, "a TIMEOUT is the absence of evidence — it must never latch");
  assert.equal(h.seeded, false);
  // …and the state is the RECOVERABLE one, so the refusal reads as temporary.
  assert.equal(h.wasTypeEverDefined("MarkdownNote"), HISTORY_PENDING);
});

test("#496 HIGH: the seed keeps running past the bound — a late response still restores normal operation", async () => {
  const h = createObjectInfoHistory();
  // A seed that resolves well AFTER the caller's bound, exactly like an 8.1s getNodeDefs
  // against an 8s wait.
  const slowSeed = new Promise((resolve) => setTimeout(resolve, 40)).then(() => {
    h.recordTypes({ KSampler: {}, CLIPTextEncode: {} });
    h.markSeeded();
  });
  assert.equal(await awaitHistoryBaseline(h, slowSeed, 5), false, "gave up waiting");
  assert.equal(h.baselineLost, false, "…without burning the session");
  await slowSeed; // the response lands
  // The NEXT call sees a real baseline: no reload, and the exemption works again.
  assert.equal(await awaitHistoryBaseline(h, slowSeed, 5), true);
  assert.equal(h.wasTypeEverDefined("MarkdownNote"), false, "MarkdownNote addable/writable again");
  assert.equal(h.wasTypeEverDefined("KSampler"), true, "and the baseline is a REAL one");
});

test("awaitHistoryBaseline: a seed that RESOLVES within the bound reports seeded immediately", async () => {
  const h = createObjectInfoHistory();
  const seed = Promise.resolve().then(() => {
    h.recordTypes({ KSampler: {} });
    h.markSeeded();
  });
  assert.equal(await awaitHistoryBaseline(h, seed, 1000), true);
  assert.equal(h.baselineLost, false);
});

test("awaitHistoryBaseline: a REJECTED seed neither throws nor latches (the seed itself owns that decision)", async () => {
  const h = createObjectInfoHistory();
  const rejected = Promise.reject(new Error("network"));
  assert.equal(await awaitHistoryBaseline(h, rejected, 1000), false, "no unhandled rejection, no throw");
  assert.equal(h.baselineLost, false, "only seedObjectInfoHistory, after ALL attempts finish, may latch");
  assert.equal(h.wasTypeEverDefined("MarkdownNote"), HISTORY_PENDING);
});

test("awaitHistoryBaseline: an ALREADY-LATCHED history is reported as not seeded and stays latched", async () => {
  const h = createObjectInfoHistory();
  h.loseBaseline();
  assert.equal(await awaitHistoryBaseline(h, never(), 5), false);
  assert.equal(h.baselineLost, true);
  assert.equal(h.wasTypeEverDefined("MarkdownNote"), HISTORY_UNSEEDED, "still the reload-the-tab state");
});
