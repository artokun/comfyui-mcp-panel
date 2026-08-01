// Unit tests for web/js/lib/open-outcome.js — run with `node --test`.
//
// #402: `panel_open_workflow` came back "disconnected mid-command … OUTCOME UNKNOWN".
// Two properties are locked here, because getting either wrong produces the worst
// possible result for this path — a FABRICATED success:
//
//   1. classifyOpenOutcome() reports "applied" ONLY from the panel's own execution
//      record. A matching `active` pointer is explicitly NOT enough: after a backend
//      reconnect the frontend restores a tab on its own (#433), and the usual #402
//      request is "open the workflow that is already active", so a matching `active` is
//      fully explained without our command ever having run.
//   2. It can never mistake ANOTHER workflow's receipt for this request — the
//      wrong-workflow failure mode the #570 identity work exists to prevent.
//
// Plus the wiring contract in comfyui-mcp-panel.js: the post-open disk read is BOUNDED
// (#402), workflow_open journals both the positive and the negative, and the #442
// defect-2 re-read never runs over unsaved edits.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  OPEN_DISK_READ_BUDGET_MS,
  OPEN_RECEIPT_CAP,
  withDeadline,
  makeOpenReceipt,
  recordOpenReceipt,
  latestOpenReceipt,
  markOpenReceiptReplySent,
  summarizeOpenReceipt,
  receiptMatchesRequest,
  createSingleFlight,
  receiptAnswersCommand,
  classifyOpenOutcome,
} from "../../web/js/lib/open-outcome.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/** Comments in this file DISCUSS `throw` and `await` at length, so any structural
 *  assertion about control flow must look at CODE only. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Body of an object method from its `sig` up to the next 2-space-indented method. */
function handlerBody(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) return null;
  const after = start + sig.length;
  const m = src.slice(after).match(/\n {2}(?:async )?[A-Za-z_][A-Za-z0-9_]*\s*\(/);
  return src.slice(start, m ? after + m.index : src.length);
}

const receiptFor = (requested, extra = {}) =>
  makeOpenReceipt({
    seq: 1,
    cmd: "workflow_open",
    rid: "rid-1",
    requested,
    resolved: { path: requested, filename: "a.json", routing_key: `wf:${requested}` },
    applied: true,
    at: 1000,
    ...extra,
  });

// --- withDeadline ---------------------------------------------------------

test("withDeadline resolves the value when it beats the deadline", async () => {
  assert.equal(await withDeadline(Promise.resolve("text"), 1000, null), "text");
});

test("withDeadline yields the fallback on timeout — and NEVER rejects", async () => {
  const never = new Promise(() => {});
  assert.equal(await withDeadline(never, 5, "unknown"), "unknown");
});

test("withDeadline maps a REJECTION to the same fallback (unreadable == too slow)", async () => {
  assert.equal(await withDeadline(Promise.reject(new Error("Failed to fetch")), 1000, null), null);
});

test("withDeadline clears its timer on the fast path (no dangling timer in a long-lived tab)", async () => {
  let cleared = 0;
  let armed = 0;
  const setTimer = (fn, ms) => {
    armed++;
    return setTimeout(fn, ms);
  };
  const clearTimer = (t) => {
    cleared++;
    clearTimeout(t);
  };
  await withDeadline(Promise.resolve(1), 10000, null, { setTimer, clearTimer });
  assert.equal(armed, 1);
  assert.equal(cleared, 1, "the deadline timer must be cleared once the value arrives");
});

test("withDeadline with a non-positive/absent deadline still neutralizes rejection", async () => {
  assert.equal(await withDeadline(Promise.reject(new Error("x")), 0, "fb"), "fb");
  assert.equal(await withDeadline(Promise.reject(new Error("x")), NaN, "fb"), "fb");
});

test("codex P2: the deadline CANCELS the work it abandons, and a throwing hook cannot change the outcome", async () => {
  let cancelled = 0;
  assert.equal(
    await withDeadline(new Promise(() => {}), 5, "unknown", { onTimeout: () => cancelled++ }),
    "unknown",
  );
  assert.equal(cancelled, 1, "abandoning a read must cancel it, not leave it running");
  // A throwing cancel hook must not corrupt the deadline's result.
  assert.equal(
    await withDeadline(new Promise(() => {}), 5, "unknown", {
      onTimeout: () => {
        throw new Error("abort failed");
      },
    }),
    "unknown",
  );
  // …and a read that BEATS the deadline is never cancelled.
  let late = 0;
  assert.equal(await withDeadline(Promise.resolve("v"), 10000, null, { onTimeout: () => late++ }), "v");
  assert.equal(late, 0);
});

