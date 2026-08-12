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
import { definitionsDifferOnlyByLinkRenumber } from "../../web/js/lib/definitions-renumber.js";

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
  assert.equal(definitionsDifferOnlyByLinkRenumber(defs(), renumbered()), true);
});

test("#886 identical definitions are fine too", () => {
  assert.equal(definitionsDifferOnlyByLinkRenumber(defs(), defs()), true);
});

test("#886 a node ADDED or REMOVED still fails", () => {
  // The part that makes tolerating this safe at all: the node set must match.
  const extra = defs();
  extra.subgraphs[0].nodes = [...extra.subgraphs[0].nodes, { id: 700, type: "PreviewImage", inputs: [] }];
  assert.equal(definitionsDifferOnlyByLinkRenumber(defs(), extra), false);
  assert.equal(definitionsDifferOnlyByLinkRenumber(extra, defs()), false);
});

test("#886 a node RETYPED still fails", () => {
  const retyped = defs();
  retyped.subgraphs[0].nodes[0].type = "SaveImage";
  assert.equal(definitionsDifferOnlyByLinkRenumber(defs(), retyped), false);
});

test("#886 a changed WIDGET VALUE still fails", () => {
  // The one that matters most: a silently different model name inside a subgraph is
  // exactly the wrong-graph open this guard exists to catch (#968).
  const edited = renumbered();
  edited.subgraphs[0].nodes[1].widgets_values = ["DIFFERENT.pth"];
  assert.equal(definitionsDifferOnlyByLinkRenumber(defs(), edited), false);
});

test("#886 a moved node still fails — renumbering does not touch geometry", () => {
  const moved = renumbered();
  moved.subgraphs[0].nodes[0].pos = [500, 500];
  assert.equal(definitionsDifferOnlyByLinkRenumber(defs(), moved), false);
});

test("#886 a changed slot NAME or TYPE still fails", () => {
  // Only the link reference may move within a slot; its identity may not.
  for (const patch of [{ name: "other" }, { type: "LATENT" }, { localized_name: "x" }]) {
    const bad = renumbered();
    Object.assign(bad.subgraphs[0].nodes[0].inputs[0], patch);
    assert.equal(definitionsDifferOnlyByLinkRenumber(defs(), bad), false, JSON.stringify(patch));
  }
});

test("#886 a structural state counter moving still fails", () => {
  // lastLinkId/lastRerouteId are renumbering; lastNodeId/lastGroupId say how many
  // nodes or groups have existed, which renumbering cannot change.
  const bad = renumbered();
  bad.subgraphs[0].state.lastNodeId = 9999;
  assert.equal(definitionsDifferOnlyByLinkRenumber(defs(), bad), false);
});

test("#886 a different subgraph SET fails, and so does an unknown key", () => {
  const two = defs();
  two.subgraphs = [sg(), sg({ id: "second" })];
  assert.equal(definitionsDifferOnlyByLinkRenumber(defs(), two), false);
  // A future top-level key must not be waved through by a rule written before it.
  const future = defs();
  future.somethingNew = { a: 1 };
  assert.equal(definitionsDifferOnlyByLinkRenumber(defs(), future), false);
});

test("#886 unreadable shapes are NOT proven", () => {
  // False must read as "cannot account for it", never as "changed".
  for (const [a, b] of [[undefined, undefined], [null, defs()], [defs(), null], ["x", defs()], [defs(), { subgraphs: "no" }]]) {
    assert.equal(definitionsDifferOnlyByLinkRenumber(a, b), false, JSON.stringify([a, b]));
  }
});

test("#886 WIRING: the content proof consults it for a definitions surface", () => {
  // The predicate is inert unless the proof calls it, and the behavioural tests
  // above cannot see the call site.
  const src = readFileSync(join(ROOT, "web/js/lib/graph-binding.js"), "utf8");
  assert.match(src, /import \{ definitionsDifferOnlyByLinkRenumber \} from "\.\/definitions-renumber\.js";/);
  assert.match(src, /definitionsDifferOnlyByLinkRenumber\(state\?\.definitions, actualState\?\.definitions\)/);
  // The surface set must be a SUBSET of { nodes, definitions }; anything else refuses.
  assert.match(src, /s !== "nodes" && s !== "definitions"\)\) return NOT_PROVEN;/);
  // `nodes` must NOT be mandatory. Requiring it refused the reported case outright:
  // #886 is a graph where `definitions` is the ONLY differing surface, so the earlier
  // gate wired this fix into a branch its own bug report could never reach (review).
  assert.doesNotMatch(src, /if \(!surfaces\.includes\("nodes"\)\) return NOT_PROVEN;/);
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
  assert.equal(definitionsDifferOnlyByLinkRenumber(sgP0(), renumberedP0()), true);
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
  assert.equal(definitionsDifferOnlyByLinkRenumber(sgP0(), rewired), false);
});

test("#886 P0: a link pointing at a DIFFERENT node is not renumbering", () => {
  const moved = sgP0({
    links: [
      [11, 3, 0, 4, 0, "IMAGE"],
      [12, 4, 0, 3, 1, "MASK"],
    ],
  });
  assert.equal(definitionsDifferOnlyByLinkRenumber(sgP0(), moved), false);
});

test("#886 P0: an ADDED or REMOVED link is not renumbering", () => {
  const added = sgP0({ links: [...sgP0().subgraphs[0].links, [13, 3, 0, 5, 0, "IMAGE"]] });
  assert.equal(definitionsDifferOnlyByLinkRenumber(sgP0(), added), false);
  const removed = sgP0({ links: [sgP0().subgraphs[0].links[0]] });
  assert.equal(definitionsDifferOnlyByLinkRenumber(sgP0(), removed), false);
});

