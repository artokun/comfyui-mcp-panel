/**
 * panel#1596 — default bridge URL, the 9180 legacy, and which saved values are a pin.
 *
 * 9180 collided with Logitech G HUB's lghub_agent. The compiled default is 9199;
 * a saved setting of exactly the old 9180 (or 9101) URL is treated as "default"
 * and migrated, the way LEGACY_BRIDGE_URL already migrated 9101. A user who
 * typed any other URL is a pin and is never moved.
 *
 * When nothing is advertised the browser dials [9199, 9180] and the handshake
 * (not a TCP connect) decides which one is the orchestrator, so a live session
 * still on 9180 is not stranded across a panel update.
 */

export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:9199";
export const LEGACY_BRIDGE_URL = "ws://127.0.0.1:9101"; // old shared default — migrate off it
export const LEGACY_9180_BRIDGE_URL = "ws://127.0.0.1:9180"; // previous dedicated default

/** Normalise for COMPARISON only — never the value we dial. */
export function normalizeBridgeUrl(url) {
  return typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
}

/**
 * True when `url` is the compiled default or a previous compiled default.
 *
 * Exact loopback URLs only. `ws://localhost:9180` (or any other host/port the
 * user typed) is a pin.
 */
export function isDefaultBridgeUrl(url) {
  const n = normalizeBridgeUrl(url);
  return n === DEFAULT_BRIDGE_URL || n === LEGACY_9180_BRIDGE_URL || n === LEGACY_BRIDGE_URL;
}

/**
 * Dial order when nothing is advertised and the saved URL is default-ish.
 *
 * Handshake, not TCP, is the arbiter: 9199 first (new default), then 9180 so a
 * live session on the old port still connects.
 */
export function defaultDialOrder() {
  return [DEFAULT_BRIDGE_URL, LEGACY_9180_BRIDGE_URL];
}

/**
 * The URL to seed from a saved setting: the new default when the saved value is
 * empty or a migrated default, otherwise the pin unchanged.
 */
export function resolvedDefaultBridgeUrl(saved) {
  const n = normalizeBridgeUrl(saved);
  if (!n || isDefaultBridgeUrl(n)) return DEFAULT_BRIDGE_URL;
  return n;
}
