// Run-completion lifecycle tracker.
//
// ComfyUI fires `executed` once PER output node, so a multi-output run would
// otherwise inject several fragmented image turns into the agent. We BUFFER a
// run's inline image refs (and video descriptors) by prompt_id as `executed`
// events arrive, then deliver ONE consolidated completion when that prompt
// *authoritatively* finishes.
//
// "Authoritative" is the whole point. Completion is keyed on the ComfyUI
// execution lifecycle for a SPECIFIC prompt_id — NOT on a debounce timer. The
// prior implementation flushed on a 1.5s debounce, which fired mid-run whenever
// two output nodes were >1.5s apart (a fast PreviewImage upstream of a slow
// KSampler is the normal shape of many graphs), producing partial batches, wrong
// durations, a prior run's buffer delivered as the current prompt's result, and
// the correct batch being dropped so the agent never resumed (#293/#224/#200/
// #269/#468).
//
// Model (the invariants that make partial/misattributed completion unreachable):
//   • A prompt is ACTIVE from the first sign it is running — `execution_start`
//     OR `executing(node)` (which always precedes that node's `executed`). This
//     is what closes the "missed execution_start" hole: even if the start frame
//     is dropped, the per-node `executing` marks the prompt active before any
//     output is buffered.
//   • The debounce timer NEVER flushes an ACTIVE prompt. While active it simply
//     re-arms (bounded, purely to cap timer churn) and then stops — it never
//     emits a partial batch, so a legitimately long run (video gen can far
//     exceed any fixed cutoff) is always completed by its real end signal with
//     the full batch and correct duration.
//   • The timer's ONLY flush is a last-resort safety net for an ORPHAN buffer we
//     have NO evidence is running (outputs arrived but no start and no
//     executing(node) — i.e. heavily dropped frames). Normal runs are always
//     active, so this path never fires for them.
//   • Authoritative flush triggers, each scoped to ONE prompt_id and carrying the
//     full buffered set: `execution_success(prompt_id)` (primary), the queue
//     going idle via `executing:null` (per-prompt end signal — ComfyUI emits it
//     exactly once at prompt end, never mid-run), and a NEW run starting (which
//     means every prior sequential run is done — flush them first so nothing
//     bleeds into the new run, including a legacy __no_prompt__ buffer).
//   • duration = finish − start, both from the same clock, anchored on the run
//     start and read at flush; a missing start yields a null (omitted) duration,
//     never a bogus 0.0s.
//
// The module owns ONLY lifecycle + buffering + timing. Presentation (note text,
// metadata fetch, sendFrame, video storyboard) stays with the caller via the
// `onFlush` callback, which receives the full, correctly-scoped batch — plus the
// prompt_id `key` for machine-readable attribution — exactly once per completion.

import { parseHistoryEntry } from "./history-reconcile.js";

export const NO_PROMPT_KEY = "__no_prompt__";

/**
 * @param {object} opts
 * @param {(payload:{key:string, promptId:(string|null), images:any[], videos:any[], durationMs:number|null, finishedAt:number}) => void} opts.onFlush
 *   Called exactly once per completed prompt that buffered ≥1 image or video,
 *   with the FULL batch for that prompt_id, the correct start→finish duration,
 *   and the prompt_id (`key`/`promptId`) so the delivery can be attributed.
 * @param {() => number} [opts.now]        Clock (injectable for tests).
 * @param {(fn:Function, ms:number) => any} [opts.setTimer]
 * @param {(t:any) => void} [opts.clearTimer]
 * @param {number} [opts.debounceMs]       Orphan-flush / re-arm interval (default 1500).
 * @param {number} [opts.maxRearms]        Re-arm churn cap for an active buffer (default 40).
 */
