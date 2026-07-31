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

/** Every identity string the ACTIVE workflow answers to, for pinned-target
 *  matching (#186/#349). `routingKey` is the per-instance opaque id — "wf:<path>"
 *  for a saved tab, "tmp:<uuid>" for an unsaved one — and ALWAYS authorizes.
 *
 *  Critically, the shared forms (path, native key, filename) authorize ONLY a
 *  PERSISTED tab, whose on-disk identity is unique. An UNSAVED tab shares the
 *  native "Unsaved Workflow" key/title with every other unsaved tab and has no real
 *  path, so accepting those forms would re-open the #186 misroute (a pin to one
 *  unsaved tab matching whichever unsaved tab is active). For an unsaved tab the
 *  routing id is therefore the ONLY authority. Persistence is read straight off the
 *  workflow object's own flags — the same test savedWorkflowPath() uses. */
export function workflowIdentityForms(wf, routingKey, extraForms = []) {
  const forms = [];
  const add = (v) => {
    if (typeof v === "string" && v) forms.push(v);
  };
  add(routingKey);
  // `extraForms` carries additional per-instance authorities the caller knows —
  // notably the ORIGINAL "tmp:<uuid>" id of a tab that has since been saved, so a
  // pin taken before the save still matches the same instance afterwards (the
  // orchestrator moves the pin unchanged across the save's tab-id migration).
  for (const e of Array.isArray(extraForms) ? extraForms : []) add(e);
  // A tab with a real on-disk PATH has a unique identity, so its path/key/filename
  // may authorize a pin. Deliberately keyed on `isPersisted` + a real path, NOT on
  // `isTemporary`: that flag is derived from `size` and drifts to true for a file
  // that IS on disk after a panel_open_workflow ack race (#215), and requiring it
  // false here would spuriously reject a correct path pin (#349). A never-saved tab
  // has isPersisted=false → routing id is its ONLY authority, which is what keeps two
  // "Unsaved Workflow" tabs from colliding (#186).
  const hasDiskIdentity = wf?.isPersisted === true && typeof wf?.path === "string" && wf.path;
  if (hasDiskIdentity) {
    const filename = typeof wf.filename === "string" ? wf.filename : null;
    add(wf.path);
    add(wf.key);
    add("wf:" + wf.path);
    add(filename);
    if (filename) add(filename.replace(/\.json$/i, ""));
  }
  return forms;
}

/** Decide whether a pinned workflow identifier addresses the ACTIVE workflow.
 *  `activeForms` is the output of workflowIdentityForms() for the live canvas.
 *  Returns:
 *    "match"    — the pin names the active workflow → the edit may proceed;
 *    "mismatch" — the active identity is resolvable AND none of its forms match
 *                 → FAIL CLOSED (the pinned tab is not the active canvas, so
 *                 running would silently edit the wrong graph — #186);
 *    "unknown"  — the pin is empty, or the active workflow exposes no identity
 *                 form → never reject (an unresolvable frontend must not spuriously
 *                 fail, and current-mode sessions carry no pin).
 *  Matching is CASE-SENSITIVE (only path separators are normalized): on a
 *  case-sensitive filesystem "workflows/Foo.json" and "workflows/foo.json" are
 *  DISTINCT files, so lowercasing here (as normalizedWorkflowPath does for alias
 *  identity) would let a pin authorize the wrong graph — the same reason #207's
 *  workflowTabKey preserves case. Routing ids (tmp:/wf:) are case-stable, so exact
 *  matching never rejects a legitimate routing-id pin. */
export function classifyPinnedTarget(pinnedId, activeForms) {
  const norm = (v) =>
    typeof v === "string" && v.trim() ? v.replaceAll("\\", "/").trim() : null;
  const want = norm(pinnedId);
  if (!want) return "unknown";
  const have = (Array.isArray(activeForms) ? activeForms : []).map(norm).filter(Boolean);
  if (!have.length) return "unknown";
  return have.includes(want) ? "match" : "mismatch";
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
