// #1839 P1(b) — the durable run-completion ledger is partitioned against the LIVE
// bridge route, and that route moves under a MOUNTED panel with no remount. Before
// this fix the partition ran exactly once, at mount, so a completion still owed on
// workflow B was deferred when the panel reloaded while workflow A was the canvas,
// and switching back to B inside the same mount never adopted it. The row survived
// in storage and only a LATER mount picked it up — "successful run, no completion
// event" (#1739 / #585 / #370) with a workflow switch in front of it.
//
// These tests do NOT re-implement the wiring. They SLICE the production text out of
// web/js/comfyui-mcp-panel.js and execute it, so a mutation to the shipped function
// bodies — not just to the lib helpers they call — turns them red.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  mergeRunCompletionMetadata,
  normalizeRunCompletionMetadata,
  partitionRunCompletionMetadata,
  runCompletionContextKey,
  selectDeferredRunCompletionMetadata,
} from "../../web/js/lib/run-completion-persistence.js";
import { createRunCompletionTracker } from "../../web/js/lib/run-completion.js";
import { createRunReconcileSweep } from "../../web/js/lib/run-reconcile-sweep.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** Cut the production text between two anchors, refusing rather than guessing. */
function slice(from, to, { inclusive = false } = {}) {
  const start = PANEL_SRC.indexOf(from);
  assert.notEqual(start, -1, `production anchor missing: ${from}`);
  const end = PANEL_SRC.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `production anchor missing: ${to}`);
  const text = PANEL_SRC.slice(start, inclusive ? end + to.length : end);
  assert.ok(text.length > 0, "empty production slice");
  return text;
}

// the ledger read/write/restore helpers, including the read that can say "unknown"
const SRC_STORAGE = slice(
  "function readRunCompletionMetadata() {",
  "function readRunCompletionTerminals() {",
);
// the mount-time partition, the adopted-context set, and the persist merge
const SRC_MOUNT = slice(
  "  const completionRestoreStored = readRunCompletionMetadataOrUnknown();",
  "  const persistOwnedRunCompletionTerminals = ",
);
// the route-change rehydrate + its module-ref publication
const SRC_REHYDRATE = slice(
  "  const rehydrateRunCompletionForLiveRoute = () => {",
  "  rehydrateRunCompletionForLiveRouteRef = rehydrateRunCompletionForLiveRoute;",
  { inclusive: true },
);

const RUN_COMPLETION_META_KEY = "comfyui-mcp.panel.runCompletionMeta.v1";
const SESSION_KEY = "comfyui-mcp.panel.sessionId";
const SESSION = "agent-session-7";
const ROUTE_A = "tab-1::wf:workflows/a.json";
const ROUTE_B = "tab-1::wf:workflows/b.json";
const ROUTE_C = "tab-1::wf:workflows/c.json";

const mkRow = (routeId, promptId, nonce) => ({
  routeId,
  sessionId: SESSION,
  promptId,
  completionKey: JSON.stringify([routeId, SESSION, promptId, nonce]),
});

const wireProduction = new Function(
  "deps",
  [
    "const { ssGet, ssSet, window, RUN_COMPLETION_META_KEY, normalizeRunCompletionMetadata,",
    "  mergeRunCompletionMetadata, selectDeferredRunCompletionMetadata, runCompletionContextKey,",
    "  partitionRunCompletionMetadata, panelRunOwnerRef, mountOwner, bridgeRouteId, SESSION_KEY,",
    "  runCompletion, armRunReconcileSweep, completionRestoreRoute, completionRestoreSession } = deps;",
    "let rehydrateRunCompletionForLiveRouteRef = null;",
    SRC_STORAGE,
    SRC_MOUNT,
    SRC_REHYDRATE,
    "return {",
    "  readRunCompletionMetadata, readRunCompletionMetadataOrUnknown, restoreRunCompletionMetadata,",
    "  completionRestore, adoptedRunCompletionContexts, adoptRunCompletionContext,",
    "  runCompletionContextNeedsAdoption, persistOwnedRunCompletionMetadata,",
    "  rehydrateRunCompletionForLiveRoute,",
    "  rehydrateRef: () => rehydrateRunCompletionForLiveRouteRef,",
    "};",
  ].join("\n"),
);

