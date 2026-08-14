// comfyui-mcp#1467 — three reporters hit CONTENT_UNVERIFIED on a faithful open
// because per-node `inputs` differed from the saved payload.
//
// MEASURED, comfyui_frontend_package 1.48.7, ComfyNode.prototype.configure (runs
// BEFORE LiteGraph's): the live array is GENERATED from the node definition —
// definition order, `name`/`type`/`shape`/`localized_name`/`widget` overlaid from
// the definition, saved-but-unknown slots appended. A faithful open cannot
// reproduce the saved array.
//
// The check admits exactly that rewrite. Everything else must still refuse: the
// guard exists for #1111/#1089, where nodes really were lost.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inputsDifferOnlyByDefinitionRebuild,
  nodeInputsDifferOnlyByDefinitionRebuild,
} from "../../web/js/lib/node-inputs-rebuild.js";
import { graphRootReproducesStateContent } from "../../web/js/lib/graph-binding.js";

const slot = (name, extra = {}) => ({ name, type: "IMAGE", link: null, ...extra });

test("identical inputs are trivially explained", () => {
  const a = [slot("image"), slot("mask")];
  assert.equal(inputsDifferOnlyByDefinitionRebuild(a, structuredClone(a)), true);
});

test("REORDERING alone is explained — the live order is the definition's", () => {
  // The reported shape: same slots, definition order rather than file order.
  const saved = [slot("mask"), slot("image")];
  const live = [slot("image"), slot("mask")];
  assert.equal(inputsDifferOnlyByDefinitionRebuild(saved, live), true);
});

test("a presentation key changing is explained", () => {
  // `shape`, `localized_name` and `widget` are taken from the definition on every
  // load and carry no connection semantics, so the file's values cannot indicate
  // loss.
  const saved = [slot("image", { shape: 7, localized_name: "Image" })];
  const live = [slot("image", { shape: 3, localized_name: "Bild" })];
  assert.equal(inputsDifferOnlyByDefinitionRebuild(saved, live), true);
});

test("a changed slot TYPE is NOT explained — definition drift is not proof", () => {
  // The frontend overlays `type` from the definition, so a difference IS
  // mechanically explained by the rebuild — and admitting it anyway was a
  // false PROVEN (review). "Explained" is not the question; "does the live graph
  // reproduce the SAVED content" is, and IMAGE→MASK is a different connection
  // contract that a later agent write could land on wrongly. An earlier version
  // of this very test asserted the opposite.
  const saved = [slot("image", { type: "IMAGE" })];
  const live = [slot("image", { type: "MASK" })];
  assert.equal(inputsDifferOnlyByDefinitionRebuild(saved, live), false);
});

test("null, undefined, ABSENT and NaN are all distinguished", () => {
  // JSON.stringify(x ?? null) made every one of these identical — including NaN,
  // which stringifies to "null" — in a function whose whole job is refusing
  // unexplained differences (review). Each pair must refuse.
  const pairs = [
    [slot("a", { dir: null }), slot("a", { dir: undefined })],
    [slot("a", { dir: null }), slot("a")],
    [slot("a", { dir: undefined }), slot("a")],
    [slot("a", { dir: null }), slot("a", { dir: NaN })],
    [slot("a", { dir: 0 }), slot("a", { dir: -0 })],
    [slot("a", { dir: { x: null } }), slot("a", { dir: { x: NaN } })],
  ];
  for (const [before, after] of pairs) {
    assert.equal(
      inputsDifferOnlyByDefinitionRebuild([before], [after]),
      false,
      `${JSON.stringify(before)} vs ${JSON.stringify(after)}`,
    );
  }
});

test("key ORDER inside a structural value is not a difference", () => {
  const saved = [slot("a", { meta: { x: 1, y: 2 } })];
  const live = [slot("a", { meta: { y: 2, x: 1 } })];
  assert.equal(inputsDifferOnlyByDefinitionRebuild(saved, live), true);
});

test("a `widget` appearing is explained — the frontend adds it from the definition", () => {
  const saved = [slot("seed")];
  const live = [slot("seed", { widget: { name: "seed" } })];
  assert.equal(inputsDifferOnlyByDefinitionRebuild(saved, live), true);
});

