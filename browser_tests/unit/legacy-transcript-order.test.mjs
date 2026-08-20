/**
 * #1516 — a hard refresh across the 0.7.x -> 0.15.x panel boundary re-ordered the
 * user's transcript, so their earliest prompts came back BELOW the agent's last
 * reply and read as a replay of the conversation.
 *
 * A pre-v3 panel (anything before 0.11.0, which is where IndexedDB and the
 * atomic snapshot key arrived) wrote a BARE ARRAY of threads under
 * `comfyui-mcp.panel.threads`, and its messages carried no `id`, no `createdAt`
 * and no `ts`. On the next mount the current panel normalizes those records —
 * floor `createdAt` at 1, mint `legacy-<content hash>` ids — and then merges its
 * in-memory copy with the one `ChatHistoryStore.load()` returns.
 *
 * That merge sorts. With every message pinned at createdAt:1 the timestamp
 * comparison is a dead heat for the whole thread, so the tiebreak decided the
 * order — and the tiebreak was the message id, which for these records is a hash
 * of the message's own text. The transcript came back in hash order.
 *
 * These tests pin the ORDER, not the merge's dedupe (which has its own coverage
 * in chat-history-store.test.mjs). Delete the rank tiebreak in
 * mergeThreadMessages and the first two go red.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ChatHistoryStore, mergeHistorySnapshots } from '../../web/js/lib/chat-history-store.js'

const THREAD_ID = '11111111-2222-3333-4444-555555555555'

/** A thread exactly as a pre-0.11.0 panel left it: no message ids, no times. */
function legacyThread(texts, overrides = {}) {
  return {
    id: THREAD_ID,
    ts: 1_700_000_000_000,
    workflowKey: 'panel:global',
    msgs: texts.map((text, i) => ({ role: i % 2 === 0 ? 'user' : 'agent', text })),
    ...overrides
  }
}

const CONVERSATION = ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']

const textsOf = (snapshot) => snapshot.threads[0].msgs.map((m) => m.text)

test('#1516: merging two copies of a pre-v3 thread keeps the stored order', () => {
  // The panel's own restore does exactly this: it merges the snapshot it read
  // synchronously at mount with the one ChatHistoryStore.load() resolves to.
  const first = mergeHistorySnapshots({ threads: [legacyThread(CONVERSATION)], meta: {} })
  const merged = mergeHistorySnapshots(
    { threads: first.threads, meta: first.meta },
    { threads: first.threads, meta: first.meta }
  )
  assert.deepEqual(
    textsOf(merged),
    CONVERSATION,
    'a timestamp-less transcript must not be re-ordered by the merge'
  )
})

test('#1516: the order survives the round trip a reload actually makes', () => {
  // Merge, persist, read back, merge again — a second reload must not shuffle
  // what the first one settled on.
  let snapshot = mergeHistorySnapshots({ threads: [legacyThread(CONVERSATION)], meta: {} })
  for (let reload = 0; reload < 3; reload += 1) {
    const roundTripped = JSON.parse(JSON.stringify(snapshot))
    snapshot = mergeHistorySnapshots(
      { threads: roundTripped.threads, meta: roundTripped.meta },
      { threads: snapshot.threads, meta: snapshot.meta }
    )
    assert.deepEqual(textsOf(snapshot), CONVERSATION, `reload ${reload + 1} re-ordered the transcript`)
  }
})

test('#1516: timestamped messages still interleave by TIME, not by position', () => {
  // The rank tiebreak must never outrank a real clock — two tabs writing
  // concurrently still merge causally. `later` is appended to the merge AFTER
  // `earlier`, so position alone would put it last; its timestamp must win.
  const withTimes = (msgs) => ({
    id: THREAD_ID,
    ts: 1_700_000_000_000,
    workflowKey: 'panel:global',
    msgs
  })
  const earlier = withTimes([
    { id: 'm-a', role: 'user', text: 'a', createdAt: 3000 },
    { id: 'm-c', role: 'user', text: 'c', createdAt: 5000 }
  ])
  const later = withTimes([{ id: 'm-b', role: 'agent', text: 'b', createdAt: 4000 }])
  const merged = mergeHistorySnapshots({ threads: [earlier], meta: {} }, { threads: [later], meta: {} })
  assert.deepEqual(textsOf(merged), ['a', 'b', 'c'])
})

