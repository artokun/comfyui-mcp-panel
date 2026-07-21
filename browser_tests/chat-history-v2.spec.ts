import { test, expect } from './fixtures/panelTest'
import { resolveHistoryStoreModuleUrl } from './fixtures/historyStoreModule'

const THREADS_KEY = 'comfyui-mcp.panel.threads'
const META_KEY = 'comfyui-mcp.panel.historyMeta'

async function forceWorkflowScope(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const settings = app.ui.settings
    if (!w.__cmcpOriginalGetSettingValue) {
      w.__cmcpOriginalGetSettingValue = settings.getSettingValue.bind(settings)
    }
    settings.getSettingValue = (id: string) =>
      id === 'comfyui-mcp.chatScope'
        ? 'workflow'
        : w.__cmcpOriginalGetSettingValue(id)
  })
}

async function indexedThreadCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('comfyui-mcp-panel-history', 3)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<number>((resolve, reject) => {
        const req = db.transaction('snapshots', 'readonly').objectStore('snapshots').get('state')
        req.onsuccess = () => resolve(Array.isArray(req.result?.threads) ? req.result.threads.length : 0)
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  })
}

async function indexedHasMessage(
  page: import('@playwright/test').Page,
  text: string
): Promise<boolean> {
  return page.evaluate(async (wanted) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('comfyui-mcp-panel-history', 3)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const req = db.transaction('snapshots', 'readonly').objectStore('snapshots').get('state')
        req.onsuccess = () => resolve(
          (req.result?.threads || []).some((thread: any) =>
            thread.msgs?.some((message: any) => message.text === wanted))
        )
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  }, text)
}

test('keeps multiple chats, supports search and restores from IndexedDB without localStorage', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  let received = mockBridge.waitForUserMessage()
  await panel.sendMessage('first durable conversation')
  await received
  mockBridge.say('first answer')

  await panel.root.locator('button[title="New chat"]').click()
  received = mockBridge.waitForUserMessage()
  await panel.sendMessage('second searchable conversation')
  await received
  mockBridge.say('second answer')

  await expect(panel.root.locator('.cmcp-workflow-version').last()).toBeVisible()
  await expect.poll(() => indexedThreadCount(page)).toBe(2)

  await panel.root.locator('button[title="Chat history"]').click()
  const rows = panel.root.locator('.cmcp-hist-row')
  await expect(rows).toHaveCount(2)
  const currentOnly = panel.root.getByTestId('history-current-workflow')
  await currentOnly.check()
  await expect(rows).toHaveCount(2)
  await currentOnly.uncheck()

  const newest = rows.first()
  await newest.hover()
  await newest.evaluate((row) => {
    const original = window.prompt
    window.prompt = () => 'Pinned test chat'
    row.querySelector<HTMLButtonElement>('button[aria-label="Rename chat"]')?.click()
    window.prompt = original
  })
  await expect(panel.root.locator('.cmcp-hist-row').first()).toContainText('Pinned test chat')
  await panel.root.locator('.cmcp-hist-row').first().getByRole('button', { name: 'Pin chat' }).evaluate((button: HTMLButtonElement) => button.click())

  const search = panel.root.getByRole('searchbox', { name: 'Search chat history' })
  await search.fill('first durable')
  await expect(panel.root.locator('.cmcp-hist-row')).toHaveCount(1)
  await expect(panel.root.locator('.cmcp-hist-row')).toContainText('first durable conversation')

  const downloadPromise = page.waitForEvent('download')
  await panel.root.getByRole('button', { name: 'Export all chat history' }).evaluate((button: HTMLButtonElement) => button.click())
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^comfyui-agent-panel-history-.*\.json$/)

  await search.fill('')
  const chooserPromise = page.waitForEvent('filechooser')
  await panel.root.getByRole('button', { name: 'Import chat history (merge)' }).evaluate((button: HTMLButtonElement) => button.click())
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'history-import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      schemaVersion: 2,
      threads: [{
        id: 'imported-thread',
        ts: 1,
        workflowKey: 'panel:global',
        title: 'Imported archive',
        msgs: [{ role: 'user', text: 'imported history marker' }]
      }],
      meta: {}
    }))
  })
  await expect(panel.root.locator('.cmcp-hist-row')).toHaveCount(3)
  await expect(panel.root.locator('.cmcp-hist-row').filter({ hasText: 'Imported archive' })).toBeVisible()
  await expect.poll(() => indexedThreadCount(page)).toBe(3)

  // importPayload returns cloned records. The panel must rebind its active
  // conversation before the next record(), or this message is appended to a
  // detached object and disappears on reload.
  await panel.root.locator('button[title="Chat history"]').click()
  received = mockBridge.waitForUserMessage()
  await panel.sendMessage('message recorded immediately after import')
  await received
  mockBridge.say('post-import answer')
  await expect.poll(() => indexedHasMessage(page, 'message recorded immediately after import')).toBe(true)

  // Remove both synchronous shadows. IndexedDB alone must recover the newest
  // conversation after a new page session.
  await page.evaluate(([threadsKey, metaKey]) => {
    localStorage.removeItem(threadsKey)
    localStorage.removeItem(metaKey)
    localStorage.removeItem('comfyui-mcp.panel.autoConnect')
    sessionStorage.clear()
  }, [THREADS_KEY, META_KEY])
  await page.reload()
  await panel.openSidebar()

  await expect(panel.userBubble('second searchable conversation')).toBeVisible()
  await expect(panel.userBubble('message recorded immediately after import')).toBeVisible()
  await expect(panel.agentBubbles.filter({ hasText: 'post-import answer' }).last()).toBeVisible()
  await expect(panel.agentBubbles.filter({ hasText: 'second answer' }).last()).toBeVisible()
})

