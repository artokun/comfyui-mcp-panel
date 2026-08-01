import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isThreadInScope,
  isWorkflowCreationLoad,
  normalizedWorkflowPath,
  resolveUnsavedInstanceUuid,
  shouldForkEmbeddedWorkflowUuid,
  shouldForkInPlaceReload,
  workflowAliasForPath
} from '../../web/js/lib/workflow-chat-identity.js'

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
  assert.equal(isWorkflowCreationLoad({ workflowArg: null }), true)
  assert.equal(isWorkflowCreationLoad({ workflowArg: undefined }), true)
  assert.equal(isWorkflowCreationLoad({ workflowArg: 'workflows/Unsaved Workflow.json' }), true)
})

test('#570 an external import with an openSource is a creation', () => {
  assert.equal(isWorkflowCreationLoad({ workflowArg: 'x.json', openSource: 'file_button' }), true)
  // Even if some future path passed an object, an explicit openSource still forks.
  assert.equal(isWorkflowCreationLoad({ workflowArg: new FakeComfyWorkflow('a'), openSource: 'file_drop' }), true)
})

test('#570 a REUSE (ComfyWorkflow object 4th arg, no openSource) is NOT forked — durable reload', () => {
  // reload-restore / tab-switch / undo / reroute-migration all pass the workflow OBJECT.
  assert.equal(isWorkflowCreationLoad({ workflowArg: new FakeComfyWorkflow('workflows/Unsaved Workflow.json') }), false)
})

test('#570 the panel\'s own same-workflow reload opts out via noFork (snapshot revert)', () => {
  assert.equal(isWorkflowCreationLoad({ workflowArg: null, noFork: true }), false)
  assert.equal(isWorkflowCreationLoad({ workflowArg: 'x.json', openSource: 'file_button', noFork: true }), false)
})

test('#570 FAIL-SAFE: an unrecognized/mis-shaped object 4th arg is forked (bias to fork)', () => {
  // A real reuse passes a ComfyWorkflow with a string `path`; anything else — an object
  // WITHOUT a path, or an array — is ambiguous and must fork rather than risk inheriting.
  assert.equal(isWorkflowCreationLoad({ workflowArg: {} }), true)
  assert.equal(isWorkflowCreationLoad({ workflowArg: { notAPath: 1 } }), true)
  assert.equal(isWorkflowCreationLoad({ workflowArg: { path: 123 } }), true) // path not a string
  assert.equal(isWorkflowCreationLoad({ workflowArg: [] }), true)
  // Only a ComfyWorkflow-shaped object (string path) is trusted as a reuse.
  assert.equal(isWorkflowCreationLoad({ workflowArg: { path: 'workflows/x.json' } }), false)
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
