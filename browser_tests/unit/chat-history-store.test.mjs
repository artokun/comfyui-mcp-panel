import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHAT_HISTORY_LOCAL_SNAPSHOT_KEY,
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

function createMemoryStorage({ throwOnSet = null } = {}) {
  const values = new Map()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (key === throwOnSet) throw new Error(`blocked write: ${key}`)
      values.set(key, value)
    }
  }
}

function createFakeIndexedDb(initialState = null, { blockedThenSuccess = false } = {}) {
  let state = initialState == null ? null : structuredClone(initialState)
  let closeCount = 0

  const createDb = () => ({
    objectStoreNames: { contains: (name) => name === 'snapshots' },
    createObjectStore() {},
    close: () => { closeCount += 1 },
    transaction: (_name, mode) => {
      const tx = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore: () => ({
          get: () => {
            const request = { result: undefined, onsuccess: null, onerror: null }
            queueMicrotask(() => {
              request.result = state == null ? undefined : structuredClone(state)
              request.onsuccess?.()
            })
            return request
          },
          put: (value) => {
            assert.equal(mode, 'readwrite')
            state = structuredClone(value)
            queueMicrotask(() => tx.oncomplete?.())
          }
        })
      }
      return tx
    }
  })

  return {
    open: () => {
      const request = {
        result: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null
      }
      queueMicrotask(() => {
        if (blockedThenSuccess) request.onblocked?.()
        queueMicrotask(() => {
          request.result = createDb()
          request.onsuccess?.()
        })
      })
      return request
    },
    readState: () => state == null ? null : structuredClone(state),
    closeCount: () => closeCount
  }
}

test('migrates legacy messages to stable schema identities without losing content', () => {
  const thread = normalizeThread({ id: 'legacy', ts: 123, msgs: [{ role: 'user', text: 'hello' }] })
  const sameMigration = normalizeThread({ id: 'legacy', ts: 123, msgs: [{ role: 'user', text: 'hello' }] })
  assert.equal(thread.schemaVersion, CHAT_HISTORY_SCHEMA)
  assert.equal(thread.workflowKey, 'panel:global')
  assert.equal(thread.updatedAt, 123)
  assert.equal(thread.msgs[0].text, 'hello')
  assert.match(thread.msgs[0].id, /^legacy-[a-f0-9]{16}$/)
  assert.equal(thread.msgs[0].id, sameMigration.msgs[0].id)
})

