/**
 * #874 — reopening a workflow must not revert values the ChangeTracker never saw.
 *
 * `workflow_open` on an ALREADY-OPEN workflow does not re-read the file. It repaints
 * the canvas from `changeTracker.activeState` in order to PROVE it rebound the right
 * canvas (#721, and the receipts #604/#603/#616 lean on that proof).
 *
 * ComfyUI's ChangeTracker captures on USER INPUT events only. So every value a NODE
 * wrote without user input — an ImpactWildcardEncode populate, a control_after_generate
 * roll, a subgraph proxy the frontend filled in — was absent from that snapshot, and the
 * repaint reverted it. Silently: nothing errored and the graph looked right afterwards.
 *
 * This drives the real path (a `workflow_open` command over the bridge, the way the
 * orchestrator sends it) rather than asserting about the source, because the bug lives
 * in the interaction between two ComfyUI subsystems and only shows up when both run.
 */
import { test, expect } from './fixtures/panelTest'
import { claimFreshCanvas, settleCanvas } from './fixtures/canvasIdentity'

/** Set a widget the way a NODE does: directly, with no user input event. */
async function setWidgetWithoutUserInput(
  page: import('@playwright/test').Page,
  nodeType: string,
  widgetName: string,
  value: number
) {
  return page.evaluate(
    ({ nodeType: t, widgetName: n, value: v }) => {
      const w = window as any
      const app = w.comfyAPI?.app?.app || w.app
      const graph = app?.canvas?.graph ?? app?.graph
      const node = (graph?.nodes || []).find((x: any) => x.type === t)
      if (!node) throw new Error(`no ${t} on the canvas`)
      const widget = (node.widgets || []).find((x: any) => x.name === n)
      if (!widget) throw new Error(`${t} has no widget ${n}`)
      widget.value = v
      return { nodeId: String(node.id), value: widget.value }
    },
    { nodeType, widgetName, value }
  )
}

async function readWidget(
  page: import('@playwright/test').Page,
  nodeType: string,
  widgetName: string
) {
  return page.evaluate(
    ({ nodeType: t, widgetName: n }) => {
      const w = window as any
      const app = w.comfyAPI?.app?.app || w.app
      const graph = app?.canvas?.graph ?? app?.graph
      const node = (graph?.nodes || []).find((x: any) => x.type === t)
      const widget = (node?.widgets || []).find((x: any) => x.name === n)
      return widget ? widget.value : null
    },
    { nodeType, widgetName }
  )
}

test('reopening the active workflow keeps a value the tracker never saw', async ({
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
    const graph = app?.canvas?.graph ?? app?.graph
    const LG = w.LiteGraph || w.comfyAPI?.litegraph?.LiteGraph
    const node = LG.createNode('EmptyLatentImage')
    graph.add(node)
  })
  await settleCanvas(page)

  // Resolve the reopen target BEFORE touching the widget. Order is load-bearing:
  // the panel's command dispatch calls `changeTracker.checkState()` after every
  // successful command, so ANY panel command issued after the change refreshes the
  // tracker and hides the very lag this spec is about. An earlier draft fetched the
  // target after the change and passed with the fix removed, for exactly that reason.
  const active = await mockBridge.command('workflow_list', {})
  const target =
    active.result?.active?.routing_key ||
    active.result?.active?.key ||
    active.result?.active?.path
  expect(target, 'workflow_list must report an active workflow to reopen').toBeTruthy()

  // NOW change a value the way a node would — no user input, and no panel command
  // after it, so nothing tells the tracker.
  const changed = await setWidgetWithoutUserInput(page, 'EmptyLatentImage', 'width', 1337)
  expect(changed.value).toBe(1337)

  // Precondition: this is the state the bug depends on. If the tracker HAD seen it,
  // the test would pass for the wrong reason.
  const trackerLagged = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const wf = app?.extensionManager?.workflow?.activeWorkflow
    const tracked = wf?.changeTracker?.activeState
    const node = (tracked?.nodes || []).find((n: any) => n.type === 'EmptyLatentImage')
    return !((node?.widgets_values || []) as unknown[]).includes(1337)
  })
  expect(trackerLagged, 'precondition: the tracker must not have seen the change').toBe(true)

  // Reopen the workflow that is already active — the path that repaints.
  const reopened = await mockBridge.command('workflow_open', { path: target })
  // NOT `ok: true`. Reopening the already-active workflow legitimately answers
  // CONTENT_UNVERIFIED — the panel cannot call a repaint byte-identical — and that
  // verdict is `ok: false` by design. What this spec is about is whether the repaint
  // DESTROYED anything, so assert the open actually ran and then check the value.
  //
  // This sentence is emitted ONLY by the CONTENT_UNVERIFIED branch, which is reached
  // only after the repaint has run and its rebind marker has been checked. A loose
  // match here (codex) would accept an error raised BEFORE the repaint — and then the
  // final assertion below passes vacuously, because the widget write was never
  // touched by anything.
  const ran = JSON.stringify(reopened)
  // panel#1283 — TWO replies now prove the repaint ran, and the assertion must accept
  // both without accepting anything else.
  //
  // The sentence above is emitted only by the CONTENT_UNVERIFIED branch. Since the panel
  // started WATCHING the restore, a benign repaint difference on a load that ran to
  // completion is reported APPLIED instead — and that reply is a STRONGER post-repaint
  // signal, not a weaker one: the success path is reached only once this attempt's
  // one-time marker was found on the live root, which can only be there because THIS
  // load configured it. An error raised before the repaint has neither, so the vacuous
  // pass this assertion was written against (codex) is still excluded.
  const provenPostRepaint =
    ran.includes('workflow_open RAN, the canvas IS bound to') ||
    (reopened.ok === true && typeof reopened.result?.workflow_uuid === 'string')
  expect(provenPostRepaint, 'the reply must be the post-repaint verdict, not an earlier failure').toBe(
    true
  )

  // Two independent signals, because either alone can be satisfied for the wrong
  // reason.
  //
  // 1. The tracker snapshot must now carry the value — that is the capture this fix
  //    adds, and it is false without it.
  const trackerCaughtUp = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const wf = app?.extensionManager?.workflow?.activeWorkflow
    const tracked = wf?.changeTracker?.activeState
    const node = (tracked?.nodes || []).find((n: any) => n.type === 'EmptyLatentImage')
    return ((node?.widgets_values || []) as unknown[]).includes(1337)
  })
  expect(trackerCaughtUp, 'the repaint must capture the live canvas before reading it').toBe(true)

  // 2. And the canvas must still hold it. Before #874 the repaint reloaded the stale
  //    snapshot and this came back as the node's DEFAULT.
  await expect.poll(() => readWidget(page, 'EmptyLatentImage', 'width')).toBe(1337)
})
