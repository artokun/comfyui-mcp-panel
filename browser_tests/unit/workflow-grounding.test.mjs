import assert from 'node:assert/strict'
import test from 'node:test'

import {
  needsGrounding,
  shouldGroundBeforeTurn,
  groundingIsSafe,
  groundActiveWorkflow
} from '../../web/js/lib/workflow-save.js'

// #330 — unsaved workflows were grounded ONLY on a brand-new chat (the freshChat
// gate). Continuing an existing chat inside an unsaved tab left the user's edits
// unprotected. Grounding must run on EVERY agent turn that targets an unsaved tab —
// but a per-turn auto-save must never overwrite a real file (drift #215/#226), never
// authorize on tab A and write to tab B (TOCTOU), and never duplicate on concurrent
// turns (single-flight).

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
// must STILL be a grounding candidate. A fresh-chat-only gate would return false.
test('shouldGroundBeforeTurn flags an unsaved tab on a CONTINUED (non-fresh) chat', () => {
  assert.equal(shouldGroundBeforeTurn({ isPersisted: false }, { freshChat: false }), true)
  assert.equal(shouldGroundBeforeTurn({ isTemporary: true }, { freshChat: false }), true)
})

test('shouldGroundBeforeTurn also flags an unsaved tab on a fresh chat, never a persisted one', () => {
  assert.equal(shouldGroundBeforeTurn({ isPersisted: false }, { freshChat: true }), true)
  assert.equal(shouldGroundBeforeTurn({ isPersisted: true, isTemporary: false }, { freshChat: true }), false)
  assert.equal(shouldGroundBeforeTurn({ isPersisted: true, isTemporary: false }, { freshChat: false }), false)
})

// groundingIsSafe authorizes a per-turn save ONLY on positive disk proof of absence.
test('groundingIsSafe grounds a placeholder tab the oracle PROVES absent (404)', async () => {
  assert.equal(
    await groundingIsSafe({ isPersisted: false, path: 'workflows/Unsaved Workflow.json' }, async () => false),
    true
  )
})

// #330 data-loss guard: a drifted-temporary workflow PRESENT on disk must never be
// auto-saved over. A flag-only predicate would authorize it; groundingIsSafe refuses.
test('groundingIsSafe REFUSES a drifted-temporary workflow that exists on disk', async () => {
  assert.equal(
    await groundingIsSafe({ isTemporary: true, isPersisted: false, path: 'workflows/MyFlow.json' }, async () => true),
    false
  )
})

// P1 — refuse whenever we cannot POSITIVELY prove absence: unknown/throwing oracle,
// missing oracle, AND the pathless case (cannot probe ⇒ do not blanket-approve).
test('groundingIsSafe fails safe (refuses) when absence cannot be proven', async () => {
  // unknown / throwing oracle
  assert.equal(await groundingIsSafe({ isTemporary: true, path: 'workflows/MyFlow.json' }, async () => null), false)
  assert.equal(
    await groundingIsSafe({ isTemporary: true, path: 'workflows/MyFlow.json' }, async () => { throw new Error('net') }),
    false
  )
  // no oracle at all
  assert.equal(await groundingIsSafe({ isTemporary: true, path: 'workflows/MyFlow.json' }), false)
  // pathless tab — cannot probe ⇒ refuse (even with an oracle available)
  assert.equal(await groundingIsSafe({ isPersisted: false }, async () => false), false)
  assert.equal(await groundingIsSafe({ isTemporary: true, path: '' }, async () => false), false)
})

test('groundingIsSafe never grounds a genuinely persisted workflow', async () => {
  assert.equal(
    await groundingIsSafe({ isPersisted: true, path: 'workflows/MyFlow.json' }, async () => false),
    false
  )
})

// P0 — the safety probe and the write must bind to the SAME workflow. If the user
// switches from a genuinely-temporary tab A to a drifted-temporary REAL tab B while
// A's disk HEAD is pending, A's 404 must NOT authorize a write to B. groundActiveWorkflow
// passes expect:A → saveActiveWorkflow refuses because activeWorkflow is now B.
test('groundActiveWorkflow REFUSES a tab switch during the probe — never overwrites tab B (P0)', async () => {
  const A = { isPersisted: false, isTemporary: true, path: 'workflows/Untitled A.json', filename: 'Untitled A', directory: 'workflows' }
  const B = { isPersisted: true, isTemporary: false, path: 'workflows/MyFlow.json', filename: 'MyFlow', directory: 'workflows' }
  let active = A
  const writes = []
  const svc = {
    get activeWorkflow() { return active },
    getWorkflowByPath: () => null,
    saveWorkflow: async (wf) => { writes.push(['saveWorkflow', wf.path]) },
    saveWorkflowAs: async (wf) => { writes.push(['saveWorkflowAs', wf.path]) },
    saveAs: (wf, path) => { writes.push(['saveAs', path]); return { path, filename: path.split('/').pop() } },
    openWorkflow: async () => {},
    renameWorkflow: async () => { writes.push(['renameWorkflow']) }
  }
  // A's HEAD proves absent (safe) but the user switches to B during the await.
  const existsOnDisk = async () => { active = B; return false }
  const result = await groundActiveWorkflow(svc, { existsOnDisk, autoWorkflowName: () => 'Untitled X' })
  assert.equal(result, null)      // refused — nothing saved
  assert.equal(writes.length, 0)  // B's real file was NEVER written
})