test('#1516: a single snapshot was already in order and stays that way', () => {
  const only = mergeHistorySnapshots({ threads: [legacyThread(CONVERSATION)], meta: {} })
  assert.deepEqual(textsOf(only), CONVERSATION)
})

/**
 * The precondition the tiebreak rests on.
 *
 * The rank only ever decides an order when the timestamp comparison ties, and it
 * can only tie when BOTH messages lack a usable time. `normalizeMessage` floors a
 * time-less message at createdAt:1, so a live transcript stays timestamp-ordered
 * exactly as long as the panel keeps stamping every message it records. There is
 * one writer — `record()` is the only place anything reaches `thread.msgs` — so
 * this is a one-line invariant, and if a later edit drops it the rank silently
 * starts re-ordering a MODERN conversation instead of repairing a legacy one.
 *
 * Scoped to record()'s own body on purpose: a body-wide scan of the 38k-line panel
 * would be satisfied by any sibling that happens to mention createdAt.
 */
test('#1516: record() stamps createdAt on every entry, which is what keeps live transcripts time-ordered', () => {
  const panelUrl = new URL('../../web/js/comfyui-mcp-panel.js', import.meta.url)
  const source = readFileSync(fileURLToPath(panelUrl), 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf('\n  function record(entry) {')
  assert.notEqual(start, -1, 'could not locate record()')
  const end = source.indexOf('\n  }\n', source.indexOf('thread.msgs.push(entry);', start))
  assert.ok(end > start, 'could not locate the end of record()')
  const body = source.slice(start, end)
  assert.match(
    body,
    /if \(!Number\(entry\.createdAt\)\) entry\.createdAt = now;[\s\S]{0,400}?thread\.msgs\.push\(entry\);/,
    'record() must stamp createdAt BEFORE the entry reaches thread.msgs'
  )
})

test('#1516: record() is still the only path into thread.msgs', () => {
  const panelUrl = new URL('../../web/js/comfyui-mcp-panel.js', import.meta.url)
  const source = readFileSync(fileURLToPath(panelUrl), 'utf8').replace(/\r\n/g, '\n')
  // A second writer would be a second place a message can arrive without a time.
  const pushes = source.match(/\.msgs\.push\(/g) || []
  assert.equal(pushes.length, 1, 'a new thread.msgs writer must also stamp createdAt (see #1516)')
})

/**
 * The sibling call site. `importPayload` sorted messages with its OWN copy of the
 * same two-term rule, so a portable archive of a pre-v3 transcript arrived
 * content-hash scrambled — and an import is a WRITE, so that order would then be
 * persisted as the conversation's real one. Export runs every message through
 * normalizeThread, which is what floors a legacy message at createdAt:1, so the
 * exported archive carries exactly the timestamp-less shape that ties.
 */
test('#1516: importing an exported pre-v3 transcript keeps its order', () => {
  const store = new ChatHistoryStore({
    storage: { getItem: () => null, setItem: () => {} },
    indexedDb: null
  })
  const archive = store.exportPayload([legacyThread(CONVERSATION)], {})
  // Nothing local yet: the archive is the only source, so its own order is the
  // only order there is to keep.
  const imported = store.importPayload(JSON.stringify(archive), [], {})
  const thread = imported.threads.find((t) => t.id === THREAD_ID)
  assert.ok(thread, 'the archived thread should import')
  assert.deepEqual(thread.msgs.map((m) => m.text), CONVERSATION)
})

/**
 * #1536 — #1530 ranked by first-seen position in `[...oldMessages, ...newMessages]`,
 * which is only order-preserving when `older` is a prefix of `newer`. Production
 * is the other shape: `_writeLocalSnapshot` stores `thread.msgs.slice(-200)` while
 * IndexedDB holds the whole thread, and the panel restore then merges those two
 * via `mergeHistorySnapshots({ threads: inMemoryTail }, loadedFull)`.
 *
 * `older`/`newer` is chosen by `updatedAt`, not argument position, so swapping
 * the concatenation is the exact mirror failure. These tests pin the three
 * shapes the merge must survive, driving `mergeHistorySnapshots` the way the
 * restore path does. Messages already have ids (post-migration) and createdAt
 * still floored at 1 — that is the record the truncated shadow actually holds.
 */
function migratedThread(texts, updatedAt) {
  return {
    id: THREAD_ID,
    ts: 1_700_000_000_000,
    updatedAt,
    workflowKey: 'panel:global',
    schemaVersion: 3,
    msgs: texts.map((text) => ({
      id: `id:${text}`,
      role: CONVERSATION.indexOf(text) % 2 === 0 ? 'user' : 'agent',
      text,
      createdAt: 1
    }))
  }
}

function mergeByRecency(olderTexts, newerTexts) {
  const older = migratedThread(olderTexts, 1_000)
  const newer = migratedThread(newerTexts, 2_000)
  // Production may pass the snapshots in either order; updatedAt decides.
  const forward = mergeHistorySnapshots({ threads: [older], meta: {} }, { threads: [newer], meta: {} })
  const reverse = mergeHistorySnapshots({ threads: [newer], meta: {} }, { threads: [older], meta: {} })
  assert.deepEqual(textsOf(forward), textsOf(reverse), 'updatedAt, not argument order, must decide older/newer')
  return forward
}

test('#1536: older = prefix of newer keeps the stored order (#1530 still holds)', () => {
  const merged = mergeByRecency(CONVERSATION.slice(0, 3), CONVERSATION)
  assert.deepEqual(textsOf(merged), CONVERSATION)
})

test('#1536: older = tail of newer keeps the stored order (local shadow of a long thread)', () => {
  // Measured against #1530: ["a2","u3","a3","u1","a1","u2"] — the tail ranked
  // ahead of the head. This is the panel restore: in-memory shadow is the tail,
  // load() returns the full IndexedDB copy as newer.
  const merged = mergeByRecency(CONVERSATION.slice(-3), CONVERSATION)
  assert.deepEqual(textsOf(merged), CONVERSATION)
})

test('#1536: a newer tail (the load() merge) also keeps the stored order', () => {
  // The obvious one-token repair — concatenate newer first — fixes the tail-as-older
  // case and then fails this mirror. load() merges IndexedDB (full) with the local
  // shadow (tail); when the shadow is rewritten last it can be the newer snapshot.
  const merged = mergeByRecency(CONVERSATION, CONVERSATION.slice(-3))
  assert.deepEqual(textsOf(merged), CONVERSATION)
})

test('#1536: interleaved overlap keeps each sequence\'s relative order', () => {
  // Measured against #1530: ["u1","u2","u3","a1","a2"] want u1,a1,u2,a2,u3.
  const interleaved = ['u1', 'a1', 'u2', 'a2', 'u3']
  const usersOnly = ['u1', 'u2', 'u3']
  assert.deepEqual(textsOf(mergeByRecency(usersOnly, interleaved)), interleaved)
  assert.deepEqual(textsOf(mergeByRecency(interleaved, usersOnly)), interleaved)
})

test('#1536: the panel restore (same updatedAt, tail then full) keeps the stored order', () => {
  // Same updatedAt: `next.updatedAt >= prev.updatedAt` makes the SECOND snapshot
  // newer. That is the panel's `mergeHistorySnapshots({ threads: tail }, loaded)`.
  const tail = migratedThread(CONVERSATION.slice(-3), 1_700_000_000_000)
  const full = migratedThread(CONVERSATION, 1_700_000_000_000)
  const merged = mergeHistorySnapshots({ threads: [tail], meta: {} }, { threads: [full], meta: {} })
  assert.deepEqual(textsOf(merged), CONVERSATION)
})
