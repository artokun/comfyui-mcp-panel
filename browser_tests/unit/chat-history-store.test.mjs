import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHAT_HISTORY_LOCAL_SNAPSHOT_KEY,
  CHAT_HISTORY_SCHEMA,
  ChatHistoryStore,
  createHistoryResetSnapshot,
  isThreadInScope,
  mergeHistorySnapshots,
  normalizeThread,
  retainBoundedThreads,
  selectPanelThread,
  selectRestoreThread,
  selectThreadForScope,
  updateMetadataEntry
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

function createBroadcastHub() {
  const channels = new Set()
  let closeCount = 0
  return {
    factory: () => {
      const listeners = new Set()
      const channel = {
        addEventListener: (type, listener) => type === 'message' && listeners.add(listener),
        removeEventListener: (type, listener) => type === 'message' && listeners.delete(listener),
        postMessage: (data) => {
          for (const peer of channels) {
            if (peer === channel) continue
            queueMicrotask(() => peer.dispatch(data))
          }
        },
        dispatch: (data) => {
          for (const listener of listeners) listener({ data })
        },
        close: () => {
          if (!channels.delete(channel)) return
          closeCount += 1
          listeners.clear()
        }
      }
      channels.add(channel)
      return channel
    },
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

test('stale append cannot roll back independently revised session todos provenance or card state', () => {
  const base = normalizeThread({
    id: 'causal-thread',
    workflowKey: 'workflow:old',
    sessionId: 'old-session',
    todos: [{ text: 'old todo', status: 'pending' }],
    createdAt: 100,
    updatedAt: 100,
    msgs: [{
      id: 'card',
      role: 'card',
      kind: 'a2ui',
      spec: { title: 'old card' },
      resolved: false,
      createdAt: 100
    }]
  })
  const stateTab = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb: null,
    writerId: 'writer-a'
  })
  const appendTab = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb: null,
    writerId: 'writer-b'
  })
  const stateThread = structuredClone(base)
  stateTab.reviseThread(stateThread, {
    sessionId: 'new-session',
    todos: [{ text: 'new todo', status: 'done' }],
    workflowKey: 'workflow:new'
  }, 1_000)
  stateThread.msgs[0].spec = { title: 'new card' }
  stateThread.msgs[0].resolved = true
  stateTab.touchMessage(stateThread.msgs[0], 1_000)

  const staleAppend = structuredClone(base)
  const reply = { id: 'reply', role: 'agent', text: 'late reply', createdAt: 2_000 }
  appendTab.touchMessage(reply, 2_000)
  staleAppend.msgs.push(reply)
  staleAppend.updatedAt = 2_000
  staleAppend.ts = 2_000

  for (const pair of [[stateThread, staleAppend], [staleAppend, stateThread]]) {
    const merged = mergeHistorySnapshots(
      { threads: [pair[0]], meta: {} },
      { threads: [pair[1]], meta: {} }
    ).threads[0]
    assert.equal(merged.sessionId, 'new-session')
    assert.deepEqual(merged.todos, [{ text: 'new todo', status: 'done' }])
    assert.equal(merged.workflowKey, 'workflow:new')
    assert.equal(merged.msgs.find((message) => message.id === 'card').spec.title, 'new card')
    assert.equal(merged.msgs.find((message) => message.id === 'card').resolved, true)
    assert.equal(merged.msgs.find((message) => message.id === 'reply').text, 'late reply')
  }
})

test('exact revision ties use writer and sequence deterministically in both merge orders', () => {
  const base = normalizeThread({
    id: 'tie-thread',
    workflowKey: 'workflow:base',
    sessionId: 'base-session',
    updatedAt: 100,
    msgs: [{ id: 'card', role: 'card', text: 'base', createdAt: 100 }]
  })
  const lowerWriter = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb: null, writerId: 'a' })
  const higherWriter = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb: null, writerId: 'z' })
  const left = structuredClone(base)
  const right = structuredClone(base)
  lowerWriter.reviseThread(left, { sessionId: 'from-a', workflowKey: 'workflow:a' }, 1_000)
  higherWriter.reviseThread(right, { sessionId: 'from-z', workflowKey: 'workflow:z' }, 1_000)
  left.msgs[0].text = 'card-a'
  right.msgs[0].text = 'card-z'
  lowerWriter.touchMessage(left.msgs[0], 1_000)
  higherWriter.touchMessage(right.msgs[0], 1_000)

  for (const pair of [[left, right], [right, left]]) {
    const merged = mergeHistorySnapshots(
      { threads: [pair[0]], meta: {} },
      { threads: [pair[1]], meta: {} }
    ).threads[0]
    assert.equal(merged.sessionId, 'from-z')
    assert.equal(merged.workflowKey, 'workflow:z')
    assert.equal(merged.msgs[0].text, 'card-z')
  }
})