test("#886 P0: a RENAMED or RETYPED interface port is not renumbering", () => {
  // inputs/outputs are the subgraph contract with the outside graph.
  assert.equal(
    definitionsDifferOnlyByLinkRenumber(sgP0(), sgP0({ inputs: [{ name: "picture", type: "IMAGE" }] })),
    false,
  );
  assert.equal(
    definitionsDifferOnlyByLinkRenumber(sgP0(), sgP0({ outputs: [{ name: "out", type: "MASK" }] })),
    false,
  );
  assert.equal(definitionsDifferOnlyByLinkRenumber(sgP0(), sgP0({ inputs: [] })), false);
});

test("#886 P0: a changed node TYPE or widget value is not renumbering", () => {
  const retyped = sgP0({
    nodes: [
      { id: 3, type: "LoadImageMask", outputs: [{ links: [11] }] },
      ...sgP0().subgraphs[0].nodes.slice(1),
    ],
  });
  assert.equal(definitionsDifferOnlyByLinkRenumber(sgP0(), retyped), false);
  const rewidgeted = sgP0({
    nodes: [
      { id: 3, type: "LoadImage", outputs: [{ links: [11] }], widgets_values: ["b.png"] },
      ...sgP0().subgraphs[0].nodes.slice(1),
    ],
  });
  assert.equal(definitionsDifferOnlyByLinkRenumber(sgP0(), rewidgeted), false);
});

test("#886 P0: a slot that GAINED a connection is not renumbering", () => {
  const gained = sgP0({
    nodes: [
      { id: 3, type: "LoadImage", outputs: [{ links: [11, 99] }] },
      ...sgP0().subgraphs[0].nodes.slice(1),
    ],
  });
  assert.equal(definitionsDifferOnlyByLinkRenumber(sgP0(), gained), false);
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
  assert.equal(definitionsDifferOnlyByLinkRenumber(dup, dup2), false);
});

test("#886 P1: a node missing an id or type refuses", () => {
  const noId = sgP0({ nodes: [{ type: "LoadImage" }] });
  const noType = sgP0({ nodes: [{ id: 3 }] });
  assert.equal(definitionsDifferOnlyByLinkRenumber(noId, sgP0({ nodes: [{ type: "LoadImage" }] })), false);
  assert.equal(definitionsDifferOnlyByLinkRenumber(noType, sgP0({ nodes: [{ id: 3 }] })), false);
});

test("#886 P2: a cyclic structure fails closed instead of throwing", () => {
  // JSON.stringify threw here, turning a "not proven" answer into an exception on the
  // guard path.
  const a = sgP0();
  const b = renumberedP0();
  b.subgraphs[0].extra = {};
  b.subgraphs[0].extra.self = b.subgraphs[0].extra;
  assert.doesNotThrow(() => definitionsDifferOnlyByLinkRenumber(a, b));
  assert.equal(definitionsDifferOnlyByLinkRenumber(a, b), false);
});

test("#886 a differing subgraph COUNT refuses", () => {
  const two = sgP0();
  two.subgraphs.push(sgP0().subgraphs[0]);
  assert.equal(definitionsDifferOnlyByLinkRenumber(sgP0(), two), false);
});

// ── Round 2 of review: four more ways a different graph could have passed ──

test("#886 P0: REORDERED nodes are not renumbering", () => {
  // LiteGraph node order can carry execution and draw ordering, so a reordered array
  // is not the same subgraph. Indexing by identity alone accepted it.
  const base = sgP0();
  const reordered = sgP0({ nodes: [...sgP0().subgraphs[0].nodes].reverse() });
  assert.equal(definitionsDifferOnlyByLinkRenumber(base, reordered), false);
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
  assert.equal(definitionsDifferOnlyByLinkRenumber(mk("a:0>b", "c"), mk("a", "0>b:c")), false);
});

test("#886 P0: a changed link TYPE is not renumbering", () => {
  const other = sgP0({
    links: [
      [11, 3, 0, 4, 0, "LATENT"],
      [12, 4, 0, 5, 1, "MASK"],
    ],
  });
  assert.equal(definitionsDifferOnlyByLinkRenumber(sgP0(), other), false);
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
  assert.doesNotThrow(() => definitionsDifferOnlyByLinkRenumber(sgP0(), bad));
  assert.equal(definitionsDifferOnlyByLinkRenumber(sgP0(), bad), false);
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
  assert.equal(definitionsDifferOnlyByLinkRenumber(withDeep(false), withDeep(true)), true);
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
  assert.doesNotThrow(() => definitionsDifferOnlyByLinkRenumber(g, sgP0()));
  assert.equal(definitionsDifferOnlyByLinkRenumber(g, sgP0()), false);
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
  assert.doesNotThrow(() => definitionsDifferOnlyByLinkRenumber(hostile, sgP0()));
  assert.equal(definitionsDifferOnlyByLinkRenumber(hostile, sgP0()), false);
  assert.doesNotThrow(() => definitionsDifferOnlyByLinkRenumber(sgP0(), hostile));
  assert.equal(definitionsDifferOnlyByLinkRenumber(sgP0(), hostile), false);
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
  assert.doesNotThrow(() => definitionsDifferOnlyByLinkRenumber(sgP0(), bad));
  assert.equal(definitionsDifferOnlyByLinkRenumber(sgP0(), bad), false);
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
  assert.equal(definitionsDifferOnlyByLinkRenumber(g, renumberedP0()), false);
});
