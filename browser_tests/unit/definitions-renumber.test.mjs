// #886 — a faithful open of any workflow containing subgraphs reported
// CONTENT_UNVERIFIED.
//
// MEASURED on a live rig (Anima Wojak Batch.json, 4 subgraph definitions, panel
// 0.14.14 / frontend 1.48.7), raw disk JSON vs serialized-after-load:
//
//   node count / ids / types inside each subgraph : IDENTICAL
//   only differing node field                    : inputs (link refs; name/type equal)
//   links                                        : differ
//   state.lastLinkId                             : 2092 -> 2106
//
// The frontend regenerates link identity inside subgraph definitions on load. The
// content proof refused any surface but `nodes`, so it refused that too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { definitionsDifferOnlyByRenumber } from "../../web/js/lib/definitions-renumber.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** A subgraph definition shaped like the real ones. */
const sg = (over = {}) => ({
  id: "a876d5e5",
  version: 1,
  state: { lastGroupId: 66, lastNodeId: 1281, lastLinkId: 2092, lastRerouteId: 13 },
  revision: 0,
  config: {},
  name: "New Subgraph",
  nodes: [
    { id: 65, type: "PreviewImage", pos: [0, 0], widgets_values: [], inputs: [{ localized_name: "image", name: "image", type: "IMAGE", link: 11 }] },
    { id: 623, type: "UpscaleModelLoader", pos: [9, 9], widgets_values: ["x.pth"], inputs: [{ localized_name: "model_name", name: "model_name", type: "COMBO", link: 12 }] },
  ],
  links: [[11, 65, 0, 623, 0, "IMAGE"]],
  ...over,
});
const defs = (over = {}) => ({ subgraphs: [sg(over)] });

/** The measured transformation: link ids regenerated, counter advanced. */
const renumbered = () =>
  defs({
    state: { lastGroupId: 66, lastNodeId: 1281, lastLinkId: 2106, lastRerouteId: 13 },
    nodes: [
      { id: 65, type: "PreviewImage", pos: [0, 0], widgets_values: [], inputs: [{ localized_name: "image", name: "image", type: "IMAGE", link: 99 }] },
      { id: 623, type: "UpscaleModelLoader", pos: [9, 9], widgets_values: ["x.pth"], inputs: [{ localized_name: "model_name", name: "model_name", type: "COMBO", link: 98 }] },
    ],
    links: [[99, 65, 0, 623, 0, "IMAGE"]],
  });

test("#886 the MEASURED renumbering is recognised", () => {
  assert.equal(definitionsDifferOnlyByRenumber(defs(), renumbered()), true);
});

test("#886 identical definitions are fine too", () => {
  assert.equal(definitionsDifferOnlyByRenumber(defs(), defs()), true);
});

test("#886 a node ADDED or REMOVED still fails", () => {
  // The part that makes tolerating this safe at all: the node set must match.
  const extra = defs();
  extra.subgraphs[0].nodes = [...extra.subgraphs[0].nodes, { id: 700, type: "PreviewImage", inputs: [] }];
  assert.equal(definitionsDifferOnlyByRenumber(defs(), extra), false);
  assert.equal(definitionsDifferOnlyByRenumber(extra, defs()), false);
});

test("#886 a node RETYPED still fails", () => {
  const retyped = defs();
  retyped.subgraphs[0].nodes[0].type = "SaveImage";
  assert.equal(definitionsDifferOnlyByRenumber(defs(), retyped), false);
});

test("#886 a changed WIDGET VALUE still fails", () => {
  // The one that matters most: a silently different model name inside a subgraph is
  // exactly the wrong-graph open this guard exists to catch (#968).
  const edited = renumbered();
  edited.subgraphs[0].nodes[1].widgets_values = ["DIFFERENT.pth"];
  assert.equal(definitionsDifferOnlyByRenumber(defs(), edited), false);
});

test("#886 a moved node still fails — renumbering does not touch geometry", () => {
  const moved = renumbered();
  moved.subgraphs[0].nodes[0].pos = [500, 500];
  assert.equal(definitionsDifferOnlyByRenumber(defs(), moved), false);
});

test("#886 a changed slot NAME or TYPE still fails", () => {
  // Only the link reference may move within a slot; its identity may not.
  for (const patch of [{ name: "other" }, { type: "LATENT" }, { localized_name: "x" }]) {
    const bad = renumbered();
    Object.assign(bad.subgraphs[0].nodes[0].inputs[0], patch);
    assert.equal(definitionsDifferOnlyByRenumber(defs(), bad), false, JSON.stringify(patch));
  }
});

test("#886 a structural state counter moving still fails", () => {
  // lastLinkId/lastRerouteId are renumbering; lastNodeId/lastGroupId say how many
  // nodes or groups have existed, which renumbering cannot change.
  const bad = renumbered();
  bad.subgraphs[0].state.lastNodeId = 9999;
  assert.equal(definitionsDifferOnlyByRenumber(defs(), bad), false);
});