test('groups duplicate workflow titles by UUID and never resumes a foreign provider session', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  const storeModuleUrl = await resolveHistoryStoreModuleUrl(page)
  await page.evaluate(async (moduleUrl) => {
    const { ChatHistoryStore } = await import(moduleUrl)
    const store = new ChatHistoryStore({ writerId: 'archive-provider-test' })
    const canonical = await store.readCanonical()
    const now = Date.now() + 100
    store.persist([
      ...(canonical.threads || []),
      {
        id: 'same-title-a',
        createdAt: now,
        updatedAt: now,
        workflowKey: 'workflow:uuid-a',
        workflowTitle: 'Duplicated Workflow',
        provider: 'codex',
        sessionId: 'codex-session-must-not-resume',
        msgs: [{
          id: 'same-title-a-message',
          role: 'user',
          text: 'foreign provider archive',
          createdAt: now
        }]
      },
      {
        id: 'same-title-b',
        createdAt: now + 1,
        updatedAt: now + 1,
        workflowKey: 'workflow:uuid-b',
        workflowTitle: 'Duplicated Workflow',
        provider: 'claude',
        msgs: [{
          id: 'same-title-b-message',
          role: 'user',
          text: 'second same-title workflow',
          createdAt: now + 1
        }]
      }
    ], canonical.meta)
    const result = await store.flush()
    if (result !== true && result?.ok !== true) {
      throw new Error(`archive seed failed: ${JSON.stringify(result)}`)
    }
    store.close()
  }, storeModuleUrl)

  await panel.root.locator('button[title="Chat history"]').click()
  await expect(
    panel.root.locator('.cmcp-hist-group').filter({ hasText: 'Duplicated Workflow' })
  ).toHaveCount(2)

  const controls: Record<string, unknown>[] = []
  const stopCapture = mockBridge.onFrame((frame) => controls.push(frame))
  await panel.root
    .locator('.cmcp-hist-row')
    .filter({ hasText: 'foreign provider archive' })
    .locator('.cmcp-hist-open')
    .click()
  await expect.poll(() => controls.some((frame) => frame.type === 'new_session')).toBe(true)
  expect(
    controls.some((frame) =>
      frame.type === 'resume_session' &&
      frame.session_id === 'codex-session-must-not-resume')
  ).toBe(false)
  stopCapture()
})

test('embeds a stable workflow UUID and records provider/model workflow snapshots', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  await forceWorkflowScope(page)

  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('workflow identity test')
  await received
  await expect.poll(() => page.evaluate((key) => {
    const threads = JSON.parse(localStorage.getItem(key) || '[]')
    return threads.some((thread: any) =>
      thread.msgs?.some((message: any) => message.text === 'workflow identity test'))
  }, THREADS_KEY)).toBe(true)

  const state = await page.evaluate((key) => {
    const w = window as unknown as {
      app?: { graph?: { extra?: Record<string, any> } }
      comfyAPI?: { app?: { app?: { graph?: { extra?: Record<string, any> } } } }
    }
    const app = w.comfyAPI?.app?.app || w.app
    const threads = JSON.parse(localStorage.getItem(key) || '[]')
    const current = threads.find((t: any) => t.msgs?.some((m: any) => m.text === 'workflow identity test'))
    return {
      uuid: app?.graph?.extra?.comfyui_mcp?.workflow_uuid,
      workflowKey: current?.workflowKey,
      provider: current?.provider,
      model: current?.model,
      versions: current?.workflowVersions,
      messageVersion: current?.msgs?.find((m: any) => m.text === 'workflow identity test')?.workflowVersion
    }
  }, THREADS_KEY)

  expect(state.uuid).toMatch(/^[0-9a-f-]{36}$/i)
  expect(state.workflowKey).toBe(`workflow:${state.uuid}`)
  expect(state.provider).toBe('claude')
  expect(state.model).toBeTruthy()
  expect(state.messageVersion).toMatch(/^[0-9a-f]{8}$/)
  expect(state.versions?.[state.messageVersion]?.nodeCount).toBeGreaterThanOrEqual(0)
})

