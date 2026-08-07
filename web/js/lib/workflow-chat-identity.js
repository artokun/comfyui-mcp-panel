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

/** Vue reactive proxies expose their raw target as `__v_raw`; everything else is
 *  returned as-is. The workflow service hands out reactive PROXIES in computed
 *  lists (openWorkflows) while RAW objects flow through other paths (store
 *  returns, the uuid owner/object WeakMaps), so identity comparisons across
 *  those carriers must normalize first — a raw `===`/`includes` misreads a live
 *  proxy as a different object (#558 r2). A transparent (non-Vue) proxy has no
 *  raw back-pointer and passes through; sameWorkflowObject's property identity
 *  covers that form. */
export function rawWorkflowObject(w) {
  try {
    return w?.__v_raw ?? w ?? null;
  } catch {
    return w ?? null;
  }
}

/** Proxy-safe identity between two workflow references. Layers, strongest first:
 *  object identity (after unwrapping Vue proxies), then the per-instance
 *  changeTracker OBJECT — the strongest shared identity a proxy reflects, and
 *  the only one available for an UNSAVED tab (whose synthetic path is shared by
 *  every unsaved tab, #186). PATH IS DELIBERATELY NOT EVIDENCE: two distinct
 *  objects can share a path across a close→reopen, and that reopened object is
 *  a NEW workflow — treating path as identity let a live foreign owner read as
 *  self (#558 r3 P0). The one legitimate same-path identity continuation, a
 *  save swapping the active object, is threaded through the replacement event
 *  instead (shouldCarryIdentityAcrossSaveSwap). Two references that share NONE
 *  of these carriers can never be proven same → false. */
export function sameWorkflowObject(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (rawWorkflowObject(a) === rawWorkflowObject(b)) return true;
  const ctA = rawWorkflowObject(a)?.changeTracker ?? a?.changeTracker;
  const ctB = rawWorkflowObject(b)?.changeTracker ?? b?.changeTracker;
  return Boolean(ctA) && ctA === ctB;
}

/** #557 r3/r4 — should the pre-save identity be carried onto the post-save active
 *  object? True ONLY for a continuous-lifetime replacement: an in-place or
 *  first save (NOT a Save-As copy — that starts a new workflow) that swapped
 *  the active ComfyWorkflow object. The swap is provable ONLY at the
 *  replacement event, where the predecessor and successor objects are both
 *  known; static path equality cannot decide it — a closed→reopened object at
 *  the same path is a NEW workflow (r3 P0), while a swapped successor is the
 *  same tab. A proxy/raw form of the SAME object is no swap at all.
 *
 *  CONTINUITY (r4/r5/r8/r10 P0): "whatever is active after the awaited save" is
 *  not enough — a user/reconnect tab switch DURING the await lands on a DISTINCT
 *  workflow, and seeding it with the pre-save uuid would align that foreign tab
 *  with the old root tag, bypassing the #349 wrong-canvas fence. The carry
 *  therefore requires the predecessor to be GONE from the open tabs (a genuine
 *  swap removes it; a switch keeps it open) AND continuity threaded from the
 *  save's own replacement EVENT: the post-save active object must be the record
 *  the save API itself PRODUCED. STATIC evidence is deliberately excluded:
 *  tab-slot occupancy can seat a foreign tab in the predecessor's old slot
 *  (r5), a lagging tracker state carrying the pre-save uuid can be residue
 *  (r8), and path occupancy is satisfied by any close→reopen of the same file —
 *  which is a NEW identity, not a successor (r10). A successor the event thread
 *  can't prove fails SAFE (no carry); the lazy backstop / proven repaint heals
 *  the genuine case afterward. Unknown predecessor state defaults to still-open
 *  (fail-safe: no carry). */
