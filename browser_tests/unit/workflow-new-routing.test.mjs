// #186 — panel_new_workflow collides with an existing "Unsaved Workflow" tab and
// graph_* edits silently misroute to the wrong graph.
//
// Root cause: native ComfyUI reuses the "Unsaved Workflow" TITLE/key and gives a
// never-saved tab no path, so two unsaved tabs were indistinguishable — both to
// panel_list_workflows (dedupe collapsed them to one) and to the pinned-target
// guard (a pin to tab B matched whichever unsaved tab was active). The fix gives
// every tab a unique per-instance routing id ("tmp:<uuid>" for unsaved, "wf:<path>"
// for saved), makes that id the SOLE authority for an unsaved tab, and threads it
// through the list, the pin, the guard, and workflow_open/rename/close.
//
// These tests drive the REAL decision helpers the panel uses:
//   • classifyPinnedTarget / workflowIdentityForms — the guard's match/mismatch,
//   • dedupeWorkflowTabRecords / workflowTabKey — the list de-duplication,
// with a two-unsaved-tab scenario. Each has a FAIL-BEFORE assertion (the pre-fix
// shape false-passes) next to the PASS-AFTER assertion (the fix fails closed).

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyPinnedTarget,
  workflowIdentityForms
} from '../../web/js/lib/workflow-chat-identity.js'
import {
  dedupeWorkflowTabRecords,
  workflowTabKey
} from '../../web/js/lib/session-rebind.js'

// Native ComfyUI shape for an UNSAVED tab: shared title/key, no disk path, and the
// isTemporary/isPersisted flags that mark it never-saved.
const unsavedWf = () => ({
  path: undefined,
  filename: undefined,
  key: 'Unsaved Workflow',
  isPersisted: false,
  isTemporary: true
})
// A PERSISTED tab: unique on-disk identity.
const savedWf = (p) => ({
  path: p,
  filename: p.split('/').pop(),
  key: p,
  isPersisted: true,
  isTemporary: false
})

// ---------------------------------------------------------------------------
// Authority model: an unsaved tab answers ONLY to its routing id; a saved tab
// answers to its unique on-disk forms too.
// ---------------------------------------------------------------------------

test('an unsaved tab authorizes ONLY its routing id — never the shared title/key', () => {
  const forms = workflowIdentityForms(unsavedWf(), 'tmp:AAA')
  assert.deepEqual(forms, ['tmp:AAA'], 'shared native key/title/path must NOT be authority for an unsaved tab')
})

test('a persisted tab authorizes by path / filename / key / wf: form and its routing id', () => {
  const forms = workflowIdentityForms(savedWf('workflows/Foo.json'), 'wf:workflows/Foo.json')
  assert.ok(forms.includes('workflows/Foo.json'))
  assert.ok(forms.includes('Foo.json'))
  assert.ok(forms.includes('wf:workflows/Foo.json'))
})

test('#349 no regression under isTemporary flag-drift: a persisted file still authorizes by path', () => {
  // A workflow that IS on disk (isPersisted:true) but is transiently mis-flagged
  // isTemporary:true after an open-ack race (#215). Its unique disk path must still
  // authorize a path pin — keying authority on isTemporary would spuriously reject.
  const drifted = { path: 'workflows/Foo.json', filename: 'Foo.json', key: 'workflows/Foo.json', isPersisted: true, isTemporary: true }
  const forms = workflowIdentityForms(drifted, 'tmp:driftfresh')
  assert.equal(classifyPinnedTarget('workflows/Foo.json', forms), 'match', 'a correct path pin must not fail under flag-drift')
})

