import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isDefaultWorkflowName,
  saveActiveWorkflow,
  describeSaveOutcome,
  classifyOriginalOnDisk,
  diskExistenceFromStatus
} from '../../web/js/lib/workflow-save.js'

// A minimal ComfyUI workflow-service double that records what was called and
// simulates the on-disk file set, so we can prove Save-As never consumes the
// source file (issue #226).
// Production-accurate extension derivation (mirrors ComfyUI formatUtil):
// app-mode workflows persist as "<base>.app.json", everything else as
// "<base>.json".
const extFor = (wf) => (wf.initialMode === 'app' ? '.app.json' : '.json')
const stripExt = (name) => {
  const s = String(name || '')
  const lower = s.toLowerCase()
  if (lower.endsWith('.app.json')) return s.slice(0, -'.app.json'.length)
  if (lower.endsWith('.json')) return s.slice(0, -'.json'.length)
  return s
}

function makeService({ files = [], active } = {}) {
  const disk = new Set(files)
  const calls = []
  const svc = {
    activeWorkflow: active,
    calls,
    disk,
    // The real store always exposes getWorkflowByPath (a REQUIRED member); the copy
    // path's final synchronous collision re-check needs it. Nothing on disk / not the
    // active tab ⇒ the target is free.
    getWorkflowByPath(path) {
      if (active && active.path === path) return active
      if (disk.has(path)) return { path, isPersisted: true }
      return null
    },
    // Mirrors ComfyUI's saveWorkflow: it recomputes the expected path from the
    // workflow's mode-derived extension, and if that differs from the current
    // path it RENAMES (moves) the file before saving. This is the exact upstream
    // mechanism the panel must never trigger on a persisted source (#226).
    async saveWorkflow(wf) {
      const dir = wf.directory || 'workflows'
      const expected = `${dir}/${stripExt(wf.filename)}${extFor(wf)}`
      if (wf.path !== expected) {
        await svc.renameWorkflow(wf, expected)
      }
      calls.push(['saveWorkflow', wf.path])
      disk.add(wf.path) // overwrite / create in place
    },
    async renameWorkflow(wf, newPath) {
      calls.push(['renameWorkflow', wf.path, newPath])
      // rename = MOVE: consumes the source path.
      disk.delete(wf.path)
      wf.path = newPath
      wf.filename = newPath.split('/').pop()
      disk.add(newPath)
    },
    async saveWorkflowAs(wf, { filename }) {
      // Present but the panel must PREFER the atomic low-level trio over this
      // (potentially-overwriting) high-level API — its presence lets tests prove we
      // never call it. Modeled as a safe copy so a wrong call would still "succeed".
      calls.push(['saveWorkflowAs', wf.path, filename])
      const dir = wf.directory || 'workflows'
      const base = stripExt(filename)
      const newFilename = `${base}${extFor(wf)}`
      const newPath = `${dir}/${newFilename}`
      disk.add(newPath)
      svc.activeWorkflow = {
        path: newPath,
        filename: newFilename,
        directory: dir,
        initialMode: wf.initialMode,
        isPersisted: true,
        isTemporary: false
      }
    },
    // Low-level ATOMIC copy trio (the route the real 1.47.x frontend exposes). saveAs
    // builds a NEW copy object at an explicit target; openWorkflow activates it;
    // saveWorkflow persists it. The source object + file are never touched (#226).
    saveAs(wf, path) {
      calls.push(['saveAs', wf.path, path])
      return {
        path,
        filename: path.split('/').pop(),
        directory: path.split('/').slice(0, -1).join('/') || 'workflows',
        initialMode: wf.initialMode,
        isPersisted: false,
        isTemporary: true,
        changeTracker: { prepareForSave() {} }
      }
    },
    async openWorkflow(copy) {
      calls.push(['openWorkflow', copy.path])
      svc.activeWorkflow = copy
    }
  }
  return svc
}

test('isDefaultWorkflowName flags placeholder names only', () => {
  assert.equal(isDefaultWorkflowName('Unsaved Workflow'), true)
  assert.equal(isDefaultWorkflowName('Unsaved Workflow (2)'), true)
  assert.equal(isDefaultWorkflowName('Untitled 2026-07-24 10-00-00'), true)
  assert.equal(isDefaultWorkflowName(''), true)
  assert.equal(isDefaultWorkflowName('LTX EROS Extend'), false)
})

