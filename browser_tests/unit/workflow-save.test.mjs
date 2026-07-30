import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isDefaultWorkflowName,
  saveActiveWorkflow
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
      calls.push(['saveWorkflowAs', wf.path, filename])
      // Copy: new file in the SOURCE's directory, with the mode-correct
      // extension; the original is left untouched.
      const dir = wf.directory || 'workflows'
      const base = stripExt(filename)
      const newFilename = `${base}${extFor(wf)}`
      const newPath = `${dir}/${newFilename}`
      disk.add(newPath)
      // The copy becomes the active workflow (mirrors the real frontend).
      svc.activeWorkflow = {
        path: newPath,
        filename: newFilename,
        directory: dir,
        initialMode: wf.initialMode,
        isPersisted: true,
        isTemporary: false
      }
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
  // It went through the copy path, never renameWorkflow.
  assert.ok(
    svc.calls.some((c) => c[0] === 'saveWorkflowAs'),
    'used saveWorkflowAs'
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
  assert.ok(svc.calls.some((c) => c[0] === 'saveWorkflowAs'), 'delegated to saveWorkflowAs')
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
  assert.ok(svc.calls.some((c) => c[0] === 'saveWorkflowAs'), 'used saveWorkflowAs')
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
  assert.ok(svc.calls.some((c) => c[0] === 'saveWorkflowAs'), 'used saveWorkflowAs')
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
      calls.push(['saveWorkflowAs', wf.path, filename, !!wf.isTemporary])
      const dir = wf.directory || 'workflows'
      const newPath = `${dir}/${stripExt(filename)}${extFor(wf)}`
      if (wf.isTemporary) {
        // Frontend's TEMPORARY branch: renameWorkflow(e, a) — MOVES the source.
        await svc.renameWorkflow(wf, newPath)
        svc.activeWorkflow = wf
      } else {
        // PERSISTED branch: copy, original untouched.
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
  assert.ok(svc.calls.some((c) => c[0] === 'saveWorkflowAs'), 'delegated to saveWorkflowAs')
  assert.equal(saved, 'Untitled 2026-07-29')
})

test('disk-existence backstop catches a saveWorkflowAs that moves a persisted source (#226)', async () => {
  // Rogue frontend: even a NON-temporary persisted source gets moved by
  // saveWorkflowAs. The pre-check can't foresee this, so the post-op
  // disk-existence guard must catch it and throw rather than report success.
  const active = {
    path: 'workflows/zz226b-orig.json',
    filename: 'zz226b-orig.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeFaithfulService({ files: [active.path], active })
  // Force the move branch regardless of flags.
  const origSaveAs = svc.saveWorkflowAs
  svc.saveWorkflowAs = async (wf, opts) => {
    wf.isTemporary = true
    return origSaveAs(wf, opts)
  }

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'zz226b-copy', {}),
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
  // Probe throws AFTER the (successful, copying) saveWorkflowAs.
  svc.getWorkflowByPath = () => {
    throw new Error('store index unavailable')
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
  assert.ok(svc.calls.some((c) => c[0] === 'saveWorkflowAs'), 'routed to the copy path')
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
    /save-as \(copy\) is unavailable on this frontend/
  )
  // NOTHING was copied or persisted — no null-content file; source untouched.
  assert.ok(!svc.disk.has('workflows/Bar.json'), 'no null-content copy written')
  assert.equal(svc.disk.get('workflows/Foo.json'), sourceContentBefore, 'source content untouched')
  assert.ok(!svc.calls.some((c) => c[0] === 'saveAs'), 'never created a copy')
  assert.ok(!svc.calls.some((c) => c[0] === 'saveWorkflow'), 'never persisted')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never moved')
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
  delete svc.saveWorkflowAs // older frontend without a copy path

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Bar', {}),
    /refusing to rename and destroy/
  )
  // Source untouched; nothing moved.
  assert.ok(svc.disk.has('workflows/Foo.json'))
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'))
})
