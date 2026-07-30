// Node-type resolution guard for the graph WRITE tools (#458).
//
// The panel's write tools (graph_add_node / graph_set_widget) must resolve node
// types against the REAL LiteGraph registry that ComfyUI populates from
// /object_info — and FAIL LOUDLY when a type can't be resolved, exactly like the
// read tools hard-error. The bug this fixes: with ComfyUI's backend unreachable
// the node definitions never load, so:
//   * graph_add_node let LiteGraph mint a generic PLACEHOLDER node
//     (in0/out0/type '*', widgets {value:0,text:""}) and reported it as a real,
//     resolved add — byte-identical for every class_type asked for; and
//   * graph_set_widget then "set" a widget that placeholder does not really have.
// Net: an autonomous agent wires up and reports a workflow that does not exist,
// with every signal saying success. These pure predicates are the gate; they are
// extracted here so the SAME branching the handlers run is unit-testable.

// Well-known ComfyUI CORE node classes. Their presence in the live registry is a
// reliable signal that /object_info was fetched and the backend node definitions
// were registered. If NONE are present, the defs never loaded (the backend is
// unreachable), which we surface distinctly from a genuine unknown-type.
export const COMFY_CORE_SENTINEL_TYPES = [
  "KSampler",
  "CheckpointLoaderSimple",
  "CLIPTextEncode",
  "VAEDecode",
  "VAELoader",
  "EmptyLatentImage",
  "LoadImage",
  "SaveImage",
];

/** True when `type` is registered in the live LiteGraph registry object
 *  (LG.registered_node_types). */
export function isRegisteredNodeType(registry, type) {
  if (!registry || typeof type !== "string") return false;
  return Object.prototype.hasOwnProperty.call(registry, type);
}

/** True once ComfyUI's backend node definitions have been registered (i.e.
 *  /object_info loaded). False means the backend is unreachable / defs unloaded,
 *  so no Comfy class_type can be resolved and writes must fail rather than
 *  synthesize a placeholder. */
export function comfyNodeDefsLoaded(registry) {
  if (!registry) return false;
  return COMFY_CORE_SENTINEL_TYPES.some((t) =>
    Object.prototype.hasOwnProperty.call(registry, t),
  );
}

/**
 * Guard for graph_add_node: throw (mirroring the read-path hard error) when
 * `class_type` cannot be resolved against the live registry, distinguishing
 * "backend unreachable / defs not loaded" from "type genuinely unknown". Returns
 * nothing on success — the caller may then createNode(class_type) knowing it is a
 * real, registered type (never a fabricated placeholder).
 */
export function assertAddNodeResolvable(registry, class_type) {
  if (isRegisteredNodeType(registry, class_type)) return;
  if (!comfyNodeDefsLoaded(registry)) {
    throw new Error(
      `Cannot add "${class_type}": ComfyUI node definitions are not loaded ` +
        `(the backend is unreachable, or /object_info hasn't been fetched). ` +
        `Reconnect ComfyUI and retry — refusing to add an unresolved placeholder node.`,
    );
  }
  throw new Error(
    `Unknown node type "${class_type}" — check the exact class_type via panel_search_nodes`,
  );
}

/**
 * Guard for graph_set_widget, applied to the ACTUAL RESOLVED write target (the
 * inner promoted node for a subgraph write, or the node's own for a direct
 * write) — NOT the outer node. This is the load-bearing check: it must run on
 * whatever `applyWidgetWrite` is about to mutate, so a placeholder can't slip
 * through by being (or hosting) a subgraph.
 *
 * Fails CLOSED. A resolved target is writable ONLY when it has a string `type`
 * that is registered in the live registry. Anything else — no type, or a type
 * absent from the registry (an unresolved placeholder, whether it carries a
 * `subgraph` property or not; or a genuinely missing custom node) — is refused,
 * distinguishing "backend unreachable / defs not loaded" from "type not
 * registered". A REAL subgraph parent is exempted authentically: its promoted
 * widget resolves to a registered inner node, and THAT inner node is what gets
 * passed here and passes the registry check.
 */
export function assertResolvedTargetRegistered(registry, targetNode) {
  const type = targetNode?.type;
  const id = targetNode?.id ?? "(unknown)";
  if (typeof type !== "string" || !isRegisteredNodeType(registry, type)) {
    if (!comfyNodeDefsLoaded(registry)) {
      throw new Error(
        `Cannot set widget on node ${id}${type ? ` ("${type}")` : ""}: ComfyUI ` +
          `node definitions are not loaded (the backend is unreachable). Reconnect ` +
          `ComfyUI and retry — refusing to write to an unresolved placeholder node.`,
      );
    }
    throw new Error(
      `Cannot set widget on node ${id}: its type ${type ? `"${type}" is` : "is"} ` +
        `not registered on this ComfyUI (missing custom node, or an unresolved ` +
        `placeholder) — refusing to write to it.`,
    );
  }
  // The type IS registered — but the INSTANCE may still be a stale placeholder
  // (#458). A workflow loaded while ComfyUI's defs were unavailable creates node
  // instances on a GENERIC FALLBACK constructor with no nodeData; if the backend
  // later comes back and registers the type, the type-string check now passes yet
  // the instance still carries generic in0/out0/'*' slots and {value,text}
  // widgets. registerNodesFromDefs mints a NEW class per type, so a genuinely
  // resolved instance's own constructor carries the def while a stale placeholder
  // does not. So: if the REGISTERED class has a real def (nodeData) but THIS
  // instance's constructor does not, it is an unresolved placeholder — refuse.
  // (Native/defless types have no registered nodeData to compare and are trusted,
  // so this never false-negatives Note/Reroute/etc.)
  const registeredDef = registry?.[type]?.nodeData;
  const instanceDef = targetNode?.constructor?.nodeData;
  if (registeredDef && !instanceDef) {
    throw new Error(
      `Cannot set widget on node ${id} ("${type}"): the node is an unresolved ` +
        `placeholder — its live definition is missing even though the type is now ` +
        `registered (the workflow was loaded while ComfyUI was unavailable). ` +
        `Reload the workflow now that ComfyUI is reachable. Refusing to write.`,
    );
  }
}

/**
 * graph_set_widget handler prelude: decide whether the OUTER node may be MUTATED
 * (by reconcileUnknownWidgetNames, which RENAMES widgets in place) before the
 * write, and refuse a direct placeholder UP FRONT so NO pre-write mutation ever
 * touches an unresolved node (#458). Returns { reconcile }:
 *   - subgraph parent → { reconcile: false }: the write targets an INNER node
 *     (resolved + registry-checked inside applyWidgetWrite), and reconcile only
 *     renames the OUTER parent's own widgets — irrelevant to a promoted write, so
 *     it is skipped rather than risk mutating a fake `subgraph:{}` placeholder.
 *   - direct node → asserts it's a registered write target (throws otherwise),
 *     then { reconcile: true } so only a genuinely resolved node is repaired.
 */
export function preflightSetWidgetTarget(registry, node) {
  if (node?.subgraph) return { reconcile: false };
  assertResolvedTargetRegistered(registry, node);
  return { reconcile: true };
}
