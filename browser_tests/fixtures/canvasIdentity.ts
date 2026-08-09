/**
 * Give the test canvas a real workflow identity before a spec mutates it (#793).
 *
 * THE PROBLEM. Specs build their fixtures by driving LiteGraph directly from the
 * page — `graph.clear()`, then `graph.add(node)`. That produces a canvas which is
 * DIRTY (unsaved changes) and carries NO identity stamp, and the panel refuses
 * every mutation on exactly that combination:
 *
 *   [dirty-mutation-binding-unproven] The active tab has unsaved changes and the
 *   live canvas carries no identity stamp proving it belongs to this workflow …
 *   so the canvas COULD be a stale graph from another tab
 *
 * The guard is right. A real user's canvas arrives through a load that stamps it;
 * a canvas assembled out of band has never been proven to belong to anything.
 *
 * THE FIX IS THE PANEL'S OWN PATH, NOT A SYNTHETIC STAMP. It would be easy to
 * write `graph.extra.comfyui_mcp = { workflow_uuid }` from the page and move on.
 * That would be the harness forging the very evidence the fence exists to check,
 * and every spec after it would be testing a canvas no production path can
 * produce. So instead this issues `workflow_new`, which stamps the canvas the way
 * it stamps any blank workflow the user creates — real code, real stamp.
 *
 * ORDER MATTERS, and it is the whole reason this is a helper rather than a line.
 * `graph.clear()` DROPS `graph.extra`, so stamping before the clear is erased by
 * it. Verified in the live browser: stamp-then-clear leaves `comfyui_mcp` null
 * and the mutation is still refused; clear-then-stamp leaves it set and the
 * mutation succeeds. Nodes added afterwards do not disturb it.
 */
import type { Page } from '@playwright/test'
import type { MockBridge } from './MockBridge'

/**
 * Clear the live graph, then have the PANEL claim the empty canvas so it carries
 * a real identity stamp. Call this before building nodes; build them after.
 *
 * Returns the workflow uuid now stamped on the canvas, for a spec that wants to
 * assert on it.
 */
export async function claimFreshCanvas(page: Page, bridge: MockBridge): Promise<string | null> {
  await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const graph = app?.canvas?.graph ?? app?.graph
    if (!graph) throw new Error('claimFreshCanvas: graph unavailable')
    graph.clear()
  })
  // workflow_new stamps the canvas only when it can PROVE it is empty, which is
  // what the clear above guarantees. Its reply carries the minted uuid (#755).
  const created = await bridge.command('workflow_new', {})
  if (!created.ok) {
    throw new Error(`claimFreshCanvas: workflow_new failed — ${created.error ?? 'no reason given'}`)
  }
  // The new tab is a new INSTANCE, so anything the bridge cached for the previous
  // one is stale; the next stamped command must re-read.
  bridge.forgetWorkflowUuid()
  return bridge.activeWorkflowUuid()
}
