import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  CHAT_HISTORY_LOCAL_SNAPSHOT_KEY,
  CHAT_HISTORY_SCHEMA,
  ChatHistoryStore,
  createHistoryResetSnapshot,
  isThreadInScope,
  mergeHistorySnapshots,
  normalizeThread,
  panelScopeKeyForBackend,
  resolvePanelPointer,
  retainBoundedThreads,
  selectPanelThread,
  parseHistoryImport,
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

function createFakeIndexedDb(
  initialState = null,
  { blockedThenSuccess = false, stores = ['snapshots'] } = {}
) {
  // KEYED, like the real thing. This used to be a single slot: get() ignored the key
  // and put() replaced everything, so a SECOND key in a store silently destroyed the
  // canonical snapshot. That is exactly how #861's pending-delete marker behaved when
  // it was first tried here, and the failure looked like a bug in the change rather
  // than in the fake. A fake that cannot tell two keys apart cannot test two keys.
  const data = new Map()
  const at = (store, key) => store + ' :: ' + String(key)
  if (initialState != null) data.set(at('snapshots', 'state'), structuredClone(initialState))
  let closeCount = 0

  const createDb = () => ({
    objectStoreNames: { contains: (name) => stores.includes(name) },
    createObjectStore() {},
    close: () => { closeCount += 1 },
    transaction: (names, mode) => {
      const wanted = Array.isArray(names) ? names : [names]
      for (const name of wanted) {
        if (!stores.includes(name)) throw new Error('no object store ' + name)
      }
      const tx = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore: (name = wanted[0]) => ({
          get: (key) => {
            const request = { result: undefined, onsuccess: null, onerror: null }
            queueMicrotask(() => {
              const held = data.get(at(name, key))
              request.result = held === undefined ? undefined : structuredClone(held)
              request.onsuccess?.()
            })
            return request
          },
          getAll: () => {
            const request = { result: [], onsuccess: null, onerror: null }
            queueMicrotask(() => {
              request.result = [...data.entries()]
                .filter(([held]) => held.startsWith(name + ' :: '))
                .map(([, value]) => structuredClone(value))
              request.onsuccess?.()
            })
            return request
          },
          put: (value, key) => {
            assert.equal(mode, 'readwrite')
            data.set(at(name, key === undefined ? 'state' : key), structuredClone(value))
            queueMicrotask(() => tx.oncomplete?.())
            return { onsuccess: null, onerror: null }
          },
          delete: (key) => {
            assert.equal(mode, 'readwrite')
            data.delete(at(name, key))
            queueMicrotask(() => tx.oncomplete?.())
            return { onsuccess: null, onerror: null }
          },
          clear: () => {
            assert.equal(mode, 'readwrite')
            for (const held of [...data.keys()]) {
              if (held.startsWith(name + ' :: ')) data.delete(held)
            }
            queueMicrotask(() => tx.oncomplete?.())
            return { onsuccess: null, onerror: null }
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
    // Still the CANONICAL snapshot specifically, which is what every caller means
    // by readState — now addressed by its key rather than by being the only thing
    // the fake could hold.
    readState: () => {
      const held = data.get(at('snapshots', 'state'))
      return held === undefined ? null : structuredClone(held)
    },
    readAt: (store, key) => {
      const held = data.get(at(store, key))
      return held === undefined ? null : structuredClone(held)
    },
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

test('accepts legacy array exports and rejects unrelated JSON', () => {
  const imported = parseHistoryImport(JSON.stringify([{ id: 'one', ts: 1, msgs: [] }]))
  assert.equal(imported.threads[0].id, 'one')
  assert.throws(() => parseHistoryImport('{"hello":"world"}'), /not a ComfyUI Agent Panel/i)
})

test('exports and merges portable archive payloads without dropping existing chats', () => {
  const store = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb: null,
    broadcastFactory: null
  })
  const exported = store.exportPayload([
    { id: 'portable', ts: 20, title: 'Portable chat', msgs: [] }
  ])
  const merged = store.importPayload(JSON.stringify(exported), [
    { id: 'existing', ts: 10, title: 'Existing chat', msgs: [] }
  ])
  assert.equal(exported.format, 'comfyui-agent-panel-chat-history')
  assert.equal(exported.schemaVersion, CHAT_HISTORY_SCHEMA)
  assert.deepEqual(merged.threads.map((thread) => thread.id), ['existing', 'portable'])
  store.close()
})

test('portable imports cannot carry checkpoints tombstones sessions or active pointers into local history', () => {
  const store = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb: null,
    broadcastFactory: null,
    writerId: 'portable-import-test'
  })
  const currentThread = {
    id: 'local',
    createdAt: 100,
    updatedAt: 100,
    sessionId: 'local-provider-session',
    provider: 'claude',
    msgs: [{ id: 'local-message', role: 'user', text: 'must survive', createdAt: 100 }]
  }
  const currentMeta = {
    workflowAliases: { 'workflows/local.json': 'local-uuid' },
    activeByScope: { 'panel:global': 'local' },
    checkpoint: {
      generation: 2,
      revision: { updatedAt: 200, writerId: 'local-checkpoint', sequence: 1 }
    }
  }
  const maliciousPortable = {
    format: 'comfyui-agent-panel-chat-history',
    schemaVersion: CHAT_HISTORY_SCHEMA,
    threads: [{
      id: 'imported',
      createdAt: 10,
      updatedAt: 10,
      sessionId: 'foreign-session',
      provider: 'codex',
      deletedMessages: { importedMessage: 999999 },
      msgs: [{
        id: 'imported-message',
        role: 'user',
        text: 'portable content',
        createdAt: 10,
        revision: { updatedAt: 999999, writerId: 'foreign', sequence: 9 }
      }]
    }],
    meta: {
      checkpoint: {
        generation: 99,
        revision: { updatedAt: 999999, writerId: 'foreign', sequence: 99 }
      },
      deletedThreads: {
        local: {
          value: null,
          deleted: true,
          updatedAt: 999999,
          revision: { updatedAt: 999999, writerId: 'foreign', sequence: 100 }
        }
      },
      activeByScope: { 'panel:global': 'imported' },
      workflowAliases: {
        'workflows/local.json': 'foreign-overwrite',
        'workflows/imported.json': 'imported-uuid'
      }
    }
  }

  const merged = store.importPayload(
    JSON.stringify(maliciousPortable),
    [currentThread],
    currentMeta
  )
  assert.deepEqual(merged.threads.map((thread) => thread.id), ['local', 'imported'])
  assert.equal(merged.threads.find((thread) => thread.id === 'local').sessionId, 'local-provider-session')
  assert.equal(merged.threads.find((thread) => thread.id === 'imported').sessionId, undefined)
  assert.equal(merged.threads.find((thread) => thread.id === 'imported').msgs[0].text, 'portable content')
  assert.equal(merged.meta.activeByScope['panel:global'], 'local')
  assert.equal(merged.meta.workflowAliases['workflows/local.json'], 'local-uuid')
  assert.equal(merged.meta.workflowAliases['workflows/imported.json'], 'imported-uuid')
  assert.equal(merged.meta.checkpoint.generation, 2)
  assert.equal(merged.importedCount, 1)

  const exported = store.exportPayload(merged.threads, merged.meta)
  const exportedImported = exported.threads.find((thread) => thread.id === 'imported')
  assert.equal(exportedImported.sessionId, undefined)
  assert.equal(exportedImported.createdRevision, undefined)
  assert.equal(exportedImported.fieldOps, undefined)
  assert.equal(exportedImported.msgs[0].revision, undefined)
  assert.equal(exported.meta.checkpoint, undefined)
  assert.equal(exported.meta.deletedThreads, undefined)
  assert.equal(exported.meta.activeByScope, undefined)
  store.close()
})

test('import fails closed instead of evicting local chats at the canonical cap', () => {
  const store = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb: null,
    maxThreads: 500,
    writerId: 'import-cap-test'
  })
  const locals = Array.from({ length: 500 }, (_, index) => ({
    id: `local-${index}`,
    createdAt: index + 1,
    updatedAt: index + 1,
    msgs: []
  }))
  const payload = {
    format: 'comfyui-agent-panel-chat-history',
    schemaVersion: CHAT_HISTORY_SCHEMA,
    threads: [{ id: 'imported-new', createdAt: 9999, updatedAt: 9999, msgs: [] }],
    meta: {}
  }

  assert.throws(
    () => store.importPayload(payload, locals, {}),
    /only 0 of 500 are available.*no history was changed/i
  )
  assert.equal(locals.length, 500)
  assert.equal(locals[0].id, 'local-0')
  store.close()
})

test('import fails closed instead of evicting local messages at the per-thread cap', () => {
  const store = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb: null,
    maxMessages: 5,
    writerId: 'import-message-cap-test'
  })
  const local = {
    id: 'full-chat',
    createdAt: 1,
    updatedAt: 5,
    msgs: Array.from({ length: 5 }, (_, index) => ({
      id: `local-message-${index}`,
      role: 'user',
      text: `local ${index}`,
      createdAt: index + 1
    }))
  }

  assert.throws(
    () => store.importPayload({
      format: 'comfyui-agent-panel-chat-history',
      schemaVersion: CHAT_HISTORY_SCHEMA,
      threads: [{
        id: 'full-chat',
        createdAt: 1,
        updatedAt: 99,
        msgs: [{ id: 'imported-message', role: 'agent', text: 'would evict local', createdAt: 99 }]
      }],
      meta: {}
    }, [local], {}),
    /only 0 of 5 are available.*no history was changed/i
  )
  assert.equal(local.msgs.length, 5)
  assert.equal(local.msgs[0].text, 'local 0')
  store.close()
})