test('workflow scope disables foreign chats and never restores a stale foreign pointer', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  await forceWorkflowScope(page)

  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('belongs only to workflow A')
  await received

  await expect.poll(() => page.evaluate((key) => {
    const threads = JSON.parse(localStorage.getItem(key) || '[]')
    return threads.find((thread: any) =>
      thread.msgs?.some((m: any) => m.text === 'belongs only to workflow A'))?.workflowKey
  }, THREADS_KEY)).toMatch(/^workflow:/)
  const current = await page.evaluate((key) => {
    const threads = JSON.parse(localStorage.getItem(key) || '[]')
    return threads.find((thread: any) =>
      thread.msgs?.some((m: any) => m.text === 'belongs only to workflow A'))
  }, THREADS_KEY)
  expect(current?.workflowKey).toMatch(/^workflow:/)

  const storeModuleUrl = await resolveHistoryStoreModuleUrl(page)
  await page.evaluate(async ({
    currentThread,
    currentWorkflowKey,
    storeModuleUrl
  }) => {
    const { ChatHistoryStore } = await import(storeModuleUrl)
    const foreignStore = new ChatHistoryStore({ writerId: 'foreign-archive-test' })
    const canonical = await foreignStore.readCanonical()
    const foreignThread = {
      id: 'foreign-thread',
      schemaVersion: 2,
      createdAt: Date.now() + 10,
      updatedAt: Date.now() + 10,
      ts: Date.now() + 10,
      workflowKey: 'workflow:definitely-another-workflow',
      workflowTitle: 'Workflow B',
      msgs: [{ id: 'foreign-message', role: 'user', text: 'must never appear on workflow A', createdAt: Date.now() + 10 }]
    }
    const meta = canonical.meta || {}
    meta.activeByScope = {
      ...(meta.activeByScope || {}),
      [currentWorkflowKey]: currentThread,
      'workflow:definitely-another-workflow': 'foreign-thread'
    }
    foreignStore.persist([...(canonical.threads || []), foreignThread], meta)
    const result = await foreignStore.flush()
    if (result !== true && result?.ok !== true) {
      throw new Error(`foreign archive seed failed: ${JSON.stringify(result)}`)
    }
    foreignStore.close()
    sessionStorage.setItem('comfyui-mcp.panel.currentThreadId', 'foreign-thread')
  }, {
    currentThread: current.id,
    currentWorkflowKey: current.workflowKey,
    storeModuleUrl
  })

  await panel.root.locator('button[title="Chat history"]').click()
  let currentOnly = panel.root.getByTestId('history-current-workflow')
  await currentOnly.uncheck()
  let foreignRow = panel.root.locator('.cmcp-hist-row').filter({ hasText: 'must never appear on workflow A' })
  await expect(foreignRow).toBeVisible()
  await expect(foreignRow.locator('.cmcp-hist-open')).toBeDisabled()
  await expect(foreignRow.locator('.cmcp-hist-open')).toHaveAttribute('title', /open workflow b/i)
  await panel.root.locator('button[title="Chat history"]').click()

  await page.evaluate(() => sessionStorage.clear())

  await page.reload()
  await panel.openSidebar()
  // The hermetic fixture intentionally discards panel-setting writes at the
  // HTTP boundary, so re-apply the user's persisted workflow mode after reload.
  await forceWorkflowScope(page)
  // The fixture's canvas is intentionally unsaved, so a full browser restart
  // creates a fresh workflow UUID and a clean view. Crucially, the stale pointer
  // from Workflow B is never used as a fallback.
  await expect(panel.userBubble('must never appear on workflow A')).toHaveCount(0)

  await panel.root.locator('button[title="Chat history"]').click()
  currentOnly = panel.root.getByTestId('history-current-workflow')
  await currentOnly.uncheck()
  foreignRow = panel.root.locator('.cmcp-hist-row').filter({ hasText: 'must never appear on workflow A' })
  await expect(foreignRow).toBeVisible()
  await expect(foreignRow.locator('.cmcp-hist-open')).toBeDisabled()
  await expect(foreignRow.locator('.cmcp-hist-open')).toHaveAttribute('title', /open workflow b/i)
})
