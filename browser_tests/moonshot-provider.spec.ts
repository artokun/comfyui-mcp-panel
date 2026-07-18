/**
 * Tier 1 — Kimi K3 (Moonshot) provider chip.
 *
 * The orchestrator gained a `moonshot` backend (the hosted Moonshot platform —
 * api.moonshot.ai, model kimi-k3, key MOONSHOT_API_KEY). This spec connects the
 * panel to a MockBridge, pushes the orchestrator's authoritative `backends` frame
 * (claude + moonshot, both ready) over the SAME bridge channel the real
 * orchestrator uses (createBridgeClient's onBackends, panel.js ~6453), and asserts
 * the model popup's Provider section renders moonshot's chip labeled "Kimi K3"
 * (BACKEND_LABELS) with the hint "Kimi K3 · Moonshot" (BACKEND_HINTS) — i.e. the
 * new backend id is a KNOWN label the panel renders, not an unrecognized id that
 * would fall through to the raw "moonshot" string (or be dropped like `glm`).
 *
 * Distinct from the existing `kimi` chip (label "Kimi", a Kimi-CLI subscription):
 * Kimi K3 is the hosted Moonshot platform — an API-key provider with no CLI. The
 * handshake-backend ADOPTION path (selecting the chip connects as moonshot without
 * reverting to claude) is exercised manually against a live orchestrator; here we
 * pin the deterministic UI wiring.
 *
 * HARNESS NOTE: the panel can double-mount under a test harness → a documented
 * "reconnect storm" (two clients, same tab_id — panel.js ~7674) that resets
 * knownBackends and detaches the popup after ~1s. connect.spec.ts beats it by being
 * fast; so do we — connect, advertise, then open + read the row in a single fast
 * pass. Spec-level retries reload the page to dodge a load that storms early.
 */
import { test, expect } from './fixtures/panelTest'
import { MockBridge } from './fixtures/MockBridge'

test.describe.configure({ retries: 2 })

test('a ready Kimi K3 (moonshot) backend renders a "Kimi K3" provider chip with its hint', async ({
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
    // so no auto-pick/switch fires) + a ready moonshot. The Provider section renders
    // only when >1 provider is known. Same {type:"backends"} frame the real
    // orchestrator sends post-hello; the panel ingests it via onBackends.
    bridge.send({
      type: 'backends',
      any_ready: true,
      backends: [
        { backend: 'claude', running: true, cli: true, auth: true, ready: true },
        { backend: 'moonshot', running: false, cli: true, auth: true, ready: true }
      ]
    })

    // Let the frame land (ingested synchronously by the ws onmessage handler), then
    // open the model popup and read moonshot's row FAST — capture label + full text
    // in a single pass before any reconnect can detach it.
    await panel.page.waitForTimeout(400)
    await panel.root.locator('.cmcp-chip').first().click()
    const kimiK3 = panel.root
      .locator('.cmcp-popover-item.cmcp-provider')
      .filter({ hasText: 'Kimi K3' })
    await expect(kimiK3).toHaveCount(1, { timeout: 8_000 })
    const [label, rowText] = await Promise.all([
      kimiK3.locator('.lbl').textContent(),
      kimiK3.textContent()
    ])
    // Exact label — reads "Kimi K3", never "Moonshot"/"Kimi"/the raw id. Proves
    // moonshot is in BACKEND_LABELS (the render allowlist), not an unknown id.
    expect(label?.trim()).toBe('Kimi K3')
    // BACKEND_HINTS ("Kimi K3 · Moonshot") wired through to the visible chip.
    expect(rowText).toContain('Kimi K3 · Moonshot')
  } finally {
    await bridge.close()
  }
})