/** A sessionStorage that can be made to THROW, the way a blocked origin does. */
function makeStorage(rows) {
  const map = new Map([[SESSION_KEY, SESSION]]);
  if (rows) map.set(RUN_COMPLETION_META_KEY, JSON.stringify(rows));
  const state = { failRead: false };
  const sessionStorage = {
    getItem(k) {
      if (state.failRead) throw new DOMException("blocked", "SecurityError");
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, v);
    },
    removeItem(k) {
      map.delete(k);
    },
  };
  return { map, state, window: { sessionStorage } };
}

/**
 * A mount of the REAL wiring: the shipped storage helpers, the shipped mount
 * partition / adopt / persist block, the shipped rehydrate, the real tracker and
 * the real safety sweep.
 *
 * `withRehydrate:false` reproduces the pre-fix behaviour WITHOUT deleting the
 * shipped code: the route-change hook simply never fires, exactly as it never
 * fired before this change existed. Everything else is the same production text.
 */
function mount(storage, { liveRoute, withRehydrate = true } = {}) {
  let route = liveRoute;
  const flushed = [];
  const reconciled = [];
  // verbatim from comfyui-mcp-panel.js — a throwing store reads as null.
  const ssGet = (key) => {
    try {
      return storage.window.sessionStorage.getItem(key) || null;
    } catch {
      return null;
    }
  };
  const ssSet = (key, val) => {
    try {
      if (val == null) storage.window.sessionStorage.removeItem(key);
      else storage.window.sessionStorage.setItem(key, val);
    } catch {}
  };
  const mountOwner = {};
  const panelRunOwnerRef = { current: mountOwner };

  let wired = null;
  const runCompletion = createRunCompletionTracker({
    onFlush: (payload) => flushed.push(payload),
    onCompletionStateChange: (entries) => wired?.persistOwnedRunCompletionMetadata(entries),
    // The tracker's own fence-prune timer would otherwise hold the test runner's
    // event loop open after the assertions finish.
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
  });
  const sweep = createRunReconcileSweep({
    hasPending: () => runCompletion.hasPending(),
    reconcile: () => reconciled.push(runCompletion.unsettledPromptIds()),
    setTimer: (fn) => ({ fn }),
    clearTimer: () => {},
    intervalMs: 1,
  });
  const armRunReconcileSweep = () => sweep.arm();

  wired = wireProduction({
    ssGet,
    ssSet,
    window: storage.window,
    RUN_COMPLETION_META_KEY,
    normalizeRunCompletionMetadata,
    mergeRunCompletionMetadata,
    selectDeferredRunCompletionMetadata,
    runCompletionContextKey,
    partitionRunCompletionMetadata,
    panelRunOwnerRef,
    mountOwner,
    bridgeRouteId: () => route,
    SESSION_KEY,
    runCompletion,
    armRunReconcileSweep,
    completionRestoreRoute: route,
    completionRestoreSession: ssGet(SESSION_KEY),
  });

  // The mount-time restore, exactly as buildPanel() performs it.
  if (wired.restoreRunCompletionMetadata(runCompletion, wired.completionRestore.current) > 0) {
    armRunReconcileSweep();
  }

  return {
    wired,
    runCompletion,
    flushed,
    reconciled,
    sweepArmed: () => sweep._hasTimer(),
    ledger: () =>
      normalizeRunCompletionMetadata(JSON.parse(storage.map.get(RUN_COMPLETION_META_KEY) ?? "[]")),
    /** One 600 ms poll tick with the canvas on `next` (or wherever it already is). */
    poll(next) {
      if (next !== undefined) route = next;
      if (withRehydrate) wired.rehydrateRef()?.();
    },
  };
}