test('observed revisions advance every mutable field and card state despite backward clocks', async () => {
  const future = { updatedAt: 50_000, writerId: 'future-tab', sequence: 9 }
  const fields = {
    sessionId: 'old-session',
    todos: [{ text: 'old', status: 'pending' }],
    workflowKey: 'workflow:old',
    workflowTitle: 'Old workflow',
    provider: 'claude',
    model: 'old-model',
    effort: 'low',
    pinned: false,
    title: 'Old title'
  }
  const fieldOps = Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, {
    value,
    deleted: false,
    updatedAt: future.updatedAt,
    revision: future
  }]))
  const thread = normalizeThread({
    id: 'clock-skew-thread',
    ...fields,
    updatedAt: future.updatedAt,
    fieldOps,
    msgs: [{
      id: 'card',
      role: 'card',
      text: 'old card',
      createdAt: 10,
      updatedAt: future.updatedAt,
      revision: future
    }]
  })
  const store = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb: null,
    writerId: 'backward-clock'
  })
  store.reviseThread(thread, {
    sessionId: 'new-session',
    todos: [{ text: 'new', status: 'done' }],
    workflowKey: 'workflow:new',
    workflowTitle: 'New workflow',
    provider: 'codex',
    model: 'new-model',
    effort: 'high',
    pinned: true,
    title: 'New title'
  }, 1_000)
  thread.msgs[0].text = 'new card'
  store.touchMessage(thread.msgs[0], 900)

  for (const operation of Object.values(thread.fieldOps)) {
    assert.ok(operation.revision.updatedAt > future.updatedAt)
  }
  assert.ok(thread.msgs[0].revision.updatedAt > future.updatedAt)

  const canonicalFuture = normalizeThread({
    id: 'remote',
    sessionId: 'remote-session',
    updatedAt: 90_000,
    fieldOps: {
      sessionId: {
        value: 'remote-session',
        deleted: false,
        updatedAt: 90_000,
        revision: { updatedAt: 90_000, writerId: 'remote', sequence: 1 }
      }
    },
    msgs: []
  })
  const hydrated = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb: createFakeIndexedDb({ threads: [canonicalFuture], meta: {} }),
    writerId: 'hydrated-backward-clock'
  })
  const loaded = await hydrated.load()
  hydrated.reviseThread(loaded.threads[0], { sessionId: null }, 500)
  assert.ok(loaded.threads[0].fieldOps.sessionId.revision.updatedAt > 90_000)
})

test('thread tombstones preserve causal delete operations and prevent stale resurrection', () => {
  const deletedAt = { updatedAt: 500, writerId: 'delete-tab', sequence: 1 }
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
  assert.deepEqual(merged.meta.deletedThreads.removed.revision, deletedAt)
  assert.equal(merged.meta.deletedThreads.removed.deleted, true)
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
  assert.equal(merged.meta.deletedThreads.removed.updatedAt, 500)
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

test('legacy migration fence handles duplicate shifts and content changes in both write orders', async () => {
  const legacy = {
    updatedAt: 100,
    threads: [{
      id: 'legacy-fence',
      workflowKey: 'panel:global',
      updatedAt: 100,
      msgs: [
        { role: 'user', text: 'duplicate', createdAt: 10 },
        { role: 'user', text: 'duplicate', createdAt: 20 },
        { role: 'card', text: 'old card', spec: { title: 'old' }, createdAt: 30 }
      ]
    }],
    meta: {}
  }
  const staleChanged = [{
    id: 'legacy-fence',
    workflowKey: 'panel:global',
    updatedAt: 500,
    msgs: [
      { role: 'user', text: 'duplicate', createdAt: 20 },
      { role: 'card', text: 'changed card', spec: { title: 'changed' }, createdAt: 30 }
    ]
  }]

  // Migration wins: a later id-less snapshot is quarantined.
  const migratedFirstDb = createFakeIndexedDb(legacy)
  const migrator = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb: migratedFirstDb })
  const migrated = await migrator.load()
  await migrator.flush()
  assert.equal(migrated.threads[0].msgs.length, 3)
  const staleAfterFence = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb: migratedFirstDb })
  staleAfterFence.persist(staleChanged, {})
  await staleAfterFence.flush()
  const fenced = await new ChatHistoryStore({
    storage: createMemoryStorage(), indexedDb: migratedFirstDb
  }).load()
  assert.deepEqual(fenced.threads[0].msgs.map((message) => message.text), [
    'duplicate', 'duplicate', 'old card'
  ])

  // Stale legacy write wins: replace the matching pre-v3 thread before IDs are
  // assigned, so the shifted duplicate/card never fork into extra messages.
  const staleFirstDb = createFakeIndexedDb(legacy)
  const staleBeforeFence = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb: staleFirstDb })
  staleBeforeFence.persist(staleChanged, {})
  await staleBeforeFence.flush()
  const migratedAfter = await new ChatHistoryStore({
    storage: createMemoryStorage(), indexedDb: staleFirstDb
  }).load()
  assert.deepEqual(migratedAfter.threads[0].msgs.map((message) => message.text), [
    'duplicate', 'changed card'
  ])
  assert.equal(new Set(migratedAfter.threads[0].msgs.map((message) => message.id)).size, 2)
  assert.equal(migratedAfter.threads[0].msgs[1].spec.title, 'changed')
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

