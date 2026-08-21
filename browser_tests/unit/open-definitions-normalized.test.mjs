// panel#1283, the 2026-08-21 recurrence — `panel_open_workflow` on an already-open
// unsaved `tmp:` tab was refused again, on a release (v0.15.32) that already carried
// every fix the earlier reports produced (#1358's completed-load ground, #1387's
// entered guard, #1477's definitions-only path).
//
// REPRODUCED IN A REAL BROWSER, ComfyUI 0.33.2 / frontend 1.49.6, the reporter's own
// configuration: claim a fresh canvas, add eight nodes, convert two of them into a
// subgraph, reopen the tab that is already active. The open bound, every root node
// came back with the same id and type, nothing extra appeared — `ok: false`, no
// `workflow_uuid`, refused on `nodes, definitions`.
//
// TWO independent causes, and BOTH are load-bearing: with either one reverted the
// browser reproduction goes back to `ok: false` (measured, one at a time).
//
// -- 1. `undefined` counted as a difference -----------------------------------------
// The definition fields that "differed" were `inputNode`, `outputNode` and `inputs`,
// whose JSON is byte-identical. What differed was keys the LIVE serializer emits with
// the value `undefined` and `JSON.stringify` drops:
//
//     inputNode / outputNode   pinned
//     inputs[]                 localized_name, label, dir, shape, color_off, color_on
//
// The payload side of this comparison is `JSON.parse(JSON.stringify(state))`, and the
// file side is a parsed `.json`, so NEITHER can ever carry such a key. Counting them
// made #886's and #1706's renumber accounts inert on this frontend — every subgraph
// workflow's `definitions` went unaccounted, whatever else was true of it.
//
// -- 2. no account for a per-node rewrite inside a definition ------------------------
// With that repaired the surface still refused, on a real difference: an installed
// pack (cg-use-everywhere) stamps `properties.ue_properties.version` onto every node
// during `configure`.
//
//     payload  "ue_properties": { "widget_ue_connectable": {}, "input_ue_unconnectable": {} }
//     live     "ue_properties": { "widget_ue_connectable": {}, "input_ue_unconnectable": {},
//                                 "version": "7.8" }
//
// It does the same to the ROOT nodes — and THERE it is already accounted for, by
// #1358's completed-load ground, which admits any NAMED per-node difference once the
// panel has watched the restore run to completion. The identical rewrite, on the same
// nodes, one level down had no account at all.
//
// A renumber account cannot grow to cover it: it is field-level by construction, and
// admitting `properties` would license a renumbering to rewrite arbitrary node
// content. So the question is asked at the level #1358 moved it to — did this restore
// stop early? — and the answer is an observation of the load, not a judgement about a
// field name.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  definitionsDifferOnlyByCompletedLoadNormalization,
  definitionsDifferOnlyByRenumber,
} from "../../web/js/lib/definitions-renumber.js";
import { graphRootReproducesStateContent } from "../../web/js/lib/graph-binding.js";

/** The definition the browser produced, payload side. */
const payloadDef = (over = {}) => ({
  id: "57bb0646-920b-4076-8215-2477fab7de9d",
  version: 1,
  state: { lastGroupId: 0, lastNodeId: 9, lastLinkId: 2, lastRerouteId: 0 },
  revision: 0,
  config: {},
  name: "New Subgraph",
  inputNode: { id: -10, bounding: [-178, 71, 128, 48] },
  outputNode: { id: -20, bounding: [470, 71, 128, 48] },
  inputs: [{ id: "8874cc1f", name: "text", type: "STRING", linkIds: [1], pos: [0, 0] }],
  outputs: [],
  widgets: [],
  nodes: [
    {
      id: 2,
      type: "CLIPTextEncode",
      pos: [10, 10],
      size: [400, 200],
      order: 0,
      mode: 0,
      properties: {
        cnr_id: "comfy-core",
        ver: "0.33.2",
        ue_properties: { widget_ue_connectable: {}, input_ue_unconnectable: {} },
        "Node name for S&R": "CLIPTextEncode",
      },
      widgets_values: [""],
    },
  ],
  links: [{ id: 1, origin_id: -10, origin_slot: 0, target_id: 2, target_slot: 1, type: "STRING" }],
  groups: [],
  extra: {},
  ...over,
});

