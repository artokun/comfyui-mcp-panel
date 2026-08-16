// The turn-output fence, driven through the SHIPPED bodies (mcp#884/#897).
//
// WHY THIS FILE EXISTS
// --------------------
// The independent mutation gate on PR #680 disabled the fence at every call
// site — `if (false && turnOutputFenced())` in `record()`, `onSay`, `onStream`
// and `onTodo` — and the entire unit suite stayed green. The fence was correct
// and completely unpinned: its only coverage was a Playwright spec that does
// not run in CI.
//
// NOT A SOURCE-REGEX TEST, deliberately. `if (false && turnOutputFenced())`
// still contains the string `turnOutputFenced()`, so every regex anyone would
// write about these call sites matches the disabled form just as happily as the
// live one. The only thing that separates them is RUNNING them, so that is what
// this file does: it lifts the real `turnOutputFenced`, `pinTurnOwnerAtDispatch`,
// `record`, `onSay`, `onStream` and `onTodo` bodies straight out of the shipped
// panel and executes them over stubbed collaborators — the established "real
// panel source" convention (see interactive-card-fence.test.mjs's
// buildLifecycle(), context-ring-scope.test.mjs).
//
// The stub surface is deliberately observational, never a reimplementation:
// `persistThreads` counts, `appendAgent` records what it was handed,
// `getWorkflowTitle` returns a fixture string. The two collaborators that carry
// real logic — `ChatHistoryStore` (reviseThread/touchMessage) and
// `isThreadInScope` — are imported for REAL, so nothing about thread revision
// semantics is modelled here.
//
// THE RULE BEING PINNED
// ---------------------
// Agent-side output belongs to the conversation that OWNS the turn, pinned at
// `user_message` dispatch. If the shown conversation changed mid-turn (a history
// switch in this tab, or this tab passively adopting another tab's shared
// selection), that output is DROPPED — not painted into the conversation now on
// screen, and not re-routed into its owner either (a fresh stamp there would
// hand that thread the newest activity and yank the shared selection back).
// User-authored entries are exempt: they belong to the view the user typed into.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CHAT_HISTORY_SCHEMA,
  ChatHistoryStore,
  isThreadInScope,
} from "../../web/js/lib/chat-history-store.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
// This checkout is CRLF. Normalise BEFORE matching: an LF-authored multi-line
// anchor silently misses against CRLF text, and a miss in an extraction harness
// reads exactly like a passing test.
const panelSrc = readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");

/**
 * Extract one shipped body, asserting it occurs EXACTLY once.
 *
 * Not `match()`. A zero-match anchor throws here instead of injecting an empty
 * string (which would make every assertion below vacuous), and a two-match
 * anchor throws instead of silently picking the first — the failure mode that
 * makes an extraction harness look green while driving nothing.
 */
function extractOnce(re, label) {
  const all = [...panelSrc.matchAll(new RegExp(re.source, `${re.flags}g`))];
  assert.equal(all.length, 1, `${label}: expected exactly 1 match in the panel source, got ${all.length}`);
  return all[0][0];
}

const turnOutputFencedSrc = extractOnce(
  /\n {2}function turnOutputFenced\(\) \{[\s\S]*?\n {2}\}/,
  "turnOutputFenced",
);
const pinTurnOwnerSrc = extractOnce(
  /\n {2}function pinTurnOwnerAtDispatch\(\) \{[\s\S]*?\n {2}\}/,
  "pinTurnOwnerAtDispatch",
);
const recordSrc = extractOnce(/\n {2}function record\(entry\) \{[\s\S]*?\n {2}\}/, "record");
const onSaySrc = extractOnce(/\n {4}onSay\(text, meta\) \{[\s\S]*?\n {4}\},/, "onSay");
const onStreamSrc = extractOnce(/\n {4}onStream\(msg\) \{[\s\S]*?\n {4}\},/, "onStream");
const onTodoSrc = extractOnce(/\n {4}onTodo\(items\) \{[\s\S]*?\n {4}\},/, "onTodo");

/** Read a numeric panel constant rather than restating it here. */
function panelConst(name) {
  const m = panelSrc.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(m, `could not read ${name} from the panel source`);
  return Number(m[1]);
}
const MAX_THREADS = panelConst("MAX_THREADS");
const MAX_THREAD_MSGS = panelConst("MAX_THREAD_MSGS");
const MAX_WORKFLOW_VERSIONS = panelConst("MAX_WORKFLOW_VERSIONS");