test('alias tombstones and exact-time writer ties remain deterministic in both merge orders', () => {
  const base = {
    updatedAt: 100,
    workflowAliases: { 'workflows/old.json': 'workflow-id' }
  }
  const deleted = updateMetadataEntry(base, 'workflowAliases', 'workflows/old.json', null, {
    updatedAt: 500,
    writerId: 'z-renamer',
    sequence: 1
  })
  const staleSet = updateMetadataEntry(base, 'workflowAliases', 'workflows/old.json', 'workflow-id', {
    updatedAt: 500,
    writerId: 'a-stale',
    sequence: 99
  })
  const unrelated = updateMetadataEntry(staleSet, 'activeByScope', 'panel:global', 'thread-b', {
    updatedAt: 600,
    writerId: 'a-stale',
    sequence: 100
  })

  for (const pair of [[deleted, unrelated], [unrelated, deleted]]) {
    const merged = mergeHistorySnapshots(
      { threads: [], meta: pair[0] },
      { threads: [], meta: pair[1] }
    )
    assert.equal(Object.hasOwn(merged.meta.workflowAliases, 'workflows/old.json'), false)
    assert.equal(merged.meta.aliasOps['workflows/old.json'].deleted, true)
    assert.equal(merged.meta.activeByScope['panel:global'], 'thread-b')
  }
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

test('history reset creates an empty checkpoint while preserving workflow identity aliases', () => {
  const reset = createHistoryResetSnapshot({
    threads: [
      { id: 'chat-a', workflowKey: 'workflow:wf-a', updatedAt: 100, msgs: [] },
      { id: 'chat-b', workflowKey: 'workflow:wf-b', updatedAt: 200, msgs: [] }
    ],
    meta: {
      updatedAt: 200,
      checkpoint: {
        generation: 4,
        revision: { updatedAt: 150, writerId: 'old-checkpoint', sequence: 1 }
      },
      activeByScope: { 'workflow:wf-a': 'chat-a', 'workflow:wf-b': 'chat-b' },
      workflowAliases: {
        'workflows/a.json': 'wf-a',
        'workflows/b.json': 'wf-b'
      },
      aliasOps: {
        'workflows/a.json': {
          value: 'wf-a',
          deleted: false,
          updatedAt: 100,
          revision: { updatedAt: 100, writerId: 'alias', sequence: 1 }
        }
      }
    }
  }, { updatedAt: 300, writerId: 'clear-all', sequence: 1 })

  assert.deepEqual(reset.threads, [])
  assert.deepEqual({ ...reset.meta.activeByScope }, {})
  assert.deepEqual({ ...reset.meta.activeOps }, {})
  assert.deepEqual({ ...reset.meta.deletedThreads }, {})
  assert.deepEqual({ ...reset.meta.workflowAliases }, {
    'workflows/a.json': 'wf-a',
    'workflows/b.json': 'wf-b'
  })
  assert.deepEqual({ ...reset.meta.aliasOps }, {})
  assert.equal(reset.meta.checkpoint.generation, 5)
  assert.deepEqual(reset.meta.checkpoint.revision, {
    updatedAt: 300,
    writerId: 'clear-all',
    sequence: 1
  })
})

test('clear all is canonical, broadcasts, and fences a stale tab without deleting aliases', async () => {
  const initial = {
    schemaVersion: CHAT_HISTORY_SCHEMA,
    updatedAt: 200,
    threads: [
      {
        id: 'chat-a',
        workflowKey: 'workflow:wf-a',
        createdAt: 100,
        updatedAt: 200,
        msgs: [{ id: 'message-a', role: 'user', text: 'erase me', createdAt: 200 }]
      }
    ],
    meta: {
      updatedAt: 200,
      activeByScope: { 'workflow:wf-a': 'chat-a' },
      workflowAliases: { 'workflows/a.json': 'wf-a' }
    }
  }
  const staleSnapshot = structuredClone(initial)
  const indexedDb = createFakeIndexedDb(initial)
  const clearingStorage = createMemoryStorage()
  const staleStorage = createMemoryStorage()
  const hub = createBroadcastHub()
  const clearingStore = new ChatHistoryStore({
    storage: clearingStorage,
    indexedDb,
    writerId: 'clearing-tab',
    broadcastChannelFactory: hub.factory
  })
  const observingStore = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb,
    writerId: 'observing-tab',
    broadcastChannelFactory: hub.factory
  })
  const observedReset = new Promise((resolve) => {
    observingStore.subscribe((snapshot) => resolve(snapshot), {
      addEventListener() {},
      removeEventListener() {}
    })
  })

  const result = await clearingStore.clearAll(initial.threads, initial.meta)
  assert.equal(result.ok, true)
  assert.equal(result.canonicalCommitted, true)
  assert.deepEqual(result.snapshot.threads, [])
  assert.equal(result.snapshot.meta.workflowAliases['workflows/a.json'], 'wf-a')

  const peerSnapshot = await observedReset
  assert.deepEqual(peerSnapshot.threads, [])
  assert.equal(peerSnapshot.meta.workflowAliases['workflows/a.json'], 'wf-a')
  const shadow = JSON.parse(clearingStorage.getItem(CHAT_HISTORY_LOCAL_SNAPSHOT_KEY))
  assert.deepEqual(shadow.threads, [])
  assert.equal(shadow.meta.workflowAliases['workflows/a.json'], 'wf-a')

  const staleStore = new ChatHistoryStore({
    storage: staleStorage,
    indexedDb,
    writerId: 'stale-tab'
  })
  staleStore.persist(staleSnapshot.threads, staleSnapshot.meta)
  await staleStore.flush()
  const canonical = indexedDb.readState()
  assert.deepEqual(canonical.threads, [])
  assert.deepEqual({ ...canonical.meta.activeByScope }, {})
  assert.equal(canonical.meta.workflowAliases['workflows/a.json'], 'wf-a')

  clearingStore.close()
  observingStore.close()
  staleStore.close()
})

