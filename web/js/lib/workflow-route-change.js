/**
 * #1261 — a rename must not read as a workflow SWITCH.
 *
 * ComfyUI renames (or Save-As-es) a saved workflow by mutating the SAME workflow
 * object's path in place: the instance identity survives, and only the derived
 * route id moves `wf:<old path>` -> `wf:<new path>`. A genuine tab switch always
 * arrives on a DIFFERENT object. So "same live object, wf: -> wf: id change" can
 * only be a rename, and callers may keep every instance-anchored continuity claim
 * (the canvas, the conversation, the agent's remembered node ids) while updating
 * the route.
 *
 * The discriminator is the object, never the path text: two tabs can legitimately
 * show the same file, and a path comparison cannot tell "this tab's file moved"
 * from "the user switched to another tab on a different file".
 *
 * Pure + side-effect-free so the decision is unit-testable in isolation; callers
 * supply the object comparison and both route ids.
 *
 * @param {{sameWorkflowObject?: boolean, previousRouteId?: unknown, newRouteId?: unknown}} input
 * @returns {boolean}
 */
export function isSameInstanceRename({ sameWorkflowObject, previousRouteId, newRouteId } = {}) {
  if (sameWorkflowObject !== true) return false;
  if (typeof previousRouteId !== "string" || !previousRouteId.startsWith("wf:")) return false;
  return typeof newRouteId === "string" && newRouteId.startsWith("wf:");
}
