// artokun/comfyui-mcp#1588 — a faithful open of a workflow containing SUBGRAPHS was
// disclosed with the maximal-alarm wording, because `definitions` counted as a second
// unexplained surface even though the panel had already accounted for it.
//
// WHAT THE REPORTER SAW. Save-As a copy, open it immediately, and the tool errors:
//
//   "workflow_open RAN and the canvas IS bound to … but the graph on it does not match
//    the state that was loaded … nodes, definitions … every node that was loaded IS on
//    the canvas with the same id and type, and nothing extra appeared"
//
// — followed by the paragraph that names #1111/#1089, says the canvas may hold the
// PREVIOUS workflow's graph, and prescribes reloading from disk after preserving
// unsaved work to a NEW path with Save As. A follow-up panel_graph_outline showed the
// expected 72-node graph. None of that recovery was needed.
//
// THE MECHANISM. `nodesOnly` (#825) tested the RAW surface list, requiring it to be
// exactly ["nodes"]. #886 measured that loading a persisted workflow regenerates link
// identity inside `definitions.subgraphs` — so `definitions` lands in that list on
// EVERY faithful open of EVERY workflow with a subgraph. The presence of subgraphs
// alone, not any observation about the graph, decided which paragraph the reader got.
//
// The content VERDICT already knew better: `graphRootReproducesStateContent` admits a
// `definitions` surface when `definitionsDifferOnlyByRenumber` accounts for the
// whole of it. That judgement simply never reached the sentence.
//
// #825's narrowness is deliberate and is KEPT: a second surface that is genuinely
// unexplained still falls back to "the panel cannot tell". What changed is that an
// EXPLAINED surface stops counting as one.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OPEN_REBIND_STATUS,
  describeGraphStateDifference,
  describeOpenRebindOutcome,
  resolveOpenRebindVerdict,
} from "../../web/js/lib/graph-binding.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

const CONTENT_ONLY = resolveOpenRebindVerdict({
  instanceStillTarget: true,
  markerMatches: true,
  identityMatches: true,
  contentMatches: false,
});

/** The reporter's node observation: same set, cosmetic fields only. */
const NODES_INTACT = { comparable: true, sameNodeSet: true, cosmeticOnly: true, fields: ["size", "pos"] };

// ── the reporter's own message ───────────────────────────────────────────────

test("the reporter's shape: an accounted `definitions` no longer blocks the reassurance", () => {
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "QuadView_krea2_v1.json",
    contentComparable: true,
    contentSurfaces: ["nodes", "definitions"],
    contentAccountedSurfaces: ["definitions"],
    contentNodeDifference: NODES_INTACT,
  });

  assert.match(msg, /same widget values and links/i);
  assert.match(msg, /no missing work to redo/i);
  // The paragraph the reporter was sent into, and the destructive remedy it carries.
  assert.doesNotMatch(msg, /partly applied/i);
  assert.doesNotMatch(msg, /PREVIOUS workflow's graph/i);
  assert.doesNotMatch(msg, /panel_load_workflow/, "no reload-from-disk is warranted here");
  assert.doesNotMatch(msg, /Save As/i, "nor the preserve-your-work dance that goes with it");
});

test("the accounted surface is EXPLAINED, not silently dropped", () => {
  // Suppressing it entirely would leave the reader with a message that says the graph
  // differs on `nodes` while the verdict was reached over two surfaces. Name it, and
  // say what accounts for it.
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "QuadView_krea2_v1.json",
    contentComparable: true,
    contentSurfaces: ["nodes", "definitions"],
    contentAccountedSurfaces: ["definitions"],
    contentNodeDifference: NODES_INTACT,
  });

  assert.match(msg, /definitions/);
  // comfyui-mcp#1706 — the sentence may not name ONE mechanism. There are two measured
  // rewrites on this surface (link ids, #886; subgraph node ids, #1706) and the
  // predicate does not report which it matched, so a reply that said "link renumbering"
  // would be stating a cause it never observed. It must name renumbering and BOTH kinds
  // of id, and it must say what was actually proven about the graph.
  assert.match(msg, /RENUMBERING/i);
  assert.match(msg, /link ids/i);
  assert.match(msg, /node ids inside subgraph definitions/i);
  assert.match(msg, /same nodes in the same order/i);
  assert.match(msg, /not a content change/i);
});