test("codex P2: createSingleFlight caps concurrent reads at one per key and clears on settle", async () => {
  const flight = createSingleFlight();
  let starts = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const start = () => {
    starts++;
    return gate;
  };
  const a = flight.run("wf.json", start);
  const b = flight.run("wf.json", start);
  assert.equal(starts, 1, "a second caller must join the outstanding read, not start another");
  assert.equal(a, b, "both callers share the same promise");
  assert.equal(flight.size(), 1);
  // A DIFFERENT key is independent (its own outstanding read, its own slot).
  const otherPending = flight.run("other.json", () => {
    starts++;
    return new Promise(() => {});
  });
  assert.ok(otherPending);
  assert.equal(starts, 2);
  assert.equal(flight.size(), 2);
  release("done");
  assert.equal(await a, "done");
  assert.equal(flight.size(), 1, "a settled key must be released so the next open can read again");
  // A rejected read must also release its slot (and stay rejected for its waiters).
  await assert.rejects(
    flight.run("boom.json", () => Promise.reject(new Error("nope"))),
    /nope/,
  );
  assert.equal(flight.size(), 1, "a rejected read must not hold its slot forever");
  // A synchronously throwing starter must not occupy a slot either.
  await assert.rejects(
    flight.run("sync.json", () => {
      throw new Error("sync boom");
    }),
    /sync boom/,
  );
  assert.equal(flight.size(), 1);
});

// --- the receipt journal --------------------------------------------------

test("the receipt journal is bounded and keeps the NEWEST entries", () => {
  const journal = [];
  for (let i = 0; i < OPEN_RECEIPT_CAP + 5; i++) {
    recordOpenReceipt(journal, makeOpenReceipt({ seq: i, requested: `w${i}.json` }));
  }
  assert.equal(journal.length, OPEN_RECEIPT_CAP);
  assert.equal(latestOpenReceipt(journal).seq, OPEN_RECEIPT_CAP + 4);
  assert.equal(latestOpenReceipt([]), null);
});

test("makeOpenReceipt starts reply_sent FALSE; markOpenReceiptReplySent flips it by rid only", () => {
  const journal = [];
  recordOpenReceipt(journal, receiptFor("a.json"));
  assert.equal(latestOpenReceipt(journal).reply_sent, false);
  assert.equal(markOpenReceiptReplySent(journal, "nope"), false);
  assert.equal(latestOpenReceipt(journal).reply_sent, false);
  assert.equal(markOpenReceiptReplySent(journal, "rid-1"), true);
  assert.equal(latestOpenReceipt(journal).reply_sent, true);
});

test("summarizeOpenReceipt reports an AGE, never a raw clock the other process can't trust", () => {
  const s = summarizeOpenReceipt(receiptFor("a.json"), { now: 3500 });
  assert.equal(s.ms_ago, 2500);
  assert.equal(s.applied, true);
  assert.equal(s.requested, "a.json");
  assert.equal(summarizeOpenReceipt(null), null);
});

// --- the truth function ---------------------------------------------------

test('#402 CORE: a matching `active` alone is NOT success — verdict stays "undetermined"', () => {
  // The reported scenario verbatim: ComfyUI restarts, the frontend restores the same
  // workflow as active, the agent's workflow_open drops mid-command and never ran.
  const v = classifyOpenOutcome({
    requested: "workflows/x.json",
    rid: "rid-1",
    receipt: null,
    activeMatchesRequest: true,
    activeConfirmed: true,
  });
  assert.equal(v.outcome, "undetermined");
  assert.match(v.detail, /does NOT prove/i);
  assert.match(v.detail, /UNDETERMINED/);
  assert.equal(v.evidence.active_matches_request, true);
  assert.equal(v.evidence.correlated_by_rid, false);
});

