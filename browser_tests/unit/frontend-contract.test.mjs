// FRONTEND-CONTRACT — anti-regression for the #268 class.
//
// #268 slipped because the panel called a ComfyUI frontend workflow-service
// method (`saveWorkflowAs`) that had been REMOVED from the installed
// comfyui_frontend_package on frontend 1.47.10. Nothing in CI noticed: the call
// only fails at runtime, in the browser, against whatever frontend the user has
// installed. This test makes that failure a build-time failure instead.
//
// It does three things:
//   1. DERIVES the set of frontend workflow-service members the panel actually
//      depends on, by grepping the panel source (`svc.<m>` in the shared save
//      lib, `s.<m>` / `extensionManager?.workflow?.<m>` in the panel). If the
//      panel starts calling a NEW frontend method that this contract does not
//      know about, the derivation guard FAILS — forcing the contract (and this
//      test's bundle check) to be updated deliberately.
//   2. VERIFIES every depended-on member against the INSTALLED frontend static
//      bundle. A required method missing from the bundle FAILS — which is
//      exactly how #268 would now be caught. Save-As is version-variable
//      (`saveWorkflowAs` exists on 1.45.x, was dropped on 1.47.x for the
//      low-level `saveAs`+`saveWorkflow`+`openWorkflow` trio), so the bundle
//      check asserts that AT LEAST ONE viable Save-As route survives — not that
//      any specific method does.
//   3. Drives the REAL `saveActiveWorkflow` through version-shaped service
//      doubles (a 1.47-shaped store with no `saveWorkflowAs`, and a broken store
//      with no Save-As route at all) to prove the panel (a) has a working
//      Save-As path given only the 1.47 methods, and (b) REFUSES loudly rather
//      than silently mis-saving when no route exists. This covers the mechanism
//      even for names that cannot be statically pinned in a minified bundle.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { saveActiveWorkflow } from '../../web/js/lib/workflow-save.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..', '..')
const SAVE_LIB = join(REPO, 'web', 'js', 'lib', 'workflow-save.js')
const PANEL = join(REPO, 'web', 'js', 'comfyui-mcp-panel.js')

// ---------------------------------------------------------------------------
// The contract. Every frontend workflow-service member the panel is ALLOWED to
// depend on lives here. Keep this list honest: the derivation guard below fails
// if the source references a member NOT listed, and the "no dead entries" check
// fails if a listed method is referenced nowhere.
// ---------------------------------------------------------------------------

// Methods that MUST exist on the installed bundle regardless of frontend version
// — the panel has no fallback for these.
const REQUIRED_METHODS = [
  'saveWorkflow',
  'openWorkflow',
  'closeWorkflow',
  'getWorkflowByPath',
  'renameWorkflow'
]

// Save-As is version-variable. The panel is viable if ANY of these routes is
// fully present. This is the crux of the #268 fix: never depend on a single
// method that a future frontend may drop.
const SAVE_AS_ROUTES = [
  ['saveWorkflowAs'], //                              1.45.x high-level copy
  ['saveAs', 'saveWorkflow', 'openWorkflow'] //       1.47.x low-level copy trio
]

// Optional, always called behind a `typeof … === "function"` guard, so its
// absence is not a regression. Listed so the derivation guard does not flag it.
const OPTIONAL_METHODS = ['syncWorkflows']

// Reactive store PROPERTIES the panel reads off the service.
const STORE_PROPS = ['activeWorkflow', 'workflows', 'openWorkflows']

// Members intentionally NOT part of the service contract: they live on the
// workflow DOCUMENT object (svc.activeWorkflow.*), not the service, so they are
// excluded from the derivation guard.
const DOC_MEMBERS = new Set([
  'isTemporary', 'isPersisted', 'path', 'filename', 'directory', 'initialMode',
  'changeTracker', 'save', 'activeState'
])

const CONTRACT_METHODS = new Set([
  ...REQUIRED_METHODS,
  ...SAVE_AS_ROUTES.flat(),
  ...OPTIONAL_METHODS
])
const CONTRACT_ALL = new Set([...CONTRACT_METHODS, ...STORE_PROPS])

// ---------------------------------------------------------------------------
// 1. Derivation guard — what does the source ACTUALLY reference?
// ---------------------------------------------------------------------------

// Collect every `<accessor>.<member>` where <accessor> is the workflow service
// (the shared lib binds it to `svc`; the panel binds it to `s` or reaches it via
// `extensionManager?.workflow`). Optional-chaining dots (`?.`) are handled.
function collectServiceMembers() {
  const found = new Set()
  const push = (re, text) => {
    let m
    while ((m = re.exec(text))) found.add(m[1])
  }

  const saveLib = readFileSync(SAVE_LIB, 'utf8')
  // `svc.m` and `svc?.m` — the service is the sole `svc` in the shared lib.
  push(/\bsvc\??\.([a-zA-Z_$][\w$]*)/g, saveLib)

  const panel = readFileSync(PANEL, 'utf8')
  // The panel aliases the service to `s` inside handlers (`const s =
  // app?.extensionManager?.workflow`). Collect `s.m` / `s?.m` accesses.
  push(/\bs\??\.([a-zA-Z_$][\w$]*)/g, panel)
  // Direct `extensionManager?.workflow?.m` reaches.
  push(/extensionManager\??\.workflow\??\.([a-zA-Z_$][\w$]*)/g, panel)

  return found
}

