import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeWorkflowFenceApplies,
  selectorSearchIncludesListed,
  selectorTargetsNonActiveWorkflow,
  commandWorkflowMismatch,
  isThreadInScope,
  isNewWorkflowLoad,
  normalizedWorkflowPath,
  resolveUnsavedInstanceUuid,
  shouldForkEmbeddedWorkflowUuid,
  shouldForkInPlaceReload,
  workflowAliasForPath
} from '../../web/js/lib/workflow-chat-identity.js'

// #570 P0c — the exemption is decided by the RESOLVED TARGET, not raw path presence.
test('#570 selectorTargetsNonActiveWorkflow: exempt ONLY when the selector resolves to a NON-active open workflow', () => {
  const active = { path: 'workflows/foo.json' }
  const other = { path: 'workflows/bar.json' }
  // Resolves to a DIFFERENT open workflow → non-active → exempt (true).
  assert.equal(selectorTargetsNonActiveWorkflow({ resolved: other, active }), true)
  // Resolves to the ACTIVE workflow (incl. after an in-place replacement at the same path: the
  // active object is what the selector lands on) → NOT exempt (false) → will be fenced.
  assert.equal(selectorTargetsNonActiveWorkflow({ resolved: active, active }), false)
  // Resolves to NOTHING → can't prove non-active → NOT exempt (false) → fenced (fail-closed).
  assert.equal(selectorTargetsNonActiveWorkflow({ resolved: null, active }), false)
  assert.equal(selectorTargetsNonActiveWorkflow({ resolved: undefined, active }), false)
})

test('#570 P1: the fence/executor selector scope includes CLOSED-but-listed workflows for rename, open-only for close', () => {
  // The shared resolver keys the search collection on this, so the fence resolves over EXACTLY
  // what the executor searches — rename over [...openWorkflows, ...workflows], close over open only.
  assert.equal(selectorSearchIncludesListed('workflow_rename'), true)
  assert.equal(selectorSearchIncludesListed('workflow_close'), false)
})

test('#570 P1: a CLOSED-but-listed rename target (resolved via the executor collection) is exempt (not over-fenced)', () => {
  // workflow_rename resolves over [...openWorkflows, ...workflows], so a target present only in
  // `workflows` (closed but listed) DOES resolve to a genuine non-active workflow — the executor
  // would rename it — so the fence must exempt it. Models the resolved record the shared helper
  // returns for that selector (a real record distinct from the active object).
  const active = { path: 'workflows/foo.json' } // active canvas
  const closedButListed = { path: 'workflows/archived.json' } // only in s.workflows, not openWorkflows
  assert.equal(selectorTargetsNonActiveWorkflow({ resolved: closedButListed, active }), true)
})

// #570 P0c — the panel fence must cover ALL four active-workflow mutators, not just graph_*,
// so a panel advertising enforces_workflow_stamp honestly fences everything the server admits.
test('#570 fence applies to every graph_* op and all four workflow mutators (active-workflow ops)', () => {
  assert.equal(activeWorkflowFenceApplies({ cmd: 'graph_add_node' }), true)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'graph_get_state' }), true) // reads harmlessly fenced too
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_save' }), true)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_save_as' }), true)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_rename' }), true) // path-less ⇒ active
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_close' }), true)
  // A rename/close whose selector RESOLVED to the active workflow is fenced (the P0: an explicit
  // path that, after in-place replacement, names the active workflow).
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_close', targetsNonActive: false }), true)
})

test('#570 fence ALSO applies to PINNED commands (the pin guard authorizes by path, not uuid)', () => {
  // A pinned command (workflow_path present) is NOT exempt: after an in-place replacement at the
  // SAME saved path the pin still matches but the uuid does not, and only the uuid fence catches
  // it. activeWorkflowFenceApplies no longer takes a pin — the fence fires for pinned ops too.
  assert.equal(activeWorkflowFenceApplies({ cmd: 'graph_add_node' }), true)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_save' }), true)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'graph_set_widget' }), true)
})

test('#570 fence does NOT apply to navigation / resolved-non-active workflow ops', () => {
  // Navigation / creation.
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_open' }), false)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_new' }), false)
  // Selector RESOLVED to a genuinely non-active open workflow → deterministic target → runs.
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_close', targetsNonActive: true }), false)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_rename', targetsNonActive: true }), false)
})

test('#570 pinned command after in-place replacement at the same path: uuid mismatch ⇒ REFUSED', () => {
  // A pinned graph write stamped for A (uuid-A) whose workflow_path still matches the active
  // canvas — but the workflow at that path was replaced in place by B (uuid-B). The fence APPLIES
  // (pinned no longer exempt) and the uuid mismatch refuses it, protecting B.
  assert.equal(activeWorkflowFenceApplies({ cmd: 'graph_add_node' }), true)
  assert.equal(commandWorkflowMismatch({ commandUuid: 'uuid-A', activeUuid: 'uuid-B' }), true)
})

