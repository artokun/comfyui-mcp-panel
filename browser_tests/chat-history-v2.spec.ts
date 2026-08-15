import { test, expect } from './fixtures/panelTest'
import { resolveHistoryStoreModuleUrl } from './fixtures/historyStoreModule'
import { routeWorktreeSource } from './fixtures/worktreeSource'


const THREADS_KEY = 'comfyui-mcp.panel.threads'
const META_KEY = 'comfyui-mcp.panel.historyMeta'

test.beforeEach(async ({ context }) => {
  await routeWorktreeSource(context)
})

// mcp#884: the workflow/ask chat scopes are retired — chatScopeMode() is
// hard-wired to "panel". Every spec here runs the one shipping mode.

async function indexedThreadCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('comfyui-mcp-panel-history')
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
      const req = indexedDB.open('comfyui-mcp-panel-history')
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

// Panel scope keeps workflow PROVENANCE on every thread (archive grouping),
// and the unsaved-workflow durability path (#570) still stamps the stable
// per-instance UUID into graph.extra — silently, never via a dirty flag.
test('embeds a stable workflow UUID and records provider/model workflow snapshots', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

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

// mcp#884 (P0-2): a cold upgrade from a build that still had the workflow/ask
// scopes can leave a STALE panel:global pointer behind — the user switched to
// workflow mode long ago and kept conversing in per-workflow threads. With the
// tab-local pointer gone (browser restart) the hard-wired panel restoration
// must recover the conversation the user is actually in, not repaint the
// months-old pointer target over it.
test('a stale pre-upgrade panel pointer never restores over the current conversation', async ({
  page,
  panel
}) => {
  const staleAt = Date.now() - 45 * 24 * 60 * 60 * 1000
  const freshAt = Date.now() - 60 * 1000
  await page.addInitScript(({ threadsKey, metaKey, staleAt, freshAt }) => {
    // Pre-#884 storage shape: an old panel-mode thread whose panel:global
    // pointer was last stamped months ago, plus the per-workflow conversation
    // the user actually kept using after switching the (now removed) setting.
    localStorage.setItem(threadsKey, JSON.stringify([
      {
        id: 'stale-panel-thread',
        createdAt: staleAt,
        updatedAt: staleAt,
        ts: staleAt,
        workflowKey: 'panel:global',
        msgs: [{
          id: 'stale-panel-message',
          role: 'user',
          text: 'an old conversation from months ago',
          createdAt: staleAt
        }]
      },
      {
        id: 'current-workflow-thread',
        createdAt: freshAt,
        updatedAt: freshAt,
        ts: freshAt,
        workflowKey: 'workflow:wf-current',
        workflowTitle: 'Current Workflow',
        msgs: [{
          id: 'current-workflow-message',
          role: 'user',
          text: 'the conversation I am actually in',
          createdAt: freshAt
        }]
      }
    ]))
    // The retired workflow mode stamped a workflow-scoped selection op on
    // every thread creation/open, so a real pre-upgrade snapshot carries the
    // newer workflow selection alongside the abandoned panel pointer.
    localStorage.setItem(metaKey, JSON.stringify({
      updatedAt: freshAt,
      activeByScope: {
        'panel:global': 'stale-panel-thread',
        'workflow:wf-current': 'current-workflow-thread'
      },
      activeOps: {
        'panel:global': {
          value: 'stale-panel-thread',
          deleted: false,
          updatedAt: staleAt + 1,
          revision: { updatedAt: staleAt + 1, writerId: 'old-build', sequence: 1 }
        },
        'workflow:wf-current': {
          value: 'current-workflow-thread',
          deleted: false,
          updatedAt: freshAt,
          revision: { updatedAt: freshAt, writerId: 'old-build', sequence: 2 }
        }
      }
    }))
  }, { threadsKey: THREADS_KEY, metaKey: META_KEY, staleAt, freshAt })

  await panel.goto()
  await panel.openSidebar()

  // The stale pointer loses to the newer conversation activity.
  await expect(panel.userBubble('the conversation I am actually in')).toBeVisible()
  await expect(panel.userBubble('an old conversation from months ago')).toHaveCount(0)

  // The old panel-era chat is still an ordinary archive entry — visible and
  // OPENABLE (panel scope has no foreign-workflow lockout), and opening it is
  // a deliberate selection that repaints it.
  await panel.root.locator('button[title="Chat history"]').click()
  const staleRow = panel.root
    .locator('.cmcp-hist-row')
    .filter({ hasText: 'an old conversation from months ago' })
  await expect(staleRow).toBeVisible()
  await expect(staleRow.locator('.cmcp-hist-open')).toBeEnabled()
  await staleRow.locator('.cmcp-hist-open').click()
  await expect(panel.userBubble('an old conversation from months ago')).toBeVisible()
})
