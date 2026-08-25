/**
 * artokun/comfyui-mcp#1425 — how a node id from the tools becomes a LiteGraph key.
 *
 * Unpacking a subgraph leaves genuine ROOT-level nodes carrying SUBGRAPH-QUALIFIED
 * ids: `120:104`, `263:78`, `120:113:78`. The read tools list and render them
 * normally, and every write went through `graph.getNodeById(Number(nodeId))` —
 * `Number("263:78")` is NaN — so those nodes reported as missing. One reporter had
 * 18 of 21 nodes readable and uneditable.
 *
 * Passing the qualified form THROUGH is what resolves it. LiteGraph's getNodeById
 * is a `_nodes_by_id[id]` object lookup and object keys are strings, so the id the
 * reader printed is the key the node is stored under. Measured against a live
 * ComfyUI rather than assumed: node ids there are already strings, and lookup by
 * string resolves the same node as lookup by number.
 *
 * What must NOT happen is parsing one. `Number.parseInt("263:78", 10)` is 263 — a
 * DIFFERENT, real node — so a half-done fix converts a loud "no such node" into a
 * silent edit of the wrong one. That is why the MCP side stopped coercing at the
 * same time (see src/orchestrator/node-id.ts there); a plain integer id keeps
 * behaving exactly as it always has.
 */

/** Integer segments joined by colons. Only the FIRST may be negative: a leading
 *  `-` marks a boundary-rail id (-10/-20), which the readers do emit, while a `-`
 *  inside a path is a shape nothing produces. No depth limit — nesting is
 *  arbitrary, and a limit would fail the deep case the way NaN failed the shallow. */
const QUALIFIED_NODE_ID_RE = /^-?\d+(?::\d+)+$/;

/** True for `"120:104"`; false for `"42"`, `42`, `"1:"`, `"1:-2"`, and non-strings. */
export function isQualifiedNodeId(nodeId) {
  return typeof nodeId === "string" && QUALIFIED_NODE_ID_RE.test(nodeId);
}

/**
 * The key to hand LiteGraph.
 *
 * A qualified id is returned VERBATIM. Everything else goes through `Number()`
 * exactly as before — including the numeric-string compatibility surface — so a
 * plain id is unaffected, and genuinely bad input still lands on NaN and is
 * reported as missing by the caller's existing diagnosis.
 */
export function canonicalNodeId(nodeId) {
  return isQualifiedNodeId(nodeId) ? nodeId : Number(nodeId);
}

/**
 * #1759 — a custom node can mutate a live node's id without repairing
 * LiteGraph's `_nodes_by_id` index. Reads enumerate `_nodes`, so using the
 * index alone can send a write to a stale node with the same id (the reported
 * H3One → MarkdownNote failure). When the live list is available, it is the
 * authority; the index is only a compatibility fallback for graph-shaped
 * doubles/older frontends that do not expose that list.
 *
 * A missing live-list match deliberately does not fall back to the index: a
 * stale index entry is not proof that the node is still present.
 */
export function resolveLiveNode(graph, nodeId) {
  const target = canonicalNodeId(nodeId);
  const liveNodes = graph?._nodes ?? graph?.nodes;
  if (Array.isArray(liveNodes)) {
    const matches = liveNodes.filter((node) => node?.id != null && canonicalNodeId(node.id) === target);
    return matches.length === 1 ? matches[0] : null;
  }
  return graph?.getNodeById?.(target) ?? null;
}
