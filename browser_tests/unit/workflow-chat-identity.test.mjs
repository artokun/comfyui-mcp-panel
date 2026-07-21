import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isThreadInScope,
  normalizedWorkflowPath,
  shouldForkEmbeddedWorkflowUuid,
  workflowAliasForPath
} from '../../web/js/lib/workflow-chat-identity.js'

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