// P1 — a single-flight guard: two concurrent turns must produce exactly ONE grounded
// copy, not two (delayed HEADs crossing the auto-name boundary otherwise double-save).
test('groundActiveWorkflow single-flights concurrent turns into ONE save (no duplicate)', async () => {
  const A = { isPersisted: false, isTemporary: true, path: 'workflows/Unsaved Workflow.json', filename: 'Unsaved Workflow', directory: 'workflows', initialMode: 'default' }
  let active = A
  const disk = new Set(['workflows/Unsaved Workflow.json'])
  let copySaves = 0
  const svc = {
    get activeWorkflow() { return active },
    set activeWorkflow(v) { active = v },
    getWorkflowByPath: (p) => (disk.has(p) && p !== A.path ? { path: p, isPersisted: true } : (active && active.path === p ? active : null)),
    saveAs: (wf, path) => ({ path, filename: path.split('/').pop(), directory: 'workflows', initialMode: 'default', isPersisted: false, isTemporary: true, changeTracker: { prepareForSave() {} } }),
    openWorkflow: async (copy) => { active = copy },
    saveWorkflow: async (copy) => { copySaves += 1; disk.add(copy.path) }
  }
  // Slow, always-absent HEAD so both turns overlap before either save completes.
  const existsOnDisk = async () => { await new Promise((r) => setTimeout(r, 5)); return false }
  const opts = { existsOnDisk, autoWorkflowName: () => 'Untitled X', reconcileSavedCopy: async () => 'unknown' }
  await Promise.all([groundActiveWorkflow(svc, opts), groundActiveWorkflow(svc, opts)])
  assert.equal(copySaves, 1) // exactly one grounded copy despite two concurrent turns
})

// P1 (deeper interleaving) — the atomic copy-trio activates a FRESH temporary copy
// (openWorkflow) BEFORE its write commits. A turn arriving in THAT window must not
// ground the pre-commit copy as a second save. Serializing per SERVICE prevents it.
test('groundActiveWorkflow does not double-save a turn that arrives during the copy pre-commit window', async () => {
  const A = { isPersisted: false, isTemporary: true, path: 'workflows/Unsaved Workflow.json', filename: 'Unsaved Workflow', directory: 'workflows', initialMode: 'default' }
  let active = A
  const disk = new Set([A.path])
  let copySaves = 0
  let firstSave = true
  let releaseSave
  const saveGate = new Promise((r) => { releaseSave = r })
  const svc = {
    get activeWorkflow() { return active },
    set activeWorkflow(v) { active = v },
    getWorkflowByPath: (p) => (disk.has(p) && p !== A.path ? { path: p, isPersisted: true } : (active && active.path === p ? active : null)),
    saveAs: (wf, path) => ({ path, filename: path.split('/').pop(), directory: 'workflows', initialMode: 'default', isPersisted: false, isTemporary: true, changeTracker: { prepareForSave() {} } }),
    openWorkflow: async (copy) => { active = copy }, // copy becomes active BEFORE the commit
    saveWorkflow: async (copy) => {
      if (firstSave) { firstSave = false; await saveGate } // hang the first commit
      copySaves += 1
      disk.add(copy.path)
      copy.isPersisted = true
      copy.isTemporary = false
    }
  }
  const opts = { existsOnDisk: async () => false, autoWorkflowName: () => 'Untitled X', reconcileSavedCopy: async () => 'unknown' }
  const p1 = groundActiveWorkflow(svc, opts)
  await new Promise((r) => setTimeout(r, 15)) // let turn1 reach the hung commit (active is now the copy)
  const p2 = groundActiveWorkflow(svc, opts) // arrives DURING the copy pre-commit window
  await new Promise((r) => setTimeout(r, 5))
  releaseSave()
  await Promise.all([p1, p2])
  assert.equal(copySaves, 1) // the pre-commit copy was NOT grounded a second time
})
