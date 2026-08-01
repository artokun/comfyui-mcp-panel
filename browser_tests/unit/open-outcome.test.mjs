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
    /withDeadline\(\s*workflowDiskContent\(target\.path\),\s*OPEN_DISK_READ_BUDGET_MS,\s*null\s*\)/,
    "the #442 staleness read must be bounded — the open already applied, so it must not park the reply",
  );
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
  const dirtyAt = body.indexOf("const dirtyNow = !!target.isModified;");
  const decideAt = body.indexOf("const staleInfo = decideOpenStaleness({");
  const reloadAt = body.indexOf("if (staleInfo.reload && !dirtyNow)");
  assert.notEqual(dirtyAt, -1, "isModified must be re-read after the disk await, not reused from before it");
  assert.notEqual(reloadAt, -1, "the re-read must be gated");
  assert.ok(dirtyAt < decideAt && decideAt < reloadAt, "order: re-check dirty → decide → maybe reload");
  // The gate must be the FRESH value, and there must be no await between it and the gate.
  const between = stripComments(body.slice(dirtyAt, reloadAt));
  assert.ok(!/\bawait\b/.test(between), "no await may sit between the dirty re-check and the reload gate");
  assert.match(body, /isModified: dirtyNow/, "the staleness decision must use the fresh dirty value");
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
  const loadAt = body.indexOf("await app.loadGraphData(diskGraph");
  const restoreAt = body.indexOf("canvasView.allow_interaction = priorInteraction;");
  assert.ok(lockAt !== -1 && loadAt !== -1 && restoreAt !== -1, "the load must be bracketed by an interaction lock");
  assert.ok(lockAt < loadAt && loadAt < restoreAt, "lock → load → restore");
  // The restore must live in a `finally`, so a throwing load can never strand a frozen canvas.
  const tail = body.slice(loadAt, restoreAt + 200);
  assert.match(tail, /\} finally \{[\s\S]*allow_interaction = priorInteraction;/, "the restore must be in a finally");
  // …and only when we actually captured a boolean to restore.
  assert.match(body, /typeof canvasView\?\.allow_interaction === "boolean"/);
  // The local must NOT be named so that it ends in "s": the #268 contract scanner
  // captures `s\.<member>` unanchored, so `canvas.allow_interaction` reads as a new
  // workflow-SERVICE dependency and fails that gate.
  assert.equal(/\bcanvas\.allow_interaction/.test(body), false);
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
});