test('#186 same-instance save: a pre-save tmp: pin still matches the tab after it is saved', () => {
  // create → pin("tmp:XYZ") → build → SAVE, on a frontend whose save keeps the SAME
  // workflow OBJECT (ComfyUI 1.45): post-save the routing id is now "wf:...", but the
  // orchestrator keeps injecting the old "tmp:XYZ" pin. The panel passes the retained
  // original tmp: id (from _priorTempWorkflowIds, object-keyed) as an extra authority
  // so the flow continues instead of failing closed. (On 1.47 the save REPLACES the
  // object, so the tmp id is legitimately gone and the guard fails CLOSED with a
  // re-target instruction — a safe, non-misrouting outcome, covered in the panel.)
  const savedAfter = savedWf('workflows/MyFlow.json')
  const forms = workflowIdentityForms(savedAfter, 'wf:workflows/MyFlow.json', ['tmp:XYZ'])
  assert.equal(classifyPinnedTarget('tmp:XYZ', forms), 'match', 'pre-save pin must survive a same-object save')
  // ...but the tmp: id of a DIFFERENT tab must NOT match it (no cross-tab leak).
  assert.equal(classifyPinnedTarget('tmp:OTHER', forms), 'mismatch')
})

test('matching is CASE-SENSITIVE so distinct files on a case-sensitive FS never fail open', () => {
  // #207 preserves case because "Foo.json" and "foo.json" are different files on
  // Linux. A pin must not authorize the wrong graph by case-folding.
  const forms = workflowIdentityForms(savedWf('workflows/Foo.json'), 'wf:workflows/Foo.json')
  assert.equal(classifyPinnedTarget('workflows/foo.json', forms), 'mismatch', 'case-variant path must fail closed')
  assert.equal(classifyPinnedTarget('workflows/Foo.json', forms), 'match')
  // Backslash vs forward slash IS normalized (same file, Windows path form).
  assert.equal(classifyPinnedTarget('workflows\\Foo.json', forms), 'match', 'separators are normalized')
})

// ---------------------------------------------------------------------------
// Guard: pinned-target match/mismatch (the silent-misroute half of #186).
// ---------------------------------------------------------------------------

test('#186 fail-closed: a pin to a NEW unsaved tab mismatches a DIFFERENT active unsaved tab', () => {
  // Agent created tab B via panel_new_workflow (routing id "tmp:BBB") and pinned to
  // it, but the active canvas snapped back to the pre-existing tab A ("tmp:AAA").
  const activeForms = workflowIdentityForms(unsavedWf(), 'tmp:AAA')

  // PASS-AFTER: the routing id makes the two unsaved tabs distinguishable, so the
  // pin to tab B is a POSITIVE mismatch against active tab A → fail closed.
  assert.equal(
    classifyPinnedTarget('tmp:BBB', activeForms),
    'mismatch',
    'editing tab A while pinned to tab B must fail closed, not silently misroute'
  )

  // PASS-AFTER: even the shared native title/key ("Unsaved Workflow"), which
  // workflow_new still returns as `active` and which a naive agent might pin, no
  // longer authorizes ANY unsaved tab — it fails closed instead of misrouting.
  assert.equal(
    classifyPinnedTarget('Unsaved Workflow', activeForms),
    'mismatch',
    'a shared-title pin must fail closed post-fix'
  )

  // FAIL-BEFORE: the pre-fix identity forms INCLUDED the shared native key for
  // unsaved tabs, so a pin to that key matched whatever unsaved tab was active —
  // exactly the silent misroute #186 reported.
  const preFixForms = ['Unsaved Workflow'] // wf.key was authority pre-fix
  assert.equal(
    classifyPinnedTarget('Unsaved Workflow', preFixForms),
    'match',
    'documents the pre-fix false-pass the routing-id-only authority closes'
  )
})

test('#186 the correctly-targeted unsaved tab still matches its own routing id', () => {
  const activeForms = workflowIdentityForms(unsavedWf(), 'tmp:BBB')
  assert.equal(classifyPinnedTarget('tmp:BBB', activeForms), 'match')
})

