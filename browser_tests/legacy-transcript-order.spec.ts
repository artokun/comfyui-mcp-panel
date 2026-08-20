/**
 * #1516 — after a hard refresh that crossed a panel version boundary, the user
 * reported "refreshing the page seems to have repeated my initial messages to
 * you". Nothing was re-sent to the agent; the CHAT PANE re-painted the stored
 * transcript out of order, dropping the earliest prompts below the agent's last
 * reply.
 *
 * A pre-0.11.0 panel (before IndexedDB and the atomic snapshot key existed)
 * wrote a bare array of threads under `comfyui-mcp.panel.threads`, and its
 * messages carried no id and no timestamp. The restore path merges its own
 * mount-time read of that array with the copy ChatHistoryStore.load() resolves
 * to, and the merge sorted timestamp-less records by their content-hash id.
 *
 * Measured against this exact seed before the fix:
 *
 *     stored   u1 a1 u2 a2 u3 a3
 *     painted  a3 u1 u2 a1 a2 u3
 *
 * This spec is deliberately agent-free and never sends a message: the defect is
 * in hydration, and seeding at document start is the only way to reproduce a
 * bundle-version boundary the harness cannot otherwise cross.
 */
import { test, expect } from './fixtures/panelTest'
import { routeWorktreeSource } from './fixtures/worktreeSource'

test.beforeEach(async ({ context }) => {
  await routeWorktreeSource(context)
})

const LEGACY_THREAD_ID = '11111111-2222-3333-4444-555555555555'
const USER_TEXTS = ['legacy first 1516', 'legacy second 1516', 'legacy third 1516']

test('#1516: a pre-0.11 transcript hydrates in the order it was written', async ({
  page,
  panel,
  context
}) => {
  // Seeded at document start, so the panel's synchronous restore reads exactly
  // what the older bundle left behind — no id, no createdAt, no ts, and a BARE
  // ARRAY under the pre-v3 key.
  await context.addInitScript(
    ({ threadId, texts }) => {
      const msgs: Array<Record<string, string>> = []
      texts.forEach((text: string, i: number) => {
        msgs.push({ role: 'user', text })
        msgs.push({ role: 'agent', text: `legacy reply ${i}` })
      })
      localStorage.removeItem('comfyui-mcp.panel.historySnapshot')
      localStorage.removeItem('comfyui-mcp.panel.historyMeta')
      localStorage.setItem(
        'comfyui-mcp.panel.threads',
        JSON.stringify([
          { id: threadId, ts: Date.now() - 60_000, workflowKey: 'panel:global', msgs }
        ])
      )
      sessionStorage.setItem('comfyui-mcp.panel.currentThreadId', threadId)
    },
    { threadId: LEGACY_THREAD_ID, texts: USER_TEXTS }
  )

  await panel.goto()
  await panel.openSidebar()
  await expect(panel.userBubble(USER_TEXTS[2])).toBeVisible()

  // Settle the async durable hydration: the synchronous paint-only pass reads the
  // shadow, and the merge that used to shuffle the transcript runs after
  // IndexedDB and settings resolve.
  await expect
    .poll(async () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.cmcp-root .cmcp-bubble')].map((el) =>
          (el as HTMLElement).innerText.trim().split('\n')[0]
        )
      )
    )
    .toEqual([
      'legacy first 1516',
      'legacy reply 0',
      'legacy second 1516',
      'legacy reply 1',
      'legacy third 1516',
      'legacy reply 2'
    ])

  // Each prompt appears ONCE. The reporter read the reshuffle as a repeat, so
  // assert the count too rather than only the order.
  for (const text of USER_TEXTS) {
    await expect(panel.userBubbles.filter({ hasText: text })).toHaveCount(1)
  }

  // What was painted is what got persisted: a second reload must not shuffle it
  // back, and the durable record must not keep the scrambled order either.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = localStorage.getItem('comfyui-mcp.panel.historySnapshot')
        if (!raw) return null
        const thread = JSON.parse(raw).threads.find(
          (t: { id: string }) => t.id === '11111111-2222-3333-4444-555555555555'
        )
        return thread ? thread.msgs.map((m: { text: string }) => m.text) : null
      })
    )
    .toEqual([
      'legacy first 1516',
      'legacy reply 0',
      'legacy second 1516',
      'legacy reply 1',
      'legacy third 1516',
      'legacy reply 2'
    ])
})
