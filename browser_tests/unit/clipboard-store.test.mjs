/**
 * Unit tests for web/js/lib/clipboard-store.js — run with `node --test`.
 *
 * Reproduces panel#500: `panel_copy_nodes` copying 8 nodes (each carrying a
 * large widget payload) from a 38-node workflow threw
 * `QuotaExceededError: The quota has been exceeded.` because LiteGraph's
 * `copyToClipboard` persists to localStorage, and the subsequent
 * `panel_paste_nodes` then pasted ZERO nodes. `withInMemoryClipboard` backs the
 * clipboard key with a non-quota-limited in-memory store so the copy survives
 * and the paste faithfully reconstructs the nodes and the links among them.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CLIPBOARD_KEY,
  OVERFLOW_SENTINEL,
  withInMemoryClipboard,
  getInMemoryClipboard,
  getEffectiveClipboard,
  resolveClipboardPayload,
  clearInMemoryClipboard,
} from "../../web/js/lib/clipboard-store.js";

// A localStorage-like mock. `quotaBytes` bounds the TOTAL stored size; a write
// that would exceed it throws the exact DOMException message browsers use, so
// the test exercises the real failure path (not a stand-in error).
function makeStorage({ quotaBytes = Infinity } = {}) {
  const map = new Map();
  const size = () => {
    let n = 0;
    for (const [k, v] of map) n += k.length + v.length;
    return n;
  };
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      const val = String(v);
      const projected = size() - (map.has(k) ? k.length + map.get(k).length : 0) + k.length + val.length;
      if (projected > quotaBytes) {
        const err = new Error("The quota has been exceeded.");
        err.name = "QuotaExceededError";
        throw err;
      }
      map.set(k, val);
    },
    removeItem(k) {
      map.delete(k);
    },
    _raw: map,
  };
}

// Minimal LiteGraph-ish canvas: copyToClipboard serializes the selected nodes
// AND the links whose BOTH ends are in the selection (intra-set links), exactly
// like LiteGraph, persisting to storage[CLIPBOARD_KEY]. pasteFromClipboard reads
// that key, re-creates nodes with fresh ids, and rewires the intra-set links.
function makeGraph() {
  let nextId = 1000;
  const graph = { _nodes: [] };
  const canvas = {
    graph,
    selectedItems: new Set(),
    copyToClipboard(items) {
      const nodes = [...items].map((n) => ({ id: n.id, type: n.type, widgets_values: n.widgets_values }));
      const idset = new Set(nodes.map((n) => n.id));
      const links = [];
      for (const n of items) {
        for (const l of n._outgoing ?? []) {
          if (idset.has(l.to)) links.push({ from: n.id, to: l.to, slot: l.slot });
        }
      }
      // This is the write that overflows localStorage in the bug.
      this.storage.setItem(CLIPBOARD_KEY, JSON.stringify({ nodes, links }));
    },
    pasteFromClipboard() {
      const raw = this.storage.getItem(CLIPBOARD_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      const idMap = new Map();
      for (const n of data.nodes ?? []) {
        const fresh = { id: ++nextId, type: n.type, widgets_values: n.widgets_values, _outgoing: [] };
        idMap.set(n.id, fresh.id);
        graph._nodes.push(fresh);
      }
      for (const l of data.links ?? []) {
        const from = graph._nodes.find((x) => x.id === idMap.get(l.from));
        if (from && idMap.has(l.to)) from._outgoing.push({ to: idMap.get(l.to), slot: l.slot });
      }
    },
  };
  return { graph, canvas };
}

// 8 nodes each carrying a ~700 KB widget value → ~5.6 MB, over a 5 MB quota.
function bigSelection(n = 8) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({ id: 10 + i, type: `Big.Node${i}`, widgets_values: ["x".repeat(700 * 1024)], _outgoing: [] });
  }
  // Two intra-set links so paste must reconstruct edges among the copied set.
  items[0]._outgoing.push({ to: items[1].id, slot: 0 });
  items[1]._outgoing.push({ to: items[2].id, slot: 0 });
  return items;
}

test("copy of a large selection does not throw despite localStorage quota", () => {
  clearInMemoryClipboard();
  const storage = makeStorage({ quotaBytes: 5 * 1024 * 1024 });
  const { canvas } = makeGraph();
  canvas.storage = storage;
  const sel = bigSelection(8);

  // Direct localStorage write overflows — proves the mock reproduces the bug.
  assert.throws(() => storage.setItem(CLIPBOARD_KEY, JSON.stringify(sel)), /quota has been exceeded/i);

  // Through the in-memory store the same copy succeeds and populates the clipboard.
  assert.doesNotThrow(() => withInMemoryClipboard(storage, () => canvas.copyToClipboard(sel)));
  const payload = getInMemoryClipboard();
  assert.ok(payload && payload.length > 5 * 1024 * 1024, "in-memory clipboard holds the oversized payload");
  const persisted = storage.getItem(CLIPBOARD_KEY);
  assert.notEqual(persisted, payload, "oversized payload was NOT written to localStorage");
  assert.equal(persisted, OVERFLOW_SENTINEL, "localStorage holds the small overflow sentinel instead");
});

test("paste after an overflowed copy reconstructs all nodes and intra-set links", () => {
  clearInMemoryClipboard();
  const storage = makeStorage({ quotaBytes: 5 * 1024 * 1024 });
  const src = makeGraph();
  src.canvas.storage = storage;
  const sel = bigSelection(8);
  withInMemoryClipboard(storage, () => src.canvas.copyToClipboard(sel));

  // Switch to a DIFFERENT (empty) workflow and paste.
  const dst = makeGraph();
  dst.canvas.storage = storage;
  withInMemoryClipboard(storage, () => dst.canvas.pasteFromClipboard());

  assert.equal(dst.graph._nodes.length, 8, "all 8 nodes pasted (not zero)");
  const edges = dst.graph._nodes.flatMap((n) => n._outgoing.map((l) => l.to));
  assert.equal(edges.length, 2, "both intra-set links reconstructed in the target workflow");
  // Fresh ids, all wire targets point at pasted nodes.
  const ids = new Set(dst.graph._nodes.map((n) => n.id));
  for (const t of edges) assert.ok(ids.has(t), "link target is a pasted node");
});

test("small copy mirrors to localStorage so native Ctrl+V still works", () => {
  clearInMemoryClipboard();
  const storage = makeStorage({ quotaBytes: 5 * 1024 * 1024 });
  const { canvas } = makeGraph();
  canvas.storage = storage;
  const sel = [{ id: 1, type: "T", widgets_values: ["small"], _outgoing: [] }];
  withInMemoryClipboard(storage, () => canvas.copyToClipboard(sel));
  assert.ok(storage.getItem(CLIPBOARD_KEY), "small payload mirrored to localStorage");
  assert.equal(getEffectiveClipboard(storage), getInMemoryClipboard());
});

test("storage methods are restored after the wrapped call", () => {
  const storage = makeStorage();
  const set = storage.setItem;
  const get = storage.getItem;
  withInMemoryClipboard(storage, () => storage.setItem(CLIPBOARD_KEY, "{}"));
  assert.equal(storage.setItem, set, "setItem restored");
  assert.equal(storage.getItem, get, "getItem restored");
});

test("resolveClipboardPayload: native Ctrl+C after copy wins over stale in-memory", () => {
  clearInMemoryClipboard();
  const storage = makeStorage({ quotaBytes: 5 * 1024 * 1024 });
  const { canvas } = makeGraph();
  canvas.storage = storage;
  // Overflowed tool copy → in-memory only.
  withInMemoryClipboard(storage, () => canvas.copyToClipboard(bigSelection(8)));
  // No native copy yet → paste uses the in-memory payload.
  assert.equal(getEffectiveClipboard(storage), getInMemoryClipboard());
  // A native Ctrl+C now writes a small, fresh payload directly to localStorage.
  storage.setItem(CLIPBOARD_KEY, JSON.stringify({ nodes: [{ id: 5, type: "Native" }], links: [] }));
  const eff = getEffectiveClipboard(storage);
  assert.match(eff, /Native/, "localStorage change since copy is trusted over stale in-memory");
  assert.notEqual(eff, getInMemoryClipboard());
});

test("overflow replaces the stale localStorage value with the sentinel", () => {
  clearInMemoryClipboard();
  const storage = makeStorage({ quotaBytes: 5 * 1024 * 1024 });
  // A prior native copy sits in localStorage before the overflowing tool copy.
  const priorNative = JSON.stringify({ nodes: [{ id: 7, type: "Prior" }], links: [] });
  storage.setItem(CLIPBOARD_KEY, priorNative);

  const { canvas } = makeGraph();
  canvas.storage = storage;
  withInMemoryClipboard(storage, () => canvas.copyToClipboard(bigSelection(8)));

  // The stale prior value is gone — replaced by the small sentinel, not left as-is.
  assert.equal(storage.getItem(CLIPBOARD_KEY), OVERFLOW_SENTINEL);
  // Paste still resolves to the in-memory payload.
  assert.equal(getEffectiveClipboard(storage), getInMemoryClipboard());
});

test("native Ctrl+C reproducing the PRE-COPY bytes still wins over stale in-memory", () => {
  // The exact hole the review flagged: after an overflow, a native re-copy whose
  // serialized bytes equal what localStorage held BEFORE the tool copy must be
  // honored — not shadowed by the stale in-memory payload.
  clearInMemoryClipboard();
  const storage = makeStorage({ quotaBytes: 5 * 1024 * 1024 });
  const priorNative = JSON.stringify({ nodes: [{ id: 7, type: "Prior" }], links: [] });
  storage.setItem(CLIPBOARD_KEY, priorNative);

  const { canvas } = makeGraph();
  canvas.storage = storage;
  withInMemoryClipboard(storage, () => canvas.copyToClipboard(bigSelection(8)));
  // Native Ctrl+C copies the SAME selection as the pre-copy clipboard → identical bytes.
  storage.setItem(CLIPBOARD_KEY, priorNative);

  const eff = getEffectiveClipboard(storage);
  assert.equal(eff, priorNative, "byte-identical native re-copy is honored");
  assert.notEqual(eff, getInMemoryClipboard(), "stale in-memory payload is NOT used");
});

test("storage-entirely-full fallback: preserves the tool copy, and a native change still wins", () => {
  // The doubly-degenerate case: not even the 43-byte sentinel fits (localStorage
  // packed to the byte — NOT the panel#500 scenario). The just-copied payload is
  // still preserved on paste, and a genuine native Ctrl+C that changes the bytes
  // is still honored. (A byte-identical native re-copy in this packed state is a
  // fundamental value-comparison limit and is documented as such.)
  clearInMemoryClipboard();
  // Short prior value so replacing it with the (larger) sentinel would GROW the
  // total and thus also overflow — forcing the storage-entirely-full branch.
  const priorNative = "pn-native";
  const filler = "x".repeat(4000);
  // Cap the quota exactly at the seeded total so any size increase overflows,
  // but a same-size rewrite of the clipboard key still fits.
  const total = "junk".length + filler.length + CLIPBOARD_KEY.length + priorNative.length;
  const capped = makeStorage({ quotaBytes: total });
  capped._raw.set("junk", filler);
  capped._raw.set(CLIPBOARD_KEY, priorNative);

  const { canvas } = makeGraph();
  canvas.storage = capped;
  // Overflow copy: payload write throws; sentinel write also throws (it's larger
  // than the short prior value, so it would grow the total past the cap).
  withInMemoryClipboard(capped, () => canvas.copyToClipboard(bigSelection(8)));
  assert.equal(capped.getItem(CLIPBOARD_KEY), priorNative, "clipboard key left unchanged (sentinel couldn't fit)");

  // No intervening native write → the just-copied payload is preserved, so paste
  // gets the real nodes rather than the stale/old clipboard.
  assert.equal(getEffectiveClipboard(capped), getInMemoryClipboard(), "tool copy preserved");

  // A genuine native Ctrl+C that CHANGES the bytes (same size → fits) still wins.
  const nativeChanged = "nn-native";
  capped.setItem(CLIPBOARD_KEY, nativeChanged);
  const eff = getEffectiveClipboard(capped);
  assert.equal(eff, nativeChanged, "native change is honored over in-memory");
  assert.notEqual(eff, getInMemoryClipboard());
});

test("resolveClipboardPayload: passthrough when nothing captured", () => {
  clearInMemoryClipboard();
  assert.equal(resolveClipboardPayload("abc"), "abc");
  assert.equal(resolveClipboardPayload(null), null);
});