test("#402: THIS command's receipt, applied ⇒ applied (authoritative)", () => {
  const v = classifyOpenOutcome({
    requested: "workflows/x.json",
    rid: "rid-1",
    receipt: receiptFor("workflows/x.json"),
    activeMatchesRequest: false,
    activeConfirmed: false,
  });
  assert.equal(v.outcome, "applied");
  assert.equal(v.evidence.correlated_by_rid, true);
  assert.match(v.detail, /could not deliver the reply/);
});

test("#402: a receipt that FAILED ⇒ not_applied, carrying the real error (a true negative)", () => {
  const v = classifyOpenOutcome({
    requested: "workflows/x.json",
    rid: "rid-1",
    receipt: receiptFor("workflows/x.json", { applied: false, error: "workflow service unavailable" }),
  });
  assert.equal(v.outcome, "not_applied");
  assert.match(v.detail, /workflow service unavailable/);
});

test("#402 codex P1: an EARLIER open of the SAME workflow can never answer for a later command", () => {
  // Command A opened x.json and succeeded. Command B asks for x.json again and is dropped
  // BEFORE the executor ran, so it has no receipt of its own. Selector equality alone would
  // read A's receipt as proof that B applied — the exact fabrication #402 must not produce.
  const v = classifyOpenOutcome({
    requested: "workflows/x.json",
    rid: "rid-B",
    receipt: receiptFor("workflows/x.json", { rid: "rid-A" }),
    activeMatchesRequest: true,
    activeConfirmed: true,
  });
  assert.equal(v.outcome, "undetermined");
  assert.equal(v.evidence.correlated_by_rid, false);
  assert.match(v.detail, /belongs to a DIFFERENT command/);
  assert.equal(v.evidence.latest_receipt.rid, "rid-A", "the receipt is offered as evidence, not as the verdict");
});

test("#402 codex P1: with NO rid to correlate, the verdict is undetermined — never applied", () => {
  const v = classifyOpenOutcome({
    requested: "workflows/x.json",
    receipt: receiptFor("workflows/x.json"),
    activeMatchesRequest: true,
    activeConfirmed: true,
  });
  assert.equal(v.outcome, "undetermined");
});

test("#570-class: ANOTHER workflow's receipt can never answer, even on a rid match", () => {
  const v = classifyOpenOutcome({
    requested: "workflows/x.json",
    rid: "rid-1",
    receipt: receiptFor("workflows/OTHER.json"),
    activeMatchesRequest: true,
    activeConfirmed: true,
  });
  assert.equal(v.outcome, "undetermined", "a rid match with a mismatched workflow must refuse, not answer");
  assert.equal(receiptAnswersCommand(receiptFor("workflows/OTHER.json"), { requested: "workflows/x.json", rid: "rid-1" }), false);
});

test("receiptAnswersCommand demands an exact rid and rejects every weaker form", () => {
  const r = receiptFor("workflows/x.json");
  assert.equal(receiptAnswersCommand(r, { requested: "workflows/x.json", rid: "rid-1" }), true);
  assert.equal(receiptAnswersCommand(r, { requested: "workflows/x.json" }), false, "no rid ⇒ no answer");
  assert.equal(receiptAnswersCommand(r, { requested: "workflows/x.json", rid: "" }), false);
  assert.equal(receiptAnswersCommand(r, { rid: "rid-1" }), true, "rid alone answers when no workflow is asserted");
  assert.equal(receiptAnswersCommand(null, { rid: "rid-1" }), false);
});

test("the exported receipt summary carries the rid (without it nothing can correlate)", () => {
  const s = summarizeOpenReceipt(receiptFor("workflows/x.json"), { now: 2000 });
  assert.equal(s.rid, "rid-1");
});

test('#402 codex P1: applied:"unknown" ⇒ undetermined + possibly_applied + a do-not-retry warning', () => {
  // workflow_new created the blank tab but the frontend never surfaced it. Reporting a
  // clean failure (or nothing) would invite a retry, and workflow_new is NOT idempotent.
  const receipt = makeOpenReceipt({
    seq: 3,
    cmd: "workflow_new",
    rid: "rid-N",
    applied: "unknown",
    error: "frontend did not expose the new workflow",
    at: 10,
  });
  assert.equal(receipt.applied, "unknown", "the tri-state must survive normalization");
  const v = classifyOpenOutcome({ rid: "rid-N", receipt });
  assert.equal(v.outcome, "undetermined");
  assert.equal(v.possibly_applied, true);
  assert.match(v.detail, /not idempotent/);
  assert.match(v.detail, /Do NOT blindly retry/);
});