test('same-id imports are add-only and cannot replace local messages or thread fields', () => {
  const store = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb: null,
    writerId: 'import-collision-test'
  })
  const local = {
    id: 'shared-thread',
    createdAt: 100,
    updatedAt: 100,
    workflowKey: 'workflow:local',
    workflowTitle: 'Local workflow',
    provider: 'claude',
    model: 'local-model',
    title: 'Local title',
    todos: [{ text: 'keep local todo', status: 'active' }],
    workflowVersions: {
      same: { hash: 'same', capturedAt: 100, nodeCount: 1, snapshot: { local: true } }
    },
    msgs: [{
      id: 'same-message',
      role: 'user',
      text: 'local body',
      createdAt: 100,
      updatedAt: 100
    }]
  }
  const futureRevision = { updatedAt: 999999, writerId: 'foreign', sequence: 1 }
  const payload = {
    format: 'comfyui-agent-panel-chat-history',
    schemaVersion: CHAT_HISTORY_SCHEMA,
    threads: [{
      id: 'shared-thread',
      createdAt: 100,
      updatedAt: 999999,
      workflowKey: 'workflow:foreign',
      workflowTitle: 'Foreign workflow',
      provider: 'codex',
      model: 'foreign-model',
      fieldOps: {
        title: {
          value: null,
          deleted: true,
          updatedAt: 999999,
          revision: futureRevision
        },
        todos: {
          value: null,
          deleted: true,
          updatedAt: 999999,
          revision: { ...futureRevision, sequence: 2 }
        }
      },
      workflowVersions: {
        same: { hash: 'same', capturedAt: 999999, nodeCount: 999, snapshot: { foreign: true } },
        added: { hash: 'added', capturedAt: 200, nodeCount: 2 }
      },
      msgs: [
        {
          id: 'same-message',
          role: 'agent',
          text: 'foreign replacement',
          createdAt: 100,
          updatedAt: 999999,
          revision: { ...futureRevision, sequence: 3 }
        },
        {
          id: 'new-message',
          role: 'agent',
          text: 'new portable addition',
          createdAt: 200
        }
      ]
    }],
    meta: {}
  }

  const merged = store.importPayload(payload, [local], {})
  const thread = merged.threads[0]
  assert.equal(thread.workflowKey, 'workflow:local')
  assert.equal(thread.workflowTitle, 'Local workflow')
  assert.equal(thread.provider, 'claude')
  assert.equal(thread.model, 'local-model')
  assert.equal(thread.title, 'Local title')
  assert.deepEqual(thread.todos, [{ text: 'keep local todo', status: 'active' }])
  assert.equal(thread.msgs.find((message) => message.id === 'same-message').text, 'local body')
  assert.equal(thread.msgs.find((message) => message.id === 'new-message').text, 'new portable addition')
  assert.deepEqual(thread.workflowVersions.same.snapshot, { local: true })
  assert.equal(thread.workflowVersions.added.nodeCount, 2)
  store.close()
})

