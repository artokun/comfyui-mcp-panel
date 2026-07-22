/**
 * A full ComfyUI/browser restart creates a new page session: localStorage
 * survives, sessionStorage does not. The panel must recover both the visible
 * transcript and the backend session id from the durable thread record.
 */
import { test, expect } from './fixtures/panelTest'
import { PanelPage } from './fixtures/PanelPage'

const SESSION_KEY = 'comfyui-mcp.panel.sessionId'
const CURRENT_THREAD_KEY = 'comfyui-mcp.panel.currentThreadId'
const LOCAL_HISTORY_SNAPSHOT_KEY = 'comfyui-mcp.panel.historySnapshot'

async function indexedThreadCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('comfyui-mcp-panel-history', 3)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = db.transaction('snapshots', 'readonly').objectStore('snapshots').get('state')
        request.onsuccess = () => resolve(Array.isArray(request.result?.threads) ? request.result.threads.length : 0)
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  })
}

async function indexedHasText(page: import('@playwright/test').Page, text: string): Promise<boolean> {
  return page.evaluate(async (needle) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('comfyui-mcp-panel-history', 3)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const request = db.transaction('snapshots', 'readonly').objectStore('snapshots').get('state')
        request.onsuccess = () => resolve(Boolean(request.result?.threads?.some(
          (thread: any) => thread.msgs?.some((message: any) => message.text === needle)
        )))
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  }, text)
}

async function indexedHasThread(
  page: import('@playwright/test').Page,
  threadId: string
): Promise<boolean> {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('comfyui-mcp-panel-history', 3)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const request = db.transaction('snapshots', 'readonly').objectStore('snapshots').get('state')
        request.onsuccess = () => resolve(Boolean(
          request.result?.threads?.some((thread: any) => thread.id === id)
        ))
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  }, threadId)
}

async function seedReloadEvictionRace(
  page: import('@playwright/test').Page,
  currentThreadId: string
): Promise<void> {
  await page.evaluate(async ({ pointedId }) => {
    const future = Date.now() + 60_000
    const background = Array.from({ length: 500 }, (_, i) => ({
      id: `newer-background-thread-${i}`,
      schemaVersion: 2,
      workflowKey: `workflow:background-race-${i}`,
      createdAt: future + i,
      updatedAt: future + i,
      ts: future + i,
      msgs: [{
        id: `newer-background-message-${i}`,
        role: 'user',
        text: i === 0 ? 'newer background transcript' : `background transcript ${i}`,
        createdAt: future + i
      }]
    }))
    const rewrite = (snapshot: any) => {
      const threads = Array.isArray(snapshot?.threads) ? snapshot.threads : []
      const pointed = threads.find((thread: any) => thread.id === pointedId)
      if (pointed) {
        pointed.sessionId = 'stale-stored-session'
        pointed.updatedAt = future - 1
        pointed.ts = future - 1
      }
      return {
        ...snapshot,
        updatedAt: future,
        threads: [
          ...threads.filter((thread: any) => !thread.id?.startsWith('newer-background-thread-')),
          ...background
        ],
        meta: {
          ...(snapshot?.meta || {}),
          updatedAt: future,
          activeByScope: {
            ...(snapshot?.meta?.activeByScope || {}),
            'panel:global': 'missing-active-pointer'
          }
        }
      }
    }

    const localThreads = JSON.parse(localStorage.getItem('comfyui-mcp.panel.threads') || '[]')
    const localMeta = JSON.parse(localStorage.getItem('comfyui-mcp.panel.historyMeta') || '{}')
    const local = rewrite({ threads: localThreads, meta: localMeta })
    localStorage.setItem('comfyui-mcp.panel.threads', JSON.stringify(local.threads))
    localStorage.setItem('comfyui-mcp.panel.historyMeta', JSON.stringify(local.meta))

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('comfyui-mcp-panel-history', 3)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('snapshots', 'readwrite')
        const store = tx.objectStore('snapshots')
        const get = store.get('state')
        get.onsuccess = () => store.put(rewrite(get.result || {}), 'state')
        get.onerror = () => reject(get.error)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }, { pointedId: currentThreadId })
}

test('restores the latest panel-owned conversation after sessionStorage is lost', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  mockBridge.send({ type: 'session', session_id: 'persisted-test-session' })
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY))
    .toBe('persisted-test-session')

  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('persist me across a full restart')
  await received
  mockBridge.say('durable agent reply')

  await expect(panel.userBubble('persist me across a full restart')).toBeVisible()
  await expect(panel.agentBubbles.filter({ hasText: 'durable agent reply' }).last()).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('comfyui-mcp.panel.threads')))
    .not.toBeNull()

  // Model a fully closed/reopened ComfyUI window: keep localStorage, discard the
  // tab-scoped pointers, and reload the application/module from scratch.
  await page.evaluate(() => {
    localStorage.removeItem('comfyui-mcp.panel.autoConnect')
    sessionStorage.clear()
  })
  await page.reload()
  await panel.openSidebar()

  await expect(panel.userBubble('persist me across a full restart')).toBeVisible()
  await expect(panel.agentBubbles.filter({ hasText: 'durable agent reply' }).last()).toBeVisible()
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), CURRENT_THREAD_KEY))
    .not.toBeNull()
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY))
    .toBe('persisted-test-session')
})

