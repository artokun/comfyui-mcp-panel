/**
 * Tier 1 — pending queue drains.
 *
 * While a turn is in flight (the bridge emitted turn:working and is withholding
 * the result), a second message must QUEUE in the pending tray rather than paint
 * inline. When the agent dequeues it (a "seen" ack) the message materializes in
 * the chat and leaves the tray.
 *
 * The panel only queues when its internal `agentWorking` flag is set, which
 * happens solely on a turn:working frame. We confirm the panel processed that
 * frame by polling the sessionStorage marker the working-turn handler writes
 * (comfyui-mcp.panel.midTaskResume) before sending the second message — avoiding
 * a race where the 2nd send would otherwise be treated as an idle (inline) send.
 */
import { test, expect } from './fixtures/panelTest'

const MID_TASK_KEY = 'comfyui-mcp.panel.midTaskResume'

test('queues a message during a working turn, then drains it on dequeue', async ({
  panel,
  page,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  // First message — sent while idle, so it paints inline immediately.
  const first = mockBridge.waitForUserMessage()
  await panel.sendMessage('first message')
  await first

  // A turn is now in flight and its result is withheld.
  mockBridge.emitWorking()
  await expect
    .poll(() => page.evaluate((k) => sessionStorage.getItem(k), MID_TASK_KEY))
    .toBe('1')

  // Second message — must queue (turn busy), not paint inline.
  const second = mockBridge.waitForUserMessage()
  await panel.sendMessage('second queued message')
  const secondMsg = await second
  expect(secondMsg.mid).toBeTruthy()

  await expect(panel.pendingTray).toBeVisible()
  await expect(panel.pendingItems).toHaveCount(1)
  await expect(panel.pendingTray).toContainText('Pending · 1')
  // Queued: no inline user bubble for it yet.
  await expect(panel.userBubble('second queued message')).toHaveCount(0)

  // The agent dequeues it — it materializes in the chat and leaves the tray.
  mockBridge.markSeen(secondMsg.mid!)
  mockBridge.turnDone()

  await expect(panel.pendingItems).toHaveCount(0)
  await expect(panel.userBubble('second queued message')).toBeVisible()
})