test('Save-As with a new name COPIES and leaves the original file on disk (#226)', async () => {
  const active = {
    path: 'workflows/_a_exporter/Foo.json',
    filename: 'Foo.json',
    directory: 'workflows/_a_exporter',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeService({ files: [active.path], active })

  const saved = await saveActiveWorkflow(svc, 'Bar', {
    autoWorkflowName: () => 'Untitled'
  })

  // The original source file must still exist — NOT moved/renamed.
  assert.ok(svc.disk.has('workflows/_a_exporter/Foo.json'), 'original preserved')
  // A new copy exists, in the SAME containing folder (folder preserved).
  assert.ok(svc.disk.has('workflows/_a_exporter/Bar.json'), 'copy created in place')
  // It went through the ATOMIC low-level copy path — never the overwriting
  // high-level saveWorkflowAs, and never renameWorkflow.
  assert.ok(
    svc.calls.some((c) => c[0] === 'saveAs'),
    'used the atomic low-level saveAs copy'
  )
  assert.ok(
    !svc.calls.some((c) => c[0] === 'saveWorkflowAs'),
    'never called the overwriting high-level saveWorkflowAs'
  )
  assert.ok(
    !svc.calls.some((c) => c[0] === 'renameWorkflow'),
    'never renamed the source'
  )
  assert.equal(saved, 'Bar')
})

test('save-in-place (same name) overwrites the same file, no copy', async () => {
  const active = {
    path: 'workflows/Foo.json',
    filename: 'Foo.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeService({ files: [active.path], active })

  const saved = await saveActiveWorkflow(svc, 'Foo', {})

  assert.deepEqual(svc.calls, [['saveWorkflow', 'workflows/Foo.json']])
  assert.equal(svc.disk.size, 1)
  assert.equal(saved, 'Foo')
})

test('workflow_save with no name saves the current persisted file in place', async () => {
  const active = {
    path: 'workflows/Foo.json',
    filename: 'Foo.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeService({ files: [active.path], active })

  await saveActiveWorkflow(svc, undefined, { autoWorkflowName: () => 'Untitled' })

  assert.deepEqual(svc.calls, [['saveWorkflow', 'workflows/Foo.json']])
})

test('a never-saved placeholder tab is grounded safely via the FAITHFUL frontend (temporary->rename branch, no source to destroy)', async () => {
  // Retested against the faithful 1.45.21 double whose saveWorkflowAs takes the
  // temporary->renameWorkflow branch. A genuine placeholder temp has NO backing
  // file, so the rename is safe: it just names the never-saved tab.
  const active = {
    path: 'workflows/Unsaved Workflow.json',
    filename: 'Unsaved Workflow.json',
    directory: 'workflows',
    isPersisted: false,
    isTemporary: true
  }
  const svc = makeFaithfulService({ active }) // disk starts EMPTY — no source file

  const saved = await saveActiveWorkflow(svc, undefined, {
    autoWorkflowName: () => 'Untitled 2026-07-24'
  })

  // Grounded to a real file; nothing on disk was destroyed (there was nothing).
  assert.ok(svc.disk.has('workflows/Untitled 2026-07-24.json'), 'temp grounded to a file')
  assert.ok(svc.calls.some((c) => c[0] === 'saveAs'), 'delegated to the atomic low-level saveAs copy')
  assert.equal(saved, 'Untitled 2026-07-24')
})

test('rejects an explicit whitespace-only name and leaves the source untouched (#226)', async () => {
  const active = {
    path: 'workflows/Foo.json',
    filename: 'Foo.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeService({ files: [active.path], active })

  await assert.rejects(() => saveActiveWorkflow(svc, '   ', {}), /must not be blank/)

  // Nothing was saved or overwritten — the persisted source stands as-is.
  assert.deepEqual(svc.calls, [])
  assert.ok(svc.disk.has('workflows/Foo.json'))
  assert.equal(svc.disk.size, 1)
})

test('double-extension Save-As to the base name still COPIES, never renames (#226)', async () => {
  // ComfyUI strips the final ".json", so a file persisted at "Foo.json.json"
  // reports filename "Foo.json". Save-As to "Foo" must copy, not be misread as
  // an in-place save (which upstream would turn into a destructive rename).
  const active = {
    path: 'workflows/Foo.json.json',
    filename: 'Foo.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeService({ files: [active.path], active })

  await saveActiveWorkflow(svc, 'Foo', {})

  assert.ok(svc.disk.has('workflows/Foo.json.json'), 'original preserved')
  assert.ok(svc.disk.has('workflows/Foo.json'), 'copy created')
  assert.ok(svc.calls.some((c) => c[0] === 'saveAs'), 'used the atomic low-level saveAs copy')
  assert.ok(
    !svc.calls.some((c) => c[0] === 'renameWorkflow'),
    'never renamed the source'
  )
})

test('app-mode Save-As to the base name COPIES, never renames the source (#226)', async () => {
  // App-mode workflows persist as "<name>.app.json". A source at "Foo.json"
  // (filename "Foo") Save-As to "Foo" must NOT be read as in-place: ComfyUI's
  // real target is "Foo.app.json", so an in-place save would upstream detect a
  // path change and rename/move "Foo.json". The classifier must compare against
  // the mode-derived target path.
  const active = {
    path: 'workflows/Foo.json',
    filename: 'Foo',
    directory: 'workflows',
    initialMode: 'app',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeService({ files: [active.path], active })

  await saveActiveWorkflow(svc, 'Foo', {})

  assert.ok(svc.disk.has('workflows/Foo.json'), 'original preserved')
  assert.ok(svc.disk.has('workflows/Foo.app.json'), 'app-mode copy created')
  assert.ok(svc.calls.some((c) => c[0] === 'saveAs'), 'used the atomic low-level saveAs copy')
  assert.ok(
    !svc.calls.some((c) => c[0] === 'renameWorkflow'),
    'never renamed the source'
  )
})

// A service double whose saveWorkflowAs mirrors ComfyUI 1.45.21 FAITHFULLY: it
// COPIES a persisted source but MOVES (renameWorkflow) a source it considers
// TEMPORARY — the exact branch that destroys the original (#226). It also
// exposes getWorkflowByPath backed by `disk`, so the panel's disk-existence
// guard has a real oracle.
function makeFaithfulService({ files = [], active } = {}) {
  const disk = new Set(files)
  const calls = []
  const svc = {
    activeWorkflow: active,
    calls,
    disk,
    getWorkflowByPath(path) {
      // Nothing on disk at this path ⇒ the store knows no workflow here.
      if (!disk.has(path)) return undefined
      // On disk: return whatever object the store currently holds for it. If the
      // ACTIVE object claims this path, return IT — this models the #226 drift
      // where a persisted file's in-memory object is mis-flagged temporary
      // (isPersisted=false). Otherwise a persisted stub.
      if (svc.activeWorkflow && svc.activeWorkflow.path === path) return svc.activeWorkflow
      return { path, isPersisted: true }
    },
    async renameWorkflow(wf, newPath) {
      calls.push(['renameWorkflow', wf.path, newPath])
      disk.delete(wf.path) // MOVE: consumes the source path
      wf.path = newPath
      wf.filename = newPath.split('/').pop()
      disk.add(newPath)
    },
    async saveWorkflow(wf) {
      calls.push(['saveWorkflow', wf.path])
      disk.add(wf.path)
    },
    async saveWorkflowAs(wf, { filename }) {
      // The DANGEROUS high-level API (MOVES a temporary). Kept so tests prove the
      // panel PREFERS the atomic low-level trio and NEVER calls this.
      calls.push(['saveWorkflowAs', wf.path, filename, !!wf.isTemporary])
      const dir = wf.directory || 'workflows'
      const newPath = `${dir}/${stripExt(filename)}${extFor(wf)}`
      if (wf.isTemporary) {
        await svc.renameWorkflow(wf, newPath)
        svc.activeWorkflow = wf
      } else {
        disk.add(newPath)
        svc.activeWorkflow = {
          path: newPath,
          filename: newPath.split('/').pop(),
          directory: dir,
          initialMode: wf.initialMode,
          isPersisted: true,
          isTemporary: false
        }
      }
    },
    // Low-level ATOMIC copy trio (the real 1.47.x route). Move-free by construction:
    // saveAs snapshots the source into a NEW copy object; the source is never touched.
    saveAs(wf, path) {
      calls.push(['saveAs', wf.path, path])
      return {
        path,
        filename: path.split('/').pop(),
        directory: path.split('/').slice(0, -1).join('/') || 'workflows',
        initialMode: wf.initialMode,
        isPersisted: false,
        isTemporary: true,
        changeTracker: { prepareForSave() {} }
      }
    },
    async openWorkflow(copy) {
      calls.push(['openWorkflow', copy.path])
      svc.activeWorkflow = copy
    }
  }
  return svc
}

test('refuses save-as when an on-disk source is mis-flagged temporary — never moves it (#226)', async () => {
  // The reproduced drift: panel_open_workflow left a PERSISTED workflow flagged
  // temporary (isTemporary === true), but its file is on disk. Delegating to the
  // frontend saveWorkflowAs here would MOVE (destroy) the original.
  const active = {
    path: 'workflows/zz226b-orig.json',
    filename: 'zz226b-orig.json',
    directory: 'workflows',
    isPersisted: false, // drifted flag
    isTemporary: true // drifted flag (frontend: size === -1)
  }
  const svc = makeFaithfulService({ files: [active.path], active })

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'zz226b-copy', {}),
    /could MOVE \(destroy\) the original/
  )
  // Original stands, nothing was moved, saveWorkflowAs was never even invoked.
  assert.ok(svc.disk.has('workflows/zz226b-orig.json'), 'original preserved')
  assert.ok(!svc.disk.has('workflows/zz226b-copy.json'), 'no rogue copy')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never renamed')
  assert.ok(!svc.calls.some((c) => c[0] === 'saveWorkflowAs'), 'never delegated a move')
})

test('a correctly-flagged persisted workflow still COPIES via the faithful frontend — SOURCE FILE survives (#226)', async () => {
  const active = {
    path: 'workflows/zz226b-orig.json',
    filename: 'zz226b-orig.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeFaithfulService({ files: [active.path], active })

  const saved = await saveActiveWorkflow(svc, 'zz226b-copy', {})

  // Proves COPY semantics on the modeled 1.45.21 frontend: after saveWorkflowAs
  // the SOURCE FILE is still on disk (persisted -> t.saveAs is a copy, #226).
  assert.ok(svc.disk.has('workflows/zz226b-orig.json'), 'SOURCE FILE still exists after saveWorkflowAs')
  assert.ok(svc.disk.has('workflows/zz226b-copy.json'), 'copy created')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never renamed')
  assert.equal(saved, 'zz226b-copy')
})

test('item 1: an oracle that THROWS is NOT proof of absence ⇒ unknown ⇒ REFUSE (#226)', async () => {
  // A drifted-temporary doc with a real path, whose getWorkflowByPath lookup
  // throws. A thrown lookup proves nothing about the disk — it must NOT be read
  // as "no file here" and must refuse rather than move.
  const active = {
    path: 'workflows/zz226b-orig.json',
    filename: 'zz226b-orig.json',
    directory: 'workflows',
    isPersisted: false, // drifted
    isTemporary: true // drifted
  }
  const svc = makeFaithfulService({ files: [active.path], active })
  svc.getWorkflowByPath = () => {
    throw new Error('store not ready')
  }

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'zz226b-copy', {}),
    /cannot be proven absent from disk/
  )
  assert.ok(svc.disk.has('workflows/zz226b-orig.json'), 'source preserved')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never renamed')
})

test('item 2: a genuine NEW workflow with NO path grounds/saves (never refused) (#226)', async () => {
  // The everyday "save my brand-new workflow" path: a temporary doc with no
  // backing path at all. Nothing on disk to lose ⇒ provably never-persisted ⇒
  // must SAVE, not refuse — even with no existence oracle consulted.
  const active = {
    path: undefined,
    filename: 'Unsaved Workflow.json',
    directory: 'workflows',
    isPersisted: false,
    isTemporary: true
  }
  const svc = makeFaithfulService({ active }) // disk empty

  const saved = await saveActiveWorkflow(svc, undefined, {
    autoWorkflowName: () => 'Untitled 2026-07-29'
  })

  assert.ok(svc.disk.has('workflows/Untitled 2026-07-29.json'), 'new workflow grounded to a file')
  assert.ok(svc.calls.some((c) => c[0] === 'saveAs'), 'delegated to the atomic low-level saveAs copy')
  assert.equal(saved, 'Untitled 2026-07-29')
})

test('disk-existence backstop catches a low-level copy that moves a persisted source (#226)', async () => {
  // Rogue frontend: the low-level saveAs ALSO deletes the source (a move). The pre-
  // check can't foresee this, so the post-op disk-existence backstop must catch the
  // vanished source and throw rather than report success. The backstop is now gated on
  // CONFIRMED disk evidence (200 before -> 404 after), so the test supplies a disk
  // oracle backed by svc.disk (an in-memory-only signal must NOT trip it — see the
  // dedicated no-false-throw test below).
  const active = {
    path: 'workflows/zz226b-orig.json',
    filename: 'zz226b-orig.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeFaithfulService({ files: [active.path], active })
  const existsOnDisk = async (p) => svc.disk.has(p) // 200 while on disk, 404 once deleted
  const origSaveAs = svc.saveAs
  svc.saveAs = (wf, path) => {
    svc.disk.delete(wf.path) // ROGUE: consumes (moves) the source
    return origSaveAs(wf, path)
  }

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'zz226b-copy', { existsOnDisk }),
    /moved the original workflow .* instead of copying it/
  )
})

test('P0 round-5: no-name save of a persisted workflow with an EMPTY filename refuses — never moves Orig.json → .json (#226)', async () => {
  // Flow edge: an on-disk workflow whose in-memory filename is empty/unresolved,
  // saved with NO name. effectiveName/finalTargetPath come out empty; the old
  // code called saveInPlace unconditionally and the frontend's saveWorkflow
  // recomputed the target from the empty name and MOVED "Orig.json" → ".json".
  const active = {
    path: 'workflows/Orig.json',
    filename: '',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeService({ files: [active.path], active })

  await assert.rejects(
    () => saveActiveWorkflow(svc, undefined, {}),
    /cannot resolve a target filename/
  )
  // Source preserved; NOTHING was called that could relocate it.
  assert.ok(svc.disk.has('workflows/Orig.json'), 'source preserved')
  assert.ok(!svc.disk.has('workflows/.json'), 'never moved to a bare .json')
  assert.equal(svc.calls.length, 0, 'no service call moved it')
})

test('no-name save of a persisted workflow with a normal filename saves IN PLACE to its own file (#226)', async () => {
  // The healthy counterpart: filename resolves, so the target equals the current
  // path and it is a true in-place save (no relocation) — the source file is the
  // one written, never moved.
  const active = {
    path: 'workflows/Orig.json',
    filename: 'Orig.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeService({ files: [active.path], active })

  await saveActiveWorkflow(svc, undefined, {})

  assert.deepEqual(svc.calls, [['saveWorkflow', 'workflows/Orig.json']], 'saved to its own path')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never renamed')
  assert.equal(svc.disk.size, 1)
})

test('round-6: a THROWING post-save probe does NOT false-alarm — a valid copy reports SUCCESS (#226)', async () => {
  // saveWorkflowAs copied the persisted source correctly, but the post-save
  // getWorkflowByPath probe throws (and there are no lists). A throw is UNKNOWN,
  // not proof the source vanished — the backstop must NOT report a valid save-as
  // as "moved".
  const active = {
    path: 'workflows/zz226b-orig.json',
    filename: 'zz226b-orig.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeFaithfulService({ files: [active.path], active })
  // The lookup for the SOURCE path throws (the post-save backstop probe); the TARGET
  // path resolves free (so the copy path's final re-check proceeds normally). A throw
  // on the source lookup is UNKNOWN — not proof the source vanished — so the backstop
  // must NOT report a valid copy as "moved".
  svc.getWorkflowByPath = (p) => {
    if (p === 'workflows/zz226b-orig.json') throw new Error('store index unavailable')
    return null
  }

  const saved = await saveActiveWorkflow(svc, 'zz226b-copy', {})

  assert.ok(svc.disk.has('workflows/zz226b-orig.json'), 'source survived (copy)')
  assert.ok(svc.disk.has('workflows/zz226b-copy.json'), 'copy created')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never renamed')
  assert.equal(saved, 'zz226b-copy', 'reported success, not a false "moved" error')
})

test('P0 round-4: oracle returns the DRIFTED non-persisted wf for an on-disk path ⇒ unknown ⇒ REFUSE (#226)', async () => {
  // Source IS on disk, but its in-memory object is mis-flagged temporary. The
  // store's getWorkflowByPath returns that same non-persisted object. A RETURNED
  // object is NOT proof of absence — classifying it never-persisted would move
  // (destroy) the real file with the backstop skipped. Must classify unknown.
  const active = {
    path: 'workflows/zz226b-orig.json',
    filename: 'zz226b-orig.json',
    directory: 'workflows',
    isPersisted: false, // drifted
    isTemporary: true // drifted
  }
  const svc = makeFaithfulService({ files: [active.path], active })
  // Sanity: the oracle returns the drifted non-persisted active object here.
  assert.equal(svc.getWorkflowByPath('workflows/zz226b-orig.json'), active)
  assert.equal(active.isPersisted, false)

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'zz226b-copy', {}),
    /cannot be proven absent from disk/
  )
  assert.ok(svc.disk.has('workflows/zz226b-orig.json'), 'real source preserved')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never renamed')
  assert.ok(!svc.calls.some((c) => c[0] === 'saveWorkflowAs'), 'never delegated a move')
})

test('P0 round-4: a LIST-miss is not proof of absence ⇒ unknown ⇒ REFUSE (#226)', async () => {
  // The only oracle is the workflow lists, and the source path is absent from
  // them. A list MISS cannot prove a file is absent from disk (an unlisted file
  // may exist), so it must NOT confirm absence — classify unknown and refuse.
  const active = {
    path: 'workflows/zz226b-orig.json',
    filename: 'zz226b-orig.json',
    directory: 'workflows',
    isPersisted: false, // drifted
    isTemporary: true // drifted
  }
  const calls = []
  const svc = {
    activeWorkflow: active,
    calls,
    workflows: [], // present but empty ⇒ oracle available, source is a MISS
    openWorkflows: [],
    async renameWorkflow(wf, to) {
      calls.push(['renameWorkflow', wf.path, to])
    },
    async saveWorkflow(wf) {
      calls.push(['saveWorkflow', wf.path])
    },
    async saveWorkflowAs(wf, opts) {
      calls.push(['saveWorkflowAs', wf.path, opts?.filename])
    }
  }

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'zz226b-copy', {}),
    /cannot be proven absent from disk/
  )
  assert.equal(calls.length, 0, 'nothing was called — no move')
})

test('P0-a: no existence oracle + mis-flagged temporary + real name ⇒ REFUSE, never move (#226)', async () => {
  // The most dangerous drift: the doc has a REAL filename and is flagged
  // temporary, but there is NO existence API/list to prove whether a file backs
  // it. Existence is UNKNOWN, which must FAIL SAFE (refuse) — the old code
  // classified this FALSE and let saveWorkflowAs move (destroy) the source.
  const active = {
    path: 'workflows/zz226b-orig.json',
    filename: 'zz226b-orig.json',
    directory: 'workflows',
    isPersisted: false, // drifted
    isTemporary: true // drifted (frontend: size === -1)
  }
  // makeService exposes NO getWorkflowByPath and NO workflows/openWorkflows lists
  // ⇒ no existence oracle ⇒ classification is UNKNOWN.
  const svc = makeService({ files: [active.path], active })

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'zz226b-copy', {}),
    /cannot be proven absent from disk/
  )
  // Source untouched; saveWorkflowAs never delegated a move.
  assert.ok(svc.disk.has('workflows/zz226b-orig.json'), 'original preserved')
  assert.equal(svc.calls.length, 0, 'nothing was called')
})

for (const realName of ['Untitled 2026-07-24', 'Unsaved Workflow 3']) {
  test(`P0 name-vs-proof: a REAL on-disk "${realName}" drifted temporary + NO oracle ⇒ REFUSE, never moved (#226)`, async () => {
    // The exact collision: a user really can have "workflows/Untitled ….json"
    // (or "Unsaved Workflow 3.json") ON DISK. If its flags drift temporary and
    // there is no existence oracle, the placeholder NAME must NOT be treated as
    // proof of absence — that would classify a real file as never-persisted and
    // then MOVE (destroy) it. With no oracle to confirm absence ⇒ unknown ⇒ refuse.
    const active = {
      path: `workflows/${realName}.json`,
      filename: `${realName}.json`,
      directory: 'workflows',
      isPersisted: false, // drifted
      isTemporary: true // drifted
    }
    // makeService ⇒ NO getWorkflowByPath, NO lists ⇒ no existence oracle.
    const svc = makeService({ files: [active.path], active })

    await assert.rejects(
      () => saveActiveWorkflow(svc, 'a-copy', {}),
      /cannot be proven absent from disk/
    )
    assert.ok(svc.disk.has(`workflows/${realName}.json`), 'real source preserved')
    assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never renamed')
    assert.ok(!svc.calls.some((c) => c[0] === 'saveWorkflowAs'), 'never delegated a move')
  })
}

