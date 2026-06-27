/**
 * Tier 1 — hidden/background-tab streaming regression (commit 23a88ad).
 *
 * THE BUG: the panel's streaming typewriter (pumpStreams) runs on
 * requestAnimationFrame. Browsers PAUSE rAF in a hidden/background tab, so a
 * reply that committed while the user was on another tab would never paint — the
 * agent bubble sat empty with a stuck cursor ("stuck thinking / never drains").
 *
 * THE FIX: commitStream() checks `document.hidden` and, when hidden, renders the
 * final text SYNCHRONOUSLY (finalizeStream) instead of waiting for an rAF tick
 * that will not come.
 *
 * WHAT THIS TEST ASSERTS: with the tab reporting hidden, a streamed reply still
 * lands in the agent bubble.
 *
 * LIMITATION / WHY WE ALSO NEUTER rAF: headless Chromium does not reliably pause
 * requestAnimationFrame just because we spoof document.hidden — so spoofing
 * visibility alone would pass even against the OLD (buggy) code. To make this a
 * REAL regression test we additionally replace requestAnimationFrame with a
 * no-op, deterministically reproducing the "rAF never fires" condition a true
 * background tab creates. Under that condition only the synchronous hidden-path
 * (the fix) can paint the reply; the pre-fix rAF-only path would leave the bubble
 * empty and this test would fail.
 */
import { test, expect } from './fixtures/panelTest'

test('renders a streamed reply while the tab is hidden (rAF paused)', async ({
  panel,
  page,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  // Simulate a hidden tab with paused rAF: spoof visibility AND stop rAF from
  // ever firing, so only the synchronous hidden-path can render the reply.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden'
    })
    window.requestAnimationFrame = (() => 0) as typeof window.requestAnimationFrame
    document.dispatchEvent(new Event('visibilitychange'))
  })

  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('reply while hidden')
  await received

  mockBridge.replyStreamed('hidden tab reply text')

  await expect(panel.agentBubbles.last()).toContainText('hidden tab reply text')
})
