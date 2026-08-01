// Pure helper: is the workflow service's `active` pointer possibly stale right now?
//
// After a ComfyUI BACKEND restart the frontend's OWN websocket reconnects and it
// RESTORES a tab as active — but it can restore a DIFFERENT tab than the one the
// user was viewing immediately before the drop (a last-SAVED vs last-VIEWED
// snapshot, or a race where the restore hasn't settled yet). workflow_list /
// graph_outline faithfully report whatever the frontend calls `active`, so for a
// short window after a reconnect the `active` identity an agent reads may not match
// the tab the user is actually looking at and must be double-checked rather than
// silently trusted (#433).
//
// Two independent signals, deliberately NOT collapsed into a wall-clock compare:
//   * an EPOCH counter (monotonically bumped on every reconnect) decides ORDER —
//     "has an explicit open/new re-pointed `active` SINCE the latest reconnect?".
//     A pre-reconnect resync carries an OLDER epoch and can never clear the new
//     window, even if both events land in the same millisecond (codex P1).
//   * a MONOTONIC elapsed reading (callers pass performance.now(), which never
//     runs backwards and is immune to wall-clock adjustments — codex P1) decides
//     the WINDOW — "was the reconnect recent enough to still warn?".
//
// Dependency-free (no DOM, no app, no timers, no clock) so it is unit-testable with
// plain values and the same logic can't drift between workflow_list and graph_outline.

/** How long after a reconnect the `active` pointer is treated as possibly stale (ms). */
export const ACTIVE_STALE_WINDOW_MS = 30000;

/**
 * True when the LATEST reconnect (epoch > 0) has NOT been superseded by an explicit
 * resync for that same epoch AND it happened within `windowMs` of `now` on a
 * MONOTONIC clock. Fail-safe: any missing/invalid input yields `false` (never flag
 * when we can't actually tell), preserving the pre-existing "report active as-is".
 *
 * @param {{
 *   reconnectEpoch?: number,   // bumped on every reconnect; 0/absent = none yet
 *   resyncEpoch?: number,      // epoch value at the last explicit open/new
 *   reconnectedAt?: number|null, // monotonic timestamp (performance.now) of latest reconnect
 *   now?: number,              // monotonic timestamp (performance.now)
 *   windowMs?: number,
 * }} o
 */
export function activeWorkflowPossiblyStale({
  reconnectEpoch = 0,
  resyncEpoch = 0,
  reconnectedAt,
  now,
  windowMs = ACTIVE_STALE_WINDOW_MS,
} = {}) {
  // No reconnect has happened → nothing to warn about.
  if (!Number.isFinite(reconnectEpoch) || reconnectEpoch <= 0) return false;
  // An explicit open/new that ran AT OR AFTER the latest reconnect (same-or-newer
  // epoch) makes `active` authoritative again — clear immediately. Ordering is by
  // epoch, so a pre-reconnect resync (older epoch) can't spuriously clear (codex P1).
  if (Number.isFinite(resyncEpoch) && resyncEpoch >= reconnectEpoch) return false;
  // Window check on a monotonic clock: negative elapsed (should be impossible with
  // performance.now) fails safe to "not stale" rather than flag forever.
  if (typeof reconnectedAt !== "number" || !Number.isFinite(reconnectedAt)) return false;
  if (typeof now !== "number" || !Number.isFinite(now)) return false;
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
