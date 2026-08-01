// Regression coverage for panel#381 (+ codex-P2 follow-up): the composer's
// context ring was persisted under a SINGLE GLOBAL sessionStorage key
// (comfyui-mcp.panel.ctxPct) while agent conversations are per-conversation
// (per workflow-tab, and one workflow can hold several saved conversations).
// Switching conversations left the ring showing the PREVIOUS one's fill until
// the next agent_status push — a nearly-full context could read as having
// headroom. The fix keys the persisted value by the ACTIVE THREAD id (falling
// back to the workflow scope only for the pre-first-message view) and repaints
// the ring from that conversation on every switch/restore, blanking when it has
// no stored fill.
//
// ctxScopeKey / refreshContextRingForScope / clearAllCtxScopes live inside the
// panel-builder closure in web/js/comfyui-mcp-panel.js (they close over browser
// globals + the closure's `thread`), so we follow the established "real panel
// source" extraction convention (see graph-set-node-collapsed.test.mjs): regex
// the three function declarations out of the file and evaluate them via
// `new Function` with their collaborators injected as stubs, driving the ACTUAL
// shipped logic against a fake sessionStorage.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8");

const CTX_KEY = "comfyui-mcp.panel.ctxPct";

// The three helpers are contiguous in the source. Grab the slice from
// ctxScopeKey through the closing brace of clearAllCtxScopes (the first
// two-space-indented `}` after that function opens).
const sliceMatch = panelSrc.match(
  /function ctxScopeKey\(\) \{[\s\S]*?function clearAllCtxScopes\(\) \{[\s\S]*?\n {2}\}/,
);
assert.ok(sliceMatch, "could not locate the #381 ctx-scope helpers in panel source");
for (const name of ["ctxScopeKey", "ctxPersistKey", "ctxFrameForActiveView", "refreshContextRingForScope", "clearAllCtxScopes"]) {
  assert.ok(sliceMatch[0].includes(`function ${name}(`), `extraction missing ${name}`);
}
// Lock in that the key is thread-scoped (codex P2), not merely workflow-scoped.
assert.ok(/thread\?\.id/.test(sliceMatch[0]), "ctxScopeKey must key by the active thread id");

// The turn owner MUST be cleared on a terminal `done` frame, else a later
// reconnect re-push persists under the completed conversation (codex P2). Assert
// the onTurn done branch resets it, so the source can't silently drop this.
const doneBranch = panelSrc.match(/else if \(state === "done"\) \{[\s\S]*?agentWorking = false;[\s\S]*?liveTurnThreadId = null;/);
assert.ok(doneBranch, "onTurn 'done' must clear liveTurnThreadId (codex P2 turn-owner reset)");

// A sync-driven detach/rebind (another tab deleted/invalidated the active
// conversation) must repaint the ring, else it keeps the deleted chat's fill
// (codex P2). Assert the detach helper calls the refresh before returning.
const detachFn = panelSrc.match(/function detachInvalidCurrentThread\([\s\S]*?refreshContextRingForScope\(\);[\s\S]*?return replacement;/);
assert.ok(detachFn, "detachInvalidCurrentThread must call refreshContextRingForScope (codex P2)");

// The manual thread switch (loadThread) must also refresh the ring, after it
// repaints the selected conversation.
const loadThreadFn = panelSrc.match(/function loadThread\(t\) \{[\s\S]*?\n {2}\}/);
assert.ok(loadThreadFn, "could not locate loadThread");
const paintIdx = loadThreadFn[0].indexOf("paintThread(t);");
const refreshIdx = loadThreadFn[0].indexOf("refreshContextRingForScope();");
assert.ok(paintIdx >= 0 && refreshIdx > paintIdx, "loadThread must call refreshContextRingForScope after paintThread(t)");

/** A minimal sessionStorage with the enumeration surface clearAllCtxScopes uses. */
function makeSessionStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    _dump() { return new Map(map); },
  };
}

/** Build the REAL helpers bound to injected collaborators. `thread` is the
 *  closure's active-conversation object (mutate `thread.id` to simulate a
 *  conversation switch, or pass null for the pre-first-message view);
 *  `scopeRef.value` drives the workflow-scope fallback. */
function buildHelpers({ thread = null, liveTurnThreadId = null, scopeRef = { value: "workflow:none" }, sessionStorage } = {}) {
  const ss = sessionStorage ?? makeSessionStorage();
  const setCalls = [];
  const ctxLabel = { textContent: "" };
  const factory = new Function(
    "CTX_KEY",
    "thread",
    "liveTurnThreadId",
    "currentHistoryScopeKey",
    "ssGet",
    "ssSet",
    "setContextPct",
    "ctxLabel",
    "window",
    `${sliceMatch[0]}\nreturn { ctxScopeKey, ctxPersistKey, ctxFrameForActiveView, refreshContextRingForScope, clearAllCtxScopes };`,
  );
  const helpers = factory(
    CTX_KEY,
    thread,
    liveTurnThreadId,
    () => scopeRef.value,
    (k) => ss.getItem(k),
    (k, v) => (v == null ? ss.removeItem(k) : ss.setItem(k, v)),
    (p) => setCalls.push(p),
    ctxLabel,
    { sessionStorage: ss },
  );
  return { helpers, setCalls, ctxLabel, ss, thread, scopeRef };
}

test("#381 ctxScopeKey keys by the active thread id", () => {
  const thread = { id: "t-123" };
  const { helpers } = buildHelpers({ thread });
  assert.equal(helpers.ctxScopeKey(), `${CTX_KEY}:t-123`);
  thread.id = "t-999";
  assert.equal(helpers.ctxScopeKey(), `${CTX_KEY}:t-999`);
});

test("codex-P2: ctxScopeKey is null for the pre-first-message view (no workflow-scope fallback)", () => {
  // A thread-less view has no conversation, so no key — nothing is read,
  // persisted, or painted against it, and a re-push in that gap cannot leak into
  // the thread the first message then mints.
  const { helpers } = buildHelpers({ thread: null });
  assert.equal(helpers.ctxScopeKey(), null);
});

test("codex-P2: nothing is persisted or painted against a thread-less view", () => {
  const empty = buildHelpers({ thread: null, liveTurnThreadId: null });
  assert.equal(empty.helpers.ctxPersistKey(), null, "no persist target without a conversation");
  assert.equal(empty.helpers.ctxFrameForActiveView(), false, "a re-push must not paint an empty view");
});

test("codex-P2: refreshContextRingForScope blanks when no conversation is shown", () => {
  const { helpers, setCalls, ctxLabel } = buildHelpers({ thread: null });
  helpers.refreshContextRingForScope();
  assert.equal(setCalls.at(-1), 0);
  assert.equal(ctxLabel.textContent, "—");
});

test("#381 switching conversations never shows the previous one's fill", () => {
  const thread = { id: "t-A" };
  const ss = makeSessionStorage();
  const { helpers, setCalls, ctxLabel } = buildHelpers({ thread, sessionStorage: ss });

  // Conversation A reports a high fill (agent_status writes under A's key).
  ss.setItem(helpers.ctxScopeKey(), "0.785");

  // Switch to a lightly-used conversation B (no stored fill yet).
  thread.id = "t-B";
  helpers.refreshContextRingForScope();
  assert.equal(setCalls.at(-1), 0, "switching to an unused conversation must blank the ring, not keep A's fill");
  assert.equal(ctxLabel.textContent, "—");

  // B accrues its own smaller fill.
  ss.setItem(helpers.ctxScopeKey(), "0.24");
  helpers.refreshContextRingForScope();
  assert.equal(setCalls.at(-1), 0.24);

  // Back to A — its own high fill is restored, not B's.
  thread.id = "t-A";
  helpers.refreshContextRingForScope();
  assert.equal(setCalls.at(-1), 0.785, "returning to A must restore A's fill, not leave B's 0.24");
});

test("codex-P2: two conversations in the SAME workflow keep independent fills", () => {
  // The scope (workflow) is constant across both threads — proving the key is
  // thread-scoped, so picking an older history entry in one workflow does not
  // inherit the other conversation's usage.
  const thread = { id: "t-A" };
  const ss = makeSessionStorage();
  const scopeRef = { value: "workflow:SAME" };
  const { helpers, setCalls } = buildHelpers({ thread, scopeRef, sessionStorage: ss });

  ss.setItem(helpers.ctxScopeKey(), "0.70"); // A, in workflow:SAME
  thread.id = "t-B";                          // same workflow, different conversation
  ss.setItem(helpers.ctxScopeKey(), "0.24"); // B, in workflow:SAME
  assert.notEqual(`${CTX_KEY}:t-A`, `${CTX_KEY}:t-B`);

  thread.id = "t-A";
  helpers.refreshContextRingForScope();
  assert.equal(setCalls.at(-1), 0.70, "A keeps 0.70 even though B is in the same workflow scope");
  thread.id = "t-B";
  helpers.refreshContextRingForScope();
  assert.equal(setCalls.at(-1), 0.24, "B keeps its own 0.24");
});

test("codex-P2: a status frame persists under the turn's owner, not the switched-to conversation", () => {
  // The user was chatting in A (a turn is live, so liveTurnThreadId === A), then
  // switched history to B (thread === B) before A's turn drained. A late
  // agent_status must persist under A, never B.
  const { helpers } = buildHelpers({ thread: { id: "t-B" }, liveTurnThreadId: "t-A" });
  assert.equal(helpers.ctxPersistKey(), `${CTX_KEY}:t-A`, "late frame must attribute to the turn owner A, not the displayed B");
});

test("codex-P2: outside a live turn, persistence targets the current conversation", () => {
  // liveTurnThreadId null (between turns / after reload) → the reconnect re-push
  // belongs to whatever conversation is now shown.
  const { helpers } = buildHelpers({ thread: { id: "t-B" }, liveTurnThreadId: null });
  assert.equal(helpers.ctxPersistKey(), `${CTX_KEY}:t-B`);
});

test("codex-P2: a background turn's frame does NOT repaint the ring of the chat on screen", () => {
  // Live turn owned by A (liveTurnThreadId=A) while B is displayed (thread=B):
  // the frame is persisted to A but must not touch B's visible ring.
  const bg = buildHelpers({ thread: { id: "t-B" }, liveTurnThreadId: "t-A" });
  assert.equal(bg.helpers.ctxFrameForActiveView(), false, "a background-turn frame must not repaint the active ring");

  // Live turn owned by the displayed chat → repaint.
  const fg = buildHelpers({ thread: { id: "t-A" }, liveTurnThreadId: "t-A" });
  assert.equal(fg.helpers.ctxFrameForActiveView(), true);

  // No live turn (reconnect re-push) → repaint the current chat.
  const idle = buildHelpers({ thread: { id: "t-A" }, liveTurnThreadId: null });
  assert.equal(idle.helpers.ctxFrameForActiveView(), true);
});

test("codex-P2: a mid-turn switch cannot corrupt the switched-to conversation's stored fill", () => {
  // End to end: A has a stored fill; a live turn owned by A drains a late frame
  // while B is displayed; B's own stored fill must be untouched.
  const ss = makeSessionStorage();
  const { helpers } = buildHelpers({ thread: { id: "t-B" }, liveTurnThreadId: "t-A", sessionStorage: ss });
  ss.setItem(`${CTX_KEY}:t-B`, "0.10"); // B's real, low fill
  // Simulate onAgentStatus persisting a high A-frame while B is shown.
  ss.setItem(helpers.ctxPersistKey(), "0.90");
  assert.equal(ss.getItem(`${CTX_KEY}:t-B`), "0.10", "B's fill must stay 0.10");
  assert.equal(ss.getItem(`${CTX_KEY}:t-A`), "0.90", "A absorbs its own turn's fill");
});

test("#381 refreshContextRingForScope blanks the ring when the conversation has no fill", () => {
  const { helpers, setCalls, ctxLabel } = buildHelpers({ thread: { id: "t-fresh" } });
  helpers.refreshContextRingForScope();
  assert.equal(setCalls.at(-1), 0);
  assert.equal(ctxLabel.textContent, "—");
});

test("#381 clearAllCtxScopes drops every conversation's fill and the legacy global key", () => {
  const ss = makeSessionStorage();
  const { helpers } = buildHelpers({ thread: { id: "t-A" }, sessionStorage: ss });

  ss.setItem(`${CTX_KEY}:t-A`, "0.5");
  ss.setItem(`${CTX_KEY}:t-B`, "0.6");
  ss.setItem(`${CTX_KEY}:panel:global`, "0.7");
  ss.setItem(CTX_KEY, "0.9"); // pre-#381 global key an upgraded tab might carry
  ss.setItem("unrelated.key", "keep-me");

  helpers.clearAllCtxScopes();

  assert.deepEqual([...ss._dump().keys()], ["unrelated.key"], "only non-ctx keys should survive");
});
