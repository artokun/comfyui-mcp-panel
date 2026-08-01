// Unit tests for the robust node-removal wrapper (web/js/lib/safe-remove-node.js).
//
// Regression coverage for #420: on rapid batched removals litegraph intermittently
// throws "t.findInputSlot is not a function" while disconnecting a link whose far end
// momentarily isn't a proper LGraphNode, aborting the removal (the same call succeeds
// on retry). safeRemoveNode severs the node's links via the link RECORDS (far-end
// method-free) and retries once.
import test from "node:test";
import assert from "node:assert/strict";

import {
  safeRemoveNode,
  severNodeLinks,
  isLinkDisconnectCrash,
} from "../../web/js/lib/safe-remove-node.js";

// Minimal litegraph-shaped mock. `_links` is a Map<id, {id,origin_id,origin_slot,
// target_id,target_slot}>. graph.remove(node) reproduces litegraph: walk this node's
// links and touch the far end. A NON-NULL far end that lacks findInputSlot (a
// non-LGraphNode) reproduces the #420 crash → THROW. A NULL far end (rail / already
// gone) is SKIPPED — litegraph's `if (target) {...}` guard — and its record deleted,
// never a throw.
function makeGraph() {
  const nodesById = new Map();
  const graph = {
    _links: new Map(),
    inputNode: null,
    outputNode: null,
    getNodeById: (id) => nodesById.get(id) ?? null,
    _register: (n) => nodesById.set(n.id, n),
    remove(node) {
      for (const out of node.outputs ?? []) {
        for (const id of Array.isArray(out.links) ? [...out.links] : []) {
          const link = this._links.get(id);
          if (!link) continue;
          const far = this.getNodeById(link.target_id);
          if (far != null && typeof far.findInputSlot !== "function") {
            throw new TypeError("t.findInputSlot is not a function");
          }
          if (far) far.inputs[link.target_slot].link = null;
          this._links.delete(id);
        }
        out.links = null;
      }
      for (const inp of node.inputs ?? []) {
        if (inp.link != null) {
          const link = this._links.get(inp.link);
          if (link) {
            const far = this.getNodeById(link.origin_id);
            if (far != null && typeof far.findInputSlot !== "function") {
              throw new TypeError("t.findInputSlot is not a function");
            }
            this._links.delete(inp.link);
          }
          inp.link = null;
        }
      }
      nodesById.delete(node.id);
      node._removed = true;
    },
  };
  return graph;
}

// Build a graph: node A (output) → node B (input), where B is optionally a "bad"
// far end that lacks findInputSlot (the crash trigger).
function wireAtoB(graph, { bBad }) {
  const B = bBad
    ? { id: 2, inputs: [{ name: "in", link: 10 }], outputs: [] } // no findInputSlot
    : { id: 2, inputs: [{ name: "in", link: 10 }], outputs: [], findInputSlot: () => 0 };
  const A = {
    id: 1,
    inputs: [],
    outputs: [{ name: "out", links: [10] }],
    findInputSlot: () => -1,
  };
  graph._register(A);
  graph._register(B);
  graph._links.set(10, { id: 10, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 });
  return { A, B };
}

test("normal removal (no throw) → removed, not recovered, remove() called once", () => {
  const graph = makeGraph();
  const { A } = wireAtoB(graph, { bBad: false });
  let calls = 0;
  const orig = graph.remove.bind(graph);
  graph.remove = (n) => { calls++; return orig(n); };
  const res = safeRemoveNode(graph, A);
  assert.deepEqual(res, { removed: true, recovered: false });
  assert.equal(calls, 1);
  assert.equal(graph.getNodeById(1), null, "node A is gone");
  assert.equal(graph._links.has(10), false, "the link was removed");
});

test("bad far end throws on first remove, sever+retry succeeds (#420 core)", () => {
  const graph = makeGraph();
  const { A, B } = wireAtoB(graph, { bBad: true }); // B lacks findInputSlot → crash
  const res = safeRemoveNode(graph, A);
  assert.deepEqual(res, { removed: true, recovered: true });
  assert.equal(graph.getNodeById(1), null, "node A was removed on the retry");
  assert.equal(graph._links.has(10), false, "the dangling link record was severed");
  // The far end B survives and its stale input ref was cleared by the sever (direct
  // property write, no findInputSlot call).
  assert.equal(graph.getNodeById(2), B, "far end B is untouched as a node");
  assert.equal(B.inputs[0].link, null, "B's stale input link ref was cleared");
});

