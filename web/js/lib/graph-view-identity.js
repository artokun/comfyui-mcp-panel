/**
 * Stable identity attached to graph read replies. A scope descriptor alone is
 * not enough: two root workflows (or two subgraphs with the same owner/title)
 * can legitimately report the same scope shape after a tab switch.
 */
export function withWorkflowUuid(viewing, rootGraph, workflowUuid) {
  // A read-only stale-tag bypass can deliberately leave rootGraph.extra carrying
  // the previous workflow's UUID. Callers that resolved the live workflow must
  // pass that canonical identity explicitly; the root fallback remains for
  // standalone callers and older integrations.
  const uuid = workflowUuid !== undefined
    ? workflowUuid
    : rootGraph?.extra?.comfyui_mcp?.workflow_uuid;
  return typeof uuid === "string" && uuid.length > 0
    ? { ...viewing, workflow_uuid: uuid }
    : viewing;
}
