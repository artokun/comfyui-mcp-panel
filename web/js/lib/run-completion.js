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
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  debounceMs = 1500,
  maxRearms = 40,
} = {}) {
  if (typeof onFlush !== "function") {
    throw new TypeError("createRunCompletionTracker requires an onFlush callback");
  }
  const key = (id) => id ?? NO_PROMPT_KEY;
  const promptIdOf = (k) => (k === NO_PROMPT_KEY ? null : k);
  const buffers = new Map(); // key -> { images: any[], videos: any[], timer, rearms }
  const active = new Set(); // keys ComfyUI currently reports as running
  const starts = new Map(); // key -> start timestamp

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

  return {
    /** ComfyUI `execution_start` — authoritative run-start for a prompt. */
    onExecutionStart(id) {
      const k = key(id);
      // Runs are sequential: a new run beginning means EVERY prior run has ended
      // (even one whose end signal we missed). Flush every existing buffer under
      // ITS OWN key/timing first, so an older buffer — including a legacy
      // __no_prompt__ one from the previous run — can never bleed into, or be
      // misreported as, this new run (#224). A run cannot have buffered output
      // before its own start, so nothing belonging to THIS run is lost here.
      for (const other of [...buffers.keys()]) flush(other);
      active.clear();
      markStart(id);
      active.add(k);
    },

    /**
     * ComfyUI `executed` (per output node) — buffer this prompt's outputs.
     * @param {string|null} id
     * @param {{images?: any[], videos?: any[]}} outputs
     */
    onExecuted(id, { images = [], videos = [] } = {}) {
      if (!images.length && !videos.length) return;
      // Fallback render-start if execution_start was missed (no-op otherwise).
      // Does NOT mark active: `executing(node)` is the run-liveness signal, so an
      // output with no start AND no executing(node) is treated as an orphan.
      markStart(id);
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
      flush(k);
      // Retire start for runs that buffered nothing (flush early-returns then).
      starts.delete(k);
    },

    /** ComfyUI `execution_error` — drop this prompt's buffer, deliver no batch. */
    onExecutionFailed(id) {
      const k = key(id);
      active.delete(k);
      const buf = buffers.get(k);
      if (buf?.timer) clearTimer(buf.timer);
      buffers.delete(k);
      starts.delete(k);
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
      markStart(id);
      active.add(key(id));
    },

    /** Synchronous start lookup (diagnostics / fallbacks). */
    startFor(id) {
      return starts.get(key(id));
    },

    // Introspection for tests / diagnostics.
    _active: active,
    _buffers: buffers,
    _starts: starts,
  };
}
