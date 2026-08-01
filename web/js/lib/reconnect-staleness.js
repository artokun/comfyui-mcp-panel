// Pure helper: is the workflow service's `active` pointer possibly stale right now?
//
// After a ComfyUI BACKEND restart the frontend's OWN websocket reconnects and it
// RESTORES a tab as active — but it can restore a DIFFERENT tab than the one the
// user was viewing immediately before the drop (a last-SAVED vs last-VIEWED
// snapshot, or a race where the restore hasn't settled yet). workflow_list /
// graph_outline faithfully report whatever the frontend calls `active`, so for a
// short window after a reconnect the `active` identity an agent reads may not match
// the tab the user is actually looking at and must be double-checked rather than
// silently trusted (#433). This just answers "did a reconnect happen recently, and
// has nothing authoritative re-pointed `active` since?" — the callers add the flag.
//
// Dependency-free (no DOM, no app, no timers) so it is unit-testable with plain
// values and the same logic can't drift between workflow_list and graph_outline.

/** How long after a reconnect the `active` pointer is treated as possibly stale. */
export const ACTIVE_STALE_WINDOW_MS = 30000;

/**
 * True when a backend reconnect happened within `windowMs` of `now` AND nothing
 * authoritative has re-pointed the active tab since (an explicit panel_open_workflow
 * / panel_new_workflow records `resyncedAt`). Fail-safe: any missing/non-finite
 * input yields `false` (never flag when we can't actually tell), matching the
 * pre-existing "report active as-is" behaviour.
 *
 * @param {{reconnectedAt?: number|null, resyncedAt?: number|null, now?: number, windowMs?: number}} o
 */
export function activeWorkflowPossiblyStale({
  reconnectedAt,
  resyncedAt = null,
  now,
  windowMs = ACTIVE_STALE_WINDOW_MS,
} = {}) {
  if (typeof reconnectedAt !== "number" || !Number.isFinite(reconnectedAt)) return false;
  if (typeof now !== "number" || !Number.isFinite(now)) return false;
  // An explicit resync (panel_open_workflow / panel_new_workflow) AT OR AFTER the
  // reconnect makes the active pointer authoritative again — clear immediately.
  if (typeof resyncedAt === "number" && Number.isFinite(resyncedAt) && resyncedAt >= reconnectedAt) {
    return false;
  }
  const elapsed = now - reconnectedAt;
  return elapsed >= 0 && elapsed < windowMs;
}

/** Actionable one-liner surfaced to the agent when `active` may be post-reconnect stale. */
export function activeStaleHint() {
  return (
    "ComfyUI reconnected moments ago (e.g. a backend restart) and its frontend may have " +
    "restored a DIFFERENT active tab than the one the user was last viewing. Do not trust " +
    "`active` blindly: confirm the intended workflow from the `open`/`workflows` list, then " +
    "call panel_open_workflow to bind to it before reading or editing its graph."
  );
}