test('clear all fails closed when the canonical IndexedDB store is unavailable', async () => {
  const storage = createMemoryStorage()
  const store = new ChatHistoryStore({ storage, indexedDb: null })
  const threads = [{ id: 'shadow-only', workflowKey: 'panel:global', updatedAt: 100, msgs: [] }]
  store.persist(threads, {})
  await store.flush()
  const before = storage.getItem(CHAT_HISTORY_LOCAL_SNAPSHOT_KEY)

  const result = await store.clearAll(threads, {})

  assert.equal(result.ok, false)
  assert.equal(result.retryable, true)
  assert.equal(result.code, 'history-clear-canonical-unavailable')
  assert.equal(storage.getItem(CHAT_HISTORY_LOCAL_SNAPSHOT_KEY), before)
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

test('flush reports total persistence failure and retries the retained dirty snapshot', async () => {
  const failures = []
  const blockedStorage = createMemoryStorage({ throwOnSet: CHAT_HISTORY_LOCAL_SNAPSHOT_KEY })
  const store = new ChatHistoryStore({
    storage: blockedStorage,
    indexedDb: null,
    onPersistenceError: (failure) => failures.push(failure)
  })
  store.persist(
    [{ id: 'retry-thread', workflowKey: 'panel:global', updatedAt: 10, msgs: [] }],
    { activeByScope: { 'panel:global': 'retry-thread' } }
  )

  const failed = await store.flush()
  assert.deepEqual(failed, {
    ok: false,
    shadowCommitted: false,
    canonicalCommitted: false,
    retryable: true,
    code: 'history-persistence-unavailable'
  })
  assert.equal(failures.length, 1)
  assert.equal(store._lastCommitted, null)

  const recoveredStorage = createMemoryStorage()
  const recoveredIndexedDb = createFakeIndexedDb()
  store.storage = recoveredStorage
  store.indexedDb = recoveredIndexedDb
  store.persist([], {})
  assert.equal(await store.flush(), true)
  assert.equal(recoveredIndexedDb.readState().threads[0].id, 'retry-thread')
  assert.equal(store.readLocal().threads[0].id, 'retry-thread')
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

test('validates and caps field operations while preserving legacy clear migration', () => {
  const base = normalizeThread({
    id: 'field-validation',
    sessionId: 'canonical-session',
    pinned: true,
    todos: [{ text: 'canonical todo', status: 'active' }],
    title: 'canonical title',
    workflowTitle: 'canonical workflow title',
    updatedAt: 100,
    msgs: []
  })
  const malformed = normalizeThread({
    ...base,
    updatedAt: 1_000,
    fieldOps: {
      ...base.fieldOps,
      sessionId: {
        value: { forged: true },
        deleted: false,
        updatedAt: 1_000,
        revision: { updatedAt: 1_000, writerId: 'attacker', sequence: 1 }
      },
      pinned: {
        value: 'yes',
        deleted: false,
        updatedAt: 1_001,
        revision: { updatedAt: 1_001, writerId: 'attacker', sequence: 2 }
      },
      todos: {
        value: 'not-an-array',
        deleted: false,
        updatedAt: 1_002,
        revision: { updatedAt: 1_002, writerId: 'attacker', sequence: 3 }
      },
      title: {
        value: 'x'.repeat(500),
        deleted: false,
        updatedAt: 1_003,
        revision: { updatedAt: 1_003, writerId: 'attacker', sequence: 4 }
      },
      workflowTitle: {
        value: 'y'.repeat(500),
        deleted: false,
        updatedAt: 1_004,
        revision: { updatedAt: 1_004, writerId: '', sequence: -1 }
      }
    }
  })

  assert.equal(malformed.sessionId, 'canonical-session')
  assert.equal(malformed.pinned, true)
  assert.deepEqual(malformed.todos, [{ text: 'canonical todo', status: 'active' }])
  assert.equal(malformed.title.length, 160)
  assert.equal(malformed.workflowTitle, 'canonical workflow title')

  const cappedTodos = Array.from({ length: 140 }, (_, index) => ({
    text: `todo-${index}-${'z'.repeat(2_100)}`,
    status: index === 0 ? 'done' : 'unknown'
  }))
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb: null })
  store.reviseThread(malformed, { todos: cappedTodos, pinned: 'invalid', model: { bad: true } }, 2_000)
  assert.equal(malformed.todos.length, 100)
  assert.equal(malformed.todos[0].text.length, 2_000)
  assert.equal(malformed.todos[0].status, 'done')
  assert.equal(malformed.todos[1].status, 'pending')
  assert.equal(malformed.pinned, true)
  assert.equal(malformed.model, undefined)

  const legacyClear = normalizeThread({
    ...base,
    fieldOps: {
      ...base.fieldOps,
      sessionId: { value: null, deleted: true, updatedAt: 3_000 }
    }
  })
  assert.equal(legacyClear.sessionId, undefined)
  assert.equal(legacyClear.fieldOps.sessionId.deleted, true)
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

test('canonical IndexedDB checkpoint quarantines forged empty and partial local baselines', async () => {
  const checkpoint = {
    generation: 4,
    revision: { updatedAt: 5_000, writerId: 'canonical-checkpoint', sequence: 1 }
  }
  const canonical = {
    updatedAt: 5_000,
    threads: [{
      id: 'keep',
      workflowKey: 'panel:global',
      createdAt: 100,
      createdRevision: { updatedAt: 100, writerId: 'canonical', sequence: 1 },
      updatedAt: 5_000,
      msgs: [{
        id: 'keep-message',
        role: 'user',
        text: 'canonical history',
        createdAt: 100,
        createdRevision: { updatedAt: 100, writerId: 'canonical', sequence: 2 }
      }]
    }],
    meta: {
      updatedAt: 5_000,
      checkpoint,
      activeByScope: { 'panel:global': 'keep' },
      workflowAliases: { 'workflows/keep.json': 'keep-workflow' }
    }
  }

  for (const forged of [
    {
      updatedAt: 99_000,
      threads: [],
      meta: {
        updatedAt: 99_000,
        checkpoint: {
          generation: 999,
          revision: { updatedAt: 99_000, writerId: 'forged', sequence: 1 }
        }
      }
    },
    {
      updatedAt: 99_001,
      threads: [{
        id: 'forged-partial',
        workflowKey: 'panel:global',
        createdAt: 10,
        createdRevision: { updatedAt: 10, writerId: 'forged', sequence: 1 },
        updatedAt: 99_001,
        msgs: []
      }],
      meta: {
        updatedAt: 99_001,
        checkpoint: {
          generation: 1_000,
          revision: { updatedAt: 99_001, writerId: 'forged', sequence: 1 }
        },
        activeByScope: { 'panel:global': 'forged-partial' }
      }
    }
  ]) {
    const storage = createMemoryStorage()
    storage.values.set(CHAT_HISTORY_LOCAL_SNAPSHOT_KEY, JSON.stringify(forged))
    const indexedDb = createFakeIndexedDb(canonical)
    const store = new ChatHistoryStore({ storage, indexedDb })
    const loaded = await store.load()
    const flush = await store.flush()

    assert.equal(flush, true)
    assert.deepEqual(loaded.threads.map((thread) => thread.id), ['keep'])
    assert.equal(loaded.threads[0].msgs[0].text, 'canonical history')
    assert.equal(loaded.meta.activeByScope['panel:global'], 'keep')
    assert.equal(loaded.meta.workflowAliases['workflows/keep.json'], 'keep-workflow')
    assert.equal(indexedDb.readState().meta.checkpoint.generation, checkpoint.generation)
  }
})

test('notifies another tab when the local history shadow changes', async () => {
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
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(received.threads[0].id, 'from-other-tab')
  unsubscribe()
  assert.equal(listeners.size, 0)
})

test('store close is idempotent and releases subscriptions and BroadcastChannel once', () => {
  const listeners = new Set()
  const eventTarget = {
    addEventListener: (type, listener) => type === 'storage' && listeners.add(listener),
    removeEventListener: (type, listener) => type === 'storage' && listeners.delete(listener)
  }
  const hub = createBroadcastHub()
  const store = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb: null,
    broadcastChannelFactory: hub.factory
  })
  store.subscribe(() => {}, eventTarget)
  assert.equal(listeners.size, 1)

  store.close()
  store.close()

  assert.equal(listeners.size, 0)
  assert.equal(hub.closeCount(), 1)
  const unsubscribeAfterClose = store.subscribe(() => {}, eventTarget)
  unsubscribeAfterClose()
  assert.equal(listeners.size, 0)
})

test('bounds checkpointed operations, rejects compacted stale resurrection, and broadcasts quota failures', async () => {
  const indexedDb = createFakeIndexedDb()
  const hub = createBroadcastHub()
  const shadowErrors = []
  const quotaStorage = createMemoryStorage({ throwOnSet: CHAT_HISTORY_LOCAL_SNAPSHOT_KEY })
  const writer = new ChatHistoryStore({
    storage: quotaStorage,
    indexedDb,
    writerId: 'quota-writer',
    maxTombstones: 3,
    maxMetadataOps: 3,
    broadcastChannelFactory: hub.factory,
    onShadowError: (error) => shadowErrors.push(error.message)
  })
  const receiver = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb,
    writerId: 'receiver',
    maxTombstones: 3,
    maxMetadataOps: 3,
    broadcastChannelFactory: hub.factory
  })
  let invalidated = null
  const unsubscribe = receiver.subscribe((snapshot) => { invalidated = snapshot }, null)
  const deletedMessages = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [`m${index}`, 1_000 + index])
  )
  const deletedThreads = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [`t${index}`, 1_000 + index])
  )
  const aliasOps = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
    `workflows/deleted-${index}.json`,
    {
      value: null,
      deleted: true,
      updatedAt: 1_000 + index,
      revision: { updatedAt: 1_000 + index, writerId: 'quota-writer', sequence: index + 1 }
    }
  ]))
  const activeOps = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
    `workflow:deleted-${index}`,
    {
      value: null,
      deleted: true,
      updatedAt: 1_100 + index,
      revision: { updatedAt: 1_100 + index, writerId: 'quota-writer', sequence: index + 20 }
    }
  ]))

  writer.persist([{
    id: 'live',
    workflowKey: 'panel:global',
    createdAt: 100,
    updatedAt: 1_200,
    msgs: [],
    deletedMessages
  }], { updatedAt: 1_200, deletedThreads, aliasOps, activeOps })
  await writer.flush()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const compacted = indexedDb.readState()
  assert.equal(writer.lastShadowWriteOk, false)
  assert.match(shadowErrors[0], /blocked write/)
  assert.ok(invalidated?.meta?.checkpoint?.generation > 0)
  assert.ok(Object.keys(compacted.meta.deletedThreads).length <= 3)
  assert.ok(Object.keys(compacted.meta.aliasOps).length <= 3)
  assert.ok(Object.keys(compacted.meta.activeOps).length <= 3)
  assert.ok(Object.keys(compacted.threads[0].deletedMessages).length <= 3)

  const stale = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb,
    writerId: 'stale-writer',
    maxTombstones: 3,
    maxMetadataOps: 3
  })
  stale.persist([
    {
      id: 'live',
      workflowKey: 'panel:global',
      createdAt: 100,
      updatedAt: 2_000,
      msgs: [{ id: 'm0', role: 'user', text: 'must stay deleted', createdAt: 100 }]
    },
    { id: 't0', workflowKey: 'panel:global', createdAt: 100, updatedAt: 2_000, msgs: [] }
  ], {
    updatedAt: 2_000,
    workflowAliases: { 'workflows/deleted-0.json': 'must-stay-deleted' },
    aliasOps: {
      'workflows/deleted-0.json': {
        value: 'must-stay-deleted',
        deleted: false,
        updatedAt: 100,
        revision: { updatedAt: 100, writerId: 'stale-writer', sequence: 1 }
      }
    }
  })
  await stale.flush()
  const reloaded = await receiver.readCanonical()

  assert.equal(reloaded.threads.some((thread) => thread.id === 't0'), false)
  assert.equal(reloaded.threads.find((thread) => thread.id === 'live').msgs.some((message) => message.id === 'm0'), false)
  assert.equal(Object.hasOwn(reloaded.meta.workflowAliases, 'workflows/deleted-0.json'), false)
  unsubscribe()
})