/** The same definition as the LIVE serializer emits it after the load. */
const liveDef = (over = {}) => {
  const d = payloadDef();
  // The measured `undefined` keys. Written explicitly because that is the point: a
  // `JSON.parse(JSON.stringify(...))` fixture would erase the very thing under test.
  d.inputNode = { id: -10, bounding: [-178, 71, 128, 48], pinned: undefined };
  d.outputNode = { id: -20, bounding: [470, 71, 128, 48], pinned: undefined };
  d.inputs = [
    {
      id: "8874cc1f",
      name: "text",
      type: "STRING",
      linkIds: [1],
      localized_name: undefined,
      label: undefined,
      dir: undefined,
      shape: undefined,
      color_off: undefined,
      color_on: undefined,
      pos: [0, 0],
    },
  ];
  // ...and the pack's version stamp.
  d.nodes = [
    {
      ...d.nodes[0],
      properties: {
        ...d.nodes[0].properties,
        ue_properties: { widget_ue_connectable: {}, input_ue_unconnectable: {}, version: "7.8" },
      },
    },
  ];
  return { ...d, ...over };
};

const payload = (over) => ({ subgraphs: [payloadDef(over)] });
const live = (over) => ({ subgraphs: [liveDef(over)] });
const completed = { loadRanToCompletion: true };

// -- the `undefined` rule, on the ACCOUNT THAT ALREADY SHIPPED -----------------------
//
// This is the half that is invisible from the new predicate: #886's renumber account
// is what a plain link-renumbering open depends on, and the `undefined` keys made it
// answer false on any frontend that emits them. Pinned on
// `definitionsDifferOnlyByRenumber` so a revert of the `deepEqual` rule fails HERE,
// not only on the new ground.

test("#1283 the renumber account survives the keys the live serializer emits as `undefined`", () => {
  const before = { subgraphs: [payloadDef()] };
  const after = {
    subgraphs: [{ ...payloadDef(), inputNode: { id: -10, bounding: [-178, 71, 128, 48], pinned: undefined } }],
  };
  assert.equal(definitionsDifferOnlyByRenumber(before, after, { rootNodes: [] }), true);
});

test("#1283 `null` is still a real difference — only `undefined` is absent", () => {
  const before = { subgraphs: [payloadDef()] };
  const after = {
    subgraphs: [{ ...payloadDef(), inputNode: { id: -10, bounding: [-178, 71, 128, 48], pinned: null } }],
  };
  assert.equal(definitionsDifferOnlyByRenumber(before, after, { rootNodes: [] }), false);
  assert.equal(definitionsDifferOnlyByCompletedLoadNormalization(before, after, completed), false);
});

test("#1283 a field the payload HAS and the live side lost is still a difference", () => {
  const before = { subgraphs: [payloadDef({ name: "New Subgraph" })] };
  const after = { subgraphs: [{ ...payloadDef(), name: undefined }] };
  assert.equal(definitionsDifferOnlyByCompletedLoadNormalization(before, after, completed), false);
  assert.equal(definitionsDifferOnlyByRenumber(before, after, { rootNodes: [] }), false);
});

// -- the completed-load ground, one level down ---------------------------------------

test("#1283 the MEASURED per-node rewrite inside a definition is accounted for", () => {
  assert.equal(definitionsDifferOnlyByCompletedLoadNormalization(payload(), live(), completed), true);
  // ...and the renumber account still refuses it, so the new ground is what carries it.
  assert.equal(definitionsDifferOnlyByRenumber(payload(), live(), { rootNodes: [] }), false);
});

