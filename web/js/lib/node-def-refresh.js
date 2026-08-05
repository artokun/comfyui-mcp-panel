// #635 — the node-def refresh VERDICT, with the cause when it is not fresh.
//
// registerComfyNodeDefs used to answer a bare boolean: {ok:true, refreshed:false}
// gave the caller no way to tell "the backend did not serve /object_info" from
// "this frontend build has no combo-refresh API" from "the fetch threw" — every
// failure read as the same no-op, so the agent could neither act nor explain.
// This module turns the observed evidence into a verdict with a stable `reason`
// token and a `remedy` that is actionable from the caller's current state.
//
// The verdict describes THIS run only. It is deliberately NOT derived from (and
// never written into) the shared nodeDefsRefreshConfirmed global: a concurrent
// refresh can overwrite that global mid-await (codex round-6 P0 on the get_errors
// path), so each caller must read the verdict of the run it triggered.
//
// Pure: every input is observed by the caller and passed in.

/** Stable reason tokens for a node-def refresh that is NOT confirmed fresh. */
export const NODE_DEF_REFRESH_REASONS = Object.freeze({
  APP_UNAVAILABLE: "app_unavailable",
  OBJECT_INFO_UNAVAILABLE: "object_info_unavailable",
  OBJECT_INFO_FETCH_FAILED: "object_info_fetch_failed",
  REGISTER_FAILED: "register_failed",
  COMBO_API_ABSENT: "combo_api_absent",
  COMBO_REFRESH_FAILED: "combo_refresh_failed",
});

function detailSuffix(thrown) {
  const text = String(thrown?.message ?? thrown ?? "").trim();
  return text ? `(${text})` : "";
}

/**
 * Build the verdict for one registerComfyNodeDefs run.
 *
 * @param {{
 *   appAvailable: boolean,     // the ComfyUI frontend app object was reachable
 *   defsObtained: boolean,     // an /object_info payload was actually obtained
 *   comboApiPresent: boolean,  // app.refreshComboInNodes exists on this build
 *   comboRan: boolean,         // refreshComboInNodes completed this run
 *   phase?: string,            // "fetch" | "register" | "combo" | "done" — where a throw happened
 *   thrown?: any,              // the error a phase threw, if any
 * }} o
 * @returns {{ refreshed: boolean, reason: string, remedy?: string, detail?: string }}
 */
export function describeNodeDefRefresh({
  appAvailable,
  defsObtained,
  comboApiPresent,
  comboRan,
  phase = "done",
  thrown = null,
} = {}) {
  if (!appAvailable) {
    return {
      refreshed: false,
      reason: NODE_DEF_REFRESH_REASONS.APP_UNAVAILABLE,
      remedy:
        "The ComfyUI frontend app object is not available in this browser tab, so nothing was " +
        "refreshed. Reload the ComfyUI tab, then retry.",
    };
  }
  if (thrown) {
    const reason =
      phase === "fetch"
        ? NODE_DEF_REFRESH_REASONS.OBJECT_INFO_FETCH_FAILED
        : phase === "combo"
          ? NODE_DEF_REFRESH_REASONS.COMBO_REFRESH_FAILED
          : NODE_DEF_REFRESH_REASONS.REGISTER_FAILED;
    const remedy =
      reason === NODE_DEF_REFRESH_REASONS.OBJECT_INFO_FETCH_FAILED
        ? "The /object_info fetch failed, so nothing was refreshed. The backend may still be " +
          "restarting — retry once it answers, and if it never does, check that the ComfyUI " +
          "server process is still running."
        : reason === NODE_DEF_REFRESH_REASONS.COMBO_REFRESH_FAILED
          ? "Node definitions WERE re-registered from a fresh /object_info, but refreshing the " +
            "combo lists failed, so dropdown options may still be stale. Retry; if it keeps " +
            "failing, reload the ComfyUI tab to rebuild the combo lists."
          : "A fresh /object_info was obtained but re-registering the node definitions failed, " +
            "so the refresh is NOT confirmed. Reload the ComfyUI tab, then retry.";
    return { refreshed: false, reason, detail: detailSuffix(thrown) || undefined, remedy };
  }
  if (!defsObtained) {
    return {
      refreshed: false,
      reason: NODE_DEF_REFRESH_REASONS.OBJECT_INFO_UNAVAILABLE,
      remedy:
        "The panel could not obtain /object_info from the ComfyUI backend (this frontend exposes " +
        "no getNodeDefs, or it returned nothing), so node definitions and combo lists were NOT " +
        "refreshed. If the backend is mid-restart, retry once it is up; otherwise reload the " +
        "ComfyUI tab.",
    };
  }
  if (!comboApiPresent) {
    return {
      refreshed: false,
      reason: NODE_DEF_REFRESH_REASONS.COMBO_API_ABSENT,
      remedy:
        "This ComfyUI frontend build has no refreshComboInNodes API, so combo lists cannot be " +
        "rebuilt in place. Node definitions WERE re-registered from a fresh /object_info — only " +
        "the combo dropdowns may be stale, and those refresh on a tab reload (reload the ComfyUI " +
        "page or press R in it).",
    };
  }
  if (!comboRan) {
    // Defensive: a present combo API that did not run without a throw should be
    // unreachable — but "could not determine" is not "refreshed", so fail closed
    // with the honest token rather than claim success.
    return {
      refreshed: false,
      reason: NODE_DEF_REFRESH_REASONS.COMBO_REFRESH_FAILED,
      remedy:
        "Node definitions WERE re-registered from a fresh /object_info, but the combo refresh " +
        "did not complete, so dropdown options may still be stale. Retry; if it keeps " +
        "happening, reload the ComfyUI tab to rebuild the combo lists.",
    };
  }
  return { refreshed: true, reason: "refreshed" };
}
