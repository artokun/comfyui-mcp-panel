import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isThreadInScope,
  normalizedWorkflowPath,
  resolveUnsavedWorkflowUuid,
  shouldForkEmbeddedWorkflowUuid,
  workflowAliasForPath
} from '../../web/js/lib/workflow-chat-identity.js'

// #570 P0b/P1 — unsaved-workflow durable uuid keyed on (path, graph-id).
test('#570 reload of the same unsaved workflow reuses its stored uuid (P1 durability)', () => {
  const stored = { u: 'uuid-A', g: 'gid-A' }
  const r = resolveUnsavedWorkflowUuid({ stored, gid: 'gid-A', mint: 'fresh' })
  assert.equal(r.uuid, 'uuid-A') // same path + same graph id → continuity
  assert.equal(r.changed, false)
})

test('#570 a cold import (no stored entry for its deduped path) mints fresh (P0b)', () => {
  // The imported copy carries the SOURCE embedded uuid, but it lands on a brand-new
  // deduped path with no stored alias → it must NOT inherit the source identity.
  const r = resolveUnsavedWorkflowUuid({ stored: null, gid: 'gid-A', mint: 'fresh' })
  assert.equal(r.uuid, 'fresh')
  assert.equal(r.changed, true)
})

test('#570 a new workflow reusing a freed path slot does NOT inherit the old uuid (graph-id guard)', () => {
  const stored = { u: 'uuid-old', g: 'gid-old' }
  const r = resolveUnsavedWorkflowUuid({ stored, gid: 'gid-new', mint: 'fresh' })
  assert.equal(r.uuid, 'fresh') // same path, DIFFERENT graph id → different workflow
  assert.equal(r.changed, true)
})

test('#570 FAILS CLOSED when a graph id is unavailable (mints fresh, never path-only reuse)', () => {
  // A missing gid on either side can't prove continuity — reusing by path alone would
  // let a new workflow inherit a closed one that reused the path slot. Mint fresh.
  assert.equal(resolveUnsavedWorkflowUuid({ stored: { u: 'u', g: '' }, gid: 'g', mint: 'm' }).uuid, 'm')
  assert.equal(resolveUnsavedWorkflowUuid({ stored: { u: 'u', g: 'g' }, gid: '', mint: 'm' }).uuid, 'm')
})

test('#570 a read-only probe (no mint) returns null unless BOTH graph ids match', () => {
  assert.equal(resolveUnsavedWorkflowUuid({ stored: null, gid: 'g' }).uuid, null)
  assert.equal(resolveUnsavedWorkflowUuid({ stored: { u: 'u', g: 'gid-old' }, gid: 'gid-new' }).uuid, null)
  assert.equal(resolveUnsavedWorkflowUuid({ stored: { u: 'u', g: '' }, gid: 'g' }).uuid, null)
  assert.equal(resolveUnsavedWorkflowUuid({ stored: { u: 'u', g: 'g' }, gid: 'g' }).uuid, 'u')
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
