/**
 * Tier 1 — streamed reply renders.
 *
 * Sends a message, then has the MockBridge emit a full streamed reply
 * (stream/text -> say/streamed -> stream/end -> turn/done). Asserts the last
 * agent bubble actually shows the streamed text — i.e. the typewriter caught up
 * and the committed `say` reconciled with its live preview, instead of leaving
 * an empty bubble with a stuck cursor.
 */
import { test, expect } from './fixtures/panelTest'

test('renders a streamed agent reply into the last agent bubble', async ({
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('say hello')
  const msg = await received
  expect(msg.text).toContain('say hello')

  mockBridge.replyStreamed('hello world')

  await expect(panel.agentBubbles.last()).toContainText('hello world')
})
