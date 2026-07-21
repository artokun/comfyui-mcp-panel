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
