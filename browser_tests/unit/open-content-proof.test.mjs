/**
 * #1001 — `workflow_open`'s content proof was a byte-shape equality over the whole
 * serialized node array, so the geometry the ComfyUI frontend measures for itself made
 * a perfect load report CONTENT_UNVERIFIED. That verdict THROWS, and a throwing open
 * never publishes `workflow_uuid` — so the caller's fence stayed stale and the next
 * command was refused as a workflow instance mismatch.
 *
 * MEASURED on ComfyUI 0.31.1 / frontend 1.48.7, opening a saved workflow from the
 * user's own library (`MiniMax_H3_00173_.json`, 10 nodes):
 *
 *   surfaces               ["nodes"]
 *   sameNodeSet            true
 *   fields                 ["showAdvanced", "size"]   <- SaveVideo 358 high -> 126
 *   graphRootMatchesState  false
 *
 * Sampled at 0ms, one animation frame, 50ms, 250ms, 1s and 2s after the load resolved:
 * IDENTICAL every time. It is not a race with the frontend's normalisation — it is
 * deterministic, and it applies to any workflow whose stored sizes are not what this
 * frontend computes.
 *
 * `showAdvanced` is the second half: the frontend puts the key on every node it
 * instantiates with the value `undefined`. No saved file can carry that — JSON.stringify
 * drops it — so comparing a live serialize() against a parsed file reported a difference
 * in a form that cannot exist on disk.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyNodeDifference,
  graphRootReproducesStateContent,
  graphRootMatchesState,
} from "../../web/js/lib/graph-binding.js";

const node = (id, type, extra = {}) => ({ id, type, pos: [0, 0], size: [200, 100], widgets_values: ["a"], ...extra });
/** A root whose serialize() returns a JSON round-trip of this state — what a file gives. */
const rootOf = (state) => ({ serialize: () => JSON.parse(JSON.stringify(state)) });
/** …and one that preserves `undefined`-valued keys, which is what the LIVE graph emits. */
const liveRootOf = (state) => ({ serialize: () => state });
const stateOf = (nodes) => ({ nodes, links: [], groups: [], config: {}, extra: {} });

test("#1001 a key present with `undefined` is NOT a difference from an absent key", () => {
  // The frontend stamps `showAdvanced: undefined` on every node it instantiates.
  const file = [node(1, "KSampler")];
  const live = [{ ...node(1, "KSampler"), showAdvanced: undefined }];
  const d = classifyNodeDifference({ expectedNodes: file, actualNodes: live });
  assert.equal(d.comparable, true);
  assert.equal(d.sameNodeSet, true);
  assert.deepEqual(d.fields, [], "a value JSON cannot carry cannot be a difference from a file");
});

test("#1001 `null` is STILL a difference from absent — only `undefined` is absent", () => {
  // JSON carries null, so present-as-null and absent are genuinely different states of
  // a saved file. Collapsing them would erase a node that LOST its widgets_values.
  const file = [node(1, "KSampler")];
  const live = [{ ...node(1, "KSampler"), widgets_values: null }];
  const d = classifyNodeDifference({ expectedNodes: file, actualNodes: live });
  assert.deepEqual(d.fields, ["widgets_values"], "a nulled value must still register");
  assert.equal(d.cosmeticOnly, false);
  // ABSENT vs NULL, the state a saved file really can be in. This asserts the BEHAVIOUR
  // and not the spelling: the value comparison flags this pair under a looser `!= null`
  // presence test too (verified by mutation — the swap changes no result). What must
  // never happen is a nulled field going unreported, and that is what is pinned here.
  const withoutKey = [{ id: 1, type: "KSampler", pos: [0, 0] }];
  const withNull = [{ id: 1, type: "KSampler", pos: [0, 0], widgets_values: null }];
  assert.deepEqual(
    classifyNodeDifference({ expectedNodes: withoutKey, actualNodes: withNull }).fields,
    ["widgets_values"],
    "absent and null are different states of a saved file",
  );
});

test("#1001 the measured case: recomputed geometry proves content, and says it was not exact", () => {
  const file = [node(1, "SaveVideo", { size: [1030, 358] }), node(2, "LoadImage", { size: [225, 0] })];
  const live = [
    { ...node(1, "SaveVideo", { size: [1030, 126] }), showAdvanced: undefined },
    { ...node(2, "LoadImage", { size: [225, 22] }), showAdvanced: undefined },
  ];
  const state = stateOf(file);
  const root = liveRootOf(stateOf(live));
  const proof = graphRootReproducesStateContent({ rootGraph: root, state });
  assert.equal(proof.proven, true, "the content IS reproduced");
  assert.equal(proof.exact, false, "…but not byte-identically, and the caller is told so");
  assert.deepEqual(proof.fields, ["size"]);
  assert.equal(
    graphRootMatchesState({ rootGraph: root, state }),
    false,
    "the old proof rejected this exact load — which is the bug",
  );
});

