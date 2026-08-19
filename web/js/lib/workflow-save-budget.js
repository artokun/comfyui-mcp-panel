// #1434 — ONE deadline for panel_save_workflow, so a hung userdata write cannot
// silence the tab.
//
// Field report: panel_save_workflow delivered workflow_save to the pinned tab and
// got no acknowledgement for 15,000 ms (the orchestrator's ctx.call budget in
// comfyui-mcp panel-tools.ts). panel_graph_outline and panel_list_workflows from
// the SAME tab answered immediately afterward, and panel_list_workflows still showed
// persisted:true / modified:true. The tab was not backgrounded or frozen — the
// save path's /userdata HEAD, GET and PUT are unbounded, and a server that
// accepts those and never answers parks the reply for the whole browser timeout.
// The retry_of token then waited on that same in-flight promise and timed out
// identically.
//
// The dispatch already replies on throw. What it cannot do is reply while the
// save promise is still pending. This module bounds that wait: the save is not
// cancelled (withTimeout never cancels), the ledger settles with a worded
// refusal that reports the live dirty/modified observation, and a later retry
// is not left hanging on the original.
//
// 13,000 ms, against the 15,000 ms relay window, for the same 2 s reply slack
// get_errors uses against its 20 s read timeout. Not derived from the relay
// constant, because that constant lives in the OTHER repo.

import { makeCommandBudget } from "./command-budget.js";

/** Whole-command deadline `workflow_save` / `workflow_save_as` take. */
export const WORKFLOW_SAVE_COMMAND_BUDGET_MS = 13000;

/** Sentinel withTimeout yields when the save has not settled. Frozen so identity holds. */
export const WORKFLOW_SAVE_TIMEOUT = Object.freeze({ timeout: true });

/**
 * Snapshot the dirty/persisted flags a timeout reply can still observe.
 * Getters that throw are omitted rather than failing the timeout path itself.
 */
export function workflowSaveTimeoutObservation(wf) {
  if (!wf || typeof wf !== "object") return {};
  const observed = {};
  try {
    if (wf.isModified === true || wf.isModified === false) observed.modified = wf.isModified;
  } catch {
    /* omit */
  }
  try {
    if (wf.isPersisted === true || wf.isPersisted === false) observed.persisted = wf.isPersisted;
  } catch {
    /* omit */
  }
  try {
    if (typeof wf.filename === "string" && wf.filename) observed.filename = wf.filename;
  } catch {
    /* omit */
  }
  return observed;
}

/**
 * The refusal a timed-out save throws. States that the tab is still live and what
 * the flags SAY — never what they imply about whether the write landed.
 *
 * #1455: `isModified === false` is also the state of a workflow that was never
 * dirty, so it cannot distinguish "the write landed" from "there was nothing to
 * write". The frontend's save() forces through the `isPersisted && !isModified`
 * early return, so a persisted-and-clean workflow reaches a hanging PUT with the
 * flag already false. `panel_list_workflows` reports that same flag, so it cannot
 * settle it either. The honest terminal state is "could not determine".
 *
 * `subject` is the workflow the save TARGETED, captured before the save ran; the
 * /userdata HEAD probe can hang before any Save-As swap, so the workflow that is
 * active when the budget fires is not necessarily the one being saved.
 */