// ── the direction that costs something ───────────────────────────────────────

test("a definitions difference that is NOT accounted for still blocks the reassurance", () => {
  // `definitionsDifferOnlyByRenumber` fails closed, so anything it cannot fully
  // explain arrives here with an empty accounted list — and must read exactly as it
  // did before this change.
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "QuadView_krea2_v1.json",
    contentComparable: true,
    contentSurfaces: ["nodes", "definitions"],
    contentAccountedSurfaces: [],
    contentNodeDifference: NODES_INTACT,
  });

  assert.match(msg, /partly applied/i);
  assert.doesNotMatch(msg, /no missing work to redo/i);
});

test("an accounted surface does not license a genuinely unexplained one", () => {
  // #825's rule, unchanged: a group that disagrees is unexplained by anything the node
  // set or the renumber check establishes.
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "QuadView_krea2_v1.json",
    contentComparable: true,
    contentSurfaces: ["nodes", "groups", "definitions"],
    contentAccountedSurfaces: ["definitions"],
    contentNodeDifference: NODES_INTACT,
  });

  assert.match(msg, /partly applied/i);
  assert.doesNotMatch(msg, /no missing work to redo/i);
});

test("only surfaces with a written account may be claimed as accounted", () => {
  // This list SHRINKS what a reader is asked to worry about, so a wrong entry waves
  // away a real difference. `groups` has no account anywhere in this file, and naming
  // it here must change nothing.
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "QuadView_krea2_v1.json",
    contentComparable: true,
    contentSurfaces: ["nodes", "groups"],
    contentAccountedSurfaces: ["groups"],
    contentNodeDifference: NODES_INTACT,
  });

  assert.match(msg, /partly applied/i);
  assert.doesNotMatch(msg, /no missing work to redo/i);
});

test("a surface that did not differ cannot be used to shorten the list", () => {
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "QuadView_krea2_v1.json",
    contentComparable: true,
    contentSurfaces: ["nodes", "groups"],
    // `definitions` IS accountable, but it is not among the surfaces that differ, so
    // it accounts for nothing and `groups` stays unexplained.
    contentAccountedSurfaces: ["definitions"],
    contentNodeDifference: NODES_INTACT,
  });

  assert.match(msg, /partly applied/i);
  assert.doesNotMatch(msg, /no missing work to redo/i);
});

test("a surface that did not differ is never DESCRIBED as differing", () => {
  // The membership gate earns its keep here rather than in the branch above: an
  // accounted name that is not in `contentSurfaces` subtracts nothing from the
  // unexplained list, so the gate's whole effect is on the sentence. Without it the
  // message announces "its `definitions` also differ" about a surface that agreed —
  // a fabricated observation inside the disclosure whose entire job is to report only
  // what was observed.
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "QuadView_krea2_v1.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentAccountedSurfaces: ["definitions"],
    contentNodeDifference: NODES_INTACT,
  });

  assert.doesNotMatch(msg, /definitions/i, "nothing may be said about a surface that matched");
  assert.doesNotMatch(msg, /also differ/i);
  // …and the node-only reassurance is still reached, exactly as before this change.
  assert.match(msg, /no missing work to redo/i);
});

test("an absent accounted list reproduces the pre-#1588 behaviour exactly", () => {
  // An older caller states nothing, and an unstated account is not an account.
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "QuadView_krea2_v1.json",
    contentComparable: true,
    contentSurfaces: ["nodes", "definitions"],
    contentNodeDifference: NODES_INTACT,
  });

  assert.match(msg, /partly applied/i);
  assert.doesNotMatch(msg, /no missing work to redo/i);
});

test("the verdict is untouched — this changes the sentence, not the answer", () => {
  // The content guard's error directions are not symmetric (too lenient applies writes
  // to the wrong graph), so nothing here softens it. `workflow_open` still throws.
  assert.equal(CONTENT_ONLY.status, OPEN_REBIND_STATUS.CONTENT_UNVERIFIED);
  assert.deepEqual(CONTENT_ONLY.unproven, ["content"]);
});

// ── the producer: does a REAL renumbered definitions block get accounted for? ─

