/**
 * Tier 1 — MiniMax provider chip.
 *
 * The orchestrator gained a `minimax` backend (the hosted MiniMax platform —
 * api.minimax.io, model MiniMax-M3, key MINIMAX_API_KEY). This spec connects the
 * panel to a MockBridge, pushes the orchestrator's authoritative `backends` frame
 * (claude + minimax, both ready) over the SAME bridge channel the real
 * orchestrator uses (createBridgeClient's onBackends), and asserts the model
 * popup's Provider section renders minimax's chip labeled "MiniMax"
 * (BACKEND_LABELS) with the hint "MiniMax M3 · 1M context" (BACKEND_HINTS) — i.e.
 * the new backend id is a KNOWN label the panel renders, not an unrecognized id
 * that would fall through to the raw "minimax" string (or be dropped).
 *
 * MiniMax is a hosted API-key provider with no CLI (same shape as GLM / Kimi K3).
 * The handshake-backend ADOPTION path (selecting the chip connects as minimax
 * without reverting to claude) is exercised manually against a live orchestrator;
 * here we pin the deterministic UI wiring.
 *
 * HARNESS NOTE: the panel can double-mount under a test harness → a documented
 * "reconnect storm" (two clients, same tab_id) that resets knownBackends and
 * detaches the popup after ~1s. connect.spec.ts beats it by being fast; so do we —
 * connect, advertise, then open + read the row in a single fast pass. Spec-level
 * retries reload the page to dodge a load that storms early.
 */
import { test, expect } from './fixtures/panelTest'
import { MockBridge } from './fixtures/MockBridge'

test.describe.configure({ retries: 2 })

test('a ready MiniMax backend renders a "MiniMax" provider chip with its hint', async ({
  panel
}) => {
  const bridge = new MockBridge({ greeting: 'Panel agent ready.' })
  await bridge.start()
  try {
    // Standard proven connect path (connect.spec.ts).
    await panel.goto()
    await panel.setBridgeUrl(bridge.url)
    await panel.openSidebar()
    await panel.connect()
    await expect(panel.statusPill).toContainText('connected')

    // The authoritative readiness frame: claude (the connected, selected backend —
    // so no auto-pick/switch fires) + a ready minimax. The Provider section renders
    // only when >1 provider is known. Same {type:"backends"} frame the real
    // orchestrator sends post-hello; the panel ingests it via onBackends.
    bridge.send({
      type: 'backends',
      any_ready: true,
      backends: [
        { backend: 'claude', running: true, cli: true, auth: true, ready: true },
        { backend: 'minimax', running: false, cli: true, auth: true, ready: true }
      ]
    })

    // Let the frame land (ingested synchronously by the ws onmessage handler), then
    // open the model popup and read minimax's row FAST — capture label + full text
    // in a single pass before any reconnect can detach it.
    await panel.page.waitForTimeout(400)
    await panel.root.locator('.cmcp-chip').first().click()
    const minimax = panel.root
      .locator('.cmcp-popover-item.cmcp-provider')
      .filter({ hasText: 'MiniMax' })
    await expect(minimax).toHaveCount(1, { timeout: 8_000 })
    const [label, rowText] = await Promise.all([
      minimax.locator('.lbl').textContent(),
      minimax.textContent()
    ])
    // Exact label — reads "MiniMax", never the raw id. Proves minimax is in
    // BACKEND_LABELS (the render allowlist), not an unknown id.
    expect(label?.trim()).toBe('MiniMax')
    // BACKEND_HINTS ("MiniMax M3 · 1M context") wired through to the visible chip.
    expect(rowText).toContain('MiniMax M3 · 1M context')
  } finally {
    await bridge.close()
  }
})
