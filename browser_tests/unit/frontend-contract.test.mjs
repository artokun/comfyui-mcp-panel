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

// Version-variable Save-As methods. The panel MUST only ever reach these behind
// a `typeof … === "function"` capability check (never an unconditional call), so
// that a frontend which dropped one degrades to another route instead of
// throwing — the #268 lesson. The guard test below enforces that.
const VERSION_VARIABLE_METHODS = ['saveWorkflowAs', 'saveAs']

const CONTRACT_METHODS = new Set([
  ...REQUIRED_METHODS,
  ...SAVE_AS_ROUTES.flat(),
  ...OPTIONAL_METHODS
])
const CONTRACT_ALL = new Set([...CONTRACT_METHODS, ...STORE_PROPS])

// ---------------------------------------------------------------------------
// 1. Derivation guard — what does the source ACTUALLY reference?
// ---------------------------------------------------------------------------

// Strip line and block comments so the derivation guard reasons about EXECUTABLE
// code only — a service name mentioned in a comment must never satisfy (or trip)
// the contract. Deliberately simple: good enough for member-access scanning, and
// it never turns a real `accessor.member` call into something else.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// Collect every `<accessor>.<member>` where <accessor> is DEFINITELY the
// workflow service. The shared lib binds it to `svc`; the panel binds it to `s`
// inside handlers (`const s = app?.extensionManager?.workflow`) or reaches it via
// `extensionManager?.workflow`. To avoid capturing unrelated locals named `s`,
// the `s.` scan is SCOPED to the lines that follow each such alias assignment.
function collectServiceMembers() {
  const found = new Set()
  const push = (re, text) => {
    let m
    while ((m = re.exec(text))) found.add(m[1])
  }

  // Capture accesses off an accessor expression `acc`, in every shape that could
  // introduce a NEW frontend dependency: dot (`acc.m` / `acc?.m`), bracket
  // (`acc["m"]`), and destructuring (`const { a, b } = acc`). All feed the same
  // `found` set so no access form can silently escape the contract.
  const captureAccessesIn = (text, a) => {
    push(new RegExp(`${a}(?:\\?\\.|\\.)([a-zA-Z_$][\\w$]*)`, 'g'), text) // acc.m / acc?.m
    push(new RegExp(`${a}(?:\\?\\.)?\\[\\s*["']([^"']+)["']\\s*\\]`, 'g'), text) // acc["m"]
    let d
    const destr = new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${a}\\b`, 'g')
    while ((d = destr.exec(text))) {
      for (const part of d[1].split(',')) {
        const name = part.split(':')[0].trim().replace(/^\.\.\./, '')
        if (/^[a-zA-Z_$][\w$]*$/.test(name)) found.add(name)
      }
    }
  }

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // TRANSITIVE aliasing: a re-alias `const workflow = svc` (or `= s`) makes
  // `workflow.newMethod()` an equally live dependency. Given a set of known
  // accessor IDENTIFIER names in `text`, discover every `const|let|var X = <name>`
  // (and bare `X = <name>`) re-alias to a fixpoint, then capture accesses off ALL
  // of them. Bounded to whatever `text` scope is passed in (whole shared lib, or
  // a single handler block for the panel), so it never reaches unrelated locals.
  const expandNames = (text, seedNames) => {
    const names = new Set(seedNames)
    let changed = true
    while (changed) {
      changed = false
      for (const n of [...names]) {
        const re = new RegExp(
          `(?:\\b(?:const|let|var)\\s+)?([a-zA-Z_$][\\w$]*)\\s*=\\s*${esc(n)}\\s*(?:[;,)\\n]|$)`,
          'g'
        )
        let m
        while ((m = re.exec(text))) {
          if (!names.has(m[1])) {
            names.add(m[1])
            changed = true
          }
        }
      }
    }
    return names
  }

  const saveLib = stripComments(readFileSync(SAVE_LIB, 'utf8'))
  // `svc` is the seed service accessor in the shared lib; expand re-aliases.
  for (const n of expandNames(saveLib, ['svc'])) captureAccessesIn(saveLib, esc(n))

  const panelRaw = stripComments(readFileSync(PANEL, 'utf8'))
  // Direct `extensionManager?.workflow?.m` / `["m"]` / destructuring reaches.
  captureAccessesIn(panelRaw, 'extensionManager\\??\\.workflow')

  // Alias-scoped accesses: the panel binds the service to a local
  // (`const s = app?.extensionManager?.workflow`). Capture the alias NAME
  // dynamically (const/let/var, any identifier), then scan every access off that
  // name — and any re-alias of it — within the handler block that CONTAINS the
  // binding, bounded by brace matching (no fixed line cap), so a call anywhere
  // later in the same handler is caught while unrelated locals stay out.
  let a
  // Bind ONLY when the RHS is the workflow service itself — i.e. `…workflow` is
  // the tail of the expression, not `…workflow?.activeWorkflow` (which is a
  // workflow DOCUMENT, not the service). The negative lookahead excludes a
  // further `.`/`?.` member access after `workflow`. Matches BOTH a declaration
  // (`const s = …`) and a bare assignment to a pre-declared variable (`s = …`),
  // so `let s; s = app.extensionManager.workflow; s.foo()` cannot bypass it.
  const aliasRe =
    /(?:\b(?:const|let|var)\s+)?([a-zA-Z_$][\w$]*)\s*=\s*[\w.?]*extensionManager\??\.workflow(?!\s*\??\.)/g
  while ((a = aliasRe.exec(panelRaw))) {
    const aliasName = a[1]
    const block = enclosingBlockAfter(panelRaw, aliasRe.lastIndex)
    for (const n of expandNames(block, [aliasName])) captureAccessesIn(block, esc(n))
  }

  return found
}

// Return the source from `from` up to (but excluding) the `}` that closes the
// block the alias lives in — i.e. scan forward and stop at the first `}` seen at
// brace-depth 0. Nested `{ … }` are consumed. This bounds the `s.` scan to the
// exact handler, however long, with no fixed line cap.
function enclosingBlockAfter(src, from) {
  let depth = 0
  for (let i = from; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      if (depth === 0) return src.slice(from, i)
      depth--
    }
  }
  return src.slice(from)
}

test('every frontend workflow-service member the panel calls is in the contract', () => {
  const referenced = collectServiceMembers()
  // STRICT: the scanner only captures the FIRST member off the service accessor
  // (`svc.X` / `s.X`), so document-object reaches like `svc.activeWorkflow.save()`
  // contribute only `activeWorkflow` (a contracted store prop) — `save` is never
  // captured. Therefore EVERY captured member must be in the vetted contract,
  // with no exemption list to hide behind. A brand-new call like `s.remove(...)`
  // or a direct `s.save(...)` on the service fails here, forcing the contract AND
  // the bundle check to be updated deliberately.
  const unknown = [...referenced].filter((m) => !CONTRACT_ALL.has(m)).sort()
  assert.deepEqual(
    unknown,
    [],
    `panel references frontend workflow-service members not in the contract: ${unknown.join(
      ', '
    )} — add them to the contract AND the bundle check, or they will silently break like #268`
  )
})

