// #402 — keep `panel_open_workflow`'s OUTCOME truthful across a mid-command drop.
//
// Field report (#402): after a ComfyUI restart, `panel_open_workflow` came back as
//   `panel tab wf:… disconnected mid-command ("workflow_open") — OUTCOME UNKNOWN`
// The command had already been written to the socket, so the caller could not tell
// whether the workflow actually opened. Two independent defects feed that:
//
//  1. THE PANEL HOLDS A KNOWN-GOOD ANSWER HOSTAGE. `workflow_open` applies the switch
//     and then, before replying, reads the workflow file back off ComfyUI over HTTP
//     purely to compute the #442 out-of-band-staleness hint. In exactly the #402 window
//     ComfyUI's HTTP layer is what is flaky (the same report's `panel_save_workflow`
//     returned "Failed to fetch"), and that read had NO deadline — a server that accepts
//     the connection and never answers parks the reply for the whole browser timeout.
//     The open ALREADY happened; the only thing still unknown is a cosmetic hint. So the
//     read is bounded here and degrades to the ALREADY-SUPPORTED `stale:"unknown"`.
//
//  2. THE PANEL KEEPS NO RECORD OF WHAT IT DID. Once the reply is lost there is nothing
//     left to ask. A verifier is then reduced to re-reading `workflow_list.active` — but
//     right after a backend restart the panel itself declares that pointer NOT
//     authoritative (`active_possibly_stale`, #433), because the frontend restores a tab
//     on its own. Since the usual #402 request is "open the workflow that is already
//     active", a matching `active` proves NOTHING: the restore alone produces it. Calling
//     that success is a FABRICATION — the single worst outcome for this path.
//
// So the panel keeps an OPEN RECEIPT: for every `workflow_open` / `workflow_new` that
// RAN — succeeded or failed — it records the raw selector it was asked for, the identity
// it actually resolved to, and whether it applied. `workflow_list` then reports the
// latest receipt, so "did my dropped open apply?" is answered from the panel's own
// execution instead of being inferred from an ambiguous pointer. When there is no
// matching receipt the honest verdict is "undetermined" — never "opened".
//
// Dependency-free (no DOM, no app, no globals) so it is unit-testable with plain values.

/** Deadline for the post-open on-disk staleness read (#442) inside `workflow_open`.
 *  The open has already been applied when this runs, so the ONLY thing at stake is the
 *  staleness hint — never make the caller wait on ComfyUI's HTTP layer for it. */
export const OPEN_DISK_READ_BUDGET_MS = 2500;

/** How many open receipts to keep. A handful is plenty: a verifier only ever asks about
 *  the command it just lost, and an unbounded journal in a long-lived tab is a leak. */
export const OPEN_RECEIPT_CAP = 8;

/**
 * Await `promise` but give up after `ms` and resolve `fallback` instead. NEVER rejects:
 * a rejection ALSO resolves `fallback`, so a caller can treat "could not determine" and
 * "took too long to determine" identically (both are the same honest `unknown`).
 *
 * The timer is cleared on the settle path so a bounded read cannot leave a pending timer
 * behind in a page that stays open for hours. `setTimer`/`clearTimer` are injectable so
 * tests drive the deadline deterministically instead of sleeping.
 */