test("#1283 the licence is the OBSERVATION: unwatched and aborted both refuse", () => {
  for (const loadRanToCompletion of [false, null, undefined, "true", 1]) {
    assert.equal(
      definitionsDifferOnlyByCompletedLoadNormalization(payload(), live(), { loadRanToCompletion }),
      false,
      `loadRanToCompletion=${String(loadRanToCompletion)} must not license anything`,
    );
  }
  assert.equal(definitionsDifferOnlyByCompletedLoadNormalization(payload(), live(), undefined), false);
});

test("#1283 a node ADDED, RETYPED, RELABELED or REORDERED inside a definition still refuses", () => {
  const extra = liveDef();
  extra.nodes = [...extra.nodes, { id: 3, type: "CLIPTextEncode", properties: {} }];
  assert.equal(definitionsDifferOnlyByCompletedLoadNormalization(payload(), { subgraphs: [extra] }, completed), false);

  const retyped = liveDef();
  retyped.nodes = [{ ...retyped.nodes[0], type: "CLIPTextEncodeSDXL" }];
  assert.equal(definitionsDifferOnlyByCompletedLoadNormalization(payload(), { subgraphs: [retyped] }, completed), false);

  // #1706's relabeling is deliberately NOT admitted here: a definition node id that
  // moves is referenced from outside this surface (a root node's `proxyWidgets`), and
  // pinning the id is what makes that hazard unreachable rather than merely guarded.
  const relabeled = liveDef();
  relabeled.nodes = [{ ...relabeled.nodes[0], id: 182 }];
  assert.equal(definitionsDifferOnlyByCompletedLoadNormalization(payload(), { subgraphs: [relabeled] }, completed), false);

  const two = { ...payloadDef(), nodes: [payloadDef().nodes[0], { id: 3, type: "PreviewImage" }] };
  const swapped = { ...payloadDef(), nodes: [{ id: 3, type: "PreviewImage" }, payloadDef().nodes[0]] };
  assert.equal(
    definitionsDifferOnlyByCompletedLoadNormalization({ subgraphs: [two] }, { subgraphs: [swapped] }, completed),
    false,
  );
});

test("#1283 anything but the node array moving still refuses — no rewire rides in on this", () => {
  for (const over of [
    { links: [{ id: 1, origin_id: -10, origin_slot: 0, target_id: 2, target_slot: 0, type: "STRING" }] },
    { state: { lastGroupId: 0, lastNodeId: 14, lastLinkId: 2, lastRerouteId: 0 } },
    { widgets: [{ id: 2, name: "text" }] },
    { name: "Renamed Subgraph" },
    { groups: [{ id: 1, title: "g" }] },
    { outputs: [{ id: "x", name: "out", type: "STRING", linkIds: [] }] },
    { extra: { note: "hi" } },
  ]) {
    assert.equal(
      definitionsDifferOnlyByCompletedLoadNormalization(payload(), live(over), completed),
      false,
      `a change to ${Object.keys(over)[0]} must refuse`,
    );
  }
});

test("#1283 a definition ADDED, DROPPED or rekeyed, and an unreadable shape, all refuse", () => {
  assert.equal(
    definitionsDifferOnlyByCompletedLoadNormalization(payload(), { subgraphs: [liveDef(), liveDef()] }, completed),
    false,
  );
  assert.equal(definitionsDifferOnlyByCompletedLoadNormalization(payload(), { subgraphs: [] }, completed), false);
  assert.equal(
    definitionsDifferOnlyByCompletedLoadNormalization(
      { subgraphs: { a: payloadDef() } },
      { subgraphs: { b: liveDef() } },
      completed,
    ),
    false,
  );
  assert.equal(
    definitionsDifferOnlyByCompletedLoadNormalization(payload(), { subgraphs: [liveDef()], other: 1 }, completed),
    false,
  );
  for (const bad of [null, undefined, 7, "x", []]) {
    assert.equal(definitionsDifferOnlyByCompletedLoadNormalization(bad, live(), completed), false);
    assert.equal(definitionsDifferOnlyByCompletedLoadNormalization(payload(), bad, completed), false);
  }
});

