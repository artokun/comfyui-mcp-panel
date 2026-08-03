// Decide whether a completed ComfyUI reboot should immediately wake the resumed
// agent turn. A graph_run prompt recorded before the reboot is authoritative
// evidence that work is still in flight: its completion/reconciliation event is
// the only safe continuation signal. Sending a generic "continue" nudge first
// makes the agent reasonably assume the render was aborted and queue it again
// (#585).

/**
 * @param {{ rebootPending?: boolean, hasPendingRun?: boolean }} state
 * @returns {"none"|"wait_for_run"|"resume"}
 */
export function planRebootResume(state = {}) {
  if (!state.rebootPending) return "none";
  return state.hasPendingRun ? "wait_for_run" : "resume";
}