export function withDeadline(
  promise,
  ms,
  fallback,
  { setTimer = setTimeout, clearTimer = clearTimeout, onTimeout } = {},
) {
  const settleValue = (v) => v;
  if (!Number.isFinite(ms) || ms <= 0) {
    // No usable deadline → just neutralize rejection (same contract, no timer).
    return Promise.resolve(promise).then(settleValue, () => fallback);
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      // Give the caller a chance to CANCEL the underlying work (codex P2). Resolving the
      // wrapper only stops US waiting — without this the request itself keeps running, so
      // repeated opens against a server that accepts and never answers would pile up live
      // requests behind a deadline that only ever looked like it bounded them.
      try {
        onTimeout?.();
      } catch {
        /* cancellation is best-effort — it must never change the deadline's outcome */
      }
      resolve(fallback);
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * Coalesce concurrent work by key: while a call for `key` is outstanding, every further
 * caller gets THAT promise instead of starting another.
 *
 * Why the staleness read needs it (codex P2): `withDeadline` stops us WAITING but cannot
 * abort work it did not create, and one of the two disk-read paths (`api.getUserData`)
 * takes no AbortSignal at all. Against a server that accepts requests and never answers,
 * repeated opens of the same workflow would otherwise leave one live request behind each
 * time. Single-flighting caps that at ONE outstanding read per workflow, whether or not
 * cancellation is available.
 */
export function createSingleFlight() {
  const inFlight = new Map();
  return {
    run(key, start) {
      const existing = inFlight.get(key);
      if (existing) return existing;
      let tracked;
      const done = () => {
        if (inFlight.get(key) === tracked) inFlight.delete(key);
      };
      let started;
      try {
        started = Promise.resolve(start());
      } catch (err) {
        return Promise.reject(err);
      }
      tracked = started.then(
        (v) => {
          done();
          return v;
        },
        (err) => {
          done();
          throw err;
        },
      );
      inFlight.set(key, tracked);
      return tracked;
    },
    size() {
      return inFlight.size;
    },
  };
}

function textOrNull(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Build one open receipt.
 *
 * `requested` is the RAW selector the caller passed (a path, filename, native key, or a
 * per-instance routing id). `resolved` is what the panel actually landed on. Both are
 * recorded deliberately: a verifier must be able to confirm the receipt is about ITS
 * request AND that the request resolved to the workflow it meant — "an open happened"
 * is not the same claim as "MY open, of THAT workflow, happened" (the wrong-workflow
 * failure mode the #570 identity work exists to prevent).
 *
 * `applied` is the load-bearing field, and it is TRI-STATE:
 *   true        — the executor ran to completion.
 *   false       — it failed BEFORE changing anything. A genuine negative, just as
 *                 important as the positive.
 *   "unknown"   — it got far enough that something MAY have taken effect but the panel
 *                 cannot confirm it (e.g. workflow_new's blank tab was created and then
 *                 the frontend would not surface it). Recording `false` there would
 *                 invite a retry, and workflow_new is NOT idempotent — a retry makes a
 *                 SECOND blank workflow. Omitting the receipt entirely would do the same.
 */
export function makeOpenReceipt({
  seq = 0,
  cmd = "workflow_open",
  rid = null,
  requested = null,
  resolved = null,
  applied = false,
  error = null,
  at = 0,
  reconnectEpoch = 0,
} = {}) {
  const r = resolved && typeof resolved === "object" ? resolved : {};
  return {
    seq: Number.isFinite(seq) ? seq : 0,
    cmd: typeof cmd === "string" && cmd ? cmd : "workflow_open",
    rid: textOrNull(rid),
    requested: textOrNull(requested),
    resolved: {
      path: textOrNull(r.path),
      filename: textOrNull(r.filename),
      routing_key: textOrNull(r.routing_key ?? r.routingKey),
    },
    applied: applied === "unknown" ? "unknown" : Boolean(applied),
    error: textOrNull(error),
    at: Number.isFinite(at) ? at : 0,
    reconnect_epoch: Number.isFinite(reconnectEpoch) ? reconnectEpoch : 0,
    // Flipped to true ONLY once the reply for this command was handed to an OPEN socket.
    // It is ADVISORY, never proof of receipt: a socket can die between `send()` and the
    // bytes landing. `applied` is the claim about the WORKFLOW; this is only about the
    // reply's delivery attempt, and it exists so a caller can tell "you never heard my
    // answer" apart from "you heard it and are asking again".
    reply_sent: false,
  };
}

/** Append `receipt` to `journal` (mutating, newest LAST) and trim to `cap`. */
export function recordOpenReceipt(journal, receipt, cap = OPEN_RECEIPT_CAP) {
  if (!Array.isArray(journal) || !receipt) return journal;
  journal.push(receipt);
  const limit = Number.isFinite(cap) && cap > 0 ? cap : OPEN_RECEIPT_CAP;
  while (journal.length > limit) journal.shift();
  return journal;
}

/** The most recent receipt, or null. */
export function latestOpenReceipt(journal) {
  if (!Array.isArray(journal) || !journal.length) return null;
  return journal[journal.length - 1];
}

/** Mark the receipt carrying `rid` as having had its reply written to an open socket. */
export function markOpenReceiptReplySent(journal, rid) {
  const want = textOrNull(rid);
  if (!want || !Array.isArray(journal)) return false;
  for (let i = journal.length - 1; i >= 0; i--) {
    if (journal[i] && journal[i].rid === want) {
      journal[i].reply_sent = true;
      return true;
    }
  }
  return false;
}

/** Wire form of a receipt: compact, and with an AGE rather than an absolute timestamp
 *  (the reader is another process on a possibly different clock). */
export function summarizeOpenReceipt(receipt, { now = 0 } = {}) {
  if (!receipt) return null;
  const age =
    Number.isFinite(now) && Number.isFinite(receipt.at) && receipt.at > 0 && now >= receipt.at
      ? Math.round(now - receipt.at)
      : null;
  return {
    seq: receipt.seq,
    cmd: receipt.cmd,
    // The SERVER-MINTED command id this receipt belongs to. Exported deliberately: it is
    // the ONLY thing that ties a receipt to a SPECIFIC dispatch. Selector equality is not
    // enough — an earlier successful open of the same workflow would otherwise answer for
    // a later command that never ran (codex P1). A consumer that cannot match this rid
    // must treat the outcome as undetermined.
    rid: receipt.rid,
    requested: receipt.requested,
    resolved: receipt.resolved,
    applied: receipt.applied,
    ...(receipt.error ? { error: receipt.error } : {}),
    reply_sent: receipt.reply_sent,
    ...(age === null ? {} : { ms_ago: age }),
  };
}

/** Does `receipt` describe an attempt at `requested`? Matches on the RAW selector first
 *  (the exact string the caller sent), then on any resolved identity form — so a caller
 *  that asked by filename still recognizes a receipt resolved to a full path.
 *
 *  NOT SUFFICIENT ON ITS OWN for a verdict: two commands can name the SAME workflow, so
 *  this answers "is this receipt about that workflow?", never "is this receipt MINE?".
 *  Use receiptAnswersCommand() for the latter. */
export function receiptMatchesRequest(receipt, requested) {
  const want = textOrNull(requested);
  if (!receipt || !want) return false;
  if (receipt.requested === want) return true;
  const r = receipt.resolved || {};
  return r.path === want || r.filename === want || r.routing_key === want;
}

/**
 * Does `receipt` answer for THIS SPECIFIC dispatch? Requires the server-minted `rid` to
 * match EXACTLY, and (belt and braces) the workflow to match too.
 *
 * Why the rid is mandatory (codex P1): selector equality alone lets an EARLIER command's
 * receipt answer for a LATER one. Concretely — command A opens `x.json` and succeeds;
 * command B asks for `x.json` again, is dropped BEFORE the executor ever runs, and a
 * verifier reads the journal: A's receipt matches the selector, says `applied:true`, and
 * B is reported as having opened. That is precisely the fabricated success #402 exists to
 * prevent. Without a rid to correlate, the only truthful verdict is "undetermined".
 */
export function receiptAnswersCommand(receipt, { requested, rid, expectedTarget } = {}) {
  const wantRid = textOrNull(rid);
  if (!receipt || !wantRid) return false;
  if (receipt.rid !== wantRid) return false;
  // A rid match with a MISMATCHED workflow means the journal is inconsistent — refuse
  // rather than answer, so a mis-stamped receipt can never speak for another workflow.
  const wantRequested = textOrNull(requested);
  if (wantRequested && !receiptMatchesRequest(receipt, wantRequested)) return false;
  // OPTIONAL canonical target (codex): a SELECTOR is not an identity. workflow_open may
  // refresh the frontend's workflow list mid-command and re-resolve an ambiguous selector,
  // so a caller that knows the canonical target it meant (path / routing key, e.g. from
  // the dispatch-time pin) can require the receipt to have LANDED there. Without it the
  // receipt still tells the truth — `resolved` names what was actually opened — but the
  // caller must read it; this makes the check enforceable instead of advisory.
  const wantTarget = textOrNull(expectedTarget);
  if (wantTarget && !receiptMatchesRequest(receipt, wantTarget)) return false;
  return true;
}

/**
 * The honest verdict for "did MY open (the dispatch identified by `rid`) happen?", from
 * the panel's OWN execution record. Never upgrades a guess to a success.
 *
 *  - "applied"      — THIS command's receipt completed. Authoritative.
 *  - "not_applied"  — THIS command's receipt FAILED. Authoritative; carries the error.
 *  - "undetermined" — no receipt correlates to this command. This is the verdict in TWO
 *                     important cases, and both would otherwise fabricate success:
 *                       * the caller cannot supply a `rid`, or the journal's latest
 *                         receipt belongs to a DIFFERENT dispatch — an earlier open of
 *                         the SAME workflow must never answer for a later one (codex);
 *                       * the requested workflow is currently active. After a backend
 *                         reconnect the frontend restores a tab by itself (#433), so a
 *                         matching `active` is fully explained without our command ever
 *                         having run.
 *                     The evidence is returned alongside so the caller can decide what to
 *                     do, but the VERDICT stays "undetermined".
 */
export function classifyOpenOutcome({
  requested,
  rid,
  expectedTarget,
  receipt,
  activeMatchesRequest = false,
  activeConfirmed = false,
} = {}) {
  const evidence = {
    active_matches_request: Boolean(activeMatchesRequest),
    active_confirmed: Boolean(activeConfirmed),
    correlated_by_rid: false,
  };
  if (receiptAnswersCommand(receipt, { requested, rid, expectedTarget })) {
    evidence.correlated_by_rid = true;
    // WHICH workflow it landed on is part of the verdict, never a footnote: a selector can
    // resolve differently after a mid-command list refresh, so "applied" alone would let a
    // reader assume the workflow they named (codex).
    const landed =
      receipt.resolved?.path || receipt.resolved?.routing_key || receipt.resolved?.filename || null;
    if (receipt.applied === "unknown") {
      return {
        outcome: "undetermined",
        possibly_applied: true,
        opened: receipt.resolved,
        detail:
          `The panel STARTED "${receipt.cmd}" and cannot confirm whether it took effect` +
          (receipt.error ? ` (${receipt.error})` : ".") +
          ` Do NOT blindly retry: "${receipt.cmd}" is not idempotent, so a retry can leave a ` +
          `second workflow behind. Read the open workflow list and decide from what is there.`,
        evidence: { ...evidence, receipt: summarizeOpenReceipt(receipt) },
      };
    }
    if (receipt.applied === true) {
      return {
        outcome: "applied",
        opened: receipt.resolved,
        detail:
          `The panel completed "${receipt.cmd}" and it landed on ${landed ? `"${landed}"` : "the reported workflow"}` +
          (receipt.requested && landed && receipt.requested !== landed
            ? ` (asked for "${receipt.requested}" — confirm this is the workflow you meant)`
            : "") +
          (receipt.reply_sent ? "." : ", but could not deliver the reply."),
        evidence: { ...evidence, receipt: summarizeOpenReceipt(receipt) },
      };
    }
    return {
      outcome: "not_applied",
      detail:
        `The panel ran "${receipt.cmd}" for "${receipt.requested ?? requested}" and it FAILED` +
        (receipt.error ? `: ${receipt.error}` : "."),
      evidence: { ...evidence, receipt: summarizeOpenReceipt(receipt) },
    };
  }
  // Explain WHY it is undetermined, because the two reasons need different follow-ups —
  // and because "a receipt exists for this workflow" is exactly the evidence a reader
  // would otherwise over-read into a success.
  const sameWorkflowOtherCommand = receiptMatchesRequest(receipt, requested);
  return {
    outcome: "undetermined",
    detail:
      `The panel has no receipt correlating to this open of "${textOrNull(requested) ?? requested}". ` +
      (sameWorkflowOtherCommand
        ? "There IS a receipt for that workflow, but it belongs to a DIFFERENT command " +
          "(or could not be correlated by command id), so it cannot answer for this one — " +
          "an earlier open of the same workflow says nothing about whether this one ran. "
        : "") +
      (activeMatchesRequest
        ? "That workflow IS the active canvas right now, but the frontend restores a tab on its " +
          "own after a reconnect, so that does NOT prove the requested open ran. "
        : "") +
      "Treat the outcome as UNDETERMINED and re-issue panel_open_workflow (opening an " +
      "already-open workflow is safe and idempotent) rather than assuming either result.",
    evidence: {
      ...evidence,
      ...(receipt ? { latest_receipt: summarizeOpenReceipt(receipt) } : {}),
    },
  };
}
