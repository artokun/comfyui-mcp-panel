/**
 * Shared Playwright fixtures for the Agent panel Tier 1 suite.
 *
 * Provides:
 *   - `mockBridge`: a started MockBridge on an OS-assigned free port, auto-closed
 *     after each test.
 *   - `panel`: a PanelPage bound to the test's page.
 *
 * A typical spec: point the panel at `mockBridge.url`, open the sidebar, connect,
 * then drive the conversation via the MockBridge helpers.
 */
import { test as base } from '@playwright/test'

import { MockBridge } from './MockBridge'
import { PanelPage } from './PanelPage'

interface PanelFixtures {
  mockBridge: MockBridge
  panel: PanelPage
}

export const test = base.extend<PanelFixtures>({
  mockBridge: async ({}, use) => {
    const bridge = new MockBridge({ port: 0 })
    await bridge.start()
    await use(bridge)
    await bridge.close()
  },
  panel: async ({ page }, use) => {
    // Hermetic runs on a dev box with a REAL orchestrator listening on :9180:
    // the panel's mount probe (GET /comfyui_mcp_panel/status → { running: true })
    // would auto-connect it to the live agent before the spec's setBridgeUrl()
    // override applies — the real greeting then pollutes the transcript and the
    // MockBridge never sees the session. Stub the discovery routes so every spec
    // sees "no orchestrator"; connection goes only where the spec points it.
    await page.route('**/comfyui_mcp_panel/status*', (route) =>
      route.fulfill({ json: { running: false } })
    )
    await page.route('**/comfyui_mcp_panel/backends*', (route) =>
      route.fulfill({ json: { backends: [] } })
    )
    await page.route('**/comfyui_mcp_panel/bridge_url*', (route) =>
      route.fulfill({ json: { url: null } })
    )
    // Panel-setting WRITES must never reach the real server: Reconnect mirrors
    // the (per-test, throwaway) mock URL into `comfyui-mcp.bridgeUrl.single`,
    // which would poison the developer's live panel with a dead port after the
    // suite exits. Swallow them; the panel treats the write as fire-and-forget.
    await page.route(
      (url) => /\/(api\/)?settings\/comfyui-mcp\./.test(url.pathname),
      (route) =>
        route.request().method() === 'GET'
          ? route.continue()
          : route.fulfill({ status: 200, json: {} })
    )
    // Same hermeticity for SERVER-STORED user settings: a dev box that uses the
    // panel daily has `comfyui-mcp.autoConnect: true` (+ a saved bridge URL) in
    // ComfyUI's /settings store, which auto-connects the panel to the live
    // orchestrator on mount even in a fresh browser profile. Strip the panel's
    // keys from the settings payload; everything else passes through untouched.
    await page.route(
      (url) => /\/(api\/)?settings\/?$/.test(url.pathname),
      async (route) => {
        if (route.request().method() !== 'GET') return route.continue()
        const res = await route.fetch()
        let body: Record<string, unknown>
        try {
          body = await res.json()
        } catch {
          return route.fulfill({ response: res })
        }
        for (const key of Object.keys(body)) {
          if (key.startsWith('comfyui-mcp.')) delete body[key]
        }
        return route.fulfill({ response: res, json: body })
      }
    )
    await use(new PanelPage(page))
  }
})

export { expect } from '@playwright/test'
