// #833 / #817 — NAMING THE CANVAS SWAP POINT.
//
// Both issues are blocked on one missing thing, stated on #833:
//
//   > Every remaining route needs the same missing thing: a moment where the
//   > canvas-to-workflow binding is PROVABLE, to seal from. That is not a gap in
//   > the proof predicates — it is that nothing in the panel can currently
//   > observe when the canvas is swapped.
//
// Four attempts from the store-API side failed, so this comes at it from the
// canvas-rebuild side: instrument the real frontend and record what actually
// happens. Measured against ComfyUI 0.31.1 / frontend 1.44.19, the answer is
// three facts, and this spec pins all three — because the fix that follows will
// depend on them, and a frontend upgrade that changes the order must not fail
// silently somewhere else.
//
// 1. THE CANVAS OBJECT IS NEVER REPLACED. `app.graph` is the same LGraph across
//    every swap; it is cleared and re-filled through `configure`. So no scheme
//    based on an object reference can identify a canvas — which is why
//    `changeTracker.graph` was worth eliminating, and why looking for a "new
//    graph object" was never going to find one.
//
// 2. `loadGraphData` BRACKETS THE WHOLE SWAP, with the store's own activation
//    NESTED INSIDE IT:
//
//        loadGraphData:before        store still names the OLD workflow
//          configure:before/after    graph now holds the NEW content
//        store.openWorkflow:after    store now names the NEW workflow
//        loadGraphData:after         both agree  ← the binding is provable HERE
//
// 3. THERE IS A WINDOW WHERE THEY DISAGREE — between `configure:after` and
//    `store.openWorkflow:after`, the graph holds the new canvas while the store
//    still names the previous workflow. Anything that reads identity in that
//    window gets a confident, wrong answer. That is the shape of this whole
//    issue cluster, and it is why the seal has to be taken at the AFTER edge of
//    `loadGraphData` rather than on any store event.
//
// This spec asserts the contract. It does not fix the write fence: that is a
// separate, deliberate act (the refusal has its own spec).
import { expect, test } from '@playwright/test'

interface Snap {
  label: string
  appGraph: string | null
  activeWorkflowPath: string | null
  nodeCount: number | null
  graphReplaced?: boolean
}

test('the canvas swap has an observable point where identity is provable (#833/#817)', async ({
  page,
}) => {
  await page.goto('/')
  await page.waitForFunction(
    () => !!((window as any).comfyAPI?.app?.app || (window as any).app)?.graph,
    undefined,
    { timeout: 60_000 },
  )

  await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const log: unknown[] = []
    w.__swapLog = log

    const idOf = (g: any) => {
      if (!g) return null
      if (!g.__probeId) g.__probeId = `graph#${Math.random().toString(36).slice(2, 8)}`
      return g.__probeId
    }
    const first = idOf(app?.graph)
    const snap = (label: string) => {
      const active = app?.extensionManager?.workflow?.activeWorkflow
      log.push({
        label,
        appGraph: idOf(app?.graph),
        activeWorkflowPath: active?.path ?? null,
        nodeCount: app?.graph?._nodes?.length ?? null,
        graphReplaced: idOf(app?.graph) !== first,
      })
    }

    if (typeof app?.loadGraphData === 'function') {
      const orig = app.loadGraphData.bind(app)
      app.loadGraphData = async function (...args: unknown[]) {
        snap('loadGraphData:before')
        const r = await orig(...args)
        snap('loadGraphData:after')
        return r
      }
    }
    const LGraphCtor = app?.graph?.constructor
    if (LGraphCtor?.prototype?.configure) {
      const orig = LGraphCtor.prototype.configure
      LGraphCtor.prototype.configure = function (...args: unknown[]) {
        const r = orig.apply(this, args)
        if (this === app?.graph) snap('configure:after')
        return r
      }
    }
    const store = app?.extensionManager?.workflow
    if (store && typeof store.openWorkflow === 'function') {
      const orig = store.openWorkflow.bind(store)
      store.openWorkflow = async function (...args: unknown[]) {
        const r = await orig(...args)
        snap('openWorkflow:after')
        return r
      }
    }
  })

  // Two real swaps through the frontend's own command.
  for (let i = 0; i < 2; i++) {
    await page.evaluate(async () => {
      const w = window as any
      const app = w.comfyAPI?.app?.app || w.app
      await app?.extensionManager?.command?.execute('Comfy.NewBlankWorkflow')
    })
    await page.waitForTimeout(1000)
  }

  const log = (await page.evaluate(() => (window as any).__swapLog)) as Snap[]
  const labels = log.map((e) => e.label)

  // FACT 1 — the canvas object is never replaced.
  expect(
    log.some((e) => e.graphReplaced),
    'app.graph was REPLACED — every identity scheme in #833/#817 assumed it is not, ' +
      'and the swap point moves if this changes',
  ).toBe(false)

  // FACT 2 — loadGraphData brackets the swap, and openWorkflow is nested inside.
  const open = labels.indexOf('openWorkflow:after')
  expect(open, 'the store never activated a workflow — the probe did not observe a swap').toBeGreaterThan(-1)
  const before = labels.lastIndexOf('loadGraphData:before', open)
  const after = labels.indexOf('loadGraphData:after', open)
  expect(before, 'openWorkflow must be nested INSIDE loadGraphData').toBeGreaterThan(-1)
  expect(after, 'loadGraphData must close AFTER the store activates').toBeGreaterThan(open)

  // FACT 3 — at the after edge, graph content and the store agree. THIS is the
  // moment a binding can be sealed from; nothing earlier is safe.
  const sealed = log[after]
  expect(sealed.activeWorkflowPath, 'at loadGraphData:after the store must name a workflow').toBeTruthy()
  expect(sealed.nodeCount, 'and the graph must be readable at that instant').not.toBeNull()

  // …and the window where they DISAGREE is real: the graph is re-filled by
  // `configure` before the store knows. This is what makes any earlier read wrong.
  //
  // ASSERTED, NOT SKIPPED. Behind an `if` this check would quietly become inert
  // the day the ordering changes — which is the one day it needs to speak. If
  // `configure` stops preceding the store's activation, the disagreement window
  // has closed and the seal could move earlier: a real finding, and this must
  // fail so someone looks, rather than pass by not running.
  const cfg = labels.indexOf('configure:after')
  expect(cfg, 'configure:after was never observed — the instrument missed the rebuild').toBeGreaterThan(-1)
  expect(
    cfg,
    'configure must precede the store activation, or the disagreement window is gone ' +
      'and the whole premise of sealing at the after-edge needs re-deriving',
  ).toBeLessThan(open)
  expect(
    log[cfg].activeWorkflowPath,
    'the graph was re-filled while the store still named the previous workflow — if these ' +
      'now agree, the window closed and the seal could move earlier',
  ).not.toBe(sealed.activeWorkflowPath)
})
