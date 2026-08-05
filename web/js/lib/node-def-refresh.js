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
  REGISTER_API_ABSENT: "register_api_absent",
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
 *   defsRegistered: boolean,   // registerNodesFromDefs actually RAN this run —
 *                              // a frontend without that API must never let the
 *                              // remedy claim registration happened (codex r2 P1)
 *   comboApiPresent: boolean,  // app.refreshComboInNodes exists on this build
 *   comboRan: boolean,         // refreshComboInNodes completed this run
 *   phase?: string,            // "fetch" | "record" | "register" | "reapply" | "combo" | "done" — where a throw happened
 *   didThrow?: boolean,        // a throw happened at all — tracked independently of
 *                              // the caught VALUE, which can be falsy (throw null)
 *   thrown?: any,              // the error a phase threw, if any
 * }} o
 * @returns {{ refreshed: boolean, reason: string, remedy?: string, detail?: string }}
 */
export function describeNodeDefRefresh({
  appAvailable,
  defsObtained,
  defsRegistered = false,
  comboApiPresent,
  comboRan,
  phase = "done",
  didThrow,
  thrown = null,
} = {}) {
  // Backstop for a caller that predates didThrow: a truthy caught value implies it.
  const failed = didThrow === true || !!thrown;
  // The registration clause the combo-failure remedies are allowed to make:
  // "WERE re-registered" only when the registration call observably ran.
  const registrationClause = defsRegistered
    ? "Node definitions WERE re-registered from a fresh /object_info"
    : "Node definitions were fetched but this frontend exposes no registerNodesFromDefs, so they were NOT registered";
  const registrationRemedy = defsRegistered
    ? ""
    : " Reload the ComfyUI tab so the frontend picks up the new definitions.";
  if (!appAvailable) {
    return {
      refreshed: false,
      reason: NODE_DEF_REFRESH_REASONS.APP_UNAVAILABLE,
      remedy:
        "The ComfyUI frontend app object is not available in this browser tab, so nothing was " +
        "refreshed. Reload the ComfyUI tab, then retry.",
    };
  }
  if (failed) {
    const reason =
      phase === "fetch"
        ? NODE_DEF_REFRESH_REASONS.OBJECT_INFO_FETCH_FAILED
        : phase === "combo"
          ? NODE_DEF_REFRESH_REASONS.COMBO_REFRESH_FAILED
          : NODE_DEF_REFRESH_REASONS.REGISTER_FAILED;
    // The register_failed remedy must describe what ACTUALLY threw (codex r3/r4):
    // "register" is the registerNodesFromDefs call itself, "reapply" runs after
    // registration succeeded, and "record" fails BEFORE registration was ever
    // attempted — claiming a registration attempt in the last case is a lie.
    const registerRemedy =
      phase === "reapply"
        ? `${registrationClause}, but applying the fresh definitions to the live canvas ` +
          "nodes failed, so the refresh is NOT confirmed. Reload the ComfyUI tab, then retry."
        : phase === "record"
          ? "A fresh /object_info was obtained, but the refresh failed while recording it, " +
            "BEFORE registration was attempted, so nothing was refreshed. Retry; if it " +
            "persists, reload the ComfyUI tab."
          : "A fresh /object_info was obtained but re-registering the node definitions failed, " +
            "so the refresh is NOT confirmed. Reload the ComfyUI tab, then retry.";
    const remedy =
      reason === NODE_DEF_REFRESH_REASONS.OBJECT_INFO_FETCH_FAILED
        ? "The /object_info fetch failed, so nothing was refreshed. The backend may still be " +
          "restarting — retry once it answers, and if it never does, check that the ComfyUI " +
          "server process is still running."
        : reason === NODE_DEF_REFRESH_REASONS.COMBO_REFRESH_FAILED
          ? `${registrationClause}, but refreshing the ` +
            "combo lists failed, so dropdown options may still be stale. Retry; if it keeps " +
            "failing, reload the ComfyUI tab to rebuild the combo lists." +
            registrationRemedy
          : registerRemedy;
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
  if (!defsRegistered) {
    // Registration never RAN (a frontend without registerNodesFromDefs) — the
    // whole point of the tool for a pack install is defeated, so this is its own
    // reason, never a silent refreshed:true (codex gate r3). Combos may still
    // have refreshed; say so when they did.
    return {
      refreshed: false,
      reason: NODE_DEF_REFRESH_REASONS.REGISTER_API_ABSENT,
      remedy:
        "A fresh /object_info was fetched, but this frontend exposes no registerNodesFromDefs, " +
        "so the new/updated node definitions were NOT registered in place." +
        (comboRan ? " The combo dropdown lists WERE refreshed from it." : "") +
        " Reload the ComfyUI tab so the frontend picks up the new definitions; if they are " +
        "still missing after a reload, this frontend build predates the registration API and " +
        "ComfyUI needs an update.",
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
        `${registrationClause}, but the combo refresh ` +
        "did not complete, so dropdown options may still be stale. Retry; if it keeps " +
        "happening, reload the ComfyUI tab to rebuild the combo lists." +
        registrationRemedy,
    };
  }
  return { refreshed: true, reason: "refreshed" };
}
