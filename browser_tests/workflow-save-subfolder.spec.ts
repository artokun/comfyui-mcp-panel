import { test, expect } from './fixtures/panelTest'
import { routeWorktreeSource } from './fixtures/worktreeSource'

test.beforeEach(async ({ context }) => {
  await routeWorktreeSource(context)
})

async function readWorkflow(page: import('@playwright/test').Page, path: string) {
  return page.evaluate(async (workflowPath) => {
    const api = (window as any).comfyAPI?.api?.api
    if (typeof api?.fetchApi !== 'function') throw new Error('ComfyUI API unavailable')
    const response = await api.fetchApi(`/userdata/${encodeURIComponent(workflowPath)}`)
    return {
      status: response?.status ?? null,
      body: response?.ok ? await response.json() : null
    }
  }, path)
}

test('#1794 nested first-save and Save-As use the production panel command path', async ({
  page,
  panel,
  mockBridge
}) => {
  test.setTimeout(120_000)
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  const suffix = Date.now()
  const subfolder = `cmcp-e2e-1794-${suffix}/nested`
  const firstName = `cmcp-e2e-1794-first-${suffix}`
  const copyName = `cmcp-e2e-1794-copy-${suffix}`
  const firstPath = `workflows/${subfolder}/${firstName}.json`
  const copyPath = `workflows/${subfolder}/${copyName}.json`
  const writes: string[] = []
  page.on('request', (request) => {
    try {
      const url = new URL(request.url())
      if (request.method() === 'POST' && url.pathname.includes('/api/userdata/')) writes.push(url.pathname)
    } catch {
      // Request bookkeeping must not affect the production call under test.
    }
  })

  const added = await mockBridge.command('graph_add_node', { class_type: 'VAEDecode' })
  expect(added.ok, `setup graph edit must succeed: ${added.error || ''}`).toBe(true)

  const first = await mockBridge.command('workflow_save', { name: firstName, subfolder })
  expect(first.ok, `nested first-save must succeed: ${first.error || ''}`).toBe(true)
  expect(first.result?.workflow).toBe(firstName)

  const firstOnDisk = await readWorkflow(page, firstPath)
  expect(firstOnDisk.status).toBe(200)
  const originalBody = firstOnDisk.body

  const edited = await mockBridge.command('graph_add_node', { class_type: 'VAEDecode' })
  expect(edited.ok, `source edit before Save-As must succeed: ${edited.error || ''}`).toBe(true)

  const copied = await mockBridge.command('workflow_save', { name: copyName, subfolder })
  expect(copied.ok, `nested Save-As must succeed: ${copied.error || ''}`).toBe(true)
  expect(copied.result?.saved_as).toBe(true)

  const sourceAfterCopy = await readWorkflow(page, firstPath)
  const copyOnDisk = await readWorkflow(page, copyPath)
  expect(sourceAfterCopy.status).toBe(200)
  expect(sourceAfterCopy.body).toEqual(originalBody)
  expect(copyOnDisk.status).toBe(200)
  expect(copyOnDisk.body?.nodes?.length).toBeGreaterThan(originalBody?.nodes?.length ?? 0)
  expect(writes).toHaveLength(2)
})

test('#1794 refuses traversal, absolute/UNC/drive destinations and slashed names without writes', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  const writes: string[] = []
  page.on('request', (request) => {
    try {
      const url = new URL(request.url())
      if (request.method() === 'POST' && url.pathname.includes('/api/userdata/')) writes.push(url.pathname)
    } catch {
      // Request bookkeeping must not affect the production call under test.
    }
  })

  const refused = ['../escape', '/absolute', '\\server\\share', 'C:\\workflows', 'nested//empty', 'nested/./dot']
  for (const subfolder of refused) {
    const result = await mockBridge.command('workflow_save', {
      name: `cmcp-e2e-1794-refused-${Date.now()}`,
      subfolder
    })
    expect(result.ok, `unsafe subfolder must be refused: ${subfolder}`).toBe(false)
    expect(result.error).toMatch(/subfolder|relative|unsafe|empty|dot|traversal|absolute|UNC|drive/i)
  }

  const slashedName = await mockBridge.command('workflow_save', {
    name: 'workflow/with-slash',
    subfolder: 'cmcp-e2e-1794-safe'
  })
  expect(slashedName.ok).toBe(false)
  expect(slashedName.error).toMatch(/path separator|1721/i)
  expect(writes).toHaveLength(0)
})
