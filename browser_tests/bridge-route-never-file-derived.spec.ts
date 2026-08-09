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
 * itself. The composition is unit-tested, but nothing checked what a real panel
 * actually PUTS ON THE WIRE, which is where the reported collision was observed.
 *
 * So this asserts the wire form directly: on a saved workflow the hello must carry the
 * composed route and must never be the bare file handle. A tab-specific route cannot
 * collide with another tab's by construction, so pinning the form is what pins the
 * property — and it fails on any change that reintroduces a file-derived route,
 * including a "helpful" fallback when the tab identity is not yet established.
 */
import { test, expect } from './fixtures/panelTest'

/** Record the `tab_id` of every hello this page sends. */
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

test('a saved workflow never routes on its file path', async ({ page, panel, mockBridge }) => {
  await captureHellos(page)
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  // Give tab A a SAVED workflow. The collision is specific to saved workflows: an
  // unsaved tab already routes on a per-object `tmp:<uuid>`, so it could never collide
  // and would make this pass for the wrong reason.
  const saved = await mockBridge.command('workflow_save', {})
  expect(saved.ok, 'the workflow must save so both tabs share a FILE').toBe(true)
  const savedName = String(saved.result?.workflow || '')
  expect(savedName, 'the save must report a name').toBeTruthy()

  // Re-hello on the SAVED workflow, then read what went on the wire.
  await page.waitForTimeout(2500)
  const hellos: string[] = await page.evaluate(() => (window as any).__hellos ?? [])
  expect(hellos.length, 'the panel must have helloed').toBeGreaterThan(0)

  const bareHandle = `wf:workflows/${savedName}.json`
  const saved_hellos = hellos.filter((id) => id.startsWith('wf:'))
  expect(
    saved_hellos.length,
    `the saved workflow must produce a wf: route (got ${JSON.stringify(hellos)})`
  ).toBeGreaterThan(0)

  for (const id of saved_hellos) {
    // The bare handle names the FILE, so every browser tab showing it produces the
    // same string. That is the collision, and it must never reach the wire.
    expect(id, 'a route must never be the bare file handle').not.toBe(bareHandle)
    // The composed form is `wf:<tabRouteId>:<path>` — the tab's own identity in
    // front of the path, which is what makes two tabs on one file route separately.
    expect(id, 'the route must compose the tab identity in front of the path').toMatch(
      /^wf:[^:]+:workflows\//
    )
  }
})
