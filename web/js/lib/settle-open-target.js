/**
 * #1575 — after ComfyUI's store-level `openWorkflow` resolves, make sure the panel
 * is holding a LOADED workflow object for the workflow the caller asked for.
 *
 * THE REPORT. `panel_open_workflow` on a saved workflow whose tab had just been
 * closed with `panel_close_workflow` came back with
 *
 *   "workflow_open could not rebind the active canvas because this frontend did
 *    not expose a complete workflow state for a safe repaint."
 *
 * — an unknown partial outcome, and `panel_list_workflows` showing an
 * inconsistent active/open state.
 *
 * THE CAUSE, measured in a browser against a live ComfyUI (frontend source read
 * at 1.47.2; probe run against the installed frontend on 2026-08-21).
 *
 * `app.extensionManager.workflow` is the workflow STORE, not the workflow
 * service — `workspaceStore` binds it as `computed(() => useWorkflowStore())`.
 * The panel therefore calls the store's two primitives, and they do not pair up
 * the way the service's do:
 *
 *   store.closeWorkflow(wf)  removes the path from `openWorkflowPaths` and calls
 *                            `wf.unload()` (which nulls `changeTracker`), and
 *                            LEAVES `activeWorkflow` pointing at wf. Moving the
 *                            pointer is the SERVICE's job, and the service is a
 *                            Vue composable the panel cannot reach.
 *
 *   store.openWorkflow(wf)   begins `if (isActive(workflow)) return workflow`,
 *                            and `isActive` compares `activeWorkflow.path` to
 *                            `workflow.path` — BY PATH, not by identity.
 *
 * So after a panel-driven close of the active tab the store is left in a state
 * its own types forbid — `activeWorkflow` is a `LoadedComfyWorkflow` whose
 * `changeTracker` is null, and whose path is not in the open list — and the next
 * `openWorkflow` for that path early-returns on the stale pointer. Nothing is
 * loaded, the path is never pushed back into `openWorkflowPaths`, and the await
 * resolves as though the open had succeeded.
 *
 * MEASURED, in that order, on the real frontend:
 *
 *   after store.closeWorkflow   activeIsSameObject:true  hasTracker:false  inOpenList:false
 *   after store.openWorkflow    activeIsSameObject:true  hasTracker:false  inOpenList:false
 *   panel repaint-state read    changeTracker?.activeState ?? activeState  ===  null
 *
 * `null` is exactly what makes `workflow_open` refuse — and the refusal blames
 * the FRONTEND for not exposing a complete state, which is untrue: the state is
 * one `load()` away, on the very object the panel is already holding.
 *
 * WHY THE PATCH IN THE ISSUE DOES NOT FIX IT. It proposed re-reading
 * `activeWorkflowRef()` after the open and adopting it when it matches the
 * selector, on the theory that the frontend had replaced the catalog entry with
 * a new live tab object. It does not: `ComfyWorkflow.load()` returns `this`, and
 * the probe shows `activeWorkflow` IS the object the panel already held
 * (`activeIsSameObject: true`), so that adoption is a no-op and the open still
 * refuses. The adopt arm is kept here anyway — it is cheap, and it is the right
 * repair IF a frontend ever does hand back a different instance. It is simply not
 * the arm that fixes the reported bug.
 *
 * WHAT THIS DOES, only when the open left us with NO usable state:
 *
 *   1. ADOPT — a DIFFERENT live object is active for the requested selector and
 *      it has a complete state. Take it.
 *   2. LOAD  — the frontend still names our target as active by the same rule its
 *      own `openWorkflow` used to early-return (path equality), yet it is
 *      unloaded. That combination is the store contradicting itself, so load the
 *      content the early return skipped, then put the tab back in the open list.
 *
 * The open-list repair goes through `openWorkflowsInBackground`, the store's own
 * "add paths without loading them or changing the active workflow" entry point.
 * It is the missing half of the early-returned open, and it is what clears the
 * inconsistent active/open state the report also named.
 *
 * NON-REGRESSION, by construction: an open that already produced a complete state
 * returns at `reason: "loaded"` before anything is touched. Every open that works
 * today takes that exit.
 *
 * ORDER: load FIRST, re-list the tab only once the load succeeded, so a repair
 * that fails leaves the store exactly as it was found.
 *
 * Best-effort throughout. Nothing here may turn a working open into a throw; on
 * any failure the caller keeps the object it had and the pre-existing refusal
 * stands unchanged. Callers inject the collaborators so the decision is
 * unit-testable without a DOM.
 */

/** The state `workflow_open` repaints FROM. Mirrors the call site's `st` read,
 *  which accepts both the tracker-owned and the flat shape (#721). */
export function workflowRepaintState(wf) {
  return wf?.changeTracker?.activeState ?? wf?.activeState;
}

/** Is that state complete enough to repaint from? The call site's
 *  `!st || !Array.isArray(st.nodes)` refusal, inverted. */
export function hasCompleteRepaintState(wf) {
  const st = workflowRepaintState(wf);
  return !!st && typeof st === "object" && Array.isArray(st.nodes);
}

/** The frontend's OWN activity test, which is what decided the early return:
 *  `activeWorkflow.path === workflow.path`. Object identity counts too, because a
 *  proxy/raw pair is one tab and `sameWorkflowObject` is the panel's proxy-safe
 *  answer to that (#558 r2). */
function frontendConsidersActive(active, target, sameWorkflowObject) {
  if (!active || typeof active !== "object" || !target) return false;
  try {
    if (typeof sameWorkflowObject === "function" && sameWorkflowObject(active, target)) return true;
  } catch {
    // A throwing identity oracle must not decide this; fall through to the path test.
  }
  return typeof active.path === "string" && !!active.path && active.path === target.path;
}