test("#886 a different subgraph SET fails, and so does an unknown key", () => {
  const two = defs();
  two.subgraphs = [sg(), sg({ id: "second" })];
  assert.equal(definitionsDifferOnlyByRenumber(defs(), two), false);
  // A future top-level key must not be waved through by a rule written before it.
  const future = defs();
  future.somethingNew = { a: 1 };
  assert.equal(definitionsDifferOnlyByRenumber(defs(), future), false);
});

test("#886 unreadable shapes are NOT proven", () => {
  // False must read as "cannot account for it", never as "changed".
  for (const [a, b] of [[undefined, undefined], [null, defs()], [defs(), null], ["x", defs()], [defs(), { subgraphs: "no" }]]) {
    assert.equal(definitionsDifferOnlyByRenumber(a, b), false, JSON.stringify([a, b]));
  }
});

test("#886 WIRING: the content proof consults it for a definitions surface", () => {
  // The predicate is inert unless the proof calls it, and the behavioural tests
  // above cannot see the call site.
  const src = readFileSync(join(ROOT, "web/js/lib/graph-binding.js"), "utf8");
  assert.match(src, /import \{ definitionsDifferOnlyByRenumber \} from "\.\/definitions-renumber\.js";/);
  // comfyui-mcp#1706 — BOTH call sites must pass the payload's ROOT nodes. The node-id
  // account is granted only to a caller that supplies them (a call without the argument
  // answers the pre-#1706 question and refuses), so a call site that dropped it would
  // silently un-ship the fix while every behavioural test above stayed green.
  const calls = [
    ...src.matchAll(
      /definitionsDifferOnlyByRenumber\(\s*state\?\.definitions,\s*actualState\?\.definitions,\s*\{\s*\r?\n?\s*rootNodes: state\?\.nodes,\s*\r?\n?\s*\}/g,
    ),
  ];
  assert.equal(calls.length, 2, "both call sites hand over the payload's root nodes");
  // ...and there is no THIRD call site that does not. Counting occurrences cannot see a
  // code path that was added later, so the total is pinned against the wired count.
  const allCalls = [...src.matchAll(/definitionsDifferOnlyByRenumber\(/g)];
  assert.equal(allCalls.length, 2, "every call site is one of the two pinned above");
  // The surface set must be a SUBSET of { nodes, definitions }; anything else refuses.
  // #1623 renamed the refusal value: every refusal AFTER the diff is computed now
  // carries the separate presentation-only answer out with it instead of discarding
  // it. What is pinned is unchanged — this surface set still refuses.
  assert.match(src, /s !== "nodes" && s !== "definitions"\)\) return notProven;/);
  // ...and `notProven` must be a REFUSAL of the content proof, not a second success
  // door: a rename that made it `proven: true` would pass the line above.
  assert.match(src, /const notProven = \{\r?\n\s*proven: false,/);
  // `nodes` must NOT be mandatory. Requiring it refused the reported case outright:
  // #886 is a graph where `definitions` is the ONLY differing surface, so the earlier
  // gate wired this fix into a branch its own bug report could never reach (review).
  assert.doesNotMatch(src, /if \(!surfaces\.includes\("nodes"\)\) return (?:NOT_PROVEN|notProven);/);
  assert.match(src, /if \(!unique\.includes\("nodes"\)\)/);
});

// ── The P0 direction: a genuinely different graph must NEVER read as renumbering ──
//
// Review found the first version waiving `links`, `inputs` and `outputs` wholesale, so
// a re-wire or a renamed subgraph port passed as "only renumbering". Accepting a wrong
// graph as bound is silent and destroys work; a false refusal is visible and
// recoverable. These pin the asymmetry.

const sgP0 = (over = {}) => ({
  subgraphs: [
    {
      id: "sub-1",
      name: "Detailer",
      inputs: [{ name: "image", type: "IMAGE" }],
      outputs: [{ name: "out", type: "IMAGE" }],
      state: { lastLinkId: 2092, lastNodeId: 12 },
      links: [
        [11, 3, 0, 4, 0, "IMAGE"],
        [12, 4, 0, 5, 1, "MASK"],
      ],
      nodes: [
        { id: 3, type: "LoadImage", outputs: [{ links: [11] }] },
        { id: 4, type: "VAEEncode", inputs: [{ link: 11 }], outputs: [{ links: [12] }] },
        { id: 5, type: "KSampler", inputs: [{ link: null }, { link: 12 }] },
      ],
      ...over,
    },
  ],
});

/** The same graph after a load: every link id advanced, topology untouched. */
const renumberedP0 = () =>
  sgP0({
    state: { lastLinkId: 2106, lastNodeId: 12 },
    links: [
      [211, 3, 0, 4, 0, "IMAGE"],
      [212, 4, 0, 5, 1, "MASK"],
    ],
    nodes: [
      { id: 3, type: "LoadImage", outputs: [{ links: [211] }] },
      { id: 4, type: "VAEEncode", inputs: [{ link: 211 }], outputs: [{ links: [212] }] },
      { id: 5, type: "KSampler", inputs: [{ link: null }, { link: 212 }] },
    ],
  });

test("#886 the MEASURED case still passes: pure link renumbering", () => {
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), renumberedP0()), true);
});

