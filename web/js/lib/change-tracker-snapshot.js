// Schedule ComfyUI's expensive ChangeTracker serialization after a bridge reply.
//
// Bridge graph edits must still enter the native undo history, but serializing a
// large nested subgraph synchronously in the command handler delays the rid reply
// long enough for the orchestrator's panel timeout to fire (#581). Capture the
// tracker that owned the completed edit, then yield one UI turn before asking it
// to snapshot. Capturing it matters: looking up activeWorkflow in the callback
// could snapshot a tab the user selected after the edit instead.

/**
 * Queue a best-effort ChangeTracker snapshot without blocking the current command
 * reply. Returns whether a snapshot was queued. `schedule` is injectable for the
 * no-DOM unit test; production uses the browser timer.
 */
export function deferChangeTrackerSnapshot(changeTracker, schedule = setTimeout) {
  if (typeof changeTracker?.checkState !== "function") return false;
  schedule(() => {
    try {
      changeTracker.checkState();
    } catch {
      // Older frontends and transient workflow teardown keep undo best-effort.
    }
  }, 0);
  return true;
}
