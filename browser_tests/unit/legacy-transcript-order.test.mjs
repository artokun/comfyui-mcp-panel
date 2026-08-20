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

import { mergeHistorySnapshots } from '../../web/js/lib/chat-history-store.js'

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
