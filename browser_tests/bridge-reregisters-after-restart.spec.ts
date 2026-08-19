/**
 * #654 — after the orchestrator dies and comes back, the tab must re-register itself.
 *
 * The report: `panel_restart_comfyui` confirms `server_ready:true`, and the panel tab
 * never becomes usable again — the restart reply's tab-reconnected and
 * graph-tools-ready flags both stay false,
 * `panel_set_workflow_target({mode:"current"})` deferred with no connected tab. Only a
 * manual browser refresh recovers it.
 *
 * Prior analysis ruled out retry ARMING from source (`closed` latches only in `stop()`
 * and `destroy()`, neither on a restart path) and handed over the decisive measurement:
 * after `onopen` on a post-restart socket, is the hello sent, and does it carry the
 * right route? Nothing exercised that, because the fixture could only `close()` the
 * whole server — which leaves the panel's re-dial nothing to reach.
 *
 * The orchestrator is ComfyUI's child, so a ComfyUI restart kills it and the port is
 * dead until a fresh one spawns. That is what this reproduces: the bridge dies, the
 * panel retries against a dead port, a new bridge appears on the SAME port, and the
 * panel must re-hello itself back into service without a page reload.
 *
 * Driven on a SAVED workflow deliberately: its route is `wf:<tabRouteId>:<path>`, not a
 * per-object `tmp:<uuid>`, so this also pins that the composed route survives the round
 * trip — an unsaved tab would pass on a simpler code path and prove less.
 *
 * BOUNDARY: the fixture shuts its sockets down CLEANLY. A killed child process would
 * terminate them abruptly, so this is a different close shape, not a milder one — it
 * covers reconnect and re-registration across a bridge replacement and a dead-port
 * interval, but would miss a regression that branched on the close code or `wasClean`.
 * Engineering an abrupt kill is only worth it if the reconnect path starts telling those
 * apart, or if #654 evidence points there (codex).
 */
import { test, expect, deleteSavedWorkflow } from './fixtures/panelTest'
import { MockBridge } from './fixtures/MockBridge'
import { routeWorktreeSource } from './fixtures/worktreeSource'

test.setTimeout(180_000)