export function shouldCarryIdentityAcrossSaveSwap({
  preWf,
  postWf,
  savedAs = false,
  preWfStillOpen = true,
  postWfHasConflictingEstablishedIdentity = false,
  postWfIsSaveProducedRecord = false,
} = {}) {
  if (savedAs) return false;
  if (!preWf || !postWf || typeof postWf !== "object") return false;
  if (preWf === postWf || sameWorkflowObject(preWf, postWf)) return false;
  if (preWfStillOpen) return false;
  // r7 P0 — an established, DIFFERENT identity on the successor is a conflict:
  // overwriting it would promote the pre-save stamp over the object's own
  // identity and poison the owner map (the r6 stale-lineage bypass, via
  // registration this time). Fail closed; the proven-repaint remedy heals.
  if (postWfHasConflictingEstablishedIdentity) return false;
  return postWfIsSaveProducedRecord === true;
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
/** #557 — should a previously-unseen workflow object FORK away from an embedded
 *  UUID that is still owned by a DIFFERENT live object? Fork while that owner
 *  is still an OPEN workflow tab — the genuine co-open copy case (#570) — and
 *  ALSO when the owner is closed but succession is NOT proven (r9 P0): "the
 *  owner is gone" alone does not make this object the successor — a
 *  different-path copy of the file qualifies just as well, and inheriting
 *  re-keys the uuid's owner record to the copy so stale uuid-scoped commands
 *  for the old workflow pass the command fence against it. Only a closed owner
 *  WITH positive succession evidence (hasEmbeddedUuidSuccessionEvidence) lets
 *  this object INHERIT — the save re-registers/replaces the active
 *  ComfyWorkflow object and the successor parses the same embedded uuid from
 *  the just-saved file while the REPLACED object is still the registered
 *  owner; minting fresh there desyncs it from the root graph tag the
 *  graph-binding guard compares against (#557). */
export function shouldForkEmbeddedUuidForLiveOwner({
  embeddedUuid,
  embeddedOwner,
  identityObject,
  ownerIsOpenWorkflow = false,
  successionProven = false,
} = {}) {
  if (!embeddedUuid || !embeddedOwner || embeddedOwner === identityObject) return false;
  if (ownerIsOpenWorkflow === true) return true; // a LIVE co-open owner → genuine copy
  // r9 P0 — a CLOSED owner is not succession: without positive evidence this
  // object continues the owner's file, fork rather than inherit.
  return successionProven !== true;
}

/** #557 r9/r10 — POSITIVE succession evidence for inheriting a CLOSED owner's
 *  embedded uuid. "The owner is gone" alone does not make this object the
 *  successor — a different-path COPY of the file qualifies just as well, and
 *  inheriting would re-key the uuid's owner record to the copy, letting stale
 *  uuid-scoped commands for the old workflow pass the command fence against it
 *  (r9 P0). Evidence:
 *   1. the file's OWN recorded workflow_path ties the uuid to THIS object's file;
 *   2. the canonical path alias ties THIS object's path to the uuid.
 *  The owner's file MATCHING this object's path is deliberately NOT evidence
 *  (r10 P0): a closed→reopened object at the same path is a NEW identity, not a
 *  successor — the resume heal for that case belongs to the
 *  UNREGISTERED-embedded path (no owner record), never to registered-owner
 *  inheritance. Absent both layers — notably a file carrying only
 *  workflow_uuid, saved from an unsaved tab whose embed omitted workflow_path —
 *  fail toward FORKING. */
export function hasEmbeddedUuidSuccessionEvidence({
  embeddedUuid,
  embeddedPath,
  currentPath,
  pathAlias,
} = {}) {
  if (
    embeddedPath &&
    currentPath &&
    normalizedWorkflowPath(embeddedPath) === normalizedWorkflowPath(currentPath)
  ) {
    return true;
  }
  if (typeof pathAlias === "string" && pathAlias && pathAlias === embeddedUuid) return true;
  return false;
}

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

/** #602 — commands whose execution AND result never reference the active canvas:
 *  Manager registry/server operations (node-pack discovery, install/update, queue
 *  status) and ComfyUI-server controls (reboot, VRAM free). Fencing these to the
 *  active workflow's uuid only manufactures false refusals when the user switches
 *  or replaces a tab after the command was issued — a Manager registry search was
 *  refused before it ever reached searchNodesVia because the stamped uuid no
 *  longer matched the now-active canvas.
 *
 *  refresh_nodes is deliberately NOT here (codex gate round 5): its executor
 *  re-applies fresh defs to LIVE node objects and renames UNKNOWN widget
 *  placeholders on the ACTIVE canvas — a real mutation of whichever workflow is
 *  mounted, so a stale-stamped call must stay fenced.
 *
 *  The set is EXPLICIT and everything unlisted stays fenced (fail closed): a new
 *  command must opt out here on purpose, so the #570 fence cannot silently lose
 *  coverage of a future canvas op. Membership criterion: the command neither
 *  reads nor mutates any workflow canvas and its reply does not describe the
 *  active one (workflow_list, by contrast, reports the ACTIVE workflow — a
 *  stale-stamped call must not answer for the wrong tab, so it stays fenced).
 *  graph_update_node is a Manager PACK update misnamed with a graph_ prefix; it
 *  touches no graph. */
const CANVAS_INDEPENDENT_COMMANDS = new Set([
  'nodes_search',
  'nodes_list',
  'nodes_install',
  'nodes_queue_status',
  'graph_update_node',
  'comfy_reboot',
  'free_vram',
]);

/** #602 — true when a command never reads or mutates a canvas (see the set above).
 *  Callers use this to skip canvas-targeting fences that would otherwise refuse a
 *  server-side operation for an irrelevant workflow-binding reason. */
export function commandIsCanvasIndependent(cmd) {
  return CANVAS_INDEPENDENT_COMMANDS.has(cmd);
}

/** #932 — commands that NO canvas-targeting guard may refuse, because they name no
 *  canvas to get wrong. Strictly wider than commandIsCanvasIndependent: it adds
 *  `workflow_list`, which DOES observe the canvas (it reports which tab is active)
 *  and so cannot honestly join that set, but which targets none.
 *
 *  Both guards this feeds exist to stop an operation landing on the WRONG workflow —
 *  the uuid fence (#570) and the pinned-target guard (#349/#186). `workflow_list`
 *  lands on nothing: it mutates no graph, selects no target (it enumerates every open
 *  tab), and returns tab metadata rather than graph content.
 *
 *  It is also the ONLY probe the recovery path has. `rebindWorkflowFence()` re-derives
 *  a session's target from `workflow_list`'s active record, so gating it behind either
 *  guard makes the repair require the thing it repairs to be already-correct. That
 *  circularity is what made #932/#607/#688 permanent: every command refused, and the
 *  refusal text advertising a recovery that was itself refused for the same reason.
 *  Both guards must consult THIS predicate, or the wedge simply moves to whichever one
 *  was left behind. */
export function commandIsCanvasTargetless(cmd) {
  return commandIsCanvasIndependent(cmd) || cmd === 'workflow_list';
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
 *   • canvas-independent Manager/server commands (CANVAS_INDEPENDENT_COMMANDS, #602): their
 *     execution and reply never reference the active canvas, so a stale stamp is irrelevant;
 *   • workflow_open / workflow_new: navigation/creation with their own explicit/new target;
 *   • workflow_list: the RECOVERY PROBE — see below;
 *   • workflow_rename / workflow_close whose selector resolves to a genuinely NON-active open
 *     workflow (`targetsNonActive` — via selectorTargetsNonActiveWorkflow): a deterministic
 *     close/rename of a DIFFERENT workflow must run. A path that resolves to the ACTIVE workflow
 *     (incl. after an in-place replacement) is NOT exempt — it is fenced.
 *  Other reads (graph_get_state, …) still return true here — harmlessly fenced (fail-closed);
 *  their reply is server-fenced anyway, and a read can only run against the active canvas
 *  regardless.
 *
 *  #932/#607/#688 — `workflow_list` is the ONE read for which "harmlessly fenced" was FALSE,
 *  and fencing it is what made the wedge PERMANENT rather than merely annoying. The
 *  orchestrator repairs a stale fence exactly one way: `rebindWorkflowFence()` probes with
 *  `workflow_list` and re-derives the stamp from the active record it returns. Fencing that
 *  probe makes the repair depend on the fence being already-correct — so a stale stamp refuses
 *  the only command that could refresh it, `panel_set_workflow_target({mode:"current"})` comes
 *  back "could not read the live canvas identity", and NOTHING inside the protocol can clear
 *  it. That circularity, not the refusal itself, is what those reports describe as "the
 *  documented recovery paths do not clear the guard"; the advertised remedy was a no-op and a
 *  browser reload was the only exit.
 *
 *  Exempting it does not weaken the guard the fence exists to be. The fence stops a command
 *  from being APPLIED to a canvas it was not issued for. `workflow_list` applies nothing: it
 *  mutates no graph, names no target (it enumerates every open tab rather than selecting one),
 *  and its reply carries tab METADATA only — path, title, routing key, active/modified flags —
 *  never graph content. Decisively, its handler reads the LIVE binding at execution time
 *  (`liveWorkflowListActive()`), so a stale stamp cannot make it report a stale answer: the
 *  reply describes the canvas that is actually active, which is precisely the fact the caller
 *  needs in order to stop being wrong. A read that cannot be misapplied has nothing to fence,
 *  and this one is the way back. */
export function activeWorkflowFenceApplies({ cmd, targetsNonActive = false } = {}) {
  if (commandIsCanvasTargetless(cmd)) return false;
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
 *  stamp is also a mismatch for an active-workflow mutation: this panel advertises the
 *  workflow-stamp capability, so accepting an unstamped protected command would make that
 *  advertised fence fail open (#718). */
export function commandWorkflowMismatch({ commandUuid, activeUuid } = {}) {
  if (typeof commandUuid !== 'string' || !commandUuid.trim()) return true;
  return activeUuid !== commandUuid;
}

/**
 * Does this command still name the active workflow at the instant it is about
 * to mutate it? Most graph executors are synchronous, so their dispatch-time
 * fence is sufficient. An executor that awaits an external oracle before its
 * write must ask this again after that await: a user can switch canvases while
 * the promise is pending. Keeping the rule pure makes both checks identical.
 */
export function commandTargetsActiveWorkflow({
  cmd,
  commandUuid,
  activeUuid,
  targetsNonActive = false,
} = {}) {
  return !activeWorkflowFenceApplies({ cmd, targetsNonActive }) ||
    !commandWorkflowMismatch({ commandUuid, activeUuid });
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