test('P0-b: no-name save of an on-disk app-mode workflow COPIES to .app.json, source survives (#226)', async () => {
  // An on-disk "Foo.json" opened with initialMode "app" and NO supplied name:
  // the mode-derived target is "Foo.app.json" ≠ current path, so a plain
  // saveWorkflow would MOVE (rename) "Foo.json" and consume it. The relocation
  // must instead go down the safe copy path, leaving the original on disk.
  const active = {
    path: 'workflows/Foo.json',
    filename: 'Foo',
    directory: 'workflows',
    initialMode: 'app',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeFaithfulService({ files: [active.path], active })

  await saveActiveWorkflow(svc, undefined, { autoWorkflowName: () => 'Untitled' })

  assert.ok(svc.disk.has('workflows/Foo.json'), 'original source preserved')
  assert.ok(svc.disk.has('workflows/Foo.app.json'), 'app-mode copy created')
  assert.ok(svc.calls.some((c) => c[0] === 'saveAs'), 'routed to the atomic low-level saveAs copy')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never renamed the source')
})

// ---------------------------------------------------------------------------
// ComfyUI frontend 1.47.x (issue #268). The workflow store no longer exposes
// `saveWorkflowAs`; it exposes the low-level pair `saveAs(wf, path)` (builds a
// NEW copy object at `path`, leaving the source object and its file untouched)
// + `saveWorkflow(copy)` (persists it). `getWorkflowByPath` is backed by the
// IN-MEMORY store, so it returns the open temporary tab at its
// "workflows/Unsaved Workflow (N).json" path — it can NOT prove disk absence.
// Only the authoritative `existsOnDisk` oracle (ComfyUI /userdata HEAD) can.
//
// CONTENT-FAITHFUL model of the 1.47 SAVE MECHANICS: ComfyWorkflow.save()
// serializes `changeTracker?.activeState ?? null`, and the object `saveAs`
// returns is UNLOADED (changeTracker === null). So a copy saved WITHOUT being
// opened/activated first serializes the string "null" — a saved-but-empty file.
// `disk` therefore stores the SERIALIZED CONTENT (path -> string), and the tests
// assert the persisted content equals the source graph, catching a regression
// to the null-content bug that a "path exists" check would miss.
const SAMPLE_GRAPH = { nodes: [{ id: 1, type: 'KSampler' }], links: [], version: 1 }

function makeStore147Service({ files = [], active, graph = SAMPLE_GRAPH } = {}) {
  const disk = new Map() // path -> serialized content string
  for (const f of files) disk.set(f, JSON.stringify({ seeded: f }))
  const calls = []
  const store = new Map() // path -> in-memory workflow object
  // The active source tab is LOADED (the user is editing it): model its live
  // graph via a changeTracker, exactly what save()/saveAs read.
  if (active && active.changeTracker === undefined) {
    active.changeTracker = { activeState: graph, prepareForSave() {} }
  }
  if (active) store.set(active.path, active)
  const svc = {
    activeWorkflow: active,
    calls,
    disk,
    // In-memory oracle: returns whatever object the store holds at `path`,
    // INCLUDING the open temporary tab. Never consults disk. Mirrors 1.47's
    // `getWorkflowByPath = e => n.value[e] ?? null`.
    getWorkflowByPath(path) {
      return store.get(path) ?? null
    },
    // Low-level COPY: snapshots the SOURCE's current graph and builds a NEW,
    // UNLOADED workflow object at `path` (changeTracker === null, so activeState
    // is null until opened). The source object and its on-disk file are
    // untouched. Mirrors 1.47 store `saveAs`.
    saveAs(wf, path) {
      calls.push(['saveAs', wf.path, path])
      const snapshot = JSON.parse(JSON.stringify(wf.changeTracker?.activeState ?? null))
      const copy = {
        path,
        filename: path.split('/').pop(),
        directory: path.split('/').slice(0, -1).join('/') || 'workflows',
        initialMode: wf.initialMode,
        isPersisted: false, // not written yet (size === -1)
        isTemporary: true,
        changeTracker: null, // UNLOADED — activeState is null until openWorkflow
        _pendingState: snapshot // what load() will populate the tracker with
      }
      store.set(path, copy)
      return copy
    },
    // Opening LOADS the workflow (populates changeTracker/activeState from the
    // graph) and makes it the active tab. Mirrors 1.47 store `openWorkflow`.
    async openWorkflow(wf) {
      calls.push(['openWorkflow', wf.path])
      if (wf.changeTracker === null) {
        wf.changeTracker = { activeState: wf._pendingState, prepareForSave() {} }
      }
      svc.activeWorkflow = wf
      return wf
    },
    async saveWorkflow(wf) {
      calls.push(['saveWorkflow', wf.path])
      // save() serializes changeTracker?.activeState ?? null — the exact bug
      // surface. An unopened copy writes "null".
      disk.set(wf.path, JSON.stringify(wf.changeTracker?.activeState ?? null))
      wf.isPersisted = true
      wf.isTemporary = false
    },
    async renameWorkflow(wf, newPath) {
      calls.push(['renameWorkflow', wf.path, newPath])
      const content = disk.get(wf.path)
      disk.delete(wf.path) // MOVE: consumes the source
      store.delete(wf.path)
      wf.path = newPath
      wf.filename = newPath.split('/').pop()
      store.set(newPath, wf)
      if (content !== undefined) disk.set(newPath, content)
    }
    // NOTE: deliberately NO saveWorkflowAs — that is the whole point of 1.47.
  }
  // Authoritative filesystem oracle (what the panel backs with /userdata HEAD).
  const existsOnDisk = async (p) => disk.has(p)
  return { svc, existsOnDisk, graph }
}

test('1.47: a brand-new temp tab saves under a name via the saveAs+saveWorkflow COPY path (#268)', async () => {
  const active = {
    path: 'workflows/Unsaved Workflow (2).json',
    filename: 'Unsaved Workflow (2).json',
    directory: 'workflows',
    isPersisted: false,
    isTemporary: true
  }
  const { svc, existsOnDisk, graph } = makeStore147Service({ active }) // disk EMPTY

  const saved = await saveActiveWorkflow(svc, 'My Workflow', {
    autoWorkflowName: () => 'Untitled',
    existsOnDisk
  })

  assert.ok(svc.disk.has('workflows/My Workflow.json'), 'new workflow persisted')
  // The persisted content must be the REAL graph — NOT "null". This is the
  // regression guard for the unopened-copy bug: without openWorkflow the copy's
  // activeState is null and save() would serialize "null".
  assert.deepEqual(
    JSON.parse(svc.disk.get('workflows/My Workflow.json')),
    graph,
    'persisted content is the real graph, not null'
  )
  // The copy is opened/activated BEFORE it is saved, and becomes the active tab.
  assert.ok(svc.calls.some((c) => c[0] === 'openWorkflow'), 'opened/activated the copy before save')
  assert.equal(svc.activeWorkflow?.path, 'workflows/My Workflow.json', 'copy is the active tab')
  assert.ok(svc.calls.some((c) => c[0] === 'saveAs'), 'used the store saveAs copy')
  assert.ok(svc.calls.some((c) => c[0] === 'saveWorkflow'), 'persisted the copy')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never moved the temp')
  assert.equal(saved, 'My Workflow')
})

test('1.47: a brand-new temp tab with NO args auto-names and saves (#268)', async () => {
  const active = {
    path: 'workflows/Unsaved Workflow (2).json',
    filename: 'Unsaved Workflow (2).json',
    directory: 'workflows',
    isPersisted: false,
    isTemporary: true
  }
  const { svc, existsOnDisk, graph } = makeStore147Service({ active }) // disk EMPTY

  const saved = await saveActiveWorkflow(svc, undefined, {
    autoWorkflowName: () => 'Untitled 2026-07-30',
    existsOnDisk
  })

  assert.ok(svc.disk.has('workflows/Untitled 2026-07-30.json'), 'auto-named file persisted')
  assert.deepEqual(
    JSON.parse(svc.disk.get('workflows/Untitled 2026-07-30.json')),
    graph,
    'persisted content is the real graph, not null'
  )
  assert.equal(svc.activeWorkflow?.path, 'workflows/Untitled 2026-07-30.json', 'copy is the active tab')
  assert.ok(svc.calls.some((c) => c[0] === 'saveAs'), 'used the store saveAs copy')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never moved the temp')
  assert.equal(saved, 'Untitled 2026-07-30')
})

test('1.47: a persisted workflow Save-As COPIES via saveAs+saveWorkflow, source survives (#226)', async () => {
  const active = {
    path: 'workflows/Foo.json',
    filename: 'Foo.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const { svc, existsOnDisk, graph } = makeStore147Service({ files: [active.path], active })
  const sourceContentBefore = svc.disk.get('workflows/Foo.json')

  const saved = await saveActiveWorkflow(svc, 'Bar', { existsOnDisk })

  assert.ok(svc.disk.has('workflows/Foo.json'), 'SOURCE FILE preserved (copy, not move)')
  assert.equal(
    svc.disk.get('workflows/Foo.json'),
    sourceContentBefore,
    'source file content untouched'
  )
  assert.ok(svc.disk.has('workflows/Bar.json'), 'copy created')
  assert.deepEqual(
    JSON.parse(svc.disk.get('workflows/Bar.json')),
    graph,
    'copy content is the real graph, not null'
  )
  assert.equal(svc.activeWorkflow?.path, 'workflows/Bar.json', 'copy is the active tab')
  assert.ok(svc.calls.some((c) => c[0] === 'saveAs'), 'used the store saveAs copy')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never renamed the source')
  assert.equal(saved, 'Bar')
})

test('1.47: a drifted-temporary REAL file (on disk) is NEVER moved — refuse via disk oracle (#226/#215)', async () => {
  // The exact #226 hole the #268 fix must not reopen: a PERSISTED file left
  // flagged temporary. getWorkflowByPath returns that same non-persisted object
  // (can't prove absence); only the /userdata oracle can — and it says the file
  // EXISTS, so the classifier must say "persisted" → refuse, never copy/move.
  const active = {
    path: 'workflows/Real.json',
    filename: 'Real.json',
    directory: 'workflows',
    isPersisted: false, // drifted
    isTemporary: true // drifted
  }
  const { svc, existsOnDisk } = makeStore147Service({ files: [active.path], active })
  // Sanity: the in-memory oracle returns the SAME non-persisted object.
  assert.equal(svc.getWorkflowByPath('workflows/Real.json'), active)

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Copy', { existsOnDisk }),
    /exists on disk/
  )
  assert.ok(svc.disk.has('workflows/Real.json'), 'real source preserved')
  assert.ok(!svc.disk.has('workflows/Copy.json'), 'no rogue copy')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never renamed')
  assert.ok(!svc.calls.some((c) => c[0] === 'saveWorkflow'), 'never persisted a move')
})

test('1.47: a drifted-temporary path with an UNKNOWN disk oracle still refuses (fail safe, #226)', async () => {
  // If /userdata is unreachable (oracle returns null), a flagged-temporary doc
  // whose in-memory lookup is inconclusive stays "unknown" → refuse. Grounding
  // only ever happens on a PROVEN 404.
  const active = {
    path: 'workflows/Real.json',
    filename: 'Real.json',
    directory: 'workflows',
    isPersisted: false, // drifted
    isTemporary: true // drifted
  }
  const { svc } = makeStore147Service({ files: [active.path], active })
  const existsOnDisk = async () => null // oracle unreachable ⇒ unknown

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Copy', { existsOnDisk }),
    /cannot be proven absent from disk/
  )
  assert.ok(svc.disk.has('workflows/Real.json'), 'source preserved')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never renamed')
  assert.ok(!svc.calls.some((c) => c[0] === 'saveWorkflow'), 'never persisted a move')
})

test('1.47: saveAs+saveWorkflow but NO openWorkflow ⇒ refuse, never persist null content (#226)', async () => {
  // A persisted source MUST be copied (never moved), and the copy from saveAs()
  // is UNLOADED — so without openWorkflow to load its graph, saveWorkflow(copy)
  // would serialize "null" (empty file) while reporting success. The adapter must
  // NOT select this path — refuse BEFORE any saveAs/saveWorkflow, persisting
  // nothing and leaving the source file intact.
  const active = {
    path: 'workflows/Foo.json',
    filename: 'Foo.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const { svc, existsOnDisk } = makeStore147Service({ files: [active.path], active })
  const sourceContentBefore = svc.disk.get('workflows/Foo.json')
  delete svc.openWorkflow // frontend without the activation API

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Bar', { existsOnDisk }),
    /Save-As \(copy\) is unavailable on this frontend|refusing to rename and destroy/i
  )
  // NOTHING was copied or persisted — no null-content file; source untouched.
  assert.ok(!svc.disk.has('workflows/Bar.json'), 'no null-content copy written')
  assert.equal(svc.disk.get('workflows/Foo.json'), sourceContentBefore, 'source content untouched')
  assert.ok(!svc.calls.some((c) => c[0] === 'saveAs'), 'never created a copy')
  assert.ok(!svc.calls.some((c) => c[0] === 'saveWorkflow'), 'never persisted')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never moved')
})