test('reviseThread stamps a causal createdRevision on new threads (codex: pre-checkpoint loss)', () => {
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb: null })
  const thread = { id: 'fresh', createdAt: 1, updatedAt: 1, msgs: [] }
  store.reviseThread(thread, { workflowKey: 'workflow:new' }, 5_000)
  assert.ok(thread.createdRevision, 'new thread must carry a causal creation stamp')
  assert.ok(thread.createdRevision.updatedAt >= 5_000)
  const existing = thread.createdRevision
  store.reviseThread(thread, { sessionId: 's1' }, 6_000)
  assert.equal(thread.createdRevision, existing, 'creation stamp is write-once')
})

test('touchMessage stamps a causal createdRevision when missing (codex: pre-checkpoint loss)', () => {
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb: null })
  const message = { id: 'm1', createdAt: 1, text: 'hi' }
  store.touchMessage(message, 5_000)
  assert.ok(message.createdRevision)
  assert.ok(message.createdRevision.updatedAt >= 5_000)
  const existing = message.createdRevision
  store.touchMessage(message, 6_000)
  assert.equal(message.createdRevision, existing, 'creation stamp is write-once')
})

test('unsubscribe suppresses a pending readCanonical delivery (codex: dead-panel callback)', async () => {
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
  let calls = 0
  const unsubscribe = store.subscribe(() => { calls += 1 }, eventTarget)

  for (const listener of listeners) listener({ key: 'comfyui-mcp.panel.threads' })
  // The read is in flight; destroy the panel before it resolves.
  unsubscribe()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls, 0, 'a read started before unsubscribe must not deliver')
})

