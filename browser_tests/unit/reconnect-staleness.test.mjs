// Unit tests for web/js/lib/reconnect-staleness.js — run with `node --test`.
//
// Regression coverage for #433: after a ComfyUI BACKEND restart the frontend can
// restore a DIFFERENT active tab than the user was last viewing, so workflow_list /
// graph_outline must flag `active` as possibly stale for a short window — until an
// explicit panel_open_workflow / panel_new_workflow re-points it authoritatively.
//
// The staleness verdict combines an EPOCH (ordering: has a resync happened SINCE
// the latest reconnect?) with a MONOTONIC elapsed window (recency). Both guard
// against the two codex P1s: a same-millisecond pre-reconnect resync, and a
// non-monotonic wall clock.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ACTIVE_STALE_WINDOW_MS,
  activeWorkflowPossiblyStale,
  activeStaleHint,
} from "../../web/js/lib/reconnect-staleness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

test("no reconnect yet (epoch 0) → never stale", () => {
  assert.equal(
    activeWorkflowPossiblyStale({ reconnectEpoch: 0, reconnectedAt: 5, now: 6 }),
    false,
  );
  assert.equal(activeWorkflowPossiblyStale({ reconnectedAt: 5, now: 6 }), false);
});

test("first reconnect, no resync → stale within the window", () => {
  const reconnectedAt = 1_000_000;
  const base = { reconnectEpoch: 1, resyncEpoch: 0, reconnectedAt };
  assert.equal(activeWorkflowPossiblyStale({ ...base, now: reconnectedAt + 1 }), true);
  assert.equal(
    activeWorkflowPossiblyStale({ ...base, now: reconnectedAt + ACTIVE_STALE_WINDOW_MS - 1 }),
    true,
  );
});

test("window elapsed → no longer stale", () => {
  const reconnectedAt = 1_000_000;
  const base = { reconnectEpoch: 1, resyncEpoch: 0, reconnectedAt };
  assert.equal(
    activeWorkflowPossiblyStale({ ...base, now: reconnectedAt + ACTIVE_STALE_WINDOW_MS }),
    false,
  );
  assert.equal(
    activeWorkflowPossiblyStale({ ...base, now: reconnectedAt + ACTIVE_STALE_WINDOW_MS + 5000 }),
    false,
  );
});

test("resync FOR the current epoch clears staleness immediately (#433 recovery)", () => {
  const reconnectedAt = 1_000_000;
  // panel_open_workflow / panel_new_workflow ran after reconnect #1 → resyncEpoch=1.
  assert.equal(
    activeWorkflowPossiblyStale({
      reconnectEpoch: 1,
      resyncEpoch: 1,
      reconnectedAt,
      now: reconnectedAt + 20,
    }),
    false,
  );
});

test("a PRE-reconnect resync (older epoch) does NOT clear the new window (codex P1)", () => {
  // Open happened during epoch 1 (resyncEpoch=1), THEN the backend restarted →
  // reconnectEpoch=2. Even if reconnectedAt equals the open instant to the ms, the
  // older resync epoch (1 < 2) can't clear the epoch-2 window. This is the exact
  // same-millisecond suppression codex flagged.
  const t = 1_000_000;
  assert.equal(
    activeWorkflowPossiblyStale({
      reconnectEpoch: 2,
      resyncEpoch: 1,
      reconnectedAt: t,
      now: t, // zero elapsed, still inside the window
    }),
    true,
  );
});

test("monotonic window: a backwards `now` (should be impossible with performance.now) fails safe, never flags forever", () => {
  // performance.now() never runs backwards, so now < reconnectedAt cannot occur in
  // production. If it somehow did, the verdict is a benign `false` (report as-is) —
  // NOT a stuck-forever warning.
  assert.equal(
    activeWorkflowPossiblyStale({ reconnectEpoch: 1, resyncEpoch: 0, reconnectedAt: 100, now: 50 }),
    false,
  );
});

test("fail-safe: non-finite inputs never flag (preserve report-as-is)", () => {
  assert.equal(
    activeWorkflowPossiblyStale({ reconnectEpoch: NaN, reconnectedAt: 5, now: 6 }),
    false,
  );
  assert.equal(
    activeWorkflowPossiblyStale({ reconnectEpoch: 1, reconnectedAt: NaN, now: 6 }),
    false,
  );
  assert.equal(
    activeWorkflowPossiblyStale({ reconnectEpoch: 1, reconnectedAt: 5, now: NaN }),
    false,
  );
});

test("custom windowMs is honored", () => {
  const reconnectedAt = 1_000_000;
  const base = { reconnectEpoch: 1, resyncEpoch: 0, reconnectedAt };
  assert.equal(
    activeWorkflowPossiblyStale({ ...base, now: reconnectedAt + 100, windowMs: 50 }),
    false,
  );
  assert.equal(
    activeWorkflowPossiblyStale({ ...base, now: reconnectedAt + 40, windowMs: 50 }),
    true,
  );
});

