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

test('a never-saved placeholder tab is grounded via the copy path (safe rename of a temp)', async () => {
  const active = {
    path: 'workflows/Unsaved Workflow.json',
    filename: 'Unsaved Workflow.json',
    directory: 'workflows',
    isPersisted: false,
    isTemporary: true
  }
  const svc = makeService({ active })

  const saved = await saveActiveWorkflow(svc, undefined, {
    autoWorkflowName: () => 'Untitled 2026-07-24'
  })

  assert.ok(svc.calls.some((c) => c[0] === 'saveWorkflowAs'))
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
      return disk.has(path) ? { path, isPersisted: true } : undefined
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
    /would MOVE \(destroy\) the original/
  )
  // Original stands, nothing was moved, saveWorkflowAs was never even invoked.
  assert.ok(svc.disk.has('workflows/zz226b-orig.json'), 'original preserved')
  assert.ok(!svc.disk.has('workflows/zz226b-copy.json'), 'no rogue copy')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never renamed')
  assert.ok(!svc.calls.some((c) => c[0] === 'saveWorkflowAs'), 'never delegated a move')
})

test('a correctly-flagged persisted workflow still COPIES via the faithful frontend (#226)', async () => {
  const active = {
    path: 'workflows/zz226b-orig.json',
    filename: 'zz226b-orig.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const svc = makeFaithfulService({ files: [active.path], active })

  const saved = await saveActiveWorkflow(svc, 'zz226b-copy', {})

  assert.ok(svc.disk.has('workflows/zz226b-orig.json'), 'original preserved')
  assert.ok(svc.disk.has('workflows/zz226b-copy.json'), 'copy created')
  assert.ok(!svc.calls.some((c) => c[0] === 'renameWorkflow'), 'never renamed')
  assert.equal(saved, 'zz226b-copy')
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