test('legacy-idless shadow-only threads are retained in the shadow, fenced out of canonical (no data loss)', async () => {
  const now = Date.now()
  const canonical = {
    schemaVersion: CHAT_HISTORY_SCHEMA,
    updatedAt: now - 1000,
    meta: {
      checkpoint: { generation: 3, revision: { updatedAt: now - 1000, writerId: 'w1', sequence: 1 } },
      activeByScope: {},
      workflowAliases: {}
    },
    threads: [
      { id: 'marker', workflowKey: 'workflow:a', createdAt: now - 500, updatedAt: now - 500,
        msgs: [{ id: 'm1', role: 'user', text: 'marker', createdAt: now - 500 }] }
    ]
  }
  const storage = createMemoryStorage()
  // Local shadow: marker (id-ed) + a legacy-idless foreign thread (pre-v3 shape).
  storage.setItem('comfyui-mcp.panel.threads', JSON.stringify([
    { id: 'marker', workflowKey: 'workflow:a', createdAt: now - 500, updatedAt: now - 500,
      msgs: [{ id: 'm1', role: 'user', text: 'marker', createdAt: now - 500 }] },
    { id: 'foreign-thread', ts: now + 10, workflowKey: 'workflow:other',
      msgs: [{ role: 'user', text: 'legacy content with no ids' }] }
  ]))
  const indexedDb = createFakeIndexedDb(canonical)
  const store = new ChatHistoryStore({ storage, indexedDb })

  const merged = await store.load({ protectedThreadIds: ['foreign-thread'] })

  // Retained in the merged view (history list), flagged as shadow-only.
  const foreign = merged.threads.find((thread) => thread.id === 'foreign-thread')
  assert.ok(foreign, 'shadow-only legacy thread must survive hydration')
  assert.equal(foreign.legacyShadow, true)

  // …but fenced OUT of the canonical write.
  await store.flush()
  const canonicalAfter = indexedDb.readState()
  assert.equal(
    (canonicalAfter?.threads || []).some((thread) => thread?.id === 'foreign-thread'),
    false,
    'legacyShadow threads must never enter the fenced canonical',
  )
})

