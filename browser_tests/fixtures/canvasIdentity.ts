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
  // No manual invalidation needed: `workflow_new` is one of the commands
  // MockBridge treats as re-pointing, so it drops the cache around the call.
  return bridge.activeWorkflowUuid()
}

/**
 * Let the panel SEE the nodes a spec just added (#793).
 *
 * ComfyUI's ChangeTracker captures the canvas on the events the real UI emits.
 * A spec that builds its fixture by calling `graph.add()` from the page fires
 * none of them, so the workflow's tracked state still reports the canvas it had
 * BEFORE the build — and the binding guard, comparing the two, refuses:
 *
 *   [root-shape-mismatch] … the canvas's content does not match the active
 *   workflow's own state … The panel cannot tell whether this is a DIFFERENT
 *   workflow's canvas or this workflow's own canvas drifted …
 *
 * Which is the correct answer to the question it was asked. `checkState()` is
 * the tracker's own capture — the same one a real edit triggers — so this makes
 * the fixture look like an edit rather than like a desync.
 *
 * Call it after building, before the first command.
 */
export async function settleCanvas(page: Page): Promise<void> {
  const settled = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const tracker = app?.extensionManager?.workflow?.activeWorkflow?.changeTracker
    if (typeof tracker?.checkState !== 'function') return false
    tracker.checkState()
    return true
  })
  // NOT best-effort (codex). A silent no-op here surfaces later as a binding
  // refusal in the middle of an assertion, which is precisely the misdirection
  // that left this suite's real cause unread for months. If the harness cannot
  // set the fixture up, it says so where it happened.
  if (!settled) {
    throw new Error(
      'settleCanvas: no ChangeTracker on the active workflow — the panel cannot be ' +
        'told about nodes this spec added, so every mutation would be refused as a desync'
    )
  }
}
