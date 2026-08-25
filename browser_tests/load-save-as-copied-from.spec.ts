/**
 * #1762 — `panel_load_workflow` replaces the live graph in the current tab while
 * keeping that tab's ComfyWorkflow object/path. A following Save-As must not report
 * the tab's old filename as the loaded graph's source.
 */
import { test, expect, deleteSavedWorkflow } from './fixtures/panelTest'
import { routeWorktreeSource } from './fixtures/worktreeSource'

test.beforeEach(async ({ context }) => {
  await routeWorktreeSource(context)
})

test('load-then-Save-As reports unknown copied_from provenance instead of the stale tab name', async ({
  page,
  panel,
  mockBridge
}) => {
  test.setTimeout(120_000)
  const cleanup: string[] = []
  try {
    await panel.goto()
    await panel.setBridgeUrl(mockBridge.url)
    await panel.openSidebar()
    await panel.connect()

    // Give the source tab a real saved filename so the regression is specifically the
    // stale copied_from field, not first-save handling.
    const added = await mockBridge.command('graph_add_node', { class_type: 'VAEDecode' })
    expect(added.ok, `the setup graph edit must succeed: ${added.error || ''}`).toBe(true)
    const first = await mockBridge.command('workflow_save', {})
    expect(first.ok, `the setup save must succeed: ${first.error || ''}`).toBe(true)
    const original = String(first.result?.workflow || '')
    expect(original).toBeTruthy()
    cleanup.push(original)

    // This is the production graph replacement used by panel_load_workflow. An empty UI
    // graph is enough here: the source tab contains VAEDecode, and the loaded graph is empty.
    const loaded = await mockBridge.command('graph_load', {
      graph: {
        last_node_id: 0,
        last_link_id: 0,
        nodes: [],
        links: [],
        groups: [],
        config: {},
        extra: {},
        version: 0.4
      }
    })
    expect(loaded.ok, `panel_load_workflow's graph replacement must succeed: ${loaded.error || ''}`).toBe(true)
    expect(loaded.result?.loaded).toBe(true)
    expect(loaded.result?.node_count).toBe(0)

    const outline = await mockBridge.command('graph_outline', {})
    expect(outline.ok, `the loaded graph must remain the active graph: ${outline.error || ''}`).toBe(true)
    expect(outline.result?.node_count).toBe(0)

    const copyName = `e2e-1762-${Date.now()}`
    const saved = await mockBridge.command('workflow_save', { name: copyName })
    expect(saved.ok, `the Save-As must succeed: ${saved.error || ''}`).toBe(true)
    cleanup.push(copyName)
    expect(saved.result?.saved_as).toBe(true)
    expect(saved.result?.copied_from).toBeNull()
    expect(saved.result?.copied_from).not.toBe(original)
  } finally {
    for (const name of cleanup.reverse()) {
      try {
        await deleteSavedWorkflow(page, name)
      } catch {
        // Best-effort cleanup must not mask the production-path assertion.
      }
    }
  }
})
