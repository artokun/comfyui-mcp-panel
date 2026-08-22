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
// #1455 — the SAME normalizer the save layer decides paths with. Comparing a raw
// requested name against ComfyUI's derived `filename` is a wrong-pair test: the
// frontend strips the directory and the .json/.app.json suffix, so "Foo.json" and
// "Foo" are the same workflow and must not read as a moved canvas.
// #1459 — it applies to the REQUESTED name only. The frontend's `filename` has
// already had one trailing extension removed, and stripping it again collapses
// distinct workflows onto one key (see describeWorkflowSaveTimeout).
import { baseName } from "./workflow-save.js";

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
 * the flags SAY — never what they imply about whether the write completed.
 *
 * #1455, part 1: `isModified === false` is also the state of a workflow that was
 * never dirty, so it cannot distinguish "the write landed" from "there was nothing
 * to write". The frontend's save() forces through the `isPersisted && !isModified`
 * early return, so a persisted-and-clean workflow reaches a hanging PUT with the
 * flag already false. `panel_list_workflows` reports that same flag, so it cannot
 * settle it either. The honest terminal state is "could not determine".
 *
 * #1455, part 2 — WHICH workflow the reply is about. Three cases, kept apart:
 *
 *   · `requested` given (workflow_save_as, and any named save) — that IS the
 *     destination, whatever the canvas is showing. The relocating routes call
 *     `openWorkflow(copy)` BEFORE `saveWorkflow(copy)` (workflow-save.js:1353), so
 *     the workflow active when the budget fires is normally the destination and the
 *     workflow active *before* the save is the SOURCE — which this route never
 *     writes. Naming either by position is a guess; the requested name is not.
 *   · no `requested`, and the active workflow did not move — an in-place save; the
 *     flags describe it.
 *   · no `requested`, and the active workflow moved — first-save auto-naming. Which
 *     file the hung write targets cannot be determined from here, and saying so is
 *     the answer. It is NOT the same as "unchanged", and must not collapse into it.
 */