test('contract has no dead method entries (each is referenced in executable source)', () => {
  const referenced = collectServiceMembers()
  for (const m of [...REQUIRED_METHODS, ...OPTIONAL_METHODS, ...SAVE_AS_ROUTES.flat()]) {
    assert.ok(
      referenced.has(m),
      `contract lists "${m}" but no panel source references it — remove it or fix the accessor`
    )
  }
})

test('version-variable Save-As methods are only reached behind a typeof capability guard (never unconditionally)', () => {
  const saveLib = stripComments(readFileSync(SAVE_LIB, 'utf8'))
  const panel = stripComments(readFileSync(PANEL, 'utf8'))

  // The `{ … }` regions gated by a `typeof svc?.<m> === "function"` guard: from
  // each guard, the next `{` (the if-body / block open) brace-matched to its `}`.
  const guardedRegions = (text, m) => {
    const regions = []
    const g = new RegExp(`typeof\\s+svc\\??\\.${m}\\s*===?\\s*["']function["']`, 'g')
    let hit
    while ((hit = g.exec(text))) {
      const open = text.indexOf('{', hit.index)
      if (open === -1) continue
      let depth = 0
      for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}' && --depth === 0) {
          regions.push([open, i])
          break
        }
      }
    }
    return regions
  }

  for (const m of VERSION_VARIABLE_METHODS) {
    // The panel delegates all saving to the shared lib; it must never call a
    // version-variable method directly. A direct `.saveWorkflowAs(` in the panel
    // is EXACTLY the #268 shape (unconditional dependence on a droppable method).
    assert.ok(
      !new RegExp(`\\.${m}\\s*\\(`).test(panel),
      `comfyui-mcp-panel.js calls .${m}() directly — route it through the shared, ` +
        `capability-guarded save lib instead (unconditional use is the #268 bug)`
    )
    // In the shared lib, EVERY call site must sit INSIDE a block controlled by a
    // `typeof svc?.<m> === "function"` guard — not merely be outnumbered by
    // guards. We locate each call and require it to fall within some guarded
    // region, so an unconditional call (even alongside an unrelated typeof check)
    // FAILS.
    const regions = guardedRegions(saveLib, m)
    const callRe = new RegExp(`\\bsvc\\??\\.${m}\\s*\\(`, 'g')
    let call
    while ((call = callRe.exec(saveLib))) {
      const at = call.index
      const guarded = regions.some(([o, c]) => at > o && at < c)
      assert.ok(
        guarded,
        `workflow-save.js calls svc.${m}() at offset ${at} OUTSIDE any ` +
          `"typeof svc?.${m} === 'function'" guarded block — a frontend missing ${m} ` +
          `would throw instead of falling back (the #268 bug)`
      )
    }
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

// A token in MEMBER/METHOD/KEY context (not a bare word anywhere): a member
// access `.m(` / `.m` or an object/class key/method `m:` / `m(`. Store method
// and property names survive minification because they are public object keys
// (Terser does not rename them).
function memberKeyRe(token) {
  return new RegExp(`(?:\\.${token}\\b)|(?:\\b${token}\\s*[:(])`)
}

// Walk every real .js chunk (never .map — a name in a source map is not proof
// the code ships it).
function eachJsChunk(staticDir, visit) {
  const stack = [join(staticDir, 'assets')]
  while (stack.length) {
    const dir = stack.pop()
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        stack.push(p)
        continue
      }
      if (!name.endsWith('.js') || name.endsWith('.js.map')) continue
      visit(readFileSync(p, 'utf8'))
    }
  }
}