export function describeWorkflowSaveTimeout({
  budgetMs = WORKFLOW_SAVE_COMMAND_BUDGET_MS,
  modified,
  persisted,
  filename,
  subject,
  subjectChanged = false,
} = {}) {
  const total = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : WORKFLOW_SAVE_COMMAND_BUDGET_MS;
  const seconds = Math.max(1, Math.round(total / 1000));
  // A direct caller may pass only `filename` (the pre-#1455 shape); fall back to it so
  // the reply still names the workflow rather than degrading to "the active workflow".
  const subjectName = typeof subject === "string" && subject ? subject : filename;
  const target = typeof subjectName === "string" && subjectName ? `"${subjectName}"` : "the active workflow";
  const nowActive = typeof filename === "string" && filename ? `"${filename}"` : "a different workflow";

  // The active workflow moved during the budget, so the flags below describe some
  // OTHER workflow. Reporting them against the target would be a wrong-target claim.
  if (subjectChanged) {
    return (
      `workflow_save did not finish within ${seconds}s for ${target}. ` +
      `The tab is still live — other commands from it still answer, so this is not a backgrounded or frozen tab. ` +
      `The save may still complete in the background. The active workflow changed to ${nowActive} while the save was in flight, ` +
      `so no dirty/persisted flag currently describes ${target} and this reply cannot say whether its write completed. ` +
      `Confirm by reading the saved file itself before retrying — a re-issue may write twice.`
    );
  }

  const flags = [
    modified === true ? "modified:true" : modified === false ? "modified:false" : null,
    persisted === true ? "persisted:true" : persisted === false ? "persisted:false" : null,
  ].filter(Boolean);
  const reads = flags.length ? `The same tab reports ${flags.join(" ")}. ` : "The tab's save flags could not be read. ";

  // modified:true is one-directional evidence: the canvas is still dirty, so nothing
  // has been acknowledged. modified:false proves nothing in either direction.
  const verdict =
    modified === true
      ? `modified:true means the canvas has not been marked clean, so the write has not been acknowledged as landed. `
      : `These flags cannot show whether the write completed: modified:false is also the state of a workflow that was never dirty, ` +
        `and panel_list_workflows reports that same flag. Treat the outcome as UNDETERMINED. `;

  return (
    `workflow_save did not finish within ${seconds}s for ${target}. ` +
    `The tab is still live — other commands from it still answer, so this is not a backgrounded or frozen tab. ` +
    `The save may still complete in the background. ` +
    reads +
    verdict +
    `Confirm by reading the saved file itself before retrying — a re-issue may write twice.`
  );
}

/**
 * Run `saveFn` under the command budget. Always settles.
 *
 *   - save fulfills → its result
 *   - save rejects  → that error (the actual save exception, never rewritten as a timeout)
 *   - save hangs    → describeWorkflowSaveTimeout using observeWorkflow() at fire time
 *
 * `withTimeout` maps a rejection onto its fallback, so the save is converted to a
 * `{ok, result|error}` envelope BEFORE it is bounded — otherwise a real save failure
 * would be reported as a hang.
 */
export async function runBoundedWorkflowSave(
  saveFn,
  { budgetMs = WORKFLOW_SAVE_COMMAND_BUDGET_MS, now, withTimeout, observeWorkflow } = {},
) {
  if (typeof saveFn !== "function") {
    throw new Error("runBoundedWorkflowSave requires a save function");
  }
  if (typeof withTimeout !== "function") {
    throw new Error(
      "runBoundedWorkflowSave requires withTimeout — refusing to run an unbounded save (issue #1434)",
    );
  }
  const budget = makeCommandBudget(budgetMs, now);
  // #1455 — capture the save's TARGET before it runs. The /userdata HEAD probe can
  // hang before any Save-As swap, so the workflow active when the budget fires is not
  // necessarily the one being saved; naming that one blames the wrong file.
  let target = {};
  try {
    target = typeof observeWorkflow === "function" ? observeWorkflow() || {} : {};
  } catch {
    target = {};
  }
  const settled = await withTimeout(
    Promise.resolve()
      .then(() => saveFn())
      .then(
        (result) => ({ ok: true, result }),
        (error) => ({ ok: false, error }),
      ),
    budget.bounded(),
    () => WORKFLOW_SAVE_TIMEOUT,
  );
  if (settled === WORKFLOW_SAVE_TIMEOUT || settled == null) {
    let observed = {};
    try {
      observed = typeof observeWorkflow === "function" ? observeWorkflow() || {} : {};
    } catch {
      observed = {};
    }
    // Same workflow => its flags describe the target. Different (or unreadable)
    // => they describe something else, and the reply must not attribute them.
    const subject = typeof target.filename === "string" && target.filename ? target.filename : observed.filename;
    const subjectChanged =
      typeof subject === "string" &&
      subject !== "" &&
      typeof observed.filename === "string" &&
      observed.filename !== "" &&
      observed.filename !== subject;
    throw new Error(
      describeWorkflowSaveTimeout({
        budgetMs: budget.totalMs,
        modified: observed.modified,
        persisted: observed.persisted,
        filename: observed.filename,
        subject,
        subjectChanged,
      }),
    );
  }
  if (settled.ok !== true) {
    if (settled.error instanceof Error) throw settled.error;
    throw new Error(
      settled.error == null ? "workflow_save failed" : String(settled.error),
    );
  }
  return settled.result;
}