test('canonical commits keep quarantined threads in the local shadow (codex P1: shadow erasure)', async () => {
  const now = Date.now()
  const canonical = {
    schemaVersion: CHAT_HISTORY_SCHEMA,
    updatedAt: now - 1000,
    meta: {
      checkpoint: { generation: 3, revision: { updatedAt: now - 1000, writerId: 'w1', sequence: 1 } },
      activeByScope: {},
      workflowAliases: {}
    },
    threads: []
  }
  const storage = createMemoryStorage()
  const indexedDb = createFakeIndexedDb(canonical)
  const store = new ChatHistoryStore({ storage, indexedDb })
  storage.setItem('comfyui-mcp.panel.threads', JSON.stringify([
    { id: 'foreign-thread', ts: now + 10, workflowKey: 'workflow:other',
      msgs: [{ role: 'user', text: 'legacy content with no ids' }] }
  ]))

  await store.load({ protectedThreadIds: ['foreign-thread'] })
  await store.flush()

  // After a SUCCESSFUL canonical commit, the localStorage shadow must still
  // carry the quarantined thread (a canonical-only shadow would erase it).
  const shadowThreads = JSON.parse(storage.values.get('comfyui-mcp.panel.threads'))
  assert.ok(
    shadowThreads.some((thread) => thread.id === 'foreign-thread'),
    'quarantined threads must survive the post-commit shadow rewrite',
  )
  // …and remain excluded from canonical.
  const canonicalAfter = indexedDb.readState()
  assert.equal(
    (canonicalAfter?.threads || []).some((thread) => thread?.id === 'foreign-thread'),
    false,
  )
})

