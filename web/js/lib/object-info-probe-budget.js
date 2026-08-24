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