test("#886 P0: a RE-WIRED link is not renumbering", () => {
  // Same link count, same ids, different target slot. The waived-links version accepted
  // this; it is a different graph.
  const rewired = sgP0({
    links: [
      [11, 3, 0, 4, 0, "IMAGE"],
      [12, 4, 0, 5, 0, "MASK"],
    ],
  });
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), rewired), false);
});

test("#886 P0: a link pointing at a DIFFERENT node is not renumbering", () => {
  const moved = sgP0({
    links: [
      [11, 3, 0, 4, 0, "IMAGE"],
      [12, 4, 0, 3, 1, "MASK"],
    ],
  });
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), moved), false);
});

test("#886 P0: an ADDED or REMOVED link is not renumbering", () => {
  const added = sgP0({ links: [...sgP0().subgraphs[0].links, [13, 3, 0, 5, 0, "IMAGE"]] });
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), added), false);
  const removed = sgP0({ links: [sgP0().subgraphs[0].links[0]] });
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), removed), false);
});

test("#886 P0: a RENAMED or RETYPED interface port is not renumbering", () => {
  // inputs/outputs are the subgraph contract with the outside graph.
  assert.equal(
    definitionsDifferOnlyByRenumber(sgP0(), sgP0({ inputs: [{ name: "picture", type: "IMAGE" }] })),
    false,
  );
  assert.equal(
    definitionsDifferOnlyByRenumber(sgP0(), sgP0({ outputs: [{ name: "out", type: "MASK" }] })),
    false,
  );
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), sgP0({ inputs: [] })), false);
});

test("#886 P0: a changed node TYPE or widget value is not renumbering", () => {
  const retyped = sgP0({
    nodes: [
      { id: 3, type: "LoadImageMask", outputs: [{ links: [11] }] },
      ...sgP0().subgraphs[0].nodes.slice(1),
    ],
  });
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), retyped), false);
  const rewidgeted = sgP0({
    nodes: [
      { id: 3, type: "LoadImage", outputs: [{ links: [11] }], widgets_values: ["b.png"] },
      ...sgP0().subgraphs[0].nodes.slice(1),
    ],
  });
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), rewidgeted), false);
});

test("#886 P0: a slot that GAINED a connection is not renumbering", () => {
  const gained = sgP0({
    nodes: [
      { id: 3, type: "LoadImage", outputs: [{ links: [11, 99] }] },
      ...sgP0().subgraphs[0].nodes.slice(1),
    ],
  });
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), gained), false);
});

test("#886 P1: duplicate node identities refuse rather than overwrite", () => {
  // A Map that lets a later entry overwrite an earlier one can hide a change in the
  // overwritten node. Not addressable => cannot tell => refuse.
  const dup = sgP0({
    nodes: [
      { id: 3, type: "LoadImage", outputs: [{ links: [11] }] },
      { id: 3, type: "LoadImage", outputs: [{ links: [11] }] },
    ],
  });
  // Two DISTINCT instances: passing the same object twice short-circuits as identical,
  // which would test nothing.
  const dup2 = sgP0({
    nodes: [
      { id: 3, type: "LoadImage", outputs: [{ links: [11] }] },
      { id: 3, type: "LoadImage", outputs: [{ links: [11] }] },
    ],
  });
  assert.equal(definitionsDifferOnlyByRenumber(dup, dup2), false);
});

test("#886 P1: a node missing an id or type refuses", () => {
  const noId = sgP0({ nodes: [{ type: "LoadImage" }] });
  const noType = sgP0({ nodes: [{ id: 3 }] });
  assert.equal(definitionsDifferOnlyByRenumber(noId, sgP0({ nodes: [{ type: "LoadImage" }] })), false);
  assert.equal(definitionsDifferOnlyByRenumber(noType, sgP0({ nodes: [{ id: 3 }] })), false);
});

test("#886 P2: a cyclic structure fails closed instead of throwing", () => {
  // JSON.stringify threw here, turning a "not proven" answer into an exception on the
  // guard path.
  const a = sgP0();
  const b = renumberedP0();
  b.subgraphs[0].extra = {};
  b.subgraphs[0].extra.self = b.subgraphs[0].extra;
  assert.doesNotThrow(() => definitionsDifferOnlyByRenumber(a, b));
  assert.equal(definitionsDifferOnlyByRenumber(a, b), false);
});

test("#886 a differing subgraph COUNT refuses", () => {
  const two = sgP0();
  two.subgraphs.push(sgP0().subgraphs[0]);
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), two), false);
});

// ── Round 2 of review: four more ways a different graph could have passed ──

