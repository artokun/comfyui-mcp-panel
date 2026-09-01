/**
 * #2158 — `panel_open_workflow` failed with a bare `NetworkError when attempting to
 * fetch resource.` and nothing else. No route, no classification, no statement of what
 * the failed switch left behind.
 *
 * ## What actually threw, read out of the frontend rather than guessed
 *
 * The panel's open executor calls the workflow STORE's `openWorkflow(target)`:
 *
 *     openWorkflow = async (workflow) => {
 *       if (isActive(workflow)) return workflow
 *       if (!openWorkflowPaths.value.includes(workflow.path))
 *         openWorkflowPaths.value.push(workflow.path)   // <-- store mutated HERE
 *       const loadedWorkflow = await workflow.load()    // <-- throws HERE
 *       activeWorkflow.value = loadedWorkflow           // <-- not reached
 *       comfyApp.canvas.bg_tint = loadedWorkflow.tintCanvasBg
 *       ...
 *     }
 *
 * `workflow.load()` bottoms out in `UserFile.load()`, which sets `isLoading = true` and
 * then `await api.getUserData(this.path)` — a plain `GET /userdata/<encoded path>`. On a
 * transport failure that fetch THROWS rather than returning a non-200, so the browser's
 * own string is what propagates: Firefox says `NetworkError when attempting to fetch
 * resource.`, Chrome `Failed to fetch`, Safari `Load failed`.
 *
 * Confirmed against BOTH the 1.47.2 source and the shipped 1.51.9 minified bundle, which
 * bracket the 1.49.6 the report came from.
 *
 * ## The two things the executor was getting wrong
 *
 * 1. It rethrew the browser's message verbatim. The panel already owns a classifier for
 *    exactly this failure class — `manager-fetch-failure.js`, built for comfyui-mcp#1472
 *    when `panel_install_node` failed the same bare way, whose table already carries
 *    Firefox's wording. It was simply never wired to the open path. This module reuses
 *    that classifier rather than growing a second copy of the table, so a browser whose
 *    wording is added there is understood here too.
 *
 * 2. It journaled `applied: false` and commented "nothing was applied". That is an
 *    ASSERTION, not a measurement, and `applied` is the load-bearing #402 field: the
 *    orchestrator turns `false` into "confirmed not applied by the panel's
 *    request-id-correlated receipt. It is safe to retry."
 *
 *    For the REPORTED failure that advice happens to be right — the call that threw is a
 *    GET, so nothing was written server-side and a retry is genuinely safe. But it is
 *    right by accident. The same catch also covers a throw from AFTER the pointer moved
 *    (`activeWorkflow.value` is assigned, then `comfyApp.canvas.bg_tint` is written, and
 *    a null canvas there throws). In that configuration the panel would tell the caller
 *    "confirmed not applied" while the active workflow HAS become the target — the
 *    wrong-graph hazard #968/#1111 exist to prevent, wearing the strongest phrasing in
 *    the vocabulary.
 *
 * So the verdict here is MEASURED. Where the panel can see that the active workflow is
 * still the one it started on, `false` stays `false` and the caller keeps the accurate
 * "safe to retry". Where the pointer moved, or where the panel could not observe it at
 * all, the answer degrades to `"unknown"` and the orchestrator tells the caller to
 * inspect before retrying. Both directions are strictly better than asserting.
 *
 * ## Why the tab residue is reported but does NOT change the verdict
 *
 * The push into `openWorkflowPaths` happens before the read, so a failed switch leaves
 * the target listed among the open tabs with no content behind it (`openWorkflows` is a
 * computed over that same array). That is a real, user-visible side effect and the
 * caller should be told about it — but it is not a reason to downgrade `applied`.
 * Downgrading would replace "safe to retry" with "inspect first" on the exact case this
 * issue is about, which is the caller's situation getting worse, not better. It belongs
 * in the prose, and that is where it goes.
 */

import { isTransportFailure } from "./manager-fetch-failure.js";

/** The route the frontend reads a saved workflow's bytes from. */
export const WORKFLOW_CONTENT_ROUTE = "/userdata/<workflow path>";

function messageOf(err) {
  return (err instanceof Error ? err.message : String(err ?? "")).trim();
}

/** A tri-state observation: `true`, `false`, or `null` when it could not be observed. */
function triState(v) {
  return v === true ? true : v === false ? false : null;
}