// Sanity: the slices really span the bodies the assertions are about, so a
// future refactor that shrinks an anchor fails loudly instead of quietly
// driving a fragment.
test("the extracted slices really are the shipped bodies", () => {
  assert.ok(recordSrc.includes("if (!thread) {"), "record() slice covers the mint branch");
  assert.ok(recordSrc.includes("thread.msgs.push(entry);"), "record() slice reaches the append");
  assert.ok(recordSrc.includes("persistThreads();"), "record() slice reaches the persist");
  assert.ok(turnOutputFencedSrc.includes("liveTurnThreadId"), "the fence reads the turn owner");
  assert.ok(onSaySrc.includes("appendAgent("), "onSay slice reaches its paint");
  assert.ok(onStreamSrc.includes("onStreamDelta("), "onStream slice reaches its paint");
  assert.ok(onTodoSrc.includes("renderTodo("), "onTodo slice reaches its paint");
});

/**
 * The REAL fence + owner pin + record() + the three transcript handlers over one
 * shared closure, with collaborators stubbed.
 *
 * Every stub is either an observation point or a fixture value. The only pieces
 * with behaviour are the real ChatHistoryStore and the real isThreadInScope.
 */
function buildRecorder() {
  const painted = [];
  const persistedAt = [];
  const detached = [];
  const activeThreadWrites = [];
  const session = new Map();
  const historyStore = new ChatHistoryStore({
    storage: createMemoryStorage(),
    indexedDb: null,
    broadcastFactory: null,
  });

  const factory = new Function(
    "deps",
    `
    const { CHAT_HISTORY_SCHEMA, MAX_THREADS, MAX_THREAD_MSGS, MAX_WORKFLOW_VERSIONS,
            SESSION_KEY, CURRENT_THREAD_KEY, crypto, historyStore, isThreadInScope,
            historyScopeFollowsPanel, workflowStorageKey, currentHistoryScopeKey,
            detachInvalidCurrentThread, workflowTabId, getWorkflowTitle, pickDefaultModel,
            capHistoryThreads, setActiveThread, ssGet, ssSet, workflowVersionSnapshot,
            persistThreads, extractA2UIFences, commitStream, appendAgent, paintFenceSpecs,
            bumpThinking, noteActivity, onStreamDelta, renderTodo } = deps;

    // --- the panel's own mutable state, exactly the names record() closes over
    let thread = null;
    let threads = [];
    let liveTurnThreadId = null;
    let lastMintedThreadId = null;
    let connectedBackend = "claude";
    let selectedBackend = "claude";
    let orchestratorCurrentModel = "sonnet-test";
    let modelCatalog = [];
    const prefs = { model: "sonnet-test", effort: "medium" };

    ${turnOutputFencedSrc}
    ${pinTurnOwnerSrc}
    ${recordSrc}

    const host = {
      ${onSaySrc}
      ${onStreamSrc}
      ${onTodoSrc}
    };

    return {
      host,
      record,
      turnOutputFenced,
      // What every successful user_message dispatch does (mcp#884): the coming
      // turn's output belongs to the conversation on screen right now.
      pinTurnOwnerAtDispatch,
      /** A conversation APPEARS on screen: history switch, or passive adoption
       *  of another tab's shared selection. record() was not involved. */
      showConversation(id) {
        thread = id ? threads.find((t) => t.id === id) ?? null : null;
      },
      /** Seed a conversation the way the store would have restored one. */
      seedConversation(id) {
        const now = Date.now();
        const seeded = {
          id, schemaVersion: CHAT_HISTORY_SCHEMA, createdAt: now, updatedAt: now, ts: now,
          msgs: [], workflowKey: "panel:backend:claude", workflowVersions: {},
        };
        threads.push(seeded);
        thread = seeded;
        return seeded;
      },
      endTurn() { liveTurnThreadId = null; },
      threadById: (id) => threads.find((t) => t.id === id) ?? null,
      state: () => ({
        shown: thread?.id ?? null,
        owner: liveTurnThreadId,
        minted: lastMintedThreadId,
        threadCount: threads.length,
      }),
    };
  `,
  );

  const built = factory({
    CHAT_HISTORY_SCHEMA,
    MAX_THREADS,
    MAX_THREAD_MSGS,
    MAX_WORKFLOW_VERSIONS,
    SESSION_KEY: "comfyui-mcp.panel.sessionId",
    CURRENT_THREAD_KEY: "comfyui-mcp.panel.currentThreadId",
    crypto: globalThis.crypto,
    historyStore,
    isThreadInScope,
    // The one shipping mode: the conversation is always panel-owned.
    historyScopeFollowsPanel: () => true,
    workflowStorageKey: () => "panel:backend:claude",
    currentHistoryScopeKey: () => "panel:backend:claude",
    detachInvalidCurrentThread: (opts) => { detached.push(opts); return null; },
    workflowTabId: () => "tab-1",
    getWorkflowTitle: () => "Untitled workflow",
    pickDefaultModel: () => "sonnet-default",
    capHistoryThreads: (list) => list,
    setActiveThread: (scope, id) => activeThreadWrites.push({ scope, id }),
    ssGet: (key) => (session.has(key) ? session.get(key) : null),
    ssSet: (key, value) => { session.set(key, value); },
    workflowVersionSnapshot: () => null,
    persistThreads: () => { persistedAt.push(Date.now()); },
    // --- onSay / onStream / onTodo collaborators, all observation points
    extractA2UIFences: (text) => ({ text, specs: [] }),
    commitStream: () => false,
    appendAgent: (text) => painted.push({ kind: "agent", text }),
    paintFenceSpecs: () => painted.push({ kind: "fence-specs" }),
    bumpThinking: () => painted.push({ kind: "bump" }),
    noteActivity: () => painted.push({ kind: "activity" }),
    onStreamDelta: (msg) => painted.push({ kind: "delta", id: msg?.id ?? null }),
    renderTodo: (items) => painted.push({ kind: "todo", n: items?.length ?? 0 }),
  });

  return { ...built, painted, persistedAt, detached, activeThreadWrites };
}

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

