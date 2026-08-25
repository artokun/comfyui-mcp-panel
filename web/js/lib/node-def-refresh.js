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

import { nodeInventoryLabel } from "./graph-node-inventory.js";
// #608 — the ONE renderer for "what each route did", shared with the two other refusals
// that already print it (`graph_get_object_info` and the set_widget fence). It caps the
// entry count and sanitizes each sentence, which matters here because a caller can hand
// this text a backend or extension produced.
import { objectInfoOracleFailureNote } from "./object-info-oracle.js";

/** Stable reason tokens for a node-def refresh that is NOT confirmed fresh. */
export const NODE_DEF_REFRESH_REASONS = Object.freeze({
  APP_UNAVAILABLE: "app_unavailable",
  OBJECT_INFO_UNAVAILABLE: "object_info_unavailable",
  OBJECT_INFO_FETCH_FAILED: "object_info_fetch_failed",
  REGISTER_FAILED: "register_failed",
  REGISTER_API_ABSENT: "register_api_absent",
  COMBO_API_ABSENT: "combo_api_absent",
  COMBO_REFRESH_FAILED: "combo_refresh_failed",
  // #1275 — the refresh itself deleted live-canvas nodes and they could not all
  // be restored. A data-loss verdict: it overrides even a real phase failure,
  // because the lost nodes are the fact the caller must act on first.
  GRAPH_NODES_LOST: "graph_nodes_lost",
  // #1404 — the ONE token in this map that `describeNodeDefRefresh` never produces,
  // because it does not describe a run at all: the caller's command budget ran out
  // WAITING for a refresh (someone else's, then its own), and the run it stopped
  // waiting for is still going. It lives here anyway, and deliberately: `reason` is a
  // single vocabulary as far as its reader is concerned, and a value that could only be
  // found by reading the executor is a value nobody will handle. Distinct from every
  // token above by the fact that matters to a caller — nothing failed, so a retry is
  // expected to succeed rather than hoped to.
  REFRESH_STILL_RUNNING: "refresh_still_running",
  // #1695 — a run that crossed a backend reconnect cannot certify the replacement
  // connection's node registry or combo lists.
  REFRESH_SUPERSEDED: "refresh_superseded",
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
 *   comboRebuiltLocally?: boolean, // #1193 — the panel's OWN reapply sweep finished and
 *                              // rebuilt every live combo's option list from THIS run's
 *                              // /object_info payload (#1172). Distinct from comboRan:
 *                              // one is the frontend's call answering, the other is work
 *                              // this panel did and counted. Both false is "stale";
 *                              // collapsing them into one flag is what made an abandoned
 *                              // frontend call read as stale combos it had already fixed.
 *   comboRefreshSkipped?: boolean, // #1736 — the panel skipped the duplicate frontend call
 *                              // because that local rebuild already covered every live combo.
 *   comboWaitMs?: number|null, // the bound the combo phase was actually given, so an
 *                              // abandoned phase can say whether it was STARVED by a slow
 *                              // fetch or given its whole allowance and still hung
 *   phase?: string,            // "fetch" | "record" | "register" | "reapply" | "combo" | "done" — where a throw happened
 *   didThrow?: boolean,        // a throw happened at all — tracked independently of
 *                              // the caught VALUE, which can be falsy (throw null)
 *   thrown?: any,              // the error a phase threw, if any
 *   fetchRouteFailures?: string[]|null, // #608 — what EACH transport the fetch phase has
 *                              // tried actually did, in order, when none of them produced
 *                              // a payload. The fetch-phase remedies name them: before
 *                              // this, "check that the ComfyUI server process is still
 *                              // running" was printed on the evidence of one route, and
 *                              // the reported install had a healthy server answering a
 *                              // different transport at that same moment.
 *   fetchAbandonedAtBound?: boolean|null, // #1562 — EVERY whole-document route ended by
 *                              // being ABANDONED AT ITS BOUND rather than by failing. The
 *                              // caller decides this from the oracle's per-route TAGS and
 *                              // its own timeout flag, never from the failure prose
 *                              // (#1223). null = no whole-document route was reached, so
 *                              // neither answer is claimed.
 * }} o
 * @returns {{ refreshed: boolean, reason: string, remedy?: string, detail?: string }}
 */
