// #833 / #817 — WHAT IS ACTUALLY OBSERVABLE WHEN THE CANVAS IS SWAPPED.
//
// Both issues are blocked on the same missing thing, stated on #833: a moment
// where the canvas-to-workflow binding is PROVABLE, to seal from. Four attempts
// from the store-API side failed to find one, so this comes at it from the
// canvas-rebuild side — instrumenting the live frontend rather than reading its
// surface.
//
// THIS SPEC IS EVIDENCE, AND IT IS DELIBERATELY NARROW. A first version claimed
// "the binding is provable at loadGraphData:after" and codex refused it: the
// claim was broader than the measurement in three ways, and two issues were
// about to be built on it.
//
//   • Pairing was by label position (`indexOf`/`lastIndexOf`), which cannot
//     establish that one call is NESTED IN another. Calls now carry ids.
//   • "Provable" was asserted from "a path is truthy and a graph exists", which
//     does not show the graph was configured FROM that workflow.
//   • Only `Comfy.NewBlankWorkflow` was exercised, so nothing excluded swap
//     routes that bypass `loadGraphData` entirely.
//
// So this asserts only what it measures, across every swap route it can drive,
// and records the one thing that is unambiguous and load-bearing for the fix.
import { expect, test } from '@playwright/test'

interface Ev {
  kind: 'load:enter' | 'load:exit' | 'configure' | 'open:exit'
  id: number
  /** ids of the loadGraphData calls in progress when this happened. */
  stack: number[]
  graph: string | null
  graphIsApp: boolean
  path: string | null
  nodes: number | null
  graphEverReplaced: boolean
}

async function instrument(page: import('@playwright/test').Page): Promise<void> {
  const installed = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const log: Ev[] = []
    const stack: number[] = []
    let seq = 0
    let replaced = false
    w.__ev = log

    const first = app?.graph
    const idOf = (g: any) => {
      if (!g) return null
      if (!g.__pid) g.__pid = `g${Math.random().toString(36).slice(2, 7)}`
      return g.__pid
    }
    const push = (kind: Ev['kind'], id: number, graph: any) => {
      if (app?.graph !== first) replaced = true
      const active = app?.extensionManager?.workflow?.activeWorkflow
      log.push({
        kind,
        id,
        stack: [...stack],
        graph: idOf(graph),
        graphIsApp: graph === app?.graph,
        path: active?.path ?? null,
        nodes: app?.graph?._nodes?.length ?? null,
        graphEverReplaced: replaced,
      })
    }

    const ok = { load: false, configure: false, open: false }

    if (typeof app?.loadGraphData === 'function') {
      const orig = app.loadGraphData.bind(app)
      app.loadGraphData = async function (...args: unknown[]) {
        const id = ++seq
        stack.push(id)
        push('load:enter', id, app?.graph)
        try {
          return await orig(...args)
        } finally {
          push('load:exit', id, app?.graph)
          stack.splice(stack.indexOf(id), 1)
        }
      }
      ok.load = true
    }
    const proto = app?.graph?.constructor?.prototype
    if (proto?.configure) {
      const orig = proto.configure
      proto.configure = function (...args: unknown[]) {
        const r = orig.apply(this, args)
        push('configure', ++seq, this)
        return r
      }
      w.__restoreConfigure = () => {
        proto.configure = orig
      }
      ok.configure = true
    }
    const store = app?.extensionManager?.workflow
    if (store && typeof store.openWorkflow === 'function') {
      const orig = store.openWorkflow.bind(store)
      store.openWorkflow = async function (...args: unknown[]) {
        const r = await orig(...args)
        push('open:exit', ++seq, app?.graph)
        return r
      }
      ok.open = true
    }
    return ok
  })
  // A patch that did not install would make every assertion below vacuous
  // (codex P1): the log would simply lack those events and `indexOf` would
  // report -1, which reads like "not observed" rather than "not instrumented".
  expect(installed.load, 'loadGraphData was not patchable — the instrument is blind').toBe(true)
  expect(installed.configure, 'LGraph#configure was not patchable').toBe(true)
  expect(installed.open, 'workflowStore.openWorkflow was not patchable').toBe(true)
}