test('merges browser and durable snapshots by newest thread update', () => {
  const merged = mergeHistorySnapshots(
    {
      threads: [{ id: 'same', ts: 100, msgs: [{ id: 'same-message', role: 'user', text: 'old', createdAt: 100 }], title: 'kept title' }],
      meta: { activeByScope: { 'panel:global': 'same' } }
    },
    {
      threads: [{ id: 'same', updatedAt: 200, msgs: [{ id: 'same-message', role: 'agent', text: 'new', createdAt: 100, updatedAt: 200 }] }],
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

test('thread tombstones remain final even when another tab writes the thread later', () => {
  const merged = mergeHistorySnapshots(
    {
      updatedAt: 500,
      threads: [],
      meta: { updatedAt: 500, deletedThreads: { removed: 500 } }
    },
    {
      updatedAt: 900,
      threads: [{ id: 'removed', updatedAt: 900, workflowKey: 'workflow:wf-a', msgs: [] }],
      meta: { updatedAt: 900 }
    }
  )

  assert.equal(merged.threads.some((thread) => thread.id === 'removed'), false)
  assert.equal(merged.meta.deletedThreads.removed, 500)
})

test('message tombstones survive concurrent append and later reload merges', () => {
  const base = {
    id: 'shared',
    workflowKey: 'workflow:wf-a',
    createdAt: 100,
    updatedAt: 100,
    msgs: [{ id: 'm1', role: 'user', text: 'remove me', createdAt: 100 }]
  }
  const merged = mergeHistorySnapshots(
    {
      threads: [{ ...base, updatedAt: 300, msgs: [], deletedMessages: { m1: 300 } }],
      meta: {}
    },
    {
      threads: [{
        ...base,
        updatedAt: 400,
        msgs: [
          ...base.msgs,
          { id: 'm2', role: 'agent', text: 'concurrent append', createdAt: 400 }
        ]
      }],
      meta: {}
    }
  )
  const reloaded = mergeHistorySnapshots(merged, {
    threads: [{ ...base, updatedAt: 500 }],
    meta: {}
  })

  assert.deepEqual(merged.threads[0].msgs.map((message) => message.id), ['m2'])
  assert.equal(merged.threads[0].deletedMessages.m1, 300)
  assert.deepEqual(reloaded.threads[0].msgs.map((message) => message.id), ['m2'])
})

test('two stores migrate id-less messages once and preserve concurrent append and delete in both orders', async () => {
  async function run(order) {
    const indexedDb = createFakeIndexedDb({
      updatedAt: 100,
      threads: [{
        id: 'legacy-shared',
        workflowKey: 'panel:global',
        updatedAt: 100,
        msgs: [
          { role: 'user', text: 'delete this', createdAt: 90 },
          { role: 'agent', text: 'keep this', createdAt: 100 }
        ]
      }],
      meta: {}
    })
    const stores = [
      new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb }),
      new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb })
    ]
    const snapshots = await Promise.all(stores.map((store) => store.load()))
    await Promise.all(stores.map((store) => store.flush()))
    const migratedIds = snapshots.map((snapshot) => snapshot.threads[0].msgs.map((message) => message.id))
    assert.deepEqual(migratedIds[0], migratedIds[1])

    const [deletedId] = migratedIds[0]
    const aThread = structuredClone(snapshots[0].threads[0])
    aThread.msgs = [
      ...aThread.msgs.filter((message) => message.id !== deletedId),
      { id: 'append-a', role: 'user', text: 'from A', createdAt: 300 }
    ]
    aThread.deletedMessages = { [deletedId]: 300 }
    aThread.updatedAt = 300
    const bThread = structuredClone(snapshots[1].threads[0])
    bThread.msgs.push({ id: 'append-b', role: 'agent', text: 'from B', createdAt: 400 })
    bThread.updatedAt = 400
    const writes = [
      () => stores[0].persist([aThread], {}),
      () => stores[1].persist([bThread], {})
    ]
    for (const index of order) {
      writes[index]()
      await stores[index].flush()
    }

    const reloadStore = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb })
    const reloaded = await reloadStore.load()
    await reloadStore.flush()
    return reloaded.threads[0]
  }

  for (const order of [[0, 1], [1, 0]]) {
    const thread = await run(order)
    assert.equal(thread.schemaVersion, CHAT_HISTORY_SCHEMA)
    assert.deepEqual(thread.msgs.map((message) => message.text), ['keep this', 'from A', 'from B'])
    assert.equal(Object.hasOwn(thread.deletedMessages, thread.msgs[0].id), false)
    assert.equal(Object.values(thread.deletedMessages).length, 1)
  }
})

test('metadata tombstones clear active pointers and aliases across stale snapshots', () => {
  const merged = mergeHistorySnapshots(
    {
      updatedAt: 100,
      threads: [],
      meta: {
        updatedAt: 100,
        activeByScope: { 'panel:global': 'old-thread' },
        workflowAliases: { 'workflows/old.json': 'old-workflow' }
      }
    },
    {
      updatedAt: 300,
      threads: [],
      meta: {
        updatedAt: 300,
        activeOps: {
          'panel:global': { value: null, deleted: true, updatedAt: 300 }
        },
        aliasOps: {
          'workflows/old.json': { value: null, deleted: true, updatedAt: 300 }
        }
      }
    }
  )

  assert.equal(Object.hasOwn(merged.meta.activeByScope, 'panel:global'), false)
  assert.equal(Object.hasOwn(merged.meta.workflowAliases, 'workflows/old.json'), false)
  assert.equal(merged.meta.activeOps['panel:global'].deleted, true)
  assert.equal(merged.meta.aliasOps['workflows/old.json'].deleted, true)
  assert.equal(selectPanelThread([
    { id: 'old-thread', workflowKey: 'panel:global', updatedAt: 100, msgs: [] }
  ], merged.meta), null)
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

test('canonical IndexedDB merge enforces thread and message limits after union', async () => {
  const oldMessages = Array.from({ length: 5000 }, (_, i) => ({
    id: `old-${i}`,
    role: 'user',
    text: `old ${i}`,
    createdAt: i + 1
  }))
  const seededThreads = Array.from({ length: 501 }, (_, i) => ({
    id: `t${i}`,
    workflowKey: 'panel:global',
    updatedAt: i + 1,
    msgs: i === 0 ? oldMessages : []
  }))
  const indexedDb = createFakeIndexedDb({
    updatedAt: 10_000,
    threads: seededThreads,
    meta: { activeByScope: { 'panel:global': 't0' } }
  })
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb })
  const incomingMessages = [
    ...oldMessages.slice(1),
    { id: 'newest', role: 'agent', text: 'newest', createdAt: 10_001 }
  ]

  store.persist([
    { id: 't0', workflowKey: 'panel:global', updatedAt: 10_001, msgs: incomingMessages },
    ...seededThreads.slice(2)
  ], { activeByScope: { 'panel:global': 't0' } }, { protectedThreadIds: ['t0'] })
  await store.flush()

  const canonical = indexedDb.readState()
  const protectedThread = canonical.threads.find((thread) => thread.id === 't0')
  assert.equal(canonical.threads.length, 500)
  assert.equal(canonical.threads.some((thread) => thread.id === 't0'), true)
  assert.equal(canonical.threads.some((thread) => thread.id === 't1'), false)
  assert.equal(protectedThread.msgs.length, 5000)
  assert.equal(protectedThread.msgs.some((message) => message.id === 'old-0'), false)
  assert.equal(protectedThread.msgs.at(-1).id, 'newest')
})