test("#886 P0: REORDERED nodes are not renumbering", () => {
  // LiteGraph node order can carry execution and draw ordering, so a reordered array
  // is not the same subgraph. Indexing by identity alone accepted it.
  const base = sgP0();
  const reordered = sgP0({ nodes: [...sgP0().subgraphs[0].nodes].reverse() });
  assert.equal(definitionsDifferOnlyByRenumber(base, reordered), false);
});

test("#886 P0: endpoint signatures cannot collide across delimiters", () => {
  // ("a:0>b", "c") and ("a", "0>b:c") both rendered as `a:0>b:c` in the delimiter
  // form, so two distinct wirings compared equal.
  const mk = (o, os) =>
    sgP0({
      links: [[11, o, os, 4, 0, "IMAGE"]],
      nodes: [
        { id: 3, type: "LoadImage", outputs: [{ links: [11] }] },
        { id: 4, type: "VAEEncode", inputs: [{ link: 11 }] },
      ],
    });
  assert.equal(definitionsDifferOnlyByRenumber(mk("a:0>b", "c"), mk("a", "0>b:c")), false);
});

test("#886 P0: a changed link TYPE is not renumbering", () => {
  const other = sgP0({
    links: [
      [11, 3, 0, 4, 0, "LATENT"],
      [12, 4, 0, 5, 1, "MASK"],
    ],
  });
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), other), false);
});

test("#886 P1: a hostile endpoint value fails closed instead of throwing", () => {
  // String() throws on { toString: null, valueOf: null }; an exception here would
  // escape the guard rather than answering "not proven".
  // Must be something JSON.stringify itself rejects. A plain object with null
  // toString/valueOf does NOT throw — stringify never calls them — so that fixture
  // left the guard untested and a mutation removing it survived. A throwing toJSON
  // (or a BigInt, or a cycle) is what actually reaches the catch.
  const hostile = { toJSON() { throw new Error("corrupt link id"); } };
  // Same link COUNT as the baseline, or the length check short-circuits before
  // linkEndpoints is ever called — which is why a mutation removing the try/catch
  // survived twice: the guarded line was unreachable from the fixture.
  const bad = sgP0({
    links: [
      [11, hostile, 0, 4, 0, "IMAGE"],
      [12, 4, 0, 5, 1, "MASK"],
    ],
  });
  assert.doesNotThrow(() => definitionsDifferOnlyByRenumber(sgP0(), bad));
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), bad), false);
});

test("#886 P1: a legitimately DEEP acyclic definition still compares", () => {
  // A 64-level bound made a valid large workflow refuse. Build ~80 levels of nested
  // widget data on both sides and confirm pure renumbering is still proven.
  const deep = (n) => {
    let v = { leaf: 1 };
    for (let i = 0; i < n; i += 1) v = { nest: v };
    return v;
  };
  const withDeep = (over) => {
    const g = over ? renumberedP0() : sgP0();
    g.subgraphs[0].nodes[0].widgets_values = [deep(80)];
    return g;
  };
  assert.equal(definitionsDifferOnlyByRenumber(withDeep(false), withDeep(true)), true);
});

// ── Round 3: nothing may escape this predicate, from anywhere ──
//
// Review found throws escaping past the inner wrappers: Object.keys on a Proxy whose
// ownKeys trap throws, a throwing property getter, a link Proxy read before the JSON
// encode. An exception on this path takes out the guard that decides whether graph
// writes land, instead of answering "not proven".

test("#886 a throwing property GETTER fails closed", () => {
  const g = sgP0();
  Object.defineProperty(g.subgraphs[0], "name", {
    get() {
      throw new Error("hostile getter");
    },
    enumerable: true,
    configurable: true,
  });
  assert.doesNotThrow(() => definitionsDifferOnlyByRenumber(g, sgP0()));
  assert.equal(definitionsDifferOnlyByRenumber(g, sgP0()), false);
});

test("#886 a Proxy whose ownKeys trap throws fails closed", () => {
  const hostile = new Proxy(
    { subgraphs: [] },
    {
      ownKeys() {
        throw new Error("hostile ownKeys");
      },
    },
  );
  assert.doesNotThrow(() => definitionsDifferOnlyByRenumber(hostile, sgP0()));
  assert.equal(definitionsDifferOnlyByRenumber(hostile, sgP0()), false);
  assert.doesNotThrow(() => definitionsDifferOnlyByRenumber(sgP0(), hostile));
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), hostile), false);
});

test("#886 a throwing getter on a LINK endpoint fails closed", () => {
  const link = [11, 3, 0, 4, 0, "IMAGE"];
  Object.defineProperty(link, "1", {
    get() {
      throw new Error("hostile link id");
    },
    enumerable: true,
    configurable: true,
  });
  const bad = sgP0({ links: [link, [12, 4, 0, 5, 1, "MASK"]] });
  assert.doesNotThrow(() => definitionsDifferOnlyByRenumber(sgP0(), bad));
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), bad), false);
});