// #570 — WORKFLOW-INSTANCE FENCE. A command stamped for workflow A must not execute against
// a canvas the user has since switched to (B). The generation-bound-command leak: the server
// cannot retract a delivered frame, so the panel declines to apply a stale one.
test('#570 fence: stamped uuid matches the active workflow → execute', () => {
  assert.equal(commandWorkflowMismatch({ commandUuid: 'uuid-A', activeUuid: 'uuid-A' }), false)
})

test('#570 fence: stamped uuid differs from active (post-switch) → REJECT (no cross-apply)', () => {
  assert.equal(commandWorkflowMismatch({ commandUuid: 'uuid-A', activeUuid: 'uuid-B' }), true)
})

test('#570 fence: stamped uuid but active is UNRESOLVABLE → REJECT (fail closed, #186)', () => {
  assert.equal(commandWorkflowMismatch({ commandUuid: 'uuid-A', activeUuid: undefined }), true)
  assert.equal(commandWorkflowMismatch({ commandUuid: 'uuid-A', activeUuid: null }), true)
})

test('#570 fence: NO stamp (old orchestrator / identity-less tab) → never fenced', () => {
  assert.equal(commandWorkflowMismatch({ commandUuid: undefined, activeUuid: 'uuid-B' }), false)
  assert.equal(commandWorkflowMismatch({ commandUuid: '', activeUuid: 'uuid-B' }), false)
  assert.equal(commandWorkflowMismatch({ commandUuid: '   ', activeUuid: 'uuid-B' }), false)
  assert.equal(commandWorkflowMismatch({}), false)
})

// #570 — FAIL-CLOSED durability carrier. The embedded graph.extra uuid is only trustworthy
// when the creation-boundary wrapper (the sanitizer that re-mints graph.extra on every copy)
// is provably installed. If it is NOT, a pasted/imported unsaved graph could still carry the
// SOURCE uuid, so it must be ignored and a fresh per-instance uuid minted.
test('#570 unsaved uuid: live-object WeakMap value always wins (copy-safe)', () => {
  assert.equal(
    resolveUnsavedInstanceUuid({ objectUuid: 'live-A', embeddedId: 'copied-src', forkActive: true, mint: () => 'FRESH' }),
    'live-A'
  )
  // Even with the sanitizer off, the live object is authoritative.
  assert.equal(
    resolveUnsavedInstanceUuid({ objectUuid: 'live-A', embeddedId: 'copied-src', forkActive: false, mint: () => 'FRESH' }),
    'live-A'
  )
})

test('#570 unsaved uuid: embedded uuid trusted ONLY when the fork wrapper is installed (durable reload)', () => {
  assert.equal(
    resolveUnsavedInstanceUuid({ objectUuid: undefined, embeddedId: 'wf-uuid', forkActive: true, mint: () => 'FRESH' }),
    'wf-uuid'
  )
})

test('#570 unsaved uuid: fork wrapper NOT installed → embedded uuid ignored, mint fresh (no cross-resume)', () => {
  // The critical regression: loadGraphData unavailable / wrapping threw → a copied graph must
  // NOT adopt its source graph.extra uuid.
  assert.equal(
    resolveUnsavedInstanceUuid({ objectUuid: undefined, embeddedId: 'copied-src-uuid', forkActive: false, mint: () => 'FRESH' }),
    'FRESH'
  )
})

test('#570 unsaved uuid: no live object and no embedded → mint fresh regardless of fork state', () => {
  assert.equal(resolveUnsavedInstanceUuid({ forkActive: true, mint: () => 'FRESH' }), 'FRESH')
  assert.equal(resolveUnsavedInstanceUuid({ forkActive: false, mint: () => 'FRESH' }), 'FRESH')
})

// #570 P0b — an in-place load into an existing object must FORK when the content identity
// changed; a stale object-cache must never override the newly-loaded graph identity.
test('#570 P0b in-place replace (cached uuid, DIFFERENT incoming) → fork', () => {
  assert.equal(shouldForkInPlaceReload({ cachedUuid: 'uuid-A', incomingUuid: 'uuid-B' }), true)
  // Incoming has no embedded uuid at all → still fork (can't prove same content).
  assert.equal(shouldForkInPlaceReload({ cachedUuid: 'uuid-A', incomingUuid: undefined }), true)
})

test('#570 P0b same content reloaded/undone (cached === incoming) → keep', () => {
  assert.equal(shouldForkInPlaceReload({ cachedUuid: 'uuid-A', incomingUuid: 'uuid-A' }), false)
})

test('#570 P0b a fresh object (no cache) is NOT an in-place replace here → false', () => {
  // A brand-new object (reload-restore/copy) has no cache; creation/embedded handling covers it.
  assert.equal(shouldForkInPlaceReload({ cachedUuid: undefined, incomingUuid: 'uuid-A' }), false)
  assert.equal(shouldForkInPlaceReload({}), false)
})

