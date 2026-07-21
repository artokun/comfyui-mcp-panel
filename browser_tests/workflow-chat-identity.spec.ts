import { test, expect } from './fixtures/panelTest'

const THREADS_KEY = 'comfyui-mcp.panel.threads'
const CURRENT_THREAD_KEY = 'comfyui-mcp.panel.currentThreadId'

test('embeds a workflow UUID and blocks a foreign transcript pointer', async ({
  page,
  panel,
  mockBridge
}) => {
  // Make the legacy per-workflow setting available before the panel mounts and
  // after reload; the shared fixture intentionally strips real user settings.
  await page.route(
    (url) => /\/(api\/)?settings\/?$/.test(url.pathname),
    async (route) => {
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

  await page.evaluate(({ threadsKey, currentThreadKey }) => {
    const threads = JSON.parse(localStorage.getItem(threadsKey) || '[]')
    threads.push({
      id: 'foreign-thread',
      ts: Date.now() + 10,
      workflowKey: 'workflow:definitely-another-workflow',
      msgs: [{ role: 'user', text: 'must never restore on this workflow' }]
    })
    localStorage.setItem(threadsKey, JSON.stringify(threads))
    sessionStorage.setItem(currentThreadKey, 'foreign-thread')
  }, { threadsKey: THREADS_KEY, currentThreadKey: CURRENT_THREAD_KEY })

  await page.reload()
  await panel.openSidebar()
  await expect(panel.userBubble('must never restore on this workflow')).toHaveCount(0)

  await panel.root.locator('button[title="Chat history"]').click()
  const foreign = panel.root.locator('.cmcp-hist-row').filter({ hasText: 'must never restore on this workflow' })
  await expect(foreign).toBeVisible()
  await expect(foreign.locator('.cmcp-hist-open')).toBeDisabled()
})
