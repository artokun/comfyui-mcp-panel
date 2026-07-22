import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHAT_HISTORY_SCHEMA,
  ChatHistoryStore,
  isThreadInScope,
  mergeHistorySnapshots,
  normalizeThread,
  retainBoundedThreads,
  selectPanelThread,
  selectRestoreThread,
  selectThreadForScope
} from '../../web/js/lib/chat-history-store.js'

test('normalizes legacy threads into schema v2 without losing messages', () => {
  const thread = normalizeThread({ id: 'legacy', ts: 123, msgs: [{ role: 'user', text: 'hello' }] })
  assert.equal(thread.schemaVersion, CHAT_HISTORY_SCHEMA)
  assert.equal(thread.workflowKey, 'panel:global')
  assert.equal(thread.updatedAt, 123)
  assert.equal(thread.msgs[0].text, 'hello')
})

test('merges browser and durable snapshots by newest thread update', () => {
  const merged = mergeHistorySnapshots(
    {
      threads: [{ id: 'same', ts: 100, msgs: [{ role: 'user', text: 'old' }], title: 'kept title' }],
      meta: { activeByScope: { 'panel:global': 'same' } }
    },
    {
      threads: [{ id: 'same', updatedAt: 200, msgs: [{ role: 'agent', text: 'new' }] }],
      meta: { workflowAliases: { 'workflows/a.json': 'uuid-a' } }
    }
  )
  assert.equal(merged.threads.length, 1)
  assert.equal(merged.threads[0].msgs[0].text, 'new')
  assert.equal(merged.threads[0].title, 'kept title')
  assert.equal(merged.meta.activeByScope['panel:global'], 'same')
  assert.equal(merged.meta.workflowAliases['workflows/a.json'], 'uuid-a')
})

test('merges concurrent messages in the same thread without dropping either tab', () => {
  const base = {
    id: 'shared',
    workflowKey: 'workflow:wf-a',
    createdAt: 100,
    updatedAt: 100,
    msgs: [{ id: 'm1', role: 'user', text: 'base', createdAt: 100 }]
  }
  const merged = mergeHistorySnapshots(
    {
      threads: [{
        ...base,
        updatedAt: 200,
        msgs: [...base.msgs, { id: 'm2', role: 'agent', text: 'from tab A', createdAt: 200 }]
      }],
      meta: {}
    },
    {
      threads: [{
        ...base,
        updatedAt: 210,
        msgs: [...base.msgs, { id: 'm3', role: 'user', text: 'from tab B', createdAt: 210 }]
      }],
      meta: {}
    }
  )

  assert.deepEqual(merged.threads[0].msgs.map((message) => message.text), [
    'base',
    'from tab A',
    'from tab B'
  ])
})

test('thread tombstones prevent deleted chats from being resurrected by stale snapshots', () => {
  const deletedAt = 500
  const merged = mergeHistorySnapshots(
    {
      threads: [],
      meta: { deletedThreads: { removed: deletedAt } }
    },
    {
      threads: [{ id: 'removed', updatedAt: 400, workflowKey: 'workflow:wf-a', msgs: [] }],
      meta: {}
    },
    {
      threads: [],
      meta: { deletedThreads: { removed: 100 } }
    }
  )

  assert.equal(merged.threads.some((thread) => thread.id === 'removed'), false)
  assert.equal(merged.meta.deletedThreads.removed, deletedAt)
})

test('scope selection never falls back to a chat from another workflow', () => {
  const threads = [
    { id: 'a-old', workflowKey: 'workflow:wf-a', updatedAt: 100, msgs: [] },
    { id: 'a-active', workflowKey: 'workflow:wf-a', updatedAt: 90, msgs: [] },
    { id: 'b-newest', workflowKey: 'workflow:wf-b', updatedAt: 999, msgs: [] }
  ]
  const meta = { activeByScope: { 'workflow:wf-a': 'a-active' } }

  assert.equal(isThreadInScope(threads[0], 'workflow:wf-a'), true)
  assert.equal(isThreadInScope(threads[2], 'workflow:wf-a'), false)
  assert.equal(selectThreadForScope(threads, meta, 'workflow:wf-a')?.id, 'a-active')
  assert.equal(selectThreadForScope(threads, meta, 'workflow:missing'), null)
})

