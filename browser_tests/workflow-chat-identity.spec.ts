import { test, expect } from './fixtures/panelTest'
import { resolveHistoryStoreModuleUrl } from './fixtures/historyStoreModule'
import { routeWorktreeSource } from './fixtures/worktreeSource'

const THREADS_KEY = 'comfyui-mcp.panel.threads'
const CURRENT_THREAD_KEY = 'comfyui-mcp.panel.currentThreadId'

test.beforeEach(async ({ context }) => {
  await routeWorktreeSource(context)
})

// mcp#884: the workflow/ask chat scopes are retired — chatScopeMode() is
// hard-wired to "panel", so these specs exercise the one shipping mode. The
// retired workflow scope used to embed a UUID into graph.extra on first
// record; panel scope resolves workflow PROVENANCE for the thread without
// writing to the graph at all — and, as before, without ever dirtying it.
test('opening a workflow does not dirty it and first record keeps provenance off-graph', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await page.waitForFunction(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    return !!app?.graph && !!app?.extensionManager?.workflow?.activeWorkflow
  })
  const before = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const graph = app.graph
    const workflow = app.extensionManager?.workflow?.activeWorkflow
    if (graph.extra?.comfyui_mcp) delete graph.extra.comfyui_mcp
    w.__cmcpIdentityMutationCalls = { before: 0, after: 0, dirty: 0 }
    const originalBefore = graph.beforeChange?.bind(graph)
    const originalAfter = graph.afterChange?.bind(graph)
    const originalDirty = graph.setDirtyCanvas?.bind(graph)
    graph.beforeChange = (...args: unknown[]) => {
      w.__cmcpIdentityMutationCalls.before++
      return originalBefore?.(...args)
    }
    graph.afterChange = (...args: unknown[]) => {
      w.__cmcpIdentityMutationCalls.after++
      return originalAfter?.(...args)
    }
    graph.setDirtyCanvas = (...args: unknown[]) => {
      w.__cmcpIdentityMutationCalls.dirty++
      return originalDirty?.(...args)
    }
    return { isModified: workflow?.isModified ?? null }
  })

  await panel.openSidebar()
  await page.waitForTimeout(700)
  const opened = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const workflow = app.extensionManager?.workflow?.activeWorkflow
    return {
      isModified: workflow?.isModified ?? null,
      calls: w.__cmcpIdentityMutationCalls
    }
  })
  expect(opened.isModified).toBe(before.isModified)
  expect(opened.calls).toEqual({ before: 0, after: 0, dirty: 0 })

  await panel.setBridgeUrl(mockBridge.url)
  await panel.connect()
  // The greeting record resolves this workflow's identity as thread
  // provenance (history metadata) without re-stamping the deleted graph tag.
  await expect.poll(() => page.evaluate((threadsKey) => {
    const threads = JSON.parse(localStorage.getItem(threadsKey) || '[]')
    return threads.find((t: any) => t.msgs?.length)?.workflowKey ?? null
  }, THREADS_KEY)).toMatch(/^workflow:/)
  const recorded = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    return {
      embedded: app.graph?.extra?.comfyui_mcp?.workflow_uuid ?? null,
      calls: w.__cmcpIdentityMutationCalls
    }
  })
  expect(recorded.embedded).toBeNull()
  expect(recorded.calls).toEqual({ before: 0, after: 0, dirty: 0 })
})