test('atomic writes keep message, metadata, and chat deletions through stale writers and reload', async () => {
  const indexedDb = createFakeIndexedDb({
    updatedAt: 100,
    threads: [
      {
        id: 'shared',
        workflowKey: 'panel:global',
        updatedAt: 100,
        msgs: [{ id: 'm1', role: 'user', text: 'deleted', createdAt: 100 }]
      },
      { id: 'removed-chat', workflowKey: 'panel:global', updatedAt: 100, msgs: [] }
    ],
    meta: {
      updatedAt: 100,
      activeByScope: { 'panel:global': 'removed-chat' },
      workflowAliases: { 'workflows/old.json': 'old-workflow' }
    }
  })
  const deletingTab = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb })
  const staleTab = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb })

  deletingTab.persist([
    {
      id: 'shared',
      workflowKey: 'panel:global',
      updatedAt: 300,
      msgs: [],
      deletedMessages: { m1: 300 }
    }
  ], {
    updatedAt: 300,
    deletedThreads: { 'removed-chat': 300 },
    activeOps: { 'panel:global': { value: null, deleted: true, updatedAt: 300 } },
    aliasOps: {
      'workflows/old.json': { value: null, deleted: true, updatedAt: 300 }
    }
  })
  await deletingTab.flush()

  staleTab.persist([
    {
      id: 'shared',
      workflowKey: 'panel:global',
      updatedAt: 900,
      msgs: [
        { id: 'm1', role: 'user', text: 'deleted', createdAt: 100 },
        { id: 'm2', role: 'agent', text: 'late append', createdAt: 900 }
      ]
    },
    { id: 'removed-chat', workflowKey: 'panel:global', updatedAt: 900, msgs: [] }
  ], {
    updatedAt: 100,
    activeByScope: { 'panel:global': 'removed-chat' },
    workflowAliases: { 'workflows/old.json': 'old-workflow' }
  })
  await staleTab.flush()

  const reloadedStore = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb })
  const reloaded = await reloadedStore.load()
  await reloadedStore.flush()

  assert.deepEqual(reloaded.threads.find((thread) => thread.id === 'shared').msgs.map((m) => m.id), ['m2'])
  assert.equal(reloaded.threads.some((thread) => thread.id === 'removed-chat'), false)
  assert.equal(Object.hasOwn(reloaded.meta.activeByScope, 'panel:global'), false)
  assert.equal(Object.hasOwn(reloaded.meta.workflowAliases, 'workflows/old.json'), false)
})

test('blocked IndexedDB opens can continue to success and always close the connection', async () => {
  const indexedDb = createFakeIndexedDb({
    threads: [{ id: 'durable', workflowKey: 'panel:global', updatedAt: 10, msgs: [] }],
    meta: {}
  }, { blockedThenSuccess: true })
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb })

  const loaded = await store.load()
  await store.flush()

  assert.equal(loaded.threads.some((thread) => thread.id === 'durable'), true)
  assert.equal(indexedDb.closeCount(), 2)
})

