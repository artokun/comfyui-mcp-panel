import { test, expect } from './fixtures/panelTest'
import { MockBridge } from './fixtures/MockBridge'
import { PanelPage } from './fixtures/PanelPage'
import { resolveHistoryStoreModuleUrl } from './fixtures/historyStoreModule'
import { routeWorktreeSource } from './fixtures/worktreeSource'

const THREADS_KEY = 'comfyui-mcp.panel.threads'
const CURRENT_THREAD_KEY = 'comfyui-mcp.panel.currentThreadId'

test.beforeEach(async ({ context }) => {
  await routeWorktreeSource(context)
})

// mcp#884: the workflow/ask chat scopes are retired — chatScopeMode() is
// hard-wired to "panel", so these specs exercise the one shipping mode. The
// retired workflow scope used to embed a UUID into graph.extra on first
// record; panel scope resolves workflow PROVENANCE for the thread without
// writing to the graph at all — and, as before, without ever dirtying it.
test('opening a workflow does not dirty it and first record keeps provenance off-graph', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await page.waitForFunction(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    return !!app?.graph && !!app?.extensionManager?.workflow?.activeWorkflow
  })
  const before = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const graph = app.graph
    const workflow = app.extensionManager?.workflow?.activeWorkflow
    if (graph.extra?.comfyui_mcp) delete graph.extra.comfyui_mcp
    w.__cmcpIdentityMutationCalls = { before: 0, after: 0, dirty: 0 }
    const originalBefore = graph.beforeChange?.bind(graph)
    const originalAfter = graph.afterChange?.bind(graph)
    const originalDirty = graph.setDirtyCanvas?.bind(graph)
    graph.beforeChange = (...args: unknown[]) => {
      w.__cmcpIdentityMutationCalls.before++
      return originalBefore?.(...args)
    }
    graph.afterChange = (...args: unknown[]) => {
      w.__cmcpIdentityMutationCalls.after++
      return originalAfter?.(...args)
    }
    graph.setDirtyCanvas = (...args: unknown[]) => {
      w.__cmcpIdentityMutationCalls.dirty++
      return originalDirty?.(...args)
    }
    return { isModified: workflow?.isModified ?? null }
  })

  await panel.openSidebar()
  await page.waitForTimeout(700)
  const opened = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    const workflow = app.extensionManager?.workflow?.activeWorkflow
    return {
      isModified: workflow?.isModified ?? null,
      calls: w.__cmcpIdentityMutationCalls
    }
  })
  expect(opened.isModified).toBe(before.isModified)
  expect(opened.calls).toEqual({ before: 0, after: 0, dirty: 0 })

  await panel.setBridgeUrl(mockBridge.url)
  await panel.connect()
  // The greeting record resolves this workflow's identity as thread
  // provenance (history metadata) without re-stamping the deleted graph tag.
  //
  // mcp#884 — this replaces main's #847 "save first, THEN assert the embed"
  // block. That block existed to make the embed assertion reachable on an
  // unsaved canvas, and it ran under `setWorkflowScope(page)`, forcing
  // `comfyui-mcp.chatScope = 'workflow'`. Neither survives here: the scope
  // setting is retired, so the workflow-scoped embed path
  // (`workflowStorageKey({ embed: true })`) is never reached and there is no
  // graph tag to assert. Provenance now rides history metadata instead, which
  // is the whole point — a conversation is no longer keyed off the canvas.
  await expect.poll(() => page.evaluate((threadsKey) => {
    const threads = JSON.parse(localStorage.getItem(threadsKey) || '[]')
    return threads.find((t: any) => t.msgs?.length)?.workflowKey ?? null
  }, THREADS_KEY)).toMatch(/^workflow:/)

  const recorded = await page.evaluate(() => {
    const w = window as any
    const app = w.comfyAPI?.app?.app || w.app
    return {
      embedded: app.graph?.extra?.comfyui_mcp?.workflow_uuid ?? null,
      calls: w.__cmcpIdentityMutationCalls
    }
  })
  expect(recorded.embedded).toBeNull()
  expect(recorded.calls).toEqual({ before: 0, after: 0, dirty: 0 })
  // No cleanup needed: main's version had to SAVE a workflow to reach the embed,
  // and deleted the file afterwards. This version never saves — the canvas is
  // left exactly as it was found.
})

