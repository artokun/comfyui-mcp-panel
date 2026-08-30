// #2003 — live graph RPC must recover after a manual canvas edit.
//
// Field report: panel_graph_outline timed out three consecutive times after the
// user edited a PreviewImage widget/canvas. The tab stayed registered, so the
// orchestrator kept targeting it, and every retry produced the same 20s silence.
//
// Two panel-owned causes stacked:
//
//   1. A READ retry of an in-flight original JOINS that original (#694). The
//      orchestrator does not put timeout_ms on the frame, so awaitDuplicateReply
//      waits unbounded. A hung graph_outline then pins every retry_of forever —
//      "stays timed out". Mutations must still join (#517: double-apply). Reads
//      cannot double-apply, so a hung read must not pin the next one.
//
//   2. Recovery after that silence has to name a CANVAS rebind, not a session
//      retarget. panel_set_workflow_target does not restore the live graph
//      (same rule as graphBindingRefusalMessage). panel_open_workflow does.
//
// Pure (no DOM, no sockets) so the join rule and the recovery sentence stay
// unit-testable with plain values.

import { graphCommandMayMutateWorkflow } from "./graph-binding.js";

/** Public recovery named when a live graph read cannot finish. Not a session retarget. */
export const GRAPH_RPC_REBIND_ACTION = "panel_open_workflow";

/**
 * Should this delivery wait for an already-running same command?
 *
 * Settled replies always join (idempotent, and the ledger exists to return them).
 * An IN-FLIGHT mutation must join so a timeout-plus-retry cannot land twice.
 * An in-flight READ must NOT: waiting is how graph_outline stays silent after
 * a canvas edit that made the original hang (#2003).
 *
 * `priorInFlight` is a POSITIVE signal. Anything else (settled object, missing,
 * unreadable) keeps today's join path.
 */
export function shouldJoinInFlightGraphReply({ cmd, priorInFlight } = {}) {
  if (priorInFlight !== true) return true;
  return graphCommandMayMutateWorkflow(cmd);
}

/** True when `prior` is the ledger's in-flight thenable, not a settled reply. */
export function ledgerReplyIsInFlight(prior) {
  return prior != null && typeof prior.then === "function";
}

/**
 * Agent-facing recovery when a live graph read did not finish. Names the action
 * that rebinds the canvas in place; explicitly not a browser refresh, and
 * explicitly not panel_set_workflow_target.
 */
export function graphRpcTimeoutRecovery({ cmd } = {}) {
  const name = typeof cmd === "string" && cmd.trim() ? cmd.trim() : "graph_outline";
  return (
    `The live graph did not finish "${name}" in time after a canvas change, so this ` +
    `reply is a recovery rather than a graph read. The tab is still connected. Rebind ` +
    `the live canvas with ${GRAPH_RPC_REBIND_ACTION} on the active workflow (no browser ` +
    `refresh), then retry the read. panel_set_workflow_target is NOT a remedy — it ` +
    `re-points the session, it does not rebind the canvas.`
  );
}