// Fakes for the ComfyWorkflow 4th arg: a REUSE passes a ComfyWorkflow OBJECT; a CREATION
// passes null/undefined/string.
class FakeComfyWorkflow { constructor (path) { this.path = path } }

// #570 P0 — fork the per-instance identity at the workflow CREATION boundary.
test('#570 a CREATION (non-object 4th arg) is forked so a copy cannot inherit the source uuid', () => {
  // paste/new-blank pass null; open-file/duplicate/template pass a string filename.
  assert.equal(isNewWorkflowLoad({ workflowArg: null }), true)
  assert.equal(isNewWorkflowLoad({ workflowArg: undefined }), true)
  assert.equal(isNewWorkflowLoad({ workflowArg: 'workflows/Unsaved Workflow.json' }), true)
})

test('#570 an external import with an openSource is a creation', () => {
  assert.equal(isNewWorkflowLoad({ workflowArg: 'x.json', openSource: 'file_button' }), true)
  // Even if some future path passed an object, an explicit openSource still forks.
  assert.equal(isNewWorkflowLoad({ workflowArg: new FakeComfyWorkflow('a'), openSource: 'file_drop' }), true)
})

test('#570 a REUSE (ComfyWorkflow object 4th arg, no openSource) is NOT forked — durable reload', () => {
  // reload-restore / tab-switch / undo / reroute-migration all pass the workflow OBJECT.
  assert.equal(isNewWorkflowLoad({ workflowArg: new FakeComfyWorkflow('workflows/Unsaved Workflow.json') }), false)
})

test('#570 the panel\'s own same-workflow reload opts out via noFork (snapshot revert)', () => {
  assert.equal(isNewWorkflowLoad({ workflowArg: null, noFork: true }), false)
  assert.equal(isNewWorkflowLoad({ workflowArg: 'x.json', openSource: 'file_button', noFork: true }), false)
})

test('#570 FAIL-SAFE: an unrecognized/mis-shaped object 4th arg is forked (bias to fork)', () => {
  // A real reuse passes a ComfyWorkflow with a string `path`; anything else — an object
  // WITHOUT a path, or an array — is ambiguous and must fork rather than risk inheriting.
  assert.equal(isNewWorkflowLoad({ workflowArg: {} }), true)
  assert.equal(isNewWorkflowLoad({ workflowArg: { notAPath: 1 } }), true)
  assert.equal(isNewWorkflowLoad({ workflowArg: { path: 123 } }), true) // path not a string
  assert.equal(isNewWorkflowLoad({ workflowArg: [] }), true)
  // Only a ComfyWorkflow-shaped object (string path) is trusted as a reuse.
  assert.equal(isNewWorkflowLoad({ workflowArg: { path: 'workflows/x.json' } }), false)
})

test('normalizes Windows paths for stable identity comparisons', () => {
  assert.equal(
    normalizedWorkflowPath('Workflows\\Portrait.JSON'),
    'workflows/portrait.json'
  )
})

test('forks a copied workflow with an embedded UUID on a clean browser', () => {
  assert.equal(shouldForkEmbeddedWorkflowUuid({
    embeddedUuid: 'same-uuid',
    embeddedPath: 'workflows/original.json',
    currentPath: 'workflows/copy.json'
  }), true)
})

test('keeps identity for the same live object during rename or Save As', () => {
  assert.equal(shouldForkEmbeddedWorkflowUuid({
    objectUuid: 'same-uuid',
    embeddedUuid: 'same-uuid',
    embeddedPath: 'workflows/original.json',
    currentPath: 'workflows/renamed.json'
  }), false)
})

test('forks repeated aliases even for old workflows without an embedded path', () => {
  assert.equal(shouldForkEmbeddedWorkflowUuid({
    embeddedUuid: 'same-uuid',
    currentPath: 'workflows/copy.json',
    aliases: {
      'workflows/original.json': 'same-uuid'
    }
  }), true)
})

test('keeps the canonical path when stale aliases still mention the same UUID', () => {
  assert.equal(shouldForkEmbeddedWorkflowUuid({
    embeddedUuid: 'same-uuid',
    embeddedPath: 'workflows/current.json',
    currentPath: 'workflows/current.json',
    aliases: {
      'workflows/old-name.json': 'same-uuid',
      'workflows/current.json': 'same-uuid'
    }
  }), false)
})

test('reuses the path alias minted for an unsaved fork after a browser restart', () => {
  assert.equal(workflowAliasForPath({
    'workflows/original.json': 'embedded-original',
    'Workflows\\Copy.JSON': 'stable-fork'
  }, 'workflows/copy.json'), 'stable-fork')
})

test('scope guard authorizes only an exact workflow UUID key', () => {
  const thread = { workflowKey: 'workflow:abc-123' }
  assert.equal(isThreadInScope(thread, 'workflow:abc-123'), true)
  assert.equal(isThreadInScope(thread, 'workflow:abc'), false)
  assert.equal(isThreadInScope(thread, 'workflow:abc-123-copy'), false)
  assert.equal(isThreadInScope(thread, ''), false)
})