test("#1001 a byte-identical repaint is still reported as exact", () => {
  const state = stateOf([node(1, "KSampler")]);
  assert.deepEqual(graphRootReproducesStateContent({ rootGraph: rootOf(state), state }), {
    proven: true,
    exact: true,
    fields: [],
    // #1623 — a graph that matched has no difference to classify, so the weaker
    // "nothing authored was lost" ground is not what carried it.
    presentationOnly: false,
    // panel#1283 family — nor the THIRD ground. A byte-identical repaint needs no
    // observation about whether the restore completed, and claiming one it did not
    // consult would misattribute the proof.
    normalizedOnly: false,
    normalizedFields: [],
  });
});

test("#1001 a WIDGET VALUE difference is never proven — that is real content", () => {
  const state = stateOf([node(1, "KSampler")]);
  const live = stateOf([{ ...node(1, "KSampler"), widgets_values: ["CHANGED"] }]);
  assert.equal(graphRootReproducesStateContent({ rootGraph: rootOf(live), state }).proven, false);
});

test("#1001 (codex r2) a changed WIDTH is never proven — the measurement was a height", () => {
  // A field-name allowlist admits any rewrite of the whole `[w, h]` pair, so a changed
  // width would have ridden in on evidence about something else.
  const state = stateOf([node(1, "KSampler", { size: [200, 100] })]);
  const heightOnly = stateOf([node(1, "KSampler", { size: [200, 60] })]);
  const widthToo = stateOf([node(1, "KSampler", { size: [340, 60] })]);
  const widthOnly = stateOf([node(1, "KSampler", { size: [340, 100] })]);
  assert.equal(graphRootReproducesStateContent({ rootGraph: rootOf(heightOnly), state }).proven, true);
  assert.equal(graphRootReproducesStateContent({ rootGraph: rootOf(widthToo), state }).proven, false, "width moved too");
  assert.equal(graphRootReproducesStateContent({ rootGraph: rootOf(widthOnly), state }).proven, false, "width alone");
});

test("#1001 (codex r3) every check reads ONE snapshot — a shifting serializer cannot slip content past", () => {
  // A synchronous serialization hook (a broken or hostile custom node) can return a
  // different graph each call. Serializing per check let it show a height-only
  // difference to the classifier and then alter a widget before the size check
  // re-serialized, publishing a fence for content no comparison ever saw.
  const state = stateOf([node(1, "KSampler", { size: [200, 100] })]);
  let call = 0;
  const shifting = {
    serialize: () => {
      call += 1;
      // First call: an innocent height change. Every call after: a changed widget value.
      return call === 1
        ? stateOf([node(1, "KSampler", { size: [200, 60] })])
        : stateOf([node(1, "KSampler", { size: [200, 60], widgets_values: ["SMUGGLED"] })]);
    },
  };
  const proof = graphRootReproducesStateContent({ rootGraph: shifting, state });
  assert.equal(call, 1, "the root is serialized exactly once");
  assert.equal(proof.proven, true, "…and the ONE snapshot it saw is the one it judged");

  // The reverse order proves the same rule from the other side: if the first snapshot
  // carries the smuggled value, the proof refuses however clean later calls look.
  let n = 0;
  const smuggledFirst = {
    serialize: () => {
      n += 1;
      return n === 1
        ? stateOf([node(1, "KSampler", { size: [200, 60], widgets_values: ["SMUGGLED"] })])
        : stateOf([node(1, "KSampler", { size: [200, 60] })]);
    },
  };
  assert.equal(graphRootReproducesStateContent({ rootGraph: smuggledFirst, state }).proven, false);
  assert.equal(n, 1, "still exactly one");
});

test("#1001 (codex r2) an UNREADABLE size is never proven", () => {
  // A proof cannot rest on a value nobody could read, so a non-pair or a non-finite
  // number refuses rather than being treated as a height change.
  const state = stateOf([node(1, "KSampler", { size: [200, 100] })]);
  for (const size of [null, [200], [200, 100, 5], ["a", "b"], [200, NaN], "200x100", {}]) {
    const live = stateOf([node(1, "KSampler", { size })]);
    assert.equal(
      graphRootReproducesStateContent({ rootGraph: rootOf(live), state }).proven,
      false,
      `size ${JSON.stringify(size)}`,
    );
  }
});

