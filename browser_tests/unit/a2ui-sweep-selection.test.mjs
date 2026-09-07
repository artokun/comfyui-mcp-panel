// #2183 — the no-card_id sweep's SELECTION, driven rather than grepped.
//
// `a2ui-dismiss-recovery.test.mjs` pins this handler by matching the source text of
// `onUiDismiss` (`assert.match(dismiss, /rec\.resolved = true/)` and friends), and no
// `.spec.ts` in browser_tests exercises `ui_dismiss` either — so across both suites
// nothing ran this path. That matters here because the sweep is DESTRUCTIVE: it sets
// `resolved` on records, touches the history store, removes DOM nodes and persists,
// and it runs during the reload/rebind window, when things are already going wrong.
// A reorder or rename that keeps the text passes every source assertion.
//
// The selection is the whole contract — a2ui only, unresolved only — and it decides
// how much a destructive recovery destroys. Pure, so this needs no thread, store,
// DOM or bridge.
import test from "node:test";
import assert from "node:assert/strict";

import { unresolvedA2UICards } from "../../web/js/lib/a2ui-sweep.js";

test("#2183 sweeps only UNRESOLVED a2ui records, in thread order", () => {
  const a = { kind: "a2ui", id: "m1", cardId: "c1" };
  const done = { kind: "a2ui", id: "m2", cardId: "c2", resolved: true };
  const b = { kind: "a2ui", id: "m3", cardId: "c3" };
  const picked = unresolvedA2UICards([a, done, b]);
  assert.deepEqual(
    picked.map((r) => r.id),
    ["m1", "m3"],
    "an already-resolved card must be left alone: re-resolving it is a second dismissal of something the user already dealt with",
  );
});

test("#2183 never sweeps a non-a2ui record", () => {
  // The thread holds chat turns, images and status rows. A sweep that walked those
  // would mark unrelated history as resolved and persist it.
  const msgs = [
    { kind: "text", id: "t1" },
    { kind: "image", id: "i1" },
    { kind: "a2ui", id: "m1" },
    { kind: undefined, id: "u1" },
  ];
  assert.deepEqual(
    unresolvedA2UICards(msgs).map((r) => r.id),
    ["m1"],
  );
});

test("#2183 `resolved` is compared to TRUE, not merely truthy", () => {
  // A record carrying a non-boolean (a timestamp, a string) must not read as
  // already-dismissed and be skipped — that would silently leave a live card behind
  // on the one path whose job is to remove it.
  const stamped = { kind: "a2ui", id: "m1", resolved: 1_725_400_000_000 };
  const stringy = { kind: "a2ui", id: "m2", resolved: "yes" };
  assert.deepEqual(
    unresolvedA2UICards([stamped, stringy]).map((r) => r.id),
    ["m1", "m2"],
  );
});

test("#2183 an absent or empty thread sweeps nothing, and does not throw", () => {
  // The recovery fires during reload/rebind, which is exactly when the thread can
  // be missing. `onUiDismiss` passes `thread?.msgs` straight through.
  assert.deepEqual(unresolvedA2UICards(undefined), []);
  assert.deepEqual(unresolvedA2UICards(null), []);
  assert.deepEqual(unresolvedA2UICards([]), []);
});

test("#2183 a null hole in the thread is skipped rather than throwing", () => {
  const msgs = [null, { kind: "a2ui", id: "m1" }, undefined];
  assert.deepEqual(
    unresolvedA2UICards(msgs).map((r) => r.id),
    ["m1"],
  );
});
