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

// A graph-local node id (including a subgraph wrapper id) is not a graph
// identity. Keep an opaque, object-keyed token for each live graph object so a
// read from graph A cannot authorize the same numeric ids after the canvas
// navigates to graph B. WeakMap lifetime deliberately follows the live graph
// object: a rebuild/reconnect produces a new token and therefore fails closed.
const graphViewIdentities = new WeakMap();
let nextGraphViewIdentity = 0;

function newGraphViewIdentity() {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === "function") {
    return `graph:${cryptoObject.randomUUID()}`;
  }
  nextGraphViewIdentity += 1;
  return `graph:local-${nextGraphViewIdentity}`;
}

/** Return the stable identity for this live graph object, or null when the
 * caller did not provide an object that can be keyed by identity. */
export function graphViewIdentityFor(graph) {
  if (!graph || typeof graph !== "object") return null;
  let identity = graphViewIdentities.get(graph);
  if (!identity) {
    identity = newGraphViewIdentity();
    graphViewIdentities.set(graph, identity);
  }
  return identity;
}

/** Attach the live graph-object identity to a structured graph read reply. */
export function withGraphViewIdentity(viewing, graph) {
  const identity = graphViewIdentityFor(graph);
  return identity ? { ...viewing, graph_identity: identity } : viewing;
}
