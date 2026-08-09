/**
 * #833 — a blank canvas must be readable AND buildable.
 *
 * An empty canvas is the ordinary state a user is in right before asking the agent to
 * build a workflow. It was the one state where every `panel_*` graph tool was refused,
 * with no recovery: the reporter's ladder (re-target, new workflow, re-open) all failed,
 * and the regression report adds that it survives both Ctrl+Shift+R and a ComfyUI
 * restart.
 *
 * The cause is that BOTH available proofs are structurally unavailable here:
 *
 *   - content cannot identify an empty canvas — every blank canvas serialises alike, so
 *     the content proof behind the seal has nothing to match;
 *   - a blank tab is ALWAYS dirty (creating or clearing it is what dirties it), so the
 *     emptiness proof short-circuits on `isModified` and can never succeed.
 *
 * Measured before the fix, on this exact path:
 *     graph_outline    -> [empty-binding-unproven]
 *     graph_add_node   -> [dirty-mutation-binding-unproven]
 *
 * Driven over the bridge rather than asserted at source, because the wedge is the
 * interaction of the binding guard with ComfyUI's real tracker and only appears when
 * both run. Both halves are asserted: fixing only the read half would still leave the
 * user unable to build, which is what they actually wanted to do.
 */
import { test, expect } from './fixtures/panelTest'
import { claimFreshCanvas, settleCanvas } from './fixtures/canvasIdentity'

async function emptyTheCanvas(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    ;(app?.canvas?.graph ?? app?.graph).clear()
  })
}

test('a blank canvas can be read and built on', async ({ page, panel, mockBridge }) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  await claimFreshCanvas(page, mockBridge)

  await emptyTheCanvas(page)
  await settleCanvas(page)

  // Precondition: this must be the wedge's own shape, or the test passes for the
  // wrong reason. The canvas is empty AND the tab is dirty — the combination that
  // no proof could clear.
  const shape = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const wf = app?.extensionManager?.workflow?.activeWorkflow
    return {
      liveNodes: (app?.rootGraph ?? app?.graph)?._nodes?.length ?? null,
      isModified: wf?.isModified ?? null
    }
  })
  expect(shape.liveNodes, 'precondition: the canvas must be empty').toBe(0)
  expect(shape.isModified, 'precondition: a blank tab is dirty — that is the wedge').toBe(true)

  // READ. Before the fix: [empty-binding-unproven].
  const outline = await mockBridge.command('graph_outline', {})
  expect(JSON.stringify(outline)).not.toContain('empty-binding-unproven')
  expect(outline.ok, 'a blank canvas must be readable').toBe(true)
  expect(outline.result?.node_count).toBe(0)

  // BUILD. Before the fix: [dirty-mutation-binding-unproven]. This is the half that
  // matters — a user on a blank canvas is about to add nodes, not read zero of them.
  const added = await mockBridge.command('graph_add_node', { class_type: 'EmptyLatentImage' })
  expect(JSON.stringify(added)).not.toContain('dirty-mutation-binding-unproven')
  expect(added.ok, 'a blank canvas must be buildable').toBe(true)

  // And the node must actually be on the canvas — an `ok` that changed nothing would
  // satisfy the assertions above while leaving the user exactly as stuck.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = window as any
        const app = w.comfyAPI?.app?.app || w.app
        const graph = app?.canvas?.graph ?? app?.graph
        return (graph?.nodes || []).filter((n: any) => n.type === 'EmptyLatentImage').length
      })
    )
    .toBe(1)
})

// The negative case — a canvas that reads empty while its workflow claims NODES — is
// asserted in browser_tests/unit/empty-canvas-wedge.test.mjs, not here. Constructing it
// end-to-end is unreliable: settling the canvas legitimately SEALS the binding while the
// node is present, after which deleting it is an ordinary edit on a proven canvas and is
// correctly allowed. The dangerous shape is a binding that was NEVER proven, which the
// unit suite can build exactly.