const rowB = mkRow(ROUTE_B, "prompt-b", "queue-b");
const rowC = mkRow(ROUTE_C, "prompt-c", "queue-c");

test("#1839 P1(b) the pre-fix path: a deferred row is undeliverable for the life of the mount", () => {
  const m = mount(makeStorage([rowB, rowC]), { liveRoute: ROUTE_A, withRehydrate: false });
  assert.equal(m.runCompletion.isKnown("prompt-b"), false, "mounted on A: B's row is deferred");

  m.poll(ROUTE_B);

  assert.equal(m.runCompletion.isKnown("prompt-b"), false, "switching to B never adopts B's row");
  assert.equal(m.runCompletion.completionKeyFor("prompt-b"), null);
  // ...and this is why the reconcile sweep cannot be the recovery hook: it arms on
  // hasPending(), which a deferred row cannot make true.
  assert.equal(m.runCompletion.hasPending(), false);
  assert.equal(m.sweepArmed(), false, "the sweep stays disarmed for exactly the row that needs it");
  assert.deepEqual(m.reconciled, [], "no /history reconcile ever runs for B");
  assert.deepEqual(m.flushed, [], "no completion frame is ever composed for B");
  assert.deepEqual(
    m.ledger().map((r) => r.promptId).sort(),
    ["prompt-b", "prompt-c"],
    "the row is durable, not lost — only a LATER mount would ever pick it up",
  );
});

test("#1839 P1(b) a route change inside one mount adopts the rows that became current", () => {
  const m = mount(makeStorage([rowB, rowC]), { liveRoute: ROUTE_A });
  assert.equal(m.runCompletion.isKnown("prompt-b"), false, "not adopted while A is the canvas");

  m.poll(ROUTE_B);

  assert.equal(m.runCompletion.isKnown("prompt-b"), true, "B's row is adopted on the switch");
  assert.equal(
    m.runCompletion.completionKeyFor("prompt-b"),
    rowB.completionKey,
    "adopted with its EXACT persisted key, so the replay is the same panel_run receipt",
  );
  assert.equal(m.runCompletion.hasPending(), true);
  assert.equal(m.sweepArmed(), true, "the /history safety sweep is armed for the recovered run");
});

test("#1839 P1(b) CONTROL — a foreign row is still never restored", () => {
  const m = mount(makeStorage([rowB, rowC]), { liveRoute: ROUTE_A });
  m.poll(ROUTE_B);

  // C is not on the canvas. Replaying it here would stamp a completion frame for a
  // workflow the user is not looking at — the exact harm the partition exists to
  // prevent, and the reason this fix RE-COMPUTES rather than widening.
  assert.equal(m.runCompletion.isKnown("prompt-c"), false, "C's row must stay deferred");
  assert.equal(m.runCompletion.completionKeyFor("prompt-c"), null);
  assert.deepEqual(
    m.runCompletion.unsettledPromptIds().sort(),
    ["prompt-b"],
    "only the live route's run is pending delivery",
  );
  assert.deepEqual(
    m.ledger().map((r) => r.promptId).sort(),
    ["prompt-b", "prompt-c"],
    "and C's row survives untouched in storage for a mount of its own route",
  );
});

test("#1839 P1(b) CONTROL — a session change on the same route is still foreign", () => {
  // The route can stay put while the agent conversation changes, and a completion
  // owed to a retired conversation must not be replayed into the new one.
  const otherSession = {
    ...rowB,
    sessionId: "agent-session-9",
    completionKey: JSON.stringify([ROUTE_B, "agent-session-9", "prompt-b", "queue-b"]),
  };
  const m = mount(makeStorage([otherSession]), { liveRoute: ROUTE_A });
  m.poll(ROUTE_B);
  assert.equal(m.runCompletion.isKnown("prompt-b"), false, "same route, other session ⇒ deferred");
});