test('default mode opens pre-upgrade history without re-keying it', async ({
  page,
  panel
}) => {
  // Seed storage before navigation: ComfyUI may eagerly restore the Agent tab
  // and mount the panel before openSidebar() is called.
  await page.addInitScript(({ threadsKey, currentThreadKey }) => {
    localStorage.setItem(threadsKey, JSON.stringify([
      {
        id: 'old-current',
        ts: Date.now() - 10,
        workflowKey: 'wf:workflows/original.json',
        msgs: [{ role: 'user', text: 'old current thread' }]
      },
      {
        id: 'old-secondary',
        ts: Date.now(),
        workflowKey: 'wf:workflows/another.json',
        msgs: [{ role: 'user', text: 'old secondary thread' }]
      }
    ]))
    sessionStorage.setItem(currentThreadKey, 'old-current')
  }, { threadsKey: THREADS_KEY, currentThreadKey: CURRENT_THREAD_KEY })
  await panel.goto()

  await panel.openSidebar()
  await expect(panel.userBubble('old current thread')).toBeVisible()
  await panel.root.locator('button[title="Chat history"]').click()
  const secondary = panel.root.locator('.cmcp-hist-row').filter({ hasText: 'old secondary thread' })
  await expect(secondary.locator('.cmcp-hist-open')).toBeEnabled()
  await secondary.locator('.cmcp-hist-open').click()
  await expect(panel.userBubble('old secondary thread')).toBeVisible()

  const keys = await page.evaluate((threadsKey) =>
    JSON.parse(localStorage.getItem(threadsKey) || '[]').map((t: any) => [t.id, t.workflowKey]),
  THREADS_KEY)
  expect(keys).toEqual([
    ['old-current', 'wf:workflows/original.json'],
    ['old-secondary', 'wf:workflows/another.json']
  ])
})

/** Seed an archived cross-workflow conversation's CONTENT into the shared
 *  canonical store. Deliberately content-only: the SELECTION must travel
 *  through the real actor (a panel's loadThread), never a direct meta write
 *  (gate P2-6). */
async function seedCrossWorkflowThread(page: import('@playwright/test').Page) {
  const storeModuleUrl = await resolveHistoryStoreModuleUrl(page)
  await page.evaluate(async ({ storeModuleUrl }) => {
    const { ChatHistoryStore } = await import(storeModuleUrl)
    const seedStore = new ChatHistoryStore({ writerId: 'content-seed-test' })
    const canonical = await seedStore.readCanonical()
    const at = Date.now() - 60_000
    seedStore.persist([
      ...(canonical.threads || []),
      {
        id: 'cross-workflow-thread',
        createdAt: at,
        updatedAt: at,
        ts: at,
        workflowKey: 'workflow:definitely-another-workflow',
        workflowTitle: 'Workflow B',
        msgs: [{
          id: 'cross-msg-1',
          role: 'user',
          text: 'archived cross-workflow conversation',
          createdAt: at
        }]
      }
    ], canonical.meta || {})
    const result = await seedStore.flush()
    if (result !== true && (result as any)?.ok !== true) {
      throw new Error(`content seed failed: ${JSON.stringify(result)}`)
    }
    await seedStore.close?.()
  }, { storeModuleUrl })
}

