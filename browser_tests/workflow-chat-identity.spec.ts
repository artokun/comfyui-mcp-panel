import { test, expect } from './fixtures/panelTest'

const THREADS_KEY = 'comfyui-mcp.panel.threads'
const CURRENT_THREAD_KEY = 'comfyui-mcp.panel.currentThreadId'
const SESSION_KEY = 'comfyui-mcp.panel.sessionId'

test('opening a workflow does not dirty it and first record embeds silently', async ({
  page,
  panel,
  mockBridge
}) => {
  await page.route(
    (url) => /\/(api\/)?settings\/?$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const settings = await response.json() as Record<string, unknown>
      settings['comfyui-mcp.sessionFollowsPanel'] = false
      await route.fulfill({ response, json: settings })
    }
  )

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
  const recorded = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    return {
      uuid: app.graph?.extra?.comfyui_mcp?.workflow_uuid,
      calls: w.__cmcpIdentityMutationCalls
    }
  })
  expect(recorded.uuid).toMatch(/^[0-9a-f-]{36}$/i)
  expect(recorded.calls).toEqual({ before: 0, after: 0, dirty: 0 })
})

test('default mode opens pre-upgrade history without re-keying it', async ({
  page,
  panel
}) => {
  await panel.goto()
  await page.evaluate(({ threadsKey, currentThreadKey }) => {
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

test('settings hydration never adopts a loose session into a workflow thread', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await page.evaluate(({ threadsKey, currentThreadKey }) => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const settings = app.ui.settings
    const originalGet = settings.getSettingValue.bind(settings)
    w.__cmcpPerWorkflowHydrated = false
    settings.getSettingValue = (id: string) =>
      id === 'comfyui-mcp.sessionFollowsPanel'
        ? !w.__cmcpPerWorkflowHydrated
        : originalGet(id)
    localStorage.setItem(threadsKey, JSON.stringify([{
      id: 'workflow-before-hydration',
      ts: Date.now(),
      workflowKey: 'workflow:existing-scope',
      msgs: [{ role: 'user', text: 'workflow thread before hydration' }]
    }]))
    sessionStorage.setItem(currentThreadKey, 'workflow-before-hydration')
  }, { threadsKey: THREADS_KEY, currentThreadKey: CURRENT_THREAD_KEY })

  await panel.openSidebar()
  await expect(panel.userBubble('workflow thread before hydration')).toBeVisible()
  await page.evaluate((sessionKey) => {
    const w = window as any
    w.__cmcpPerWorkflowHydrated = true
    sessionStorage.setItem(sessionKey, 'live-tab-session')
  }, SESSION_KEY)

  await panel.setBridgeUrl(mockBridge.url)
  await panel.connect()

  // #106's contract: a workflow-scoped conversation NEVER adopts a loose tab
  // session — its session must arrive through a thread selected for its exact
  // scope. Hydration clears the loose key instead of binding it to the wrong
  // conversation, and the new greeting thread starts fresh without it.
  await expect
    .poll(async () => {
      const state = await page.evaluate(({ threadsKey, sessionKey }) => ({
        sessionId: sessionStorage.getItem(sessionKey),
        threads: JSON.parse(localStorage.getItem(threadsKey) || '[]')
      }), { threadsKey: THREADS_KEY, sessionKey: SESSION_KEY })
      const greeting = state.threads.find((t: any) =>
        t.msgs?.some((m: any) => m.text === 'Panel agent ready.'))
      return {
        sessionId: state.sessionId,
        beforeScope: state.threads.find((t: any) => t.id === 'workflow-before-hydration')?.workflowKey,
        greetingScope: greeting?.workflowKey ?? null,
        greetingSession: greeting?.sessionId ?? null
      }
    }, { timeout: 15_000 })
    .toEqual({
      sessionId: null,
      beforeScope: 'workflow:existing-scope',
      greetingScope: expect.stringMatching(/^workflow:/) as unknown as string,
      greetingSession: null
    })
})

test('embeds a workflow UUID and blocks a foreign transcript pointer', async ({
  page,
  context,
  panel,
  mockBridge
}) => {
  // Make the legacy per-workflow setting available before the panel mounts and
  // after reload; the shared fixture intentionally strips real user settings.
  await page.route(
    (url) => /\/(api\/)?settings\/?$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const response = await route.fetch()
      const settings = await response.json() as Record<string, unknown>
      settings['comfyui-mcp.sessionFollowsPanel'] = false
      await route.fulfill({ response, json: settings })
    }
  )

  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('workflow identity marker')
  await received

  const current = await page.evaluate((threadsKey) => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const threads = JSON.parse(localStorage.getItem(threadsKey) || '[]')
    return {
      uuid: app?.graph?.extra?.comfyui_mcp?.workflow_uuid,
      thread: threads.find((t: any) => t.msgs?.some((m: any) => m.text === 'workflow identity marker'))
    }
  }, THREADS_KEY)

  expect(current.uuid).toMatch(/^[0-9a-f-]{36}$/i)
  expect(current.thread?.workflowKey).toBe(`workflow:${current.uuid}`)

  // A foreign (other-workflow) thread arrives the way foreign threads really
  // do in this architecture: another tab writes it through the store, landing
  // in the shared canonical. (Direct localStorage writes are just this tab's
  // own cache and are legitimately overwritten by the owning panel's flush.)
  const otherTab = await context.newPage()
  await otherTab.goto(page.url())
  await otherTab.evaluate(async ({ threadsKey, currentThreadKey }) => {
    const storeModuleUrl = '/extensions/comfyui-agent-panel/js/lib/chat-history-store.js'
    const { ChatHistoryStore } = await import(storeModuleUrl)
    const foreignStore = new ChatHistoryStore({ writerId: 'foreign-tab-test' })
    const existing = JSON.parse(localStorage.getItem(threadsKey) || '[]')
    foreignStore.persist([
      ...existing,
      {
        id: 'foreign-thread',
        ts: Date.now() + 10,
        workflowKey: 'workflow:definitely-another-workflow',
        msgs: [{ id: 'foreign-msg-1', role: 'user', text: 'must never restore on this workflow' }]
      }
    ], {})
    await foreignStore.flush()
    await foreignStore.close?.()
  }, { threadsKey: THREADS_KEY, currentThreadKey: CURRENT_THREAD_KEY })
  await otherTab.close()

  await page.reload()
  await panel.openSidebar()
  await expect(panel.userBubble('must never restore on this workflow')).toHaveCount(0)

  await panel.root.locator('button[title="Chat history"]').click()
  const foreign = panel.root.locator('.cmcp-hist-row').filter({ hasText: 'must never restore on this workflow' })
  await expect(foreign).toBeVisible()
  await expect(foreign.locator('.cmcp-hist-open')).toBeDisabled()
  await expect(foreign).toHaveCSS('opacity', '0.48')
})
