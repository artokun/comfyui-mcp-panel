/**
 * Tier 1 — the working indicator survives the 120s safety deadline.
 *
 * Regression for issue #132: `THINKING_SAFETY_MS` (120s) unconditionally hid the
 * working/thinking indicator when it fired, so a long SILENT Codex turn (tools
 * running, no user-visible text) looked like it had ended after ~2 minutes even
 * though the orchestrator still owned the turn. Newly typed messages then queued
 * against a composer that appeared idle.
 *
 * Uses the Playwright clock to jump past the old 121s deadline and asserts:
 *   1. an `action` frame surfaces the current operation on the indicator;
 *   2. the indicator is STILL visible (and still shows the action) after 130s of
 *      silence, because the turn is still authoritative (`agentWorking`);
 *   3. it disappears only after an authoritative terminal frame (`turn: done`).
 *
 * The clock is installed AFTER connect so ComfyUI's own load timers run on real
 * time; only the indicator's safety/word timers (armed on `turn: working`) are
 * faked, which is all this test advances.
 */
import { test, expect } from './fixtures/panelTest'

test('keeps the working indicator alive past the 120s safety timeout while a turn runs', async ({
  panel,
  mockBridge,
  page
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  // Fake time only from here — the indicator's timers are armed on turn:working.
  await page.clock.install()

  const thinking = page.locator('.cmcp-root .cmcp-thinking')

  // A turn begins and runs a silent tool — no say/stream frames arrive.
  mockBridge.startTurn()
  await expect(thinking).toBeVisible()

  // An `action` frame names the current operation → live label on the indicator.
  mockBridge.send({ type: 'action', name: 'panel.panel_query_graph' })
  await expect(thinking).toContainText('query graph')

  // Jump PAST the old 121s deadline. Pre-fix, armSafety() → hideThinking() here.
  await page.clock.fastForward(130_000)

  // Still running → still visible, still showing what it's doing.
  await expect(thinking).toBeVisible()
  await expect(thinking).toContainText('query graph')

  // Only an authoritative terminal frame clears it.
  mockBridge.turnDone()
  await expect(thinking).toBeHidden()
})