test("severNodeLinks clears both this node's slots and reachable far-end refs", () => {
  const graph = makeGraph();
  // A.out → B.in (id 10); C.out → A.in (id 11).
  const A = {
    id: 1,
    inputs: [{ name: "cin", link: 11 }],
    outputs: [{ name: "out", links: [10] }],
  };
  const B = { id: 2, inputs: [{ name: "in", link: 10 }], outputs: [] };
  const C = { id: 3, inputs: [], outputs: [{ name: "cout", links: [11] }] };
  graph._register(A); graph._register(B); graph._register(C);
  graph._links.set(10, { id: 10, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 });
  graph._links.set(11, { id: 11, origin_id: 3, origin_slot: 0, target_id: 1, target_slot: 0 });

  severNodeLinks(graph, A);

  assert.equal(graph._links.has(10), false, "outgoing link record removed");
  assert.equal(graph._links.has(11), false, "incoming link record removed");
  assert.equal(A.outputs[0].links, null, "A's output links nulled");
  assert.equal(A.inputs[0].link, null, "A's input link nulled");
  assert.equal(B.inputs[0].link, null, "far-end B input ref cleared");
  assert.deepEqual(C.outputs[0].links, [], "far-end C output ref spliced out");
});

test("STORE SWEEP: severs a record whose slot ref was already nulled by a partial remove (codex P1)", () => {
  // Reproduce the partial-mutation failure mode: a mid-disconnect graph.remove nulled
  // A.outputs[0].links BEFORE throwing, but link record 10 (A→B) still lives in the
  // store. The slot pass can no longer reach it; the store sweep must still drop it
  // and clear B's mirror ref, else the retry orphans a dangling link.
  const graph = makeGraph();
  const A = { id: 1, inputs: [], outputs: [{ name: "out", links: null }] }; // slot ref lost
  const B = { id: 2, inputs: [{ name: "in", link: 10 }], outputs: [] };
  graph._register(A); graph._register(B);
  graph._links.set(10, { id: 10, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 });

  severNodeLinks(graph, A);

  assert.equal(graph._links.has(10), false, "orphaned record dropped via store sweep");
  assert.equal(B.inputs[0].link, null, "far-end B mirror ref cleared via store sweep");
});

test("STORE SWEEP: also severs an INCOMING record orphaned by a partial remove", () => {
  const graph = makeGraph();
  // C.out → A.in (id 11); A's input slot ref already nulled by the partial remove.
  const A = { id: 1, inputs: [{ name: "cin", link: null }], outputs: [] };
  const C = { id: 3, inputs: [], outputs: [{ name: "cout", links: [11] }] };
  graph._register(A); graph._register(C);
  graph._links.set(11, { id: 11, origin_id: 3, origin_slot: 0, target_id: 1, target_slot: 0 });

  severNodeLinks(graph, A);

  assert.equal(graph._links.has(11), false, "incoming orphaned record dropped");
  assert.deepEqual(C.outputs[0].links, [], "far-end C output ref spliced via store sweep");
});

test("STORE SWEEP: string-vs-number node id representations still match", () => {
  const graph = makeGraph();
  const A = { id: 1, inputs: [], outputs: [{ name: "out", links: null }] };
  const B = { id: 2, inputs: [{ name: "in", link: 10 }], outputs: [] };
  graph._register(A); graph._register(B);
  // Record stores origin_id as a string "1" (subgraph-style id) vs node.id number 1.
  graph._links.set(10, { id: 10, origin_id: "1", origin_slot: 0, target_id: 2, target_slot: 0 });
  severNodeLinks(graph, A);
  assert.equal(graph._links.has(10), false, "string/number id mismatch still swept");
  assert.equal(B.inputs[0].link, null, "far-end B mirror cleared");
});

test("RAIL SAFETY: a link to a subgraph boundary rail (-20 / graph.outputNode) is LEFT for litegraph, not dropped", () => {
  // Codex round-2 P1: dropping a rail-connected record here would strand the rail's
  // own slot linkIds (rails aren't in getNodeById). Rail links must be left untouched
  // for litegraph's rail-aware retry and the caller's boundary pruning.
  const graph = makeGraph();
  const A = { id: 1, inputs: [], outputs: [{ name: "out", links: [10] }] };
  graph._register(A);
  // target_id -20 is the reserved SUBGRAPH_OUTPUT_RAIL_ID.
  graph._links.set(10, { id: 10, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0 });
  assert.doesNotThrow(() => severNodeLinks(graph, A));
  assert.equal(graph._links.has(10), true, "rail record is LEFT, not dropped");
  assert.deepEqual(A.outputs[0].links, [10], "rail slot id kept for litegraph's rail-aware retry");
});