test("#1839 P1(b) CONTROL — an unestablished route adopts nothing", () => {
  // bridgeRouteId() REFUSES (returns null) until this tab's route identity leases.
  // Adopting under it would claim every row in storage for a route that does not
  // exist yet.
  const m = mount(makeStorage([rowB, rowC]), { liveRoute: null });
  assert.equal(m.wired.adoptRunCompletionContext(null, SESSION), false);
  assert.equal(m.wired.runCompletionContextNeedsAdoption(null, SESSION), false);
  assert.equal(m.wired.adoptedRunCompletionContexts.size, 0);
  assert.equal(m.runCompletion.isKnown("prompt-b"), false);
  assert.equal(m.runCompletion.isKnown("prompt-c"), false);

  // ...and the null → id edge IS a route change, so the lease landing recovers the
  // rows the mount-time partition had to defer.
  m.poll(ROUTE_B);
  assert.equal(m.runCompletion.isKnown("prompt-b"), true);
  assert.equal(m.runCompletion.isKnown("prompt-c"), false);
});

test("#1839 P1(b) an adopted row is retired for good — the deferred set is no longer frozen", () => {
  const m = mount(makeStorage([rowB, rowC]), { liveRoute: ROUTE_A });
  m.poll(ROUTE_B);
  assert.equal(m.runCompletion.isKnown("prompt-b"), true);

  // The recovered completion reaches the agent and is acknowledged.
  assert.equal(m.runCompletion.acknowledgeDelivery("prompt-b", rowB.completionKey), true);

  // A mount-time `partition().deferred` snapshot still calls B's row foreign and
  // re-merges it into this very write, resurrecting a completion the agent already
  // received. Re-reading the ledger at persist time is what retires it.
  assert.deepEqual(m.ledger().map((r) => r.promptId), ["prompt-c"], "B's row is gone once delivered");
});

test("#1839 P1(b) an UNREADABLE ledger is never adopted — a silence is not an empty ledger", () => {
  // codex P1: ssGet swallows a throwing sessionStorage, so readRunCompletionMetadata()
  // answers `[]` for both "nothing here" and "could not look". Adoption is
  // irreversible for the life of the mount, so adopting on that answer would strand
  // the rows for good AND make the next persist delete them as no-longer-foreign.
  const storage = makeStorage([rowB]);
  storage.state.failRead = true;

  const m = mount(storage, { liveRoute: ROUTE_B });
  assert.equal(m.wired.readRunCompletionMetadataOrUnknown(), null, "the read reports UNKNOWN");
  assert.equal(m.wired.readRunCompletionMetadata().length, 0, "...where the plain read says empty");
  assert.equal(m.wired.adoptedRunCompletionContexts.size, 0, "the mount context is NOT adopted");
  assert.equal(m.runCompletion.isKnown("prompt-b"), false);

  // A tick while it is still unreadable must not adopt either.
  m.poll();
  assert.equal(m.wired.adoptedRunCompletionContexts.size, 0);

  // The store recovers, and the very next poll adopts and restores.
  storage.state.failRead = false;
  m.poll();
  assert.equal(m.runCompletion.isKnown("prompt-b"), true, "recovered on the next tick");
  assert.equal(m.runCompletion.completionKeyFor("prompt-b"), rowB.completionKey);
  assert.equal(m.sweepArmed(), true);
});