test("a changed LINK is NOT explained — the rebuild preserves it", () => {
  // `{...savedEntry, ...pick(definition)}` overlays only the five listed keys, so
  // `link` survives untouched. A different link is a real topology difference and
  // is exactly what must keep refusing.
  const saved = [slot("image", { link: 12 })];
  const live = [slot("image", { link: 99 })];
  assert.equal(inputsDifferOnlyByDefinitionRebuild(saved, live), false);
});

test("a slot DISAPPEARING is not explained", () => {
  assert.equal(
    inputsDifferOnlyByDefinitionRebuild([slot("image"), slot("mask")], [slot("image")]),
    false,
  );
});

test("a slot APPEARING is not explained", () => {
  assert.equal(
    inputsDifferOnlyByDefinitionRebuild([slot("image")], [slot("image"), slot("mask")]),
    false,
  );
});

test("an unrelated key moving is not explained", () => {
  const saved = [slot("image", { pos: [0, 0] })];
  const live = [slot("image", { pos: [10, 4] })];
  assert.equal(inputsDifferOnlyByDefinitionRebuild(saved, live), false);
});

test("a key PRESENT on one side only is caught, not skipped", () => {
  // Presence before value: an absent key must not compare equal to an explicit
  // null, or a slot that lost something drops out of the comparison entirely —
  // the failure classifyNodeDifference already had to learn once.
  assert.equal(
    inputsDifferOnlyByDefinitionRebuild([slot("image")], [slot("image", { dir: 3 })]),
    false,
  );
});

test("unreadable input arrays prove NOTHING (false, not true)", () => {
  assert.equal(inputsDifferOnlyByDefinitionRebuild(null, [slot("a")]), false);
  assert.equal(inputsDifferOnlyByDefinitionRebuild([slot("a")], undefined), false);
  assert.equal(inputsDifferOnlyByDefinitionRebuild([null], [slot("a")]), false);
  assert.equal(inputsDifferOnlyByDefinitionRebuild([{ type: "X" }], [slot("a")]), false);
});

test("both sides absent is not a difference", () => {
  assert.equal(inputsDifferOnlyByDefinitionRebuild(undefined, undefined), true);
});

test("DUPLICATE slot names refuse — pairing them would be a guess", () => {
  const dupes = [slot("image"), slot("image")];
  assert.equal(inputsDifferOnlyByDefinitionRebuild(dupes, structuredClone(dupes)), false);
});

// ── whole-graph form ────────────────────────────────────────────────────────

const node = (id, inputs) => ({ id, type: "KSampler", inputs });

test("every node's inputs must be explained, not just one", () => {
  const saved = [node(1, [slot("a")]), node(2, [slot("b", { link: 5 })])];
  const live = [node(1, [slot("a")]), node(2, [slot("b", { link: 6 })])];
  assert.equal(nodeInputsDifferOnlyByDefinitionRebuild(saved, live), false);
});

test("a graph where every node is only reordered IS explained", () => {
  const saved = [node(1, [slot("b"), slot("a")]), node(2, [slot("d"), slot("c")])];
  const live = [node(1, [slot("a"), slot("b")]), node(2, [slot("c"), slot("d")])];
  assert.equal(nodeInputsDifferOnlyByDefinitionRebuild(saved, live), true);
});

test("a node whose id/type moved is not paired and refuses", () => {
  assert.equal(
    nodeInputsDifferOnlyByDefinitionRebuild([node(1, [slot("a")])], [
      { id: 1, type: "OtherNode", inputs: [slot("a")] },
    ]),
    false,
  );
});

test("unreadable node lists prove NOTHING", () => {
  assert.equal(nodeInputsDifferOnlyByDefinitionRebuild(null, []), false);
  assert.equal(nodeInputsDifferOnlyByDefinitionRebuild([null], [node(1, [])]), false);
});