export function createRunCompletionTracker({
  onFlush,
  onReconcileError,
  onReconcileGiveUp,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  debounceMs = 1500,
  maxRearms = 40,
  reconcileRetryMs = 3000,
  maxReconcileRetries = 5,
} = {}) {
  if (typeof onFlush !== "function") {
    throw new TypeError("createRunCompletionTracker requires an onFlush callback");
  }
  // INGESTION-BOUNDARY NORMALIZATION: every prompt_id becomes a STRING the instant
  // it enters the tracker (a numeric /prompt id, e.g. 7, would otherwise never
  // `=== "7"` the string ids in /history keys and /queue rows, so a running render
  // would look absent and be given up — codex P1). Because this is the single
  // choke-point for map keys AND the stored ledger id, EVERY downstream comparison
  // (history key lookup, queue row match, fences, delivery) is string-vs-string,
  // closing the whole number-vs-string class at the source. A null/undefined id
  // (no real prompt) collapses to the shared NO_PROMPT_KEY.
  const key = (id) => (id == null ? NO_PROMPT_KEY : String(id));
  const promptIdOf = (k) => (k === NO_PROMPT_KEY ? null : k);
  const buffers = new Map(); // key -> { images: any[], videos: any[], timer, rearms }
  const active = new Set(); // keys ComfyUI currently reports as running
  const starts = new Map(); // key -> start timestamp
  // #370 reconciliation state. A run is PENDING from its first liveness signal
  // until its completion is CONFIRMED delivered to the agent. If the connection
  // drops (WS lost → execution_success missed, OR bridge down → the composed
  // frame silently dropped by sendFrame), the run stays pending and can be
  // recovered on reconnect by reconciling its prompt_id against `/history`.
  const pending = new Map(); // key -> { promptId, at }  (real prompt_ids only)
  // Two SEPARATE fences, deliberately distinct (codex P1):
  //
  //  • `terminal` — the LIFECYCLE REPLAY fence. A key is here once the prompt has
  //    reached a terminal outcome (success/error/reconcile), and it STAYS here even
  //    if delivery of that outcome is later re-pended for retry. It suppresses a
  //    late/replayed WS lifecycle event (execution_start / executed /
  //    execution_success / execution_error) from re-opening a completed run — which
  //    matters most for execution_start, whose sequential-flush would otherwise
  //    truncate a DIFFERENT currently-active prompt's buffer (#293/#370).
  //
  //  • `delivered` — the DELIVERY / RECONCILE-dedup fence. A key is here once its
  //    completion frame is CONFIRMED delivered. markUndelivered REMOVES it (only
  //    this one) so a bridge-down completion is re-reconciled and re-delivered.
  //
  // Conflating the two (the previous single `delivered` map) meant markUndelivered
  // deleted the replay fence too, so a re-pended prompt's late execution_start was
  // no longer fenced and clobbered a live run. Keeping them separate closes that.
  // Both are `key -> ts` so they can be pruned by AGE (never evicting a fence still
  // doing its job) to bound memory.
  const terminal = new Map();
  const delivered = new Map();
  // Far beyond any realistic WS-replay-after-reconnect delay, so pruning an entry
  // older than this can never re-open the double-delivery window it guards.
  const deliveredTtlMs = 10 * 60 * 1000;
  // #370 P1-3: reconnect only fires reconcile on its EDGE. If `/history` is
  // transiently unavailable at that instant (503/empty while the server catches
  // up), a run whose ENTIRE lifecycle happened during the drop would be stranded
  // until the next reconnect that may never come. So a transient/non-terminal
  // reconcile result schedules a bounded self-repolling retry that delivers once
  // /history turns terminal — still exactly once, via the same `delivered` fence.
  const retryTimers = new Map(); // key -> timer
  const retryCounts = new Map(); // key -> attempts already made

  // Pending is a RECOVERY LEDGER, not a debounce cache: it holds exactly the runs
  // whose completion has NOT been confirmed delivered. Every entry is removed the
  // instant its run reaches a confirmed terminal outcome — execution_success/error
  // with a delivered frame, or a /history reconcile — so the map is self-limiting
  // to the (normally ≤1–2) currently-undelivered runs. It is deliberately NOT
  // size-capped: evicting an entry would permanently forfeit the ONLY record that
  // lets a bridge-down completion be recovered on reconnect, defeating #370 for
  // that prompt (codex P1). Entries are tiny ({promptId, at}); a large batch simply
  // registers each of its accepted prompt_ids and drains them as they finish —
  // ledger depth mirrors the actual ComfyUI queue depth, which the server bounds.
  function trackPending(id) {
    if (id == null) return; // no prompt_id ⇒ not reconcilable against /history
    const k = key(id);
    // A prompt that already reached terminal must not be re-pended by a stray
    // liveness signal — its pending state is owned by markDelivered/markUndelivered.
    if (terminal.has(k)) return;
    // Store the NORMALIZED string id (k), so reconcile passes a string to
    // fetchHistory/fetchQueued and every downstream compare stays string-vs-string.
    if (!pending.has(k)) pending.set(k, { promptId: k, at: now() });
  }

  // Drop entries older than the TTL. Each fence is kept in strict last-touched
  // order (setters re-insert, below); an entry the `retain` predicate keeps is
  // skipped (not deleted) but scanning continues, and we still stop at the first
  // FRESH entry (recency order). O(scanned) — bounded by the retained prefix +
  // one fresh entry.
  function pruneFence(map, cutoff, retain) {
    for (const [dk, at] of map) {
      if (at >= cutoff) break;
      if (retain && retain(dk)) continue; // still needed — do NOT age it out
      map.delete(dk);
    }
  }
  function pruneFences() {
    const cutoff = now() - deliveredTtlMs;
    // NEVER age out a `terminal` replay fence while its run is STILL PENDING
    // recovery. A bridge-down completion can stay pending well past the TTL (long
    // outage); pruning its fence would strip the replay guard out from under a
    // still-pending prompt, and a later replayed execution_start for it would run
    // the sequential-start loop and clobber a DIFFERENT active run's buffer (codex
    // P1). The fence is refreshed when the run is finally delivered, then ages
    // normally; a `delivered` entry is never in `pending`, so it needs no guard.
    pruneFence(terminal, cutoff, (k) => pending.has(k));
    pruneFence(delivered, cutoff);
  }

  // Age fences out even when NO further completion arrives (idle): a single
  // self-disarming sweep that re-arms only while fences remain, so memory is
  // bounded without a perpetual timer.
  let fencePruneTimer = null;
  function scheduleFencePrune() {
    if (fencePruneTimer != null) return;
    fencePruneTimer = setTimer(() => {
      fencePruneTimer = null;
      pruneFences();
      if (terminal.size || delivered.size) scheduleFencePrune();
    }, deliveredTtlMs);
  }

  // Re-insert a key at the end of a fence map so it stays in strict recency order.
  function touchFence(map, k) {
    map.delete(k);
    map.set(k, now());
  }

  // Record that `id` reached a TERMINAL outcome — the replay fence. Set whether or
  // not its delivery is confirmed, and NEVER cleared by markUndelivered, so a late
  // execution_start for it stays fenced across a re-pend (codex P1).
  function markTerminal(id) {
    const k = key(id);
    if (k === NO_PROMPT_KEY) return; // reused key — never fence id-less runs (#224)
    pruneFences();
    touchFence(terminal, k);
    scheduleFencePrune();
  }

  function markDelivered(id) {
    const k = key(id);
    // NO_PROMPT_KEY is a SHARED, reused key for every id-less run — it is never
    // reconcilable and must never enter either fence, or the first id-less run
    // would permanently block all later ones (back-to-back id-less runs must still
    // each deliver, #224). It's also never in `pending` (trackPending skips null
    // ids), so there is nothing to retire here for it.
    if (k === NO_PROMPT_KEY) return;
    // A confirmed delivery IS a terminal outcome — set BOTH fences.
    markTerminal(id);
    touchFence(delivered, k);
    pending.delete(k);
    clearReconcileRetry(k); // a delivery (any path) cancels a scheduled /history retry
  }

  function clearReconcileRetry(k) {
    const t = retryTimers.get(k);
    if (t != null) clearTimer(t);
    retryTimers.delete(k);
    retryCounts.delete(k);
  }

  function markStart(id) {
    const k = key(id);
    // First signal wins — a later per-node event must not reset an earlier start.
    if (!starts.has(k)) starts.set(k, now());
    // Bound the map so a run that never signals end can't leak entries.
    if (starts.size > 20) {
      const oldest = starts.keys().next().value;
      if (oldest !== k) starts.delete(oldest);
    }
  }

  function arm(k) {
    const buf = buffers.get(k);
    if (!buf) return;
    if (buf.timer) clearTimer(buf.timer);
    buf.timer = setTimer(() => {
      const b = buffers.get(k);
      if (!b) return;
      b.timer = null;
      if (active.has(k)) {
        // The prompt is (still) running per ComfyUI — NEVER flush a partial batch
        // (#293/#200). Re-arm a bounded number of times purely to cap timer churn,
        // then stop and wait for the authoritative end signal (success / queue
        // idle / next run). A legitimately long run is completed there, in full.
        if (b.rearms < maxRearms) {
          b.rearms += 1;
          arm(k);
        }
        return;
      }
      // Not active: we have NO evidence this prompt is running (no start, no
      // executing(node)) yet outputs arrived — an orphan from dropped frames.
      // Flush it as a last resort so images are never permanently stranded.
      flush(k);
    }, debounceMs);
  }

  function flush(k) {
    const buf = buffers.get(k);
    if (!buf) return;
    if (buf.timer) clearTimer(buf.timer);
    buffers.delete(k);
    // Read + retire the start synchronously so a concurrent flush can't
    // double-count it. A missing start ⇒ null duration (never a bogus 0.0s).
    const startTs = starts.get(k);
    starts.delete(k);
    const durationMs = startTs != null ? now() - startTs : null;
    if (!buf.images.length && !buf.videos.length) return;
    // Optimistically mark delivered so a reconnect-triggered reconcile racing
    // this flush can't double-deliver the same prompt. If the caller reports the
    // send FAILED (bridge down), it calls markUndelivered() to re-pend it (#370).
    markDelivered(k);
    onFlush({
      key: k,
      promptId: promptIdOf(k),
      images: buf.images,
      videos: buf.videos,
      durationMs,
      finishedAt: now(),
    });
  }

  function ensureBuffer(k) {
    let buf = buffers.get(k);
    if (!buf) {
      buf = { images: [], videos: [], timer: null, rearms: 0 };
      buffers.set(k, buf);
    }
    return buf;
  }

  // Reconcile ONE pending prompt against `/history`. Idempotent: a no-op (returns
  // null) if the prompt was resolved (delivered/removed) meanwhile, incl. across
  // the fetch await (TOCTOU). Delivers a terminal SUCCESS via onFlush exactly
  // once. Returns a status row; `retriable:true` means the outcome isn't known
  // yet (transient /history miss or still-running) so the caller should schedule
  // a retry rather than strand it.
  async function reconcileKey(promptId, fetchHistory, fetchQueued, isVideo) {
    const k = key(promptId);
    if (delivered.has(k) || !pending.has(k)) return null;
    let entry = null;
    let fetchThrew = false;
    try {
      entry = await fetchHistory(promptId);
    } catch {
      fetchThrew = true;
    }
    // Re-check AFTER the await: a live execution_success/error may have delivered
    // and retired this prompt while /history was in flight — never double-deliver.
    if (delivered.has(k) || !pending.has(k)) return null;

    // parseHistoryEntry returns null for null/undefined/non-object entries.
    const parsed = fetchThrew ? null : parseHistoryEntry(entry, { isVideo });

    // ── NON-terminal outcomes (never deliver here; decide retry vs give-up) ──
    if (!parsed || !parsed.terminal) {
      // /history unreachable (503/threw) ⇒ uncertain; keep polling, never give up.
      if (fetchThrew) return { promptId, status: "running", retriable: true };
      // STRICT: only a `null` entry is a clean 200-with-no-entry (give-up eligible
      // below). ANYTHING else that isn't a terminal record — a present-but-non-
      // terminal record (status running/pending), a malformed/unparseable record,
      // OR an unexpected `undefined`/other value from a custom fetchHistory — is
      // NOT a confirmed clean absence, so treat it as running/uncertain and NEVER
      // give up (codex P1: it must not be evicted/fenced); keep polling so its live
      // lifecycle / a later terminal record delivers it.
      if (entry !== null) return { promptId, status: "running", retriable: true };
      // entry === null ⇒ CLEANLY ABSENT from /history. Absence is NORMAL for a
      // QUEUED/RUNNING prompt (ComfyUI writes /history only on task_done), so consult
      // /queue to tell a still-in-flight render apart from a genuinely gone one.
      let queued = null; // null = couldn't determine; true/false = definitive
      if (typeof fetchQueued === "function") {
        try {
          queued = await fetchQueued(promptId);
        } catch {
          queued = null;
        }
        if (delivered.has(k) || !pending.has(k)) return null; // re-check after 2nd await
      }
      // DEFINITIVELY absent from BOTH /history (clean null) AND /queue ⇒ genuinely
      // gone (cancelled / interrupted). This is the ONLY give-up-eligible state.
      if (queued === false) return { promptId, status: "unknown", retriable: true };
      // Still queued/running, OR queue membership couldn't be confirmed — keep
      // polling and NEVER give up (a live/uncertain render must not be evicted).
      return { promptId, status: "running", retriable: true };
    }

    // ── Terminal. Retire ALL live state for this key so a stale partial buffer (from
    // pre-drop `executed` events) can't double-deliver later, and mark it delivered
    // BEFORE onFlush so a concurrent reconcile can't race it.
    const buf = buffers.get(k);
    if (buf?.timer) clearTimer(buf.timer);
    buffers.delete(k);
    active.delete(k);
    const startTs = starts.get(k);
    starts.delete(k);
    markDelivered(k); // also clears any scheduled retry for this key
    if (parsed.status === "error") {
      // Deliver the terminal error through the SAME hook whether we're in the
      // reconcile loop OR a scheduled retry — otherwise a transient /history miss
      // that later resolves to an error (only discovered by a retry) would fence
      // the prompt but NEVER surface a run_error to the agent (codex P1). The hook
      // owns frame delivery (+ mute/re-pend); the returned row is for diagnostics.
      if (typeof onReconcileError === "function") {
        try {
          onReconcileError({ promptId });
        } catch {
          /* presentation error must never wedge reconciliation */
        }
      }
      return { promptId, status: "error" };
    }
    const hasBatch = parsed.images.length > 0 || parsed.videos.length > 0;
    if (hasBatch) {
      const durationMs = startTs != null ? now() - startTs : null;
      onFlush({
        key: k,
        promptId,
        images: parsed.images,
        videos: parsed.videos,
        durationMs,
        finishedAt: now(),
        reconciled: true,
      });
    }
    return { promptId, status: "success", delivered: hasBatch };
  }

  // GIVE UP on a prompt confirmed absent from BOTH /history AND /queue after the
  // retry budget is spent (P1 memory leak) — i.e. genuinely cancelled/gone, NOT a
  // still-queued/running render (which reconcileKey reports as "running", never
  // reaching here). Without this, a truly-gone prompt would sit in `pending`
  // forever — and because the fence prune RETAINS a terminal fence while its run is
  // pending, both `pending` and `terminal` would grow without bound. Evicting the
  // entry (once, with a one-time "couldn't confirm — safe to requeue" notice) keeps
  // the ledger bounded; the terminal fence we stamp here is then no longer pinned,
  // so it ages out normally.
  function giveUpReconcile(promptId) {
    const k = key(promptId);
    // ONE-TIME ownership claim: two concurrent reconcile()/retry paths can each
    // return "unknown" for the same gone prompt and both reach here — but only the
    // FIRST (which still sees it in `pending`) may retire state + fire the notice.
    // Any later caller finds it already evicted and no-ops, so onReconcileGiveUp
    // (and the eviction) happen exactly once (codex P1). Synchronous from here on,
    // so the has→delete claim is atomic.
    if (!pending.has(k)) return;
    clearReconcileRetry(k);
    // Retire ALL live state for this key, exactly as a terminal outcome would.
    // Otherwise a stale PARTIAL buffer left from pre-drop `executed` events would
    // be flushed by the NEXT different execution_start's sequential-flush — emitting
    // stale output that contradicts "status unknown", and leaking the buffered media
    // until then (codex P1).
    const buf = buffers.get(k);
    if (buf?.timer) clearTimer(buf.timer);
    buffers.delete(k);
    active.delete(k);
    starts.delete(k);
    pending.delete(k); // EVICT — bounds the ledger
    markTerminal(promptId); // fence any stray late execution_start; ages out (not pinned)
    if (typeof onReconcileGiveUp === "function") {
      try {
        onReconcileGiveUp({ promptId });
      } catch {
        /* presentation error must never wedge reconciliation */
      }
    }
  }

  // Decide what to do with a reconcileKey result. Terminal/resolved ⇒ stop. Still
  // retriable with budget left ⇒ schedule another poll. Budget SPENT this episode
  // without a terminal outcome ⇒ an "unknown" (confirmed absent from BOTH /history
  // AND /queue ⇒ genuinely gone) is GIVEN UP + evicted so the ledger stays bounded,
  // while a "running" render (still in /queue, or membership uncertain) is left
  // PENDING for the live path / next reconnect — never fenced or dropped (codex P1).
  // Centralizing the decision here makes it fire even when maxReconcileRetries===0
  // (give up immediately for a confirmed-gone prompt) — codex P2.
  function afterReconcileRow(row, promptId, fetchHistory, fetchQueued, isVideo) {
    const k = key(promptId);
    if (!row || !row.retriable) {
      clearReconcileRetry(k); // resolved (terminal / delivered)
      return;
    }
    if ((retryCounts.get(k) ?? 0) >= maxReconcileRetries) {
      if (row.status === "unknown") giveUpReconcile(promptId); // gone ⇒ evict
      else clearReconcileRetry(k); // still "running" ⇒ leave pending, stop polling
      return;
    }
    scheduleReconcileRetry(promptId, fetchHistory, fetchQueued, isVideo);
  }

  // Arm one bounded, self-repolling retry for a prompt whose /history is not yet
  // terminal (P1-3). The budget/give-up decision lives in afterReconcileRow; this
  // just schedules the next poll. Uses the injected timer so it's deterministic
  // under test.
  function scheduleReconcileRetry(promptId, fetchHistory, fetchQueued, isVideo) {
    const k = key(promptId);
    if (k === NO_PROMPT_KEY) return; // id-less runs aren't reconcilable
    if (delivered.has(k) || !pending.has(k)) {
      clearReconcileRetry(k);
      return;
    }
    if (retryTimers.has(k)) return; // one retry in flight per key
    const timer = setTimer(async () => {
      retryTimers.delete(k);
      retryCounts.set(k, (retryCounts.get(k) ?? 0) + 1);
      if (delivered.has(k) || !pending.has(k)) {
        clearReconcileRetry(k);
        return;
      }
      const row = await reconcileKey(promptId, fetchHistory, fetchQueued, isVideo);
      afterReconcileRow(row, promptId, fetchHistory, fetchQueued, isVideo);
    }, reconcileRetryMs);
    retryTimers.set(k, timer);
  }

  return {
    /** ComfyUI `execution_start` — authoritative run-start for a prompt. */
    onExecutionStart(id) {
      const k = key(id);
      // Idempotency fence (P1-2, codex): a late / replayed execution_start for a
      // prompt that already reached TERMINAL must be IGNORED — it must not run the
      // sequential-flush below, which would truncate a DIFFERENT, currently-active
      // prompt's buffer (delivering it partial) and clear active, losing that live
      // run's final output (#293 buffering regression). This fences on `terminal`,
      // NOT `delivered`, so it holds even when the terminal prompt's delivery is
      // being RE-PENDED for retry (markUndelivered clears `delivered` but not
      // `terminal`). NO_PROMPT_KEY is never in `terminal`, so id-less runs proceed.
      if (terminal.has(k)) return;
      // Runs are sequential: a new run beginning means EVERY prior run has ended
      // (even one whose end signal we missed). Flush every existing buffer under
      // ITS OWN key/timing first, so an older buffer — including a legacy
      // __no_prompt__ one from the previous run — can never bleed into, or be
      // misreported as, this new run (#224). A run cannot have buffered output
      // before its own start, so nothing belonging to THIS run is lost here.
      //
      // NB: a prior run whose end signal was missed is flushed here with whatever
      // it buffered — the #224 safe default of "deliver what we have" — because a
      // missed end is USUALLY a dropped frame on a live connection with no
      // reconnect (hence no /history reconcile) ever coming. flush() marks it
      // delivered, so a LATER reconcile for that prompt is correctly a no-op; the
      // drop-with-reconnect case (where the next run does NOT start before the
      // reconnect) is still recovered in full by reconcile.
      for (const other of [...buffers.keys()]) flush(other);
      active.clear();
      markStart(id);
      active.add(k);
      trackPending(id);
    },

    /**
     * ComfyUI `executed` (per output node) — buffer this prompt's outputs.
     * @param {string|null} id
     * @param {{images?: any[], videos?: any[]}} outputs
     */
    onExecuted(id, { images = [], videos = [] } = {}) {
      if (!images.length && !videos.length) return;
      // Idempotency fence: if this prompt already reached TERMINAL (a /history
      // reconcile beat the live WS, which then replayed a late `executed`), do NOT
      // re-buffer it — otherwise the trailing execution_success would flush a
      // second, duplicate completion for the same run (codex P1). Fences on
      // `terminal` so it still holds if delivery is being re-pended for retry.
      if (terminal.has(key(id))) return;
      // Fallback render-start if execution_start was missed (no-op otherwise).
      // Does NOT mark active: `executing(node)` is the run-liveness signal, so an
      // output with no start AND no executing(node) is treated as an orphan.
      markStart(id);
      trackPending(id);
      const k = key(id);
      const buf = ensureBuffer(k);
      if (images.length) buf.images.push(...images);
      if (videos.length) buf.videos.push(...videos);
      arm(k);
    },

    /** ComfyUI `execution_success` — the authoritative flush for THIS prompt. */
    onExecutionSuccess(id) {
      const k = key(id);
      active.delete(k);
      // Already terminal (e.g. delivered via reconcile, even if its delivery is
      // being re-pended) — a late/replayed success must not re-flush or re-mark
      // (which would clear the re-pend and lose the retry). Just retire residual
      // live state (codex P1 idempotency fence; `terminal`, not `delivered`).
      if (terminal.has(k)) {
        starts.delete(k);
        return;
      }
      flush(k);
      // Retire start for runs that buffered nothing (flush early-returns then).
      starts.delete(k);
      // A terminal success we OBSERVED live needs no /history reconcile — clear it
      // from pending. (If the completion frame is later reported undelivered, the
      // caller's markUndelivered re-pends it, so a bridge-down drop still recovers.)
      markDelivered(k);
    },

    /** ComfyUI `execution_error` — drop this prompt's buffer, deliver no batch. */
    onExecutionFailed(id) {
      const k = key(id);
      active.delete(k);
      const buf = buffers.get(k);
      if (buf?.timer) clearTimer(buf.timer);
      buffers.delete(k);
      starts.delete(k);
      // If already terminal (reconcile surfaced this run's outcome), don't re-mark
      // (which would clear a re-pend). The caller uses wasTerminal() BEFORE calling
      // this to suppress a duplicate run_error frame (codex P1).
      if (!terminal.has(k)) markDelivered(k);
    },

    /**
     * Legacy/secondary run-end: `executing` with node===null (queue idle).
     *
     * This flushes ONLY buffers whose prompt is NOT currently active — it can
     * never truncate a run ComfyUI still reports as in-flight (#200/#224). On
     * modern ComfyUI the authoritative `execution_success` has already cleared
     * `active` and flushed the buffer, so this is a no-op there; its remaining job
     * is a backstop for an ORPHAN/non-active leftover (e.g. a legacy __no_prompt__
     * buffer). Deliberately NOT trusting a possibly-spurious null to end an active
     * run is what makes an early/partial completion from a stray null unreachable.
     */
    onExecutingNull() {
      for (const k of [...buffers.keys()]) {
        if (!active.has(k)) flush(k);
      }
    },

    /**
     * `executing` with a node id. Anchors the render-start AND marks the prompt
     * active — this is the run-liveness signal that closes the "missed
     * execution_start" hole (it always precedes that node's `executed`), so the
     * timer can never early-flush a run whose start frame was dropped.
     */
    onExecutingNode(id) {
      if (id == null) return;
      // A late `executing` for an already-terminal run must not re-open it.
      if (terminal.has(key(id))) return;
      markStart(id);
      active.add(key(id));
      trackPending(id);
    },

    /**
     * Has this prompt already reached a TERMINAL outcome (via live success/error or
     * a /history reconcile)? The caller checks this BEFORE surfacing a live
     * execution_error so a reconciled/completed outcome isn't duplicated by a late
     * WS event — true even while its delivery is being re-pended for retry.
     */
    wasTerminal(id) {
      return terminal.has(key(id));
    },

    /**
     * Register a prompt_id the instant it is QUEUED (from the POST /prompt
     * response), before any WS lifecycle event. Closes the worst-case #370 hole:
     * a run that STARTS AND FINISHES entirely inside a connection drop — no
     * execution_start/executing/executed ever reaches us — is still reconcilable
     * against /history because we recorded its prompt_id at queue time.
     */
    onQueued(id) {
      trackPending(id);
    },

    /**
     * Caller reports the completion frame for `id` was CONFIRMED delivered to the
     * agent (sendFrame succeeded / batch was empty). Retires it from pending.
     */
    markDelivered(id) {
      markDelivered(id);
    },

    /**
     * Caller reports the completion frame for `id` could NOT be delivered (bridge
     * down when the flush fired). Re-pend it so the next reconnect recovers it via
     * /history — this is what makes a bridge-down drop, where we DID observe the
     * terminal success, still deliver the result on reconnect (#370).
     */
    markUndelivered(id) {
      if (id == null) return;
      const k = key(id);
      // Clear ONLY the delivery/reconcile fence so the outcome is re-reconciled and
      // re-delivered. The `terminal` REPLAY fence is deliberately LEFT intact: the
      // run already completed, so a late/replayed execution_start for it must stay
      // fenced (or it would clobber a different live run's buffer — codex P1). Also
      // cancel any in-flight retry so the re-pend restarts cleanly on the next edge.
      delivered.delete(k);
      clearReconcileRetry(k);
      if (!pending.has(k)) pending.set(k, { promptId: k, at: now() }); // normalized string id
    },

    /**
     * Reconcile every still-pending prompt against ComfyUI's `/history` and
     * deliver any terminal outcome exactly once. Call on reconnect (WS back OR
     * bridge back).
     *
     * @param {object} args
     * @param {(promptId:string)=>Promise<object|null>} args.fetchHistory  Resolves
     *   the per-prompt `/history/<id>` entry (already unwrapped from `{[id]:…}`), or
     *   null when absent.
     * @param {(promptId:string)=>Promise<boolean|null>} [args.fetchQueued]  Resolves
     *   whether the prompt is still in ComfyUI's `/queue` (running OR pending): true
     *   present, false definitively absent, null couldn't determine. Consulted only
     *   when /history is non-terminal, to tell a still-running render apart from a
     *   genuinely gone one — a running render is NEVER given up (codex P1).
     * @param {(m:object)=>boolean} [args.isVideo]  Output classifier (see parse).
     * @returns {Promise<Array<{promptId:string, status:string, delivered?:boolean}>>}
     *   One row per pending prompt inspected — the caller surfaces error/unknown
     *   notices; SUCCESS batches are delivered here via onFlush.
     */
    async reconcile({ fetchHistory, fetchQueued, isVideo } = {}) {
      const summary = [];
      pruneFences(); // reconnect is a natural sweep point for old fences
      if (typeof fetchHistory !== "function") return summary;
      for (const [, info] of [...pending.entries()]) {
        const promptId = info.promptId;
        if (promptId == null) continue;
        const row = await reconcileKey(promptId, fetchHistory, fetchQueued, isVideo);
        if (!row) continue; // resolved by a live event meanwhile — nothing to report
        const clean = { promptId: row.promptId, status: row.status };
        if (row.delivered !== undefined) clean.delivered = row.delivered;
        summary.push(clean);
        // A not-yet-terminal outcome (transient /history miss OR still running)
        // must not be stranded: this reconcile call is a FRESH episode (a reconnect
        // edge / explicit poll), so reset the retry budget first — a prompt stranded
        // by one episode's exhausted budget gets a fresh set of attempts on the
        // next. afterReconcileRow then either schedules a bounded retry, gives up +
        // evicts an absent-history prompt, or leaves a running one pending (P1-3,
        // and the memory-leak give-up — fires even when maxReconcileRetries===0).
        if (row.retriable) retryCounts.delete(key(promptId));
        afterReconcileRow(row, promptId, fetchHistory, fetchQueued, isVideo);
      }
      return summary;
    },

    /** Synchronous start lookup (diagnostics / fallbacks). */
    startFor(id) {
      return starts.get(key(id));
    },

    // Introspection for tests / diagnostics.
    _active: active,
    _buffers: buffers,
    _starts: starts,
    _pending: pending,
    _delivered: delivered,
    _terminal: terminal,
  };
}