// The workflow SERVICE is a single store object; a bare grep for `saveWorkflowAs`
// anywhere could match an UNRELATED object that still carries the name after the
// workflow store dropped it (a #268 false-pass). So we first isolate the chunk(s)
// that actually define the workflow store — identified by the co-occurrence of a
// strong fingerprint of members that only that store carries together — and then
// verify every contract member WITHIN that text. This ties presence to the
// workflow service specifically. (It remains a static approximation — a minified
// bundle exposes no literal `extensionManager.workflow.<m>` chain — which is why
// the behavioural doubles below independently cover the runtime route logic.)
//
// IMPORTANT — accepted static limitation: a MINIFIED bundle exposes no literal
// `extensionManager.workflow.<method>` chain (the store is a renamed local), so
// no static check can PROVE a given method key belongs to the workflow store
// object specifically. The fingerprint narrows the search to the chunk(s) that
// define the store, and route viability requires the route's methods to be
// CO-LOCATED in one such chunk — but a determined false pass (an unrelated class
// in the same chunk also named `saveAs`) is not fully excluded. This is exactly
// the case the task says to "document why and cover with a version-shaped
// double": the behavioural tests in section 3 are the AUTHORITATIVE check of the
// route-selection mechanism; this bundle check is the best-effort early tripwire.
const FINGERPRINT = ['openWorkflow', 'getWorkflowByPath', 'renameWorkflow']
const _serviceChunksCache = new Map()
function serviceChunks(staticDir) {
  if (_serviceChunksCache.has(staticDir)) return _serviceChunksCache.get(staticDir)
  const chunks = []
  eachJsChunk(staticDir, (text) => {
    if (FINGERPRINT.every((m) => memberKeyRe(m).test(text))) chunks.push(text)
  })
  _serviceChunksCache.set(staticDir, chunks)
  return chunks
}

