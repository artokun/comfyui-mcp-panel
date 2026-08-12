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
  // Any OTHER extra surface must still refuse outright.
  assert.match(src, /else if \(extra\.length > 0\) \{\s*\n\s*return NOT_PROVEN;/);
  // And `nodes` must still be required — this widened the tolerated set, not the gate.
  assert.match(src, /if \(!surfaces\.includes\("nodes"\)\) return NOT_PROVEN;/);
});