test("#1839 P1(b) an UNREADABLE ledger at persist time never deletes another route's rows", () => {
  const m = mount(makeStorage([rowB, rowC]), { liveRoute: ROUTE_B });
  assert.equal(m.runCompletion.isKnown("prompt-b"), true);

  // Re-reading at persist time is what retires an adopted row; if the read fails,
  // the same write would drop every FOREIGN row instead — a completion nobody ever
  // delivers. Refusing the write is the same trade the delivery path makes.
  m.wired.persistOwnedRunCompletionMetadata([]);
  assert.deepEqual(m.ledger().map((r) => r.promptId), ["prompt-c"], "readable: B retires, C stays");

  const storage2 = makeStorage([rowB, rowC]);
  const m2 = mount(storage2, { liveRoute: ROUTE_B });
  storage2.state.failRead = true;
  m2.wired.persistOwnedRunCompletionMetadata([]);
  assert.deepEqual(
    m2.ledger().map((r) => r.promptId).sort(),
    ["prompt-b", "prompt-c"],
    "unreadable: the write is refused and NOTHING is deleted",
  );
});

test("#1839 P1(b) selectDeferredRunCompletionMetadata keeps exactly the unadopted contexts", () => {
  const adopted = new Set([runCompletionContextKey(ROUTE_B, SESSION)]);
  assert.deepEqual(selectDeferredRunCompletionMetadata([rowB, rowC], adopted), [rowC]);
  assert.deepEqual(selectDeferredRunCompletionMetadata([rowB, rowC], new Set()), [rowB, rowC]);
  assert.deepEqual(selectDeferredRunCompletionMetadata([rowB, rowC], undefined), [rowB, rowC]);
  assert.deepEqual(
    selectDeferredRunCompletionMetadata([rowB, rowC], [runCompletionContextKey(ROUTE_C, SESSION)]),
    [rowB],
  );
  // A context key separates route AND session, and a null session is its own value.
  assert.notEqual(runCompletionContextKey(ROUTE_B, SESSION), runCompletionContextKey(ROUTE_B, null));
  assert.equal(
    runCompletionContextKey(` ${ROUTE_B} `, ` ${SESSION} `),
    runCompletionContextKey(ROUTE_B, SESSION),
  );
});

test("#1839 P1(b) production WIRING — the poll drives the rehydrate and the persist re-reads", () => {
  // The hook has to fire on a route change INDEPENDENTLY of tracker state, and the
  // 600 ms workflow poll is the only thing in the panel that does. Assert the call
  // site is inside onWorkflowMaybeChanged, and that the poll drives that function.
  const pollFn = slice("  function onWorkflowMaybeChanged() {", "\n    const wf = activeWorkflowRef();");
  assert.match(pollFn, /rehydrateRunCompletionForLiveRouteRef\?\.\(\)/);
  assert.match(PANEL_SRC, /setInterval\(\(\) => onWorkflowMaybeChanged\(\), 600\)/);
  // It must run BEFORE the unchanged-route early return: `wfid` is the saved handle
  // and the bridge route moves without it.
  assert.ok(
    PANEL_SRC.indexOf("rehydrateRunCompletionForLiveRouteRef?.()") <
      PANEL_SRC.indexOf("return; // case 1: no change"),
  );
  // The ref is published from the mount and dropped on teardown.
  assert.match(PANEL_SRC, /\n  rehydrateRunCompletionForLiveRouteRef = rehydrateRunCompletionForLiveRoute;/);
  assert.match(
    PANEL_SRC,
    /if \(rehydrateRunCompletionForLiveRouteRef === rehydrateRunCompletionForLiveRoute\) \{\n\s*rehydrateRunCompletionForLiveRouteRef = null;/,
  );
  // The persist path re-reads the ledger instead of closing over a mount-time set,
  // and refuses the write when that read could not answer.
  assert.match(
    PANEL_SRC,
    /mergeRunCompletionMetadata\(\s*entries,\s*selectDeferredRunCompletionMetadata\(stored, adoptedRunCompletionContexts\),\s*\),\s*\);/,
  );
  assert.doesNotMatch(PANEL_SRC, /deferredRunCompletionMetadata/);
  // The restore is still RE-COMPUTED against the live route, never widened.
  assert.match(
    PANEL_SRC,
    /partitionRunCompletionMetadata\(stored, liveRoute, liveSession\)\.current/,
  );
});