test("#886 failing closed never reports a WRONG graph as proven", () => {
  // The property that matters: every hostile shape above must answer false, which the
  // caller reads as "not proven" and refuses. None of them may answer true.
  const g = sgP0();
  Object.defineProperty(g.subgraphs[0], "state", {
    get() {
      throw new Error("boom");
    },
    enumerable: true,
    configurable: true,
  });
  assert.equal(definitionsDifferOnlyByRenumber(g, renumberedP0()), false);
});

// ── comfyui-mcp#1706 — the SECOND rewrite on this surface: subgraph NODE ids ──
//
// MEASURED in a real browser (ComfyUI 0.33.1 / comfyui-frontend-package 1.48.7, the
// live rig on :8211), payload vs `app.graph.serialize()`:
//
//   1. A workflow the frontend itself serialized reopens BYTE-IDENTICALLY — 0 differing
//      paths in `definitions`, 0 in `nodes`. There is no baseline drift to explain.
//   2. Take that same workflow, force its definition node ids to collide with its own
//      root node ids (what a paste- or agent-authored definitions store looks like),
//      reopen it. Root `nodes`: still 0 differing paths. `definitions`: differs, and the
//      WHOLE of the difference is
//
//        /subgraphs/#/nodes/#/id                     the relabeling
//        /subgraphs/#/links/#/origin_id,/target_id   patched through the same map
//        /subgraphs/#/nodes/#/order                  recomputed execution index
//        /subgraphs/#/state/lastNodeId  196 -> 214   the counter that allocated them
//
//      and nothing else (the "everything else" bucket came back EMPTY on both rigs).
//
// That is comfyui-mcp#1706's reported shape exactly: identity confirmed, every node
// matching, `definitions` the only differing surface. The fixture below is that capture.
const CAPTURED = JSON.parse(
  readFileSync(join(ROOT, "browser_tests/unit/fixtures-1706-definitions-renumber.json"), "utf8"),
);
const captured = () => JSON.parse(JSON.stringify(CAPTURED));

test("#1706 the MEASURED node-id renumber is recognised", () => {
  const c = captured();
  assert.equal(
    definitionsDifferOnlyByRenumber(c.payloadDefinitions, c.liveDefinitions, { rootNodes: c.payloadRootNodes }),
    true,
  );
});

test("#1706 the account is granted only to a caller that hands over the ROOT nodes", () => {
  // The evidence gate. A caller that does not supply them gets byte-for-byte the
  // pre-#1706 answer, so dropping the argument at a call site un-ships the fix rather
  // than silently widening it.
  const c = captured();
  for (const options of [undefined, {}, { rootNodes: null }, { rootNodes: "nodes" }]) {
    assert.equal(
      definitionsDifferOnlyByRenumber(c.payloadDefinitions, c.liveDefinitions, options),
      false,
      `${JSON.stringify(options)} is not the evidence`,
    );
  }
});

test("#1706 pure LINK renumbering is unaffected by the gate — #886 never needed the nodes", () => {
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), renumberedP0()), true);
  assert.equal(definitionsDifferOnlyByRenumber(defs(), renumbered()), true);
});

// ── the cross-surface reference: a promoted widget names a definition node BY ID ──

const promoting = (id) => [{ id: 400, type: "sub-1", properties: { proxyWidgets: [[String(id), "seed"]] } }];

test("#1706 a root node promoting a widget from a RELABELED node refuses", () => {
  // MEASURED (`templates-6-key-frames.json`, 5 root nodes promoting widgets, definition
  // ids forced to collide): that variant is NOT confined to `definitions` — the root
  // `nodes` surface came back differing on `inputs/#/widget` and `widgets_values/#`,
  // i.e. promoted widget VALUES were gone. Accounting for `definitions` here would take
  // it out of the UNEXPLAINED set the weaker completed-load ground reads, and that
  // ground does admit a `widgets_values` difference. So it refuses outright.
  const c = captured();
  const movedFrom = c.payloadDefinitions.subgraphs[0].nodes[0].id;
  assert.equal(
    definitionsDifferOnlyByRenumber(c.payloadDefinitions, c.liveDefinitions, { rootNodes: promoting(movedFrom) }),
    false,
  );
});

test("#1706 a root node promoting from an UNTOUCHED id does not block the account", () => {
  const c = captured();
  assert.equal(
    definitionsDifferOnlyByRenumber(c.payloadDefinitions, c.liveDefinitions, {
      rootNodes: promoting("no-such-node-id"),
    }),
    true,
  );
});

test("#1706 an unreadable proxyWidgets shape refuses — cannot tell is not no", () => {
  const c = captured();
  for (const rootNodes of [
    [{ id: 400, type: "sub-1", properties: { proxyWidgets: "seed" } }],
    [{ id: 400, type: "sub-1", properties: { proxyWidgets: [null] } }],
    [{ id: 400, type: "sub-1", properties: { proxyWidgets: [[]] } }],
    [{ id: 400, type: "sub-1", properties: { proxyWidgets: [[{ toString: null, valueOf: null }, "seed"]] } }],
  ]) {
    assert.equal(definitionsDifferOnlyByRenumber(c.payloadDefinitions, c.liveDefinitions, { rootNodes }), false);
  }
});

