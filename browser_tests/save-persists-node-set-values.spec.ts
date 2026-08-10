/**
 * #878 — an in-place save must not write stale bytes.
 *
 * Every save route persists `wf.activeState` (workflow-save.js states this at ~394), and
 * ComfyUI's ChangeTracker fills that on USER INPUT events only. So a value written by a
 * NODE — an ImpactWildcardEncode populate, a control_after_generate roll, a subgraph's
 * promoted widgets — was absent from it, and an in-place save wrote the STALE bytes over
 * the user's real file.
 *
 * The COPY routes have flushed the canvas into the tracker before reading it since #708.
 * In-place — the one route that overwrites an EXISTING file — did not.
 *
 * This asserts on the BYTES ON DISK, read back through ComfyUI's own userdata API, not on
 * anything the panel reports. A save that returns `saved: true` while the file disagrees
 * with the screen is exactly the failure, so the panel's own account of it proves nothing.
 */
import { test, expect, deleteSavedWorkflow } from './fixtures/panelTest'
import { claimFreshCanvas, settleCanvas } from './fixtures/canvasIdentity'

/** Read a saved workflow back off disk through ComfyUI's userdata API. */
async function readWidgetsFromDisk(
  page: import('@playwright/test').Page,
  workflowName: string,
  nodeType: string
) {
  return page.evaluate(
    async ({ name, type }) => {
      const api = (window as any).comfyAPI?.api?.api
      const res = await api.fetchApi(`/userdata/${encodeURIComponent('workflows/' + name + '.json')}`)
      if (!res.ok) return { error: res.status as number }
      const json = await res.json()
      const node = (json?.nodes || []).find((n: any) => n.type === type)
      return { widgets: (node?.widgets_values ?? null) as unknown[] | null }
    },
    { name: workflowName, type: nodeType }
  )
}

test('an in-place save persists a value the tracker never saw', async ({
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
    graph.add(LG.createNode('EmptyLatentImage'))
  })
  await settleCanvas(page)

  // First save gives the tab a real path. A never-saved tab takes the COPY route,
  // which already flushed — this spec is about the in-place overwrite.
  // #907 — the try opens BEFORE the save, so a save that lands but then fails an
  // assertion is still cleaned up (codex). `name` is assigned inside and read by the
  // finally, which no-ops on an empty one.
  let name = ''
  try {
    // #907 — SAVE UNDER A NAME THAT IS UNMISTAKABLY OURS. An unnamed save gets
    // ComfyUI's `Untitled <date> <time>`, which is the SAME shape it gives the
    // developer's own unnamed saves — so a cleanup keyed on that name can delete
    // their work if they happen to save while the suite runs (codex). Naming it
    // here means nothing the suite deletes is ever ambiguous.
    const e2eName = `cmcp-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const first = await mockBridge.command('workflow_save_as', { name: e2eName })
    expect(first.ok, 'the first save must succeed so the tab has a path').toBe(true)
    name = String(first.result?.workflow || '')
    expect(name, 'the save must report the workflow name').toBeTruthy()

    // Change a value the way a NODE does: directly, no user input event — and issue no
    // panel command afterwards, because the dispatch captures after every completed
    // command and would refresh the tracker, hiding the very lag this is about.
    await page.evaluate(() => {
      const w = window as any
      const app = w.comfyAPI?.app?.app || w.app
      const graph = app?.canvas?.graph ?? app?.graph
      const node = (graph?.nodes || []).find((n: any) => n.type === 'EmptyLatentImage')
      const widget = (node.widgets || []).find((x: any) => x.name === 'width')
      widget.value = 1337
    })

    // Precondition: the tracker must NOT have seen it, or this passes for the wrong reason.
    const trackerLagged = await page.evaluate(() => {
      const w = window as any
      const app = w.comfyAPI?.app?.app || w.app
      const wf = app?.extensionManager?.workflow?.activeWorkflow
      const node = (wf?.changeTracker?.activeState?.nodes || []).find(
        (n: any) => n.type === 'EmptyLatentImage'
      )
      return !((node?.widgets_values || []) as unknown[]).includes(1337)
    })
    expect(trackerLagged, 'precondition: the tracker must not have seen the change').toBe(true)

    const saved = await mockBridge.command('workflow_save', {})
    expect(saved.ok, 'the in-place save must succeed').toBe(true)

    // THE BYTES, not the panel's account of them. Before #878 this was the node's
    // default — the file quietly disagreeing with the screen.
    const onDisk = await readWidgetsFromDisk(page, name, 'EmptyLatentImage')
    expect(onDisk.error, 'the saved workflow must be readable from disk').toBeUndefined()
    expect(onDisk.widgets, 'the saved file must carry the live value, not the tracker default').toContain(
      1337
    )
  } finally {
    await deleteSavedWorkflow(page, name)
  }
})
