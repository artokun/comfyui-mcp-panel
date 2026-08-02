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

/** The balanced block starting at an `if (...) {` marker. The source contracts below
 * need to prove a failure cannot merely skip one statement and then reach a later
 * re-baseline/disk read. Strip comments and literals first so their prose/braces do
 * not affect the lightweight structural scan. */
function blockAt(src, marker) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `missing block marker: ${marker}`);
  const brace = src.indexOf("{", start + marker.length);
  assert.notEqual(brace, -1, `missing opening brace: ${marker}`);
  const scan = stripComments(src).replace(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*")/g, "");
  const scanBrace = scan.indexOf("{", start + marker.length);
  let depth = 0;
  for (let i = scanBrace; i < scan.length; i += 1) {
    if (scan[i] === "{") depth += 1;
    if (scan[i] === "}" && --depth === 0) return src.slice(brace, i + 1);
  }
  throw new Error(`unterminated block: ${marker}`);
}

/** Extract a balanced source block while ignoring braces in comments and strings. */
function codeBlockAt(src, marker) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `missing block marker: ${marker}`);
  const brace = src.indexOf("{", start + marker.length);
  assert.notEqual(brace, -1, `missing opening brace: ${marker}`);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < src.length; i += 1) {
        if (src[i] === "\\") {
          i += 1;
          continue;
        }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return src.slice(brace, i + 1);
  }
  throw new Error(`unterminated block: ${marker}`);
}

/** Extract one simple top-level function for a behavioral panel-source test. */
function namedFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
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

