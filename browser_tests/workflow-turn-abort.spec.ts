// #1810 — drive panel_new_workflow through the live panel/MockBridge lifecycle.
// The unit regression covers the retired dedicated-chat branch; this test proves the
// shipped panel path does not create a session rebind or a synthetic resume turn while
// the calling agent turn is still working.
import { test, expect } from './fixtures/panelTest'
import { MockBridge } from './fixtures/MockBridge'

test('panel_new_workflow during an in-flight turn keeps the calling chat and emits no false resume', async ({
  panel,
  page
}) => {
  // The dedicated branch is provider-owned in production: use a real Grok
  // handshake so this browser test cannot pass with a forced followsPanel=false
  // test seam or the default panel-owned Claude state.
  const grokBridge = await new MockBridge({ backend: 'grok' }).start()
  try {
    await panel.goto()
    await panel.setBridgeUrl(grokBridge.url)
    await panel.openSidebar()
    await panel.connect()

    const frames: Record<string, unknown>[] = []
    const off = grokBridge.onFrame((frame) => frames.push(frame))
    try {
      grokBridge.startTurn()
      await expect(page.locator('.cmcp-root .cmcp-thinking')).toBeVisible()

      const before = frames.length
      const created = await grokBridge.command('workflow_new')
      expect(created.ok).toBe(true)

      // The production workflow poll is 600ms. MockBridge answers the re-hello with
      // ready while the original turn is still live, which is the false-nudge seam.
      await page.waitForTimeout(900)
      const duringSwitch = frames.slice(before)
      expect(duringSwitch.some((frame) => frame.type === 'hello')).toBe(true)
      expect(duringSwitch.some((frame) => frame.type === 'resume_session' || frame.type === 'new_session')).toBe(false)
      expect(duringSwitch.some((frame) => frame.type === 'user_message')).toBe(false)

      grokBridge.turnDone()
      await expect(page.locator('.cmcp-root .cmcp-thinking')).toBeHidden()
      await expect(page.locator('.cmcp-root')).toContainText('Switched workflow tab', { timeout: 5_000 })
    } finally {
      off()
    }
  } finally {
    await grokBridge.close()
  }
})