test('imported aliases fill bounded free slots without evicting local aliases', () => {
  const store = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb: null,
    maxMetadataOps: 512,
    writerId: 'import-alias-cap-test'
  })
  const localAliases = Object.fromEntries(
    Array.from({ length: 511 }, (_, index) => [`workflows/local-${index}.json`, `uuid-${index}`])
  )
  const importedAliases = Object.fromEntries(
    Array.from({ length: 600 }, (_, index) => [`workflows/imported-${index}.json`, `imported-${index}`])
  )
  const merged = store.importPayload({
    format: 'comfyui-agent-panel-chat-history',
    schemaVersion: CHAT_HISTORY_SCHEMA,
    threads: [],
    meta: { workflowAliases: importedAliases }
  }, [], { workflowAliases: localAliases })

  assert.equal(Object.keys(merged.meta.workflowAliases).length, 512)
  assert.equal(merged.meta.workflowAliases['workflows/local-0.json'], 'uuid-0')
  assert.equal(merged.meta.workflowAliases['workflows/local-510.json'], 'uuid-510')
  assert.equal(merged.meta.workflowAliases['workflows/imported-0.json'], 'imported-0')
  assert.equal(merged.importedAliasCount, 1)
  assert.equal(merged.skippedAliasCount, 599)
  store.close()
})

test('duplicate imported records cannot crowd local workflow versions out of a colliding chat', () => {
  const store = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb: null,
    writerId: 'import-version-cap-test'
  })
  const localVersions = Object.fromEntries(
    Array.from({ length: 19 }, (_, index) => [
      `local-${index}`,
      { hash: `local-${index}`, capturedAt: index + 1, nodeCount: index + 1 }
    ])
  )
  const payload = {
    format: 'comfyui-agent-panel-chat-history',
    schemaVersion: CHAT_HISTORY_SCHEMA,
    threads: [
      {
        id: 'shared-thread',
        createdAt: 1,
        updatedAt: 999,
        workflowVersions: {
          'imported-a': { hash: 'imported-a', capturedAt: 999_999, nodeCount: 100 }
        },
        msgs: []
      },
      {
        id: 'shared-thread',
        createdAt: 1,
        updatedAt: 1_000,
        workflowVersions: {
          'imported-b': { hash: 'imported-b', capturedAt: 1_000_000, nodeCount: 101 }
        },
        msgs: []
      }
    ],
    meta: {}
  }

  const merged = store.importPayload(payload, [{
    id: 'shared-thread',
    createdAt: 1,
    updatedAt: 1,
    workflowVersions: localVersions,
    msgs: []
  }], {})
  const versions = merged.threads[0].workflowVersions

  assert.equal(Object.keys(versions).length, 20)
  for (const hash of Object.keys(localVersions)) assert.ok(versions[hash], `${hash} must survive`)
  assert.ok(versions['imported-a'] || versions['imported-b'])
  store.close()
})

test('rejects exports from a future history schema', () => {
  assert.throws(
    () => parseHistoryImport(JSON.stringify({
      format: 'comfyui-agent-panel-chat-history',
      schemaVersion: CHAT_HISTORY_SCHEMA + 1,
      threads: []
    })),
    /newer than this panel supports/i
  )
})

test('unions concurrent workflow versions instead of replacing the older map', () => {
  const merged = mergeHistorySnapshots(
    {
      threads: [{
        id: 'versioned',
        createdAt: 1,
        updatedAt: 10,
        msgs: [],
        workflowVersions: {
          alpha: { hash: 'alpha', capturedAt: 10, nodeCount: 1 }
        }
      }],
      meta: {}
    },
    {
      threads: [{
        id: 'versioned',
        createdAt: 1,
        updatedAt: 20,
        msgs: [],
        workflowVersions: {
          beta: { hash: 'beta', capturedAt: 20, nodeCount: 2 }
        }
      }],
      meta: {}
    }
  )
  assert.deepEqual(Object.keys(merged.threads[0].workflowVersions).sort(), ['alpha', 'beta'])
})

test('bounds workflow versions and drops only oversized snapshots', () => {
  const workflowVersions = Object.fromEntries(
    Array.from({ length: 25 }, (_, index) => {
      const hash = `version-${index}`
      return [hash, {
        hash,
        capturedAt: index + 1,
        nodeCount: index,
        snapshot: index === 24 ? { payload: 'x'.repeat(300_001) } : { nodes: [] }
      }]
    })
  )
  const normalized = normalizeThread({
    id: 'bounded-versions',
    ts: 1,
    msgs: [],
    workflowVersions
  })
  assert.equal(Object.keys(normalized.workflowVersions).length, 20)
  assert.ok(normalized.workflowVersions['version-24'])
  assert.equal(normalized.workflowVersions['version-24'].snapshot, undefined)
  assert.equal(normalized.workflowVersions['version-24'].nodeCount, 24)
  assert.equal(normalized.workflowVersions['version-0'], undefined)
})