/** A subgraph definition, with link ids that renumbering may reassign. */
function definitions(lastLinkId, linkIds) {
  return {
    subgraphs: [
      {
        id: "sub-1",
        name: "Upscale",
        state: { lastNodeId: 2, lastLinkId, lastGroupId: 0, lastRerouteId: 0 },
        nodes: [
          { id: 1, type: "LoadImage", outputs: [{ name: "IMAGE", type: "IMAGE", links: [linkIds[0]] }] },
          { id: 2, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: linkIds[0] }] },
        ],
        links: [[linkIds[0], 1, 0, 2, 0, "IMAGE"]],
        inputs: [],
        outputs: [],
      },
    ],
  };
}

const NODE = { id: 1, type: "KSampler", pos: [0, 0], size: [200, 100], widgets_values: [1] };

function stateWith(defs, node = NODE) {
  return { nodes: [structuredClone(node)], links: [], definitions: defs };
}

test("producer: a renumber-only definitions difference is reported as ACCOUNTED", () => {
  const state = stateWith(definitions(2092, [7]));
  const live = stateWith(definitions(2106, [21]));
  live.nodes[0].size = [200, 140]; // the frontend re-measured the box

  const diff = describeGraphStateDifference({ rootGraph: { serialize: () => live }, state });

  assert.equal(diff.comparable, true);
  assert.deepEqual(diff.surfaces.slice().sort(), ["definitions", "nodes"]);
  assert.deepEqual(diff.accountedSurfaces, ["definitions"]);
});

test("producer: a RE-WIRED definitions difference is NOT accounted for", () => {
  // The direction that must fail closed. Same link count, different endpoints — a
  // re-wire, not a renumber, and `definitionsDifferOnlyByRenumber` refuses it.
  const state = stateWith(definitions(2092, [7]));
  const live = stateWith(definitions(2106, [21]));
  live.definitions.subgraphs[0].links = [[21, 2, 0, 1, 0, "IMAGE"]];

  const diff = describeGraphStateDifference({ rootGraph: { serialize: () => live }, state });

  assert.ok(diff.surfaces.includes("definitions"));
  assert.deepEqual(diff.accountedSurfaces, []);
});

test("producer: a surface with no written account is never reported as accounted", () => {
  const state = stateWith(definitions(2092, [7]));
  const live = stateWith(definitions(2092, [7]));
  live.groups = [{ title: "G", bounding: [0, 0, 10, 10] }];

  const diff = describeGraphStateDifference({ rootGraph: { serialize: () => live }, state });

  assert.deepEqual(diff.surfaces, ["groups"]);
  assert.deepEqual(diff.accountedSurfaces, []);
});

// ── wiring: production must actually pass it ─────────────────────────────────

test("wiring: the panel hands the accounted list to the message it feeds", () => {
  // A green disclosure test proves the function behaves; it cannot prove the call site
  // supplies the field. Without this the whole change is inert and every test above
  // still passes.
  const src = readFileSync(PANEL_JS, "utf8");

  // Bounded by the ARGUMENT OBJECT of the one call, found by brace matching — never by
  // a character window, which silently stops covering the field the moment the object
  // grows a comment.
  const callAt = src.indexOf("describeOpenRebindOutcome(verdict, {");
  assert.notEqual(callAt, -1, "the disclosure call must still exist");
  const openAt = src.indexOf("{", callAt + "describeOpenRebindOutcome(verdict,".length);
  let depth = 0;
  let closeAt = -1;
  for (let i = openAt; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        closeAt = i;
        break;
      }
    }
  }
  assert.ok(closeAt > openAt, "the argument object must be brace-balanced");
  const args = src.slice(openAt, closeAt + 1);

  assert.match(args, /contentAccountedSurfaces:\s*contentDiff\.accountedSurfaces/);
  // It must come from the SAME diff object as the surfaces it filters. Two different
  // reads could disagree about what differed, and the filter would then subtract a
  // surface from a list that never contained it.
  assert.match(args, /contentSurfaces:\s*contentDiff\.surfaces/);

  // The `contentMatches` shortcut object must carry the field too — an object missing
  // it would reach the message as `undefined` on that branch alone.
  assert.match(src, /\{\s*comparable:\s*true,\s*surfaces:\s*\[\],\s*accountedSurfaces:\s*\[\],/);
});
