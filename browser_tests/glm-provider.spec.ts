/**
 * Tier 1 — GLM (z.ai) provider chip.
 *
 * The orchestrator has a `glm` backend (the hosted z.ai coding plan —
 * api.z.ai/api/coding/paas/v4, key ZAI_API_KEY). This spec connects the panel to
 * a MockBridge, pushes the orchestrator's authoritative `backends` frame (claude +
 * glm, both ready) over the SAME bridge channel the real orchestrator uses
 * (createBridgeClient's onBackends, panel.js ~6453), and asserts the model popup's
 * Provider section renders glm's chip labeled "GLM (z.ai)" (BACKEND_LABELS) with
 * the hint "GLM · z.ai coding plan" (BACKEND_HINTS) — i.e. the backend id is a
 * KNOWN label the panel renders, not an unrecognized id that would fall through to
 * the raw "glm" string (or be dropped entirely, as it was before this change).
 *
 * GLM is a hosted API-key provider with no CLI (like Moonshot / Kimi K3): setup is
 * pasting a z.ai coding-plan key, not a CLI login. The handshake-backend ADOPTION
 * path (selecting the chip connects as glm without reverting to claude) is
 * exercised manually against a live orchestrator; here we pin the deterministic UI
 * wiring.
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

test('a ready GLM (z.ai) backend renders a "GLM (z.ai)" provider chip with its hint', async ({
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
    // so no auto-pick/switch fires) + a ready glm. The Provider section renders
    // only when >1 provider is known. Same {type:"backends"} frame the real
    // orchestrator sends post-hello; the panel ingests it via onBackends.
    bridge.send({
      type: 'backends',
      any_ready: true,
      backends: [
        { backend: 'claude', running: true, cli: true, auth: true, ready: true },
        { backend: 'glm', running: false, cli: true, auth: true, ready: true }
      ]
    })

    // Let the frame land (ingested synchronously by the ws onmessage handler), then
    // open the model popup and read glm's row FAST — capture label + full text in a
    // single pass before any reconnect can detach it.
    await panel.page.waitForTimeout(400)
    await panel.root.locator('.cmcp-chip').first().click()
    const glm = panel.root
      .locator('.cmcp-popover-item.cmcp-provider')
      .filter({ hasText: 'GLM (z.ai)' })
    await expect(glm).toHaveCount(1, { timeout: 8_000 })
    const [label, rowText] = await Promise.all([
      glm.locator('.lbl').textContent(),
      glm.textContent()
    ])
    // Exact label — reads "GLM (z.ai)", never the raw id. Proves glm is in
    // BACKEND_LABELS (the render allowlist), not an unknown/dropped id.
    expect(label?.trim()).toBe('GLM (z.ai)')
    // BACKEND_HINTS ("GLM · z.ai coding plan") wired through to the visible chip.
    expect(rowText).toContain('GLM · z.ai coding plan')
  } finally {
    await bridge.close()
  }
})
