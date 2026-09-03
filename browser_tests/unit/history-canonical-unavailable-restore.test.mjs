import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  CHAT_HISTORY_SCHEMA,
  ChatHistoryStore,
  planRemountHistoryRestore,
  selectRestoreThread,
} from '../../web/js/lib/chat-history-store.js'

const PANEL_SRC = readFileSync(
  fileURLToPath(new URL('../../web/js/comfyui-mcp-panel.js', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n')

function createMemoryStorage() {
  const values = new Map()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

function createFakeIndexedDb(initialState = null) {
  const data = new Map()
  const at = (store, key) => store + ' :: ' + String(key)
  if (initialState != null) data.set(at('snapshots', 'state'), structuredClone(initialState))
  const createDb = () => ({
    objectStoreNames: { contains: (name) => name === 'snapshots' || name === 'legacy' },
    createObjectStore() {},
    close() {},
    transaction: (names, mode) => {
      const wanted = Array.isArray(names) ? names : [names]
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
            data.set(at(name, key === undefined ? 'state' : key), structuredClone(value))
            queueMicrotask(() => tx.oncomplete?.())
            return { onsuccess: null, onerror: null }
          },
        }),
      }
      return tx
    },
  })
  return {
    open: () => {
      const request = {
        result: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      }
      queueMicrotask(() => {
        request.result = createDb()
        request.onsuccess?.()
      })
      return request
    },
    readState: () => {
      const held = data.get(at('snapshots', 'state'))
      return held === undefined ? null : structuredClone(held)
    },
  }
}

const CODEX_CANONICAL = {
  schemaVersion: CHAT_HISTORY_SCHEMA,
  updatedAt: 5_000,
  threads: [{
    id: 'keep',
    workflowKey: 'panel:global',
    provider: 'codex',
    sessionId: 'sess-codex',
    updatedAt: 5_000,
    msgs: [{
      id: 'keep-message',
      role: 'user',
      text: 'panel-wide codex turn',
      createdAt: 5_000,
    }],
  }],
  meta: {
    updatedAt: 5_000,
    activeByScope: { 'panel:backend:codex': 'keep' },
  },
}

function remountRestore(loaded, pointers, writes, feed) {
  const durableActive = selectRestoreThread(loaded.threads, loaded.meta, {
    panelOwned: true,
    scopeKey: 'panel:backend:codex',
    preferredThreadId: pointers.threadId,
  })
  const plan = planRemountHistoryRestore({
    canonicalAvailable: loaded.canonicalAvailable === true,
    durableActive,
  })
  if (plan.kind === 'preserve') return plan
  if (plan.kind === 'reset') {
    writes.push({ threadId: null, sessionId: null })
    pointers.threadId = null
    pointers.sessionId = null
    feed.length = 0
    return plan
  }
  feed.splice(0, feed.length, ...plan.thread.msgs.map((message) => message.text))
  pointers.threadId = plan.thread.id
  pointers.sessionId = plan.thread.sessionId || pointers.sessionId
  return plan
}

test('#2201 remount restore keeps Codex session pointers through a timed-out canonical read, then repaints', async () => {
  const inner = createFakeIndexedDb(CODEX_CANONICAL)
  let hang = true
  const indexedDb = {
    open: () => {
      if (hang) {
        const req = {}
        queueMicrotask(() => req.onerror?.())
        return req
      }
      return inner.open()
    },
    readState: inner.readState,
  }
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb })
  const pointers = { threadId: 'keep', sessionId: 'sess-codex' }
  const writes = []
  const feed = []

  const first = await store.load({ protectedThreadIds: ['keep'] })
  assert.equal(first.canonicalAvailable, false)
  assert.equal(remountRestore(first, pointers, writes, feed).kind, 'preserve')
  assert.equal(pointers.threadId, 'keep')
  assert.equal(pointers.sessionId, 'sess-codex')
  assert.deepEqual(writes, [])
  assert.equal(inner.readState().meta.activeByScope['panel:backend:codex'], 'keep')

  hang = false
  const recovered = await store.load({ protectedThreadIds: ['keep'] })
  const plan = remountRestore(recovered, pointers, writes, feed)
  assert.equal(plan.kind, 'bind')
  assert.deepEqual(feed, ['panel-wide codex turn'])
  assert.equal(pointers.threadId, 'keep')
  assert.equal(pointers.sessionId, 'sess-codex')
  assert.deepEqual(writes, [])
  store.close()
})

test('#2201 panel remount restore is gated on planRemountHistoryRestore and retries hydration', () => {
  assert.match(
    PANEL_SRC,
    /planRemountHistoryRestore,/,
    'the panel imports the remount restore policy',
  )
  const restoreAt = PANEL_SRC.indexOf('const applyHydratedHistory = (loaded, canonicalAvailable) => {')
  assert.notEqual(restoreAt, -1, 'remount restore applies through applyHydratedHistory')
  const restoreEnd = PANEL_SRC.indexOf('\n  })();', PANEL_SRC.indexOf('const historyRestoreReady = (async () => {'))
  assert.ok(restoreEnd > restoreAt)
  const restore = PANEL_SRC.slice(restoreAt, restoreEnd)
  assert.match(restore, /canonicalAvailable = loaded\.canonicalAvailable === true/)
  assert.match(restore, /planRemountHistoryRestore\(\{ canonicalAvailable, durableActive \}\)/)
  assert.match(
    restore,
    /if \(plan\.kind === "preserve"\) \{\s*void retryCanonicalHydration\(historyRestoreGeneration\);/,
    'an unavailable canonical read retries instead of resetting',
  )
  assert.match(
    PANEL_SRC,
    /if \(plan\.kind === "reset"\) \{[\s\S]*?ssSet\(CURRENT_THREAD_KEY, null\);/,
    'the destructive tab-pointer clear stays behind the reset plan',
  )
  assert.match(
    PANEL_SRC,
    /destroy\(\) \{\s*historyRestoreGeneration \+= 1;/,
    'unmount cancels an in-flight hydration retry',
  )
})