test('default mode opens pre-upgrade history without re-keying it', async ({
  page,
  panel
}) => {
  // Seed storage before navigation: ComfyUI may eagerly restore the Agent tab
  // and mount the panel before openSidebar() is called.
  await page.addInitScript(({ threadsKey, currentThreadKey }) => {
    localStorage.setItem(threadsKey, JSON.stringify([
      {
        id: 'old-current',
        ts: Date.now() - 10,
        workflowKey: 'wf:workflows/original.json',
        msgs: [{ role: 'user', text: 'old current thread' }]
      },
      {
        id: 'old-secondary',
        ts: Date.now(),
        workflowKey: 'wf:workflows/another.json',
        msgs: [{ role: 'user', text: 'old secondary thread' }]
      }
    ]))
    sessionStorage.setItem(currentThreadKey, 'old-current')
  }, { threadsKey: THREADS_KEY, currentThreadKey: CURRENT_THREAD_KEY })
  await panel.goto()

  await panel.openSidebar()
  await expect(panel.userBubble('old current thread')).toBeVisible()
  await panel.root.locator('button[title="Chat history"]').click()
  const secondary = panel.root.locator('.cmcp-hist-row').filter({ hasText: 'old secondary thread' })
  await expect(secondary.locator('.cmcp-hist-open')).toBeEnabled()
  await secondary.locator('.cmcp-hist-open').click()
  await expect(panel.userBubble('old secondary thread')).toBeVisible()

  const keys = await page.evaluate((threadsKey) =>
    JSON.parse(localStorage.getItem(threadsKey) || '[]').map((t: any) => [t.id, t.workflowKey]),
  THREADS_KEY)
  expect(keys).toEqual([
    ['old-current', 'wf:workflows/original.json'],
    ['old-secondary', 'wf:workflows/another.json']
  ])
})

// mcp#884/#897 (P0-1): the agent session is orchestrator-global — ONE
// conversation per backend across every tab and workflow. When another tab
// moves the shared selection (its loadThread writes the panel:global pointer),
// this tab must follow it, and the next message typed here must be recorded
// into the adopted conversation — never into the thread this tab used to show.
test('adopts the shared conversation another tab selected, across workflows', async ({
  page,
  context,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('conversation A marker')
  await received

  // Another tab archives a thread from a DIFFERENT workflow and moves the
  // shared panel selection to it — exactly what loadThread writes there.
  const storeModuleUrl = await resolveHistoryStoreModuleUrl(page)
  const otherTab = await context.newPage()
  await otherTab.goto(page.url())
  await otherTab.evaluate(async ({ storeModuleUrl }) => {
    const { ChatHistoryStore, updateMetadataEntry } = await import(storeModuleUrl)
    const otherStore = new ChatHistoryStore({ writerId: 'other-tab-test' })
    const canonical = await otherStore.readCanonical()
    const now = Date.now() + 50
    const meta = updateMetadataEntry(
      canonical.meta || {},
      'activeByScope',
      'panel:global',
      'cross-workflow-thread',
      { updatedAt: now, writerId: 'other-tab-test', sequence: 1 }
    )
    otherStore.persist([
      ...(canonical.threads || []),
      {
        id: 'cross-workflow-thread',
        createdAt: now,
        updatedAt: now,
        ts: now,
        workflowKey: 'workflow:definitely-another-workflow',
        workflowTitle: 'Workflow B',
        msgs: [{
          id: 'cross-msg-1',
          role: 'user',
          text: 'moved here from another tab',
          createdAt: now
        }]
      }
    ], meta)
    const result = await otherStore.flush()
    if (result !== true && (result as any)?.ok !== true) {
      throw new Error(`shared-selection seed failed: ${JSON.stringify(result)}`)
    }
    await otherStore.close?.()
  }, { storeModuleUrl })
  await otherTab.close()

  // This tab follows the shared selection without a reload...
  await expect(panel.userBubble('moved here from another tab')).toBeVisible()
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), CURRENT_THREAD_KEY))
    .toBe('cross-workflow-thread')

  // ...and the next message typed HERE is recorded into the adopted
  // conversation (the one the orchestrator's global session is in).
  const next = mockBridge.waitForUserMessage()
  await panel.sendMessage('recorded into the adopted conversation')
  await next
  await expect.poll(() => page.evaluate((threadsKey) => {
    const threads = JSON.parse(localStorage.getItem(threadsKey) || '[]')
    const adopted = threads.find((t: any) => t.id === 'cross-workflow-thread')
    return adopted?.msgs?.some((m: any) => m.text === 'recorded into the adopted conversation') ?? false
  }, THREADS_KEY)).toBe(true)

  // Panel scope has no foreign-workflow lockout: the conversation this tab
  // showed before remains an openable archive entry, workflow provenance and
  // all (one conversation spans workflows — mcp#884's invariant).
  await panel.root.locator('button[title="Chat history"]').click()
  const previousRow = panel.root.locator('.cmcp-hist-row').filter({ hasText: 'conversation A marker' })
  await expect(previousRow).toBeVisible()
  await expect(previousRow.locator('.cmcp-hist-open')).toBeEnabled()
})
