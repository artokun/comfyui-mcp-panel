// #1267 half (b) — a Save-As must ACKNOWLEDGE THE CAPTURE, not the call.
//
// Reported: "the tool reported the new workflow name, the active canvas reverted, and
// the newly named copy was EMPTY." The mechanism, read off the installed 1.47 frontend
// bundle rather than inferred:
//
//   ComfyWorkflow:  get activeState() { return this.changeTracker?.activeState ?? null }
//   ComfyWorkflow.save():  this.content = JSON.stringify(this.activeState); …POST…
//   workflowStore.saveAs(wf, path):  builds the copy UNLOADED (changeTracker = null)
//   workflowStore.openWorkflow(w):   if (isActive(w)) return w   ← returns without loading
//
// So the bytes a Save-As writes are the COPY's activeState at write time, and a copy
// whose tracker was never built serializes to the JSON literal `null`. `main` guarded
// this with a CAPABILITY check only ("openWorkflow exists, therefore the copy is
// loaded") — a dispatch receipt, not an effect. And every downstream guard confirms the
// bad write: the post-write read-back compares the target against the copy's OWN
// content, so `"null" === "null"` reads back as "ours" — a false success, not a catch.
//
// THE TWO EMPTY CASES MUST STAY DISTINGUISHABLE. A user can legitimately Save-As an
// empty canvas, and refusing that would be data loss pointed the other way. The signal
// is CAPTURE COMPLETION, never node count: the frontend's own blankGraph is
// {last_node_id:0,last_link_id:0,nodes:[],links:[],groups:[],config:{},extra:{},version:0.4}
// and LGraph.serialize() always returns an object carrying a `nodes` array. `nodes: []`
// saves; `null` refuses. Both directions are asserted below.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  saveActiveWorkflow,
  classifyGraphCapture,
  classifyWorkflowCapture
} from '../../web/js/lib/workflow-save.js'

// The frontend's own blankGraph (read out of the installed bundle) — what an EMPTY
// canvas actually serializes to. This is the shape the guard must never refuse.
const BLANK_GRAPH = {
  last_node_id: 0,
  last_link_id: 0,
  nodes: [],
  links: [],
  groups: [],
  config: {},
  extra: {},
  version: 0.4
}

const GRAPH_WITH_NODES = {
  ...BLANK_GRAPH,
  last_node_id: 2,
  nodes: [{ id: 1, type: 'CheckpointLoaderSimple' }, { id: 2, type: 'SaveImage' }]
}

/** A workflow-store double that models the REAL 1.47 data flow the bug lives in:
 *  the copy is created UNLOADED, `activeState` is derived from the change tracker,
 *  and the persist serializes `activeState` into `content` before writing it.
 *
 *  Knobs (each reproduces one real failure mode, none loosen an assertion):
 *    openLoadsCopy   — false ⇒ openWorkflow returns WITHOUT building a tracker
 *                      (the store's `if (isActive(w)) return w` early exit).
 *    dropTrackerAtWrite — true ⇒ the tracker vanishes inside save()'s own await
 *                      (the microtask gap it opens before reading activeState).
 *    sourceState     — what the SOURCE tab's graph is (an empty canvas is legal). */
function makeStore({
  files = [],
  active,
  openLoadsCopy = true,
  dropTrackerAtWrite = false
} = {}) {
  const disk = new Map()
  for (const f of files) disk.set(f, JSON.stringify({ id: 'source-uuid', ...GRAPH_WITH_NODES }))
  const lookup = new Map()
  if (active) lookup.set(active.path, active)
  const calls = []

  const svc = {
    activeWorkflow: active,
    calls,
    disk,
    lookup,
    getWorkflowByPath(path) {
      return lookup.get(path)
    },
    // workflowStore.saveAs: deep-copies the SOURCE's activeState into the copy's
    // content, mints a fresh id, and inserts an UNLOADED record at the target path.
    saveAs(wf, path) {
      calls.push(['saveAs', wf.path, path])
      const cloned = JSON.parse(JSON.stringify(wf.activeState))
      cloned.id = 'copy-uuid'
      const serialized = JSON.stringify(cloned)
      const copy = {
        path,
        filename: path.split('/').pop(),
        directory: path.split('/').slice(0, -1).join('/') || 'workflows',
        initialMode: wf.initialMode,
        size: -1,
        isPersisted: false,
        isTemporary: true,
        changeTracker: null, // UNLOADED — exactly as the real store leaves it
        content: serialized,
        originalContent: serialized,
        get activeState() {
          return this.changeTracker ? this.changeTracker.activeState : null
        }
      }
      lookup.set(path, copy)
      return copy
    },
    async openWorkflow(copy) {
      calls.push(['openWorkflow', copy.path])
      if (openLoadsCopy) {
        const state = JSON.parse(copy.content)
        copy.changeTracker = {
          activeState: state,
          initialState: state,
          prepareForSave() {}
        }
      }
      svc.activeWorkflow = copy
    },
    // ComfyWorkflow.save(): content := JSON.stringify(activeState), THEN POST.
    async saveWorkflow(wf) {
      if (dropTrackerAtWrite) wf.changeTracker = null // save()'s pre-read await gap
      wf.content = JSON.stringify(wf.activeState)
      calls.push(['saveWorkflow', wf.path, wf.content])
      disk.set(wf.path, wf.content)
    },
    async closeWorkflow(wf) {
      calls.push(['closeWorkflow', wf.path])
      lookup.delete(wf.path)
    },
    async renameWorkflow(wf, newPath) {
      calls.push(['renameWorkflow', wf.path, newPath])
      const bytes = disk.get(wf.path)
      disk.delete(wf.path)
      lookup.delete(wf.path)
      wf.path = newPath
      wf.filename = newPath.split('/').pop()
      disk.set(newPath, bytes)
      lookup.set(newPath, wf)
    }
  }
  return svc
}