// ---------------------------------------------------------------------------
// #285 — Save-As of a workflow loaded from an EXTERNAL absolute path (outside the
// managed workflows dir, via panel_load_workflow path:<file>). The copy must land
// in the USER workflows dir and the external original file must never be moved.

test('#285: external-path Save-As COPIES into the user workflows dir, external original survives', async () => {
  // A pack workflow loaded from an absolute path OUTSIDE workflows/. It is a live
  // temporary tab whose graph the user is editing; its file is on disk externally.
  const active = {
    path: 'C:/packs/qwen/Product Label Repair.json',
    filename: 'Product Label Repair.json',
    directory: 'C:/packs/qwen',
    isPersisted: false,
    isTemporary: true,
  }
  const { svc, existsOnDisk, graph } = makeStore147Service({ files: [active.path], active })

  const saved = await saveActiveWorkflow(svc, 'Product Label Repair - Qwen Edit Q5', {
    autoWorkflowName: () => 'Untitled',
    existsOnDisk,
  })

  // The copy lands in the USER workflows dir — NOT the external pack folder.
  assert.ok(
    svc.disk.has('workflows/Product Label Repair - Qwen Edit Q5.json'),
    'copy created in the user workflows dir',
  )
  assert.ok(
    !svc.disk.has('C:/packs/qwen/Product Label Repair - Qwen Edit Q5.json'),
    'no copy written into the unwritable external folder',
  )
  // The external ORIGINAL is untouched (copy, never move).
  assert.ok(svc.disk.has('C:/packs/qwen/Product Label Repair.json'), 'external original preserved')
  // Real graph content, not null (regression guard for the unopened-copy bug).
  assert.deepEqual(
    JSON.parse(svc.disk.get('workflows/Product Label Repair - Qwen Edit Q5.json')),
    graph,
    'copy content is the real graph',
  )
  assert.ok(svc.calls.some((c) => c[0] === 'saveAs'), 'used the move-free explicit-target copy')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never moved the external original')
  assert.equal(saved, 'Product Label Repair - Qwen Edit Q5')
})

test('#285: external-path Save-As REFUSES (never moves) when only the moving high-level copy exists', async () => {
  // A 1.45-style frontend exposes ONLY saveWorkflowAs (which MOVES a temporary and
  // cannot retarget the directory). For an external temporary source that would
  // destroy the external original — refuse instead, leaving it on disk.
  const active = {
    path: 'C:/packs/qwen/External.json',
    filename: 'External.json',
    directory: 'C:/packs/qwen',
    isPersisted: false,
    isTemporary: true,
  }
  const svc = makeFaithfulService({ files: [active.path], active })
  delete svc.saveAs // only the moving high-level saveWorkflowAs remains (no atomic trio)
  delete svc.openWorkflow

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'External Copy', {}),
    /externally-loaded workflow|outside the workflows folder/,
  )
  assert.ok(svc.disk.has('C:/packs/qwen/External.json'), 'external original preserved')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never moved')
  assert.ok(!svc.calls.some((c) => c[0] === 'saveWorkflowAs'), 'never delegated a move')
})

// ---------------------------------------------------------------------------
// #309 — a Save-As whose server write 409-conflicts (name already exists) must not
// leave the active tab rebound to the conflicting path.

// A service double whose saveWorkflowAs OPTIMISTICALLY rebinds the active tab to
// the target path (the reported bug) and THEN throws a 409 when the target file
// already exists on disk. The rebind persists across the throw unless rolled back.
function makeConflictService({ files = [], active } = {}) {
  const disk = new Set(files)
  const calls = []
  const svc = {
    activeWorkflow: active,
    calls,
    disk,
    getWorkflowByPath(path) {
      if (active && active.path === path) return active
      if (disk.has(path)) return { path, isPersisted: true }
      return null
    },
    async renameWorkflow(wf, to) {
      calls.push(['renameWorkflow', wf.path, to])
      wf.path = to
      wf.filename = to.split('/').pop()
    },
    async saveWorkflow(wf) {
      calls.push(['saveWorkflow', wf.path])
      disk.add(wf.path)
    },
    async saveWorkflowAs(wf, { filename }) {
      calls.push(['saveWorkflowAs', wf.path, filename])
      const target = `workflows/${stripExt(filename)}${extFor(wf)}`
      // OPTIMISTIC in-memory rebind BEFORE the server write (the #309 bug).
      wf.path = target
      wf.filename = target.split('/').pop()
      wf.isPersisted = false
      wf.isTemporary = true
      svc.activeWorkflow = wf
      if (disk.has(target)) {
        const err = new Error(`Error storing user data file '${target}': 409 Conflict`)
        err.status = 409
        throw err // server rejected — nothing written on disk
      }
      disk.add(target)
      svc.activeWorkflow = { path: target, filename: wf.filename, directory: 'workflows', isPersisted: true, isTemporary: false }
    },
    // Atomic low-level trio (the route the panel actually uses).
    saveAs(wf, path) {
      calls.push(['saveAs', wf.path, path])
      return { path, filename: path.split('/').pop(), directory: 'workflows', initialMode: wf.initialMode, isPersisted: false, isTemporary: true, changeTracker: { prepareForSave() {} } }
    },
    async openWorkflow(copy) {
      calls.push(['openWorkflow', copy.path])
      svc.activeWorkflow = copy
    },
  }
  return svc
}

test('#309: a name collision is pre-empted before any rebind, and a re-save under a new name succeeds', async () => {
  const active = {
    path: 'workflows/Unsaved Workflow.json',
    filename: 'Unsaved Workflow.json',
    directory: 'workflows',
    isPersisted: false,
    isTemporary: true,
  }
  const svc = makeConflictService({ files: ['workflows/FourRef_Identity.json'], active })
  const existsOnDisk = async (p) => svc.disk.has(p)

  // Save under a name that already exists on disk ⇒ clean conflict.
  await assert.rejects(
    () => saveActiveWorkflow(svc, 'FourRef_Identity', { existsOnDisk }),
    /already exists \(409 Conflict\)|choose a different name/,
  )

  // The collision was caught UP FRONT: no save/copy API was ever called, so the
  // tab was never optimistically rebound to the conflicting path (which is what
  // tripped the #226 guard before). The tab stands exactly as it was.
  assert.ok(!svc.calls.some((c) => c[0] === 'saveWorkflowAs'), 'never invoked the rebinding save')
  assert.equal(active.path, 'workflows/Unsaved Workflow.json', 'tab path unchanged')
  assert.equal(active.filename, 'Unsaved Workflow.json', 'tab filename unchanged')
  assert.equal(svc.activeWorkflow, active, 'active reference unchanged')
  assert.ok(svc.disk.has('workflows/FourRef_Identity.json'), 'the pre-existing file is untouched')

  // Because the tab is consistent, saving under a DIFFERENT unique name now works
  // (before the fix this refused via the #226 guard).
  const saved = await saveActiveWorkflow(svc, 'FourRef_Identity_v2', { existsOnDisk })
  assert.ok(svc.disk.has('workflows/FourRef_Identity_v2.json'), 're-save under a new name succeeded')
  assert.equal(saved, 'FourRef_Identity_v2')
})

test('#309: a low-level 409 rollback on a getter-only source never throws (getter-safe restore)', async () => {
  // withConflictRollback restores the SOURCE's fields on any conflict. A REAL
  // ComfyUI workflow exposes DERIVED, getter-only flags (get isTemporary(){...}); a
  // plain assignment to those throws a TypeError and would swallow the clean 409. On
  // the low-level path the source is never rebound (the copy is separate), so the
  // restore is a no-op — but it must still not throw on the getter-only flags.
  let size = -1 // -1 ⇒ temporary
  const wf = {
    path: 'workflows/Unsaved Workflow.json',
    filename: 'Unsaved Workflow.json',
    directory: 'workflows',
    get isTemporary() {
      return size === -1
    },
    get isPersisted() {
      return size !== -1
    },
  }
  const disk = new Set(['workflows/Existing.json'])
  const calls = []
  const svc = {
    activeWorkflow: wf,
    calls,
    getWorkflowByPath() {
      return null // stale: proves the temp source absent; target unknown
    },
    async renameWorkflow() {},
    saveAs(w, path) {
      calls.push(['saveAs', w.path, path])
      return { path, filename: path.split('/').pop(), directory: 'workflows', isPersisted: false, isTemporary: true, changeTracker: { prepareForSave() {} } }
    },
    async openWorkflow(copy) {
      svc.activeWorkflow = copy
    },
    async saveWorkflow(w) {
      calls.push(['saveWorkflow', w.path])
      if (disk.has(w.path)) {
        const err = new Error(`Error storing user data file '${w.path}': 409 Conflict`)
        err.status = 409
        throw err
      }
      disk.add(w.path)
    },
  }
  const existsOnDisk = async () => false // pre-check passes (TOCTOU); 409 from saveWorkflow

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Existing', { existsOnDisk }),
    /already exists \(409 Conflict\)/,
  )
  // Clean conflict surfaced (no TypeError); source identity + derived getter intact.
  assert.equal(wf.path, 'workflows/Unsaved Workflow.json', 'source path untouched')
  assert.equal(wf.isTemporary, true, 'derived getter intact')
})

test('#309: low-level (1.47) copy that 409s on persist removes the orphaned copy tab, restores active', async () => {
  // On a 1.47 store the copy is created + opened (becoming active) BEFORE its
  // persist. If saveWorkflow(copy) 409s, the copy must be removed from the open
  // tabs and the previously-active workflow restored — no phantom unsaved tab.
  const active = {
    path: 'workflows/Unsaved Workflow.json',
    filename: 'Unsaved Workflow.json',
    directory: 'workflows',
    isPersisted: false,
    isTemporary: true,
  }
  const openWorkflows = [active]
  const disk = new Set(['workflows/Existing.json'])
  const calls = []
  const svc = {
    activeWorkflow: active,
    openWorkflows,
    calls,
    // STALE registry: the store does not know the on-disk target, so neither the
    // pre-check nor the classifier pre-empts — the 409 surfaces from saveWorkflow.
    getWorkflowByPath() {
      return null
    },
    saveAs(wf, path) {
      calls.push(['saveAs', wf.path, path])
      const copy = { path, filename: path.split('/').pop(), directory: 'workflows', changeTracker: { prepareForSave() {} } }
      openWorkflows.push(copy)
      return copy
    },
    async openWorkflow(wf) {
      calls.push(['openWorkflow', wf.path])
      svc.activeWorkflow = wf
    },
    async saveWorkflow(wf) {
      calls.push(['saveWorkflow', wf.path])
      if (disk.has(wf.path)) {
        const err = new Error(`Error storing user data file '${wf.path}': 409 Conflict`)
        err.status = 409
        throw err
      }
      disk.add(wf.path)
    },
    async renameWorkflow() {},
  }

  // No existsOnDisk ⇒ pre-check skipped; the 409 surfaces from saveWorkflow(copy).
  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Existing', {}),
    /already exists \(409 Conflict\)/,
  )

  // The orphaned copy tab was removed and the original tab restored as active.
  assert.deepEqual(openWorkflows, [active], 'orphaned copy tab removed from open tabs')
  assert.equal(svc.activeWorkflow, active, 'original tab restored as active')
})

test('#309/P1-A: an UNKNOWN disk probe + a persisted target in the store ⇒ REFUSE, never call the overwriting saveWorkflowAs', async () => {
  // The exact P1-A repro: the disk probe THROWS (unknown), but the store knows a
  // PERSISTED workflow already sits at the target. The high-level saveWorkflowAs
  // would prompt-and-overwrite (deleting the existing target) — so we must refuse
  // up front, never reaching it.
  const active = {
    path: 'workflows/Orig.json',
    filename: 'Orig.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false,
  }
  const disk = new Set(['workflows/Orig.json', 'workflows/Copy.json'])
  const calls = []
  const svc = {
    activeWorkflow: active,
    calls,
    disk,
    getWorkflowByPath(p) {
      if (p === active.path) return active
      if (disk.has(p)) return { path: p, isPersisted: true } // Copy.json is a known persisted target
      return null
    },
    async saveWorkflow() {},
    async renameWorkflow() {},
    async saveWorkflowAs() {
      calls.push('saveWorkflowAs')
    },
  }
  const existsOnDisk = async () => {
    throw new Error('userdata unreachable') // probe is UNKNOWN
  }

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Copy', { existsOnDisk }),
    /already exists \(409 Conflict\)|choose a different name/,
  )
  assert.ok(!calls.includes('saveWorkflowAs'), 'never invoked the overwriting Save-As')
  assert.ok(svc.disk.has('workflows/Copy.json'), 'the existing target is untouched')
  assert.ok(svc.disk.has('workflows/Orig.json'), 'the source is untouched')
})