// mcp#884/#897 (P0-1): the agent session is orchestrator-scoped per backend —
// ONE conversation across every tab and workflow. The selection moves through
// the REAL actor seam: a second panel's loadThread (history click) dispatches
// the session frame and only then publishes the shared pointer; this tab
// passively adopts it, and the next message typed here is recorded into the
// adopted conversation — never into the thread this tab used to show.
test('adopts the shared conversation another tab selected, across workflows', async ({
  page,
  context,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('conversation A marker')
  await received

  await seedCrossWorkflowThread(page)

  // A second REAL panel is the actor: it connects, opens its history picker,
  // and clicks the archived row — driving loadThread (dispatch + publish).
  const otherTab = await context.newPage()
  const otherPanel = new PanelPage(otherTab)
  await otherTab.goto(page.url())
  await otherPanel.openSidebar()
  await otherPanel.setBridgeUrl(mockBridge.url)
  await otherPanel.connect()
  await otherPanel.root.locator('button[title="Chat history"]').click()
  const archivedRow = otherPanel.root
    .locator('.cmcp-hist-row')
    .filter({ hasText: 'archived cross-workflow conversation' })
  await expect(archivedRow.locator('.cmcp-hist-open')).toBeEnabled()
  await archivedRow.locator('.cmcp-hist-open').click()
  await expect(otherPanel.userBubble('archived cross-workflow conversation')).toBeVisible()

  // This tab follows the shared selection without a reload...
  await expect(panel.userBubble('archived cross-workflow conversation')).toBeVisible()
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), CURRENT_THREAD_KEY))
    .toBe('cross-workflow-thread')

  // ...and the next message typed HERE is recorded into the adopted
  // conversation (the one the backend's session is in).
  const next = mockBridge.waitForUserMessage()
  await panel.sendMessage('recorded into the adopted conversation')
  await next
  await expect.poll(() => page.evaluate((threadsKey) => {
    const threads = JSON.parse(localStorage.getItem(threadsKey) || '[]')
    const adopted = threads.find((t: any) => t.id === 'cross-workflow-thread')
    return adopted?.msgs?.some((m: any) => m.text === 'recorded into the adopted conversation') ?? false
  }, THREADS_KEY)).toBe(true)

  // Panel scope has no foreign-workflow lockout: the conversation this tab
  // showed before remains an openable archive entry, workflow provenance and
  // all (one conversation spans workflows — mcp#884's invariant).
  await panel.root.locator('button[title="Chat history"]').click()
  const previousRow = panel.root.locator('.cmcp-hist-row').filter({ hasText: 'conversation A marker' })
  await expect(previousRow).toBeVisible()
  await expect(previousRow.locator('.cmcp-hist-open')).toBeEnabled()
  await otherTab.close()
})

// Gate round-3 finding 1 (one conversation PER BACKEND, the switch flow):
// entering a backend must adopt THAT backend's own conversation — the
// orchestrator keys its session orchestrator::<backend>, so keeping the
// previous provider's thread on screen would run the new session against a
// conversation this backend does not own.
test('switching backends adopts that backend\'s own conversation', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('claude conversation marker')
  await received
  const claudeThreadId = await page.evaluate((key) => sessionStorage.getItem(key), CURRENT_THREAD_KEY)
  expect(claudeThreadId).not.toBeNull()

  // PRE-EXISTING state an earlier Codex session left behind: its conversation
  // and its backend-scoped selection. (Setup data, not the behavior under
  // test — the seam under test is the handshake's switch adoption below.)
  const storeModuleUrl = await resolveHistoryStoreModuleUrl(page)
  await page.evaluate(async ({ storeModuleUrl }) => {
    const { ChatHistoryStore, updateMetadataEntry } = await import(storeModuleUrl)
    const seedStore = new ChatHistoryStore({ writerId: 'codex-prior-session' })
    const canonical = await seedStore.readCanonical()
    const at = Date.now() - 120_000
    const meta = updateMetadataEntry(
      canonical.meta || {},
      'activeByScope',
      'panel:backend:codex',
      'codex-own-thread',
      { updatedAt: at + 1, writerId: 'codex-prior-session', sequence: 1 }
    )
    seedStore.persist([
      ...(canonical.threads || []),
      {
        id: 'codex-own-thread',
        createdAt: at,
        updatedAt: at,
        ts: at,
        provider: 'codex',
        workflowKey: 'workflow:codex-earlier-workflow',
        msgs: [{
          id: 'codex-msg-1',
          role: 'user',
          text: 'codex conversation from before',
          createdAt: at
        }]
      }
    ], meta)
    const result = await seedStore.flush()
    if (result !== true && (result as any)?.ok !== true) {
      throw new Error(`codex state seed failed: ${JSON.stringify(result)}`)
    }
    await seedStore.close?.()
  }, { storeModuleUrl })

  // Reconnect to an orchestrator that reports the CODEX backend.
  const codexBridge = new MockBridge({ port: 0, backend: 'codex' })
  await codexBridge.start()
  try {
    await panel.setBridgeUrl(codexBridge.url)
    await panel.connect()

    // The handshake adopts codex's own conversation...
    await expect(panel.userBubble('codex conversation from before')).toBeVisible()
    await expect
      .poll(() => page.evaluate((key) => sessionStorage.getItem(key), CURRENT_THREAD_KEY))
      .toBe('codex-own-thread')
    // ...and claude's selection still names claude's conversation.
    expect(await page.evaluate(() => {
      const meta = JSON.parse(localStorage.getItem('comfyui-mcp.panel.historyMeta') || '{}')
      return meta.activeByScope?.['panel:backend:claude'] || null
    })).toBe(claudeThreadId)
  } finally {
    await codexBridge.close()
  }
})

