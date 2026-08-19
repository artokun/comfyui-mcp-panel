/**
 * comfyui-mcp#1657 / panel#1284 — "absent from /object_info" is not "missing".
 *
 * Three surfaces answered the question "is this node type real?" with a single
 * observation — the server's /object_info does not list it — and that observation
 * cannot tell apart:
 *
 *   A. a node the FRONTEND registers as VIRTUAL, which never reaches the backend and
 *      is absent from /object_info BY DESIGN (KJNodes' Get/Set bus, rgthree's Label
 *      and Fast Groups toggles, litegraph's own Note/Reroute/PrimitiveNode); and
 *   B. a node whose pack is not installed, or whose frontend JS this tab never
 *      loaded, so litegraph minted a defless PLACEHOLDER for it.
 *
 * Both are absent from /object_info. Only B is a fault. Collapsing them reports a
 * working 422-node canvas as a wall of missing node types (#1657), which is the
 * report the user then acts on.
 *
 * ## Why not a list of type names
 *
 * Because a list gets case B wrong, and case B is real: panel#1284 and comfyui-mcp#1648
 * come from the SAME rig (darwin, ComfyUI 0.33.1, frontend 1.48.7, panel 0.14.41), where
 * `GetNode`/`SetNode` were reported by ComfyUI's OWN missing-nodes store because that
 * tab's frontend had never loaded KJNodes' JS. On that rig those nodes really were dead,
 * and a name allowlist containing "GetNode"/"SetNode" would have declared them fine and
 * sent a broken run to the queue. A list is also stale the moment a pack ships a new
 * virtual node — which is how this recurred three times.
 *
 * ## The derivable signal
 *
 * `node.isVirtualNode === true`, read off the live node INSTANCE. This is not a
 * heuristic and not this repo's invention — it is the exact flag ComfyUI's own
 * serializer uses to decide what never reaches the backend. Verified in the shipped
 * frontend 1.48.7 bundle:
 *
 *     for (let e of i.values()) {
 *       if (e.isVirtualNode || e.mode === NEVER || e.mode === BYPASS) continue;
 *       ...
 *       a[String(e.id)] = { inputs: t, class_type: e.comfyClass, ... }
 *     }
 *
 * and its `ExecutableNodeDTO` proxies it straight through
 * (`get isVirtualNode() { return this.node.isVirtualNode }`). So this flag is the ONLY
 * thing standing between a virtual node and a `class_type: undefined` prompt entry —
 * exactly the property these surfaces need, asserted by the authority that acts on it.
 *
 * Verified against the three packs on this machine's install, which set it in their own
 * source rather than having it inferred for them:
 *   - comfyui-kjnodes/web/js/setgetnodes.js  — `this.isVirtualNode = true` on SetNode
 *     and GetNode ("purely frontend and does not impact the resulting prompt").
 *   - rgthree-comfy/web/comfyui/base_node.js — `RgthreeBaseVirtualNode` sets it, and
 *     Label, Fast Groups Bypasser/Muter, Fast Bypasser/Muter, Node Collector and
 *     Reroute (rgthree) all extend it.
 *   - the ComfyUI frontend itself — Note, MarkdownNote, PrimitiveNode, Reroute.
 *
 * A pack nobody has heard of yet is covered on the same terms, because a virtual node
 * that does NOT set this flag is serialized into the prompt and fails at the server —
 * so a pack cannot both omit the flag and work.
 *
 * ## What this deliberately does NOT claim
 *
 * A defless PLACEHOLDER never carries this flag: litegraph mints it for a type no class
 * was registered for, so nothing set it. That is what keeps case B reported. The
 * predicate is a POSITIVE proof of virtuality and nothing else — every other shape
 * (absent flag, unreadable node, no live instance at all) keeps the node reported,
 * which is the direction that costs noise rather than a missed diagnosis.
 *
 * The one input that would defeat this is a placeholder that somehow arrives WITH the
 * flag, which would need a workflow file to carry it. It cannot: enumerated across the
 * shipped 1.48.7 bundle there are 11 occurrences of `isVirtualNode`, and every one is a
 * class declaration or a read — the graph serializer does not emit it, so no saved
 * workflow can put it on a node whose class was never registered.
 *
 * ## Why the write guards' extra clause is not required here
 *
 * `node-resolve.js` additionally demands no backend provenance on the class, because it
 * authorizes WRITES and a fabricated success there is the #458 hole. These call sites
 * only decide what to REPORT, and the extra clause would be actively wrong for them: the
 * frontend STAMPS a synthesized def on every subgraph container's class
 * (registerSubgraphNodeDef), so requiring provenance-cleanliness would put subgraph
 * containers — also `isVirtualNode`, also absent from /object_info by design — back on
 * the missing list this exists to clean up.
 */

/**
 * POSITIVE proof that this live node instance is a frontend virtual node: it is never
 * serialized into a prompt, so its absence from /object_info is expected, not a fault.
 *
 * Defensive: anything unreadable answers false, i.e. stays reported.
 */
export function isFrontendVirtualNode(node) {
  try {
    return !!node && typeof node === "object" && node.isVirtualNode === true;
  } catch {
    return false;
  }
}

/**
 * The node types among `nodes` whose EVERY live instance is a frontend virtual node.
 *
 * "Every", not "any": one registered class decides a type's virtuality, so the two agree
 * in practice — but if a type ever presents both a virtual instance and a placeholder in
 * the same tab, that type has a real problem and must keep being reported. Requiring
 * unanimity makes the ambiguous case fail toward reporting.
 *
 * A type with NO live instance yields nothing, so a load-time store entry that outlived
 * its nodes is never cleared by this.
 */
export function frontendVirtualTypesAmong(nodes) {
  const virtual = new Set();
  const refuted = new Set();
  try {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      let type = null;
      try {
        type = typeof node?.type === "string" && node.type ? node.type : null;
      } catch {
        type = null;
      }
      if (!type) continue;
      if (isFrontendVirtualNode(node)) virtual.add(type);
      else refuted.add(type);
    }
  } catch {
    /* a malformed graph exempts nothing — every type stays reported */
  }
  for (const t of refuted) virtual.delete(t);
  return virtual;
}

/**
 * Drop the frontend-virtual types from a list of allegedly-missing node types.
 *
 * `types` is ComfyUI's own load-time `missingNodesError` record, which the frontend
 * never re-evaluates (see stale-placeholders.js) — so it keeps naming a type long after
 * the pack that provides it started working, and it names virtual types whose pack is
 * working perfectly. `nodes` is the live graph (every scope), the only thing that can
 * say which of those two happened.
 *
 * Order-preserving, and a no-op on any input it cannot read.
 */
export function withoutFrontendVirtualTypes(types, nodes) {
  if (!Array.isArray(types) || !types.length) return Array.isArray(types) ? types : [];
  const virtual = frontendVirtualTypesAmong(nodes);
  if (!virtual.size) return types;
  return types.filter((t) => !virtual.has(t));
}
