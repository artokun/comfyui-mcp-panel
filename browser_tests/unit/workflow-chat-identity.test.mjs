import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isThreadInScope,
  isWorkflowCreationLoad,
  normalizedWorkflowPath,
  shouldForkEmbeddedWorkflowUuid,
  workflowAliasForPath
} from '../../web/js/lib/workflow-chat-identity.js'

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
