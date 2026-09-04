/**
 * #2249 — the workflow-switch token must not latch recovery after a delivered open.
 *
 * `activeWorkflowReloadGuard` is a critical section so a graph command cannot land
 * mid-switch and be overwritten or re-baselined as CLEAN (#442). A step in flight
 * is deliberately immune to the 30s age-out. That immunity is what latches
 * `workflow_list` / `graph_outline` / `panel_set_workflow_target({mode:"current"})`
 * for minutes after MCP has already acked `workflow_open` delivery, while a later
 * settle or safe-repaint is still pending (#1264 recurrence).
 *
 * Dispatch and ownership are different questions. The open keeps the token for its
 * own remaining steps (abort a late load). Dispatch must not refuse the recovery
 * probe, and must unlatch once the correlated open receipt is applied and the
 * frontend already names that workflow. Leftover previous-tab graph is
 * `switchRepaintUnproven`'s job (#1215), not this token.
 *
 * Dependency-free so unit tests drive the shipped predicate.
 */

import { commandIsCanvasTargetless } from "./workflow-chat-identity.js";

function nonEmptyString(value) {
  return typeof value === "string" && value ? value : null;
}

/**
 * Does the frontend's live active workflow already name the workflow a correlated
 * `applied:true` open receipt resolved to?
 *
 * Path and routing key only — filename is shared by every unsaved tab (#186) and
 * must not unlatch a switch onto a different instance.
 */
export function frontendActiveMatchesAppliedOpen({
  receipt,
  activePath = null,
  activeRoutingKey = null,
} = {}) {
  if (!receipt || receipt.applied !== true) return false;
  const resolved = receipt.resolved && typeof receipt.resolved === "object" ? receipt.resolved : {};
  const want = [
    nonEmptyString(resolved.routing_key ?? resolved.routingKey),
    nonEmptyString(resolved.path),
    nonEmptyString(receipt.requested),
  ].filter(Boolean);
  const have = [nonEmptyString(activeRoutingKey), nonEmptyString(activePath)].filter(Boolean);
  if (!want.length || !have.length) return false;
  return have.some((id) => want.includes(id));
}

/**
 * Should dispatch refuse this command because the switch/reload section is held?
 *
 * `workflow_list` (and other canvas-targetless commands) are exempt the same way
 * they are exempt from the instance fence: the list is the recovery probe, and
 * fencing it makes the repair require the thing it repairs.
 *
 * When `openReceiptApplied` and the frontend already reports that workflow, later
 * settle/repaint must not keep refusing `graph_outline`. A receipt for a different
 * workflow, or an unapplied one, stays fail-closed.
 */
export function switchFenceRefusesCommand({
  cmd,
  guard,
  openReceiptApplied = false,
  frontendActiveMatchesAppliedOpen: activeMatchesAppliedOpen = false,
} = {}) {
  if (commandIsCanvasTargetless(cmd)) return false;
  if (!guard) return false;
  if (openReceiptApplied === true && activeMatchesAppliedOpen === true) return false;
  return true;
}