test('#402 codex P1: "applied" names the workflow it LANDED on, and flags a re-resolved selector', () => {
  // A selector can resolve differently after a mid-command list refresh, so "applied"
  // alone would let a reader assume the workflow they named.
  const receipt = makeOpenReceipt({
    seq: 4,
    cmd: "workflow_open",
    rid: "rid-1",
    requested: "x",
    resolved: { path: "workflows/b.json", filename: "b.json", routing_key: "wf:workflows/b.json" },
    applied: true,
    at: 5,
  });
  const v = classifyOpenOutcome({ requested: "x", rid: "rid-1", receipt });
  assert.equal(v.outcome, "applied");
  assert.equal(v.opened.path, "workflows/b.json");
  assert.match(v.detail, /landed on "workflows\/b\.json"/);
  assert.match(v.detail, /confirm this is the workflow you meant/);
  // …and a caller that knows its canonical target can make that check ENFORCEABLE.
  const strict = classifyOpenOutcome({
    requested: "x",
    rid: "rid-1",
    expectedTarget: "workflows/a.json",
    receipt,
  });
  assert.equal(strict.outcome, "undetermined", "a receipt that landed elsewhere must not answer");
});

test("receiptMatchesRequest accepts any RESOLVED identity form of the same open", () => {
  const r = receiptFor("workflows/x.json");
  assert.equal(receiptMatchesRequest(r, "workflows/x.json"), true);
  assert.equal(receiptMatchesRequest(r, "a.json"), true, "resolved filename form");
  assert.equal(receiptMatchesRequest(r, "wf:workflows/x.json"), true, "resolved routing id");
  assert.equal(receiptMatchesRequest(r, "workflows/other.json"), false);
  assert.equal(receiptMatchesRequest(null, "x"), false);
  assert.equal(receiptMatchesRequest(r, ""), false);
});

// --- wiring contract in the panel -----------------------------------------