function makeSource(state) {
  return {
    path: 'workflows/Src1267.json',
    filename: 'Src1267.json',
    directory: 'workflows',
    size: 4096,
    isPersisted: true,
    isTemporary: false,
    changeTracker: { activeState: state, prepareForSave() {} },
    get activeState() {
      return this.changeTracker ? this.changeTracker.activeState : null
    }
  }
}

const onDisk = (svc) => async (path) => (svc.disk.has(path) ? true : false)

// ---------------------------------------------------------------------------
// The classifier — the ONE definition both guards ask.
// ---------------------------------------------------------------------------

test('#1267: capture completion separates "never captured" from "genuinely empty"', () => {
  // NEVER CAPTURED — no serialization happened. No canvas can produce these.
  assert.equal(classifyGraphCapture(null), 'uncaptured')
  assert.equal(classifyGraphCapture('null'), 'uncaptured', 'the bytes an unloaded copy writes')
  assert.equal(classifyGraphCapture(''), 'uncaptured')
  assert.equal(classifyGraphCapture('   '), 'uncaptured')
  assert.equal(classifyGraphCapture(42), 'uncaptured')
  assert.equal(classifyGraphCapture([]), 'uncaptured')
  assert.equal(classifyGraphCapture({}), 'uncaptured', 'an object with no nodes array')

  // GENUINELY EMPTY — a COMPLETED serialization of an empty canvas. Must save.
  assert.equal(classifyGraphCapture(BLANK_GRAPH), 'captured')
  assert.equal(classifyGraphCapture(JSON.stringify(BLANK_GRAPH)), 'captured')
  assert.equal(classifyGraphCapture({ nodes: [] }), 'captured')
  assert.equal(classifyGraphCapture(GRAPH_WITH_NODES), 'captured')

  // UNKNOWN — nothing was observed, so nothing may be refused. On a real
  // ComfyWorkflow `activeState` is a class getter that yields null (never
  // undefined) when unloaded, so undefined means "this object does not expose it".
  assert.equal(classifyGraphCapture(undefined), 'unknown')
  assert.equal(classifyGraphCapture('{not json'), 'unknown')
  assert.equal(classifyWorkflowCapture(undefined), 'unknown')
  assert.equal(classifyWorkflowCapture({}), 'unknown', 'a stub with no activeState field')
  assert.equal(
    classifyWorkflowCapture({
      get activeState() {
        throw new Error('unreadable')
      }
    }),
    'unknown',
    'a throwing getter is unknown, never a refusal'
  )
  assert.equal(classifyWorkflowCapture({ activeState: null }), 'uncaptured')
  assert.equal(classifyWorkflowCapture({ activeState: BLANK_GRAPH }), 'captured')
})

// ---------------------------------------------------------------------------
// The CALL SITE — drive the real saveActiveWorkflow, not the helper.
// ---------------------------------------------------------------------------

test('#1267: openWorkflow returning without loading the copy REFUSES — no empty file is written', async () => {
  const active = makeSource(GRAPH_WITH_NODES)
  const svc = makeStore({ files: [active.path], active, openLoadsCopy: false })

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Copy1267', { existsOnDisk: onDisk(svc) }),
    /never captured|EMPTY workflow/,
    'refused rather than acknowledging a save it had not captured'
  )

  // The whole point: NOTHING was written.
  assert.ok(!svc.disk.has('workflows/Copy1267.json'), 'no file was created at the target')
  assert.ok(
    !svc.calls.some((c) => c[0] === 'saveWorkflow'),
    'the write was never attempted — this is a PRE-COMMIT refusal'
  )
  // …and the source is intact, with the user returned to it.
  assert.ok(svc.disk.has(active.path), 'the ORIGINAL file is untouched')
  assert.equal(svc.activeWorkflow, active, 'the previously-active tab was restored')
  assert.equal(svc.lookup.get('workflows/Copy1267.json'), undefined, 'the orphan copy was purged')
})