/**
 * @param {{
 *   wasOpen?: boolean,
 *   target?: object | null,
 *   selector?: string,
 *   activeAfterOpen?: object | null,
 *   readOpenWorkflows?: () => unknown[],
 *   sameWorkflowObject?: (a: unknown, b: unknown) => boolean,
 *   matchesSelector?: (wf: object, sel: string) => boolean,
 *   loadWorkflowContent?: (wf: object) => unknown,
 *   reopenTabInBackground?: (path: string) => unknown,
 * }} [input]
 * @returns {Promise<{ target: object | null, adopted: boolean, loaded: boolean,
 *   reopened: boolean, reason: string }>}
 */
export async function settleOpenedWorkflowTarget({
  wasOpen,
  target,
  selector,
  activeAfterOpen,
  readOpenWorkflows,
  sameWorkflowObject,
  matchesSelector,
  loadWorkflowContent,
  reopenTabInBackground,
} = {}) {
  const keep = (reason) => ({ target, adopted: false, loaded: false, reopened: false, reason });
  try {
    if (!target || typeof target !== "object") return keep("no-target");
    // An already-loaded tab cannot be in this state: `wasOpen` IS
    // `!!target.changeTracker`, and the store's early return only ever strands an
    // UNLOADED workflow. Leaving the already-open path untouched also keeps the
    // #442 disk-staleness comparison reading the object it baselined.
    if (wasOpen) return keep("already-open");
    // THE NON-REGRESSION EXIT. Every open that works today lands here.
    if (hasCompleteRepaintState(target)) return keep("loaded");

    // 1. ADOPT — a different live object answers for this selector and has state.
    if (activeAfterOpen && typeof activeAfterOpen === "object" && hasCompleteRepaintState(activeAfterOpen)) {
      let sameObject;
      try {
        sameObject =
          typeof sameWorkflowObject === "function"
            ? sameWorkflowObject(activeAfterOpen, target)
            : activeAfterOpen === target;
      } catch {
        sameObject = activeAfterOpen === target;
      }
      let selectorOk = false;
      try {
        selectorOk =
          typeof matchesSelector === "function" && typeof selector === "string" && !!selector
            ? !!matchesSelector(activeAfterOpen, selector)
            : false;
      } catch {
        // An unreadable selector answer is NOT a match: adopting the active
        // workflow without proving it is the requested one would repaint, stamp
        // and report under someone else's tab.
        selectorOk = false;
      }
      // …and it must be the SAME WORKFLOW FILE, not merely something the selector
      // answers to. `workflowRecordMatchesSelector` accepts a bare filename, and two
      // workflows in different directories can share one — so on a path where the
      // store's open failed for a reason OTHER than the early return, the active tab
      // could be a DIFFERENT workflow that answers the same bare name. Adopting it
      // would repaint it, stamp this command's uuid onto it, and report success under
      // its identity: the #1089 hazard, manufactured by the repair. This arm exists for
      // "a different OBJECT for the same workflow", so requiring the path to agree costs
      // it nothing, and falling through leaves today's refusal rather than a wrong tab.
      const samePath =
        typeof activeAfterOpen.path === "string" &&
        !!activeAfterOpen.path &&
        activeAfterOpen.path === target.path;
      if (!sameObject && selectorOk && samePath) {
        return {
          target: activeAfterOpen,
          adopted: true,
          loaded: false,
          reopened: false,
          reason: "adopted-live-object",
        };
      }
    }

    // 2. LOAD — the store early-returned on a stale active pointer.
    if (!frontendConsidersActive(activeAfterOpen, target, sameWorkflowObject)) {
      return keep("not-active-after-open");
    }
    if (typeof loadWorkflowContent !== "function") return keep("load-unavailable");
    try {
      await loadWorkflowContent(target);
    } catch (err) {
      return keep(`load-failed: ${err?.message ?? err}`);
    }
    if (!hasCompleteRepaintState(target)) return keep("load-produced-no-state");

    // The other half of the early-returned open: the tab itself. Best-effort, and
    // strictly after the load, so a failure here leaves a loaded tab rather than
    // an empty one.
    //
    // `reopened` is an OBSERVATION of the open list, never "the call did not throw"
    // (review, P1). The call site reaches `openWorkflowsInBackground` through a
    // capability-guarded lambda, so on a frontend that lacks it the call returns
    // `undefined` silently — and inferring success from the absence of an exception
    // made "this store has no such API" and "the tab was restored" the same value.
    // The reply then asserted it had restored the tab AND suppressed the disclosure
    // saying it could not, which is the inconsistent active/open state this fix
    // exists to repair being reported as repaired while untouched.
    const path = typeof target.path === "string" ? target.path : "";
    const listedNow = () => {
      if (typeof readOpenWorkflows !== "function" || !path) return false;
      try {
        const list = readOpenWorkflows();
        return Array.isArray(list) && list.some((w) => w?.path === path);
      } catch {
        return false;
      }
    };
    const alreadyListed = listedNow();
    if (path && !alreadyListed && typeof reopenTabInBackground === "function") {
      try {
        reopenTabInBackground(path);
      } catch {
        // A tab that is active but absent from the open list is recoverable, and is
        // disclosed on the reply; failing the whole open over it would not be.
      }
    }
    return {
      target,
      adopted: false,
      loaded: true,
      // Re-read, so this reports what the store DID, not what it was asked to do.
      reopened: alreadyListed || listedNow(),
      reason: "loaded-after-noop-open",
    };
  } catch (err) {
    return keep(`failed: ${err?.message ?? err}`);
  }
}
