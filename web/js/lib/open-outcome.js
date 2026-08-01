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
  { setTimer = setTimeout, clearTimer = clearTimeout } = {},
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
 * `applied` is the load-bearing field: true only when the executor ran to completion.
 * A thrown open records `applied:false` WITH its error — that is a genuine NEGATIVE
 * signal, and it is just as important as the positive one.
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
    applied: Boolean(applied),
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
 *  that asked by filename still recognizes a receipt resolved to a full path. */
export function receiptMatchesRequest(receipt, requested) {
  const want = textOrNull(requested);
  if (!receipt || !want) return false;
  if (receipt.requested === want) return true;
  const r = receipt.resolved || {};
  return r.path === want || r.filename === want || r.routing_key === want;
}

/**
 * The honest verdict for "did the open of `requested` happen?", from the panel's OWN
 * execution record. Never upgrades a guess to a success.
 *
 *  - "applied"      — a receipt for this request completed. Authoritative.
 *  - "not_applied"  — a receipt for this request FAILED. Authoritative; carries the error.
 *  - "undetermined" — no receipt for this request. This is the verdict EVEN WHEN the
 *                     requested workflow is currently active: after a backend reconnect
 *                     the frontend restores a tab by itself (#433), so a matching
 *                     `active` is fully explained without our command ever running.
 *                     The evidence is returned alongside so the caller can decide, but
 *                     the VERDICT stays "undetermined" — reporting "opened" here is the
 *                     fabrication #402 must never produce.
 */
export function classifyOpenOutcome({
  requested,
  receipt,
  activeMatchesRequest = false,
  activeConfirmed = false,
} = {}) {
  const evidence = {
    active_matches_request: Boolean(activeMatchesRequest),
    active_confirmed: Boolean(activeConfirmed),
  };
  if (receiptMatchesRequest(receipt, requested)) {
    if (receipt.applied) {
      return {
        outcome: "applied",
        detail:
          `The panel completed "${receipt.cmd}" for "${receipt.requested ?? requested}"` +
          (receipt.reply_sent ? "." : " but could not deliver the reply."),
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
  return {
    outcome: "undetermined",
    detail:
      `The panel has no completed open on record for "${textOrNull(requested) ?? requested}". ` +
      (activeMatchesRequest
        ? "That workflow IS the active canvas right now, but the frontend restores a tab on its " +
          "own after a reconnect, so that does NOT prove the requested open ran. "
        : "") +
      "Treat the outcome as UNDETERMINED and re-issue panel_open_workflow (opening an " +
      "already-open workflow is safe and idempotent) rather than assuming either result.",
    evidence,
  };
}