test('#226: a Save-As whose target is occupied by ANOTHER unsaved TEMPORARY tab REFUSES, never orphans it', async () => {
  // The real 1.47 store's saveAs unconditionally replaces workflowLookup[target].
  // If an UNSAVED temporary tab already owns the target path, saving over it would
  // orphan its graph (data loss) — and a disk 404 can't see an unsaved tab, so the
  // store index is the only signal. A DISTINCT object at the target (persisted OR
  // temporary) must refuse, not overwrite.
  const active = {
    path: 'workflows/Unsaved Workflow.json',
    filename: 'Unsaved Workflow.json',
    directory: 'workflows',
    isPersisted: false,
    isTemporary: true,
  }
  const otherTemp = {
    path: 'workflows/Draft.json',
    filename: 'Draft.json',
    directory: 'workflows',
    isPersisted: false, // ANOTHER unsaved tab already at the target path
    isTemporary: true,
  }
  const store = new Map([
    ['workflows/Unsaved Workflow.json', active],
    ['workflows/Draft.json', otherTemp],
  ])
  const calls = []
  const svc = {
    activeWorkflow: active,
    calls,
    getWorkflowByPath: (p) => store.get(p) ?? null,
    saveAs(wf, path) {
      calls.push(['saveAs', path])
      const c = { path, filename: path.split('/').pop(), isPersisted: false, isTemporary: true, changeTracker: { prepareForSave() {} } }
      store.set(path, c) // the real store REPLACES the lookup entry (orphaning otherTemp)
      return c
    },
    async openWorkflow(c) {
      svc.activeWorkflow = c
    },
    async saveWorkflow() {},
    async renameWorkflow() {},
  }
  const existsOnDisk = async () => false // disk 404s (the other tab is unsaved)

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Draft', { existsOnDisk }),
    /already exists \(409 Conflict\)|choose a different name/,
  )
  assert.ok(!calls.some((c) => c[0] === 'saveAs'), 'never created a copy over the existing tab')
  assert.equal(store.get('workflows/Draft.json'), otherTemp, 'the existing temporary tab is intact (not orphaned)')
})

test('#226: a temp tab that occupies the target DURING the async disk probe is caught by the final re-check (TOCTOU)', async () => {
  // The residual race: probeTargetCollision's store check sees the target FREE, then
  // awaits the disk HEAD; while it is pending, another unsaved tab occupies the
  // target. The final SYNCHRONOUS re-check right before saveAs must catch it — the
  // store's saveAs would otherwise replace the lookup entry and orphan that tab.
  const active = {
    path: 'workflows/Unsaved Workflow.json',
    filename: 'Unsaved Workflow.json',
    directory: 'workflows',
    isPersisted: false,
    isTemporary: true,
  }
  const otherTemp = { path: 'workflows/Draft.json', filename: 'Draft.json', isPersisted: false, isTemporary: true }
  const store = new Map([['workflows/Unsaved Workflow.json', active]]) // otherTemp NOT present yet
  const calls = []
  const svc = {
    activeWorkflow: active,
    calls,
    getWorkflowByPath: (p) => store.get(p) ?? null,
    saveAs(wf, path) {
      calls.push(['saveAs', path])
      const c = { path, filename: path.split('/').pop(), isPersisted: false, isTemporary: true, changeTracker: { prepareForSave() {} } }
      store.set(path, c) // REPLACES the lookup entry (would orphan otherTemp)
      return c
    },
    async openWorkflow(c) {
      svc.activeWorkflow = c
    },
    async saveWorkflow() {},
    async renameWorkflow() {},
  }
  // The disk HEAD probe: another tab occupies the target WHILE the probe is pending.
  const existsOnDisk = async (p) => {
    if (p === 'workflows/Draft.json') {
      store.set('workflows/Draft.json', otherTemp) // occupies the target mid-probe
      return false // 404 — the disk can't see the unsaved tab
    }
    return false
  }

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Draft', { existsOnDisk }),
    /already occupies|already exists \(409 Conflict\)|choose a different name/,
  )
  assert.ok(!calls.some((c) => c[0] === 'saveAs'), 'never overwrote the tab that appeared mid-probe')
  assert.equal(store.get('workflows/Draft.json'), otherTemp, 'the appeared temporary tab is intact (not orphaned)')
})

test('#226: the copy path FAILS CLOSED when the target cannot be verified (lookup absent or throwing)', async () => {
  // The atomic re-check must not fail OPEN: if getWorkflowByPath is absent, or throws,
  // we cannot prove the target is free, so we refuse rather than risk saveAs
  // overwriting an in-memory tab.
  const base = {
    path: 'workflows/Unsaved Workflow.json',
    filename: 'Unsaved Workflow.json',
    directory: 'workflows',
    isPersisted: false,
    isTemporary: true,
  }
  const mkSvc = (lookup) => {
    const calls = []
    const svc = {
      activeWorkflow: { ...base },
      calls,
      saveAs(wf, path) {
        calls.push(['saveAs', path])
        return { path, filename: path.split('/').pop(), isPersisted: false, isTemporary: true, changeTracker: { prepareForSave() {} } }
      },
      async openWorkflow(c) {
        svc.activeWorkflow = c
      },
      async saveWorkflow() {},
      async renameWorkflow() {},
    }
    if (lookup) svc.getWorkflowByPath = lookup
    return svc
  }
  const existsOnDisk = async () => false // target provably absent on disk

  // (a) No getWorkflowByPath at all ⇒ refuse.
  const noLookup = mkSvc(null)
  await assert.rejects(
    () => saveActiveWorkflow(noLookup, 'Draft', { existsOnDisk }),
    /cannot verify the target|refusing to avoid overwriting/i,
  )
  assert.ok(!noLookup.calls.some((c) => c[0] === 'saveAs'), 'never wrote without a lookup')

  // (b) A THROWING getWorkflowByPath ⇒ refuse.
  const throwingLookup = mkSvc(() => {
    throw new Error('store index unavailable')
  })
  await assert.rejects(
    () => saveActiveWorkflow(throwingLookup, 'Draft', { existsOnDisk }),
    /could not verify the target|refusing to avoid overwriting/i,
  )
  assert.ok(!throwingLookup.calls.some((c) => c[0] === 'saveAs'), 'never wrote on a throwing lookup')
})

test('#226/#309 P1-1: a frontend with ONLY the overwriting high-level saveWorkflowAs ⇒ REFUSE the relocating Save-As', async () => {
  // The only Save-As is the high-level one, which writes by prompting and can
  // delete+overwrite an existing target — no pre-check can make it atomic. A
  // collision-capable Save-As must be REFUSED, never routed through it.
  const active = {
    path: 'workflows/Orig.json',
    filename: 'Orig.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false,
  }
  const calls = []
  const svc = {
    activeWorkflow: active,
    calls,
    getWorkflowByPath: (p) => (p === active.path ? active : null),
    async saveWorkflow() {},
    async renameWorkflow() {},
    async saveWorkflowAs() {
      calls.push('saveWorkflowAs')
    },
  }
  const existsOnDisk = async (p) => p === active.path // target absent; source present

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Copy', { existsOnDisk }),
    /atomic Save-As.*unavailable|refused to avoid data loss/i,
  )
  assert.ok(!calls.includes('saveWorkflowAs'), 'never invoked the overwriting Save-As')
})

// A minimal 1.47-style low-level store double whose saveWorkflow is NON-atomic
// (mirrors the real server: overwrite:false does exists→await→os.replace, so it does
// NOT 409 a target that appears during the body-read). Parameterized by a saveWorkflow
// implementation so a test can model commit/reject/clobber precisely.
function makeLowLevelStore({ active, saveWorkflowImpl } = {}) {
  const store = new Map() // path -> RAW object (like reactive workflowLookup's targets)
  const openWorkflows = [] // holds PROXIES (like the store's computed open-tabs array)
  // Model Vue/Pinia reactivity: the RAW object goes into the lookup, but reads come
  // back as a STABLE reactive PROXY that is NOT === the raw object (Vue's documented
  // proxy-vs-raw identity). getWorkflowByPath returns the proxy; saveAs returns the raw.
  const proxies = new WeakMap()
  const proxyOf = (raw) => {
    if (!raw) return raw
    let p = proxies.get(raw)
    if (!p) {
      p = new Proxy(raw, {}) // transparent proxy: reflects props (incl. our token), !== raw
      proxies.set(raw, p)
    }
    return p
  }
  if (active) {
    store.set(active.path, active)
    openWorkflows.push(proxyOf(active))
  }
  const calls = []
  const svc = {
    activeWorkflow: active,
    openWorkflows,
    calls,
    getWorkflowByPath: (p) => (store.has(p) ? proxyOf(store.get(p)) : null),
    saveAs(wf, path) {
      calls.push(['saveAs', path])
      // Faithful UserFile shape: isTemporary/isPersisted are DERIVED from `size`
      // (get isTemporary(){return size===-1}); a fresh copy starts temporary.
      const copy = {
        path,
        filename: path.split('/').pop(),
        directory: 'workflows',
        size: -1,
        get isTemporary() {
          return this.size === -1
        },
        get isPersisted() {
          return this.size !== -1
        },
        content: '{"id":"OUR-ID"}',
        changeTracker: { prepareForSave() {} }
      }
      store.set(path, copy) // raw into the lookup
      openWorkflows.push(proxyOf(copy)) // computed open-tabs hold the proxy
      return copy // saveAs returns the RAW object (like the real store)
    },
    async openWorkflow(copy) {
      svc.activeWorkflow = copy
    },
    // Real 1.47 closeWorkflow, KEYED BY PATH: remove from open tabs; TEMPORARY → delete
    // the lookup entry; PERSISTED → merely unload (lookup record REMAINS). Never disk.
    async closeWorkflow(wf) {
      const path = wf.path
      for (let i = openWorkflows.length - 1; i >= 0; i--) {
        if (openWorkflows[i] && openWorkflows[i].path === path) openWorkflows.splice(i, 1)
      }
      const raw = store.get(path)
      if (raw && raw.isTemporary) store.delete(path)
      else if (raw) raw.content = null
    },
    async saveWorkflow(wf) {
      calls.push(['saveWorkflow', wf.path])
      if (saveWorkflowImpl) await saveWorkflowImpl(wf) // may throw (pre/post-commit)
      wf.size = 100 // a successful write marks the copy PERSISTED (size from resp.json)
      // Upstream 1.47: after a SUCCESSFUL save, re-baseline the change tracker to the
      // LIVE canvas and mark the workflow clean — the behavior our success-path
      // bookkeeping must OVERRIDE when an edit happened during the save await.
      wf.changeTracker?.reset?.()
      try {
        wf.isModified = false
      } catch {
        /* getter-only ⇒ tracker reset above already re-baselined */
      }
    },
    async renameWorkflow() {},
  }
  return { svc, store, openWorkflows, calls }
}

test('#226/#309 P0: a concurrent clobber of our just-written file is DETECTED, not silently reported as success (upstream os.replace race)', async () => {
  // ComfyUI's /userdata write is NOT exclusive-create — the server does
  // os.path.exists → await request.read() → os.replace, so a target appearing during
  // the body-read is silently overwritten (200, not 409). The residual we CAN detect:
  // our persist reports success, but a concurrent save then clobbered the target with
  // a DIFFERENT workflow. The post-write read-back returns "foreign" ⇒ surface a
  // detected error instead of a false success.
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const { svc } = makeLowLevelStore({ active, saveWorkflowImpl: async () => {} /* 200, non-atomic */ })
  const existsOnDisk = async () => false // target absent at the pre-check
  const reconcileSavedCopy = async () => 'foreign' // a concurrent save clobbered ours

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy }),
    /does not contain the saved workflow|concurrent save clobbered|not exclusive-create/i,
  )
})

test('P0: a reported-success save whose read-back confirms OUR content reports SUCCESS (no false alarm)', async () => {
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const { svc } = makeLowLevelStore({ active, saveWorkflowImpl: async () => {} })
  const existsOnDisk = async () => false
  const reconcileSavedCopy = async () => 'ours'

  const saved = await saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy })
  assert.equal(saved, 'Bar', 'a verified-ours save reports success')
})