test('atomic local shadow survives a failed legacy metadata write', async () => {
  const storage = createMemoryStorage({ throwOnSet: 'comfyui-mcp.panel.historyMeta' })
  const store = new ChatHistoryStore({ storage, indexedDb: null })
  store.persist(
    [{ id: 'kept', workflowKey: 'panel:global', updatedAt: 10, msgs: [] }],
    { activeByScope: { 'panel:global': 'kept' } }
  )
  await store.flush()

  assert.notEqual(storage.values.get(CHAT_HISTORY_LOCAL_SNAPSHOT_KEY), undefined)
  assert.equal(store.readLocal().threads[0].id, 'kept')
  assert.equal(store.readLocal().meta.activeByScope['panel:global'], 'kept')
})

test('legacy local shadow migration preserves the valid half of split or corrupt state', () => {
  const storage = createMemoryStorage()
  storage.values.set('comfyui-mcp.panel.threads', JSON.stringify([
    { id: 'legacy-thread', workflowKey: 'panel:global', updatedAt: 10, msgs: [] }
  ]))
  storage.values.set('comfyui-mcp.panel.historyMeta', '{broken')
  const store = new ChatHistoryStore({ storage, indexedDb: null })

  const loaded = store.readLocal()

  assert.equal(loaded.threads[0].id, 'legacy-thread')
  assert.deepEqual(Object.keys(loaded.meta.activeByScope), [])
})

test('partially corrupt atomic shadow recovers each invalid half from legacy storage', () => {
  const storage = createMemoryStorage()
  storage.values.set(CHAT_HISTORY_LOCAL_SNAPSHOT_KEY, JSON.stringify({
    schemaVersion: CHAT_HISTORY_SCHEMA,
    threads: 'broken',
    meta: { activeByScope: { 'panel:global': 'legacy-thread' } }
  }))
  storage.values.set('comfyui-mcp.panel.threads', JSON.stringify([
    { id: 'legacy-thread', workflowKey: 'panel:global', updatedAt: 10, msgs: [] }
  ]))
  storage.values.set('comfyui-mcp.panel.historyMeta', '{broken')
  const store = new ChatHistoryStore({ storage, indexedDb: null })

  const loaded = store.readLocal()

  assert.equal(loaded.threads[0].id, 'legacy-thread')
  assert.equal(loaded.meta.activeByScope['panel:global'], 'legacy-thread')
})

test('drops malformed nested tombstones and metadata operations before canonical merge', async () => {
  const canonical = {
    updatedAt: 500,
    threads: [{
      id: 'keep',
      workflowKey: 'panel:global',
      updatedAt: 500,
      msgs: [{ id: 'keep-message', role: 'user', text: 'durable', createdAt: 500 }]
    }],
    meta: {
      updatedAt: 500,
      activeByScope: { 'panel:global': 'keep' },
      workflowAliases: { 'workflows/keep.json': 'keep-workflow' }
    }
  }
  const storage = createMemoryStorage()
  storage.values.set(CHAT_HISTORY_LOCAL_SNAPSHOT_KEY, JSON.stringify({
    updatedAt: 900,
    threads: [{
      id: 'keep',
      workflowKey: 'panel:global',
      updatedAt: 100,
      msgs: [],
      deletedMessages: {
        'keep-message': 'bad',
        'also-bad': -1,
        'still-bad': null
      }
    }],
    meta: {
      updatedAt: 900,
      deletedThreads: { keep: 'bad', nope: 0 },
      activeByScope: { 'panel:global': 'malformed-shadow' },
      activeOps: {
        'panel:global': { value: null, deleted: true, updatedAt: 'bad' },
        broken: { value: 'x', deleted: true, updatedAt: 900 }
      },
      workflowAliases: { 'workflows/keep.json': 'malformed-shadow' },
      aliasOps: {
        'workflows/keep.json': { value: null, deleted: true, updatedAt: NaN },
        'workflows/broken.json': { value: null, deleted: false, updatedAt: 900 }
      }
    }
  }))
  const indexedDb = createFakeIndexedDb(canonical)
  const store = new ChatHistoryStore({ storage, indexedDb })

  const loaded = await store.load()
  await store.flush()
  const reloaded = await new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb }).load()

  assert.deepEqual(loaded.threads[0].msgs.map((message) => message.id), ['keep-message'])
  assert.equal(loaded.meta.activeByScope['panel:global'], 'keep')
  assert.equal(loaded.meta.workflowAliases['workflows/keep.json'], 'keep-workflow')
  assert.deepEqual(reloaded.threads[0].msgs.map((message) => message.id), ['keep-message'])
  assert.equal(Object.hasOwn(reloaded.meta.deletedThreads, 'keep'), false)
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