test('#1267 regression witness: main would have written the literal `null` and reported success', async () => {
  // Same double, with the guard's input removed from the equation: prove the double
  // really does reproduce the bug, so a green suite is not green by construction.
  const active = makeSource(GRAPH_WITH_NODES)
  const svc = makeStore({ files: [active.path], active, openLoadsCopy: false })
  const copy = svc.saveAs(active, 'workflows/Witness1267.json')
  await svc.openWorkflow(copy)
  await svc.saveWorkflow(copy)
  assert.equal(
    svc.disk.get('workflows/Witness1267.json'),
    'null',
    'an unloaded copy really does serialize to the JSON literal null'
  )
})

test('#1267 the OTHER direction: a legitimately EMPTY canvas still saves', async () => {
  // The guard must not become the same two-states-collapse pointed backwards. An
  // empty canvas is a COMPLETED capture (the frontend's blankGraph) and is a save
  // the user is entitled to.
  const active = makeSource(BLANK_GRAPH)
  const svc = makeStore({ files: [active.path], active })

  const saved = await saveActiveWorkflow(svc, 'EmptyOnPurpose', { existsOnDisk: onDisk(svc) })

  assert.equal(saved, 'EmptyOnPurpose')
  assert.ok(svc.disk.has('workflows/EmptyOnPurpose.json'), 'the empty workflow WAS saved')
  const written = JSON.parse(svc.disk.get('workflows/EmptyOnPurpose.json'))
  assert.deepEqual(written.nodes, [], 'and it is an honest empty graph, not a refusal')
  assert.ok(svc.disk.has(active.path), 'the original is still on disk (#226)')
})

test('#1267: a normal Save-As is unchanged — the copy carries the source graph', async () => {
  const active = makeSource(GRAPH_WITH_NODES)
  const svc = makeStore({ files: [active.path], active })

  const saved = await saveActiveWorkflow(svc, 'Copy1267', { existsOnDisk: onDisk(svc) })

  assert.equal(saved, 'Copy1267')
  const written = JSON.parse(svc.disk.get('workflows/Copy1267.json'))
  assert.equal(written.nodes.length, 2, 'the real graph landed')
  assert.ok(svc.disk.has(active.path), 'the original is still on disk (#226)')
})

test('#1267: a pre-commit refusal is NOT adopted by the post-commit reconciliation', async () => {
  // The failure handler exists to ADOPT a write that committed before its response
  // was lost. A refusal raised before any write must not travel that path, or the
  // refusal turns back into a reported success. Here the read-back oracle is rigged
  // to claim "ours" for anything — if the refusal were reconciled, this would resolve.
  const active = makeSource(GRAPH_WITH_NODES)
  const svc = makeStore({ files: [active.path], active, openLoadsCopy: false })
  let reconciled = 0

  await assert.rejects(
    () =>
      saveActiveWorkflow(svc, 'Copy1267', {
        existsOnDisk: onDisk(svc),
        reconcileSavedCopy: async () => {
          reconciled += 1
          return 'ours'
        }
      }),
    /never captured|EMPTY workflow/
  )
  assert.equal(reconciled, 0, 'the read-back oracle was never consulted for a pre-commit refusal')
  assert.ok(!svc.disk.has('workflows/Copy1267.json'), 'still nothing on disk')
})

test('#1267: state lost inside save()’s own await is reported, never acknowledged', async () => {
  // The residual the pre-write guard cannot reach: ComfyUI's save() awaits a dynamic
  // import before it reads activeState. Here the tracker dies in that gap, so the
  // write really does land — and it lands EMPTY. The reply must say so.
  const active = makeSource(GRAPH_WITH_NODES)
  const svc = makeStore({ files: [active.path], active, dropTrackerAtWrite: true })

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Copy1267', { existsOnDisk: onDisk(svc) }),
    /contain no graph|EMPTY/,
    'reported the bytes it observed, not the call it made'
  )
  assert.equal(svc.disk.get('workflows/Copy1267.json'), 'null', 'the empty write did happen')
  assert.ok(svc.disk.has(active.path), 'the original is untouched')
  assert.equal(svc.activeWorkflow, active, 'the previous tab was restored, not left on the husk')
})

test('#1267: the copy’s own read-back cannot see an empty write (why the guard is needed)', async () => {
  // Documents the collapse the fix removes: reconcileSavedCopy compares the target
  // against the COPY'S OWN content. When the copy wrote "null", the disk holds "null"
  // and the oracle says "ours" — a false success confirmed by the very check that was
  // supposed to catch it. With the guard in place the save never reaches that point.
  const active = makeSource(GRAPH_WITH_NODES)
  const svc = makeStore({ files: [active.path], active, dropTrackerAtWrite: true })
  const verdicts = []

  await assert.rejects(
    () =>
      saveActiveWorkflow(svc, 'Copy1267', {
        existsOnDisk: onDisk(svc),
        reconcileSavedCopy: async (path, copy) => {
          const v = svc.disk.get(path) === copy.content ? 'ours' : 'foreign'
          verdicts.push(v)
          return v
        }
      }),
    /contain no graph|EMPTY/
  )
  assert.deepEqual(verdicts, [], 'the bytes guard fires BEFORE the oracle can bless the empty file')
})
