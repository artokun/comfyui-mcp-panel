import { acceptableLoopbackBridgeUrl } from "./advertised-bridge-url.js";
import {
  DEFAULT_BRIDGE_URL,
  defaultDialOrder,
  isDefaultBridgeUrl,
  normalizeBridgeUrl,
} from "./bridge-defaults.js";

export function migrateAutostartValue({ existingInstall, legacyValue }) {
  return existingInstall ? legacyValue === true : true;
}

export function panelOpenAction({ orchestratorRunning, autostartEnabled }) {
  if (orchestratorRunning) return "connect";
  return autostartEnabled ? "start" : "idle";
}

/**
 * panel#1596 — Connect / autostart entry: spawn vs connect, and which URL.
 *
 * A live orchestrator on 9180 must be connected, not abandoned for a 9199 spawn.
 * Advertised local URL is first; then `/status` (which probes 9199 then 9180);
 * a user pin is never moved. `tryUrls` is the handshake list that MUST be
 * attempted before launcher `/start` when nothing is yet proven live.
 */
export function connectEntryPlan({
  pinnedUrl,
  advertisedLocalUrl,
  statusRunning,
  statusBridgeUrl,
} = {}) {
  const pin = normalizeBridgeUrl(pinnedUrl);
  if (pin && !isDefaultBridgeUrl(pin)) {
    return { action: "connect", spawn: false, url: pin, tryUrls: [pin] };
  }
  const advertised = acceptableLoopbackBridgeUrl(advertisedLocalUrl);
  if (advertised) {
    return { action: "connect", spawn: false, url: advertised, tryUrls: [advertised] };
  }
  if (statusRunning === true) {
    const live = acceptableLoopbackBridgeUrl(statusBridgeUrl) || DEFAULT_BRIDGE_URL;
    return { action: "connect", spawn: false, url: live, tryUrls: [live] };
  }
  const tryUrls = defaultDialOrder();
  return { action: "start", spawn: true, url: null, tryUrls };
}
