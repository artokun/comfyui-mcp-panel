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
    `Unknown node type "${class_type}" — check the exact class_type via panel_get_graph or panel_search_nodes`,
  );
}

/**
 * Guard for graph_set_widget: throw when the target `node`'s type is not a
 * resolved, registered class — an unregistered placeholder's widget list is not
 * the real schema, so echoing back {set:...} would report a change that didn't
 * happen. Subgraph nodes carry their own inner graph rather than a registered
 * class, so they are exempt.
 */
export function assertNodeWidgetWritable(registry, node) {
  if (!node || node.subgraph) return;
  const type = node.type;
  if (!type || isRegisteredNodeType(registry, type)) return;
  if (!comfyNodeDefsLoaded(registry)) {
    throw new Error(
      `Cannot set widget on node ${node.id} ("${type}"): ComfyUI node ` +
        `definitions are not loaded (the backend is unreachable). Reconnect ` +
        `ComfyUI and retry — refusing to write to an unresolved placeholder node.`,
    );
  }
  throw new Error(
    `Cannot set widget on node ${node.id}: its type "${type}" is not registered ` +
      `on this ComfyUI (missing custom node?) — refusing to write to an ` +
      `unresolved placeholder node.`,
  );
}
