/**
 * #693 — two browser tabs on the SAME saved workflow must not share a bridge route.
 *
 * The reported symptom was a permanent reconnect storm: sockets opening, helloing, and
 * being closed ~2s later forever, at ~2 hellos/sec, with every close `code=1005
 * clean=true` — a SERVER-side close. The bridge keeps exactly one connection per
 * `tab_id` and closes the older socket whenever a new hello arrives for the same one,
 * so two clients helloing with an identical `tab_id` evict each other indefinitely.
 * Closing the sidebar did not stop it; only a page reload did.
 *
 * The reported hellos carried `tab_id = wf:workflows/<name>` — the bare saved-workflow
 * HANDLE, which names the FILE. Every browser tab showing that file produces the same
 * string, so two tabs collided by construction.
 *
 * #640 replaced the route with `wf:<tabRouteId>:<path>`, composing the tab's own
 * established identity in front of the path, and `savedWorkflowRoute` REFUSES (returns
 * null) rather than falling back to the bare path — the fallback being the collision
 * itself. The composition is unit-tested, but nothing exercised the property that
 * actually matters through two real pages, real Web Locks, and real wire serialisation.
 *
 * So this opens the same saved workflow in TWO pages and asserts their routes DIFFER.
 * Asserting the wire FORM alone would not do: an implementation that emitted
 * `wf:<one-shared-id>:<path>` for every tab matches the form and recreates #693 exactly
 * (codex). Uniqueness is the invariant; the form is only how it is carried.
 */
import { test, expect, isolatePanelPage, deleteSavedWorkflow } from './fixtures/panelTest'
import { PanelPage } from './fixtures/PanelPage'

/** Record the `tab_id` of every hello this page sends, from before it connects. */
async function captureHellos(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const w = window as any
    w.__hellos = []
    const O = w.WebSocket
    const W = function (url: string, p?: any) {
      const ws = p ? new O(url, p) : new O(url)
      const send = ws.send.bind(ws)
      ws.send = (d: any) => {
        try {
          const f = typeof d === 'string' ? JSON.parse(d) : null
          if (f && f.type === 'hello') w.__hellos.push(String(f.tab_id ?? ''))
        } catch {}
        return send(d)
      }
      return ws
    } as any
    W.prototype = O.prototype
    W.OPEN = O.OPEN; W.CONNECTING = O.CONNECTING; W.CLOSING = O.CLOSING; W.CLOSED = O.CLOSED
    w.WebSocket = W
  })
}

/** Open an already-saved workflow by path, the way switching to its tab would. */
async function openSavedWorkflow(page: import('@playwright/test').Page, path: string) {
  return page.evaluate(async (p) => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const store = app?.extensionManager?.workflow
    const wf = (store?.workflows || []).find((x: any) => x?.path === p)
    if (!wf) return { opened: false, reason: 'not in store' }
    await store.openWorkflow(wf)
    return { opened: true, active: store?.activeWorkflow?.path ?? null }
  }, path)
}

const savedHellos = (ids: string[]) => ids.filter((id) => id.startsWith('wf:'))

test('two tabs on one saved workflow never share a bridge route', async ({
  page,
  panel,
  mockBridge,
  context
}) => {
  const cleanup: Array<() => Promise<void>> = []
  try {
    await captureHellos(page)
    await panel.goto()
    await panel.setBridgeUrl(mockBridge.url)
    await panel.openSidebar()
    await panel.connect()

    // A SAVED workflow specifically. An unsaved tab routes on a per-object `tmp:<uuid>`
    // and could never collide, so using one would pass for the wrong reason.
    // #907 — an unnamed save gets ComfyUI's `Untitled <date> <time>`, the SAME
    // name it gives the developer's own unnamed saves, so nothing downstream can
    // tell them apart and the cleanup must not try. Name it ours.
    const e2eSaveName = `cmcp-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const saved = await mockBridge.command('workflow_save_as', { name: e2eSaveName })
    expect(saved.ok, 'the workflow must save so both tabs share a FILE').toBe(true)
    const savedName = String(saved.result?.workflow || '')
    expect(savedName, 'the save must report a name').toBeTruthy()
    const savedPath = `workflows/${savedName}.json`
    // This spec PERSISTS a file on the developer's real ComfyUI. Remove it however the
    // test ends — an assertion failure must not leave litter behind (codex).
    cleanup.push(() => deleteSavedWorkflow(page, savedName))
    await page.waitForTimeout(2500)

    // Tab B: a second real browser tab in the same context, opening that same file.
    const pageB = await context.newPage()
    await captureHellos(pageB)
    // The fixture only isolates the test's OWN page. Page B needs the identical stub set
    // or its Reconnect writes this throwaway mock bridge URL into the developer's REAL
    // ComfyUI settings, leaving a dead port behind after the suite exits (codex).
    await isolatePanelPage(pageB)
    const panelB = new PanelPage(pageB)
    await panelB.goto()
    await panelB.setBridgeUrl(mockBridge.url)
    await panelB.openSidebar()
    await panelB.connect()

    const openedB = await openSavedWorkflow(pageB, savedPath)
    expect(openedB.opened, `tab B must open ${savedPath}`).toBe(true)
    await pageB.waitForTimeout(3000)

    const hellosA = savedHellos(await page.evaluate(() => (window as any).__hellos ?? []))
    const hellosB = savedHellos(await pageB.evaluate(() => (window as any).__hellos ?? []))
    expect(hellosA.length, 'tab A must have helloed on the saved workflow').toBeGreaterThan(0)
    expect(hellosB.length, 'tab B must have helloed on the saved workflow').toBeGreaterThan(0)

    // Both must be routing for the SAME file, or they were never in a position to
    // collide and this proves nothing.
    expect(hellosA.some((id) => id.endsWith(`:${savedPath}`)), 'tab A must route for the saved file').toBe(true)
    expect(hellosB.some((id) => id.endsWith(`:${savedPath}`)), 'tab B must route for the saved file').toBe(true)

    // The bare handle names the FILE, so every tab showing it produces the same string.
    for (const [label, ids] of [['A', hellosA], ['B', hellosB]] as const) {
      for (const id of ids) {
        expect(id, `tab ${label} must not route on the bare file handle`).not.toBe(`wf:${savedPath}`)
      }
    }

    // THE INVARIANT: no route may be shared. This is what the bridge keys on, and a
    // shared value is what makes two clients evict each other forever.
    const shared = hellosA.filter((id) => hellosB.includes(id))
    expect(
      shared,
      `both tabs helloed with the same route — the bridge keeps one connection per ` +
        `tab_id, so these two would close each other's sockets indefinitely ` +
        `(A=${JSON.stringify(hellosA)} B=${JSON.stringify(hellosB)})`
    ).toEqual([])

    await pageB.close()
  } finally {
    for (const fn of cleanup.reverse()) {
      try {
        await fn()
      } catch {
        // Best-effort: a failed cleanup must not mask the assertion that failed.
      }
    }
  }
})