// ── what STILL produces a genuine mismatch, on top of the relabeling ──

/** The captured live definitions with one surgical change. */
const mutatedLive = (fn) => {
  const c = captured();
  fn(c.liveDefinitions.subgraphs[0], c);
  return c;
};
const verdict = (c) =>
  definitionsDifferOnlyByRenumber(c.payloadDefinitions, c.liveDefinitions, { rootNodes: c.payloadRootNodes });

test("#1706 P0: a definition node that VANISHED is not a relabeling", () => {
  assert.equal(verdict(mutatedLive((def) => def.nodes.pop())), false);
});

test("#1706 P0: a RETYPED definition node is not a relabeling", () => {
  assert.equal(
    verdict(
      mutatedLive((def) => {
        def.nodes[0].type = "SomethingElse";
      }),
    ),
    false,
  );
});

test("#1706 P0: a changed WIDGET VALUE inside a relabeled definition is not a relabeling", () => {
  assert.equal(
    verdict(
      mutatedLive((def) => {
        def.nodes[0].widgets_values = ["CHANGED", ...(def.nodes[0].widgets_values ?? [])];
      }),
    ),
    false,
  );
});

test("#1706 P0: a RE-WIRED link inside a relabeled definition is not a relabeling", () => {
  assert.equal(
    verdict(
      mutatedLive((def) => {
        def.links[0].target_slot = (def.links[0].target_slot ?? 0) + 7;
      }),
    ),
    false,
  );
});

test("#1706 P0: a link endpoint that does NOT follow the map is not a relabeling", () => {
  // The patch is what makes the relabeling harmless. A definition whose node ids moved
  // while a link kept pointing at the OLD id is a broken graph, not a renamed one.
  assert.equal(
    verdict(
      mutatedLive((def, c) => {
        def.links[0].origin_id = c.payloadDefinitions.subgraphs[0].links[0].origin_id;
      }),
    ),
    false,
  );
});

test("#1706 P0: an ADDED or REMOVED link is not a relabeling", () => {
  assert.equal(verdict(mutatedLive((def) => def.links.pop())), false);
  assert.equal(
    verdict(
      mutatedLive((def) => {
        def.links.push({ ...def.links[0], id: 90210 });
      }),
    ),
    false,
  );
});

test("#1706 P0: a RENAMED interface port is not a relabeling", () => {
  assert.equal(
    verdict(
      mutatedLive((def) => {
        def.inputs[0].name = "renamed";
      }),
    ),
    false,
  );
});

test("#1706 P0: a node that MOVED is not a relabeling — geometry is untouched", () => {
  assert.equal(
    verdict(
      mutatedLive((def) => {
        def.nodes[0].pos = [999, 999];
      }),
    ),
    false,
  );
});

test("#1706 P0: REORDERED nodes inside a relabeled definition are not a relabeling", () => {
  assert.equal(verdict(mutatedLive((def) => def.nodes.reverse())), false);
});

test("#1706 P0: a duplicated live node id collapses two nodes into one and refuses", () => {
  assert.equal(
    verdict(
      mutatedLive((def) => {
        def.nodes[1].id = def.nodes[0].id;
      }),
    ),
    false,
  );
});

test("#1706 P1: the allocation counter may only go FORWARD", () => {
  const back = mutatedLive((def, c) => {
    for (const d of c.liveDefinitions.subgraphs) d.state.lastNodeId = 1;
  });
  assert.equal(verdict(back), false);
  const nonNumeric = mutatedLive((def, c) => {
    for (const d of c.liveDefinitions.subgraphs) d.state.lastNodeId = "214";
  });
  assert.equal(verdict(nonNumeric), false);
});

test("#1706 P1: a structural state counter moving is still not a relabeling", () => {
  assert.equal(
    verdict(
      mutatedLive((def, c) => {
        for (const d of c.liveDefinitions.subgraphs) d.state.lastGroupId = 999;
      }),
    ),
    false,
  );
});

test("#1706 P1: WITHOUT a relabeling, lastNodeId and order stay refusals", () => {
  // The wider allowances are bought by the relabeling, not granted by default. A
  // definitions block whose node ids did not move gets exactly the #886 answer.
  const counterOnly = sgP0({ state: { lastLinkId: 2092, lastNodeId: 13 } });
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), counterOnly, { rootNodes: [] }), false);
  const orderOnly = sgP0({
    nodes: [
      { id: 3, type: "LoadImage", order: 5, outputs: [{ links: [11] }] },
      { id: 4, type: "VAEEncode", inputs: [{ link: 11 }], outputs: [{ links: [12] }] },
      { id: 5, type: "KSampler", inputs: [{ link: null }, { link: 12 }] },
    ],
  });
  assert.equal(definitionsDifferOnlyByRenumber(sgP0(), orderOnly, { rootNodes: [] }), false);
});

