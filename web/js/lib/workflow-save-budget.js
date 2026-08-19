// #1434 — ONE deadline for panel_save_workflow, so a hung userdata write cannot
// silence the tab.
//
// Field report: panel_save_workflow delivered workflow_save to the pinned tab and
// got no acknowledgement for 15,000 ms (the orchestrator's ctx.call budget in
// comfyui-mcp panel-tools.ts). panel_graph_outline and panel_list_workflows from
// the SAME tab answered immediately afterward, and list_workflows still showed
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
 * The refusal a timed-out save throws. States that the tab is still live, what
 * the dirty flag currently says, and that the write may still land — never
 * "backgrounded or frozen", which is the orchestrator's guess this report
 * disproved.
 */
export function describeWorkflowSaveTimeout({
  budgetMs = WORKFLOW_SAVE_COMMAND_BUDGET_MS,
  modified,
  persisted,
  filename,
} = {}) {
  const total = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : WORKFLOW_SAVE_COMMAND_BUDGET_MS;
  const seconds = Math.max(1, Math.round(total / 1000));
  const who = typeof filename === "string" && filename ? `"${filename}"` : "the active workflow";
  const dirty =
    modified === true
      ? "still reports modified:true — the canvas has not been marked clean, so the write has not been acknowledged as landed"
      : modified === false
        ? "now reports modified:false — the write may have landed after this deadline; confirm with panel_list_workflows"
        : "its modified flag could not be read";
  const persist =
    persisted === true ? " persisted:true." : persisted === false ? " persisted:false." : "";
  return (
    `workflow_save did not finish within ${seconds}s for ${who}. ` +
    `The tab is still live — other commands from it still answer, so this is not a backgrounded or frozen tab. ` +
    `The save may still complete in the background. The same tab ${dirty}.${persist} ` +
    `Check panel_list_workflows before retrying: if modified is false the write landed; ` +
    `if it stays true the save is still in flight or failed. Do not re-issue until you have seen that observation.`
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
    throw new Error(
      describeWorkflowSaveTimeout({
        budgetMs: budget.totalMs,
        modified: observed.modified,
        persisted: observed.persisted,
        filename: observed.filename,
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
