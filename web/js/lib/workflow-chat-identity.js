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

/** #570 P0 — classify an `app.loadGraphData` call as a workflow CREATION (import,
 *  open-file, drag-drop, template, shared-url, DUPLICATE, PASTE, new-blank) versus a
 *  reuse (reload-restore, tab-switch, undo/redo, reroute-migration, in-place repaint).
 *
 *  ComfyUI passes the open ComfyWorkflow OBJECT as the 4th `loadGraphData` arg for every
 *  REUSE, and a non-object (null / undefined / string filename) for every CREATION; the
 *  external imports additionally carry an `openSource`. Paste and duplicate keep the
 *  SOURCE graph's embedded per-instance uuid, so a creation must MINT A FRESH identity
 *  before the graph goes live — otherwise a copy that preserved the source's uuid AND
 *  its synthesized "Unsaved Workflow.json" path inherits the source's session (the
 *  reopened cross-resume that a (path,graph-id) key can't catch). `noFork` lets the
 *  panel's OWN same-workflow reloads (snapshot revert) opt out.
 *
 *  A rare legacy single-tab restore (a string 4th arg, no openSource) is treated as a
 *  creation and re-mints — harmless: it already forks into a fresh temporary, and the
 *  common multi-tab reload passes an object so it is never misclassified.
 *
 *  FAIL SAFE (bias to fork): a REUSE is recognized ONLY when the 4th arg is genuinely a
 *  ComfyWorkflow — a non-array object exposing a string `path` (every open workflow,
 *  including a temporary "workflows/Unsaved Workflow.json", has one). Anything else — a
 *  primitive, an array, or an unrecognized/mis-shaped object — is treated as a CREATION.
 *  A mis-classified reuse only loses durability (P1, a fresh session); a mis-classified
 *  creation that INHERITED the source identity would be a wrong-resume (P0) — so, faced
 *  with an ambiguous arg, fork. */
/** #570 P0b — should an IN-PLACE graph load (loadGraphData into an EXISTING workflow object)
 *  FORK the per-instance identity? A stale object-cache must NEVER override the identity of
 *  newly-loaded content, and ownership is anchored on the LIVE object (not copyable
 *  graph.extra). Fork when the object already has a cached uuid AND the incoming graph's
 *  embedded uuid DIFFERS from it (a workflow REPLACED in place) — or the incoming has none.
 *  Same uuid → the same content reloaded/undone → keep. The embedded value is used only to
 *  DETECT the change; the caller mints a FRESH uuid (never adopts the copyable embedded one). */
export function shouldForkInPlaceReload({ cachedUuid, incomingUuid } = {}) {
  return Boolean(cachedUuid) && incomingUuid !== cachedUuid;
}

/** #570 P1 — does the path-selector search scope for `cmd` include CLOSED-but-LISTED workflows
 *  (s.workflows) in addition to the OPEN ones (s.openWorkflows)? workflow_rename can rename a
 *  closed-but-listed workflow, so it searches both; workflow_close can only close an OPEN one, so
 *  it searches openWorkflows alone. The fence and the executor share the ONE resolver keyed on
 *  this so their target decision matches exactly (a closed-but-listed rename target resolves in
 *  BOTH → correctly exempted, never over-fenced). */
export function selectorSearchIncludesListed(cmd) {
  return cmd !== 'workflow_close';
}

/** #570 — a path-selectored active-targeting mutator (workflow_rename / workflow_close) is exempt
 *  from the active-workflow uuid fence ONLY when its selector resolves to a REAL open workflow
 *  that is NOT the active one. Decide by the RESOLVED TARGET, never by raw path presence: the
 *  executor does openWorkflows.find(selector), so a non-empty path that resolves to the ACTIVE
 *  workflow — including after that path was replaced IN PLACE with a different workflow (same
 *  path/tab, new uuid) — still hits the active canvas and MUST be fenced. Resolves to the active
 *  object, or to nothing (can't prove non-active), ⇒ NOT exempt (fenced). `resolved` is the open
 *  workflow the selector matched (or null); `active` is the active workflow object. */
export function selectorTargetsNonActiveWorkflow({ resolved, active } = {}) {
  return Boolean(resolved) && resolved !== active;
}

