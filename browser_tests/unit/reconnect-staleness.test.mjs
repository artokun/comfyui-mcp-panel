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
// any of it fails a test rather than silently reintroducing the bug.

test("#433 wiring: reconnect bumps the epoch on a MONOTONIC clock, open/new record it", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // Epoch bump + monotonic timestamp live inside the `reconnected` listener.
  const reconnectBlock = src.slice(
    src.indexOf('api.addEventListener("reconnected"'),
    src.indexOf('api.addEventListener("reconnected"') + 700,
  );
  assert.match(reconnectBlock, /backendReconnectEpoch \+= 1/, "reconnect must bump the epoch");
  assert.match(reconnectBlock, /backendReconnectedAt = monotonicNow\(\)/, "reconnect must arm the monotonic window");
  // Both explicit resync sites stamp the CURRENT epoch (not a wall-clock time).
  const resyncStamps = src.match(/activeWorkflowResyncEpoch = backendReconnectEpoch/g) ?? [];
  assert.ok(resyncStamps.length >= 2, `open AND new must record the resync epoch (found ${resyncStamps.length})`);
  // The read tools consult the helper with the epoch pair + monotonic now.
  const readerCalls = src.match(/activeWorkflowPossiblyStale\(\{/g) ?? [];
  assert.ok(readerCalls.length >= 2, `workflow_list + graph_outline must both check staleness (found ${readerCalls.length})`);
  assert.match(src, /reconnectEpoch: backendReconnectEpoch/, "readers pass the epoch for ordering");
  assert.match(src, /now: monotonicNow\(\)/, "readers use the monotonic clock");
});

test("#429 wiring: every group-membership READ handler resyncs live rects first", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // For each handler, take the slice from its declaration to the next handler and
  // assert syncGraphNodeAreas appears before the geometric membership read.
  const handlers = [
    "graph_get_state()",
    "graph_outline()",
    "graph_query({",
    "graph_auto_layout({",
    "graph_subgraph_group({",
    "graph_edit_group({",
    "graph_remove_group({",
  ];
  for (const sig of handlers) {
    const start = src.indexOf(sig);
    assert.notEqual(start, -1, `handler ${sig} must exist`);
    // Bound the slice to a reasonable handler size so we test THIS handler's body.
    const body = src.slice(start, start + 2200);
    assert.match(
      body,
      /syncGraphNodeAreas\(graph\)/,
      `handler ${sig} must resync live rects before reading geometric membership (#429)`,
    );
  }
});