test("#1283 a cyclic definition is NOT proven — it fails closed rather than throwing", () => {
  const cyclic = liveDef();
  cyclic.extra = {};
  cyclic.extra.self = cyclic.extra;
  assert.equal(
    definitionsDifferOnlyByCompletedLoadNormalization(payload(), { subgraphs: [cyclic] }, completed),
    false,
  );
});

// -- THE WIRING, on the verdict the reply is taken from -------------------------------
//
// The predicate above is only half a fix: it changes nothing unless
// `graphRootReproducesStateContent` subtracts `definitions` from the surface list the
// completed-load ground reads. These drive the REAL function, so deleting the lines
// that call it fails here.

/** The reporter's shape: root nodes rewritten by the same pack, plus the subgraph. */
const rootNode = (props) => ({
  id: 1,
  type: "CheckpointLoaderSimple",
  pos: [10, 10],
  size: [270, 98],
  order: 0,
  mode: 0,
  properties: props,
  widgets_values: ["sd_xl.safetensors"],
});
const PAYLOAD_PROPS = { cnr_id: "comfy-core", ue_properties: { widget_ue_connectable: {} } };
const LIVE_PROPS = { cnr_id: "comfy-core", ue_properties: { widget_ue_connectable: {}, version: "7.8" } };

const openState = { nodes: [rootNode(PAYLOAD_PROPS)], links: [], definitions: payload() };
const openRoot = { serialize: () => ({ nodes: [rootNode(LIVE_PROPS)], links: [], definitions: live() }) };

test("#1283 the open verdict admits `nodes, definitions` on a WATCHED, completed load", () => {
  const proof = graphRootReproducesStateContent({
    rootGraph: openRoot,
    state: openState,
    loadRanToCompletion: true,
  });
  assert.equal(proof.proven, false, "the strict proof does not reach a properties difference");
  assert.equal(proof.normalizedOnly, true, "the completed-load ground must carry this open");
  assert.deepEqual(proof.normalizedFields, ["properties"]);
  assert.equal(proof.definitionsNormalized, true, "the reply must be able to disclose the subgraph difference");
});

test("#1283 the same difference on an UNWATCHED load is still refused", () => {
  for (const loadRanToCompletion of [null, false, undefined]) {
    const proof = graphRootReproducesStateContent({ rootGraph: openRoot, state: openState, loadRanToCompletion });
    assert.equal(proof.normalizedOnly, false, `loadRanToCompletion=${String(loadRanToCompletion)}`);
    assert.equal(proof.definitionsNormalized, false);
    assert.equal(proof.presentationOnly, false);
  }
});

test("#1283 `definitionsNormalized` is an account that was USED, never one that merely applied", () => {
  // The definitions are exactly the accountable shape, but a LINK was lost at the root —
  // so the verdict refuses, and the reply must not announce a subgraph account it never
  // rested on.
  const proof = graphRootReproducesStateContent({
    rootGraph: openRoot,
    state: { ...openState, links: [[1, 1, 0, 2, 0, "MODEL"]] },
    loadRanToCompletion: true,
  });
  assert.equal(proof.normalizedOnly, false, "a lost link must still refuse");
  assert.equal(proof.definitionsNormalized, false, "and the disclosure flag must not be set");
});

test("#1283 a definitions difference the ground CANNOT account for still refuses the open", () => {
  const rewired = liveDef();
  rewired.links = [{ id: 1, origin_id: -10, origin_slot: 0, target_id: 2, target_slot: 0, type: "STRING" }];
  const proof = graphRootReproducesStateContent({
    rootGraph: {
      serialize: () => ({ nodes: [rootNode(LIVE_PROPS)], links: [], definitions: { subgraphs: [rewired] } }),
    },
    state: openState,
    loadRanToCompletion: true,
  });
  assert.equal(proof.normalizedOnly, false);
  assert.equal(proof.definitionsNormalized, false);
});
