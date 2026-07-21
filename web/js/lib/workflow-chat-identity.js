// Pure workflow transcript-identity rules shared by the panel and unit tests.

export function normalizedWorkflowPath(path) {
  return typeof path === "string" ? path.replaceAll("\\", "/").toLowerCase() : null;
}

/** Resolve a persisted path alias without making identity locale-dependent. */
export function workflowAliasForPath(aliases, path) {
  const normalized = normalizedWorkflowPath(path);
  if (!normalized) return null;
  const match = Object.entries(aliases || {}).find(
    ([knownPath]) => normalizedWorkflowPath(knownPath) === normalized,
  );
  return typeof match?.[1] === "string" && match[1] ? match[1] : null;
}

/** Return true when an embedded UUID belongs to a different workflow file.
 *  An existing objectUuid means ComfyUI mutated the same live workflow object
 *  during rename/Save-As, so continuity wins. Otherwise an embedded path or a
 *  known path alias can prove that copied JSON needs a fresh identity. */
export function shouldForkEmbeddedWorkflowUuid({
  objectUuid,
  embeddedUuid,
  embeddedPath,
  currentPath,
  aliases = {},
} = {}) {
  if (objectUuid || !embeddedUuid || !currentPath) return false;
  if (embeddedPath) {
    return normalizedWorkflowPath(embeddedPath) !== normalizedWorkflowPath(currentPath);
  }
  const canonicalAlias = Object.entries(aliases || {}).find(
    ([knownPath]) => normalizedWorkflowPath(knownPath) === normalizedWorkflowPath(currentPath),
  );
  if (canonicalAlias?.[1] === embeddedUuid) return false;
  return Object.entries(aliases || {}).some(
    ([knownPath, knownUuid]) =>
      knownUuid === embeddedUuid &&
      normalizedWorkflowPath(knownPath) !== normalizedWorkflowPath(currentPath),
  );
}

/** Exact-match authorization guard for activating a workflow transcript.
 *  Paths and titles are migration/display metadata, never resume authority. */
export function isThreadInScope(thread, scopeKey) {
  return Boolean(
    thread &&
      typeof scopeKey === "string" &&
      scopeKey &&
      typeof thread.workflowKey === "string" &&
      thread.workflowKey === scopeKey,
  );
}
