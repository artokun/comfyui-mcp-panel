/**
 * Tier 1 — connect handshake.
 *
 * Points the panel at the MockBridge, connects, and asserts:
 *   1. the status pill flips to "connected" (only the `models` handshake frame
 *      does this — proving the panel saw a real-shaped handshake), and
 *   2. the greeting `say` renders as an agent bubble.
 */
import { test, expect } from './fixtures/panelTest'

test('connects to the bridge and renders the ready greeting', async ({
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()

  await panel.connect()

  await expect(panel.statusPill).toContainText('connected')
  await expect(panel.statusDot).toHaveClass(/connected/)
  await expect(panel.agentBubbles.last()).toContainText('Panel agent ready')
})