test("RAIL SAFETY: recognizes a rail by graph.inputNode.id too (not only the reserved id)", () => {
  const graph = makeGraph();
  graph.inputNode = { id: 42 }; // this graph's live input rail node
  const A = { id: 1, inputs: [{ name: "in", link: 11 }], outputs: [] };
  graph._register(A);
  graph._links.set(11, { id: 11, origin_id: 42, origin_slot: 0, target_id: 1, target_slot: 0 });
  severNodeLinks(graph, A);
  assert.equal(graph._links.has(11), true, "link from the live input rail is left");
  assert.equal(A.inputs[0].link, 11, "this node's rail input ref is kept");
});

test("MISSING (non-rail) far end: the orphan record is DROPPED, not left (#420 codex round-3 P1b)", () => {
  // A missing (already-removed) far-end node is NOT a rail; leaving its record would
  // orphan a link pointing at the removed node (classic disconnectInput early-returns
  // without deleting it). Drop it — no orphan, matches modern litegraph self-heal.
  const graph = makeGraph();
  const A = { id: 1, inputs: [{ name: "cin", link: 11 }], outputs: [{ name: "out", links: [10] }] };
  graph._register(A);
  graph._links.set(10, { id: 10, origin_id: 1, origin_slot: 0, target_id: 77, target_slot: 0 });
  graph._links.set(11, { id: 11, origin_id: 88, origin_slot: 0, target_id: 1, target_slot: 0 });
  severNodeLinks(graph, A);
  assert.equal(graph._links.has(10), false, "outgoing orphan (missing target) dropped");
  assert.equal(graph._links.has(11), false, "incoming orphan (missing origin) dropped — no P1b orphan");
  assert.equal(A.outputs[0].links, null);
  assert.equal(A.inputs[0].link, null);
});

test("MIXED: severs the broken far-end link but leaves the rail link on the same node", () => {
  const graph = makeGraph();
  // A.out slot 0 → B.in (id 10, B is a broken far end → sever). A.out slot 1 → rail
  // (id 11, target -20 → leave).
  const A = {
    id: 1,
    inputs: [],
    outputs: [
      { name: "o0", links: [10] },
      { name: "o1", links: [11] },
    ],
  };
  const B = { id: 2, inputs: [{ name: "in", link: 10 }], outputs: [] };
  graph._register(A); graph._register(B);
  graph._links.set(10, { id: 10, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 });
  graph._links.set(11, { id: 11, origin_id: 1, origin_slot: 1, target_id: -20, target_slot: 0 });

  severNodeLinks(graph, A);

  assert.equal(graph._links.has(10), false, "resolvable broken link severed");
  assert.equal(graph._links.has(11), true, "rail link left for litegraph");
  assert.equal(A.outputs[0].links, null, "severed slot nulled");
  assert.deepEqual(A.outputs[1].links, [11], "rail slot kept");
  assert.equal(B.inputs[0].link, null, "broken far-end mirror cleared");
});

test("a node with no links removes cleanly", () => {
  const graph = makeGraph();
  const solo = { id: 5, inputs: [], outputs: [] };
  graph._register(solo);
  const res = safeRemoveNode(graph, solo);
  assert.deepEqual(res, { removed: true, recovered: false });
  assert.equal(graph.getNodeById(5), null);
});

test("recovery is HOOK-FREE: it never re-runs litegraph's disconnect, so a far-end onConnectionsChange is NOT re-invoked (codex R6 P1)", () => {
  // The recovery path must sever links at the record level only — never call the
  // node's disconnectOutput/disconnectInput — so a far-end disconnect hook that threw
  // the crash is not invoked a second time.
  const graph = makeGraph();
  let disconnectCalls = 0;
  let farHookCalls = 0;
  const B = {
    id: 2,
    inputs: [{ name: "in", link: 10 }],
    outputs: [],
    // The far-end node's disconnect hook (would fire if litegraph re-disconnected).
    onConnectionsChange() { farHookCalls++; },
    // Note: no findInputSlot → the mock's remove throws the #420 crash for this link.
  };
  const node = {
    id: 1,
    inputs: [],
    outputs: [{ name: "out", links: [10] }],
    disconnectOutput() { disconnectCalls++; },
    disconnectInput() { disconnectCalls++; },
  };
  graph._register(node); graph._register(B);
  graph._links.set(10, { id: 10, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 });
  const res = safeRemoveNode(graph, node);
  assert.deepEqual(res, { removed: true, recovered: true });
  assert.equal(disconnectCalls, 0, "node.disconnect* was NOT called on recovery (hook-free)");
  assert.equal(farHookCalls, 0, "far-end onConnectionsChange was NOT re-invoked");
  assert.equal(graph.getNodeById(1), null, "node removed on retry");
  assert.equal(graph._links.has(10), false, "link record severed at the record level");
  assert.equal(B.inputs[0].link, null, "far-end mirror cleared by a plain write");
});

