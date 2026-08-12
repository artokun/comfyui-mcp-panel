/**
 * comfyui-mcp#1136 — the status chip read `disconnected` on a working session,
 * because the panel was dialing a dead port while a healthy bridge answered next door.
 *
 * Measured on the reporting machine:
 *
 *   9180   LISTENING, HTTP 426 Upgrade Required   <- the live single-port bridge
 *   52727  ECONNREFUSED                            <- comfyui-mcp.bridgeUrl.claude
 *
 * with `defaultBackend: "claude"`, so the panel dialed 52727 forever and the chip
 * faithfully reported that socket as down. The label was never wrong; its SUBJECT was.
 *
 * ## How a dead port became sticky
 *
 * Three ordinary decisions compose into it:
 *
 * 1. A one-time migration copies the pre-per-backend `comfyui-mcp.bridgeUrl` into the
 *    Claude group "so a returning user's custom port isn't lost". But the value it
 *    preserves is an EPHEMERAL orchestrator port, which stops being valid the moment
 *    that process restarts — and it is preserved unconditionally.
 *
 * 2. The connect path classifies any URL that differs from the backend default as a
 *    deliberate MANUAL OVERRIDE, and honours it over the live single-port bridge. It
 *    cannot tell "the user typed this on purpose" from "a migration put it here".
 *
 * 3. In external-orchestrator mode the panel dials that URL directly and never POSTs
 *    /connect, so the orchestrator's advertised `bridge_url` — which carries the live
 *    port — is never consulted, and nothing self-heals.
 *
 * The single-port key's own definition already forbids exactly this outcome: it is
 * "deliberately NOT the per-backend or legacy ones, whose stale pre-single-port values
 * (e.g. a migrated custom port) must not leak in and make the panel dial a dead port."
 * The guard existed; the migration walked around it.
 *
 * ## The discriminator is PROVENANCE, not the value
 *
 * No comparison of the URL itself can separate the two cases — a migrated port and a
 * hand-typed one are both just strings that differ from the default. So the migration
 * RECORDS what it wrote, and a value that matches that record is treated as inherited
 * rather than chosen. A port the user actually types still outranks everything, which
 * is the behaviour the override rule exists to protect.
 *
 * KNOWN LIMITATION, stated because the first draft of this comment claimed otherwise.
 * The record is NOT cleared when the user edits the field. Two consequences, both real:
 *
 *   - A user who changes the URL and later deliberately retypes the value the migration
 *     once wrote is still classified as inherited, and their choice is disregarded.
 *   - The record lives in localStorage while the URL is a SYNCED ComfyUI setting, so on
 *     a second tab or device the setting can arrive without its record (wrongly manual),
 *     or a stale local record can suppress a legitimately re-entered URL.
 *
 * Neither is the reported bug and neither makes it worse, but both are ways this can be
 * wrong, and a reader deserves to know before extending it. The clearing path belongs
 * wherever the user's own edit is committed; storing provenance beside the setting
 * rather than in localStorage would close the sync hole.
 */

/** localStorage key holding the URL the migration wrote for `backend`. */
export function migratedBridgeUrlKey(backend) {
  return `comfyui-mcp.panel.migratedBridgeUrl.${String(backend ?? "")}`;
}

/**
 * Is `url` the value a migration deposited, rather than one the user chose?
 *
 * Both arguments are compared as trimmed strings: a stored setting can pick up
 * whitespace through a settings round-trip, and a trailing space must not be enough
 * to promote an inherited value into a deliberate one.
 */
export function isInheritedBridgeUrl(url, migratedUrl) {
  if (typeof url !== "string" || typeof migratedUrl !== "string") return false;
  const a = url.trim();
  const b = migratedUrl.trim();
  if (!a || !b) return false;
  return a === b;
}

/**
 * Should `wanted` be honoured as a deliberate manual override?
 *
 * `wanted` is what the URL field holds; `backendDefault` is the backend's default
 * bridge URL; `lastAutoUrl` is the last URL the panel applied by itself; `migratedUrl`
 * is what a migration deposited for this backend, if anything.
 *
 * This reproduces the existing rule exactly and subtracts ONE case — the inherited
 * value — so a genuinely custom port keeps winning and a stale migrated one stops.
 */
export function isManualBridgeOverride({
  wanted,
  backendDefault,
  lastAutoUrl,
  migratedUrl,
} = {}) {
  const w = typeof wanted === "string" ? wanted.trim() : "";
  if (!w) return false;
  if (w === backendDefault) return false;
  if (w === lastAutoUrl) return false;
  // The one subtraction: a value this panel inherited is not a value the user chose.
  if (isInheritedBridgeUrl(w, migratedUrl)) return false;
  return true;
}