export function describeWorkflowSaveTimeout({
  budgetMs = WORKFLOW_SAVE_COMMAND_BUDGET_MS,
  modified,
  persisted,
  filename,
  requested,
  previousActive,
} = {}) {
  const total = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : WORKFLOW_SAVE_COMMAND_BUDGET_MS;
  const seconds = Math.max(1, Math.round(total / 1000));
  const str = (v) => (typeof v === "string" && v ? v : null);
  // Directory + extension are presentation, not identity: `panel_list_workflows`
  // reports "workflows/Foo.json" and the canvas reports "Foo" for one workflow.
  //
  // #1459 — but the two sides arrive normalized to DIFFERENT degrees, so one shared
  // helper cannot key both. `requested` is the caller's raw string and may still carry
  // a directory and a ".json"/".app.json" suffix — exactly what the save layer strips
  // with baseName() before it builds the target path. `filename` has already been
  // stripped by the frontend (UserFile → getPathDetails → getFilenameDetails), so the
  // directory is the only part of it still safe to drop. Running it through baseName()
  // too strips it a SECOND time — the same double-strip workflow-save.js:650 documents
  // as unsafe: a file on disk at "…/Foo.json.json" reports filename "Foo.json", which
  // stripped again reads "Foo" and matches a requested "Foo". A genuinely different
  // workflow then passes as the destination, the "not the save's destination"
  // disclosure is suppressed, and the SOURCE's dirty/persisted flags are printed as
  // the target's.
  const dropDir = (v) => {
    const raw = String(v ?? "").trim();
    if (!raw) return "";
    const segments = raw.split(/[\\/]/);
    return (segments[segments.length - 1] ?? raw).trim();
  };
  /** Key a caller-supplied name: both the directory and the extension are presentation. */
  const requestedKey = (v) => baseName(dropDir(v));
  // What getFilenameDetails actually does, read off the shipped frontend (1.49.6) rather
  // than assumed: ONE special case for the compound ".app.json", then a cut at the LAST
  // dot. So "Foo.app.json" → "Foo", "Foo.json" → "Foo", "Foo.json.json" → "Foo.json",
  // and "My.Workflow.json" → "My.Workflow". Every one of those is already as bare as the
  // frontend can make it, which is why activeKey must not cut again.
  //
  // KNOWN AND UNCHANGED: it leaves ONE residual mismatch, in the other (safe) direction.
  // A workflow literally NAMED "Foo.app" persists at "Foo.app.json" and so reports
  // filename "Foo", while requestedKey keeps the ".app" baseName does not recognise —
  // the two do not key equal. That is identical before and after this change, and it
  // errs toward an extra "cannot say which file" disclosure rather than toward a
  // wrong-target claim, so it is left alone rather than papered over with another guess.
  /** Key a frontend-derived `filename`: drop the directory and NOTHING else. */
  const activeKey = (v) => dropDir(v);
  const dest = str(requested);
  const active = str(filename);
  const prior = str(previousActive);

  const head =
    `The tab is still live — other commands from it still answer, so this is not a backgrounded or frozen tab. ` +
    `The save may still complete in the background. `;
  const retry = `Confirm by reading the saved file itself before retrying — a re-issue may write twice.`;

  const flags = [
    modified === true ? "modified:true" : modified === false ? "modified:false" : null,
    persisted === true ? "persisted:true" : persisted === false ? "persisted:false" : null,
  ].filter(Boolean);

  // modified:true is one-directional evidence: the canvas is still dirty, so nothing
  // has been acknowledged. modified:false proves nothing in either direction.
  const verdict =
    modified === true
      ? `modified:true means the canvas has not been marked clean, so the write has not been acknowledged as landed. `
      : `These flags cannot show whether the write completed: modified:false is also the state of a workflow that was never dirty, ` +
        `and panel_list_workflows reports that same flag. Treat the outcome as UNDETERMINED. `;

  // Case 3 — the target is genuinely unknown. Never dressed up as case 2.
  // BOTH sides here are frontend-derived `filename`s, so both take activeKey.
  if (!dest && prior && active && activeKey(prior) !== activeKey(active)) {
    return (
      `workflow_save did not finish within ${seconds}s. ` +
      head +
      `The active workflow changed from "${prior}" to "${active}" while the save was in flight, and no destination name was requested, ` +
      `so which file the hung write targets cannot be determined from here. ` +
      retry
    );
  }

  // When the destination and the canvas are the SAME workflow, prefer the name the
  // frontend derived: it is the file as it actually exists. `dest` is only needed to
  // NAME a target the canvas is not showing.
  const subject = dest && active && requestedKey(dest) === activeKey(active) ? active : (dest ?? prior ?? active);
  const who = subject ? `"${subject}"` : "the active workflow";

  // Case 1 with a moved canvas: the destination is known, but the flags on screen
  // belong to some other workflow. Report the target; withhold the foreign flags.
  if (dest && active && activeKey(active) !== requestedKey(dest)) {
    return (
      `workflow_save did not finish within ${seconds}s for ${who}. ` +
      head +
      `The active workflow is "${active}", not the save's destination, so its dirty/persisted flags do not describe ${who} ` +
      `and this reply cannot say whether that write completed. ` +
      retry
    );
  }

  if (!flags.length) {
    // Nothing was read, so there is no observation to report and nothing to reason
    // from. Saying "modified:false is also the state of…" here would discuss a flag
    // this reply never saw.
    return (
      `workflow_save did not finish within ${seconds}s for ${who}. ` +
      head +
      `The tab's save flags could not be read, so the outcome is UNDETERMINED. ` +
      retry
    );
  }
  return (
    `workflow_save did not finish within ${seconds}s for ${who}. ` +
    head +
    `The same tab reports ${flags.join(" ")}. ` +
    verdict +
    retry
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
  {
    budgetMs = WORKFLOW_SAVE_COMMAND_BUDGET_MS,
    now,
    withTimeout,
    observeWorkflow,
    targetName,
    onTimeout,
    onLateSuccess,
  } = {},
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
  // #1455 — record which workflow was active BEFORE the save. This is NOT the target:
  // the relocating routes activate the copy before the write they hang on, so it is the
  // SOURCE. It is kept only to detect that the canvas moved, which is what makes an
  // un-named save's destination undeterminable.
  let priorActive = {};
  try {
    priorActive = typeof observeWorkflow === "function" ? observeWorkflow() || {} : {};
  } catch {
    priorActive = {};
  }
  let timedOut = false;
  const saveWork = Promise.resolve()
    .then(() => saveFn())
    .then(
      (result) => {
        if (timedOut) {
          try {
            onLateSuccess?.(result);
          } catch {
            // A late-success observer is bookkeeping only; never rewrite the save result.
          }
        }
        return { ok: true, result };
      },
      (error) => ({ ok: false, error }),
    );
  const settled = await withTimeout(
    saveWork,
    budget.bounded(),
    () => {
      timedOut = true;
      return WORKFLOW_SAVE_TIMEOUT;
    },
  );
  if (settled === WORKFLOW_SAVE_TIMEOUT || settled == null) {
    try {
      onTimeout?.();
    } catch {
      // A timeout observer is bookkeeping only; it must never change the save verdict.
    }
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
        // The requested name is the destination on every named route; the pre-save
        // active workflow is only evidence that the canvas moved.
        requested: targetName,
        previousActive: priorActive.filename,
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
