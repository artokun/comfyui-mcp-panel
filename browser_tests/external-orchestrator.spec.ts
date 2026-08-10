/**
 * Tier 1 — external/local orchestrator mode.
 *
 * NOT a mode test any more. `externalOrchestratorMode()` returns `true`
 * unconditionally — the pack is pure-frontend and can no longer spawn anything
 * (Comfy Registry security standards), so the "external/local orchestrator
 * (advanced)" setting is a back-compat NO-OP. Flipping it to `false` was measured
 * here and changes nothing: the spec passes either way.
 *
 * What it still pins, and the reason to keep it: the pure-frontend pack must NEVER
 * ask the ComfyUI host to spawn an orchestrator (a remote pod may have no Node,
 * and the stripped node answers /connect with 503). So this is a regression guard
 * on a PERMANENT invariant, not a branch test — `connectPosts === 0` cannot fail
 * today, and it exists to fail the day someone reintroduces host spawning.
 *
 * The load-bearing assertion is therefore the OTHER one: clicking the real Connect
 * button reaches a real handshake with the MockBridge at the CONFIGURED url.
 * That one is a true regression test — removing the url write in step (4) turns
 * this red (measured: it dialled the default ws://127.0.0.1:9180 instead).
 */
import { test, expect } from './fixtures/panelTest'

const CONNECT_ROUTE = '**/comfyui_mcp_panel/connect'
const EXTERNAL_SETTING = 'comfyui-mcp.externalOrchestrator'

test('external mode connects to the bridge WITHOUT a host /connect spawn', async ({
  panel,
  mockBridge
}) => {
  await panel.goto()
  // NB: panel.setBridgeUrl() is deliberately NOT used here. It only records a
  // PENDING url that panel.connect() applies via Advanced + Reconnect; this spec
  // clicks the real **Connect** button instead (that is the behaviour under test),
  // so the pending url would never be applied. See step 4 below.

  // EVERYTHING that shapes the connect decision must be in place BEFORE the panel
  // mounts (openSidebar), otherwise the panel can auto-connect during mount and
  // POST /connect before the guard below exists — silently MISSING the very
  // host-spawn behavior this test forbids.

  // 1) Truly disable sticky auto-connect. goto() writes "0", but the panel's
  //    lsGet() returns the raw string and treats ANY non-null value as truthy —
  //    so "0" would still fire a mount-time connectAgent(). Remove the key so the
  //    panel sits idle on mount and the explicit Connect click below is the ONLY
  //    connect attempt.
  await panel.page.evaluate(() => {
    try {
      localStorage.removeItem('comfyui-mcp.panel.autoConnect')
    } catch {
      // storage disabled — nothing persisted to auto-connect from anyway.
    }
  })

  // 2) Set the external toggle anyway, for the day it stops being a no-op. It is
  //    INERT today (externalOrchestratorMode() is a hardcoded `return true`), and
  //    a pre-mount settings write is clobbered at mount regardless — see step 4.
  //    Nothing in this spec depends on it.
  // 3) Install the host-spawn guard/spy. External mode must never depend on the
  //    ComfyUI host starting anything, so fail loudly if the panel POSTs /connect —
  //    installed BEFORE mount so even a stray mount-time connect would be caught.
  let connectPosts = 0
  await panel.page.route(CONNECT_ROUTE, async (route) => {
    if (route.request().method() === 'POST') connectPosts += 1
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"ok":false,"message":"external mode should not call this"}'
    })
  })

  // 4) The bridge URL is configured AFTER mount, just before the click — see the
  //    block below. It is the one piece of setup that must NOT be pre-mount.
  // Now mount the panel — external mode on, auto-connect off, guard armed.
  await panel.openSidebar()

  //    …and re-apply it AFTER mount. The pre-mount write above is clobbered when
  //    the panel registers its own settings during mount: reading it back at that
  //    point returned the DEFAULT `ws://127.0.0.1:9180`, which is exactly what this
  //    spec was dialling. Auto-connect was removed in (1), so the panel sits idle
  //    here and this write lands before the only connect attempt.
  await panel.page.evaluate(([id, u]) => {
    const w = window as unknown as {
      comfyAPI?: { app?: { app?: { ui?: { settings?: { setSettingValue?: (k: string, v: unknown) => void } } } } }
      app?: { ui?: { settings?: { setSettingValue?: (k: string, v: unknown) => void } } }
    }
    const app = w.comfyAPI?.app?.app || w.app
    app?.ui?.settings?.setSettingValue?.(id, u)
  }, ['comfyui-mcp.bridgeUrl.single', mockBridge.url])

  // Click the REAL Connect button (whose default path would POST /connect) — in
  // external mode it must skip that and dial the Bridge URL directly.
  await panel.openConnectionSettings()
  await panel.connectButton.click()
  await expect(panel.statusPill).toContainText('connected')
  await expect(panel.statusDot).toHaveClass(/connected/)
  expect(connectPosts).toBe(0)
})