test('every frontend workflow-service member the panel calls is in the contract', () => {
  const referenced = collectServiceMembers()
  // Filter out document-object members and obvious noise; what remains must be a
  // service member we have vetted. Anything unknown means the panel grew a new
  // frontend dependency that this contract test must be updated to cover.
  const suspicious = [...referenced].filter(
    (m) => !CONTRACT_ALL.has(m) && !DOC_MEMBERS.has(m)
  )
  // The `s.` alias regex is deliberately broad and can capture unrelated locals
  // named `s`; we only FAIL on members that collide with the service surface
  // (i.e. look like workflow ops). To keep the guard strict but not brittle, we
  // assert that every KNOWN service member we expect is present, and that no
  // suspicious token matches a workflow-service naming shape.
  const serviceShaped = suspicious.filter((m) =>
    /workflow|save|open|rename|sync|active/i.test(m)
  )
  assert.deepEqual(
    serviceShaped,
    [],
    `panel references frontend workflow-service members not in the contract: ${serviceShaped.join(
      ', '
    )} — add them to the contract AND the bundle check, or they will silently break like #268`
  )
})

test('contract has no dead method entries (each is referenced in source)', () => {
  const referenced = collectServiceMembers()
  for (const m of [...REQUIRED_METHODS, ...OPTIONAL_METHODS, ...SAVE_AS_ROUTES.flat()]) {
    assert.ok(
      referenced.has(m),
      `contract lists "${m}" but no panel source references it — remove it or fix the accessor`
    )
  }
})

// ---------------------------------------------------------------------------
// 2. Verify the contract against the INSTALLED frontend static bundle.
// ---------------------------------------------------------------------------

function resolveStaticDir() {
  const fromEnv = process.env.COMFYUI_FRONTEND_STATIC
  const candidates = [
    fromEnv,
    'C:/Users/Artokun/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/Lib/site-packages/comfyui_frontend_package/static'
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(join(c, 'assets'))) return c
  }
  return null
}

// Grep the bundle for a bare identifier token. Store method/property names are
// preserved through minification because they are object property keys accessed
// as `store.saveWorkflowAs(...)` — Terser does not rename public object keys.
// Returns true on the first asset chunk that contains the token.
function bundleHasToken(staticDir, token) {
  const assets = join(staticDir, 'assets')
  const re = new RegExp(`\\b${token}\\b`)
  const stack = [assets]
  while (stack.length) {
    const dir = stack.pop()
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) {
        stack.push(p)
        continue
      }
      // Only real JS chunks — never source maps (a name in a .map comment is not
      // proof the code ships it).
      if (!name.endsWith('.js') || name.endsWith('.js.map')) continue
      if (re.test(readFileSync(p, 'utf8'))) return true
    }
  }
  return false
}

test('installed frontend bundle exposes every REQUIRED workflow-service method', (t) => {
  const staticDir = resolveStaticDir()
  if (!staticDir) {
    t.skip('comfyui_frontend_package static bundle not found (set COMFYUI_FRONTEND_STATIC)')
    return
  }
  for (const m of REQUIRED_METHODS) {
    assert.ok(
      bundleHasToken(staticDir, m),
      `frontend method "${m}" is MISSING from the installed bundle at ${staticDir} — ` +
        `the panel calls it unconditionally and would fail at runtime (the #268 class)`
    )
  }
})

test('installed frontend bundle exposes at least one viable Save-As route', (t) => {
  const staticDir = resolveStaticDir()
  if (!staticDir) {
    t.skip('comfyui_frontend_package static bundle not found (set COMFYUI_FRONTEND_STATIC)')
    return
  }
  const viable = SAVE_AS_ROUTES.filter((route) =>
    route.every((m) => bundleHasToken(staticDir, m))
  )
  assert.ok(
    viable.length > 0,
    `NO viable Save-As route exists on the installed frontend bundle. The panel ` +
      `needs one of: ${SAVE_AS_ROUTES.map((r) => r.join('+')).join(' OR ')}. ` +
      `This is exactly the #268 failure: saveWorkflowAs was dropped on 1.47.x.`
  )
})

