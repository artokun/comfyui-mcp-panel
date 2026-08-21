// panel#1486 — which advertised bridge URL a tab may adopt.
//
// WHAT `/comfyui_mcp_panel/status` ACTUALLY SAYS, because the obvious reading is wrong
// and a fix built on it does nothing. `bridge_url` is not a report of where the
// orchestrator bound. It is `ws://{_BRIDGE_HOST}:{_BRIDGE_PORT}` (`__init__.py:928`),
// and `_BRIDGE_PORT` is an IMPORT-TIME constant of the ComfyUI process
// (`__init__.py:64`, `COMFYUI_MCP_BRIDGE_PORT` or 9180) with exactly one writer and no
// `global` declaration anywhere — no handler can mutate it. So the field says only
// "the port THIS ComfyUI was configured to probe". If the orchestrator finds 9180 held
// and binds 9181, status still says 9180, and nothing here can discover that.
//
// What this fixes is therefore narrower than it first appears, and is the reported
// case: ComfyUI is configured for a non-default port (so status names it), the
// orchestrator is on that same port, and the panel — which had no reader for a plain
// `ws://` advertisement at all — kept dialling its compiled 9180 default. Adoption
// previously existed only on two POST responses (the panel's own launcher start, and
// the auto-reclaim), neither of which an externally started orchestrator sends, plus a
// tunnel reader gated to `https:` + `wss://`.
//
// `running` IS the discriminator, and it is in the same payload. It reports whether
// this ComfyUI could reach an orchestrator at that port. Adopting without it is how a
// tab gets moved OFF a live bridge onto a dead one: with `COMFYUI_MCP_BRIDGE_PORT=9181`
// in ComfyUI's environment and an orchestrator actually on 9180, an unconditional adopt
// sends the tab to 9181 where nothing listens — and the next tick sees the
// advertisement already equal to the current URL, so it never comes back.

// ONE KNOWN LIMIT OF THAT CORROBORATION: `running` is ComfyUI probing ITS OWN
// loopback, while the URL adopted here is dialled in the BROWSER's. Where those
// namespaces differ — WSL, a LAN-served ComfyUI, an SSH tunnel — a true `running`
// says a listener exists server-side, not client-side. It takes a non-default
// COMFYUI_MCP_BRIDGE_PORT *and* split namespaces to reach, it only affects a tab
// already failing to reconnect, and `persist: false` means any Connect or reload
// resets to configuredBridgeUrlFor — so it degrades nothing that was working.

/** ws:// on loopback only. */
const LOOPBACK_WS = /^ws:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?(\/|$)/i;

/**
 * A `ws://` URL a tab may adopt from an advertisement, or null.
 *
 * Loopback ONLY, deliberately. An advertisement is a hint from a local endpoint, not an
 * instruction: adopting an arbitrary host would let whatever answers
 * `/comfyui_mcp_panel/status` redirect this tab's agent traffic. `wss://` is NOT
 * accepted here — that is the tunnel path, which has its own reader and token handling.
 */
export function acceptableLoopbackBridgeUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  return LOOPBACK_WS.test(trimmed) ? trimmed : null;
}

/**
 * The URL this tab should switch to, or null to stay put.
 *
 * `secureUrl` is the tunnel advertisement (https pages) and keeps its existing
 * precedence; a plain loopback advertisement is never substituted for it, and an https
 * page with no secure URL yet adopts nothing rather than downgrading.
 *
 * On a non-https page the loopback advertisement is adopted only when `statusRunning`
 * is exactly `true` — see the header. An older pack that omits the field, or a `false`,
 * or anything non-boolean, means the advertisement is not corroborated and the tab
 * keeps whatever it has: the bare WS retry can still recover on its own, which is what
 * it did before this path existed at all.
 *
 * Returns null when the advertisement equals what is already dialled, so polling never
 * churns the socket for a no-op.
 */
export function pickAdvertisedBridgeUrl({
  protocol,
  secureUrl,
  localUrl,
  statusBridgeUrl,
  statusRunning,
  currentUrl,
} = {}) {
  let chosen;
  if (protocol === "https:") {
    chosen =
      typeof secureUrl === "string" && secureUrl.startsWith("wss://") ? secureUrl : null;
  } else {
    // #1596 — the orchestrator's advertised loopback is authoritative. It named
    // the port it bound; that does not need `running` corroboration (the compiled
    // probe port may be 9199 while a live session is still on 9180).
    chosen = acceptableLoopbackBridgeUrl(localUrl);
    if (!chosen) {
      chosen =
        statusRunning === true ? acceptableLoopbackBridgeUrl(statusBridgeUrl) : null;
    }
  }
  if (!chosen) return null;
  if (typeof currentUrl === "string" && currentUrl.trim() === chosen) return null;
  return chosen;
}