test("activeStaleHint names the risk and the recovery action", () => {
  const hint = activeStaleHint();
  assert.match(hint, /reconnect/i);
  assert.match(hint, /panel_open_workflow/);
  assert.match(hint, /active/i);
});

// --- Wiring guards (close the codex "tests don't exercise the wiring" gap) ------
// The handlers need the real ComfyUI `app`/canvas to run, so we can't unit-invoke
// them here. Instead assert on the SOURCE that the wiring is present, so removing
// any of it fails a test rather than silently reintroducing the bug. To avoid a
// false-pass from a NEIGHBOUR handler's code (codex P2), each body is extracted up
// to the NEXT executor-method declaration, and ordering (sync BEFORE the membership
// read) is asserted explicitly.

/** Body of an object method from its `sig` up to the next 2-space-indented method
 *  declaration (executor methods are indented exactly 2 spaces; nested code is 4+),
 *  so the slice contains ONLY this handler — never a neighbour's. */
function handlerBody(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) return null;
  const after = start + sig.length;
  // Next `\n  name(` / `\n  async name(` — the following executor method.
  const m = src.slice(after).match(/\n {2}(?:async )?[A-Za-z_][A-Za-z0-9_]*\s*\(/);
  const end = m ? after + m.index : src.length;
  return src.slice(start, end);
}

test("#433 wiring: reconnect bumps the epoch on a MONOTONIC clock; open/new/readers wire it", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // Epoch bump + monotonic timestamp live inside the `reconnected` listener.
  const reconnectBlock = src.slice(
    src.indexOf('api.addEventListener("reconnected"'),
    src.indexOf('api.addEventListener("reconnected"') + 700,
  );
  assert.match(reconnectBlock, /backendReconnectEpoch \+= 1/, "reconnect must bump the epoch");
  assert.match(reconnectBlock, /backendReconnectedAt = monotonicNow\(\)/, "reconnect must arm the monotonic window");

  // Each explicit resync site (open AND new) must stamp the epoch GUARDED by the
  // TOCTOU check (codex P1): only when no reconnect intervened during the async op.
  // Both executors now also take the command `rid` (#402 open receipts), so match on the
  // signature PREFIX rather than the exact old zero-arg form.
  for (const sig of ["async workflow_new({", "async workflow_open({"]) {
    const body = handlerBody(src, sig);
    assert.ok(body, `${sig} must exist`);
    const snapAt = body.indexOf("const openedForEpoch = backendReconnectEpoch;");
    assert.notEqual(snapAt, -1, `${sig} must snapshot the epoch`);
    assert.match(
      body,
      /if \(backendReconnectEpoch === openedForEpoch\) activeWorkflowResyncEpoch = openedForEpoch;/,
      `${sig} must stamp the resync epoch ONLY if unchanged (TOCTOU guard)`,
    );
    // The snapshot MUST precede the first `await` — otherwise a reconnect during the
    // native work would advance the epoch before we capture it, reintroducing the
    // TOCTOU P1 with the guard still "present". Ordering, not mere presence.
    const firstAwaitAt = body.indexOf("await ");
    assert.notEqual(firstAwaitAt, -1, `${sig} is async and must contain an await`);
    assert.ok(
      snapAt < firstAwaitAt,
      `${sig} must snapshot openedForEpoch BEFORE the first await (snap@${snapAt} vs await@${firstAwaitAt})`,
    );
  }

  // BOTH readers must consult the helper — checked in their OWN bodies, not globally.
  for (const sig of ["workflow_list()", "graph_outline({"]) {
    const body = handlerBody(src, sig);
    assert.ok(body, `${sig} must exist`);
    assert.match(body, /activeWorkflowPossiblyStale\(\{/, `${sig} must check post-reconnect staleness`);
    assert.match(body, /reconnectEpoch: backendReconnectEpoch/, `${sig} must pass the epoch for ordering`);
    assert.match(body, /now: monotonicNow\(\)/, `${sig} must use the monotonic clock`);
  }
});

test("#429 wiring: every group-membership READ handler resyncs live rects BEFORE the read", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const handlers = [
    "graph_get_state()",
    "graph_outline({",
    "graph_query({",
    "graph_auto_layout({",
    "graph_subgraph_group({",
    "graph_edit_group({",
    "graph_remove_group({",
  ];
  for (const sig of handlers) {
    const body = handlerBody(src, sig);
    assert.ok(body, `handler ${sig} must exist`);
    const syncAt = body.indexOf("syncGraphNodeAreas(graph)");
    assert.notEqual(syncAt, -1, `handler ${sig} must resync live rects (#429)`);
    // The membership read is via summarizeGroup(...) or groupMemberNodes(...).
    const readMatch = body.match(/summarizeGroup\(graph|groupMemberNodes\(graph/);
    assert.ok(readMatch, `handler ${sig} must read geometric membership`);
    assert.ok(
      syncAt < readMatch.index,
      `handler ${sig} must resync BEFORE computing membership (sync@${syncAt} vs read@${readMatch.index})`,
    );
  }
});