test("#1001 (codex) `pos` and `order` hold the proof back — only `size` was measured", () => {
  // An earlier cut listed both as "layout too". Neither was ever observed being
  // rewritten, `pos` is authored by dragging a node, and `order` is execution-order
  // state — proving content across a changed `order` would publish a fence for a graph
  // whose observable behaviour changed. The set grows only when a measurement says so.
  for (const field of ["pos", "order"]) {
    const state = stateOf([node(1, "KSampler", { [field]: field === "pos" ? [0, 0] : 1 })]);
    const live = stateOf([node(1, "KSampler", { [field]: field === "pos" ? [500, 500] : 7 })]);
    assert.equal(
      graphRootReproducesStateContent({ rootGraph: rootOf(live), state }).proven,
      false,
      `${field} must not prove content`,
    );
  }
});

test("#1001 `color`/`bgcolor` hold the proof back, though they ARE cosmetic to look at", () => {
  // They are in COSMETIC_NODE_FIELDS, which licenses a reassuring SENTENCE. They are
  // NOT in the recomputed set, because a lost color is a lost authored value and the
  // frontend does not compute one for itself.
  const state = stateOf([node(1, "KSampler", { color: "#353535" })]);
  const live = stateOf([node(1, "KSampler")]);
  assert.equal(graphRootReproducesStateContent({ rootGraph: rootOf(live), state }).proven, false);
});

test("#1001 a LOST node, an EXTRA node, or a retype is never proven", () => {
  const state = stateOf([node(1, "KSampler"), node(2, "LoadImage")]);
  for (const live of [
    stateOf([node(1, "KSampler")]),
    stateOf([node(1, "KSampler"), node(2, "LoadImage"), node(3, "SaveImage")]),
    stateOf([node(1, "KSampler"), node(2, "SaveImage")]),
  ]) {
    assert.equal(graphRootReproducesStateContent({ rootGraph: rootOf(live), state }).proven, false);
  }
});

test("#1001 a SECOND differing surface is never proven, however tidy the nodes are", () => {
  // A group or a link that disagrees is unexplained by anything the node comparison
  // establishes, so geometry cannot vouch for it.
  const state = { ...stateOf([node(1, "KSampler", { size: [200, 100] })]), groups: [{ title: "g" }] };
  const live = { ...stateOf([node(1, "KSampler", { size: [200, 60] })]), groups: [] };
  assert.equal(graphRootReproducesStateContent({ rootGraph: rootOf(live), state }).proven, false);
});

test("#1001 an unreadable root proves nothing — absence of comparison is not evidence", () => {
  const state = stateOf([node(1, "KSampler")]);
  for (const bad of [
    null,
    undefined,
    {},
    {
      serialize: () => {
        throw new Error("boom");
      },
    },
    { serialize: () => null },
  ]) {
    assert.deepEqual(graphRootReproducesStateContent({ rootGraph: bad, state }), {
      proven: false,
      exact: false,
      fields: [],
      // #1623 — and it must not answer the WEAKER question either. A root nobody
      // could read supports "nothing authored was lost" exactly as little as it
      // supports "the content was reproduced".
      presentationOnly: false,
      // panel#1283 family — and not the third one. `loadRanToCompletion` was not even
      // passed here, so the only honest answer is false; a ground that could pass on an
      // unreadable root would prove an open off a comparison that never happened.
      normalizedOnly: false,
      normalizedFields: [],
    });
  }
  assert.equal(graphRootReproducesStateContent({ rootGraph: rootOf(state), state: null }).proven, false);
  assert.equal(graphRootReproducesStateContent().proven, false);
});

test("#1001 source guard: the open publishes the fence and DISCLOSES rewritten geometry", () => {
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  // The call site now spans several lines (it passes `loadRanToCompletion` too), so the
  // pin is on the CALL and its two payload arguments rather than on one formatted line —
  // still a call-site assertion, and still fails if the open stops asking for the proof.
  assert.match(src, /const contentProof = graphRootReproducesStateContent\(\{[\s\S]{0,600}?state: repaintState,/);
  assert.match(src, /openGeometryRewritten = contentProof\.fields/, "a non-exact proof is recorded");
  assert.match(src, /geometry_rewritten: openGeometryRewritten/, "and reaches the reply");
  assert.match(src, /geometry_rewritten_note:/, "with prose, since a bare field list is not a disclosure");
});