test('#226 P1: post-write "foreign" detection removes our copy + restores active, so a later in-place Save does NOT overwrite the foreign target', async () => {
  // After a reported-success persist, the copy is ACTIVE and PERSISTED. If read-back
  // proves the on-disk target is FOREIGN (a concurrent clobber), merely throwing but
  // leaving the copy active+persisted is itself a data-loss setup: a later plain Save
  // (no new name) takes the in-place branch and ComfyUI's persisted save uses
  // overwrite:this.isPersisted → it would SILENTLY OVERWRITE the foreign file. So the
  // copy must be identity-safely removed and prevActive restored BEFORE throwing.
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const diskWrites = []
  const { svc, store, openWorkflows } = makeLowLevelStore({
    active,
    // A successful write marks the copy PERSISTED (the store's saveWorkflow sets its
    // size); we only record the write here.
    saveWorkflowImpl: async (wf) => {
      diskWrites.push(wf.path)
    },
  })
  const existsOnDisk = async () => false

  // First save: succeeds on the wire, but a concurrent writer replaced Bar before
  // our read-back ⇒ "foreign".
  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy: async () => 'foreign' }),
    /a concurrent save clobbered it|does not contain the saved workflow/i,
  )
  // The Bar copy is NOT left active/owned: active restored to Foo, copy gone.
  assert.equal(svc.activeWorkflow, active, 'active restored to the original (not the foreign Bar copy)')
  assert.equal(store.get('workflows/Bar.json'), undefined, 'our (persisted) copy PURGED from the store lookup')
  assert.ok(!openWorkflows.some((w) => w.path === 'workflows/Bar.json'), 'copy removed from open tabs')

  // A subsequent plain Save (no new name) now saves FOO in place — it must NEVER
  // touch the foreign Bar.
  diskWrites.length = 0
  await saveActiveWorkflow(svc, undefined, { existsOnDisk, reconcileSavedCopy: async () => 'ours' })
  assert.ok(!diskWrites.includes('workflows/Bar.json'), 'later in-place Save never overwrote the foreign Bar')
  assert.deepEqual(diskWrites, ['workflows/Foo.json'], 'later in-place Save wrote only the original Foo')
})

test('#226 P1: foreign-detection PURGES a now-PERSISTED copy from the store lookup, so a later Save-As to the same name is not blocked', async () => {
  // ComfyUI 1.47's closeWorkflow deletes the lookup entry ONLY for a TEMPORARY
  // workflow; a PERSISTED one is merely unloaded and LINGERS in workflowLookup. After
  // a reported-success write, our copy is persisted — so the foreign-detection cleanup
  // must COERCE it temporary so closeWorkflow fully purges the lookup, else the stale
  // record blocks a future Save-As to that name (getWorkflowByPath still returns it).
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const { svc, store } = makeLowLevelStore({ active, saveWorkflowImpl: async () => {} })
  const existsOnDisk = async () => false

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy: async () => 'foreign' }),
    /a concurrent save clobbered it|does not contain the saved workflow/i,
  )
  // The now-PERSISTED copy is FULLY purged from the lookup (not merely unloaded).
  assert.equal(svc.getWorkflowByPath('workflows/Bar.json'), null, 'persisted copy purged from the store lookup')
  assert.equal(store.get('workflows/Bar.json'), undefined, 'lookup entry deleted')
  assert.equal(svc.activeWorkflow, active, 'active restored to the original')

  // A later Save-As to the SAME name is NOT blocked by a lingering stale record.
  const saved = await saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy: async () => 'ours' })
  assert.equal(saved, 'Bar', 'later Save-As to the same name succeeds (not blocked by a stale record)')
})

test('#226 P1: the purge identifies "our copy" by a proxy-safe token, NOT object === (Vue reactive store returns a proxy)', async () => {
  // Guards the exact bug: the real reactive store returns getWorkflowByPath as a Vue
  // PROXY that is NOT === the raw object saveAs returned. A `===` identity check makes
  // the purge a no-op. This double models that (getWorkflowByPath ≠ the raw copy);
  // the cleanup must still purge our copy via its stable token.
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const { svc } = makeLowLevelStore({ active, saveWorkflowImpl: async () => {} })
  const existsOnDisk = async () => false

  // Sanity: the store returns a PROXY, not the raw object — proving === would fail.
  const before = svc.getWorkflowByPath('workflows/Foo.json')
  assert.equal(before === active, false, 'store getter returns a proxy, not === the raw object')
  assert.equal(before.path, 'workflows/Foo.json', 'proxy transparently reflects the raw properties')

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy: async () => 'foreign' }),
    /a concurrent save clobbered it|does not contain the saved workflow/i,
  )
  // Purged despite the proxy-vs-raw identity mismatch.
  assert.equal(svc.getWorkflowByPath('workflows/Bar.json'), null, 'copy purged via proxy-safe token match')
})

test('#226 P2: an AMBIGUOUS post-commit persist failure that actually COMMITTED is ADOPTED, not orphaned', async () => {
  // A persist can COMMIT to disk and THEN reject (connection reset after commit, or a
  // resp.json() parse error — the frontend updates persisted metadata only after
  // parsing). Blindly removing the copy would ORPHAN the on-disk file (a retry then
  // 409s). The reconcile read-back shows OUR content landed ⇒ adopt the copy, report
  // success, never orphan it.
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const committed = new Set()
  const { svc, store, openWorkflows } = makeLowLevelStore({
    active,
    saveWorkflowImpl: async (wf) => {
      committed.add(wf.path) // the write LANDS on disk...
      throw new Error('connection reset after commit') // ...then the response is lost
    },
  })
  const existsOnDisk = async () => false
  const reconcileSavedCopy = async (p) => (committed.has(p) ? 'ours' : 'absent')

  const saved = await saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy })
  assert.equal(saved, 'Bar', 'reported success (the write DID commit)')
  assert.ok(store.get('workflows/Bar.json') != null, 'copy ADOPTED in the store lookup (not orphaned)')
  assert.ok(openWorkflows.some((w) => w.path === 'workflows/Bar.json'), 'copy still open (not removed)')
})

test('#309 P2: an adopted copy is marked PERSISTED (size != -1) so a later in-place Save does not 409 and close does not purge it', async () => {
  // On 1.47 isTemporary/isPersisted are GETTER-ONLY, derived from `size`; the adopt
  // path must update `size`, not assign the getters (silently discarded). Otherwise
  // the adopted copy stays "temporary": a later in-place Save uses overwrite:false and
  // 409s, and closing it takes the temporary-purge path (dropping the saved copy).
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const committed = new Set()
  let firstSave = true
  const { svc, store } = makeLowLevelStore({
    active,
    saveWorkflowImpl: async (wf) => {
      if (firstSave) {
        firstSave = false
        committed.add(wf.path) // the write COMMITS to disk...
        throw new Error('resp.json parse error after commit') // ...then the response fails
      }
      // A subsequent in-place save models the real overwrite:this.isPersisted — a
      // TEMPORARY workflow saved in place onto an EXISTING target 409s (overwrite:false).
      if (committed.has(wf.path) && wf.isTemporary) {
        const e = new Error(`Error storing user data file '${wf.path}': 409 Conflict`)
        e.status = 409
        throw e
      }
    },
  })
  const existsOnDisk = async () => false
  const reconcileSavedCopy = async (p) => (committed.has(p) ? 'ours' : 'absent')

  // First save: post-commit reject → read-back "ours" → ADOPT.
  const saved = await saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy })
  assert.equal(saved, 'Bar', 'adoption reports success')

  // The adopted copy is active and marked PERSISTED via `size` (not the getter-only flags).
  const adopted = svc.activeWorkflow
  assert.equal(adopted.path, 'workflows/Bar.json', 'adopted copy is the active workflow')
  assert.notEqual(adopted.size, -1, 'size is non-(-1) ⇒ persisted')
  assert.equal(adopted.isPersisted, true, 'isPersisted derives true')
  assert.equal(adopted.isTemporary, false, 'isTemporary derives false')

  // A subsequent ordinary in-place Save (no new name) must NOT 409 (overwrite:true now).
  await assert.doesNotReject(
    () => saveActiveWorkflow(svc, undefined, { existsOnDisk, reconcileSavedCopy: async () => 'ours' }),
    'in-place Save of the adopted (persisted) copy does not 409',
  )

  // Closing the adopted copy must NOT take the TEMPORARY purge path — persisted, so
  // its lookup record remains (unload only).
  await svc.closeWorkflow(adopted)
  assert.notEqual(store.get('workflows/Bar.json'), undefined, 'persisted copy not purged by close (lookup remains)')
})

// Attach a faithful ComfyWorkflow change tracker to a copy: `content` is the COMMITTED
// snapshot (what the write persisted); the tracker's initialState is the baseline and
// activeState the live canvas; updateModified sets isModified = !graphEqual(initial,
// active) (JSON compare here). reset() re-baselines to activeState (the WRONG direction
// the fix must avoid). undo() restores the previous state and recomputes.
function attachChangeTracker(copy, { committedContent, activeState, undoStack = [] }) {
  copy.content = committedContent
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const ct = {
    initialState: JSON.parse(committedContent),
    activeState,
    _undo: [...undoStack],
    updateModified() {
      copy.isModified = !eq(ct.initialState, ct.activeState)
    },
    reset() {
      ct.initialState = ct.activeState
      ct.updateModified()
    },
    undo() {
      const prev = ct._undo.pop()
      if (prev !== undefined) {
        ct.activeState = prev
        ct.updateModified()
      }
    },
    prepareForSave() {},
  }
  copy.isModified = false
  copy.changeTracker = ct
  return ct
}

test('#309 P1: adoption keeps the copy DIRTY when the canvas was edited DURING the save (baseline = COMMITTED snapshot, not live)', async () => {
  // The race the previous (reset-to-activeState) direction introduced: the save
  // committed S1, but the user edited the live canvas to S2 WHILE the persist awaited;
  // the response then failed and read-back returned "ours". Re-baselining to the LIVE
  // activeState (S2) and forcing clean would let workflow_close silently drop the
  // unsaved S2 edit. The baseline must be the COMMITTED snapshot (S1), so isModified
  // reflects that the canvas has DIVERGED ⇒ the copy stays DIRTY.
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const { svc } = makeLowLevelStore({
    active,
    saveWorkflowImpl: async () => {
      throw new Error('resp.json parse error after commit') // committed S1, response lost
    },
  })
  const origSaveAs = svc.saveAs
  svc.saveAs = (wf, path) => {
    const copy = origSaveAs(wf, path)
    // The write committed S1; the user edited the live canvas to S2 during the await.
    attachChangeTracker(copy, { committedContent: JSON.stringify({ v: 'S1' }), activeState: { v: 'S2' } })
    return copy
  }
  const existsOnDisk = async () => false
  const reconcileSavedCopy = async () => 'ours'

  const saved = await saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy })
  assert.equal(saved, 'Bar', 'adoption reports success')
  const adopted = svc.activeWorkflow

  // The live canvas (S2) diverged from what committed (S1) ⇒ the copy stays DIRTY.
  assert.equal(adopted.isModified, true, 'in-flight edit ⇒ copy stays DIRTY (holds the unsaved S2)')

  // workflow_close's clean-guard must NOT silently unload a modified workflow.
  let unloaded = false
  const closeIfClean = (wf) => {
    if (!wf.isModified) unloaded = true
  }
  closeIfClean(adopted)
  assert.equal(unloaded, false, 'workflow_close does NOT silently unload the unsaved in-flight edit')
})

test('#309 P1: adoption sets isModified on OUR copy directly — a distinct late occupant that claimed the path is NOT marked clean', async () => {
  // During the reconcile read-back await, a distinct DIRTY workflow B claims copy A's
  // path. 1.47's ct.updateModified() re-resolves BY PATH and would write isModified on
  // B (marking B falsely clean → workflow_close unloads B's unsaved graph). Adoption
  // must set isModified on OUR copy A directly, never path-resolving, so B stays dirty.
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const B = { path: 'workflows/Bar.json', filename: 'Bar.json', isModified: true } // distinct, UNSAVED
  const { svc, store } = makeLowLevelStore({
    active,
    saveWorkflowImpl: async () => {
      throw new Error('resp.json parse error after commit')
    },
  })
  const origSaveAs = svc.saveAs
  svc.saveAs = (wf, path) => {
    const copy = origSaveAs(wf, path)
    copy.content = JSON.stringify({ v: 'S1' }) // committed S1; A itself is clean (active S1)
    copy.changeTracker = {
      initialState: JSON.parse(copy.content),
      activeState: { v: 'S1' },
      workflow: copy,
      // Faithful 1.47: resolve the workflow BY PATH and write isModified on it.
      updateModified() {
        const resolved = svc.getWorkflowByPath(this.workflow.path)
        if (resolved) resolved.isModified = false // (initial == active for A)
      },
    }
    copy.isModified = false
    return copy
  }
  const existsOnDisk = async () => false
  // During the reconcile await, B claims A's path in the store lookup.
  const reconcileSavedCopy = async (p) => {
    store.set(p, B)
    return 'ours'
  }

  await saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy })
  // The distinct late occupant B (now at the path) must NOT have been marked clean.
  assert.equal(B.isModified, true, 'a distinct late occupant is NOT marked clean by adoption (no path-resolving write)')
})