test("a THROWING slot proves nothing — the catch must answer false", () => {
  // Mutation found this: every other "unreadable" case is stopped by an explicit
  // guard before the try, so the catch block itself was never exercised and
  // flipping it to `return true` changed nothing observable. A getter that throws
  // is the shape that actually reaches it.
  // The slot must otherwise MATCH, or an earlier check answers first and the
  // catch is never reached — which is what happened in the first version of this
  // test: `type` was present on one side only, so presence-differs returned false
  // before anything read the getter, and mutating the catch changed nothing.
  const hostile = { name: "image", type: "IMAGE" };
  Object.defineProperty(hostile, "link", {
    enumerable: true,
    get() {
      throw new Error("hostile getter");
    },
  });
  assert.equal(inputsDifferOnlyByDefinitionRebuild([slot("image")], [hostile]), false);
  assert.equal(
    nodeInputsDifferOnlyByDefinitionRebuild([node(1, [slot("image")])], [node(1, [hostile])]),
    false,
  );
});

// ── WIRING: the check must actually gate the verdict ────────────────────────
//
// Mutation found that deleting the gate from graph-binding left every test above
// green — they exercise the pure function, which cannot see whether anything
// calls it. These drive the real `graphRootReproducesStateContent`.

const graphOf = (nodes) => ({ serialize: () => ({ nodes }) });

test("WIRING: a reorder-only inputs difference is now PROVEN through the real gate", () => {
  const saved = { nodes: [node(1, [slot("mask"), slot("image")])] };
  const live = graphOf([node(1, [slot("image"), slot("mask")])]);
  const verdict = graphRootReproducesStateContent({ rootGraph: live, state: saved });
  assert.equal(verdict.proven, true, "the reporters' case must stop refusing");
  assert.equal(verdict.exact, false, "…but it is not byte-identical, and must not claim to be");
  assert.deepEqual(verdict.fields, ["inputs"]);
});

test("WIRING: a changed LINK still refuses through the real gate", () => {
  const saved = { nodes: [node(1, [slot("image", { link: 12 })])] };
  const live = graphOf([node(1, [slot("image", { link: 99 })])]);
  assert.equal(graphRootReproducesStateContent({ rootGraph: live, state: saved }).proven, false);
});

test("WIRING: a LOST slot still refuses through the real gate", () => {
  const saved = { nodes: [node(1, [slot("image"), slot("mask")])] };
  const live = graphOf([node(1, [slot("image")])]);
  assert.equal(graphRootReproducesStateContent({ rootGraph: live, state: saved }).proven, false);
});

test("EXOTIC values fail closed rather than compare equal", () => {
  // Date/Map/Set have no enumerable own string keys, so a naive key-walk encodes
  // every one of them as `{}` — making two different Dates, or two differently
  // populated Maps, compare EQUAL and be admitted as rebuild-only (review r2).
  const pairs = [
    [new Date(0), new Date(1)],
    [new Map([["a", 1]]), new Map([["b", 2]])],
    [new Set([1]), new Set([2])],
  ];
  for (const [a, b] of pairs) {
    assert.equal(
      inputsDifferOnlyByDefinitionRebuild([slot("x", { v: a })], [slot("x", { v: b })]),
      false,
      String(a),
    );
  }
});

test("a HOLE in an array is not a value", () => {
  // `.map` skips holes and `.join` renders them empty, so a sparse array could
  // encode identically to a shorter one or to empty strings.
  const sparse = [];
  sparse.length = 2;
  assert.equal(
    inputsDifferOnlyByDefinitionRebuild([slot("x", { v: sparse })], [slot("x", { v: ["", ""] })]),
    false,
  );
  assert.equal(
    inputsDifferOnlyByDefinitionRebuild([slot("x", { v: sparse })], [slot("x", { v: [] })]),
    false,
  );
  // THE discriminating case: a hole is not an explicit undefined. Encoding a
  // hole by reading value[i] yields undefined for both, so these two collide and
  // an array that LOST an entry reads as unchanged. The pairs above refuse
  // either way, which is why mutation caught this and they did not.
  assert.equal(
    inputsDifferOnlyByDefinitionRebuild([slot("x", { v: sparse })], [slot("x", { v: [undefined, undefined] })]),
    false,
  );
});