// Gate P0-1: THE COMMIT IS THE TRANSITION. A tab that cannot reach the
// orchestrator can still open an archive for READING, but it must not publish
// the shared selection — the backend never entered that conversation, so no
// connected tab may be moved onto it.
test('a disconnected tab cannot move the shared conversation', async ({
  page,
  context,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('conversation A marker')
  await received
  const threadA = await page.evaluate((key) => sessionStorage.getItem(key), CURRENT_THREAD_KEY)
  expect(threadA).not.toBeNull()

  await seedCrossWorkflowThread(page)

  // A second panel that is NOT connected opens the archived conversation.
  const otherTab = await context.newPage()
  const otherPanel = new PanelPage(otherTab)
  await otherTab.goto(page.url())
  await otherPanel.openSidebar()
  await otherPanel.root.locator('button[title="Chat history"]').click()
  const archivedRow = otherPanel.root
    .locator('.cmcp-hist-row')
    .filter({ hasText: 'archived cross-workflow conversation' })
  await archivedRow.locator('.cmcp-hist-open').click()
  // The disconnected tab gets its own local view of the archive...
  await expect(otherPanel.userBubble('archived cross-workflow conversation')).toBeVisible()

  // ...but the connected tab is NOT moved: no session transition was
  // dispatched, so no selection was published.
  await page.waitForTimeout(800)
  await expect(panel.userBubble('conversation A marker')).toBeVisible()
  expect(await page.evaluate((key) => sessionStorage.getItem(key), CURRENT_THREAD_KEY)).toBe(threadA)
  await otherTab.close()
})

// Gate P0-4: output of an abandoned turn must not reach the conversation the
// user opened mid-turn — including BEFORE any turn:working frame arrived (the
// owner is pinned at user_message dispatch, not at turn:working, because an
// adoption/switch's endTurnLocally discards a working frame landing inside the
// stale-working window). Covers the say/record fence AND the card paths the
// first round left open (ask_user, set_todo).
test('an abandoned turn cannot leak output into a conversation opened mid-turn', async ({
  page,
  panel,
  mockBridge
}) => {
  await panel.goto()
  await panel.setBridgeUrl(mockBridge.url)
  await panel.openSidebar()
  await panel.connect()

  await seedCrossWorkflowThread(page)

  const received = mockBridge.waitForUserMessage()
  await panel.sendMessage('turn A prompt')
  await received
  // Deliberately NO turn:working yet — the pre-working hole the gate flagged.

  // The user opens the archived conversation mid-flight (the real actor:
  // loadThread ends the local turn, dispatches the session frame, publishes).
  await panel.root.locator('button[title="Chat history"]').click()
  const archivedRow = panel.root
    .locator('.cmcp-hist-row')
    .filter({ hasText: 'archived cross-workflow conversation' })
  await archivedRow.locator('.cmcp-hist-open').click()
  await expect(panel.userBubble('archived cross-workflow conversation')).toBeVisible()

  // Turn A's late output arrives: a committed say, a plan update, and an
  // interactive question card. None of it may reach the opened conversation.
  mockBridge.say('late straggler from the abandoned turn')
  mockBridge.send({ rid: 'gate-todo-1', cmd: 'set_todo', items: [{ text: 'abandoned todo', status: 'active' }] })
  mockBridge.send({ rid: 'gate-ask-1', cmd: 'ask_user', question: 'abandoned question?', options: [{ label: 'yes' }] })
  await page.waitForTimeout(600)
  await expect(
    panel.agentBubbles.filter({ hasText: 'late straggler from the abandoned turn' })
  ).toHaveCount(0)
  await expect(panel.root.locator('.cmcp-question')).toHaveCount(0)
  await expect(panel.root.locator('.cmcp-todo-item').filter({ hasText: 'abandoned todo' })).toHaveCount(0)
  expect(await page.evaluate((threadsKey) => {
    const threads = JSON.parse(localStorage.getItem(threadsKey) || '[]')
    return threads.some((t: any) =>
      t.msgs?.some((m: any) => String(m.text || '').includes('late straggler')))
  }, THREADS_KEY)).toBe(false)

  // The abandoned conversation still holds the user's own prompt — user
  // records are never fenced.
  expect(await page.evaluate((threadsKey) => {
    const threads = JSON.parse(localStorage.getItem(threadsKey) || '[]')
    return threads.some((t: any) =>
      t.msgs?.some((m: any) => m.text === 'turn A prompt'))
  }, THREADS_KEY)).toBe(true)
})
