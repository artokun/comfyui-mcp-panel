/**
 * #702 — an open that proves the binding but not the CONTENT must not strand the caller.
 *
 * `workflow_open` on the already-active tab legitimately answers CONTENT_UNVERIFIED: the
 * binding is proven (instance, marker and identity all match) and only the content
 * cannot be called byte-identical. That outcome THROWS, so it never reaches the line
 * that publishes `workflow_uuid` — and the caller's command fence keeps whatever it had.
 *
 * The disclosure then closed by recommending `panel_graph_outline`, which is exactly the
 * call about to be refused as a `workflow instance mismatch`. Two reporters followed that
 * advice into the refusal and concluded only a full `panel_reload` could recover.
 *
 * Measured here before the fix, in this order:
 *     workflow_open (already active) -> ok:false, CONTENT_UNVERIFIED, no workflow_uuid
 *     workflow_list                  -> ok:true, republishes the SAME active uuid
 *     graph_outline stamped with it  -> ok:true
 *
 * So the recovery already existed and the reply simply never named it. This asserts both
 * halves: the disclosure names it, and it actually works.
 */
import { test, expect } from './fixtures/panelTest'
import { claimFreshCanvas, settleCanvas } from './fixtures/canvasIdentity'

test('a content-unverified open names the fence recovery, and it works', async ({
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

  const listed = await mockBridge.command('workflow_list', {})
  const target =
    listed.result?.active?.routing_key || listed.result?.active?.key || listed.result?.active?.path
  expect(target, 'an active workflow must be resolvable').toBeTruthy()

  // Reopening the ALREADY-ACTIVE workflow is the CONTENT_UNVERIFIED path.
  const reopened = await mockBridge.command('workflow_open', { path: target })
  const text = JSON.stringify(reopened)
  // Precondition: this must be the outcome the issue is about, not some other failure.
  expect(text, 'the reply must be the post-repaint content verdict').toContain(
    'workflow_open RAN, the canvas IS bound to'
  )
  expect(reopened.ok, 'content-unverified is ok:false by design').toBe(false)

  // It must SAY the fence was not refreshed, and name the call that refreshes it.
  // Without this the reply recommends the graph read that is about to be refused.
  expect(text, 'the reply must disclose that no fence refresh rode with it').toContain(
    'carries NO fence refresh'
  )
  expect(text, 'the reply must name the fence-exempt recovery probe').toContain(
    'panel_list_workflows'
  )

  // And the named recovery must actually work — a remedy that does not is worse than none.
  const after = await mockBridge.command('workflow_list', {})
  expect(after.ok, 'workflow_list must stay usable — it is the fence-exempt probe').toBe(true)
  const stamp = after.result?.active?.workflow_uuid
  expect(stamp, 'workflow_list must republish the active identity').toBeTruthy()

  const outline = await mockBridge.command('graph_outline', { workflow_uuid: stamp })
  expect(
    outline.ok,
    'a graph read stamped from the recovery probe must succeed — this is the whole loop'
  ).toBe(true)
})
