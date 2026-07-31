import assert from 'node:assert/strict'
import test from 'node:test'

import {
  needsGrounding,
  shouldGroundBeforeTurn,
  groundingIsSafe
} from '../../web/js/lib/workflow-save.js'

// #330 — unsaved workflows were grounded ONLY on a brand-new chat (the freshChat
// gate). Continuing an existing chat inside an unsaved tab left the user's edits
// unprotected. Grounding must run on EVERY agent turn that targets an unsaved tab.

test('needsGrounding is true for a never-persisted / temporary workflow', () => {
  assert.equal(needsGrounding({ isPersisted: false }), true)
  assert.equal(needsGrounding({ isTemporary: true }), true)
})

test('needsGrounding is false for a persisted workflow and for no workflow', () => {
  assert.equal(needsGrounding({ isPersisted: true, isTemporary: false }), false)
  assert.equal(needsGrounding(null), false)
  assert.equal(needsGrounding(undefined), false)
})

// CORE #330 regression: a CONTINUED chat (freshChat === false) on an unsaved tab
// must STILL ground. A fresh-chat-only gate (freshChat && needsGrounding) would
// return false here — this test fails against that old behavior and passes now.
test('shouldGroundBeforeTurn grounds an unsaved tab on a CONTINUED (non-fresh) chat', () => {
  assert.equal(
    shouldGroundBeforeTurn({ isPersisted: false }, { freshChat: false }),
    true
  )
  assert.equal(
    shouldGroundBeforeTurn({ isTemporary: true }, { freshChat: false }),
    true
  )
})

test('shouldGroundBeforeTurn also grounds an unsaved tab on a fresh chat', () => {
  assert.equal(
    shouldGroundBeforeTurn({ isPersisted: false }, { freshChat: true }),
    true
  )
})

test('shouldGroundBeforeTurn never grounds an already-persisted workflow', () => {
  assert.equal(
    shouldGroundBeforeTurn({ isPersisted: true, isTemporary: false }, { freshChat: true }),
    false
  )
  assert.equal(
    shouldGroundBeforeTurn({ isPersisted: true, isTemporary: false }, { freshChat: false }),
    false
  )
})

// #330 safety gate — a per-turn save must NOT overwrite a real on-disk file whose
// `isTemporary` flag merely drifted (#215/#226). groundingIsSafe authorizes a save
// only when the source is PROVABLY never-persisted via the disk oracle.
test('groundingIsSafe grounds a brand-new tab with no backing path (no oracle needed)', async () => {
  assert.equal(await groundingIsSafe({ isPersisted: false }, async () => 404), true)
  assert.equal(await groundingIsSafe({ isTemporary: true, path: '' }, async () => 404), true)
})

test('groundingIsSafe grounds a placeholder tab the oracle PROVES absent (404)', async () => {
  const oracle = async () => false // 404 → absent
  assert.equal(
    await groundingIsSafe({ isPersisted: false, path: 'workflows/Unsaved Workflow.json' }, oracle),
    true
  )
})

// CORE #330 data-loss guard: a workflow flagged temporary (drifted) but PRESENT on
// disk must NEVER be auto-saved over. FAIL-BEFORE (flag-only needsGrounding) would
// authorize the overwrite; groundingIsSafe refuses it.
test('groundingIsSafe REFUSES a drifted-temporary workflow that exists on disk', async () => {
  const oracle = async () => true // 200 → real file present
  assert.equal(
    await groundingIsSafe({ isTemporary: true, isPersisted: false, path: 'workflows/MyFlow.json' }, oracle),
    false
  )
})

test('groundingIsSafe fails safe (refuses) when the disk oracle is unknown or missing', async () => {
  assert.equal(
    await groundingIsSafe({ isTemporary: true, path: 'workflows/MyFlow.json' }, async () => null),
    false
  )
  assert.equal(
    await groundingIsSafe({ isTemporary: true, path: 'workflows/MyFlow.json' }, async () => { throw new Error('net') }),
    false
  )
  // No oracle function at all ⇒ cannot prove ⇒ refuse.
  assert.equal(
    await groundingIsSafe({ isTemporary: true, path: 'workflows/MyFlow.json' }),
    false
  )
})

test('groundingIsSafe never grounds a genuinely persisted workflow', async () => {
  assert.equal(
    await groundingIsSafe({ isPersisted: true, path: 'workflows/MyFlow.json' }, async () => false),
    false
  )
})