test('restores from IndexedDB after the localStorage shadow is lost', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('indexeddb-only transcript')
  await received
  mockBridge.say('indexeddb-only reply')
  await expect.poll(() => indexedThreadCount(page)).toBeGreaterThan(0)
  await expect.poll(() => indexedHasText(page, 'indexeddb-only transcript')).toBe(true)
  await expect.poll(() => indexedHasText(page, 'indexeddb-only reply')).toBe(true)

  await page.evaluate(() => {
    localStorage.removeItem('comfyui-mcp.panel.historySnapshot')
    localStorage.removeItem('comfyui-mcp.panel.threads')
    localStorage.removeItem('comfyui-mcp.panel.historyMeta')
    localStorage.removeItem('comfyui-mcp.panel.autoConnect')
    sessionStorage.clear()
  })
  await page.reload()
  await panel.openSidebar()

  await expect(panel.userBubble('indexeddb-only transcript')).toBeVisible()
  await expect(panel.agentBubbles.filter({ hasText: 'indexeddb-only reply' }).last()).toBeVisible()
})

test('reload keeps the pointed conversation and live tab session during durable hydration', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  mockBridge.send({ type: 'session', session_id: 'live-tab-session' })
  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('conversation selected by this tab')
  await received
  mockBridge.say('selected conversation reply')

  await expect.poll(
    () => page.evaluate((key) => sessionStorage.getItem(key), CURRENT_THREAD_KEY)
  ).not.toBeNull()
  const currentThreadId = await page.evaluate(
    (key) => sessionStorage.getItem(key),
    CURRENT_THREAD_KEY
  )
  expect(currentThreadId).not.toBeNull()
  await expect.poll(() => indexedHasText(page, 'conversation selected by this tab')).toBe(true)
  await seedReloadEvictionRace(page, currentThreadId!)

  await page.evaluate(() => localStorage.removeItem('comfyui-mcp.panel.autoConnect'))
  await page.reload()
  await panel.openSidebar()

  await expect(panel.userBubble('conversation selected by this tab')).toBeVisible()
  await expect(panel.userBubble('newer background transcript')).toHaveCount(0)
  await expect.poll(
    () => page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)
  ).toBe('live-tab-session')

  // The active metadata rewrite occurs only after settings + IndexedDB hydration,
  // so this is a deterministic completion signal for the final binding.
  await expect.poll(() => page.evaluate(() => {
    const meta = JSON.parse(localStorage.getItem('comfyui-mcp.panel.historyMeta') || '{}')
    return meta.activeByScope?.['panel:global'] || null
  })).toBe(currentThreadId)
  await expect(panel.userBubble('conversation selected by this tab')).toBeVisible()
  await expect(panel.userBubble('newer background transcript')).toHaveCount(0)
  expect(await page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)).toBe('live-tab-session')
  expect(await page.evaluate((pointedId) => {
    const shadow = JSON.parse(localStorage.getItem('comfyui-mcp.panel.threads') || '[]')
    return {
      count: shadow.length,
      hasPointed: shadow.some((thread: any) => thread.id === pointedId)
    }
  }, currentThreadId)).toEqual({ count: 20, hasPointed: true })
  await expect.poll(() => indexedThreadCount(page)).toBe(500)
  await expect.poll(() => indexedHasThread(page, currentThreadId!)).toBe(true)
  expect(await page.evaluate((key) => localStorage.getItem(key), LOCAL_HISTORY_SNAPSHOT_KEY)).not.toBeNull()
})

