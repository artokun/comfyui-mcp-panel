// Run-completion lifecycle tracker.
//
// ComfyUI fires `executed` once PER output node, so a multi-output run would
// otherwise inject several fragmented image turns into the agent. We BUFFER a
// run's inline image refs by prompt_id as `executed` events arrive, then deliver
// ONE consolidated `executed` agent_event when that prompt *authoritatively*
// finishes.
//
// "Authoritative" is the whole point of this module. Completion is keyed on the
// ComfyUI execution lifecycle for a SPECIFIC prompt_id — execution_start →
// executed(…) → execution_success — NOT on a debounce timer. Prior behaviour
// flushed on a 1.5s debounce, which fired mid-run whenever two output nodes were
// >1.5s apart (a fast PreviewImage upstream of a slow KSampler is the normal
// shape of many graphs). That produced:
//   • partial image batches + a wrong (~6× short) duration (#293),
//   • a previous run's buffer delivered as the current run's FINAL output while
//     the queued prompt was still executing (#224),
//   • "no saved output node ran" while SaveImage was still seconds from writing
//     (#200),
//   • the correct, later batch being dropped so the agent never resumed on the
//     real result (#269, #468).
//
// Rules enforced here:
//   1. execution_success(prompt_id) is the authoritative flush for THAT prompt —
//      it collects the FULL output set buffered for that prompt_id.
//   2. The debounce is a bounded SAFETY NET only. While ComfyUI still reports the
//      prompt in-flight, the timer RE-ARMS instead of flushing — it never emits a
//      partial batch. Bounded re-arming (default 600 × 1.5s = 15 min) preserves
//      the "never strand images" guarantee for an interrupted run that never
//      delivers a run-end signal.
//   3. A run beginning flushes any lingering buffer from the PRIOR (sequential)
//      run first, so an older buffer can never be misattributed to the new run.
//   4. The idle `executing:null` signal flushes only buffers whose prompt is NOT
//      still active — it can never truncate a mid-flight run.
//   5. duration = finish − start, both from the same clock, anchored on
//      execution_start (with per-node fallbacks) and read at flush time.
//
// The module owns ONLY lifecycle + buffering + timing. Presentation (note text,
// metadata fetch, sendFrame) stays with the caller via the `onFlush` callback,
// which receives the full, correctly-scoped batch exactly once per completion.

export const NO_PROMPT_KEY = "__no_prompt__";

/**
 * @param {object} opts
 * @param {(payload:{key:string, images:any[], durationMs:number|null, finishedAt:number}) => void} opts.onFlush
 *   Called exactly once per completed prompt that buffered ≥1 image, with the
 *   FULL batch for that prompt_id and the correct start→finish duration.
 * @param {() => number} [opts.now]        Clock (injectable for tests).
 * @param {(fn:Function, ms:number) => any} [opts.setTimer]
 * @param {(t:any) => void} [opts.clearTimer]
 * @param {number} [opts.debounceMs]       Safety-net interval (default 1500).
 * @param {number} [opts.maxRearms]        Re-arm ceiling (default 600 = ~15 min).
 */
export function createRunCompletionTracker({
  onFlush,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  debounceMs = 1500,
  maxRearms = 600,
} = {}) {
  if (typeof onFlush !== "function") {
    throw new TypeError("createRunCompletionTracker requires an onFlush callback");
  }
  const key = (id) => id ?? NO_PROMPT_KEY;
  const buffers = new Map(); // key -> { images: any[], timer, rearms }
  const active = new Set(); // keys ComfyUI currently reports in-flight
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
      // If ComfyUI still reports this prompt in-flight, the run is NOT done —
      // re-arm rather than flush a partial batch (#293/#200). Bounded so an
      // interrupted run that never delivers a run-end signal still flushes.
      if (active.has(k) && b.rearms < maxRearms) {
        b.rearms += 1;
        arm(k);
        return;
      }
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
    if (!buf.images.length) return;
    onFlush({ key: k, images: buf.images, durationMs, finishedAt: now() });
  }

  return {
    /** ComfyUI `execution_start` — authoritative run-start for a prompt. */
    onExecutionStart(id) {
      const k = key(id);
      // Runs are sequential: a new run beginning means EVERY prior run has ended,
      // even one whose execution_success we missed (the exact #224 conditions).
      // Finalize every other buffer NOW — attributed to ITS own prompt/timing —
      // so an older buffer can never be carried into, and misreported as, this
      // new run (#224). A stale prior prompt is also cleared from `active` so it
      // can't linger and suppress a future idle flush. Never touch this run's own.
      for (const other of [...buffers.keys()]) {
        if (other !== k) {
          active.delete(other);
          flush(other);
        }
      }
      // Drop any stale active marker with no buffer (e.g. a prior run that
      // produced no images and never signalled end) so `active` can't leak.
      for (const other of [...active]) {
        if (other !== k) active.delete(other);
      }
      markStart(id);
      active.add(k);
    },

    /** ComfyUI `executed` (per output node) — buffer this prompt's images. */
    onExecuted(id, images) {
      if (!images || !images.length) return;
      // Fallback render-start if execution_start was missed (no-op otherwise).
      markStart(id);
      const k = key(id);
      let buf = buffers.get(k);
      if (!buf) {
        buf = { images: [], timer: null, rearms: 0 };
        buffers.set(k, buf);
      }
      buf.images.push(...images);
      arm(k);
    },

    /** ComfyUI `execution_success` — the authoritative flush for THIS prompt. */
    onExecutionSuccess(id) {
      const k = key(id);
      active.delete(k);
      flush(k);
      // Retire start for runs that buffered no inline images (e.g. video-only),
      // where flush early-returns and would otherwise leave the entry behind.
      starts.delete(k);
    },

    /** ComfyUI `execution_error` — drop this prompt's buffer, deliver no batch. */
    onExecutionError(id) {
      const k = key(id);
      active.delete(k);
      const buf = buffers.get(k);
      if (buf?.timer) clearTimer(buf.timer);
      buffers.delete(k);
      starts.delete(k);
    },

    /** Legacy idle signal: `executing` with node===null (no prompt_id). */
    onExecutingNull() {
      // The queue is idle. Flush only buffers whose prompt ComfyUI is NOT still
      // running — an active prompt is flushed by execution_success and must
      // never be truncated here (#200/#224).
      for (const k of [...buffers.keys()]) {
        if (!active.has(k)) flush(k);
      }
    },

    /** `executing` with a node id — fallback render-start anchor. */
    onExecutingNode(id) {
      if (id != null) markStart(id);
    },

    /** Synchronous start lookup for the async video-storyboard duration path. */
    startFor(id) {
      return starts.get(key(id));
    },

    // Introspection for tests / diagnostics.
    _active: active,
    _buffers: buffers,
    _starts: starts,
  };
}
