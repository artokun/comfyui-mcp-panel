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
