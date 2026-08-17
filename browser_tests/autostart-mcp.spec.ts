import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { expect, test } from './fixtures/panelTest'

test.use({ panelAutostartMcp: true })

const REVIEWED_SOURCES = new Map([
  ['js/comfyui-mcp-panel.js', readFileSync(resolve('web/js/comfyui-mcp-panel.js'), 'utf8')],
  ['js/cmcp-modal.js', readFileSync(resolve('web/js/cmcp-modal.js'), 'utf8')],
  ['js/lib/mcp-autostart-policy.js', readFileSync(resolve('web/js/lib/mcp-autostart-policy.js'), 'utf8')],
  ['js/lib/provider-autoselect.js', readFileSync(resolve('web/js/lib/provider-autoselect.js'), 'utf8')],
])

test.beforeEach(async ({ context }) => {
  // The running ComfyUI may point at the main checkout. Serve every changed
  // module from this worktree so this gate cannot accidentally exercise stale JS.
  for (const [suffix, body] of REVIEWED_SOURCES) {
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await context.route(new RegExp(`/extensions/[^/]+/${escaped}(?:\\?.*)?$`), (route) =>
      route.fulfill({ contentType: 'text/javascript', body })
    )
  }
})

test('panel-open autostart asks the companion once and connects after MCP appears', async ({
  page,
  panel,
}) => {
  let bridgeRunning = false
  let startCalls = 0

  // These handlers are registered after the fixture's hermetic defaults and
  // therefore narrow this one spec to the autostart behavior under test.
  await page.route('**/comfyui_mcp_panel/status*', (route) =>
    route.fulfill({ json: { running: bridgeRunning } })
  )
  await page.route('**/comfyui_mcp_panel/launcher/start*', (route) => {
    startCalls += 1
    bridgeRunning = true
    return route.fulfill({ json: { ok: true, installed: true, running: true, started: true } })
  })
  await page.route('**/comfyui_mcp_panel/launcher/handshake*', (route) =>
    route.fulfill({ json: { ok: true, minimized: false } })
  )
  await panel.goto()
  // goto() seeds the historical sticky-connect key for older specs. Remove it
  // so this connection can only come from the new panel-open autostart path.
  await page.evaluate(() => localStorage.removeItem('comfyui-mcp.panel.autoConnect'))
  await panel.openSidebar()

  await expect.poll(() => startCalls).toBe(1)
  await expect.poll(() => panel.status()).toBe('connected')
})