test('workflow snapshot cap counts UTF-8 bytes instead of UTF-16 code units', () => {
  const normalized = normalizeThread({
    id: 'unicode-version',
    ts: 1,
    msgs: [],
    workflowVersions: {
      unicode: {
        hash: 'unicode',
        capturedAt: 1,
        nodeCount: 1,
        // 120k CJK characters are 360k UTF-8 bytes, despite fitting in 120k
        // JavaScript UTF-16 code units.
        snapshot: { payload: '界'.repeat(120_000) }
      }
    }
  })
  assert.equal(normalized.workflowVersions.unicode.snapshot, undefined)
  assert.equal(normalized.workflowVersions.unicode.nodeCount, 1)
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

// mcp#884 upgrade guard: a build that still had the workflow/ask scopes could
// leave the panel:global pointer behind and keep SELECTING per-workflow
// threads (the retired mode stamped a workflow-scoped active op on every
// thread creation and open). On upgrade the newest SELECTION wins — message
// timestamps are deliberately not evidence (gate P0-3: imports, straggler
// writes, and skewed clocks carry newer messages without any user selection).
test('a stale panel pointer loses to a newer retired-mode selection, never to mere messages', () => {
  const threads = [
    {
      id: 'stale-panel-thread',
      workflowKey: 'panel:global',
      updatedAt: 1_000,
      msgs: [{ id: 'old-msg', role: 'user', text: 'months ago', createdAt: 1_000 }]
    },
    {
      id: 'current-workflow-thread',
      workflowKey: 'workflow:wf-current',
      updatedAt: 9_000,
      msgs: [{ id: 'new-msg', role: 'user', text: 'this week', createdAt: 9_000 }]
    }
  ]
  const stalePanelPointer = updateMetadataEntry(
    {},
    'activeByScope',
    'panel:global',
    'stale-panel-thread',
    { updatedAt: 1_001, writerId: 'old-build', sequence: 1 }
  )

  // The retired workflow mode recorded its selection as a workflow-scoped op —
  // newer than the abandoned panel pointer, so it wins.
  const withWorkflowSelection = updateMetadataEntry(
    stalePanelPointer,
    'activeByScope',
    'workflow:wf-current',
    'current-workflow-thread',
    { updatedAt: 8_000, writerId: 'old-build', sequence: 2 }
  )
  assert.equal(selectPanelThread(threads, withWorkflowSelection)?.id, 'current-workflow-thread')

  // Same result when the panel op was compacted into the checkpoint baseline
  // (value survives, its revision does not).
  const compactedPanelValue = {
    activeByScope: {
      'panel:global': 'stale-panel-thread',
      'workflow:wf-current': 'current-workflow-thread'
    },
    activeOps: withWorkflowSelection.activeOps && Object.fromEntries(
      Object.entries(withWorkflowSelection.activeOps)
        .filter(([key]) => key !== 'panel:global')
    )
  }
  assert.equal(selectPanelThread(threads, compactedPanelValue)?.id, 'current-workflow-thread')

  // A panel pointer stamped AFTER the workflow selection (the user returned to
  // panel mode / opened a chat from the archive) is the latest selection and
  // sticks.
  const returnedToPanel = updateMetadataEntry(
    withWorkflowSelection,
    'activeByScope',
    'panel:global',
    'stale-panel-thread',
    { updatedAt: 9_500, writerId: 'archive-open', sequence: 3 }
  )
  assert.equal(selectPanelThread(threads, returnedToPanel)?.id, 'stale-panel-thread')

  // Gate P0-3: newer MESSAGES without any selection op (an imported archive
  // keeps its original createdAt; a straggler write lands without a pointer
  // move) never steal the selection.
  assert.equal(selectPanelThread(threads, stalePanelPointer)?.id, 'stale-panel-thread')

  // A retired-mode op whose target no longer exists is not evidence either.
  const danglingWorkflowSelection = updateMetadataEntry(
    stalePanelPointer,
    'activeByScope',
    'workflow:wf-gone',
    'deleted-thread',
    { updatedAt: 8_000, writerId: 'old-build', sequence: 2 }
  )
  assert.equal(selectPanelThread(threads, danglingWorkflowSelection)?.id, 'stale-panel-thread')
})

// Gate P0-2: the selection pointer is BACKEND-scoped (one conversation per
// backend, mirroring the orchestrator's orchestrator::<backend> session key).
test('panel selection is backend-scoped with a one-way legacy fallback', () => {
  // `provider` is the ownership stamp record() writes on mint and on every append.
  // It is what forks the LEGACY route per backend (mcp#884) — see the dedicated
  // upgrade test below.
  const threads = [
    { id: 'claude-thread', provider: 'claude', updatedAt: 100, msgs: [] },
    { id: 'codex-thread', provider: 'codex', updatedAt: 200, msgs: [] },
    { id: 'legacy-thread', provider: 'claude', updatedAt: 50, msgs: [] }
  ]
  let meta = updateMetadataEntry(
    {},
    'activeByScope',
    'panel:backend:claude',
    'claude-thread',
    { updatedAt: 1_000, writerId: 'claude-tab', sequence: 1 }
  )
  meta = updateMetadataEntry(
    meta,
    'activeByScope',
    'panel:backend:codex',
    'codex-thread',
    { updatedAt: 2_000, writerId: 'codex-tab', sequence: 1 }
  )

  // Each backend resolves its own conversation; the other backend's newer
  // selection is not evidence for this one.
  assert.equal(
    selectPanelThread(threads, meta, { scopeKey: 'panel:backend:claude' })?.id,
    'claude-thread'
  )
  assert.equal(
    selectPanelThread(threads, meta, { scopeKey: 'panel:backend:codex' })?.id,
    'codex-thread'
  )

  // A backend key never written falls back to the legacy shared pointer...
  const legacyOnly = updateMetadataEntry(
    {},
    'activeByScope',
    'panel:global',
    'legacy-thread',
    { updatedAt: 500, writerId: 'pre-upgrade', sequence: 1 }
  )
  assert.equal(resolvePanelPointer(legacyOnly, 'panel:backend:claude').activeId, 'legacy-thread')
  assert.equal(
    selectPanelThread(threads, legacyOnly, { scopeKey: 'panel:backend:claude' })?.id,
    'legacy-thread'
  )

  // ...but a written backend key (including a deliberate CLEAR) never falls
  // back: migration is one-way per backend.
  const cleared = updateMetadataEntry(
    legacyOnly,
    'activeByScope',
    'panel:backend:claude',
    null,
    { updatedAt: 1_500, writerId: 'claude-tab', sequence: 2 }
  )
  const clearedPointer = resolvePanelPointer(cleared, 'panel:backend:claude')
  assert.equal(clearedPointer.activeId, null)
  assert.equal(clearedPointer.cleared, true)
  assert.equal(selectPanelThread(threads, cleared, { scopeKey: 'panel:backend:claude' }), null)
  // The legacy pointer serves other backends only where it can — and it CANNOT here.
  // `legacy-thread` is claude's (provider: 'claude'); handing it to codex as well is
  // precisely the shared-transcript corruption the fork rule exists to stop. Codex
  // resolves its OWN most recent conversation instead.
  assert.equal(
    selectPanelThread(threads, cleared, { scopeKey: 'panel:backend:codex' })?.id,
    'codex-thread'
  )
})

test('mcp#884 UPGRADE: one legacy pointer never becomes TWO backends conversation', () => {
  // THE UPGRADE PATH EVERY EXISTING USER TAKES. A pre-upgrade snapshot has a single
  // shared `panel:global` pointer and no per-backend keys, so before the fork every
  // backend key fell back to the SAME thread id. Claude and Codex both claimed it,
  // `loadThread` scrubbed its foreign session, and `record()` rewrote its provider on
  // every append — two providers sharing and corrupting one transcript.
  const legacy = { id: 'the-one-conversation', provider: 'claude', updatedAt: 500, msgs: [] }
  const meta = updateMetadataEntry(
    {},
    'activeByScope',
    'panel:global',
    'the-one-conversation',
    { updatedAt: 500, writerId: 'pre-upgrade', sequence: 1 }
  )

  const forClaude = selectPanelThread([legacy], meta, { scopeKey: 'panel:backend:claude' })
  const forCodex = selectPanelThread([legacy], meta, { scopeKey: 'panel:backend:codex' })

  // The owner keeps it — the single-backend upgrade, which is the common case, is
  // completely unaffected.
  assert.equal(forClaude?.id, 'the-one-conversation', 'the owning backend still adopts it')
  // …and nobody else does.
  assert.equal(forCodex, null, 'a second backend must NOT resolve the same conversation')
  assert.notEqual(
    forClaude?.id,
    forCodex?.id,
    'two backends resolving one thread id is the corruption this rule exists to prevent'
  )

  // Stated for a third backend too: the rule is "only the owner", not "only the second
  // one loses".
  assert.equal(selectPanelThread([legacy], meta, { scopeKey: 'panel:backend:gemini' }), null)

  // The legacy thread is NOT deleted — it stays in history and opens through the picker
  // like any archived conversation, exactly as the retired per-workflow threads do.
  assert.ok([legacy].includes(legacy))
})

test('mcp#884 UPGRADE: a provider-less legacy thread fails CLOSED rather than into every backend', () => {
  // Very old snapshots can carry a thread with no provider stamp. There is no evidence
  // of ownership, so no backend auto-adopts it: fail-open here is exactly the collision
  // above, and the cost of failing closed is bounded and non-destructive (the
  // conversation stays in history and opens through the picker).
  const orphan = { id: 'no-provider', updatedAt: 500, msgs: [] }
  const meta = updateMetadataEntry(
    {},
    'activeByScope',
    'panel:global',
    'no-provider',
    { updatedAt: 500, writerId: 'pre-upgrade', sequence: 1 }
  )
  for (const backend of ['claude', 'codex', 'gemini']) {
    assert.equal(
      selectPanelThread([orphan], meta, { scopeKey: `panel:backend:${backend}` }),
      null,
      `${backend} must not claim a conversation nothing attributes to it`
    )
  }
})

test('mcp#884 UPGRADE: the no-pointer recency fallback is forked per backend too', () => {
  // The OTHER door into the same collision, and the one a fix aimed only at the legacy
  // POINTER would miss: a snapshot with no panel pointer at all fell through to
  // "most recently updated thread", which is equally the same id for every backend.
  const threads = [
    { id: 'codex-newest', provider: 'codex', updatedAt: 900, msgs: [] },
    { id: 'claude-older', provider: 'claude', updatedAt: 100, msgs: [] }
  ]
  assert.equal(
    selectPanelThread(threads, {}, { scopeKey: 'panel:backend:claude' })?.id,
    'claude-older',
    'claude falls back to ITS most recent conversation, not the globally newest one'
  )
  assert.equal(
    selectPanelThread(threads, {}, { scopeKey: 'panel:backend:codex' })?.id,
    'codex-newest'
  )
})

test("mcp#884 another backend's selection never competes — even for a thread THIS backend could claim", () => {
  // REGRESSION GUARD FOR THE GUARD. The `panel:` skip in the compete loop was
  // previously pinned by a fixture whose threads had no provider. Adding the upgrade
  // fork MASKED that: another backend's op now usually resolves to a thread this
  // backend cannot claim anyway, so deleting the skip stopped failing anything.
  //
  // The two rules are NOT the same rule. The fork asks "could this backend own the
  // thread"; the skip asks "is another backend's selection evidence for mine". A
  // thread whose provider matches BOTH questions separates them — which is exactly
  // reachable, because a thread's provider changes when the user switches backends
  // while it is open.
  const threads = [
    { id: 'mine', provider: 'codex', updatedAt: 100, msgs: [] },
    // Same provider, so the fork happily allows it. Only the `panel:` skip stops it.
    { id: 'claudes-pick', provider: 'codex', updatedAt: 900, msgs: [] }
  ]
  let meta = updateMetadataEntry(
    {},
    'activeByScope',
    'panel:backend:codex',
    'mine',
    { updatedAt: 1_000, writerId: 'codex-tab', sequence: 1 }
  )
  // Written LATER, under ANOTHER backend's key. If it were allowed to compete it would
  // win on revision and move codex onto claude's conversation.
  meta = updateMetadataEntry(
    meta,
    'activeByScope',
    'panel:backend:claude',
    'claudes-pick',
    { updatedAt: 9_000, writerId: 'claude-tab', sequence: 2 }
  )

  assert.equal(
    selectPanelThread(threads, meta, { scopeKey: 'panel:backend:codex' })?.id,
    'mine',
    "a Claude tab's newer selection must not move the Codex conversation"
  )
  // And the mirror, so the rule is not "codex always wins".
  assert.equal(
    selectPanelThread(threads, meta, { scopeKey: 'panel:backend:claude' })?.id,
    'claudes-pick'
  )
})

test('mcp#884 a backend pointer this backend WROTE is honoured whatever the provider stamp says', () => {
  // The fork must not become a second, stricter gate on normal operation. A thread
  // legitimately changes provider when the user switches backends while it is open, so
  // a pointer the backend wrote for itself is its own evidence and outranks the stamp.
  const threads = [{ id: 'mine', provider: 'claude', updatedAt: 100, msgs: [] }]
  const meta = updateMetadataEntry(
    {},
    'activeByScope',
    'panel:backend:codex',
    'mine',
    { updatedAt: 1_000, writerId: 'codex-tab', sequence: 1 }
  )
  assert.equal(
    selectPanelThread(threads, meta, { scopeKey: 'panel:backend:codex' })?.id,
    'mine',
    'codex selected this conversation itself — the stale provider stamp must not veto that'
  )
})

test('metadata-only edits on an archived chat never steal the panel selection', () => {
  // Rename/pin bump thread.updatedAt without new messages; grooming the archive
  // must not hijack the conversation every tab is in.
  const threads = [
    {
      id: 'active-conversation',
      workflowKey: 'workflow:wf-a',
      updatedAt: 5_000,
      msgs: [{ id: 'live-msg', role: 'user', text: 'live', createdAt: 5_000 }]
    },
    {
      id: 'renamed-archive',
      workflowKey: 'workflow:wf-b',
      updatedAt: 9_999,
      title: 'freshly renamed',
      msgs: [{ id: 'archived-msg', role: 'user', text: 'archived', createdAt: 100 }]
    }
  ]
  const meta = updateMetadataEntry(
    {},
    'activeByScope',
    'panel:global',
    'active-conversation',
    { updatedAt: 4_000, writerId: 'writer', sequence: 1 }
  )

  assert.equal(selectPanelThread(threads, meta)?.id, 'active-conversation')
})

// mcp#884/#897: with the agent session orchestrator-global, the SHARED pointer
// is authoritative on reload — a tab preference only bridges legacy snapshots
// that predate the shared pointer.
test('reload keeps the tab-pointed panel conversation only until a shared pointer exists', () => {
  const threads = [
    { id: 'visible', workflowKey: 'workflow:wf-a', updatedAt: 100, msgs: [] },
    { id: 'newer-background', workflowKey: 'workflow:wf-b', updatedAt: 999, msgs: [] }
  ]

  // Legacy snapshot (no panel:global pointer): the tab pointer is the only
  // record of what this tab had open, so honor it.
  assert.equal(selectRestoreThread(threads, {}, {
    panelOwned: true,
    preferredThreadId: 'visible'
  })?.id, 'visible')

  // Shared pointer present: every tab must restore the same conversation the
  // orchestrator's single session is in, tab preference notwithstanding.
  const shared = updateMetadataEntry(
    {},
    'activeByScope',
    'panel:global',
    'newer-background',
    { updatedAt: 2_000, writerId: 'other-tab', sequence: 1 }
  )
  assert.equal(selectRestoreThread(threads, shared, {
    panelOwned: true,
    preferredThreadId: 'visible'
  })?.id, 'newer-background')

  // A deliberately cleared pointer (new chat elsewhere) restores the empty
  // view, not the tab's old conversation.
  const cleared = updateMetadataEntry(
    {},
    'activeByScope',
    'panel:global',
    null,
    { updatedAt: 2_000, writerId: 'other-tab', sequence: 1 }
  )
  assert.equal(selectRestoreThread(threads, cleared, {
    panelOwned: true,
    preferredThreadId: 'visible'
  }), null)

  // A DANGLING pointer (its thread was evicted or lost in a partial merge)
  // says nothing about which conversation the global session is in — the tab
  // that was just using one is better evidence than guessing by recency.
  const dangling = updateMetadataEntry(
    {},
    'activeByScope',
    'panel:global',
    'evicted-thread',
    { updatedAt: 2_000, writerId: 'other-tab', sequence: 1 }
  )
  assert.equal(selectRestoreThread(threads, dangling, {
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
  const failures = []
  const store = new ChatHistoryStore({
    storage,
    indexedDb: null,
    onPersistenceError: (failure) => failures.push(failure)
  })
  store.persist(threads, { activeByScope: { 'panel:global': 't0' } })
  const result = await store.flush()

  const shadow = JSON.parse(values.get('comfyui-mcp.panel.threads'))
  assert.deepEqual(result, {
    ok: false,
    shadowCommitted: true,
    canonicalCommitted: false,
    retryable: true,
    code: 'history-canonical-unavailable-shadow-truncated'
  })
  assert.equal(failures.length, 1)
  assert.equal(store._dirtyWrite.snapshot.threads.length, 21)
  assert.equal(shadow.length, 20)
  assert.equal(shadow.some((thread) => thread.id === 't0'), true)
  assert.equal(shadow.some((thread) => thread.id === 't1'), false)
  assert.equal(store.readLocal().threads.some((thread) => thread.id === 't0'), true)
  const degradedStore = new ChatHistoryStore({ storage, indexedDb: null })
  const degradedReload = await degradedStore.load({ protectedThreadIds: ['t0'] })
  await degradedStore.flush()
  assert.equal(degradedReload.threads.some((thread) => thread.id === 't0'), true)
})

test('canonical compaction bounds materialized aliases as well as alias operations', async () => {
  const indexedDb = createFakeIndexedDb()
  const aliases = Object.fromEntries(
    Array.from({ length: 600 }, (_, index) => [`workflows/alias-${index}.json`, `uuid-${index}`])
  )
  const store = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb,
    maxMetadataOps: 512,
    writerId: 'materialized-alias-cap-test'
  })

  store.persist([], { updatedAt: 1_000, workflowAliases: aliases })
  assert.equal(await store.flush(), true)

  const canonical = indexedDb.readState()
  assert.equal(Object.keys(canonical.meta.workflowAliases).length, 512)
  assert.equal(Object.keys(canonical.meta.aliasOps).length, 512)
  assert.equal(canonical.meta.checkpoint.generation, 1)
  const droppedPath = Object.keys(aliases).find(
    (path) => !Object.hasOwn(canonical.meta.workflowAliases, path)
  )
  assert.ok(droppedPath)

  const stale = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb,
    maxMetadataOps: 512,
    writerId: 'stale-alias-writer'
  })
  stale.persist([], {
    workflowAliases: { [droppedPath]: 'must-not-resurrect' },
    aliasOps: {
      [droppedPath]: {
        value: 'must-not-resurrect',
        deleted: false,
        updatedAt: 1,
        revision: { updatedAt: 1, writerId: 'stale-alias-writer', sequence: 1 }
      }
    }
  })
  await stale.flush()
  const reloaded = await store.readCanonical()
  assert.equal(Object.hasOwn(reloaded.meta.workflowAliases, droppedPath), false)
  stale.close()
  store.close()
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
  // A fully legacy (idless) shadow above both ordinary local-shadow caps.
  // These threads are canonical-excluded, so their shadow is the only copy.
  const many = Array.from({ length: 21 }, (_, i) => ({
    id: `t${i}`, workflowKey: 'workflow:a', createdAt: now - i, updatedAt: now - i,
    msgs: Array.from({ length: i === 0 ? 201 : 1 }, (_, j) => ({
      role: 'user',
      text: `legacy msg ${i}:${j}`,
      createdAt: now - i + j,
    })),
  }))
  storage.setItem('comfyui-mcp.panel.threads', JSON.stringify([
    ...many,
    { id: 'foreign-thread', ts: 1, workflowKey: 'workflow:other',
      msgs: [{ role: 'user', text: 'legacy content' }] }
  ]))

  await store.load({})
  await store.flush()

  const shadowThreads = JSON.parse(storage.values.get('comfyui-mcp.panel.threads'))
  assert.equal(
    shadowThreads.length,
    22,
    'the shadow cap must retain every quarantined thread',
  )
  assert.equal(
    shadowThreads.find((thread) => thread.id === 't0')?.msgs.length,
    201,
    'the message cap must retain the full only-copy transcript',
  )
  assert.ok(shadowThreads.some((thread) => thread.id === 'foreign-thread'))
  // And every quarantined thread keeps its shadow copy (none merged into canonical).
  const canonicalAfter = indexedDb.readState()
  assert.equal(
    (canonicalAfter?.threads || []).some((thread) => thread?.id === 'foreign-thread'),
    false,
  )
})

test('a canonical commit cannot hide failure to save a legacyShadow only-copy transcript', async () => {
  const failures = []
  const indexedDb = createFakeIndexedDb({
    schemaVersion: CHAT_HISTORY_SCHEMA,
    updatedAt: 1,
    meta: { checkpoint: { generation: 1, revision: { updatedAt: 1, writerId: 'seed', sequence: 1 } } },
    threads: []
  })
  const store = new ChatHistoryStore({
    storage: createMemoryStorage({ throwOnSet: CHAT_HISTORY_LOCAL_SNAPSHOT_KEY }),
    indexedDb,
    writerId: 'legacy-shadow-quota-test',
    onPersistenceError: (failure) => failures.push(failure)
  })

  store.persist([{
    id: 'legacy-only',
    legacyShadow: true,
    createdAt: 10,
    updatedAt: 10,
    msgs: [{ id: 'legacy-message', role: 'user', text: 'only copy', createdAt: 10 }]
  }], {})
  const result = await store.flush()

  assert.deepEqual(result, {
    ok: false,
    shadowCommitted: false,
    canonicalCommitted: true,
    retryable: true,
    code: 'history-legacy-shadow-unavailable'
  })
  assert.equal(failures.length, 1)
  assert.equal(store._dirtyWrite.snapshot.threads[0].id, 'legacy-only')
  assert.equal(
    (indexedDb.readState()?.threads || []).some((thread) => thread.id === 'legacy-only'),
    false,
    'the schema fence must still exclude the legacy-only transcript from canonical IndexedDB',
  )
  store.close()
})

test('#1171 flush() SETTLES even when IndexedDB never answers', async () => {
  // Relied on by the panel: hardRestart holds the reload re-entrancy guard across
  // `invalidateDurableAgentSession()`, which awaits this. If flush() could hang, that guard
  // would latch for the rest of the session. A bound was added in the panel for that fear
  // and removed again once this property was established, so it is pinned here.
  //
  // The worst slow store there is: an `open` request that fires NO handler at all.
  const hungIndexedDb = {
    open: () => ({
      set onsuccess(_) {},
      set onerror(_) {},
      set onblocked(_) {},
      set onupgradeneeded(_) {}
    })
  }
  const store = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb: hungIndexedDb,
    broadcastFactory: null
  })
  store.persist([{ id: 't1', ts: 1, title: 'hung', msgs: [] }], {}, { maxThreads: 10, maxMessages: 10 })
  const started = Date.now()
  const result = await store.flush()
  const elapsed = Date.now() - started
  // Settles on the store's OWN open cap (IDB_OPEN_TIMEOUT_MS, 2000) rather than waiting
  // forever. The slack is for CI scheduling, not for a second cap hiding behind this one.
  assert.ok(elapsed < 4000, `flush() took ${elapsed}ms — it must settle on the open cap, not hang`)
  // For a history INSIDE the local shadow's limits it also reports success — and via
  // `result.ok === true`, because the shadow write is complete. (An earlier comment here
  // claimed flush() got there by mapping a null result to true; that is a different branch
  // and not the one this case takes.)
  //
  // WORTH BEING PRECISE ABOUT WHAT THAT TRUE MEANS: the CANONICAL IndexedDB write did not
  // happen — the open was capped — so success here rests on the local shadow alone. The
  // panel's caller is named `invalidateDurableAgentSession`, and on this path it reports
  // durable invalidation when only the shadow carries it. That is the store's existing
  // contract rather than anything this branch changes, but it is the reason the word
  // "durable" is doing less work than it looks like it is.
  assert.equal(result, true, 'a capped open must not read as a failed write for a small history')
  store.close()
})

