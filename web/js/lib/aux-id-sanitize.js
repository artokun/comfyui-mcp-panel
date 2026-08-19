// panel#1411 — `properties.aux_id` is the frontend/Manager install-hint stamped on a
// node ("github-user/repo-name"). The Manager 3.x legacy metadata chain can stamp a
// MALFORMED value (observed: "work") on nodes created via LG.createNode, and ComfyUI's
// workflow zod schema then rejects EVERY subsequent save/load of the workflow with
// "Invalid format. Must be 'github-user/repo-name'". One bad node poisons the whole
// workflow file.
//
// The sanitizer treats only `github-user/repo-name` (or absence) as valid — the same
// rule the zod schema enforces — and DELETES an invalid hint rather than guessing a
// replacement: a wrong repo attribution is worse than none. A valid hint is kept.

/** The zod schema's accepted shape: `github-user/repo-name`, no whitespace. */
export const AUX_ID_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Drop `node.properties.aux_id` when it is present but not a valid
 * `github-user/repo-name` hint. Returns true when a value was removed.
 * No-op (returns false) for missing/valid hints or nodes without properties.
 */
export function sanitizeNodeAuxId(node) {
  const aux = node?.properties?.aux_id;
  if (aux != null && !(typeof aux === "string" && AUX_ID_RE.test(aux))) {
    delete node.properties.aux_id;
    return true;
  }
  return false;
}

/** Sanitize every node in a list; returns how many hints were dropped. */
export function sanitizeNodesAuxId(nodes) {
  let dropped = 0;
  for (const n of nodes || []) {
    if (sanitizeNodeAuxId(n)) dropped++;
  }
  return dropped;
}