test("#402 wiring: workflow_open BOUNDS the post-open disk read and never claims fresh on timeout", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  assert.ok(body, "workflow_open must exist");
  assert.match(
    body,
    /withDeadline\(\s*\n?\s*staleReadFlight\.run\(target\.path,[\s\S]{0,200}?OPEN_DISK_READ_BUDGET_MS,/,
    "the #442 staleness read must be bounded — the open already applied, so it must not park the reply",
  );
  // codex P2: a deadline only stops US waiting. The read must also be cancellable and
  // single-flighted, or a server that accepts and never answers leaks a request per open.
  assert.match(body, /onTimeout: \(\) => readAbort\?\.abort\(\)/, "the deadline must cancel the read it abandoned");
  assert.match(body, /staleReadFlight\.run\(target\.path/, "reads must be single-flighted per workflow path");
  assert.match(body, /workflowDiskContent\(target\.path, \{ signal: readAbort\?\.signal \}\)/);
  // A null read must still land on the honest "unknown", never on a fresh claim.
  assert.match(body, /stale === "unknown"/, "a timed-out/unreadable disk read must degrade to stale:\"unknown\"");
  assert.ok(OPEN_DISK_READ_BUDGET_MS > 0 && OPEN_DISK_READ_BUDGET_MS <= 10000);
});

test("#402 wiring: workflow_open journals BOTH outcomes, and every early throw is a negative", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  assert.match(body, /const failOpen = \(err\) => \{/, "there must be a single negative-journal helper");
  assert.match(body, /applied: false/, "the failure path must journal applied:false");
  assert.match(body, /noteOpenAttempt\(\{[\s\S]*?cmd: "workflow_open",[\s\S]*?applied: true,/, "the success path must journal a receipt");
  // Every `throw` inside workflow_open must go through failOpen — an unjournaled throw
  // leaves a lost reply with no evidence at all. Code only: the prose discusses throws.
  const rawThrows = [...stripComments(body).matchAll(/\bthrow (?!failOpen)/g)];
  assert.equal(
    rawThrows.length,
    0,
    `every throw in workflow_open must be journaled via failOpen (found ${rawThrows.length} raw throws)`,
  );
});

test("#442 defect-2 wiring: the re-read is gated on a FRESH dirty re-check (no silent data loss)", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  const dirtyAt = body.indexOf("dirtyNow = !!target.isModified;");
  const decideAt = body.indexOf("staleInfo = decideOpenStaleness({");
  const reloadAt = body.indexOf("if (staleInfo.reload && !dirtyNow");
  assert.notEqual(dirtyAt, -1, "isModified must be re-read after the disk await, not reused from before it");
  assert.notEqual(reloadAt, -1, "the re-read must be gated");
  assert.ok(dirtyAt < decideAt && decideAt < reloadAt, "order: re-check dirty → decide → maybe reload");
  // The gate must be the FRESH value, and there must be no await between it and the gate.
  const between = stripComments(body.slice(dirtyAt, reloadAt));
  assert.ok(!/\bawait\b/.test(between), "no await may sit between the dirty re-check and the reload gate");
  assert.match(body, /isModified: dirtyNow \|\| wasDirty/, "the staleness decision must honour BOTH dirty signals");
  assert.match(body, /conflict: true/, "stale + unsaved edits must surface a CONFLICT, not a silent pick");
  assert.match(body, /reloaded,/, "the reply must state whether the canvas was actually re-read");
  assert.match(body, /reloadError = coerceMessageText/, "a failed re-read must never be reported as reloaded");
});

test("#442 codex P1: the destructive re-read freezes canvas interaction and ALWAYS restores it", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  // The clean sample authorizes the load, but loadGraphData is awaited — an edit made
  // while it yields would be destroyed by a reload nobody asked for.
  const lockAt = body.indexOf("canvasView.allow_interaction = false;");
  const firstRebaselineAt = body.indexOf("await clearSpuriousOpenModified(target);");
  const loadAt = body.indexOf("await app.loadGraphData(diskGraph");
  const rebaselineAt = body.indexOf("await clearSpuriousOpenModified(target);", loadAt);
  const restoreAt = body.indexOf("canvasView.allow_interaction = priorInteraction;");
  assert.ok(lockAt !== -1 && loadAt !== -1 && restoreAt !== -1, "the load must be bracketed by an interaction lock");
  // clearSpuriousOpenModified awaits a frame and then RE-BASELINES the change tracker, so
  // an edit made during it is absorbed as the new CLEAN baseline — which would make the
  // dirty gate read false and authorize the reload to overwrite that edit. The freeze must
  // therefore start BEFORE the FIRST (post-switch) re-baseline, not just before the load,
  // and must still be held across the second one (codex R2 + R4).
  assert.notEqual(firstRebaselineAt, -1, "the open must re-baseline after its repaint");
  assert.notEqual(rebaselineAt, -1, "the reload must re-baseline the change tracker");
  assert.ok(
    lockAt < firstRebaselineAt,
    "the freeze must start before the FIRST re-baseline, whose frame could otherwise absorb an edit",
  );
  assert.ok(
    firstRebaselineAt < loadAt && loadAt < rebaselineAt && rebaselineAt < restoreAt,
    "lock → repaint/re-baseline → disk decision → load → re-baseline → restore",
  );
  // The dirty sample must live INSIDE the frozen region.
  const dirtySampleAt = body.indexOf("dirtyNow = !!target.isModified;");
  assert.ok(lockAt < dirtySampleAt && dirtySampleAt < restoreAt, "the dirty sample must be taken under the freeze");
  // The restore must live in a `finally`, so a throwing load can never strand a frozen canvas.
  const tail = body.slice(loadAt, restoreAt + 200);
  assert.match(tail, /\} finally \{[\s\S]*allow_interaction = priorInteraction;/, "the restore must be in a finally");
  assert.match(body, /typeof canvasView\?\.allow_interaction === "boolean"/);
  // The local must NOT be named so that it ends in "s": the #268 contract scanner
  // captures `s\.<member>` unanchored, so `canvas.allow_interaction` reads as a new
  // workflow-SERVICE dependency and fails that gate.
  assert.equal(/\bcanvas\.allow_interaction/.test(body), false);
});

test("#442 codex R7: a tab that arrived DIRTY is never re-baselined and never reloaded", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  // clearSpuriousOpenModified captures the canvas as the new baseline and FORCES
  // isModified=false. On a tab that already had unsaved edits that does not clear a
  // spurious flag — it erases a REAL one, after which every later dirty check reads clean
  // and the destructive reload is authorized over the user's work.
  const wasDirtyAt = body.indexOf("const wasDirty = !!target.isModified;");
  const openAt = body.indexOf("await s.openWorkflow(target);");
  assert.notEqual(wasDirtyAt, -1, "the pre-open dirty state must be snapshotted");
  assert.ok(wasDirtyAt < openAt, "…BEFORE any await, since it cannot be recovered afterwards");
  assert.match(
    body,
    /if \(!wasDirty\) await clearSpuriousOpenModified\(target\);/,
    "a genuinely dirty tab must never be re-baselined",
  );
  // BOTH reload gates must require the pre-open snapshot to be clean too.
  const gates = [...body.matchAll(/if \(staleInfo\.reload && !dirtyNow[^)]*\)/g)].map((m) => m[0]);
  assert.ok(gates.length >= 2, "both the skip and the reload branch must be gated");
  for (const g of gates) assert.match(g, /!wasDirty/, `gate must honour the pre-open snapshot: ${g}`);
  // …and the conflict report must fire for either signal.
  assert.match(body, /: dirtyNow \|\| wasDirty/, "a pre-open dirty tab must be reported as a CONFLICT");
});

