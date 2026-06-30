/**
 * Tier 1 — external/local orchestrator mode.
 *
 * Covers the "Use external/local orchestrator (advanced)" Settings toggle: when
 * ON, Connect must NOT ask the ComfyUI host to spawn an orchestrator (the host —
 * e.g. a remote RunPod pod — may have no Node/agent). Instead it dials the
 * configured Bridge URL directly. This is the path that lets an agent running on
 * the USER's machine (`npx -y comfyui-mcp connect <url>`) drive a remote ComfyUI.
 *
 * Asserts:
 *   1. clicking the real Connect button connects to the MockBridge (handshake →
 *      status pill "connected"), and
 *   2. the host spawn route `/comfyui_mcp_panel/connect` is NEVER POSTed.
 */
import { test, expect } from './fixtures/panelTest'

const CONNECT_ROUTE = '**/comfyui_mcp_panel/connect'
const EXTERNAL_SETTING = 'comfyui-mcp.externalOrchestrator'

test('external mode connects to the bridge WITHOUT a host /connect spawn', async ({
  panel,
  mockBridge
}) => {
  await panel.goto()
  // Point the panel at the MockBridge. In external mode this non-default URL is a
  // manual override, so Connect dials it straight (no host involvement).
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()

  // Turn ON the external/local orchestrator toggle via ComfyUI's settings store —
  // the same store the panel reads through getSetting().
  await panel.page.evaluate((id) => {
    const w = window as unknown as {
      comfyAPI?: { app?: { app?: { ui?: { settings?: { setSettingValue?: (k: string, v: unknown) => void } } } } }
      app?: { ui?: { settings?: { setSettingValue?: (k: string, v: unknown) => void } } }
    }
    const app = w.comfyAPI?.app?.app || w.app
    app?.ui?.settings?.setSettingValue?.(id, true)
  }, EXTERNAL_SETTING)

  // Guard: fail loudly if the panel POSTs the host spawn route. External mode must
  // never depend on the ComfyUI host starting anything.
  let connectPosts = 0
  await panel.page.route(CONNECT_ROUTE, async (route) => {
    if (route.request().method() === 'POST') connectPosts += 1
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"ok":false,"message":"external mode should not call this"}'
    })
  })

  // Click the REAL Connect button (whose default path would POST /connect) — in
  // external mode it must skip that and dial the Bridge URL directly.
  await panel.openConnectionSettings()
  await panel.connectButton.click()

  await expect(panel.statusPill).toContainText('connected')
  await expect(panel.statusDot).toHaveClass(/connected/)
  expect(connectPosts).toBe(0)
})