export function describeNodeDefRefresh({
  appAvailable,
  defsObtained,
  defsRegistered = false,
  comboApiPresent,
  comboRan,
  comboRebuiltLocally = false,
  comboRefreshSkipped = false,
  comboWaitMs = null,
  phase = "done",
  didThrow,
  thrown = null,
  fetchRouteFailures = null,
  fetchAbandonedAtBound = null,
} = {}) {
  // Backstop for a caller that predates didThrow: a truthy caught value implies it.
  const failed = didThrow === true || !!thrown;
  // #608 — "" when the caller recorded nothing, so a caller that does not pass this reads
  // exactly as it did before rather than gaining an empty clause.
  const routesNote = objectInfoOracleFailureNote(fetchRouteFailures);
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
  // #608 — the answer for a run that obtained NO /object_info at all, in one place. Two
  // branches return it: the ordinary no-payload path below, and a LATER phase that failed
  // on a run which never had a payload to fail over.
  const noPayloadRemedy =
    "The panel could not obtain /object_info from the ComfyUI backend (this frontend exposes " +
    "no getNodeDefs, or no route returned anything usable), so node definitions and combo " +
    "lists were NOT refreshed. If the backend is mid-restart, retry once it is up; " +
    "otherwise reload the ComfyUI tab." +
    // The routes are the only thing that can tell a caller WHICH transport it was: this
    // path carries no detail of its own.
    routesNote;
  if (failed) {
    // #608 — A LATER PHASE CANNOT SPEAK FOR A RUN THAT NEVER OBTAINED A PAYLOAD, and this
    // is keyed on `defsObtained` — an input this function is HANDED, not on an assumption
    // about what else was true.
    //
    // Reported by the gate on the fix that made it reachable: with `getNodeDefs` resolving
    // null (#1223's NOTHING_RETURNED) and the raw route not answering either, the run does
    // not rethrow — there is no error to rethrow — so it falls through to the combo phase
    // with `defs === null` and a budget the second route has spent. The combo call is then
    // abandoned, which sets `thrown`, and this ladder answered `combo_refresh_failed`
    // with a remedy that was false in BOTH halves: it said definitions "were fetched" when
    // none were, and that the frontend "exposes no registerNodesFromDefs" when it does —
    // registration was skipped only because there was nothing to register.
    //
    // The combo phase's outcome is not the fact the caller has to act on here, and
    // `registrationClause` cannot be true on either side of its own ternary when no payload
    // exists. So the missing payload names the verdict, exactly as it does when nothing
    // threw at all — the reply for this state is now the same either way.
    //
    // PHASE "fetch" IS EXCLUDED and keeps its own token: that failure IS the missing
    // payload, it is more specific, and its `detail` carries what the transport said.
    const noPayload = !defsObtained && phase !== "fetch";
    const reason = noPayload
      ? NODE_DEF_REFRESH_REASONS.OBJECT_INFO_UNAVAILABLE
      : phase === "fetch"
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
    const remedy = noPayload
      ? noPayloadRemedy
      : reason === NODE_DEF_REFRESH_REASONS.OBJECT_INFO_FETCH_FAILED
        ? // #1562 — SAY WHICH OF THE TWO THIS WAS, because their remedies are opposite.
          //
          // Every route being ABANDONED AT ITS BOUND is not evidence that the server is
          // down; it is evidence that nothing arrived in the time this command had. The
          // reporter's `/object_info` returned 25,104,088 bytes in 20.84 s from a server
          // that was up the whole time, while this text sent them to check whether the
          // process was still running — a remedy for a cause that was never established,
          // which is the same defect #982 recorded and #608 narrowed.
          //
          // It also must not promise that a plain retry helps. A document that does not fit
          // the window will not fit the next one either, so the steps named are the ones
          // that change the size of the question or the size of the window.
          //
          // `=== true` deliberately: `null` means no whole-document route was reached at
          // all, and an unestablished fact must fall to the wording that claims less about
          // this particular run rather than to the one that claims more.
          (fetchAbandonedAtBound === true
            ? "No /object_info answered inside the time this command had — every transport was " +
              "ABANDONED AT ITS BOUND and none of them FAILED, so this is NOT evidence that the " +
              "ComfyUI server is down; it may have been answering the whole time, just not fast " +
              "enough. Nothing was refreshed. A plain retry meets the same bound unless the " +
              "backend got faster: on a very large install the whole node-definition document " +
              "can take longer to deliver than one command may wait. Reload the ComfyUI tab — " +
              "its page load fetches the schema under no such bound — or reduce the installed " +
              "pack count."
            : "The /object_info fetch failed on every transport this panel has, so nothing was " +
              "refreshed. The backend may still be restarting — retry once it answers, and if it " +
              "never does, check that the ComfyUI server process is still running.") +
          // #608 — the routes, appended rather than folded into the sentence above: which
          // ones were tried is EVIDENCE, and it is what separates "one client call did not
          // answer" (where the server is usually fine, and was) from "nothing answers".
          routesNote
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
      remedy: noPayloadRemedy,
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
    // #1193 — the frontend's `refreshComboInNodes()` was still running when this run
    // stopped waiting for it, but the panel's OWN sweep already rebuilt every live
    // combo's option list from the /object_info payload this run fetched (#1172). The
    // dropdowns are current; what is missing is a confirmation from a call that is
    // largely a REPEAT of work already done — it issues its own /object_info and
    // re-registers every def, which `registerNodesFromDefs` did moments earlier.
    //
    // So this is neither "refreshed and confirmed" nor "stale". Said as its own answer,
    // because collapsing it into `combo_refresh_failed` reported stale dropdowns that
    // had in fact just been rebuilt, and — through the shared trust flag — put the
    // missing-asset scan back into over-report-safe mode (#610's false "model still
    // missing") for a refresh that succeeded.
    if (comboRebuiltLocally) {
      return {
        refreshed: true,
        reason: "refreshed",
        combo_refresh_confirmed: false,
        combo_refresh_note:
          `${registrationClause}, and the panel rebuilt every combo widget's option list ` +
          (comboRefreshSkipped
            ? "on the live graph from that same payload. The frontend's duplicate " +
              "refreshComboInNodes() call was skipped because those lists are already current."
            : "on the live graph from that same payload. The frontend's own refreshComboInNodes() " +
              "had not answered when this run stopped waiting for it" +
              (comboWaitMs ? ` (it was given ${comboWaitMs}ms)` : "") +
              " — it is still running and will re-apply the same definitions when it finishes. " +
              "The dropdown lists are current; only that call's completion is unconfirmed."),
      };
    }
    // Nothing rebuilt the lists — neither the frontend's call nor this panel's sweep
    // (no live graph, no payload, or the sweep stopped early). "Could not determine" is
    // not "refreshed", so fail closed with the honest token rather than claim success.
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

// ---------------------------------------------------------------------------
// #1275 — the refresh deleted live-canvas nodes. Wording lives here, beside
// the verdict it overrides, so the disclosure and the failure verdict cannot
// drift apart. Both helpers take INVENTORY ENTRIES (lib/graph-node-inventory)
// and both name the nodes: "some nodes disappeared" is the silent-loss bug
// wearing a disclosure costume.
// ---------------------------------------------------------------------------

function labelList(entries, cap = 6) {
  const labels = entries.map(nodeInventoryLabel);
  const shown = labels.slice(0, cap).join(", ");
  return labels.length > cap ? `${shown}, and ${labels.length - cap} more` : shown;
}

/**
 * Disclosure for a refresh whose graph loss was fully ROLLED BACK: the panel
 * restored the pre-refresh snapshot through the frontend's own workflow loader
 * and re-verified every vanished node is present. `refreshed` stays true —
 * the refresh did refresh, and the canvas is back — but the restore is said
 * out loud, because an install that pruned the canvas once will do it again.
 *
 * Only node PRESENCE is re-verified. The restore replays the full serialized
 * pre-refresh workflow, so positions, widgets, modes, links and ids are all
 * rewritten from it — but claiming they were verified would be claiming a
 * check that did not run, so the note tells the user to look.
 */
export function restoredLiveNodesNote(restoredEntries) {
  const list = Array.isArray(restoredEntries) ? restoredEntries : [];
  if (!list.length) return "";
  return (
    `The refresh REMOVED ${list.length} node${list.length === 1 ? "" : "s"} from the live canvas ` +
    `while it ran (${labelList(list)}) — a refresh must be additive, and this one was not. ` +
    "The panel restored the missing nodes from a snapshot taken immediately before the refresh " +
    "ran, using the frontend's own workflow loader, and re-verified every one is present on the " +
    "canvas again. Positions, widgets, links and ids were rewritten from that snapshot, but only " +
    "their presence was re-verified — look at the canvas and save the workflow before relying on " +
    "it. This install has demonstrated a refresh that prunes the live graph: prefer reloading the " +
    "tab over panel_refresh_nodes until the pruning cause is identified."
  );
}

/**
 * FAIL-CLOSED verdict for a refresh whose graph loss could NOT be fully
 * undone. Refreshed is FALSE whatever the refresh's phases accomplished —
 * a reply that says "refreshed" over a canvas the user just lost work on is
 * the bug being fixed. `lost_nodes` names what is gone; the remedy says what
 * was tried (and its outcome, when a restore ran and failed) rather than
 * guessing at the cause, which is not established.
 */
export function describeRefreshGraphLoss(lostEntries, { restoreAvailable = false, restoreThrew = null } = {}) {
  const lost = Array.isArray(lostEntries) ? lostEntries : [];
  const n = lost.length;
  const restoreOutcome = !restoreAvailable
    ? "This frontend exposes no loadGraphData, so the panel could not restore them. "
    : restoreThrew
      ? `The panel tried to restore them from the pre-refresh snapshot and the restore itself failed. `
      : "The panel tried to restore them from the pre-refresh snapshot, but they are still missing. ";
  return {
    refreshed: false,
    reason: NODE_DEF_REFRESH_REASONS.GRAPH_NODES_LOST,
    lost_nodes: lost.map(nodeInventoryLabel),
    ...(restoreThrew
      ? { detail: `(restore failed: ${String(restoreThrew?.message ?? restoreThrew)})` }
      : {}),
    remedy:
      `The refresh REMOVED ${n} node${n === 1 ? "" : "s"} from the live canvas: ${labelList(lost)}. ` +
      restoreOutcome +
      "The removed nodes were unsaved and are gone from the canvas: re-add them, or reload your " +
      "last saved workflow to recover everything else the canvas held. Do NOT call " +
      "panel_refresh_nodes again on this install — it pruned the live graph once and a retry has " +
      "no reason to behave differently.",
  };
}