test("a genuine persistent failure propagates (retry also throws)", () => {
  const graph = makeGraph();
  // Residual link so the disconnect-phase crash is recognized and recovery proceeds.
  const node = { id: 7, inputs: [{ name: "in", link: 10 }], outputs: [] };
  const B = { id: 2, inputs: [], outputs: [{ name: "o", links: [10] }] };
  graph._register(node); graph._register(B);
  graph._links.set(10, { id: 10, origin_id: 2, origin_slot: 0, target_id: 7, target_slot: 0 });
  // The recognized crash on first call, then a DIFFERENT hard failure on retry.
  let first = true;
  graph.remove = () => {
    if (first) { first = false; throw new TypeError("t.findInputSlot is not a function"); }
    throw new Error("boom");
  };
  assert.throws(() => safeRemoveNode(graph, node), /boom/);
});

test("NARROW CATCH: an unrelated first-attempt error is NOT retried and propagates (codex P1a)", () => {
  // A node onRemoved() throwing (or any non-link-disconnect error) must propagate on
  // the FIRST attempt — never retried (which could duplicate side effects) or masked.
  const graph = makeGraph();
  const node = { id: 8, inputs: [], outputs: [] };
  graph._register(node);
  let calls = 0;
  graph.remove = () => { calls++; throw new Error("onRemoved blew up"); };
  assert.throws(() => safeRemoveNode(graph, node), /onRemoved blew up/);
  assert.equal(calls, 1, "unrelated error is not retried");
});

test("NARROW CATCH: an onRemoved hook throwing the IDENTICAL crash message is NOT retried (no residual links, codex R4/R5 P1a)", () => {
  // litegraph fully disconnects every link BEFORE firing onRemoved (both modern AND
  // classic — classic fires onRemoved before splicing the node out, so node-presence
  // can't discriminate). A hook thrown after full disconnection leaves NO links, so
  // even with an identical-looking TypeError we must NOT sever+retry (that would
  // re-run the hook / duplicate side effects) — we must propagate. The node here has
  // no links (fully disconnected), modeling the post-disconnect state.
  const graph = makeGraph();
  const node = { id: 9, inputs: [{ name: "in", link: null }], outputs: [{ name: "o", links: null }] };
  graph._register(node);
  let calls = 0;
  graph.remove = () => {
    calls++;
    // Node still in the graph (classic ordering: onRemoved before splice), but its
    // links are already gone — the crash is from onRemoved, not disconnect.
    throw new TypeError("t.findInputSlot is not a function");
  };
  assert.throws(() => safeRemoveNode(graph, node), /findInputSlot/);
  assert.equal(calls, 1, "a post-disconnect hook error is not retried");
});

test("RECOVERY fires for the disconnect-phase crash (RESIDUAL links present)", () => {
  // The crash happens during disconnect: the node still has links attached → recover.
  const graph = makeGraph();
  const A = { id: 1, inputs: [], outputs: [{ name: "out", links: [10] }] };
  const B = { id: 2, inputs: [{ name: "in", link: 10 }], outputs: [] }; // no findInputSlot
  graph._register(A); graph._register(B);
  graph._links.set(10, { id: 10, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 });
  const res = safeRemoveNode(graph, A);
  assert.deepEqual(res, { removed: true, recovered: true });
  assert.equal(graph.getNodeById(1), null);
});

test("NARROW CATCH: residual links tracked via the STORE even if slot refs were nulled", () => {
  // If a partial disconnect nulled the slot refs but a record still references the
  // node, that's still a disconnect-phase crash → recover.
  const graph = makeGraph();
  const A = { id: 1, inputs: [{ name: "in", link: null }], outputs: [{ name: "o", links: null }] };
  const B = { id: 2, inputs: [{ name: "in", link: 10 }], outputs: [] };
  graph._register(A); graph._register(B);
  graph._links.set(10, { id: 10, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 });
  let calls = 0;
  const realRemove = graph.remove.bind(graph);
  graph.remove = (n) => {
    calls++;
    if (calls === 1) throw new TypeError("t.findInputSlot is not a function");
    return realRemove(n);
  };
  const res = safeRemoveNode(graph, A);
  assert.deepEqual(res, { removed: true, recovered: true });
  assert.equal(graph._links.has(10), false, "residual store record swept");
});