test('#309 P1: adoption with NO in-flight edit is CLEAN, and a later Undo makes it correctly DIRTY', async () => {
  // The healthy case: the live canvas still equals what committed (S1) ⇒ clean. A later
  // Undo restores an earlier UNSAVED state (S0) ⇒ correctly DIRTY (baseline = committed
  // S1, not re-based to S0), so close won't silently drop it.
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const { svc } = makeLowLevelStore({
    active,
    saveWorkflowImpl: async () => {
      throw new Error('resp.json parse error after commit')
    },
  })
  const origSaveAs = svc.saveAs
  svc.saveAs = (wf, path) => {
    const copy = origSaveAs(wf, path)
    // Committed S1; live canvas still S1 (no edit during the await); undo stack has S0.
    attachChangeTracker(copy, {
      committedContent: JSON.stringify({ v: 'S1' }),
      activeState: { v: 'S1' },
      undoStack: [{ v: 'S0' }],
    })
    return copy
  }
  const existsOnDisk = async () => false
  const reconcileSavedCopy = async () => 'ours'

  await saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy })
  const adopted = svc.activeWorkflow

  // Canvas equals committed ⇒ clean.
  assert.equal(adopted.isModified, false, 'no in-flight edit ⇒ clean (canvas equals the committed snapshot)')

  // Undo to the earlier UNSAVED state ⇒ correctly DIRTY.
  adopted.changeTracker.undo()
  assert.equal(adopted.isModified, true, 'after Undo the copy is correctly DIRTY (unsaved change)')
})

test('#309 P1: a SUCCESSFUL Save-As with an in-flight edit keeps the copy DIRTY (mirror of the adoption fix, success branch)', async () => {
  // The success-path mirror: ComfyUI's saveWorkflow(copy) captures S1, awaits the write,
  // THEN reset()s the tracker to the LIVE canvas and marks clean. If the user edited to
  // S2 DURING the successful save await, upstream would mark the copy "clean" at the
  // UNSAVED S2 (disk has S1) → close silently unloads S2. Our success-path bookkeeping
  // must OVERRIDE that: baseline to the COMMITTED snapshot (S1) so the copy stays DIRTY.
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const { svc } = makeLowLevelStore({
    active,
    // The write PERSISTS S1; the user edits the live canvas to S2 during the (successful)
    // save await.
    saveWorkflowImpl: async (wf) => {
      wf.changeTracker.activeState = { v: 'S2' }
    },
  })
  const origSaveAs = svc.saveAs
  svc.saveAs = (wf, path) => {
    const copy = origSaveAs(wf, path)
    attachChangeTracker(copy, { committedContent: JSON.stringify({ v: 'S1' }), activeState: { v: 'S1' } })
    return copy
  }
  const existsOnDisk = async () => false
  const reconcileSavedCopy = async () => 'ours' // P0 read-back: our content is on disk

  const saved = await saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy })
  assert.equal(saved, 'Bar', 'save reports success')
  const copy = svc.activeWorkflow
  // The live canvas (S2) diverged from what committed (S1) ⇒ DIRTY despite the success.
  assert.equal(copy.isModified, true, 'in-flight edit ⇒ copy stays DIRTY after a SUCCESSFUL save')
  let unloaded = false
  const closeIfClean = (wf) => {
    if (!wf.isModified) unloaded = true
  }
  closeIfClean(copy)
  assert.equal(unloaded, false, 'close does NOT silently unload the unsaved in-flight edit')
})

test('#309 P1: a SUCCESSFUL Save-As with NO in-flight edit leaves the copy CLEAN', async () => {
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const { svc } = makeLowLevelStore({ active, saveWorkflowImpl: async () => {} }) // no edit during save
  const origSaveAs = svc.saveAs
  svc.saveAs = (wf, path) => {
    const copy = origSaveAs(wf, path)
    attachChangeTracker(copy, { committedContent: JSON.stringify({ v: 'S1' }), activeState: { v: 'S1' } })
    return copy
  }
  const existsOnDisk = async () => false
  const reconcileSavedCopy = async () => 'ours'

  const saved = await saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy })
  assert.equal(saved, 'Bar', 'save reports success')
  assert.equal(svc.activeWorkflow.isModified, false, 'no in-flight edit ⇒ clean (canvas equals committed)')
})

test('#226 P2: a persist failure whose read-back proves ABSENT removes the copy and rethrows (safe)', async () => {
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const { svc, store, openWorkflows } = makeLowLevelStore({
    active,
    saveWorkflowImpl: async () => {
      throw new Error('write failed before commit')
    },
  })
  const existsOnDisk = async () => false
  const reconcileSavedCopy = async () => 'absent' // the write did NOT land

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy }),
    /write failed before commit/,
  )
  assert.equal(store.get('workflows/Bar.json'), undefined, 'orphan copy removed from the store')
  assert.ok(!openWorkflows.some((w) => w.path === 'workflows/Bar.json'), 'copy removed from open tabs')
  assert.equal(svc.activeWorkflow, active, 'source restored as active')
})

test('#226 P2: a persist failure whose read-back shows FOREIGN content surfaces a clobber error, removes the copy', async () => {
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const { svc, store } = makeLowLevelStore({
    active,
    saveWorkflowImpl: async () => {
      throw new Error('connection reset after commit')
    },
  })
  const existsOnDisk = async () => false
  const reconcileSavedCopy = async () => 'foreign' // the target holds someone else's content

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Bar', { existsOnDisk, reconcileSavedCopy }),
    /a concurrent save clobbered it|holds a DIFFERENT workflow/i,
  )
  assert.equal(store.get('workflows/Bar.json'), undefined, 'our copy removed (target is not ours)')
})

test('#226: a persisted target already indexed in the store pre-empts with a clean conflict (never evicted)', async () => {
  // The store shows a persisted Bar at the target ⇒ the collision pre-check refuses
  // BEFORE any write, and barTarget is untouched.
  const active = { path: 'workflows/Foo.json', filename: 'Foo.json', directory: 'workflows', isPersisted: true, isTemporary: false }
  const barTarget = { path: 'workflows/Bar.json', filename: 'Bar.json', isPersisted: true, isTemporary: false }
  const openWorkflows = [active, barTarget]
  const store = new Map([['workflows/Foo.json', active], ['workflows/Bar.json', barTarget]])
  const calls = []
  const svc = {
    activeWorkflow: active,
    openWorkflows,
    calls,
    getWorkflowByPath: (p) => store.get(p) ?? null,
    saveAs(wf, path) {
      calls.push(['saveAs', path])
      return { path, filename: path.split('/').pop(), isPersisted: false, isTemporary: true, changeTracker: { prepareForSave() {} } }
    },
    async openWorkflow(copy) {
      svc.activeWorkflow = copy
    },
    async closeWorkflow() {},
    async saveWorkflow() {},
    async renameWorkflow() {},
  }
  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Bar', {}),
    /already exists \(409 Conflict\)|already occupies/,
  )
  assert.ok(!calls.some((c) => c[0] === 'saveAs'), 'never wrote — pre-empted')
  assert.equal(store.get('workflows/Bar.json'), barTarget, 'real persisted target still indexed (never evicted)')
  assert.ok(openWorkflows.includes(barTarget), 'real persisted target still open')
})

test('#226: a LATE occupant that claims the copy path during the awaited persist is NOT evicted by orphan cleanup', async () => {
  // The deep late-occupant race: our copy is created at the target, then DURING the
  // awaited openWorkflow another temporary tab claims the same store path. When
  // saveWorkflow then 409s, the orphan cleanup must NOT close-by-path (which the real
  // 1.47 store does by `delete workflowLookup[path]`) — that would delete the late
  // occupant. It must only splice OUR copy out by identity, leaving the occupant.
  const active = { path: 'workflows/Unsaved Workflow.json', filename: 'Unsaved Workflow.json', directory: 'workflows', isPersisted: false, isTemporary: true }
  const lateOccupant = { path: 'workflows/Draft.json', filename: 'Draft.json', isPersisted: false, isTemporary: true }
  const store = new Map([['workflows/Unsaved Workflow.json', active]])
  const openWorkflows = [active]
  const disk = new Set(['workflows/Draft.json']) // target exists on disk ⇒ saveWorkflow 409s
  const calls = []
  const svc = {
    activeWorkflow: active,
    openWorkflows,
    calls,
    getWorkflowByPath: (p) => store.get(p) ?? null,
    saveAs(wf, path) {
      calls.push(['saveAs', path])
      const copy = { path, filename: path.split('/').pop(), isPersisted: false, isTemporary: true, changeTracker: { prepareForSave() {} } }
      store.set(path, copy)
      openWorkflows.push(copy)
      return copy
    },
    async openWorkflow(copy) {
      // DURING this await, a late temporary tab claims the SAME store path.
      store.set('workflows/Draft.json', lateOccupant)
      openWorkflows.push(lateOccupant)
      svc.activeWorkflow = copy
    },
    async saveWorkflow(wf) {
      if (disk.has(wf.path)) {
        const err = new Error(`Error storing user data file '${wf.path}': 409 Conflict`)
        err.status = 409
        throw err
      }
      disk.add(wf.path)
    },
    // Real 1.47 closeWorkflow deletes by PATH (would evict whatever is at the path).
    async closeWorkflow(wf) {
      const i = openWorkflows.indexOf(wf)
      if (i >= 0) openWorkflows.splice(i, 1)
      store.delete(wf.path)
    },
    async renameWorkflow() {},
  }
  // The target's own path is absent from the store at the pre-check (only appears via
  // saveAs), so the collision pre-check passes and we reach the awaited persist.
  const existsOnDisk = async (p) => (p === 'workflows/Draft.json' ? false : false)

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Draft', { existsOnDisk }),
    /already exists \(409 Conflict\)/,
  )
  // The late occupant is NOT evicted — its lookup entry and unsaved graph survive.
  assert.equal(store.get('workflows/Draft.json'), lateOccupant, 'late occupant NOT evicted (identity-safe cleanup)')
  assert.ok(openWorkflows.includes(lateOccupant), 'late occupant still open')
})

test('refuses to rename-destroy a persisted workflow when no copy API exists', async () => {
  const active = {
    path: 'workflows/Foo.json',
    filename: 'Foo.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeService({ files: [active.path], active })
  // Older frontend with NO copy path at all (neither the atomic low-level trio nor
  // even the high-level saveWorkflowAs).
  delete svc.saveWorkflowAs
  delete svc.saveAs
  delete svc.openWorkflow

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Bar', {}),
    /refusing to rename and destroy/
  )
  // Source untouched; nothing moved.
  assert.ok(svc.disk.has('workflows/Foo.json'))
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'))
})

// ---------------------------------------------------------------------------
// EXACT-SCENARIO regressions for mcp#579 and panel#363 (reported on panel 0.11.6
// against a ComfyUI 0.28.3 / frontend-1.47.x store). Both are reproduced through
// the SAME saveActiveWorkflow path that panel_save_workflow → workflow_save_as →
// programmaticSave invokes, on the 1.47 store double that mirrors that frontend.
// They must NOT move/destroy the original and must NOT refuse a new-workflow save.

test('mcp#579: Save-As of an open PERSISTED workflow COPIES — the original file survives, never moved (1.47)', async () => {
  // The literal reported case: an on-disk "UGC - 01 …" workflow is open; the agent
  // calls panel_save_workflow({name:"UGC - 06 …"}) intending a Save-As. The original
  // must remain on disk (the ComfyUI log's `moving 'UGC - 01…' -> 'UGC - 06…'` must
  // NOT happen), and a NEW file must be written with the real graph content.
  const active = {
    path: 'workflows/UGC - 01 Imagem para Video (TI2V-5B).json',
    filename: 'UGC - 01 Imagem para Video (TI2V-5B).json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const { svc, existsOnDisk, graph } = makeStore147Service({ files: [active.path], active })
  const originalContentBefore = svc.disk.get(active.path)

  const details = {}
  const saved = await saveActiveWorkflow(svc, 'UGC - 06 Cena 1 Leticia (TI2V-5B + Wav2Lip)', {
    existsOnDisk,
    details
  })

  // AUTHORITATIVE outcome the tool result is built from: a Save-As COPY of the real
  // source, with the source path/name recorded for the caller's disk re-verification.
  assert.equal(details.mode, 'save-as-copy', 'reported as a Save-As copy (not silent, not first-save)')
  assert.equal(details.sourcePath, 'workflows/UGC - 01 Imagem para Video (TI2V-5B).json')
  assert.deepEqual(describeSaveOutcome(details), {
    saved_as: true,
    copied_from: 'UGC - 01 Imagem para Video (TI2V-5B)'
  })

  // The ORIGINAL is untouched on disk — copy, not move (the #579 data-loss guard).
  assert.ok(
    svc.disk.has('workflows/UGC - 01 Imagem para Video (TI2V-5B).json'),
    'ORIGINAL preserved on disk — not moved/renamed (mcp#579)'
  )
  assert.equal(
    svc.disk.get('workflows/UGC - 01 Imagem para Video (TI2V-5B).json'),
    originalContentBefore,
    'original file content byte-identical (untouched)'
  )
  // The new file exists with the real graph.
  assert.ok(
    svc.disk.has('workflows/UGC - 06 Cena 1 Leticia (TI2V-5B + Wav2Lip).json'),
    'new Save-As file created'
  )
  assert.deepEqual(
    JSON.parse(svc.disk.get('workflows/UGC - 06 Cena 1 Leticia (TI2V-5B + Wav2Lip).json')),
    graph,
    'new file holds the real graph, not "null"'
  )
  // It took the move-free atomic copy path; the source was NEVER renamed/moved.
  assert.ok(svc.calls.some((c) => c[0] === 'saveAs'), 'used the atomic low-level saveAs copy')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'source was NEVER renamed (no MOVE)')
  assert.equal(saved, 'UGC - 06 Cena 1 Leticia (TI2V-5B + Wav2Lip)')
})