test("#1706 P1: a promoted WIDGET whose id did not follow the map refuses", () => {
  const base = (widgetId) =>
    sgP0({
      widgets: [{ id: widgetId, name: "seed", promotedName: "seed" }],
      state: { lastLinkId: 2092, lastNodeId: 12 },
    });
  const relabel = (widgetId) =>
    sgP0({
      widgets: [{ id: widgetId, name: "seed", promotedName: "seed" }],
      state: { lastLinkId: 2092, lastNodeId: 42 },
      links: [
        [11, 40, 0, 41, 0, "IMAGE"],
        [12, 41, 0, 42, 1, "MASK"],
      ],
      nodes: [
        { id: 40, type: "LoadImage", outputs: [{ links: [11] }] },
        { id: 41, type: "VAEEncode", inputs: [{ link: 11 }], outputs: [{ links: [12] }] },
        { id: 42, type: "KSampler", inputs: [{ link: null }, { link: 12 }] },
      ],
    });
  assert.equal(definitionsDifferOnlyByRenumber(base(3), relabel(40), { rootNodes: [] }), true);
  assert.equal(definitionsDifferOnlyByRenumber(base(3), relabel(3), { rootNodes: [] }), false);
  assert.equal(definitionsDifferOnlyByRenumber(base(3), relabel(41), { rootNodes: [] }), false);
});

test("#1706 P1: a definition the map did not move is still compared in FULL", () => {
  // The two-pass shape: `state.lastNodeId` is the ROOT graph's counter, so a definition
  // that was NOT relabeled shows it moving anyway as soon as another one was. That is
  // the only thing the second definition is allowed to differ in.
  const c = captured();
  c.liveDefinitions.subgraphs[1] = JSON.parse(JSON.stringify(c.payloadDefinitions.subgraphs[1]));
  c.liveDefinitions.subgraphs[1].state.lastNodeId = c.liveDefinitions.subgraphs[0].state.lastNodeId;
  assert.equal(verdict(c), true, "an untouched definition riding the shared counter is fine");
  c.liveDefinitions.subgraphs[1].nodes[0].widgets_values = ["CHANGED"];
  assert.equal(verdict(c), false);
});

test("#1706 P0: two payload nodes COLLAPSING onto one live id is not a relabeling", () => {
  // The injectivity refusal, isolated. Measured by mutation: the captured-fixture
  // version of this refused for the WRONG reason (its links still named the old
  // second id), so removing the `usedTargets` check killed no test. Here the links
  // are collapsed consistently too, so the ONLY thing standing between this and a
  // "relabeling" verdict is the requirement that the map be injective — and what it
  // is standing in front of is a definition that lost a node.
  const twoNodes = (idA, idB) => ({
    subgraphs: [
      {
        id: "sub-1",
        name: "Detailer",
        state: { lastLinkId: 11, lastNodeId: Math.max(Number(idA), Number(idB)) },
        links: [[11, idA, 0, idB, 0, "IMAGE"]],
        nodes: [
          { id: idA, type: "LoadImage", widgets_values: [], outputs: [{ links: [11] }] },
          { id: idB, type: "LoadImage", widgets_values: [], inputs: [{ link: 11 }] },
        ],
      },
    ],
  });
  // Sanity: a genuine, injective relabeling of the same definition IS accounted...
  assert.equal(definitionsDifferOnlyByRenumber(twoNodes(3, 4), twoNodes(40, 41), { rootNodes: [] }), true);
  // ...and the collapse is not, even though every other check passes under it.
  assert.equal(definitionsDifferOnlyByRenumber(twoNodes(3, 4), twoNodes(40, 40), { rootNodes: [] }), false);
});

test("#1706 P0: an id whose only change is its TYPE is not a relabeling", () => {
  // Adversarial re-review of this change, not a reported case. The map is keyed by
  // String(id), so `78 -> "78"` reads as the identity — and once ANY definition in the
  // block has relabeled, `id` is an allowed field on EVERY definition, so a definition
  // whose ids only changed dialect would go completely unchecked. Pre-#1706 that case
  // refused (the definition-level deep-equal compared `id`), and it still must.
  const def = (id, over = {}) => ({
    id: "sub-1",
    name: "d",
    state: { lastLinkId: 11, lastNodeId: 9 },
    links: [],
    nodes: [{ id, type: "VAEDecode", widgets_values: [] }],
    ...over,
  });
  const moved = (a, b) => ({
    subgraphs: [
      { ...def(a), id: "sub-0", nodes: [{ id: a, type: "LoadImage", widgets_values: [] }] },
      def(b),
    ],
  });
  // Definition [0] genuinely relabels; definition [1]'s id only changes type.
  const payload = moved(3, 9);
  const live = moved(40, "9");
  live.subgraphs[0].state = { lastLinkId: 11, lastNodeId: 40 };
  live.subgraphs[1].state = { lastLinkId: 11, lastNodeId: 40 };
  assert.equal(definitionsDifferOnlyByRenumber(payload, live, { rootNodes: [] }), false);
  // The same shape with definition [1] left alone IS accounted, so the refusal above is
  // the type change and nothing else.
  const okLive = moved(40, 9);
  okLive.subgraphs[0].state = { lastLinkId: 11, lastNodeId: 40 };
  okLive.subgraphs[1].state = { lastLinkId: 11, lastNodeId: 40 };
  assert.equal(definitionsDifferOnlyByRenumber(payload, okLive, { rootNodes: [] }), true);
});

