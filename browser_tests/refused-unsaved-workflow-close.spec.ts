/**
 * #1795 — a refused save followed by a forced close of an unsaved ACTIVE tab
 * must select a surviving tab and leave graph tools usable.
 *
 * This drives the real panel_close_workflow executor against ComfyUI. The
 * slash-containing save is expected to refuse; the first close is expected to
 * preserve that refusal; only force:true may discard the tab. The final list
 * and graph read prove the production close/rebind path did not leave a stale
 * active workflow or root binding behind.
 */
import { test, expect } from './fixtures/panelTest'
import { claimFreshCanvas, settleCanvas } from './fixtures/canvasIdentity'

test('closing a refused unsaved workflow rebinds the active canvas', async ({
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

  const before = await mockBridge.command('workflow_list', {})
  expect(before.ok, `workflow_list setup failed: ${JSON.stringify(before)}`).toBe(true)
  const unsavedRoute = String(before.result?.active?.routing_key || '')
  expect(unsavedRoute, 'the new active workflow must have a per-instance route').toMatch(/^tmp:/)

  // The slash is rejected before the save transport runs, so this remains an
  // unsaved workflow and there is no file for cleanup to remove.
  const refusedSave = await mockBridge.command('workflow_save', { name: '1795/refused' })
  expect(refusedSave.ok).toBe(false)
  expect(refusedSave.error || '').toMatch(/separator|slash|path/i)

  const refusedClose = await mockBridge.command('workflow_close', {
    path: unsavedRoute
  })
  expect(refusedClose.ok).toBe(false)
  expect(refusedClose.error || '').toMatch(/unsaved|save it first|force:true/i)

  const stillOpen = await mockBridge.command('workflow_list', {})
  expect(stillOpen.ok).toBe(true)
  expect(stillOpen.result?.active?.routing_key).toBe(unsavedRoute)
  expect((stillOpen.result?.open || []).some((row: any) => row?.routing_key === unsavedRoute)).toBe(true)

  const closed = await mockBridge.command('workflow_close', {
    path: unsavedRoute,
    force: true
  })
  expect(closed.ok, `forced close failed: ${JSON.stringify(closed)}`).toBe(true)
  expect(closed.result?.closed?.routing_key).toBe(unsavedRoute)
  expect(closed.result?.active?.routing_key).toBeTruthy()
  expect(closed.result?.active?.routing_key).not.toBe(unsavedRoute)
  expect(closed.result?.workflow_uuid).toBeTruthy()
  expect(closed.result?.graph_binding).toBe('bound')

  const after = await mockBridge.command('workflow_list', {})
  expect(after.ok).toBe(true)
  expect(after.result?.active?.routing_key).toBe(closed.result?.active?.routing_key)
  expect(after.result?.active?.workflow_uuid).toBe(closed.result?.workflow_uuid)
  expect((after.result?.open || []).some((row: any) => row?.routing_key === unsavedRoute)).toBe(false)

  const outline = await mockBridge.command('graph_outline', {})
  expect(outline.ok, `graph_outline after close failed: ${JSON.stringify(outline)}`).toBe(true)
  expect(JSON.stringify(outline)).not.toContain('root-workflow-uuid-mismatch')
})
