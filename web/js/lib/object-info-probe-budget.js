/**
 * The first object-info probe on a connection is intentionally short when the
 * ComfyUI page is local. A non-loopback page origin means the same whole-schema
 * read crosses a network, so give that discovery window a larger bounded allowance.
 *
 * This only selects the probe's allowance. The panel_set_widget command still caps
 * the actual wait with its one 25s command budget, and the object-info oracle still
 * refuses answered-but-unusable responses.
 */
export const OBJECT_INFO_SNAPSHOT_PROBE_DEADLINE_MS = 2000;
export const OBJECT_INFO_REMOTE_SNAPSHOT_PROBE_DEADLINE_MS = 8000;

function isLoopbackHostname(hostname) {
  const host = String(hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host.startsWith("127.") ||
    host === "::" ||
    host === "::1"
  );
}

/**
 * Select the first-silence allowance from the origin that serves the panel's
 * ComfyUI API. Unknown or malformed origins take the remote allowance: that is
 * still bounded, while treating an unclassified target as local would recreate
 * the false-dead probe this helper exists to prevent.
 */
export function objectInfoSnapshotProbeDeadline(origin) {
  try {
    const hostname = new URL(origin).hostname;
    return isLoopbackHostname(hostname)
      ? OBJECT_INFO_SNAPSHOT_PROBE_DEADLINE_MS
      : OBJECT_INFO_REMOTE_SNAPSHOT_PROBE_DEADLINE_MS;
  } catch {
    return OBJECT_INFO_REMOTE_SNAPSHOT_PROBE_DEADLINE_MS;
  }
}

/**
 * #2050 — how long a whole-schema fetch may wait on a large install.
 *
 * The warm-install 10s getNodeDefs floor is too small after a pack install whose
 * `/object_info` takes ~21s (#1562 measured 25,104,088 bytes / 20.84s). Size from a
 * prior successful duration when we have one; otherwise from what the command still
 * has. Always finite and at least 1ms so `withTimeout` still bounds. A never-arriving
 * schema still fails closed at that bound.
 */
export const OBJECT_INFO_FETCH_MARGIN = 1.25;

export function objectInfoFetchBudgetMs({
  observedMs = 0,
  remainingMs,
  floorMs = 0,
  ceilingMs,
  margin = OBJECT_INFO_FETCH_MARGIN,
} = {}) {
  const remaining = Number(remainingMs);
  if (!Number.isFinite(remaining) || remaining <= 0) return 1;
  const floor = Number.isFinite(floorMs) && floorMs > 0 ? floorMs : 0;
  const ceiling = Number.isFinite(ceilingMs) && ceilingMs > 0 ? ceilingMs : remaining;
  const factor = Number.isFinite(margin) && margin >= 1 ? margin : 1;
  const observed = Number(observedMs);
  let want = floor;
  if (Number.isFinite(observed) && observed > 0) {
    want = Math.max(floor, Math.ceil(observed * factor));
  } else {
    want = Math.max(floor, remaining);
  }
  return Math.max(1, Math.min(want, ceiling, remaining));
}