test('two unsaved tabs never share a routing id, so cross-pins fail closed both ways', () => {
  const aActive = workflowIdentityForms(unsavedWf(), 'tmp:AAA')
  const bActive = workflowIdentityForms(unsavedWf(), 'tmp:BBB')
  assert.equal(classifyPinnedTarget('tmp:AAA', aActive), 'match')
  assert.equal(classifyPinnedTarget('tmp:BBB', aActive), 'mismatch')
  assert.equal(classifyPinnedTarget('tmp:BBB', bActive), 'match')
  assert.equal(classifyPinnedTarget('tmp:AAA', bActive), 'mismatch')
})

test('no regression to #349: a saved-workflow pin matches by path / filename / key / wf: form', () => {
  const forms = workflowIdentityForms(savedWf('workflows/Foo.json'), 'wf:workflows/Foo.json')
  for (const pin of [
    'workflows/Foo.json', //         raw path
    'wf:workflows/Foo.json', //      canonical routing id
    'Foo.json', //                   filename
    'Foo' //                         filename sans .json (case-normalized)
  ]) {
    assert.equal(classifyPinnedTarget(pin, forms), 'match', `pin "${pin}" should match the saved wf`)
  }
  // A pin to a DIFFERENT saved workflow is a positive mismatch (fail closed).
  assert.equal(classifyPinnedTarget('workflows/Bar.json', forms), 'mismatch')
})

test('classifier is 3-valued: indeterminate inputs are "unknown" (the guard fails closed on them)', () => {
  // The PURE classifier reports "unknown" when it cannot decide — no active identity
  // forms, or an empty/blank pin. The GUARD turns a non-empty pin + "unknown" into a
  // fail-closed error (it cannot confirm the pin names the live canvas); a blank pin
  // never reaches the guard (it gates on pinnedPath.trim()). This test pins the
  // function contract, not the policy.
  assert.equal(classifyPinnedTarget('tmp:BBB', []), 'unknown') // unresolvable active workflow
  const forms = workflowIdentityForms(unsavedWf(), 'tmp:AAA')
  assert.equal(classifyPinnedTarget('', forms), 'unknown')
  assert.equal(classifyPinnedTarget('   ', forms), 'unknown')
  assert.equal(classifyPinnedTarget(undefined, forms), 'unknown')
})

// ---------------------------------------------------------------------------
// List: panel_list_workflows de-duplication (the "only one Unsaved Workflow
// shown" half of #186).
// ---------------------------------------------------------------------------

test('#186 list: distinct unsaved tabs survive dedupe once keyed by routing id', () => {
  // PASS-AFTER: the fixed brief() reports path:null and key:<routing id> for unsaved
  // tabs, so the two tabs carry distinct stable keys and both appear.
  const fixed = [
    { path: null, filename: undefined, key: 'tmp:AAA', routing_key: 'tmp:AAA', active: true, persisted: false },
    { path: null, filename: undefined, key: 'tmp:BBB', routing_key: 'tmp:BBB', active: false, persisted: false }
  ]
  assert.notEqual(workflowTabKey(fixed[0]), workflowTabKey(fixed[1]), 'unsaved tabs must key distinctly')
  assert.equal(dedupeWorkflowTabRecords(fixed).length, 2, 'both unsaved tabs must be listed')

  // FAIL-BEFORE: the pre-fix brief() reported the shared native key (and, per the
  // report, a synthesized "Unsaved Workflow.json" path) for every unsaved tab, so
  // dedupe collapsed them to one — hiding the second tab.
  const preFix = [
    { path: 'workflows/Unsaved Workflow.json', filename: 'Unsaved Workflow.json', key: 'Unsaved Workflow', active: true },
    { path: 'workflows/Unsaved Workflow.json', filename: 'Unsaved Workflow.json', key: 'Unsaved Workflow', active: false }
  ]
  assert.equal(workflowTabKey(preFix[0]), workflowTabKey(preFix[1]), 'documents the pre-fix key collision')
  assert.equal(dedupeWorkflowTabRecords(preFix).length, 1, 'documents the pre-fix collapse to one tab')
})