/** The abandoned-turn shape: the turn is pinned to A, then B lands on screen. */
function abandonedTurn() {
  const h = buildRecorder();
  h.seedConversation("t-A");
  h.pinTurnOwnerAtDispatch(); // user_message dispatched while A was shown
  h.seedConversation("t-B");
  h.showConversation("t-B"); // adoption / history switch — B is now on screen
  assert.equal(h.state().owner, "t-A", "the turn is still owned by A");
  assert.equal(h.state().shown, "t-B", "and B is what the tab is showing");
  return h;
}

// ---------------------------------------------------------------------------
// record() — the recording half of the fence
// ---------------------------------------------------------------------------

test("LOAD-BEARING: an abandoned turn's agent record is DROPPED, not filed under the adopted conversation", () => {
  const h = abandonedTurn();
  const before = h.persistedAt.length;

  const entry = { role: "assistant", text: "output from the turn A owned" };
  const returned = h.record(entry);

  assert.deepEqual(
    h.threadById("t-B").msgs,
    [],
    "the straggler must not be appended to the conversation now on screen",
  );
  assert.equal(h.persistedAt.length, before, "and nothing is persisted for it");
  assert.equal(returned, entry, "record() still returns the entry so callers do not crash on a drop");
});

test("LOAD-BEARING: the dropped record is not re-routed into its OWNER thread either", () => {
  // Deliberate: stamping it into A now would hand A the newest conversation
  // activity and yank the shared selection straight back (selectPanelThread
  // recency). The turn was abandoned exactly like an interrupt.
  const h = abandonedTurn();
  h.record({ role: "assistant", text: "straggler" });
  assert.deepEqual(h.threadById("t-A").msgs, [], "the owner thread is not stamped either");
});

test("LOAD-BEARING: a fenced record does not MINT a conversation for the straggler", () => {
  // The nastier shape: nothing on screen at all. A fence that only skipped the
  // append would still fall through record()'s mint branch and create a whole
  // conversation for output nobody asked for.
  const h = buildRecorder();
  h.seedConversation("t-A");
  h.pinTurnOwnerAtDispatch();
  h.showConversation(null);

  h.record({ role: "assistant", text: "straggler onto a blank view" });
  assert.equal(h.state().threadCount, 1, "no conversation is minted for a fenced record");
  assert.equal(h.state().minted, null, "and nothing claims to have been minted");
});

test("EXEMPT: a USER entry is recorded even when the turn owner is elsewhere", () => {
  // The user typed into the view they are looking at, by definition. A fence
  // that dropped this would silently eat the user's own message after a switch.
  const h = abandonedTurn();
  const entry = { role: "user", text: "typed into B" };
  h.record(entry);

  const msgs = h.threadById("t-B").msgs;
  assert.equal(msgs.length, 1, "the user's own message lands in the view they typed into");
  assert.equal(msgs[0], entry, "and it is the SAME object — record() mutates in place, never clones");
  assert.ok(h.persistedAt.length > 0, "and it is persisted");
});

test("NORMAL PATH: the turn's own conversation still records agent output", () => {
  const h = buildRecorder();
  h.seedConversation("t-A");
  h.pinTurnOwnerAtDispatch();

  h.record({ role: "assistant", text: "a reply in the turn's own conversation" });
  assert.equal(h.threadById("t-A").msgs.length, 1, "the ordinary case is untouched by the fence");
  assert.ok(h.persistedAt.length > 0);
});