/** #570 — does the per-command workflow-instance uuid fence APPLY to this command? The fence
 *  refuses a command whose stamped workflow_uuid ≠ the ACTIVE workflow's uuid, so it must cover
 *  everything that runs against the active canvas — every graph_* op AND the active-workflow
 *  mutators workflow_save / workflow_save_as / workflow_rename / workflow_close (workflow_save*
 *  ignore any path, so they are ALWAYS active).
 *
 *  A PINNED command (workflow_path present) is NOT exempt (codex): the #349 pin guard authorizes
 *  by PATH/key/filename, which cannot distinguish workflow A from a DIFFERENT workflow B saved to
 *  the SAME path after an in-place replacement — a stale command stamped for A still carries a
 *  matching workflow_path but a mismatching uuid, and only the uuid fence catches it. The pin
 *  guard runs as an ADDITIONAL check (it catches a switch to a DIFFERENT path the uuid alone
 *  can't); both must pass. The fence fires for pinned ops too.
 *
 *  It must NOT fire only for:
 *   • workflow_open / workflow_new: navigation/creation with their own explicit/new target;
 *   • workflow_rename / workflow_close whose selector resolves to a genuinely NON-active open
 *     workflow (`targetsNonActive` — via selectorTargetsNonActiveWorkflow): a deterministic
 *     close/rename of a DIFFERENT workflow must run. A path that resolves to the ACTIVE workflow
 *     (incl. after an in-place replacement) is NOT exempt — it is fenced.
 *  Reads (graph_get_state, …) still return true here — harmlessly fenced (fail-closed); their
 *  reply is server-fenced anyway, and a read can only run against the active canvas regardless. */
export function activeWorkflowFenceApplies({ cmd, targetsNonActive = false } = {}) {
  if (cmd === 'workflow_open' || cmd === 'workflow_new') return false;
  if ((cmd === 'workflow_rename' || cmd === 'workflow_close') && targetsNonActive) return false;
  return true;
}

/** #570 — should the panel REFUSE to execute a command stamped for a specific workflow
 *  instance? The orchestrator stamps each dispatched command with the trusted per-instance
 *  `workflow_uuid` it was ISSUED FOR. Every graph executor runs against the ACTIVE canvas, so
 *  if the user switched/replaced the workflow after the command was dispatched (a frame the
 *  server can no longer retract), applying it would silently mutate the WRONG graph. Reject
 *  when the command carries a non-empty uuid that does NOT equal the active workflow's uuid —
 *  including when the active uuid is unresolvable (fail closed, #186). A command with no
 *  stamp (old orchestrator / identity-less tab) is never fenced here. */
export function commandWorkflowMismatch({ commandUuid, activeUuid } = {}) {
  if (typeof commandUuid !== 'string' || !commandUuid.trim()) return false;
  return activeUuid !== commandUuid;
}

/** #570 — resolve the per-instance uuid for an UNSAVED workflow, failing CLOSED on the
 *  copyable durability carrier. Precedence:
 *   1. `objectUuid` — the LIVE-object WeakMap value. A copy/import never shares the live
 *      object, so this is always a safe per-instance identity.
 *   2. `embeddedId` — the graph.extra uuid. Trustworthy ONLY when `forkActive` is true,
 *      because the creation-boundary wrapper is what re-mints graph.extra on every
 *      copy/import/in-place replace. If the sanitizer is not provably installed
 *      (`forkActive` false), a pasted graph could still carry the SOURCE's uuid, so the
 *      embedded value is IGNORED and a fresh uuid is minted (lost-resume, never wrong-resume).
 *   3. a freshly minted uuid.
 *  `mint` is injected for deterministic tests; defaults to crypto.randomUUID. */
export function resolveUnsavedInstanceUuid({
  objectUuid,
  embeddedId,
  forkActive,
  mint = () => crypto.randomUUID(),
} = {}) {
  if (objectUuid) return objectUuid;
  if (forkActive && embeddedId) return embeddedId;
  return mint();
}

export function isNewWorkflowLoad({ workflowArg, openSource, noFork = false } = {}) {
  if (noFork) return false;
  if (openSource != null) return true;
  const looksLikeWorkflow =
    workflowArg !== null &&
    typeof workflowArg === "object" &&
    !Array.isArray(workflowArg) &&
    typeof workflowArg.path === "string";
  return !looksLikeWorkflow;
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
