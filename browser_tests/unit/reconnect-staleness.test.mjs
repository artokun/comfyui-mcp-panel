// Unit tests for web/js/lib/reconnect-staleness.js — run with `node --test`.
//
// Regression coverage for #433: after a ComfyUI BACKEND restart the frontend can
// restore a DIFFERENT active tab than the user was last viewing, so workflow_list /
// graph_outline must flag `active` as possibly stale for a short window — until an
// explicit panel_open_workflow / panel_new_workflow re-points it authoritatively.
import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVE_STALE_WINDOW_MS,
  activeWorkflowPossiblyStale,
  activeStaleHint,
} from "../../web/js/lib/reconnect-staleness.js";

test("no reconnect recorded → never stale", () => {
  assert.equal(
    activeWorkflowPossiblyStale({ reconnectedAt: null, now: 1_000_000 }),
    false,
  );
  assert.equal(activeWorkflowPossiblyStale({ now: 1_000_000 }), false);
});

test("just reconnected, no resync → stale within the window", () => {
  const reconnectedAt = 1_000_000;
  assert.equal(
    activeWorkflowPossiblyStale({ reconnectedAt, now: reconnectedAt + 1 }),
    true,
  );
  assert.equal(
    activeWorkflowPossiblyStale({ reconnectedAt, now: reconnectedAt + ACTIVE_STALE_WINDOW_MS - 1 }),
    true,
  );
});

test("window elapsed → no longer stale", () => {
  const reconnectedAt = 1_000_000;
  assert.equal(
    activeWorkflowPossiblyStale({ reconnectedAt, now: reconnectedAt + ACTIVE_STALE_WINDOW_MS }),
    false,
  );
  assert.equal(
    activeWorkflowPossiblyStale({ reconnectedAt, now: reconnectedAt + ACTIVE_STALE_WINDOW_MS + 5000 }),
    false,
  );
});

test("explicit resync AT/AFTER the reconnect clears staleness immediately (#433 recovery)", () => {
  const reconnectedAt = 1_000_000;
  // panel_open_workflow / panel_new_workflow ran right after the reconnect.
  assert.equal(
    activeWorkflowPossiblyStale({
      reconnectedAt,
      resyncedAt: reconnectedAt + 10,
      now: reconnectedAt + 20,
    }),
    false,
  );
  // Resync exactly at the reconnect instant also counts as authoritative.
  assert.equal(
    activeWorkflowPossiblyStale({ reconnectedAt, resyncedAt: reconnectedAt, now: reconnectedAt + 5 }),
    false,
  );
});

test("a STALE resync (before the reconnect) does NOT clear the new window", () => {
  const reconnectedAt = 1_000_000;
  // The agent opened a tab, THEN the backend restarted — the pre-restart open is
  // no longer authoritative, so the freshly-reconnected active must still be flagged.
  assert.equal(
    activeWorkflowPossiblyStale({
      reconnectedAt,
      resyncedAt: reconnectedAt - 5000,
      now: reconnectedAt + 100,
    }),
    true,
  );
});

test("fail-safe: non-finite / missing inputs never flag (preserve report-as-is)", () => {
  assert.equal(activeWorkflowPossiblyStale({ reconnectedAt: NaN, now: 5 }), false);
  assert.equal(activeWorkflowPossiblyStale({ reconnectedAt: 5, now: NaN }), false);
  assert.equal(activeWorkflowPossiblyStale({ reconnectedAt: 5 }), false);
  // A `now` earlier than the reconnect (clock skew) yields a negative elapsed → not stale.
  assert.equal(activeWorkflowPossiblyStale({ reconnectedAt: 100, now: 50 }), false);
});

test("custom windowMs is honored", () => {
  const reconnectedAt = 1_000_000;
  assert.equal(
    activeWorkflowPossiblyStale({ reconnectedAt, now: reconnectedAt + 100, windowMs: 50 }),
    false,
  );
  assert.equal(
    activeWorkflowPossiblyStale({ reconnectedAt, now: reconnectedAt + 40, windowMs: 50 }),
    true,
  );
});

test("activeStaleHint names the risk and the recovery action", () => {
  const hint = activeStaleHint();
  assert.match(hint, /reconnect/i);
  assert.match(hint, /panel_open_workflow/);
  assert.match(hint, /active/i);
});
