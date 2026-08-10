/**
 * #882 — the data-loss guards must see a value a node wrote.
 *
 * ComfyUI derives `isModified` from a snapshot it captures on USER INPUT events only, so a
 * value written by a node — an ImpactWildcardEncode populate, a control_after_generate roll,
 * a subgraph's promoted widgets — leaves the tab reading CLEAN while the canvas already
 * differs from the file. Measured:
 *
 *     after save            isModified: false   (correct)
 *     after a node writes   isModified: false   (WRONG)
 *     after checkState()    isModified: true    (correct)
 *
 * `workflow_close` refuses to close a workflow with unsaved changes, precisely because
 * `closeWorkflow` bypasses the UI's save prompt. With a stale flag it discarded exactly the
 * work it exists to protect.
 *
 * Driven over the bridge rather than asserted at source, because the bug is an interaction
 * between ComfyUI's tracker and the panel's guard and only appears when both run.
 */
import { test, expect, deleteSavedWorkflow } from './fixtures/panelTest'
import { claimFreshCanvas, settleCanvas } from './fixtures/canvasIdentity'

/** Change a widget the way a NODE does: directly, no user input event. */
async function nodeWritesWidget(page: import('@playwright/test').Page, value: number) {
  await page.evaluate((v) => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const graph = app?.canvas?.graph ?? app?.graph
    const node = (graph?.nodes || []).find((n: any) => n.type === 'EmptyLatentImage')
    if (!node) throw new Error('no EmptyLatentImage on the canvas')
    const widget = (node.widgets || []).find((x: any) => x.name === 'width')
    widget.value = v
  }, value)
}

test('closing a workflow refuses when a NODE left unsaved work', async ({
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

  // Save so the tab is genuinely clean, and resolve the close target BEFORE the write.
  // Order is load-bearing: the command dispatch captures after every completed command,
  // so any panel command issued after the write refreshes the tracker and hides the lag.
  // #907 — the try opens BEFORE the save, so a save that lands and then fails an
  // assertion is still cleaned up (codex).
  let savedName = ''
  try {
    // #907 — SAVE UNDER A NAME THAT IS UNMISTAKABLY OURS. An unnamed save gets
    // ComfyUI's `Untitled <date> <time>`, which is the SAME shape it gives the
    // developer's own unnamed saves — so a cleanup keyed on that name can delete
    // their work if they happen to save while the suite runs (codex). Naming it
    // here means nothing the suite deletes is ever ambiguous.
    const e2eName = `cmcp-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const saved = await mockBridge.command('workflow_save_as', { name: e2eName })
    expect(saved.ok, 'the save must succeed so the tab starts clean').toBe(true)
    savedName = String(saved.result?.workflow || '')
    expect(savedName, 'the save must report a name, or cleanup has nothing to remove').toBeTruthy()
    const listed = await mockBridge.command('workflow_list', {})
    const target =
    listed.result?.active?.routing_key || listed.result?.active?.key || listed.result?.active?.path
    expect(target, 'the active workflow must be resolvable').toBeTruthy()
    // Stamp the close explicitly. Closing the ACTIVE workflow is deliberately FENCED
    // (only a close resolving to a genuinely non-active tab is exempt), and MockBridge
    // sends every `workflow_close` unstamped on the assumption that the whole command
    // is exempt — so an unstamped close is refused for identity reasons before it ever
    // reaches the dirty guard this spec is about.
    const stamp = listed.result?.active?.workflow_uuid
    expect(stamp, 'workflow_list must report the active workflow uuid').toBeTruthy()

    await nodeWritesWidget(page, 1337)

    // Precondition: the tab must still LOOK clean, or this passes for the wrong reason.
    const looksClean = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    return app?.extensionManager?.workflow?.activeWorkflow?.isModified === false
    })
    expect(looksClean, 'precondition: isModified must still read false').toBe(true)

    // The guard must now refuse. Before #882 this closed the tab and the value was gone.
    //
    // Assert the ORIGINAL guard's sentence, not a loose /unsaved changes/: the refusal
    // for an UNPROVEN capture reads "could not be checked for unsaved changes", so a
    // loose match would be satisfied by a capture that never landed — passing while the
    // flag this spec is about stayed stale. This wording is reached only when the
    // capture succeeded AND flipped `isModified` to true, which is the whole fix.
    const closed = await mockBridge.command('workflow_close', { path: target, workflow_uuid: stamp })
    expect(JSON.stringify(closed)).toContain('has unsaved changes')

    // …and the workflow must still be open with the value on it.
    const stillThere = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const graph = app?.canvas?.graph ?? app?.graph
    const node = (graph?.nodes || []).find((n: any) => n.type === 'EmptyLatentImage')
    const widget = (node?.widgets || []).find((x: any) => x.name === 'width')
    return widget ? widget.value : null
    })
    expect(stillThere, 'the refused close must leave the work on the canvas').toBe(1337)
  } finally {
    await deleteSavedWorkflow(page, savedName)
  }
})

test('force:true still discards — the guard refuses, it does not trap', async ({
  page,
  panel,
  mockBridge
}) => {
  // The escape hatch has to keep working, or the fix turns a data-loss bug into a
  // cannot-close-anything bug.
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
  let savedName2 = ''
  try {
    // #907 — an unnamed save gets ComfyUI's `Untitled <date> <time>`, the SAME
    // name it gives the developer's own unnamed saves, so nothing downstream can
    // tell them apart and the cleanup must not try. Name it ours.
    const e2eSaveName = `cmcp-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const saved2 = await mockBridge.command('workflow_save_as', { name: e2eSaveName })
    // Asserted, not assumed (codex): without this the setup save could fail, the test
    // still pass, and cleanup ask to delete `workflows/.json`.
    expect(saved2.ok, 'the setup save must succeed').toBe(true)
    savedName2 = String(saved2.result?.workflow || '')
    expect(savedName2, 'the setup save must report a name').toBeTruthy()
    const listed = await mockBridge.command('workflow_list', {})
    const target =
    listed.result?.active?.routing_key || listed.result?.active?.key || listed.result?.active?.path
    const stamp = listed.result?.active?.workflow_uuid

    await nodeWritesWidget(page, 4242)

    const closed = await mockBridge.command('workflow_close', {
    path: target,
    workflow_uuid: stamp,
    force: true
    })
    expect(closed.ok, 'force:true must still close').toBe(true)
  } finally {
    await deleteSavedWorkflow(page, savedName2)
  }
})