test("NORMAL PATH: with no turn in flight nothing is fenced", () => {
  // liveTurnThreadId is null between turns — the fence must be inert then, or
  // every restore/replay path would start dropping records.
  const h = buildRecorder();
  h.seedConversation("t-A");
  assert.equal(h.state().owner, null);
  assert.equal(h.turnOutputFenced(), false);

  h.record({ role: "assistant", text: "no live turn" });
  assert.equal(h.threadById("t-A").msgs.length, 1);
});

test("the fence lifts once the abandoned turn ends and a new one is dispatched in B", () => {
  // The ordinary continuation: the user carries on in B. Its own turn's output
  // must record normally — the fence is about ownership, not about B.
  const h = abandonedTurn();
  h.record({ role: "assistant", text: "dropped" });
  assert.deepEqual(h.threadById("t-B").msgs, []);

  h.pinTurnOwnerAtDispatch(); // the user sends a message in B
  h.record({ role: "assistant", text: "B's own turn" });
  assert.equal(h.threadById("t-B").msgs.length, 1, "B's own turn records normally");
});

// ---------------------------------------------------------------------------
// onSay / onStream / onTodo — the painting half of the fence
// ---------------------------------------------------------------------------

test("LOAD-BEARING: an abandoned turn's committed say does not paint into the adopted conversation", () => {
  const h = abandonedTurn();
  h.host.onSay("a reply belonging to conversation A", { id: "m-1" });
  assert.deepEqual(h.painted, [], "no bubble, no thinking bump, no activity reset");
});

test("LOAD-BEARING: an abandoned turn's stream delta does not open a preview bubble in the adopted conversation", () => {
  const h = abandonedTurn();
  h.host.onStream({ id: "m-1", delta: "half a sen" });
  assert.deepEqual(h.painted, [], "no preview bubble is opened for a turn this tab no longer shows");
});

test("LOAD-BEARING: an abandoned turn's plan update does not repaint the todo tray", () => {
  const h = abandonedTurn();
  h.host.onTodo([{ text: "step one", status: "running" }]);
  assert.deepEqual(h.painted, [], "the tray is not repainted with another conversation's plan");
});

test("NORMAL PATH: say / stream / todo all paint in the turn's own conversation", () => {
  const h = buildRecorder();
  h.seedConversation("t-A");
  h.pinTurnOwnerAtDispatch();

  h.host.onSay("hello", { id: "m-1" });
  h.host.onStream({ id: "m-2", delta: "partial" });
  h.host.onTodo([{ text: "step one" }]);

  assert.deepEqual(
    h.painted.map((p) => p.kind),
    ["agent", "bump", "activity", "delta", "activity", "todo"],
    "the unfenced path is exactly the shipped behaviour",
  );
});

test("the painting fence and the recording fence agree on the same question", () => {
  // They are separate call sites reading one predicate. If they ever disagree,
  // output paints without being recorded (or worse, the reverse) — so pin that
  // the single predicate really is what both consult.
  const fenced = abandonedTurn();
  assert.equal(fenced.turnOutputFenced(), true);
  fenced.host.onSay("x", { id: "m-1" });
  fenced.record({ role: "assistant", text: "x" });
  assert.deepEqual(fenced.painted, []);
  assert.deepEqual(fenced.threadById("t-B").msgs, []);

  const open = buildRecorder();
  open.seedConversation("t-A");
  open.pinTurnOwnerAtDispatch();
  assert.equal(open.turnOutputFenced(), false);
  open.host.onSay("x", { id: "m-1" });
  open.record({ role: "assistant", text: "x" });
  assert.ok(open.painted.length > 0);
  assert.equal(open.threadById("t-A").msgs.length, 1);
});

test("ownership is pinned at DISPATCH, not only at turn:working (mcp#884)", () => {
  // The hole pinTurnOwnerAtDispatch closes: an adoption's endTurnLocally()
  // discards a turn:working that lands inside the stale-working window, so an
  // owner pinned only at turn:working would still be null exactly when the
  // fence needs it — and the abandoned turn's output would flow straight into
  // the adopted conversation. Drive the shipped pin to prove it is armed
  // before any turn frame arrives.
  const h = buildRecorder();
  h.seedConversation("t-A");
  h.pinTurnOwnerAtDispatch();
  assert.equal(h.state().owner, "t-A", "dispatch alone pins the owner");

  h.seedConversation("t-B");
  h.showConversation("t-B");
  h.record({ role: "assistant", text: "output from A's turn" });
  assert.deepEqual(
    h.threadById("t-B").msgs,
    [],
    "so the straggler is fenced even though no turn:working was ever seen",
  );
});