/**
 * Classify a throw out of the store's `openWorkflow`, from what the panel MEASURED.
 *
 * Every observation is tri-state, and `null` means "not observable" — never "no". The
 * whole point of this module is that an unmeasured negative is what shipped the bug.
 *
 *   `activeIsTarget`  the active workflow IS the requested one now.
 *   `activeIsSource`  the active workflow is still the one active when the open started.
 *   `tabAppeared`     the target is listed among the open tabs and was not before.
 *   `contentLoaded`   the target's content is loaded now and was not before.
 */
export function classifyOpenSwitchFailure({
  err = null,
  activeIsTarget = null,
  activeIsSource = null,
  tabAppeared = null,
  contentLoaded = null,
} = {}) {
  const transport =
    isTransportFailure(err) ||
    (err && typeof err === "object" ? isTransportFailure(err.cause) : false);

  const target = triState(activeIsTarget);
  const source = triState(activeIsSource);

  const residue = [];
  if (target === true) residue.push("active_pointer_moved_to_target");
  if (triState(contentLoaded) === true) residue.push("workflow_content_loaded");
  if (triState(tabAppeared) === true) residue.push("tab_listed_without_content");

  // ONLY a positive observation that the pointer never left the source licenses the
  // hard negative. Anything else — it moved, it moved somewhere third, or it could not
  // be read — is `"unknown"`.
  const applied = target !== true && source === true ? false : "unknown";

  return { transport, applied, residue, activeIsTarget: target, activeIsSource: source };
}

/**
 * What to say when the native workflow switch threw.
 *
 * `path` is the selector the caller asked for. `sourceLabel` names the workflow that was
 * active when the open started, when the panel knows it.
 */
export function openSwitchFailureMessage({
  path = null,
  err = null,
  activeIsTarget = null,
  activeIsSource = null,
  tabAppeared = null,
  contentLoaded = null,
  sourceLabel = null,
} = {}) {
  const verdict = classifyOpenSwitchFailure({
    err,
    activeIsTarget,
    activeIsSource,
    tabAppeared,
    contentLoaded,
  });
  const raw = messageOf(err) || "no message";
  const want = path ? `"${path}"` : "the requested workflow";
  const parts = [];

  if (verdict.transport) {
    parts.push(
      `panel_open_workflow could not switch to ${want}: the frontend's read of the workflow ` +
        `file did not complete. ${raw}. This is a TRANSPORT failure on the workflow-content ` +
        `route (GET ${WORKFLOW_CONTENT_ROUTE}) — no usable response reached the browser, so ` +
        `there is no HTTP status or response body to report (#2158). Likely causes are ComfyUI ` +
        `having stopped or restarted, the tab having lost its connection, or a proxy in front ` +
        `of /userdata.`,
    );
  } else {
    // Never relabel an error whose shape is not recognised — same rule as #1472. Keep
    // what it actually said, and add only the route it was attempted against.
    parts.push(
      `panel_open_workflow could not switch to ${want}: the native workflow switch failed ` +
        `while reading the workflow file (GET ${WORKFLOW_CONTENT_ROUTE}). ${raw}.`,
    );
  }

  // The measured half. Stated as an observation with its own provenance, so a reader can
  // tell it apart from the inference that used to stand here.
  if (verdict.activeIsTarget === true) {
    parts.push(
      `MEASURED, NOT ASSUMED: the active workflow IS now ${want} even though the switch ` +
        `reported failure — the store moved the pointer and then threw. Do NOT treat the ` +
        `canvas as the previous workflow's. Re-read the graph before issuing any further ` +
        `command, because commands are answered against whatever is active now.`,
    );
  } else if (verdict.activeIsSource === true) {
    parts.push(
      `MEASURED, NOT ASSUMED: the active workflow is still ` +
        `${sourceLabel ? `"${sourceLabel}"` : "the one that was active before this command"} — ` +
        `the switch did not happen.` +
        (verdict.transport
          ? ` The call that failed is a READ of the workflow file and writes nothing on the ` +
            `server, so re-issuing panel_open_workflow is safe once ComfyUI is reachable again.`
          : ""),
    );
  } else {
    parts.push(
      `The panel could NOT observe which workflow is active after the failure, so it does not ` +
        `claim the switch did or did not happen. Read the active workflow before deciding ` +
        `whether to retry.`,
    );
  }

  if (verdict.residue.includes("tab_listed_without_content")) {
    parts.push(
      `SIDE EFFECT the store applied before it threw: ${want} is now listed among the open ` +
        `workflow tabs even though its content never loaded — the store appends the path to ` +
        `its open-tab list BEFORE it reads the file. This does not have to be cleaned up ` +
        `first: the panel decides "was this tab already open" from loaded content, not from ` +
        `tab membership, so the next open reads the file normally. Close the tab if you do ` +
        `not want it.`,
    );
  }

  return parts.join(" ");
}