test('#1171 a capped open reports failure exactly past the local shadow boundary', async () => {
  // The other half, and the one a first probe missed by testing a five-message thread and
  // generalising. A capped open makes idbMergeWrite yield null, so persist() falls back to
  // the LOCAL SHADOW's completeness — and the shadow is deliberately partial past
  // LOCAL_SHADOW_THREADS (20) and LOCAL_SHADOW_MESSAGES (200).
  //
  // Pinned AT the boundary rather than at some comfortably-past size, so this test says
  // where the behaviour actually changes instead of merely that it changes somewhere.
  //
  // Why the panel cares: invalidateDurableAgentSession() maps a non-true flush to "could
  // not invalidate durably", so for any user past these limits a two-second disk hiccup
  // answers false — which its callers must treat as "could not CONFIRM" rather than "the
  // store is broken" (#1184).
  // FAILS immediately rather than hanging. What this test needs is "the canonical write did
  // not happen", and openDb() resolves null on onerror exactly as it does on its 2s cap —
  // same downstream path, no wall-clock wait. Hanging here cost four seconds of suite time
  // per case to prove something the settle test above already proves once.
  const failingIndexedDb = {
    open: () => {
      const req = {}
      queueMicrotask(() => req.onerror?.())
      return req
    }
  }
  const thread = (id, n) => ({ id, ts: 1, title: id, msgs: Array.from({ length: n }, (_, i) => ({ id: id + i, role: 'user', text: 'x' })) })
  const cases = [
    ['200 messages — at the limit', [thread('t', 200)], true],
    ['201 messages — one past it', [thread('t', 201)], false],
    ['20 threads — at the limit', Array.from({ length: 20 }, (_, t) => thread('t' + t, 1)), true],
    ['21 threads — one past it', Array.from({ length: 21 }, (_, t) => thread('t' + t, 1)), false]
  ]
  for (const [label, threads, expectOk] of cases) {
    const store = new ChatHistoryStore({
      storage: createMemoryStorage(),
      indexedDb: failingIndexedDb,
      broadcastFactory: null
    })
    store.persist(threads, {}, { maxThreads: 500, maxMessages: 1000 })
    const result = await store.flush()
    if (expectOk) {
      assert.equal(result, true, `${label}: a complete shadow still confirms`)
    } else {
      assert.notEqual(result, true, `${label}: a partial shadow must not claim a durable write`)
      assert.equal(result?.ok, false, `${label}: and it reports why`)
    }
    store.close()
  }
})
// ---------------------------------------------------------------------------
// mcp#884 — THE INVARIANT, pinned as a gate rather than left to inspection.
//
// User-selectable workflow/ask scope is retired, but Grok's real provider state
// intentionally reaches the existing dedicated branch. These assertions keep
// that decision independent from persisted scope settings.
// ---------------------------------------------------------------------------