test('panel selection preserves provenance and recovers when its tab pointer is lost', () => {
  const threads = [
    { id: 'older-selected', workflowKey: 'wf:workflows/a.json', updatedAt: 100, msgs: [] },
    { id: 'newest', workflowKey: 'tmp:browser-restart', updatedAt: 200, msgs: [] }
  ]

  assert.equal(
    selectPanelThread(threads, { activeByScope: { 'panel:global': 'older-selected' } })?.id,
    'older-selected'
  )
  assert.equal(selectPanelThread(threads, {})?.id, 'newest')
  assert.equal(threads[0].workflowKey, 'wf:workflows/a.json')
})

test('reload keeps the tab-pointed panel conversation instead of switching to a newer thread', () => {
  const threads = [
    { id: 'visible', workflowKey: 'workflow:wf-a', updatedAt: 100, msgs: [] },
    { id: 'newer-background', workflowKey: 'workflow:wf-b', updatedAt: 999, msgs: [] }
  ]

  assert.equal(selectRestoreThread(threads, {}, {
    panelOwned: true,
    preferredThreadId: 'visible'
  })?.id, 'visible')
})

test('reload never accepts a tab pointer from another workflow', () => {
  const threads = [
    { id: 'visible-elsewhere', workflowKey: 'workflow:wf-b', updatedAt: 999, msgs: [] },
    { id: 'scoped', workflowKey: 'workflow:wf-a', updatedAt: 100, msgs: [] }
  ]

  assert.equal(selectRestoreThread(threads, {}, {
    panelOwned: false,
    scopeKey: 'workflow:wf-a',
    preferredThreadId: 'visible-elsewhere'
  })?.id, 'scoped')
})

test('canonical eviction retains the pointed thread and fills the rest by recency', () => {
  const threads = Array.from({ length: 501 }, (_, i) => ({
    id: `t${i}`,
    workflowKey: 'panel:global',
    updatedAt: 1000 + i,
    msgs: [{ id: `m${i}` }]
  }))
  const kept = retainBoundedThreads(threads, 500, ['t0'])

  assert.equal(kept.length, 500)
  assert.equal(kept.some((thread) => thread.id === 't0'), true)
  assert.equal(kept.some((thread) => thread.id === 't1'), false)
  assert.equal(kept.some((thread) => thread.id === 't500'), true)
  assert.equal(selectRestoreThread(kept, {}, {
    panelOwned: true,
    preferredThreadId: 't0'
  })?.id, 't0')

  const protectedOverflow = retainBoundedThreads(threads.slice(0, 3), 2, ['t0', 't1', 't2'])
  assert.deepEqual(protectedOverflow.map((thread) => thread.id), ['t0', 't1'])
})

test('localStorage shadow retains the active tab thread when IndexedDB is unavailable', async () => {
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  }
  const threads = Array.from({ length: 21 }, (_, i) => ({
    id: `t${i}`,
    workflowKey: 'panel:global',
    updatedAt: 1000 + i,
    msgs: [{ id: `m${i}`, role: 'user', text: `message ${i}` }]
  }))
  const store = new ChatHistoryStore({ storage, indexedDb: null })
  store.persist(threads, { activeByScope: { 'panel:global': 't0' } })
  await store.flush()

  const shadow = JSON.parse(values.get('comfyui-mcp.panel.threads'))
  assert.equal(shadow.length, 20)
  assert.equal(shadow.some((thread) => thread.id === 't0'), true)
  assert.equal(shadow.some((thread) => thread.id === 't1'), false)
  assert.equal(store.readLocal().threads.some((thread) => thread.id === 't0'), true)
  const degradedStore = new ChatHistoryStore({ storage, indexedDb: null })
  const degradedReload = await degradedStore.load({ protectedThreadIds: ['t0'] })
  await degradedStore.flush()
  assert.equal(degradedReload.threads.some((thread) => thread.id === 't0'), true)
})

test('notifies another tab when the local history shadow changes', () => {
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  }
  const listeners = new Set()
  const eventTarget = {
    addEventListener: (type, listener) => type === 'storage' && listeners.add(listener),
    removeEventListener: (type, listener) => type === 'storage' && listeners.delete(listener)
  }
  const store = new ChatHistoryStore({ storage, indexedDb: null })
  values.set('comfyui-mcp.panel.threads', JSON.stringify([
    { id: 'from-other-tab', workflowKey: 'workflow:wf-a', updatedAt: 10, msgs: [] }
  ]))
  let received = null
  const unsubscribe = store.subscribe((snapshot) => { received = snapshot }, eventTarget)

  for (const listener of listeners) listener({ key: 'unrelated' })
  assert.equal(received, null)
  for (const listener of listeners) listener({ key: 'comfyui-mcp.panel.threads' })
  assert.equal(received.threads[0].id, 'from-other-tab')
  unsubscribe()
  assert.equal(listeners.size, 0)
})
