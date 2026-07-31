// Unit tests for per-turn revert snapshot selection (web/js/lib/graph-revert.js).
//
// Regression coverage for #327: /revert restored graphSnapshots[last]
// unconditionally, so after a turn cleared/replaced the graph — and the next
// message snapshotted that already-changed graph — the newest snapshot equaled
// the current canvas and reverting to it recovered nothing (silent no-op).
import test from "node:test";
import assert from "node:assert/strict";

import { pickRevertSnapshot } from "../../web/js/lib/graph-revert.js";

const snap = (data) => ({ mid: null, ts: 0, data });
// Distinct serialized-graph shapes standing in for rootGraph.serialize() output.
const GRAPH_A = { nodes: [{ id: 1, type: "KSampler" }], links: [] };
const GRAPH_B = { nodes: [{ id: 2, type: "SaveImage" }], links: [] };
const EMPTY = { nodes: [], links: [] };

test("skips an identical latest snapshot, reverts to the prior different one (#327)", () => {
  // A (non-empty) → turn cleared it → next message snapshotted EMPTY.
  const ring = [snap(GRAPH_A), snap(EMPTY)];
  // Current canvas is EMPTY, equal to the newest snapshot.
  const chosen = pickRevertSnapshot(ring, EMPTY);
  assert.equal(chosen.data, GRAPH_A, "reverts to the earlier non-empty graph, not the no-op latest");
});

test("returns null when EVERY snapshot equals the current graph (nothing to revert)", () => {
  const ring = [snap(GRAPH_A), snap(GRAPH_A)];
  assert.equal(pickRevertSnapshot(ring, GRAPH_A), null);
});

test("returns the newest snapshot when it already differs from current", () => {
  const ring = [snap(GRAPH_A), snap(GRAPH_B)];
  // Current is something else again → newest (B) is a genuine prior state.
  assert.equal(pickRevertSnapshot(ring, EMPTY).data, GRAPH_B);
});

test("walks back past MULTIPLE identical snapshots to the first real difference", () => {
  const ring = [snap(GRAPH_A), snap(EMPTY), snap(EMPTY)];
  assert.equal(pickRevertSnapshot(ring, EMPTY).data, GRAPH_A);
});

test("empty / missing ring yields null", () => {
  assert.equal(pickRevertSnapshot([], GRAPH_A), null);
  assert.equal(pickRevertSnapshot(null, GRAPH_A), null);
  assert.equal(pickRevertSnapshot(undefined, GRAPH_A), null);
});

test("accepts a pre-stringified snapshot.data and compares canonically", () => {
  // Key order matches because both come from the same serializer; equality holds.
  const ring = [snap(JSON.stringify(GRAPH_A)), snap(JSON.stringify(EMPTY))];
  // Current EMPTY (object) canonicalizes to the same string as the newest snap →
  // skip it, land on the stringified GRAPH_A.
  assert.equal(pickRevertSnapshot(ring, EMPTY), ring[0]);
  // And a differing current still selects the newest.
  assert.equal(pickRevertSnapshot(ring, GRAPH_B).data, JSON.stringify(EMPTY));
});

test("tolerates holes in the ring without throwing", () => {
  const ring = [snap(GRAPH_A), null, snap(EMPTY)];
  assert.equal(pickRevertSnapshot(ring, EMPTY).data, GRAPH_A);
});

test("treats key-reordered but structurally-equal graphs as identical (no false revert)", () => {
  // Same graph, different object key insertion order — must canonicalize equal so
  // the newest snapshot is recognized as a no-op and skipped, not restored.
  const newest = { nodes: [{ id: 1, type: "KSampler" }], links: [], version: 0.4 };
  const currentReordered = { version: 0.4, links: [], nodes: [{ type: "KSampler", id: 1 }] };
  const ring = [snap(GRAPH_A), snap(newest)];
  // Current equals `newest` up to key order → skip it, land on the real prior graph.
  assert.equal(pickRevertSnapshot(ring, currentReordered).data, GRAPH_A);
  // And when the ONLY snapshot equals current (reordered), nothing to revert.
  assert.equal(pickRevertSnapshot([snap(newest)], currentReordered), null);
});