test("#1706 P0: a promoted widget id in a NON-CANONICAL dialect still refuses", () => {
  // Gate finding, and the same class as a string/number key mismatch that made two
  // tools fail 100% of the time on a real graph tonight. `remappedFrom` is keyed by
  // `String(payloadId)`, so `"78.0"` / `" 78"` / `"+78"` are all "not in the set" to a
  // text comparison while naming node 78 to anything that reads the id numerically.
  // Measured end-to-end by the gate: `definitions` came back ACCOUNTED and the weaker
  // completed-load ground flipped to normalizedOnly with
  // `normalizedFields ["properties","widgets_values"]` — reassuring wording over a
  // genuinely lost promoted widget. The verdict still refused, so no fence was
  // published, but the sentence was wrong and this closes it.
  const c = captured();
  const movedFrom = c.payloadDefinitions.subgraphs[0].nodes[0].id;
  assert.equal(typeof movedFrom, "number", "the fixture's ids are numeric, as the frontend writes them");
  for (const dialect of [
    `${movedFrom}.0`,
    ` ${movedFrom}`,
    `+${movedFrom}`,
    `${movedFrom} `,
    `0${movedFrom}`,
    `${movedFrom}.00`,
    `${movedFrom}abc`, // Number() says NaN; a leading-integer parse says it names the moved node
    movedFrom, // the number itself, not a string — the schema says string, reality may not
  ]) {
    assert.equal(
      definitionsDifferOnlyByRenumber(c.payloadDefinitions, c.liveDefinitions, {
        rootNodes: [{ id: 400, type: "sub-1", properties: { proxyWidgets: [[dialect, "seed"]] } }],
      }),
      false,
      `proxyWidgets id ${JSON.stringify(dialect)} names a relabeled node and must refuse`,
    );
  }
});

test("#1706 a NON-numeric promoted id that names nothing remapped still does not block", () => {
  // The direction that costs something: the guard must not become "refuse whenever any
  // root node promotes anything". A promoted widget naming a node the relabeling never
  // touched is not evidence of loss, and the account stays available.
  const c = captured();
  for (const id of ["not-a-node", "999999", " 999999", "999999.0"]) {
    assert.equal(
      definitionsDifferOnlyByRenumber(c.payloadDefinitions, c.liveDefinitions, {
        rootNodes: [{ id: 400, type: "sub-1", properties: { proxyWidgets: [[id, "seed"]] } }],
      }),
      true,
      `proxyWidgets id ${JSON.stringify(id)} names nothing that moved`,
    );
  }
});

test("#1706 P0: a promoted widget id in HEX or EXPONENT form still refuses", () => {
  // The two numeric readings are NOT redundant, and mutation is what showed it: with
  // only the decimal dialects above, deleting the `Number()` clause killed no test,
  // because a leading-integer parse already caught `"78.0"`, `" 78"`, `"078"`, `"78abc"`.
  // These two are the inputs where the readings DISAGREE — `Number("0x4E")` is 78 while
  // a leading-integer parse is 0, and `Number("7.8e1")` is 78 while the parse is 7 — so
  // each clause is the only thing standing in front of one of them.
  const c = captured();
  const movedFrom = c.payloadDefinitions.subgraphs[0].nodes[0].id;
  const hex = `0x${movedFrom.toString(16)}`;
  const exponent = `${movedFrom / 10}e1`;
  assert.equal(Number(hex), movedFrom, "the hex form must really name the moved node");
  assert.equal(Number(exponent), movedFrom, "the exponent form must really name the moved node");
  assert.notEqual(Number(/^\s*[+-]?\d+/.exec(hex)[0]), movedFrom, "and the leading-integer parse must NOT");
  assert.notEqual(Number(/^\s*[+-]?\d+/.exec(exponent)[0]), movedFrom, "likewise");
  for (const dialect of [hex, exponent]) {
    assert.equal(
      definitionsDifferOnlyByRenumber(c.payloadDefinitions, c.liveDefinitions, {
        rootNodes: [{ id: 400, type: "sub-1", properties: { proxyWidgets: [[dialect, "seed"]] } }],
      }),
      false,
      `proxyWidgets id ${JSON.stringify(dialect)} names a relabeled node and must refuse`,
    );
  }
});
