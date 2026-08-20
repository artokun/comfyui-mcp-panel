// panel#1486 — which advertised bridge URL a tab may adopt.
//
// The orchestrator owns port 9180 by default on BOTH sides, so the panel's compiled
// fallback is not stale. But the port is overridable (`COMFYUI_MCP_BRIDGE_PORT`) and
// the orchestrator moves off it when an older instance holds it — and in either case
// it ADVERTISES where it actually landed, via `/comfyui_mcp_panel/status`.
//
// Adoption used to exist on exactly two paths, both of them POST responses: the
// panel's own launcher start, and the auto-reclaim. An orchestrator started
// EXTERNALLY (`npx comfyui-mcp connect` in a terminal) sends neither, and the only
// other reader — `fetchAdvertisedBridgeUrl` — is `https:`-gated and `wss://`-only for
// the tunnel case. So a plain loopback bridge on a non-default port was never
// adoptable: the tab dialled its compiled default forever while status advertised the
// real one.

/** ws:// on loopback only. */
const LOOPBACK_WS = /^ws:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?(\/|$)/i;

/**
 * A `ws://` URL a tab may adopt from an advertisement, or null.
 *
 * Loopback ONLY, deliberately. An advertisement is a hint from a local endpoint, not
 * an instruction: adopting an arbitrary host from it would let whatever answers
 * `/comfyui_mcp_panel/status` redirect this tab's agent traffic somewhere else. The
 * loopback case is the one this fixes and the one that carries no such question.
 * `wss://` is NOT accepted here — that is the tunnel path, which has its own reader
 * and its own token handling.
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
 * `secureUrl` is the tunnel advertisement (https pages); `statusBridgeUrl` is what
 * `/comfyui_mcp_panel/status` reports. On an https page the secure URL keeps its
 * existing precedence and a plain loopback advertisement is NOT substituted for it —
 * that path is token-gated and changing it is a separate question from this fix.
 *
 * Returns null when the advertisement matches what is already dialled, so a caller
 * never churns the socket for a no-op.
 */
export function pickAdvertisedBridgeUrl({ protocol, secureUrl, statusBridgeUrl, currentUrl } = {}) {
  const chosen =
    protocol === "https:"
      ? typeof secureUrl === "string" && secureUrl.startsWith("wss://")
        ? secureUrl
        : null
      : acceptableLoopbackBridgeUrl(statusBridgeUrl);
  if (!chosen) return null;
  if (typeof currentUrl === "string" && currentUrl.trim() === chosen) return null;
  return chosen;
}
