/**
 * comfyui-mcp#1460 — a run queued nodes the server cannot dispatch, one rejection at
 * a time.
 *
 * ## Measured, not inferred
 *
 * A node whose type is not registered stays on the canvas and is included in the
 * prompt by ComfyUI's OWN serializer:
 *
 *     canvas:  { id: "45", type: "TotallyNotInstalledNode", comfyClass: undefined }
 *     graphToPrompt() ids: ["1", "45"]     <- included
 *     prompt["45"].class_type: undefined   <- with nothing to dispatch on
 *
 * which is the reporter's error verbatim: "Node 'ID #45' has no class_type." It is
 * why their nodes were VISIBLE — an unregistered type renders as a placeholder — and
 * why this is not a serializer defect on our side: `graph_run` calls
 * `app.queuePrompt`, so ComfyUI builds that payload itself.
 *
 * The reporter discovered the four missing types sequentially, removing and rewiring
 * nodes after each rejection. Every one of them was knowable before the first queue.
 *
 * ## Why refusing is safe here
 *
 * A run containing an unregistered type CANNOT succeed — the server rejects it. So
 * this prevents no working run; it replaces a rejection loop with one complete
 * answer. That is the only reason a pre-flight is allowed to block at all.
 *
 * ## Two properties that must not be lost
 *
 * FAIL SOFT. An `/object_info` lookup that cannot be reached is UNKNOWN, not missing.
 * Refusing a run because a metadata probe failed would swap one false failure for
 * another, which is the defect class this repo keeps paying for.
 *
 * BOUNDED. One request per distinct TYPE, cached — a canvas with thirty KSamplers
 * must not become thirty requests, and a pathological canvas must not spend the run's
 * deadline on lookups (#589).
 */

/**
 * Which of `types` the server does not define.
 *
 * Returns `{ missing, unknown }`. A type whose lookup FAILED lands in `unknown` and
 * never in `missing`, so the caller can disclose it without refusing on it.
 */
export async function findUnregisteredTypes(types, fetchClassInfo, { maxTypes = 200 } = {}) {
  const missing = [];
  const unknown = [];
  if (!Array.isArray(types) || typeof fetchClassInfo !== "function") {
    return { missing, unknown };
  }
  const distinct = [...new Set(types.filter((t) => typeof t === "string" && t))];
  for (const t of distinct.slice(0, maxTypes)) {
    let info;
    try {
      info = await fetchClassInfo(t);
    } catch {
      // Unreachable/failed lookup: not evidence of absence.
      unknown.push(t);
      continue;
    }
    if (info === null || info === undefined) {
      unknown.push(t);
      continue;
    }
    // A definition is an object keyed by the class name (or the class itself). An
    // EMPTY object is the server saying it has no such class.
    const defined =
      typeof info === "object" && !Array.isArray(info) ? Object.keys(info).length > 0 : !!info;
    if (!defined) missing.push(t);
  }
  return { missing, unknown };
}

/**
 * The refusal for a run whose canvas carries types the server does not define.
 *
 * Names every missing type AND the node ids each accounts for, because the reporter's
 * cost was not knowing which node came next.
 */
export function missingNodeRunRefusal({ missing, nodesByType, unknown = [] } = {}) {
  const list = (missing ?? []).map((t) => {
    const ids = (nodesByType?.[t] ?? []).map(String);
    return ids.length ? `"${t}" (node ${ids.join(", ")})` : `"${t}"`;
  });
  const unknownClause = unknown.length
    ? ` ${unknown.length} further type(s) could NOT be checked (${unknown
        .slice(0, 5)
        .map((t) => `"${t}"`)
        .join(", ")}) because the lookup failed — that is not evidence they are missing, ` +
      `and they are NOT why this refused.`
    : "";
  return (
    `NOT queued: this canvas uses ${list.length} node type(s) the connected ComfyUI does not ` +
    `define — ${list.join("; ")}. ComfyUI would have accepted the run and then rejected it with ` +
    `"has no class_type" for one node at a time, because an unregistered type still draws on the ` +
    `canvas and is still sent (comfyui-mcp#1460). Every one is named here so you do not have to ` +
    `find them one rejection at a time.${unknownClause} Install the pack that provides them ` +
    `(install_custom_node, or ComfyUI-Manager on the host) and RESTART ComfyUI, then retry. ` +
    `Nothing was queued, so nothing needs undoing.`
  );
}
