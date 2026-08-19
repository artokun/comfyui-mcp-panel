// Schedule ComfyUI's expensive ChangeTracker serialization after a bridge reply.
//
// Bridge graph edits must still enter the native undo history, but serializing a
// large nested subgraph synchronously in the command handler delays the rid reply
// long enough for the orchestrator's panel timeout to fire (#581). Capture the
// tracker that owned the completed edit, then yield one UI turn before asking it
// to snapshot. Capturing it matters: looking up activeWorkflow in the callback
// could snapshot a tab the user selected after the edit instead.
//
// comfyui-mcp#1723 — the deferral leaves a WINDOW: until the timer fires, the
// tracker's captured state still describes the canvas BEFORE the panel's own
// edit, and the graph-binding fence reads that lag as a shape mismatch — so a
// back-to-back graph command from the same burst (two calls dispatched in one
// turn, both handled before the timer phase) refused the RIGHT canvas, and every
// mutation needed its own re-open first. The pending record below lets the next
// graph command FLUSH the already-committed capture synchronously before its
// fence runs: the capture was going to happen either way, so flushing changes
// only WHEN it lands, never WHETHER.

let pendingSnapshot = null;

function captureNow(changeTracker) {
  // `checkState` is DEPRECATED upstream — it warns, then delegates to this — so
  // prefer the current name and keep the old one as the fallback for older
  // frontends (mirrors captureCanvasIntoTracker's resolution order).
  const capture = changeTracker?.captureCanvasState ?? changeTracker?.checkState;
  if (typeof capture !== "function") return false;
  try {
    capture.call(changeTracker);
  } catch {
    // Older frontends and transient workflow teardown keep undo best-effort.
  }
  return true;
}

/**
 * Queue a best-effort ChangeTracker snapshot without blocking the current command
 * reply. Returns whether a snapshot was queued. `schedule` is injectable for the
 * no-DOM unit test; production uses the browser timer.
 */
export function deferChangeTrackerSnapshot(changeTracker, schedule = setTimeout, cancel = clearTimeout) {
  if (
    typeof changeTracker?.captureCanvasState !== "function" &&
    typeof changeTracker?.checkState !== "function"
  ) {
    return false;
  }
  const record = { tracker: changeTracker };
  const timer = schedule(() => {
    // A flush (or a newer defer) may have consumed the record already; the
    // capture is diff-based and idempotent, so firing anyway is harmless — only
    // the pending marker must not be cleared from under a NEWER record.
    if (pendingSnapshot === record) pendingSnapshot = null;
    captureNow(changeTracker);
  }, 0);
  record.cancel = () => cancel(timer);
  pendingSnapshot = record;
  return true;
}

/**
 * #1723 — run the deferred snapshot NOW, before the caller's next observation of
 * the tracker. Refuses unless the pending record belongs to THIS tracker: a
 * capture serializes the live canvas, so flushing a tracker that no longer owns
 * it would stamp one workflow's canvas onto another's state. Returns whether a
 * pending snapshot was consumed. The timer is cancelled so the capture runs
 * exactly once.
 */
export function flushPendingChangeTrackerSnapshot(changeTracker) {
  const record = pendingSnapshot;
  if (!record || !changeTracker || record.tracker !== changeTracker) return false;
  pendingSnapshot = null;
  record.cancel();
  return captureNow(changeTracker);
}