test('the tab re-registers after the bridge dies and respawns', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  // #907 — an unnamed save gets ComfyUI's `Untitled <date> <time>`, the SAME
  // name it gives the developer's own unnamed saves, so nothing downstream can
  // tell them apart and the cleanup must not try. Name it ours.
  const e2eSaveName = `cmcp-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const saved = await mockBridge.command('workflow_save_as', { name: e2eSaveName })
  expect(saved.ok, 'the workflow must save so the route is the composed wf: form').toBe(true)
  const savedName = String(saved.result?.workflow || '')
  expect(savedName).toBeTruthy()
  // This spec persists a file on the real ComfyUI — remove it however the test ends.
  const cleanup = () => deleteSavedWorkflow(page, savedName)

  try {
    const port = mockBridge.port
    await expect(panel.statusPill).toHaveText(/connected/i, { timeout: 20_000 })

    // The orchestrator dies with ComfyUI; its port is dead until a fresh one spawns.
    await mockBridge.close()
    await expect(panel.statusPill).not.toHaveText(/^connected$/i, { timeout: 30_000 })

    // …and a new one comes up on the same port.
    const revived = new MockBridge({ port })
    const hellos: any[] = []
    revived.onFrame((f) => {
      if (f.type === 'hello') hellos.push(f)
    })
    await revived.start()

    try {
      // THE INVARIANT: the panel re-registers itself, with no page reload. Before this
      // was measured, nothing proved the hello was ever re-sent.
      await expect
        .poll(() => hellos.length, {
          timeout: 60_000,
          message: 'the panel must re-hello the revived bridge without a page reload'
        })
        .toBeGreaterThan(0)
      await expect(panel.statusPill).toHaveText(/connected/i, { timeout: 30_000 })

      // And it must re-register for the SAVED workflow, on the composed route. A
      // re-hello carrying the bare file path would be the #693 collision; one carrying
      // a stale `tmp:` id would leave graph tools pointed at a route the orchestrator
      // no longer maps.
      const route = String(hellos[hellos.length - 1]?.tab_id ?? '')
      expect(route, 'the re-hello must carry the composed saved route').toMatch(
        /^wf:[^:]+:workflows\//
      )
      expect(route, 'and it must name the workflow that is actually open').toContain(savedName)

      // The hello is only the ANNOUNCEMENT. #654's symptom is that graph tools stay
      // unusable afterwards, so drive one through the revived bridge: that proves the
      // new bridge accepted the registration and can route on it (codex).
      const outline = await revived.command('graph_outline', {})
      expect(
        outline.ok,
        'a graph command must route through the revived bridge — announcing the ' +
          'registration is not the same as being usable again'
      ).toBe(true)
    } finally {
      await revived.close()
    }
  } finally {
    await cleanup()
  }
})

/**
 * #654, the shape the spec above cannot reach: THE BRIDGE SURVIVES THE RESTART.
 *
 * The spec above reproduces a bridge that dies with ComfyUI and comes back on the
 * same port. That was the deployment when it was written; it no longer is. The
 * pack is pure-frontend and can no longer spawn the orchestrator
 * (`externalOrchestratorMode()` is hardcoded true), so the orchestrator now runs
 * out-of-band and ALWAYS survives a ComfyUI restart. The bridge socket therefore
 * never closes, no socket `open` handler fires, and `connectAgent()` early-returns
 * on an already-OPEN socket — so nothing sent the `hello` that is the only thing
 * which re-registers this tab's route.
 *
 * What that produces is the report verbatim: the restart confirms its down/up
 * cycle, the orchestrator's post-restart watch waits for a strictly NEWER hello
 * generation that never arrives, and every graph tool answers `Connected: none`
 * until the browser tab is reloaded by hand.
 *
 * The restart is driven through ComfyUI's OWN api events, which is exactly what
 * the panel sees during a real one — the frontend socket goes away
 * (`reconnecting`) and comes back (`reconnected`) while the page stays loaded.
 * Killing the real ComfyUI would prove the same thing and take the whole suite's
 * backend with it.
 *
 * The CONTROL half is the load-bearing one. ComfyUI fires `reconnected` for
 * benign blips too — viewing an asset, checking an image, a tab refocus — and a
 * hello is a full re-greeting that bumps the agent-session epoch and draws a
 * fresh ready ack. A fix that re-advertised on those would be #1138's
 * false-nudge-into-a-live-session harm wearing this issue's clothes, so the short
 * bounce asserts SILENCE before the long one asserts recovery.
 */
test('a ComfyUI restart under a LIVE bridge re-advertises the tab route', async ({
  page,
  panel,
  mockBridge
}) => {
  // Serve THIS checkout's web/js tree. Not optional and not a nicety: the dev
  // ComfyUI loads the pack from a git-linked checkout on another branch, and
  // without this the spec measures that branch. Verified by running it exactly
  // once without the route — the panel produced no re-advertise at all, which is
  // this issue reproducing in the browser rather than the test passing.
  await routeWorktreeSource(page.context())

  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  await expect(panel.statusPill).toHaveText(/connected/i, { timeout: 20_000 })

  const hellos: Record<string, unknown>[] = []
  mockBridge.onFrame((f) => {
    if (f.type === 'hello') hellos.push(f)
  })
  const socketsAtStart = mockBridge.connectionsOpened

  const fireComfyApiEvent = async (name: string) => {
    // The SAME resolution the panel itself uses to find the api singleton
    // (`window.comfyAPI?.api?.api || window.api`). Reaching for `app.api`
    // instead finds an object the panel never listened on, and the control half
    // of this test would then pass for the wrong reason — silence because the
    // event went nowhere. Assert the dispatch was accepted so that failure mode
    // is loud rather than green.
    const delivered = await page.evaluate((event) => {
      const w = window as any
      const api = w.comfyAPI?.api?.api || w.api
      if (!api || typeof api.dispatchEvent !== 'function') return false
      api.dispatchEvent(new CustomEvent(event))
      return true
    }, name)
    expect(delivered, `ComfyUI's api singleton must accept the ${name} event`).toBe(true)
  }

  /** ComfyUI's backend socket goes away for `downMs` and comes back. The BRIDGE
   *  is deliberately untouched — that is the whole point of this shape. */
  const bounceComfyBackend = async (downMs: number) => {
    await fireComfyApiEvent('reconnecting')
    await page.waitForTimeout(downMs)
    await fireComfyApiEvent('reconnected')
  }

  // CONTROL: a sub-second blip is not a restart and must produce no greeting.
  await bounceComfyBackend(600)
  await page.waitForTimeout(3_000)
  expect(
    hellos.length,
    'a benign WS blip must NOT re-greet the agent — that is the #1138 harm'
  ).toBe(0)

  // THE INVARIANT: a restart-length outage re-advertises the route, with no page
  // reload and no reconnect.
  await bounceComfyBackend(7_000)
  await expect
    .poll(() => hellos.length, {
      timeout: 30_000,
      message: 'the tab must re-advertise its route after a restart the bridge survived'
    })
    .toBeGreaterThan(0)

  expect(
    mockBridge.connectionsOpened,
    'and it must do so on the SAME socket — no drop, no redial, no page reload'
  ).toBe(socketsAtStart)

  const route = String(hellos[hellos.length - 1]?.tab_id ?? '')
  expect(route, 'the re-advertise must carry a real route, never a bare path').toMatch(
    /^(wf:[^:]+:|tmp:)/
  )

  // The hello is only the ANNOUNCEMENT. #654's symptom is that graph tools stay
  // unusable afterwards, so drive one: that is what "Connected: none" was about.
  const outline = await mockBridge.command('graph_outline', {})
  expect(
    outline.ok,
    'a graph command must route after the re-advertise — announcing is not being usable'
  ).toBe(true)

  // ONE-SHOT: `reconnected` repeats, and each repeat is another full re-greeting
  // if the claim is not stamped. A second event with no new outage adds nothing.
  const afterRestart = hellos.length
  await fireComfyApiEvent('reconnected')
  await page.waitForTimeout(3_000)
  expect(hellos.length, 'a repeated `reconnected` must not re-greet again').toBe(afterRestart)
})