// A member present in ANY workflow-store chunk.
function serviceHas(staticDir, token) {
  return serviceChunks(staticDir).some((c) => memberKeyRe(token).test(c))
}

// A whole route present TOGETHER in a SINGLE workflow-store chunk (co-located —
// so a route cannot be "assembled" from methods scattered across unrelated
// chunks).
function routeCoLocated(staticDir, route) {
  return serviceChunks(staticDir).some((c) => route.every((m) => memberKeyRe(m).test(c)))
}

test('installed frontend bundle exposes every REQUIRED workflow-service method', (t) => {
  const staticDir = resolveStaticDir()
  if (!staticDir) {
    t.skip('comfyui_frontend_package static bundle not found (set COMFYUI_FRONTEND_STATIC)')
    return
  }
  // The fingerprint must resolve to a real workflow-store chunk first — an empty
  // result means the workflow service itself is absent from this bundle.
  assert.ok(
    serviceChunks(staticDir).length > 0,
    `could not locate the workflow-service chunk in the bundle at ${staticDir} ` +
      `(no chunk carries all of ${FINGERPRINT.join(', ')}) — the frontend layout changed; ` +
      `update the fingerprint`
  )
  for (const m of REQUIRED_METHODS) {
    assert.ok(
      serviceHas(staticDir, m),
      `frontend method "${m}" is MISSING from the workflow-service chunk of the bundle at ` +
        `${staticDir} — the panel calls it unconditionally and would fail at runtime (#268 class)`
    )
  }
})

test('installed frontend bundle exposes at least one viable Save-As route', (t) => {
  const staticDir = resolveStaticDir()
  if (!staticDir) {
    t.skip('comfyui_frontend_package static bundle not found (set COMFYUI_FRONTEND_STATIC)')
    return
  }
  const viable = SAVE_AS_ROUTES.filter((route) => routeCoLocated(staticDir, route))
  assert.ok(
    viable.length > 0,
    `NO viable Save-As route exists on the workflow-service chunk of the installed bundle. ` +
      `The panel needs one of: ${SAVE_AS_ROUTES.map((r) => r.join('+')).join(' OR ')}. ` +
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
      serviceHas(staticDir, p),
      `frontend store property "${p}" is MISSING from the workflow-service chunk at ${staticDir}`
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
  // A crippled frontend with NO copy API (no saveWorkflowAs, no saveAs) but which
  // DOES expose the destructive renameWorkflow. This is the dangerous shape the
  // #226 fallback gate must resist: for a PERSISTED source, renameWorkflow would
  // MOVE (destroy) the original, so the panel must refuse — never rename. The
  // rename spy proves the destructive path is not taken.
  const svc = {
    activeWorkflow: active,
    disk,
    calls,
    getWorkflowByPath: (p) => (disk.has(p) && p === active.path ? active : null),
    async saveWorkflow(wf) {
      calls.push(['saveWorkflow', wf.path])
      disk.add(wf.path)
    },
    async renameWorkflow(wf, newPath) {
      calls.push(['renameWorkflow', wf.path, newPath])
      disk.delete(wf.path)
      wf.path = newPath
      disk.add(newPath)
    }
  }

  await assert.rejects(
    () => saveActiveWorkflow(svc, 'Bar', {}),
    /save-as \(copy\) is unavailable/i,
    'a relocating Save-As with no copy route must throw, not silently succeed'
  )
  assert.ok(
    !svc.calls.some((c) => c[0] === 'renameWorkflow'),
    'must NEVER renameWorkflow a persisted source (that is the #226 move-destroy)'
  )
  // Crucially: the refusal happened BEFORE any write — saveWorkflow was never
  // even invoked on the source (a regression that wrote through saveWorkflow and
  // then threw would still corrupt the on-disk file; this asserts it did not).
  assert.deepEqual(svc.calls, [], 'refused before any save/rename call')
  assert.ok(svc.disk.has('workflows/Foo.json'), 'original untouched after refusal')
  assert.equal(svc.disk.size, 1, 'no phantom copy or extra file written')
  assert.ok(!svc.disk.has('workflows/Bar.json'), 'no phantom copy written')
})
