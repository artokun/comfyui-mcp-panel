/**
 * A full ComfyUI/browser restart creates a new page session: localStorage
 * survives, sessionStorage does not. The panel must recover both the visible
 * transcript and the backend session id from the durable thread record.
 */
import { test, expect } from './fixtures/panelTest'

const SESSION_KEY = 'comfyui-mcp.panel.sessionId'
const CURRENT_THREAD_KEY = 'comfyui-mcp.panel.currentThreadId'

async function indexedThreadCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('comfyui-mcp-panel-history', 2)
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
      const request = indexedDB.open('comfyui-mcp-panel-history', 2)
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

async function seedReloadRace(
  page: import('@playwright/test').Page,
  currentThreadId: string
): Promise<void> {
  await page.evaluate(async ({ pointedId }) => {
    const future = Date.now() + 60_000
    const background = {
      id: 'newer-background-thread',
      schemaVersion: 2,
      workflowKey: 'workflow:background-race',
      createdAt: future - 100,
      updatedAt: future,
      ts: future,
      msgs: [{
        id: 'newer-background-message',
        role: 'user',
        text: 'newer background transcript',
        createdAt: future
      }]
    }
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
        threads: [...threads.filter((thread: any) => thread.id !== background.id), background],
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
      const request = indexedDB.open('comfyui-mcp-panel-history', 2)
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
  await seedReloadRace(page, currentThreadId!)

  await page.evaluate(() => localStorage.removeItem('comfyui-mcp.panel.autoConnect'))
  await page.reload()
  await panel.openSidebar()

  await expect(panel.userBubble('conversation selected by this tab')).toBeVisible()
  await expect(panel.userBubble('newer background transcript')).toHaveCount(0)
  await expect.poll(
    () => page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)
  ).toBe('live-tab-session')

  // Cross the settings-hydration boundary and the async IndexedDB load. Neither
  // is allowed to repaint another conversation or replace the live tab session.
  await page.waitForTimeout(3_000)
  await expect(panel.userBubble('conversation selected by this tab')).toBeVisible()
  await expect(panel.userBubble('newer background transcript')).toHaveCount(0)
  expect(await page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)).toBe('live-tab-session')
})