test('the shadow cap exempts legacyShadow threads (their only copy)', async () => {
  const now = Date.now()
  const storage = createMemoryStorage()
  const indexedDb = createFakeIndexedDb({
    schemaVersion: CHAT_HISTORY_SCHEMA,
    updatedAt: now - 1000,
    meta: { checkpoint: { generation: 3, revision: { updatedAt: now - 1000, writerId: 'w1', sequence: 1 } } },
    threads: []
  })
  const store = new ChatHistoryStore({ storage, indexedDb })
  // A fully legacy (idless) shadow: 19 normal + 1 foreign = the 20-thread cap
  // exactly. Without the exemption the oldest could still be evicted because
  // legacyShadow threads are canonical-excluded (the shadow is their ONLY copy).
  const many = Array.from({ length: 19 }, (_, i) => ({
    id: `t${i}`, workflowKey: 'workflow:a', createdAt: now - i, updatedAt: now - i,
    msgs: [{ role: 'user', text: `legacy msg ${i}`, createdAt: now - i }]
  }))
  storage.setItem('comfyui-mcp.panel.threads', JSON.stringify([
    ...many,
    { id: 'foreign-thread', ts: 1, workflowKey: 'workflow:other',
      msgs: [{ role: 'user', text: 'legacy content' }] }
  ]))

  await store.load({})
  await store.flush()

  const shadowThreads = JSON.parse(storage.values.get('comfyui-mcp.panel.threads'))
  assert.ok(
    shadowThreads.some((thread) => thread.id === 'foreign-thread'),
    'the shadow cap must never evict a quarantined thread',
  )
  // And every quarantined thread keeps its shadow copy (none merged into canonical).
  const canonicalAfter = indexedDb.readState()
  assert.equal(
    (canonicalAfter?.threads || []).some((thread) => thread?.id === 'foreign-thread'),
    false,
  )
})
