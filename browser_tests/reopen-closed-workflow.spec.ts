/**
 * #1575 — reopening a saved workflow after `panel_close_workflow` closed its tab.
 *
 * THE REPORT. The reopen came back with "workflow_open could not rebind the active
 * canvas because this frontend did not expose a complete workflow state for a safe
 * repaint" — an unknown partial outcome — and `panel_list_workflows` could then show
 * an inconsistent active/open state.
 *
 * THE CAUSE. `app.extensionManager.workflow` is ComfyUI's workflow STORE, not the
 * workflow service, so this pack's close and open are the store's primitives and they
 * do not pair up: `closeWorkflow` unloads the tab and leaves `activeWorkflow` pointing
 * at it, and `openWorkflow` begins `if (isActive(workflow)) return workflow` where
 * `isActive` compares BY PATH. The reopen therefore early-returns on the stale pointer,
 * loads nothing, and never puts the tab back in the open list — and the panel's repaint
 * finds no state to paint from.
 *
 * Driven over the bridge rather than asserted at source: the defect is an interaction
 * between the panel's command and two of ComfyUI's store methods, and it only appears
 * when the real store runs. `browser_tests/unit/settle-open-target.test.mjs` pins the
 * decision; this pins that the reported CALL now works.
 */
import { test, expect, deleteSavedWorkflow } from './fixtures/panelTest'
import { claimFreshCanvas, settleCanvas } from './fixtures/canvasIdentity'

test('a saved workflow reopens after its tab was closed', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  await claimFreshCanvas(page, mockBridge)
  await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const LG = w.LiteGraph || w.comfyAPI?.litegraph?.LiteGraph
    ;(app?.canvas?.graph ?? app?.graph).add(LG.createNode('EmptyLatentImage'))
  })
  await settleCanvas(page)

  // #907 — the try opens BEFORE the save, so a save that lands and then fails an
  // assertion is still cleaned up.
  let savedName = ''
  try {
    const e2eName = `cmcp-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const saved = await mockBridge.command('workflow_save_as', { name: e2eName })
    expect(saved.ok, 'the save must succeed so the tab is clean enough to close').toBe(true)
    savedName = String(saved.result?.workflow || '')
    expect(savedName, 'the save must report a name, or cleanup has nothing to remove').toBeTruthy()

    const listed = await mockBridge.command('workflow_list', {})
    const active = listed.result?.active
    // The PATH, not the routing key: after the close this workflow is no longer an open
    // tab, and the on-disk path is the selector the reporter used.
    const savedPath = String(active?.path || '')
    expect(savedPath, 'the saved workflow must report an on-disk path').toBeTruthy()
    const stamp = active?.workflow_uuid
    expect(stamp, 'workflow_list must report the active workflow uuid').toBeTruthy()

    // Closing the ACTIVE workflow is fenced, so stamp it (see #882's spec).
    const closed = await mockBridge.command('workflow_close', {
      path: active?.routing_key || active?.key || savedPath,
      workflow_uuid: stamp
    })
    expect(closed.ok, `the close must succeed: ${JSON.stringify(closed)}`).toBe(true)

    // THE REPORTED CALL. Before the fix this refused, because ComfyUI's store still
    // named the just-closed tab as active and its `openWorkflow` early-returned.
    const reopened = await mockBridge.command('workflow_open', { path: savedPath })
    expect(
      JSON.stringify(reopened),
      'the reopen must not refuse with the #1575 rebind failure'
    ).not.toContain('did not expose a complete workflow state')
    expect(reopened.ok, `the reopen must succeed: ${JSON.stringify(reopened)}`).toBe(true)

    // The canvas must actually be this workflow's graph, not an empty or stale one.
    const onCanvas = await page.evaluate(() => {
      const w = window as any
      const app = w.comfyAPI?.app?.app || w.app
      const graph = app?.canvas?.graph ?? app?.graph
      return (graph?.nodes || []).map((n: any) => n.type)
    })
    expect(onCanvas, 'the reopened canvas must carry the saved graph').toContain(
      'EmptyLatentImage'
    )

    // …and the active/open state must agree again — the second half of the report.
    const after = await mockBridge.command('workflow_list', {})
    expect(after.result?.active?.path, 'the reopened workflow must be active').toBe(savedPath)
    const openPaths = (after.result?.open || after.result?.workflows || []).map((x: any) =>
      String(x?.path || '')
    )
    expect(openPaths, 'and it must be listed as OPEN, not active-but-closed').toContain(
      savedPath
    )
  } finally {
    await deleteSavedWorkflow(page, savedName)
  }
})