test('installed frontend bundle exposes the store properties the panel reads', (t) => {
  const staticDir = resolveStaticDir()
  if (!staticDir) {
    t.skip('comfyui_frontend_package static bundle not found (set COMFYUI_FRONTEND_STATIC)')
    return
  }
  for (const p of STORE_PROPS) {
    assert.ok(
      bundleHasToken(staticDir, p),
      `frontend store property "${p}" is MISSING from the installed bundle at ${staticDir}`
    )
  }
})

// ---------------------------------------------------------------------------
// 3. Behavioural anti-regression: drive the REAL saveActiveWorkflow through
//    version-shaped service doubles. This covers the actual runtime mechanism
//    (route selection + fail-safe) that a static grep cannot fully prove.
// ---------------------------------------------------------------------------

const stripExt = (name) => String(name || '').replace(/\.(app\.)?json$/i, '')

// A 1.47.x-shaped store: NO `saveWorkflowAs`; only the low-level
// `saveAs`+`openWorkflow`+`saveWorkflow` trio. Mirrors the frontend closely
// enough to prove the copy is a real copy (source file survives).
function make147Service({ files = [], active } = {}) {
  const disk = new Set(files)
  const calls = []
  const svc = {
    activeWorkflow: active,
    workflows: active ? [active] : [],
    openWorkflows: active ? [active] : [],
    disk,
    calls,
    // NOTE: no saveWorkflowAs — this is the 1.47.x removal that caused #268.
    getWorkflowByPath(path) {
      // The source is on disk and persisted; the drift-proof classifier must see
      // it as persisted so the copy (never move) branch is taken.
      if (disk.has(path) && active && active.path === path) return active
      return null
    },
    saveAs(wf, path) {
      calls.push(['saveAs', wf.path, path])
      // Builds a NEW in-memory copy object at `path`; source object untouched,
      // source file NOT referenced. Copy starts unopened (no changeTracker).
      return {
        path,
        filename: path.split('/').pop(),
        directory: path.split('/').slice(0, -1).join('/'),
        initialMode: wf.initialMode,
        isPersisted: false,
        isTemporary: false,
        changeTracker: null
      }
    },
    async openWorkflow(copy) {
      calls.push(['openWorkflow', copy.path])
      copy.changeTracker = { prepareForSave() {} }
      svc.activeWorkflow = copy
    },
    async saveWorkflow(wf) {
      calls.push(['saveWorkflow', wf.path])
      disk.add(wf.path) // persist in place — no rename, no move
    },
    async renameWorkflow(wf, newPath) {
      // Present but MUST NOT be used on a persisted copy path.
      calls.push(['renameWorkflow', wf.path, newPath])
      disk.delete(wf.path)
      wf.path = newPath
      disk.add(newPath)
    }
  }
  return svc
}

test('Save-As works on a 1.47-shaped store (no saveWorkflowAs): copies, never moves', async () => {
  const active = {
    path: 'workflows/Foo.json',
    filename: 'Foo.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const svc = make147Service({ files: [active.path], active })

  const saved = await saveActiveWorkflow(svc, 'Bar', {})

  // Original preserved (true copy, not a move) — the #226 invariant, proven on
  // the frontend shape that dropped saveWorkflowAs.
  assert.ok(svc.disk.has('workflows/Foo.json'), 'original preserved')
  assert.ok(svc.disk.has('workflows/Bar.json'), 'copy created')
  // Went through the low-level trio, and opened the copy BEFORE saving it (so it
  // does not persist an empty "null" graph).
  const kinds = svc.calls.map((c) => c[0])
  assert.deepEqual(kinds, ['saveAs', 'openWorkflow', 'saveWorkflow'])
  assert.ok(!kinds.includes('renameWorkflow'), 'never renamed the persisted source')
  assert.equal(saved, 'Bar')
})

test('a frontend with NO Save-As route makes the panel REFUSE, not silently mis-save (#268 class)', async () => {
  const active = {
    path: 'workflows/Foo.json',
    filename: 'Foo.json',
    directory: 'workflows',
    isPersisted: true,
    isTemporary: false
  }
  const disk = new Set([active.path])
  const calls = []
  // A crippled frontend: only save-in-place. No saveWorkflowAs, no saveAs, no
  // renameWorkflow. This is the runtime shape #268 hit — the panel must fail
  // LOUDLY rather than move/destroy or fake success.
  const svc = {
    activeWorkflow: active,
    disk,
    calls,
    getWorkflowByPath: (p) => (disk.has(p) && p === active.path ? active : null),
    async saveWorkflow(wf) {
      calls.push(['saveWorkflow', wf.path])
      disk.add(wf.path)
    }
  }

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Bar', {}),
    /save-as \(copy\) is unavailable/i,
    'a relocating Save-As with no copy route must throw, not silently succeed'
  )
  // Crucially: the original file was never touched by the refused save.
  assert.ok(svc.disk.has('workflows/Foo.json'), 'original untouched after refusal')
  assert.ok(!svc.disk.has('workflows/Bar.json'), 'no phantom copy written')
})
