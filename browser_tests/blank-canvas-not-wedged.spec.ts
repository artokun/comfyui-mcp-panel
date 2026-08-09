/**
 * #833 — a blank canvas must be READABLE.
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
 * SCOPE: the READ half only. Admitting mutations needs more than emptiness, and the
 * difference is not academic — the panel's own reconnect tab restore can leave the
 * shared root holding workflow W while the active pointer names a different workflow N
 * (the #708 mismatch). If both are blank, both sides read provably empty, and a seal
 * on that evidence would create N's first node on W's canvas. Emptiness proves there is
 * nothing to mis-attribute; it does not prove WHOSE canvas this is, and a mutation
 * needs the second thing. Tracked on #833 for a deliberate fix.
 *
 * Driven over the bridge rather than asserted at source, because the wedge is the
 * interaction of the binding guard with ComfyUI's real tracker and only appears when
 * both run.
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

test('a blank canvas can be read', async ({ page, panel, mockBridge }) => {
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

  // Mutations are deliberately NOT admitted by this change — see the scope note above.
  // Asserted so the boundary is pinned: if a later change starts admitting them, it
  // must do so on identity evidence and update this test on purpose.
  const added = await mockBridge.command('graph_add_node', { class_type: 'EmptyLatentImage' })
  expect(added.ok, 'building still needs identity evidence emptiness cannot supply').toBe(false)
})

// The negative case — a canvas that reads empty while its workflow claims NODES — is
// asserted in browser_tests/unit/empty-canvas-wedge.test.mjs, not here. Constructing it
// end-to-end is unreliable: settling the canvas legitimately SEALS the binding while the
// node is present, after which deleting it is an ordinary edit on a proven canvas and is
// correctly allowed. The dangerous shape is a binding that was NEVER proven, which the
// unit suite can build exactly.