const PANEL_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../web/js/comfyui-mcp-panel.js'),
  'utf8'
).replace(/\r\n/g, '\n')

/** The body of a top-level `function name() {` … column-0 `}`. */
function topLevelFunction(name) {
  const start = PANEL_SRC.indexOf(`\nfunction ${name}(`)
  assert.notEqual(start, -1, `${name}() must exist as a top-level function`)
  const end = PANEL_SRC.indexOf('\n}\n', start)
  assert.ok(end > start, `${name}() must be closed`)
  return PANEL_SRC.slice(start, end)
}

test('mcp#884 chatScopeMode follows the real provider, never a stored scope setting', () => {
  const body = topLevelFunction('chatScopeMode')
  assert.match(body, /backend\s*===\s*['"]grok['"]/, 'Grok must reach the dedicated provider branch')
  assert.ok(!/getSetting|localStorage|sessionStorage/.test(body), 'it reads no stored value')
  const chatScopeMode = new Function(`${body}\n}\nreturn chatScopeMode;`)()
  assert.equal(chatScopeMode('grok'), 'workflow')
  assert.equal(chatScopeMode('claude'), 'panel')
})

test('mcp#884 no chat-scope setting is registered any more', () => {
  const start = PANEL_SRC.indexOf('function panelSettingsList() {')
  assert.notEqual(start, -1)
  const body = PANEL_SRC.slice(start, PANEL_SRC.indexOf('\n}\n', start))
  // The combo is what wrote the value chatScopeMode() used to read. A row for it
  // cannot come back without this failing.
  assert.ok(!/SETTING_CHAT_SCOPE/.test(body), 'the "Chat conversation scope" row stays retired')
  assert.ok(!/SETTING_SESSION_FOLLOWS_PANEL/.test(body), 'the legacy boolean stays retired')
  assert.ok(!/applyChatScope/.test(PANEL_SRC.replace(/\/\/[^\n]*/g, '')), 'no live scope switcher hook')
})

test('mcp#884 currentHistoryScopeKey resolves to a backend axis for a panel-owned chat', () => {
  const at = PANEL_SRC.indexOf('function currentHistoryScopeKey(')
  assert.notEqual(at, -1)
  const body = PANEL_SRC.slice(at, PANEL_SRC.indexOf('\n  }\n', at))
  // The workflow branch is the unreachable one and must STAY behind the guard —
  // if the guard is ever deleted, the remaining return must still be the backend
  // key, never workflowStorageKey().
  // The key is built by the store's exported helper now (mcp#884), so the panel and the
  // backend-switch path cannot interpolate two different shapes for the same axis.
  assert.match(
    body,
    /return panelScopeKeyForBackend\(/,
    'the panel-owned answer is keyed on the backend, the same axis as orchestrator::<backend>'
  )
  // …and the helper really does produce that axis, so this is not just a rename.
  assert.equal(panelScopeKeyForBackend('codex'), 'panel:backend:codex')
  assert.equal(panelScopeKeyForBackend(null), 'panel:backend:claude', 'the documented default')
  const wfReturn = /if \(!historyScopeFollowsPanel\(\)\) return workflowStorageKey/.test(body)
  assert.ok(wfReturn, 'the workflow key is reachable ONLY through the historyScopeFollowsPanel() guard')
})

test('mcp#884 every selection-pointer WRITE uses the backend key, never a workflow key', () => {
  // The pointer is the one piece of state that decides which conversation a tab
  // renders and records into. If any writer can address it by a workflow key, the
  // conversation is workflow-scoped again no matter what chatScopeMode() says.
  const writes = [...PANEL_SRC.matchAll(/setActiveThread\(\s*([^,]+),/g)]
    .map((m) => m[1].trim())
    .filter((arg) => arg !== 'scopeKey' || false)
  const allowed = new Set([
    'currentHistoryScopeKey()', // the backend key
    'scopeKey', // a local already assigned from currentHistoryScopeKey()
    'key' // the delete sweep, iterating keys that already exist in metadata
  ])
  const offenders = writes.filter((arg) => !allowed.has(arg))
  assert.deepEqual(offenders, [], `setActiveThread called with a non-backend scope key: ${offenders.join(', ')}`)

  // …and the one `scopeKey` local really is the backend key, not a workflow one.
  assert.match(
    PANEL_SRC,
    /const scopeKey = currentHistoryScopeKey\(\);/,
    'the scopeKey local is assigned from currentHistoryScopeKey()'
  )
})

test('mcp#884 the workflow-keyed session bind is unreachable while the chat is panel-owned', () => {
  // `ssSet(SESSION_KEY, existing?.sessionId || null)` in onWorkflowMaybeChanged is
  // the exact line that made a session belong to a WORKFLOW. It still exists, and
  // it is only safe because the panel-owned branch returns before reaching it.
  const at = PANEL_SRC.indexOf('function onWorkflowMaybeChanged() {')
  assert.notEqual(at, -1)
  const body = PANEL_SRC.slice(at, PANEL_SRC.indexOf('\n  }\n', at))
  const guardAt = body.indexOf('if (followsPanel) {')
  assert.ok(guardAt > -1, 'the panel-owned branch exists')
  // The guard block must END in a return, so nothing below it can run.
  const afterGuard = body.slice(guardAt)
  const guardEnd = afterGuard.indexOf('\n    }\n')
  assert.ok(guardEnd > -1, 'the panel-owned branch closes at its own 4-space brace')
  assert.match(
    afterGuard.slice(0, guardEnd),
    /\n {6}return;$/,
    'the panel-owned branch RETURNS — this is the only thing keeping the workflow-scoped tail dead'
  )
  const tail = body.slice(guardAt + guardEnd)
  assert.match(
    tail,
    /completeDedicatedWorkflowSessionSwap\(\)/,
    'the panel-owned branch returns before the deferred dedicated switch call',
  )
  const helperAt = PANEL_SRC.indexOf('function completeDedicatedWorkflowSessionSwap(')
  assert.ok(helperAt > -1, 'the dedicated session bind helper exists')
  const helper = PANEL_SRC.slice(helperAt, PANEL_SRC.indexOf('\n  }\n', helperAt) + 5)
  assert.match(
    helper,
    /ssSet\(SESSION_KEY, existing\?\.sessionId/,
    'the workflow-keyed bind remains inside the dedicated helper',
  )
})