test("RAIL SAFETY: recognizes a rail via the private _inputNode variant (codex R4 P2)", () => {
  const graph = makeGraph();
  graph._inputNode = { id: 55 }; // private variant property
  const A = { id: 1, inputs: [{ name: "in", link: 11 }], outputs: [] };
  graph._register(A);
  graph._links.set(11, { id: 11, origin_id: 55, origin_slot: 0, target_id: 1, target_slot: 0 });
  severNodeLinks(graph, A);
  assert.equal(graph._links.has(11), true, "link from the private-variant rail is left");
  assert.equal(A.inputs[0].link, 11, "rail input ref kept");
});

test("isLinkDisconnectCrash matches only the far-end slot-lookup crash, rejects unrelated errors", () => {
  assert.equal(isLinkDisconnectCrash(new TypeError("t.findInputSlot is not a function")), true);
  assert.equal(isLinkDisconnectCrash(new TypeError("e.findOutputSlot is not a function")), true);
  // Narrowed: other connection methods are NOT accepted (a custom hook throwing them
  // must not be treated as the litegraph link-traversal crash).
  assert.equal(isLinkDisconnectCrash(new TypeError("n.disconnectInput is not a function")), false);
  assert.equal(isLinkDisconnectCrash(new TypeError("x.onConnectionsChange is not a function")), false);
  // Unrelated shapes must NOT match.
  assert.equal(isLinkDisconnectCrash(new Error("t.findInputSlot is not a function")), false, "not a TypeError");
  assert.equal(isLinkDisconnectCrash(new TypeError("Cannot read properties of null")), false);
  assert.equal(isLinkDisconnectCrash(new TypeError("foo is not a function")), false, "no slot lookup");
  assert.equal(isLinkDisconnectCrash(undefined), false);
});

test("prefers LLink.disconnect() so modern reroute/layout cleanup happens (codex R7 P1)", () => {
  // A modern link record exposes .disconnect(network), which deletes the record AND
  // clears reroute linkIds + layout state. severNodeLinks must call it (not a raw
  // store delete) so a rerouted link doesn't leave dangling reroute state.
  const graph = makeGraph();
  const reroute = { id: 500, linkIds: new Set([10]) };
  const A = { id: 1, inputs: [], outputs: [{ name: "out", links: [10] }] };
  const B = { id: 2, inputs: [{ name: "in", link: 10 }], outputs: [] };
  graph._register(A); graph._register(B);
  let disconnectArg;
  const link = {
    id: 10, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0,
    disconnect(network) {
      disconnectArg = network;
      network._links.delete(this.id); // modern: remove the record
      reroute.linkIds.delete(this.id); // modern: clean the reroute
    },
  };
  graph._links.set(10, link);

  severNodeLinks(graph, A);

  assert.equal(disconnectArg, graph, "LLink.disconnect was called with the graph as network");
  assert.equal(graph._links.has(10), false, "record removed via LLink.disconnect");
  assert.equal(reroute.linkIds.has(10), false, "reroute linkId cleaned (no dangling reroute state)");
  assert.equal(B.inputs[0].link, null, "far-end mirror still cleared");
});

test("falls back to raw store deletion when the record has no .disconnect() (legacy)", () => {
  const graph = makeGraph();
  const A = { id: 1, inputs: [], outputs: [{ name: "out", links: [10] }] };
  const B = { id: 2, inputs: [{ name: "in", link: 10 }], outputs: [] };
  graph._register(A); graph._register(B);
  graph._links.set(10, { id: 10, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 });
  severNodeLinks(graph, A);
  assert.equal(graph._links.has(10), false, "legacy record removed via raw delete");
});

test("works against the back-compat `links` record store (no _links Map)", () => {
  // Some builds expose only the legacy record. severNodeLinks must still delete.
  const records = { 10: { id: 10, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 } };
  const nodesById = new Map();
  const A = { id: 1, inputs: [], outputs: [{ name: "out", links: [10] }] };
  const B = { id: 2, inputs: [{ name: "in", link: 10 }], outputs: [] };
  nodesById.set(1, A); nodesById.set(2, B);
  const graph = { links: records, getNodeById: (id) => nodesById.get(id) ?? null };
  severNodeLinks(graph, A);
  assert.equal(records[10], undefined, "legacy record deleted");
  assert.equal(A.outputs[0].links, null);
  assert.equal(B.inputs[0].link, null);
});