test('strict workflow storage sync detaches transcript todos and session before the next record', async ({
  page,
  context,
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
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()
  mockBridge.send({ type: 'session', session_id: 'workflow-a-session' })

  const initial = mockBridge.waitForUserMessage()
  await panel.sendMessage('workflow A visible transcript')
  await initial
  await expect.poll(
    () => page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)
  ).toBe('workflow-a-session')
  const currentThreadId = await page.evaluate(
    (key) => sessionStorage.getItem(key),
    CURRENT_THREAD_KEY
  )
  expect(currentThreadId).not.toBeNull()

  const otherTab = await context.newPage()
  await otherTab.goto(page.url())
  await otherTab.evaluate(({ snapshotKey, threadId }) => {
    const snapshot = JSON.parse(localStorage.getItem(snapshotKey) || '{}')
    const thread = snapshot.threads?.find((candidate: any) => candidate.id === threadId)
    if (!thread) throw new Error('current thread missing from shared shadow')
    const updatedAt = Date.now() + 10_000
    const revision = { updatedAt, writerId: 'tab-b', sequence: 1 }
    thread.workflowKey = 'workflow:foreign-provenance'
    thread.todos = [{ text: 'foreign todo', status: 'active' }]
    thread.updatedAt = updatedAt
    thread.ts = updatedAt
    thread.fieldOps = {
      ...(thread.fieldOps || {}),
      workflowKey: {
        value: 'workflow:foreign-provenance',
        deleted: false,
        updatedAt,
        revision
      },
      todos: {
        value: [{ text: 'foreign todo', status: 'active' }],
        deleted: false,
        updatedAt,
        revision: { ...revision, sequence: 2 }
      }
    }
    localStorage.setItem(snapshotKey, JSON.stringify(snapshot))
  }, { snapshotKey: LOCAL_HISTORY_SNAPSHOT_KEY, threadId: currentThreadId })

  await expect.poll(
    () => page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)
  ).toBeNull()
  await expect.poll(
    () => page.evaluate((key) => sessionStorage.getItem(key), CURRENT_THREAD_KEY)
  ).toBeNull()
  await expect(panel.userBubble('workflow A visible transcript')).toHaveCount(0)
  await expect(panel.root.locator('.cmcp-todo-item')).toHaveCount(0)

  const next = mockBridge.waitForUserMessage()
  await panel.sendMessage('fresh workflow A transcript')
  await next
  const rebound = await page.evaluate(({ snapshotKey, sessionKey }) => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const workflowUuid = app.graph?.extra?.comfyui_mcp?.workflow_uuid
    const snapshot = JSON.parse(localStorage.getItem(snapshotKey) || '{}')
    const thread = snapshot.threads?.find((candidate: any) =>
      candidate.msgs?.some((message: any) => message.text === 'fresh workflow A transcript'))
    return { workflowUuid, thread, sessionId: sessionStorage.getItem(sessionKey) }
  }, { snapshotKey: LOCAL_HISTORY_SNAPSHOT_KEY, sessionKey: SESSION_KEY })
  expect(rebound.thread?.workflowKey).toBe(`workflow:${rebound.workflowUuid}`)
  expect(rebound.thread?.sessionId).toBeUndefined()
  expect(rebound.sessionId).toBeNull()
  await otherTab.close()
})

test('workflow rename publishes alias tombstones and a stale tab cannot echo them back', async ({
  page,
  context,
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
  await panel.openSidebar()
  await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const workflow = app.extensionManager?.workflow?.activeWorkflow
    Object.defineProperties(workflow, {
      path: { configurable: true, writable: true, value: 'workflows/alias-old.json' },
      isPersisted: { configurable: true, writable: true, value: true },
      isTemporary: { configurable: true, writable: true, value: false }
    })
  })
  await expect.poll(() => page.evaluate(() => {
    const aliases = JSON.parse(localStorage.getItem('comfyui-mcp.panel.workflowUuidAliases') || '{}')
    return aliases['workflows/alias-old.json'] || null
  })).not.toBeNull()
  const workflowUuid = await page.evaluate(() => {
    const aliases = JSON.parse(localStorage.getItem('comfyui-mcp.panel.workflowUuidAliases') || '{}')
    return aliases['workflows/alias-old.json']
  })

  const otherTab = await context.newPage()
  const otherPanel = new PanelPage(otherTab)
  await otherTab.goto(page.url())
  await otherPanel.openSidebar()
  await expect.poll(() => otherTab.evaluate(() => {
    const aliases = JSON.parse(localStorage.getItem('comfyui-mcp.panel.workflowUuidAliases') || '{}')
    return aliases['workflows/alias-old.json'] || null
  })).toBe(workflowUuid)

  await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    app.extensionManager.workflow.activeWorkflow.path = 'workflows/alias-new.json'
  })
  await expect.poll(() => page.evaluate(() => {
    const snapshot = JSON.parse(localStorage.getItem('comfyui-mcp.panel.historySnapshot') || '{}')
    return {
      oldDeleted: snapshot.meta?.aliasOps?.['workflows/alias-old.json']?.deleted === true,
      newValue: snapshot.meta?.workflowAliases?.['workflows/alias-new.json'] || null
    }
  })).toEqual({ oldDeleted: true, newValue: workflowUuid })

  await otherPanel.setBridgeUrl(mockBridge.url)
  await otherPanel.connect()
  const unrelated = mockBridge.waitForUserMessage()
  await otherPanel.sendMessage('unrelated append after remote rename')
  await unrelated
  await expect.poll(() => otherTab.evaluate(() => {
    const snapshot = JSON.parse(localStorage.getItem('comfyui-mcp.panel.historySnapshot') || '{}')
    return snapshot.meta?.aliasOps?.['workflows/alias-old.json']?.deleted === true
  })).toBe(true)

  await page.reload()
  await panel.openSidebar()
  await otherTab.reload()
  await otherPanel.openSidebar()
  for (const tab of [page, otherTab]) {
    await expect.poll(() => tab.evaluate(() => {
      const aliases = JSON.parse(localStorage.getItem('comfyui-mcp.panel.workflowUuidAliases') || '{}')
      return {
        hasOld: Object.hasOwn(aliases, 'workflows/alias-old.json'),
        newValue: aliases['workflows/alias-new.json'] || null
      }
    })).toEqual({ hasOld: false, newValue: workflowUuid })
  }
  await otherTab.close()
})