test('what is observable when the canvas is swapped (#833/#817)', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(
    () => {
      const a = (window as any).comfyAPI?.app?.app || (window as any).app
      return !!a?.graph && !!a?.extensionManager?.workflow
    },
    undefined,
    { timeout: 60_000 },
  )
  await instrument(page)

  // WAIT FOR THE PAGE TO GO QUIET FIRST. The instrument installs while ComfyUI is
  // still restoring its own default workflow, so a drive() that starts here reads
  // STARTUP events and returns before its own command has done anything — which
  // is exactly what made the first two versions of this harness read a half-built
  // log and conclude nothing was observable.
  await page
    .waitForFunction(
      () => {
        const w = window as any
        const log = w.__ev as Ev[]
        const n = log.length
        if (w.__quietAt === undefined || w.__quietN !== n) {
          w.__quietN = n
          w.__quietAt = Date.now()
          return false
        }
        return Date.now() - w.__quietAt > 800
      },
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => undefined)

  // Drive EVERY swap route reachable from here, not just one (codex P0): a blank
  // create, a second one (tab switch to a different workflow), and an explicit
  // open of an existing workflow.
  const drive = async (fn: string) => {
    const before = await page.evaluate(() => ((window as any).__ev as Ev[]).length)
    await page.evaluate(async (f) => {
      const w = window as any
      const app = w.comfyAPI?.app?.app || w.app
      await app?.extensionManager?.command?.execute(f)
    }, fn)
    // Synchronise on the BRACKET CLOSING, not merely on the log growing (codex
    // P1, and my own first correction was worse than the sleep it replaced: it
    // returned on the first `load:enter` and read the log mid-swap, so the
    // activation had not happened yet). Wait until a loadGraphData that started
    // after this command has EXITED with nothing else in progress.
    await page
      .waitForFunction(
        (n) => {
          const log = (window as any).__ev as Ev[]
          const fresh = log.slice(n as number)
          return fresh.some((e) => e.kind === 'load:exit' && e.stack.length <= 1)
        },
        before,
        { timeout: 20_000 },
      )
      .catch(() => undefined)
    await page.waitForTimeout(300)
  }

  await drive('Comfy.NewBlankWorkflow')
  await drive('Comfy.NewBlankWorkflow')

  const log = (await page.evaluate(() => (window as any).__ev)) as Ev[]
  await page.evaluate(() => (window as any).__restoreConfigure?.()) // codex P2

  console.log('[#833] LOG:', JSON.stringify(log.map((e) => [e.kind, e.id, e.stack.join('/'), e.path, e.nodes])))
  expect(log.length, 'nothing was observed at all').toBeGreaterThan(0)

  // ── FACT 1 — the canvas object is never replaced. ───────────────────────────
  // Directly refutes every identity scheme based on an object reference, which
  // is the family `changeTracker.graph` belonged to.
  expect(
    log.some((e) => e.graphEverReplaced),
    'app.graph was REPLACED at some point — the identity work on #833/#817 assumes it is ' +
      'reused and re-filled, so that assumption needs redoing',
  ).toBe(false)
  expect(
    new Set(log.map((e) => e.graph).filter(Boolean)).size,
    'more than one graph object was seen',
  ).toBe(1)

  // ── FACT 2 — every store activation we saw was NESTED INSIDE a loadGraphData ─
  // Correlated by CALL ID, not by label position: `stack` holds the ids of the
  // loadGraphData invocations in progress at that instant.
  const opens = log.filter((e) => e.kind === 'open:exit')
  expect(opens.length, 'no workflow activation was observed — nothing was measured').toBeGreaterThan(0)
  for (const o of opens) {
    expect(
      o.stack.length,
      `a workflow was activated with NO loadGraphData in progress (event ${o.id}, path ${o.path}). ` +
        `That is a swap route which bypasses the bracket, and the seal cannot be taken there.`,
    ).toBeGreaterThan(0)
  }

  // ── FACT 3 — the store lags the graph inside that bracket. ──────────────────
  // For each activation, the graph had already been re-configured while the store
  // still named the previous workflow. This is the window that makes any earlier
  // read confidently wrong, and it is why a seal must be taken at the exit.
  for (const o of opens) {
    const outer = o.stack[0]
    const enter = log.find((e) => e.kind === 'load:enter' && e.id === outer)
    const exit = log.find((e) => e.kind === 'load:exit' && e.id === outer)
    expect(enter, `no enter event for call ${outer}`).toBeTruthy()
    expect(exit, `loadGraphData ${outer} never exited`).toBeTruthy()
    // The path at entry differs from the path this activation established.
    expect(
      enter!.path,
      'the store already named this workflow when loadGraphData was entered — if that is ' +
        'now true generally, the disagreement window is gone and the seal could move earlier',
    ).not.toBe(o.path)
    // …and at the exit, the store names it.
    expect(exit!.path, 'at loadGraphData exit the store must name the activated workflow').toBe(o.path)
  }

  // ── WHAT IS NOT ESTABLISHED, recorded so the next attempt does not assume it ─
  // This drives the swap routes reachable through the command palette. It does
  // NOT prove that every possible route goes through loadGraphData — a direct
  // `graph.configure` by another extension, or a restore path we cannot trigger
  // here, would not appear. FACT 2 is therefore "every activation OBSERVED was
  // nested", and a fix that seals at the exit must still fail closed when it sees
  // an activation it never bracketed.
  const configures = log.filter((e) => e.kind === 'configure')
  expect(configures.length, 'no graph rebuild was observed').toBeGreaterThan(0)
  const unbracketed = configures.filter((c) => c.stack.length === 0)
  console.log(
    `[#833] ${opens.length} activation(s), ${configures.length} configure(s), ` +
      `${unbracketed.length} configure(s) OUTSIDE any loadGraphData` +
      (unbracketed.length
        ? ' — these are the routes a seal taken at the bracket would miss.'
        : ' — every rebuild observed was bracketed.'),
  )
})
