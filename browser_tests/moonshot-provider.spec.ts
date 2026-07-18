/**
 * Tier 1 — Kimi K3 (Moonshot) provider chip.
 *
 * The orchestrator gained a `moonshot` backend (the hosted Moonshot platform —
 * api.moonshot.ai, model kimi-k3, key MOONSHOT_API_KEY). This spec advertises a
 * READY `moonshot` backend over the discovery route AND has the MockBridge report
 * `backend:"moonshot"` on the handshake, then asserts:
 *   1. the panel ADOPTS moonshot as the connected backend — it's a known backend
 *      label, so it must NOT silently revert to claude (the CRITICAL allowlist),
 *      and
 *   2. the model popup's Provider section renders its chip with the label
 *      "Kimi K3" (BACKEND_LABELS), the hint "Kimi K3 · Moonshot" (BACKEND_HINTS),
 *      and marks it the active/selected provider.
 *
 * Distinct from the existing `kimi` chip (label "Kimi", a Kimi-CLI subscription):
 * Kimi K3 is the hosted Moonshot platform — an API-key provider with no CLI.
 */
import { test, expect } from './fixtures/panelTest'
import { MockBridge } from './fixtures/MockBridge'

test('advertises a ready Kimi K3 (moonshot) backend → chip renders as "Kimi K3" and is selectable', async ({
  panel
}) => {
  const bridge = new MockBridge({
    backend: 'moonshot',
    models: [{ id: 'kimi-k3', label: 'Kimi K3', small: 'Moonshot' }],
    greeting: 'Kimi K3 ready.'
  })
  await bridge.start()
  try {
    // Advertise a READY moonshot backend over the discovery route (plus a ready
    // claude, so the popup's Provider section — shown only when >1 provider is
    // known — renders). Registered before goto() so mount-time discovery sees it;
    // this overrides the fixture's empty-backends stub (the last route wins).
    await panel.page.route('**/comfyui_mcp_panel/backends*', (route) =>
      route.fulfill({
        json: {
          any_ready: true,
          backends: [
            {
              backend: 'moonshot',
              running: true,
              cli: true,
              auth: true,
              ready: true
            },
            {
              backend: 'claude',
              running: false,
              cli: true,
              auth: true,
              ready: true
            }
          ]
        }
      })
    )

    await panel.goto()
    await panel.setBridgeUrl(bridge.url)
    await panel.openSidebar()
    await panel.connect()

    // The handshake advertised backend:"moonshot" — a KNOWN backend label, so the
    // panel adopts it as connected rather than falling back to claude.
    await expect(panel.statusPill).toContainText('connected')

    // The connection popover may still be open from connect() — close it so it
    // can't overlay the composer's model chip.
    if (await panel.connectionPopover.isVisible().catch(() => false)) {
      await panel.statusPill.click()
      await panel.connectionPopover
        .waitFor({ state: 'hidden' })
        .catch(() => {})
    }

    // Open the model popup and locate the Kimi K3 provider row. Only moonshot and
    // claude are advertised, and only moonshot's row carries "Kimi K3".
    await panel.root.locator('.cmcp-chip').click()
    const kimiK3 = panel.root
      .locator('.cmcp-popover-item.cmcp-provider')
      .filter({ hasText: 'Kimi K3' })

    await expect(kimiK3).toHaveCount(1)
    // Exact label — the chip reads "Kimi K3", never "Moonshot" or "Kimi".
    await expect(kimiK3.locator('.lbl')).toHaveText('Kimi K3')
    // BACKEND_HINTS wired through to the visible chip.
    await expect(kimiK3).toContainText('Kimi K3 · Moonshot')
    // Selectable + connected: moonshot is the ACTIVE provider (marked .sel),
    // proving the chip is a real, non-reverting selection — not a claude fallback.
    await expect(kimiK3).toHaveClass(/\bsel\b/)
  } finally {
    await bridge.close()
  }
})
