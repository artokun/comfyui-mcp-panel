// Pure snapshot selection for the per-turn graph revert (#44 rollback, bug #327).
//
// The panel keeps a bounded ring of pre-turn graph snapshots (oldest → newest).
// The naive "revert" restored graphSnapshots[last] unconditionally. But after an
// agent turn REPLACES or CLEARS the graph, the user's next message captures a
// fresh pre-turn snapshot of the ALREADY-changed graph, so the newest snapshot
// equals the current canvas — reverting to it is a silent no-op that can't
// recover the prior workflow (#327).
//
// pickRevertSnapshot walks newest → oldest and returns the first snapshot whose
// serialized graph actually DIFFERS from the current state, so /revert lands on
// the nearest genuinely-different pre-turn graph. Returns null when every
// snapshot equals the current graph (nothing to revert to) — the caller surfaces
// that honestly instead of pretending a no-op succeeded.
//
// Dependency-free (no LiteGraph, no DOM). Comparison is by a STABLE canonical
// form (object keys sorted recursively; array order preserved, since node/link
// order is semantically meaningful) so two structurally-equal graphs that merely
// serialized their object keys in a different insertion order still compare
// equal — otherwise a logically-identical latest snapshot could slip through the
// difference test and reintroduce the no-op revert this fix removes. A
// pre-stringified snapshot.data is re-parsed so it canonicalizes the same way.
// Unit-testable with plain object fixtures.

/** Recursively key-sorted JSON so equality is independent of key insertion order. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** Stable string form of a serialized graph (or a pre-stringified snapshot). */
function canonicalize(data) {
  if (data == null) return "";
  try {
    // Re-parse a pre-stringified snapshot so it goes through the same key-sort.
    const obj = typeof data === "string" ? JSON.parse(data) : data;
    return stableStringify(obj);
  } catch {
    // Unparseable / circular — treat as its own unique value so it never
    // spuriously matches the current graph and blocks a legitimate revert.
    return null;
  }
}

/**
 * @param {Array<{data:unknown}>} snapshots  pre-turn ring, oldest → newest
 * @param {unknown} currentSerialized  the LIVE graph's serialize() output (object or string)
 * @returns the most recent snapshot that differs from the current graph, or null
 */
export function pickRevertSnapshot(snapshots, currentSerialized) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return null;
  const current = canonicalize(currentSerialized);
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const snap = snapshots[i];
    if (!snap) continue;
    const snapForm = canonicalize(snap.data);
    // A snapshot that can't be compared (null) is always eligible; otherwise
    // require a genuine difference from the current graph.
    if (snapForm === null || current === null || snapForm !== current) return snap;
  }
  return null;
}
