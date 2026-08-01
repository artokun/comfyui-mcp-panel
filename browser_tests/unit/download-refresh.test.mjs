// Unit tests for the download-completion combo-refresh transition (issue #396):
// a freshly downloaded model must become SELECTABLE on the live canvas without a
// manual reload. reconcileCompletedDownloads decides WHEN to fire the refresh —
// once per completed download, never on an error, never twice for a lingering
// done row.
import test from "node:test";
import assert from "node:assert/strict";

import { reconcileCompletedDownloads } from "../../web/js/lib/download-refresh.js";

test("a download reaching done fires exactly once", () => {
  let seen = new Set();
  // Still downloading — nothing to refresh yet.
  let r = reconcileCompletedDownloads([{ id: "d1", name: "vae.safetensors", status: "downloading" }], seen);
  assert.deepEqual(r.newlyDone, []);
  seen = r.nextSeen;
  // Transitions to done — fire once.
  r = reconcileCompletedDownloads([{ id: "d1", name: "vae.safetensors", status: "done" }], seen);
  assert.deepEqual(r.newlyDone, ["d1"]);
  seen = r.nextSeen;
  // The done row LINGERS in the tray on subsequent frames — must NOT re-fire.
  r = reconcileCompletedDownloads([{ id: "d1", name: "vae.safetensors", status: "done" }], seen);
  assert.deepEqual(r.newlyDone, []);
});

test("an error row never triggers a refresh", () => {
  const r = reconcileCompletedDownloads([{ id: "e1", name: "bad", status: "error" }], new Set());
  assert.deepEqual(r.newlyDone, []);
  assert.equal(r.nextSeen.has("e1"), false);
});

test("many files completing on one frame all count as newly done (caller coalesces the refresh)", () => {
  const rows = [
    { id: "a", status: "done" },
    { id: "b", status: "done" },
    { id: "c", status: "downloading" },
  ];
  const r = reconcileCompletedDownloads(rows, new Set());
  assert.deepEqual(r.newlyDone.sort(), ["a", "b"]);
  assert.equal(r.nextSeen.has("c"), false);
});

test("a pruned-then-re-downloaded id can fire again", () => {
  let seen = new Set();
  seen = reconcileCompletedDownloads([{ id: "d1", status: "done" }], seen).nextSeen;
  // Row pruned from the tray (disappears) — id drops from the tracked set.
  seen = reconcileCompletedDownloads([], seen).nextSeen;
  assert.equal(seen.has("d1"), false);
  // Same target re-downloaded and completed again — fires anew.
  const r = reconcileCompletedDownloads([{ id: "d1", status: "done" }], seen);
  assert.deepEqual(r.newlyDone, ["d1"]);
});

test("rows are keyed by id, falling back to name; shapeless rows are ignored", () => {
  const r = reconcileCompletedDownloads(
    [
      { name: "only-name.ckpt", status: "done" },
      { status: "done" }, // no id/name → ignored
      null,
      "junk",
    ],
    new Set(),
  );
  assert.deepEqual(r.newlyDone, ["only-name.ckpt"]);
});

test("non-array / undefined frame is a no-op", () => {
  const r = reconcileCompletedDownloads(undefined, new Set());
  assert.deepEqual(r.newlyDone, []);
  assert.equal(r.nextSeen.size, 0);
});