test("#442 codex P1: with NO reliable freeze available, the destructive reload is SKIPPED", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  // Serving a stale graph behind a loud flag is recoverable; silently eating an edit made
  // during an unrequested load is not. So an absent allow_interaction must skip the reload.
  assert.match(
    body,
    /if \(staleInfo\.reload && !dirtyNow && !wasDirty && priorInteraction === null\) \{/,
    "no interaction flag ⇒ no automatic reload",
  );
  assert.match(body, /could not be protected against a concurrent edit and was skipped/);
});

test("#402 codex P1: workflow_new records UNKNOWN (never a clean failure) once creation started", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_new({");
  assert.ok(body, "workflow_new must exist");
  // Before the creation command runs, a failure is a clean negative — safe to retry.
  assert.match(body, /applied: false,\s*\n\s*error: "command service unavailable"/);
  // After it runs, a blank tab may exist. workflow_new is NOT idempotent, so neither
  // "no receipt" nor applied:false is acceptable — both read as "nothing happened".
  const created = body.indexOf('await mgr.command.execute("Comfy.NewBlankWorkflow");');
  assert.notEqual(created, -1);
  const afterCreate = body.slice(created);
  assert.equal(
    /applied: false/.test(afterCreate),
    false,
    "no path after the creation command may record a clean failure",
  );
  assert.equal(
    (afterCreate.match(/applied: "unknown"/g) || []).length >= 1,
    true,
    "a post-creation failure must be journaled as UNKNOWN",
  );
});

test("#570 P0b: the #442 re-read must KEEP this tab's instance identity (no mid-open fork)", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  // The re-read loads a file written OUT OF BAND, so its embedded uuid may be absent or
  // belong to something else. Without __cmcpKeepInstance the create-boundary fork would
  // mint a NEW identity for this tab mid-open and the next stamped command would be
  // refused as a "workflow instance mismatch" against the session that asked for the open.
  assert.match(
    body,
    /await app\.loadGraphData\(diskGraph, true, true, target, \{ __cmcpKeepInstance: true \}\)/,
    "the disk re-read must pass __cmcpKeepInstance, exactly as graph_load does",
  );
});

test("#402 wiring: workflow_list exposes the receipt + the POSITIVE trust flag", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "workflow_list()");
  assert.ok(body, "workflow_list must exist");
  assert.match(body, /active_confirmed: !activeMaybeStale/, "trust must be reported positively, not inferred from silence");
  assert.match(body, /last_open: lastOpen/, "the last open receipt must be reachable after a lost reply");
  assert.match(body, /summarizeOpenReceipt\(latestOpenReceipt\(openReceipts\)/);
  // The consumer is in ANOTHER process, so the reading rule ships WITH the data — a
  // receipt that merely names the right workflow is the most over-readable thing here.
  assert.match(body, /answers_only_command_rid: lastOpenReceipt\.rid/);
  assert.match(body, /interpretation:/, "last_open must state how it may be read");
  assert.match(body, /answers ONLY for the command/);
  assert.match(body, /do not infer success from `active` matching your target/);
});
