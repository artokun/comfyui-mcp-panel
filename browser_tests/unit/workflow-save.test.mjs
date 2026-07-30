import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isDefaultWorkflowName,
  saveActiveWorkflow
} from '../../web/js/lib/workflow-save.js'

// A minimal ComfyUI workflow-service double that records what was called and
// simulates the on-disk file set, so we can prove Save-As never consumes the
// source file (issue #226).
function makeService({ files = [], active } = {}) {
  const disk = new Set(files)
  const calls = []
  const svc = {
    activeWorkflow: active,
    calls,
    disk,
    async saveWorkflow(wf) {
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
      // Copy: new file in the SOURCE's directory, original left untouched.
      const dir = wf.directory || 'workflows'
      const newPath = `${dir}/${filename}.json`
      disk.add(newPath)
      // The copy becomes the active workflow (mirrors the real frontend).
      svc.activeWorkflow = {
        path: newPath,
        filename: `${filename}.json`,
        directory: dir,
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