test("#402/#721 wiring: workflow_open journals clean negatives and partial rebind outcomes", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  assert.match(body, /const failOpen = \(err\) => \{/, "there must be a single negative-journal helper");
  assert.match(body, /applied: false/, "the failure path must journal applied:false");
  assert.match(body, /noteOpenAttempt\(\{[\s\S]*?cmd: "workflow_open",[\s\S]*?applied: true,/, "the success path must journal a receipt");
  // A failed post-switch repaint is not a clean negative: the active workflow may
  // already have changed. It must be journaled UNKNOWN, while every other throw
  // remains a request that definitely did not apply. Code only: prose discusses throws.
  assert.match(body, /const failOpenRebindUnknown = \(err\) => \{/);
  assert.match(body, /applied: "unknown"/);
  const rawThrows = [...stripComments(body).matchAll(/\bthrow (?!failOpen|failOpenRebindUnknown)/g)];
  assert.equal(
    rawThrows.length,
    0,
    `every throw in workflow_open must be journaled as a clean negative or unknown partial outcome (found ${rawThrows.length} raw throws)`,
  );
});

test("#721 P1: an already-active workflow requires state even when empty, then proves the repaint", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  // graph-binding accepts both shapes; repainting only the tracker form stranded a
  // legitimate active tab whose state is exposed flat on the workflow object.
  assert.match(body, /const st = target\.changeTracker\?\.activeState \?\? target\.activeState;/);
  assert.match(
    body,
    /if \(!st \|\| !Array\.isArray\(st\.nodes\)\) \{[\s\S]{0,500}?rebindFailed = new Error\(/,
    "a state-less EMPTY target cannot report opened against the prior canvas",
  );
  const repaintAt = body.indexOf("await app.loadGraphData(repaintState, true, true, target);");
  const proofAt = body.indexOf("graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid: targetUuid })", repaintAt);
  const openedAt = body.lastIndexOf("applied: true");
  assert.ok(repaintAt !== -1 && proofAt > repaintAt && openedAt > proofAt, "must prove the repaint before success");
  // A failed/missing repaint is an honest unknown after s.openWorkflow may have
  // switched tabs, never the old fabricated {opened} receipt.
  assert.match(body, /if \(rebindFailed\) throw failOpenRebindUnknown\(rebindFailed\);/);
  assert.match(body, /workflow_open could not rebind the active canvas/);
});

test("#721 P1: dirty rebind success requires the target UUID, never only a read-shaped comparison", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  const repaintStart = body.indexOf("const targetUuid = workflowStableUuid");
  const repaint = body.slice(repaintStart, body.indexOf("} catch (err)", repaintStart));
  assert.match(repaint, /const targetUuid = workflowStableUuid\(target, \{ embed: true \}\);/);
  assert.match(repaint, /\[WORKFLOW_UUID_FIELD\]: targetUuid/);
  assert.match(repaint, /await app\.loadGraphData\(repaintState, true, true, target\);/);
  assert.match(repaint, /activeWorkflowRef\(\) !== target/);
  assert.match(repaint, /graphRootWorkflowUuidMatches\(\{ rootGraph, activeWorkflowUuid: targetUuid \}\)/);
  assert.match(repaint, /graphRootMatchesState\(\{ rootGraph, state: repaintState \}\)/);
  assert.doesNotMatch(repaint, /assertGraphBoundToActiveWorkflow\(/, "the read guard is deliberately non-strict for dirty roots");
});

test("#721 P1: a failed rebind never re-baselines, reads disk, or reloads the stale root", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  const successOnly = codeBlockAt(body, "if (!rebindFailed)");
  assert.match(successOnly, /await clearSpuriousOpenModified\(target, \{/);
  assert.match(successOnly, /await withDeadline\(/);
  assert.match(successOnly, /await app\.loadGraphData\(diskGraph/);
  const unknownAt = body.indexOf("if (rebindFailed) throw failOpenRebindUnknown(rebindFailed);");
  assert.ok(unknownAt > body.indexOf("if (!rebindFailed)"), "the unknown receipt is emitted only after the guarded success-only work");
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
  const firstRebaselineAt = body.indexOf("await clearSpuriousOpenModified(target, {");
  const loadAt = body.indexOf("await app.loadGraphData(diskGraph");
  const rebaselineAt = body.indexOf("await clearSpuriousOpenModified(target, {", loadAt);
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
    /if \(\s*!wasDirty &&\s*priorInteraction !== null &&\s*ownsWorkflowReloadGuard\(reloadGuardToken\)\s*\) \{[\s\S]{0,400}?await clearSpuriousOpenModified\(target, \{/,
    "a genuinely dirty tab must never be re-baselined, nor one we no longer hold exclusively",
  );
  // BOTH reload gates must require the pre-open snapshot to be clean too.
  const gates = [...body.matchAll(/if \(staleInfo\.reload && !dirtyNow[^)]*\)/g)].map((m) => m[0]);
  assert.ok(gates.length >= 2, "both the skip and the reload branch must be gated");
  for (const g of gates) assert.match(g, /!wasDirty/, `gate must honour the pre-open snapshot: ${g}`);
  // …and the conflict report must fire for either signal.
  assert.match(body, /: dirtyNow \|\| wasDirty/, "a pre-open dirty tab must be reported as a CONFLICT");
});

test("#442 codex R9: the switch+reload holds a critical section that REFUSES concurrent commands", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  // Freezing the canvas keeps the USER out of the window; the bridge is a second writer.
  // A valid graph_* command landing mid-reload is either overwritten by the load or —
  // worse — recorded as CLEAN by the tracker re-baseline, so the next out-of-band disk
  // change discards it with no conflict shown.
  const acquireAt = body.indexOf("acquireWorkflowReloadGuard(");
  const openAt = body.indexOf("await s.openWorkflow(target);");
  const releaseAt = body.indexOf("releaseWorkflowReloadGuard(reloadGuardToken);");
  assert.ok(acquireAt !== -1 && releaseAt !== -1, "the section must be acquired and released");
  assert.ok(acquireAt < openAt, "held from before the switch, so the whole mutating sequence is covered");
  assert.ok(openAt < releaseAt);
  // Release must be in the SAME finally as the canvas restore — a throw must never leave
  // the tab refusing every command.
  const tail = body.slice(body.indexOf("} finally {", openAt));
  assert.match(tail, /releaseWorkflowReloadGuard\(reloadGuardToken\);[\s\S]{0,200}allow_interaction = priorInteraction;/);
  // codex R10 — token-scoped: an expired-then-superseded holder must not release a NEWER
  // holder's section, and must not keep mutating once it has lost it.
  assert.match(src, /if \(workflowReloadGuard && workflowReloadGuard\.token === token\) workflowReloadGuard = null;/);
  assert.match(body, /!ownsWorkflowReloadGuard\(reloadGuardToken\)/, "losing the section must abort the destructive reload");
  assert.match(body, /lost its exclusive switch\/reload window/);

  // The dispatcher must refuse executors while it is held — nothing applied, retryable.
  const guardAt = src.indexOf("const reloadGuard = activeWorkflowReloadGuard();");
  const execAt = src.indexOf("result = await executor(msg);");
  assert.notEqual(guardAt, -1, "the command dispatcher must consult the section");
  assert.ok(guardAt < execAt, "…BEFORE running the executor");
  const refusal = src.slice(guardAt, execAt);
  assert.match(refusal, /was NOT applied — nothing changed\. Retry in a moment\./);
  // A stuck guard must age out rather than wedge the tab forever.
  assert.match(src, /Date\.now\(\) - workflowReloadGuard\.since > WORKFLOW_RELOAD_GUARD_MAX_MS/);
});

// The reload-guard block (let/const + the five functions) lives inline in
// comfyui-mcp-panel.js, so — per the "real panel source" extraction convention of
// graph-resize-node.test.mjs — it is regexed out of the file and evaluated with a FAKE
// Date injected, letting the tests drive the ACTUAL shipped logic across the 30s ceiling.
const reloadGuardMatch = readFileSync(PANEL_JS, "utf8").match(
  /let workflowReloadGuard = null;[\s\S]*?function activeWorkflowReloadGuard\(\) \{[\s\S]*?\n\}/,
);
assert.ok(reloadGuardMatch, "could not locate the workflow reload guard block in panel source");

/** Build a fresh guard section from the REAL panel source, with time driven by `now.t`. */
function realReloadGuard(now) {
  const factory = new Function(
    "Date",
    `${reloadGuardMatch[0]}\nreturn { acquireWorkflowReloadGuard, releaseWorkflowReloadGuard, ` +
      `beginWorkflowReloadStep, endWorkflowReloadStep, ownsWorkflowReloadGuard, activeWorkflowReloadGuard };`,
  );
  return factory({ now: () => now.t });
}

test("#442 DATA-LOSS: the guard CANNOT expire while a reload is genuinely in flight", () => {
  const now = { t: 1_000_000 };
  const g = realReloadGuard(now);
  const token = g.acquireWorkflowReloadGuard("wf:a.json");
  // The reload's loadGraphData await starts. Pre-fix, the 30s defensive ceiling fired
  // DURING this await: activeWorkflowReloadGuard() returned null, the dispatcher's fence
  // dropped, a graph command ran and was ACKNOWLEDGED — and the late-completing load then
  // overwrote that edit. The guard is now tied to the step's settle instead.
  assert.equal(g.beginWorkflowReloadStep(token), true, "the owner may mark a step in flight");
  now.t += 31_000; // past WORKFLOW_RELOAD_GUARD_MAX_MS, load still awaiting
  const held = g.activeWorkflowReloadGuard();
  assert.ok(held, "a step in flight must SUSPEND the ageing ceiling — the fence stays up");
  assert.equal(held.token, token, "…for the SAME holder");
  assert.equal(
    g.ownsWorkflowReloadGuard(token),
    true,
    "the reload's post-await ownership re-check still passes, so it may re-baseline",
  );
  // The load settles; the idle ceiling runs from the SETTLE, not from acquire, so a long
  // multi-step section cannot expire in the synchronous gap between two of its steps.
  g.endWorkflowReloadStep(token);
  now.t += 29_000;
  assert.ok(g.activeWorkflowReloadGuard(), "idle time is measured from the last step's settle");
  // …and the fence comes down ONLY through the open's own finally.
  g.releaseWorkflowReloadGuard(token);
  assert.equal(g.activeWorkflowReloadGuard(), null, "released by its owner — commands may run again");
});

test("#442 DATA-LOSS: the defensive ceiling still ages out a guard stuck BETWEEN steps", () => {
  const now = { t: 1_000_000 };
  const g = realReloadGuard(now);
  const token = g.acquireWorkflowReloadGuard("wf:a.json");
  g.beginWorkflowReloadStep(token);
  g.endWorkflowReloadStep(token);
  // No step in flight and no settle for 30s+ — the holder must have VANISHED without its
  // finally; age the guard out rather than wedge every command in the tab.
  now.t += 31_000;
  assert.equal(g.activeWorkflowReloadGuard(), null, "a guard idle past the ceiling still ages out");
  assert.equal(g.ownsWorkflowReloadGuard(token), false, "an outlived holder's re-checks fail closed");
  assert.equal(g.beginWorkflowReloadStep(token), false, "a non-owner must not start a step");
  // Token scoping is intact: the stale holder must not release a NEWER section.
  const newer = g.acquireWorkflowReloadGuard("wf:b.json");
  g.releaseWorkflowReloadGuard(token);
  assert.equal(g.activeWorkflowReloadGuard()?.token, newer, "a stale holder cannot release the newer section");
  // A balanced begin/finally-end never strands a pending hold.
  assert.equal(g.beginWorkflowReloadStep(newer), true);
  g.endWorkflowReloadStep(newer);
  g.endWorkflowReloadStep(newer); // over-ending is a no-op, never negative
  now.t += 31_000;
  assert.equal(g.activeWorkflowReloadGuard(), null, "balanced begin/end leaves the idle ceiling working");
});

test("#442 DATA-LOSS: every mutating await of the section is held across its own await", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  const begins = (body.match(/beginWorkflowReloadStep\(reloadGuardToken\);/g) || []).length;
  const ends = (body.match(/endWorkflowReloadStep\(reloadGuardToken\);/g) || []).length;
  assert.ok(begins >= 4, `the switch, repaint, reload and re-baseline awaits must each be held (got ${begins})`);
  assert.equal(begins, ends, "every held step needs its own end (balanced via finally)");
  // THE finding's case — the destructive disk reload: begin before the await, end in a
  // finally after it, so neither a slow load nor a throwing one can drop/strand the fence.
  const loadAt = body.indexOf("await app.loadGraphData(diskGraph");
  assert.notEqual(loadAt, -1);
  const beginAt = body.lastIndexOf("beginWorkflowReloadStep(reloadGuardToken);", loadAt);
  const endAt = body.indexOf("endWorkflowReloadStep(reloadGuardToken);", loadAt);
  assert.ok(beginAt !== -1 && beginAt < loadAt, "the reload await must start INSIDE a held step");
  assert.ok(loadAt < endAt, "…and the step must end only AFTER the load settles");
  assert.match(
    body.slice(loadAt, endAt + 60),
    /\} finally \{\s*endWorkflowReloadStep\(reloadGuardToken\);\s*\}/,
    "the step must end in a finally, so a throwing load cannot strand the fence",
  );
  // The repaint load has the same clobber shape (it overwrites the canvas with the tab's
  // pre-edit buffer), so it must be held too.
  const repaintAt = body.indexOf("await app.loadGraphData(repaintState, true, true, target);");
  assert.notEqual(repaintAt, -1);
  const repaintBegin = body.lastIndexOf("beginWorkflowReloadStep(reloadGuardToken);", repaintAt);
  const repaintEnd = body.indexOf("endWorkflowReloadStep(reloadGuardToken);", repaintAt);
  assert.ok(repaintBegin !== -1 && repaintBegin < repaintAt && repaintAt < repaintEnd, "the repaint await must be held too");
  // The mechanism: expiry requires NO step in flight, and ending a step rearms the clock.
  assert.match(
    src,
    /workflowReloadGuard\.pending === 0 &&[\s\S]{0,80}?Date\.now\(\) - workflowReloadGuard\.since > WORKFLOW_RELOAD_GUARD_MAX_MS/,
    "the ageing ceiling must be suspended while any step is in flight",
  );
  assert.match(
    src,
    /workflowReloadGuard\.pending -= 1;[\s\S]{0,80}?workflowReloadGuard\.since = Date\.now\(\);/,
    "ending a step must rearm the idle clock",
  );
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

test("#442 round-2: with NO freeze available the tracker is NOT re-baselined either (no silent clean-slate)", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  // clearSpuriousOpenModified awaits a frame, then captures the canvas as the CLEAN
  // baseline and forces isModified=false. The canvas freeze (allow_interaction) is what
  // makes that frame safe. On a frontend WITHOUT the flag the reload is skipped for
  // exactly that reason (priorInteraction === null) — so the tracker must not be
  // re-baselined either: an edit landing in the unprotected frame would be adopted as
  // clean, erasing unsaved-work protection and inviting later silent loss. (Round 3
  // extended the same exclusion to the first-time open — see the round-3 test below.)
  const skipGate = body.indexOf("if (staleInfo.reload && !dirtyNow && !wasDirty && priorInteraction === null)");
  const firstRebaseline = body.indexOf("await clearSpuriousOpenModified(target, {");
  assert.notEqual(skipGate, -1, "the no-freeze skip gate must exist");
  assert.notEqual(firstRebaseline, -1, "the post-repaint re-baseline must exist");
  assert.ok(firstRebaseline < skipGate, "fixture order: the re-baseline precedes the reload decision");
  assert.match(
    body,
    /if \(\s*!wasDirty &&\s*priorInteraction !== null &&\s*ownsWorkflowReloadGuard\(reloadGuardToken\)\s*\) \{[\s\S]{0,400}?await clearSpuriousOpenModified\(target, \{/,
    "the pre-reload re-baseline must be gated on the freeze holding — the same condition whose absence skips the reload",
  );
  // The only OTHER re-baseline is the post-reload one, and it stays gated on the reload
  // actually having run: `reloaded = true` precedes it, under the same exclusive window.
  const reloadedAt = body.indexOf("reloaded = true;");
  const secondRebaseline = body.indexOf("await clearSpuriousOpenModified(target, {", firstRebaseline + 1);
  assert.ok(reloadedAt !== -1 && reloadedAt < secondRebaseline, "the second re-baseline must follow a completed reload");
  // Two call sites, both gated — no third, ungated re-baseline may creep in.
  assert.equal(
    (body.match(/await clearSpuriousOpenModified\(target, \{/g) || []).length,
    2,
    "workflow_open re-baselines the tracker exactly twice, each behind a gate",
  );
});

test("#442 round-3: a FIRST-TIME open never re-baselines without the freeze (edit in the frame stays dirty)", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_open({");
  // The freeze handle is non-null ONLY for an already-open tab on a frontend exposing
  // allow_interaction — exactly the case where the freeze below is actually applied.
  assert.match(
    body,
    /const priorInteraction =\s*wasOpen && typeof canvasView\?\.allow_interaction === "boolean"/,
    "priorInteraction !== null ⟺ the freeze is held",
  );
  // clearSpuriousOpenModified awaits a frame, then captures the canvas as the CLEAN
  // baseline and forces isModified=false. A first-time open holds NO freeze by design,
  // so if the cleanup ran there an edit landing in that frame would be adopted as
  // clean — and a later stale open could then auto-reload the disk file over that
  // unsaved work (the round-3 DATA-LOSS finding). The gate must require the freeze
  // with NO !wasOpen exception; the fresh tab keeps a spurious flag (loud, cosmetic)
  // instead of a silent clean-slate.
  const gate = body.match(
    /if \(\s*!wasDirty &&\s*priorInteraction !== null &&\s*ownsWorkflowReloadGuard\(reloadGuardToken\)\s*\) \{[\s\S]{0,400}?await clearSpuriousOpenModified\(target, \{/,
  );
  assert.ok(gate, "the pre-reload re-baseline must be gated on the freeze holding");
  assert.doesNotMatch(
    gate[0],
    /!wasOpen/,
    "no first-time-open exception may re-open the unprotected frame",
  );
  // …which means a first-time open (wasOpen false ⇒ priorInteraction null) can NEVER
  // reach the capture/reset: an in-frame edit keeps the tracker dirty, so BOTH reload
  // paths below (each requires !dirtyNow && !wasDirty) stay closed over that work.
  const gates = [...body.matchAll(/if \(staleInfo\.reload && !dirtyNow[^)]*\)/g)].map((m) => m[0]);
  assert.ok(gates.length >= 2, "both reload paths stay gated on the fresh dirty re-check");
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

test("#402 round-2: once NewBlankWorkflow has run, the guidance forbids a retry (no SECOND blank tab)", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = handlerBody(src, "async workflow_new({");
  const created = body.indexOf('await mgr.command.execute("Comfy.NewBlankWorkflow");');
  assert.notEqual(created, -1);
  // Retrying workflow_new creates a SECOND blank tab and routes later edits to the wrong
  // workflow. Once creation has run the receipt truthfully records applied:"unknown" — so
  // the guidance must match it: do NOT retry, check workflow_list / canvas state first.
  const afterCreate = stripComments(body.slice(created));
  const errBlock = afterCreate.match(/const error =\s*\n?([\s\S]*?);/);
  assert.ok(errBlock, "the post-creation failure must build an explicit message");
  // Reassemble the concatenated literal so the check reads the message the caller gets.
  const msg = [...errBlock[1].matchAll(/"([^"\n]*)"/g)].map((m) => m[1]).join("");
  assert.doesNotMatch(
    msg,
    /(^|[.!?]\s+)Retry\b/,
    `no sentence may open with a blanket Retry once the blank tab exists: "${msg}"`,
  );
  assert.match(msg, /Do NOT retry/i, "the guidance must forbid the retry outright");
  assert.match(msg, /workflow_list/, "…and point at workflow_list / the canvas state instead");
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

test("#716 wiring: post-open and active workflow responses carry the live instance UUID", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const list = handlerBody(src, "workflow_list()");
  const open = handlerBody(src, "async workflow_open({");
  assert.ok(list && open, "workflow_list and workflow_open must exist");
  // The response source must be the live workflow object, not a path alias or
  // a stale mounted graph. The MCP only adopts a separately validated UUID.
  assert.match(list, /const \{ active, activeIdentity \} = liveWorkflowListActive\(\);/);
  assert.doesNotMatch(list, /const active = s\.activeWorkflow;/, "workflow_list must not publish a pre-reconnect service binding");
  assert.match(list, /activeIdentity \? \{ workflow_uuid: activeIdentity\.uuid \} : \{\}/);
  assert.match(open, /activeWorkflowUuidForOpenReply\(target\)/);
  assert.doesNotMatch(open, /activeWorkflowUuidForOpenReply\(target, s\.activeWorkflow\)/);
  assert.match(open, /activeWorkflowUuid \? \{ workflow_uuid: activeWorkflowUuid \} : \{\}/);
});

test("#716 P1: service rebind during workflow_open omits the former target UUID", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const pathSource = namedFunctionSource(src, "savedWorkflowPath");
  const canonicalUuidSource = namedFunctionSource(src, "isCanonicalWorkflowInstanceUuid");
  const identitySource = namedFunctionSource(src, "establishedWorkflowReplyIdentity");
  const helperSource = namedFunctionSource(src, "activeWorkflowUuidForOpenReply");
  assert.ok(pathSource && canonicalUuidSource && identitySource && helperSource, "the reply identity check must live in the shipped panel source");

  const openedTarget = { isPersisted: true, isTemporary: false, path: "workflows/a.json" };
  const otherActive = { isPersisted: true, isTemporary: false, path: "workflows/b.json" };
  const workflowUuids = new WeakMap([
    [openedTarget, "11111111-1111-4111-8111-111111111111"],
    [otherActive, "22222222-2222-4222-8222-222222222222"],
  ]);
  // This is the actual final-reply input: activeWorkflowRef observes whatever
  // workflow service is live at emission, not the service workflow_open held
  // before its repaint/disk awaits.
  let currentService = { activeWorkflow: openedTarget };
  const replyUuid = new Function(
    "activeWorkflowRef",
    "workflowObjectUuid",
    `${pathSource}; ${canonicalUuidSource}; ${identitySource}; ${helperSource}; return activeWorkflowUuidForOpenReply;`,
  )(
    () => currentService.activeWorkflow,
    (wf) => workflowUuids.get(wf),
  );

  assert.equal(replyUuid(openedTarget), "11111111-1111-4111-8111-111111111111", "the normal completed open reports its actual active tab");
  // workflow_open has retained its old local `s`, but a reconnect/rebind has
  // replaced the service before the final reply. The old service could still
  // report A; the actual binding now says B. Returning target.uuid here would
  // stamp the NEXT graph command for the wrong live canvas.
  const staleService = currentService;
  currentService = { activeWorkflow: otherActive };
  assert.equal(staleService.activeWorkflow, openedTarget, "the pre-await service still looks like the opened target");
  assert.equal(replyUuid(openedTarget), null, "the re-bound live service omits the stale reply UUID and leaves the MCP fence unchanged");
  assert.equal(replyUuid(otherActive), "22222222-2222-4222-8222-222222222222", "the same helper still reports the actual active tab");
});

test("#716 P1: service rebind during workflow_list reports only the current active UUID", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const pathSource = namedFunctionSource(src, "savedWorkflowPath");
  const canonicalUuidSource = namedFunctionSource(src, "isCanonicalWorkflowInstanceUuid");
  const identitySource = namedFunctionSource(src, "establishedWorkflowReplyIdentity");
  const listActiveSource = namedFunctionSource(src, "liveWorkflowListActive");
  assert.ok(pathSource && canonicalUuidSource && identitySource && listActiveSource, "workflow_list must obtain its active identity through the shipped live-binding helper");

  const staleActive = { isPersisted: true, isTemporary: false, path: "workflows/a/foo.json" };
  const currentActive = { isPersisted: true, isTemporary: false, path: "workflows/b/foo.json" };
  const workflowUuids = new WeakMap([
    [staleActive, "11111111-1111-4111-8111-111111111111"],
    [currentActive, "22222222-2222-4222-8222-222222222222"],
  ]);
  let currentService = { activeWorkflow: staleActive };
  const listActive = new Function(
    "activeWorkflowRef",
    "workflowObjectUuid",
    `${pathSource}; ${canonicalUuidSource}; ${identitySource}; ${listActiveSource}; return liveWorkflowListActive;`,
  )(
    () => currentService.activeWorkflow,
    (wf) => workflowUuids.get(wf),
  );

  assert.equal(listActive().activeIdentity?.uuid, "11111111-1111-4111-8111-111111111111");
  const staleService = currentService;
  currentService = { activeWorkflow: currentActive };
  assert.equal(staleService.activeWorkflow, staleActive, "the old executor service still points at A");
  const reply = listActive();
  assert.equal(reply.active, currentActive, "workflow_list observes the re-bound live service, not its captured service");
  assert.equal(reply.activeIdentity?.uuid, "22222222-2222-4222-8222-222222222222", "only B's current UUID is eligible for the list response");
  assert.notEqual(reply.activeIdentity?.uuid, "11111111-1111-4111-8111-111111111111");
});

test("#716 P1: a malformed truthy active binding cannot mint reply identity", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const pathSource = namedFunctionSource(src, "savedWorkflowPath");
  const canonicalUuidSource = namedFunctionSource(src, "isCanonicalWorkflowInstanceUuid");
  const identitySource = namedFunctionSource(src, "establishedWorkflowReplyIdentity");
  const helperSource = namedFunctionSource(src, "activeWorkflowUuidForOpenReply");
  const malformedActive = {};
  const workflowUuids = new WeakMap();
  const replyUuid = new Function(
    "activeWorkflowRef",
    "workflowObjectUuid",
    `${pathSource}; ${canonicalUuidSource}; ${identitySource}; ${helperSource}; return activeWorkflowUuidForOpenReply;`,
  )(
    () => malformedActive,
    (wf) => workflowUuids.get(wf),
  );

  // Execute the actual shipped reply helper against a truthy but malformed
  // binding. It must be an observation only: no tmp routing id and no UUID can
  // be initialized while deciding whether to publish the response field.
  assert.equal(replyUuid(malformedActive), null);
  assert.equal(workflowUuids.has(malformedActive), false, "must not mint an ephemeral workflow UUID");
});

test("#716 P1: a temporary workflow UUID is never published as a durable refresh source", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const pathSource = namedFunctionSource(src, "savedWorkflowPath");
  const canonicalUuidSource = namedFunctionSource(src, "isCanonicalWorkflowInstanceUuid");
  const identitySource = namedFunctionSource(src, "establishedWorkflowReplyIdentity");
  const helperSource = namedFunctionSource(src, "activeWorkflowUuidForOpenReply");
  const temporaryActive = { isPersisted: false, isTemporary: true };
  const workflowUuids = new WeakMap([[temporaryActive, "33333333-3333-4333-8333-333333333333"]]);
  const replyUuid = new Function(
    "activeWorkflowRef",
    "workflowObjectUuid",
    `${pathSource}; ${canonicalUuidSource}; ${identitySource}; ${helperSource}; return activeWorkflowUuidForOpenReply;`,
  )(
    () => temporaryActive,
    (wf) => workflowUuids.get(wf),
  );

  // Even an existing object-map UUID is insufficient for a temporary tab:
  // its tmp routing identity is ephemeral, so it cannot refresh the MCP's
  // durable command fence.
  assert.equal(replyUuid(temporaryActive), null);
});

test("#716 P1: existing mapped UUIDs still omit when noncanonical", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const pathSource = namedFunctionSource(src, "savedWorkflowPath");
  const canonicalUuidSource = namedFunctionSource(src, "isCanonicalWorkflowInstanceUuid");
  const identitySource = namedFunctionSource(src, "establishedWorkflowReplyIdentity");
  const helperSource = namedFunctionSource(src, "activeWorkflowUuidForOpenReply");
  const invalidVersion = { isPersisted: true, isTemporary: false, path: "workflows/invalid-version.json" };
  const invalidVariant = { isPersisted: true, isTemporary: false, path: "workflows/invalid-variant.json" };
  const uppercase = { isPersisted: true, isTemporary: false, path: "workflows/uppercase.json" };
  const workflowUuids = new WeakMap([
    [invalidVersion, "44444444-4444-0444-8444-444444444444"],
    [invalidVariant, "55555555-5555-4555-7555-555555555555"],
    [uppercase, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"],
  ]);
  let active = invalidVersion;
  const replyUuid = new Function(
    "activeWorkflowRef",
    "workflowObjectUuid",
    `${pathSource}; ${canonicalUuidSource}; ${identitySource}; ${helperSource}; return activeWorkflowUuidForOpenReply;`,
  )(
    () => active,
    (wf) => workflowUuids.get(wf),
  );

  for (const workflow of [invalidVersion, invalidVariant, uppercase]) {
    active = workflow;
    assert.equal(replyUuid(workflow), null, `mapped ${workflow.path} must not publish a noncanonical UUID`);
  }
});