test('panel#363: naming a workflow created by panel_new_workflow (temp tab) SUCCEEDS as a first save (1.47)', async () => {
  // panel_new_workflow opens a blank temporary tab (isTemporary=true, no on-disk
  // file). Its path 404s on disk. panel_save_workflow({name}) must persist it as a
  // NEW file — NOT refuse with the destructive-rename guard (the panel#363 bug).
  const active = {
    path: 'workflows/Unsaved Workflow.json',
    filename: 'Unsaved Workflow.json',
    directory: 'workflows',
    isPersisted: false,
    isTemporary: true
  }
  const { svc, existsOnDisk, graph } = makeStore147Service({ active }) // disk EMPTY ⇒ 404

  const details = {}
  const saved = await saveActiveWorkflow(svc, 'Video Face Detail - Second Stage', {
    autoWorkflowName: () => 'Untitled',
    existsOnDisk,
    details
  })

  // Reported as a FIRST save (no prior file to preserve) — never a Save-As move.
  assert.equal(details.mode, 'first-save', 'a never-persisted temp tab first-save (panel#363)')
  assert.deepEqual(describeSaveOutcome(details), { first_save: true })
  assert.ok(
    svc.disk.has('workflows/Video Face Detail - Second Stage.json'),
    'new-workflow tab was named + persisted (panel#363 no longer refuses)'
  )
  assert.deepEqual(
    JSON.parse(svc.disk.get('workflows/Video Face Detail - Second Stage.json')),
    graph,
    'persisted content is the real graph, not "null"'
  )
  assert.ok(svc.calls.some((c) => c[0] === 'saveAs'), 'used the atomic low-level saveAs copy')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'no source file to move — never renamed')
  assert.equal(saved, 'Video Face Detail - Second Stage')
})

// ---------------------------------------------------------------------------
// describeSaveOutcome — the pure mapper from saveActiveWorkflow's AUTHORITATIVE
// `details.mode` to the tool-result fields, so panel_save_workflow reports what a
// save did (mcp#579's "at minimum (2)": a rename-vs-copy must never be silent).
// It maps the DECIDED mode, never an after-the-fact guess from the mutable tab.

test('describeSaveOutcome: save-as-copy mode ⇒ saved_as + copied_from, extension stripped (mcp#579)', () => {
  const out = describeSaveOutcome({
    mode: 'save-as-copy',
    copiedFrom: 'UGC - 01 Imagem para Video (TI2V-5B).json'
  })
  assert.deepEqual(out, { saved_as: true, copied_from: 'UGC - 01 Imagem para Video (TI2V-5B)' })
  // It does NOT assert original_on_disk — that is a disk fact the caller verifies.
  assert.ok(!('original_on_disk' in out), 'preservation is disk-checked by the caller, not inferred')
})

test('describeSaveOutcome: first-save mode (temp/new_workflow) ⇒ first_save (panel#363)', () => {
  assert.deepEqual(describeSaveOutcome({ mode: 'first-save' }), { first_save: true })
})

test('describeSaveOutcome: in-place mode ⇒ no special flags', () => {
  assert.deepEqual(describeSaveOutcome({ mode: 'in-place', sourcePath: 'workflows/Foo.json' }), {})
})

test('describeSaveOutcome: absent/undefined mode ⇒ no special flags', () => {
  assert.deepEqual(describeSaveOutcome({}), {})
  assert.deepEqual(describeSaveOutcome(), {})
})

test('outcome: an EXTERNAL-path Save-As reports save-as-copy (NOT first-save), even though the source is non-persisted (mcp#579/#285)', async () => {
  // Finding-2 guard: an externally-loaded file is isPersisted:false/isTemporary:true
  // yet is a REAL existing file being COPIED into the user dir — it must report a
  // Save-As copy, never a first-save (which would wrongly imply "nothing to preserve").
  const active = {
    path: 'C:/packs/qwen/Product Label Repair.json',
    filename: 'Product Label Repair.json',
    directory: 'C:/packs/qwen',
    isPersisted: false,
    isTemporary: true,
  }
  const { svc, existsOnDisk } = makeStore147Service({ files: [active.path], active })

  const details = {}
  await saveActiveWorkflow(svc, 'Product Label Repair - Qwen Edit Q5', {
    autoWorkflowName: () => 'Untitled',
    existsOnDisk,
    details,
  })

  assert.equal(details.mode, 'save-as-copy', 'external real file copied ⇒ save-as-copy, not first-save')
  assert.equal(details.sourcePath, 'C:/packs/qwen/Product Label Repair.json', 'source path recorded for re-verification')
  // sourceExternal must be flagged so the panel-level post-save HEAD is SKIPPED — a
  // /userdata HEAD 404s on an absolute path and would else throw a false data-loss
  // error for a perfectly-preserved external original (codex round-2 P1).
  assert.equal(details.sourceExternal, true, 'external source flagged so the /userdata HEAD is not misread as a move')
  assert.deepEqual(describeSaveOutcome(details), {
    saved_as: true,
    copied_from: 'Product Label Repair'
  })
})

// ---------------------------------------------------------------------------
// classifyOriginalOnDisk — the throw/report decision for a Save-As COPY's source.
// A hard data-loss throw ("lost") requires POSITIVE pre-save evidence (a confirmed
// 200) now confirmed gone (404). Everything indeterminate degrades to "unverified"
// so a legitimate first save / phantom source never false-alarms (codex P1 #1).

test('classifyOriginalOnDisk: confirmed present-then-gone ⇒ lost (the only throw case)', () => {
  assert.equal(classifyOriginalOnDisk({ preExisted: true, postExists: false }), 'lost')
})

test('classifyOriginalOnDisk: source never proven present ⇒ NEVER lost (no false data-loss throw)', () => {
  // The exact P1 #1 repro: a non-temporary yet never-persisted tab whose source path
  // 404s afterward simply because it never existed. preExisted is false/unknown ⇒
  // must NOT be "lost".
  assert.equal(classifyOriginalOnDisk({ preExisted: false, postExists: false }), 'unverified')
  assert.equal(classifyOriginalOnDisk({ preExisted: null, postExists: false }), 'unverified')
  assert.equal(classifyOriginalOnDisk({ preExisted: undefined, postExists: false }), 'unverified')
})

test('classifyOriginalOnDisk: source present afterward ⇒ present', () => {
  assert.equal(classifyOriginalOnDisk({ preExisted: true, postExists: true }), 'present')
  assert.equal(classifyOriginalOnDisk({ preExisted: null, postExists: true }), 'present')
})

test('classifyOriginalOnDisk: inconclusive post probe ⇒ unverified (never throws)', () => {
  assert.equal(classifyOriginalOnDisk({ preExisted: true, postExists: null }), 'unverified')
  assert.equal(classifyOriginalOnDisk({ preExisted: null, postExists: null }), 'unverified')
  assert.equal(classifyOriginalOnDisk({}), 'unverified')
})

test('outcome: a WINDOWS ROOT-RELATIVE external source ("\\packs\\Foo.json") is external ⇒ save-as-copy + sourceExternal (codex P1 #2)', async () => {
  // A single leading backslash is root-relative on the current drive — an EXTERNAL
  // file, not a managed store path. It must copy into the user dir and report
  // save-as-copy + sourceExternal, NEVER first-save (which would hide the real source
  // and route the post-save HEAD into a false 404 alarm).
  const srcPath = String.raw`\packs\Foo.json` // real single backslashes (root-relative)
  const active = {
    path: srcPath,
    filename: 'Foo.json',
    directory: String.raw`\packs`,
    isPersisted: false,
    isTemporary: true,
  }
  const { svc, existsOnDisk } = makeStore147Service({ files: [active.path], active })

  const details = {}
  await saveActiveWorkflow(svc, 'Foo Copy', {
    autoWorkflowName: () => 'Untitled',
    existsOnDisk,
    details,
  })

  assert.equal(details.mode, 'save-as-copy', 'root-relative external source ⇒ save-as-copy, not first-save')
  assert.equal(details.sourceExternal, true, 'flagged external so the /userdata HEAD is skipped')
  // Copy landed in the USER workflows dir, external original untouched.
  assert.ok(svc.disk.has('workflows/Foo Copy.json'), 'copy in the user workflows dir')
  assert.ok(svc.disk.has(srcPath), 'external original preserved')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never moved the external original')
})

// ---------------------------------------------------------------------------
// Round-2 re-review: two MORE false-throw routes had to be closed.

test('P1 #1b: an IN-MEMORY-absent source with an UNKNOWN disk oracle does NOT throw (backstop is disk-gated, #226)', async () => {
  // The old backstop threw whenever getWorkflowByPath(source)==null after a copy — an
  // in-memory signal that drifts stale once the copy activates. Here the copy succeeds,
  // the source's in-memory lookup is null (stale), and the disk oracle is UNKNOWN for
  // the source (a timed-out HEAD). That is NOT proof of on-disk loss ⇒ must NOT throw.
  const active = {
    path: 'workflows/Foo.json',
    filename: 'Foo.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const { svc } = makeStore147Service({ files: ['workflows/Foo.json'], active })
  // Source disk-state UNKNOWN (null); everything else resolves via the seeded disk.
  const existsOnDisk = async (p) => (p === 'workflows/Foo.json' ? null : svc.disk.has(p))
  // Simulate in-memory staleness: the SOURCE lookup returns null (as if evicted), while
  // target lookups behave normally (free).
  const realGWBP = svc.getWorkflowByPath.bind(svc)
  svc.getWorkflowByPath = (p) => (p === 'workflows/Foo.json' ? null : realGWBP(p))

  const saved = await saveActiveWorkflow(svc, 'Bar', { existsOnDisk })

  assert.equal(saved, 'Bar', 'reported success — no false "moved" throw')
  assert.ok(svc.disk.has('workflows/Foo.json'), 'source still on disk (the copy never moved it)')
  assert.ok(svc.disk.has('workflows/Bar.json'), 'copy created')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never renamed')
})

test('P1 #1c: diskExistenceFromStatus treats ONLY 200 as present; non-200 2xx / redirects / 5xx are indeterminate', () => {
  assert.equal(diskExistenceFromStatus(200), true, '200 ⇒ present')
  assert.equal(diskExistenceFromStatus(404), false, '404 ⇒ absent')
  // A non-200 2xx a proxy might return must NOT count as the confirmed 200 the data-loss
  // gate requires — else a 204-then-404 pair would read as "lost".
  assert.equal(diskExistenceFromStatus(204), null, '204 ⇒ indeterminate')
  assert.equal(diskExistenceFromStatus(206), null, '206 ⇒ indeterminate')
  assert.equal(diskExistenceFromStatus(301), null, '301 ⇒ indeterminate')
  assert.equal(diskExistenceFromStatus(500), null, '500 ⇒ indeterminate')
  assert.equal(diskExistenceFromStatus(undefined), null, 'missing ⇒ indeterminate')
  // And a 204 pre / 404 post must classify UNVERIFIED, never lost:
  assert.equal(
    classifyOriginalOnDisk({ preExisted: diskExistenceFromStatus(204), postExists: diskExistenceFromStatus(404) }),
    'unverified',
    'non-200 pre-probe never yields a data-loss verdict'
  )
})

test('P2: a Windows DRIVE-RELATIVE source ("C:Foo.json", no separator) is external ⇒ save-as-copy + sourceExternal', async () => {
  const active = {
    path: 'C:Foo.json',
    filename: 'Foo.json',
    directory: 'C:',
    isPersisted: false,
    isTemporary: true,
  }
  const { svc, existsOnDisk } = makeStore147Service({ files: [active.path], active })

  const details = {}
  await saveActiveWorkflow(svc, 'Foo Copy', {
    autoWorkflowName: () => 'Untitled',
    existsOnDisk,
    details,
  })

  assert.equal(details.mode, 'save-as-copy', 'drive-relative external source ⇒ save-as-copy, not first-save')
  assert.equal(details.sourceExternal, true, 'flagged external so the /userdata HEAD is skipped')
  assert.ok(svc.disk.has('workflows/Foo Copy.json'), 'copy landed in the user workflows dir')
  assert.ok(svc.disk.has('C:Foo.json'), 'external original preserved')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never moved the external original')
})
