/**
 * #1623 — `panel_open_workflow` reported an ERROR on an open it had itself just
 * described as fine.
 *
 * WHAT THE REPORTER GOT. Two consecutive workflow switches, on a library containing
 * DOM/custom nodes (ComfySketch, MarkdownNote), each returning `isError: true` with a
 * message that says:
 *
 *   "workflow_open RAN, the canvas IS bound to X, and every node that was loaded is
 *    on it with the same id and type ... nothing extra appeared ... What differs is
 *    per-node (size, order) ... the content is reported UNCONFIRMED rather than
 *    failed ... You are on the right workflow and there is no missing work to redo."
 *
 * A reply cannot say "there is no missing work to redo" and fail. They took the
 * failure at face value and spent a `panel_graph_outline` recovery read on a graph
 * that was already correct.
 *
 * THE MECHANISM, and it is two lists that answer different questions:
 *
 *   RECOMPUTED_NODE_FIELDS  {size (height-only), inputs}   "is this difference
 *                                                           explained by a rewrite
 *                                                           this panel MEASURED?"
 *   COSMETIC_NODE_FIELDS    {size, pos, order,             "could anything AUTHORED
 *                            color, bgcolor}                have been lost?"
 *
 * The DISCLOSURE asks the second. The pass/fail asked the first. So `pos`, `order`,
 * `color`, `bgcolor` — and a `size` whose WIDTH moved, which is what a DOM widget's
 * box does — all failed the open while the sentence attached to the failure said
 * nothing was lost.
 *
 * THE FIX. One shared predicate, `openContentDifferenceIsPresentationOnly`, used by
 * BOTH. The open's pass/fail turns on the weaker question, because that is the one
 * the caller acts on.
 *
 * WHAT IS NOT WIDENED, and these are the tests that matter most here.
 * `widgets_values` stays outside both sets. `resolveOpenRebindVerdict` records why
 * content blocks success at all: `loadGraphData` catches a mid-`configure()` throw
 * and returns, leaving the node id/type set, the links and the marker over nodes
 * that LOST their widget values and properties — indistinguishable from
 * normalisation. That failure cannot present as presentation-only, because
 * `configure()` writes widgets_values, properties, title, flags and mode in the same
 * pass as the cosmetic five and every one of them is outside the cosmetic set.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  openContentDifferenceIsPresentationOnly,
  graphRootReproducesStateContent,
  describeOpenRebindOutcome,
  resolveOpenRebindVerdict,
  OPEN_REBIND_STATUS,
} from "../../web/js/lib/graph-binding.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const GRAPH_BINDING_JS = fileURLToPath(new URL("../../web/js/lib/graph-binding.js", import.meta.url));

const node = (id, type, extra = {}) => ({
  id,
  type,
  pos: [0, 0],
  size: [200, 100],
  order: 0,
  widgets_values: ["a"],
  ...extra,
});
/** A root whose serialize() returns a JSON round-trip of this state — what a file gives. */
const rootOf = (state) => ({ serialize: () => JSON.parse(JSON.stringify(state)) });
const stateOf = (nodes) => ({ nodes, links: [], groups: [], config: {}, extra: {} });

const cosmetic = (fields) => ({ comparable: true, sameNodeSet: true, cosmeticOnly: true, fields });

// ── the predicate ────────────────────────────────────────────────────────────

test("#1623 a nodes-only, same-set, cosmetic difference is presentation-only", () => {
  assert.equal(
    openContentDifferenceIsPresentationOnly({
      comparable: true,
      surfaces: ["nodes"],
      nodeDifference: cosmetic(["order", "size"]),
    }),
    true,
  );
});

test("#1623 a WIDGET VALUE difference is never presentation-only — #1111/#1089's guard is untouched", () => {
  // The load that dies mid-`configure()` drops exactly this, and it is
  // byte-identical to a frontend that normalized it. The open must keep failing.
  assert.equal(
    openContentDifferenceIsPresentationOnly({
      comparable: true,
      surfaces: ["nodes"],
      nodeDifference: { comparable: true, sameNodeSet: true, cosmeticOnly: false, fields: ["widgets_values"] },
    }),
    false,
  );
});

test("#1623 an UNKNOWN field is never presentation-only — the cosmetic set is a denylist", () => {
  // A pack the panel has never seen makes the answer cautious. Inverting that would
  // tell a caller "nothing was lost" about a surface nobody has characterised.
  assert.equal(
    openContentDifferenceIsPresentationOnly({
      comparable: true,
      surfaces: ["nodes"],
      nodeDifference: { comparable: true, sameNodeSet: true, cosmeticOnly: false, fields: ["showAdvanced"] },
    }),
    false,
  );
});

test("#1623 a changed node SET is never presentation-only", () => {
  assert.equal(
    openContentDifferenceIsPresentationOnly({
      comparable: true,
      surfaces: ["nodes"],
      nodeDifference: { comparable: true, sameNodeSet: false, cosmeticOnly: false, fields: [] },
    }),
    false,
  );
});

test("#1623 sameNodeSet is checked SEPARATELY, not inferred from cosmeticOnly", () => {
  // Mutation-driven. `classifyNodeDifference` only computes `fields` once the sets
  // match, so its own `cosmeticOnly:true` already implies `sameNodeSet:true` and
  // deleting the set check changes nothing it produces — the mutation SURVIVED until
  // this test existed. But the predicate is EXPORTED and takes a caller-supplied
  // shape, and the two questions ("is this the same graph" / "can the panel name what
  // moved") are answered by different classifiers that a later change may separate.
  // An inconsistent shape must refuse rather than let a set difference through on the
  // strength of a field list.
  assert.equal(
    openContentDifferenceIsPresentationOnly({
      comparable: true,
      surfaces: ["nodes"],
      nodeDifference: { comparable: true, sameNodeSet: false, cosmeticOnly: true, fields: ["size"] },
    }),
    false,
    "a named cosmetic field cannot vouch for a node set that differs",
  );
});

test("#1623 a SECOND differing surface is never presentation-only", () => {
  // #825's own rule, kept: a group, a link, a reroute or a definitions difference is
  // unexplained by anything a node comparison establishes.
  for (const surfaces of [
    ["nodes", "groups"],
    ["nodes", "links"],
    ["nodes", "definitions"],
    ["groups"],
    [],
  ]) {
    assert.equal(
      openContentDifferenceIsPresentationOnly({ comparable: true, surfaces, nodeDifference: cosmetic(["size"]) }),
      false,
      `surfaces ${JSON.stringify(surfaces)} must not license the claim`,
    );
  }
});

test("#1623 an absent comparison asserts nothing in EITHER direction", () => {
  for (const observed of [
    undefined,
    {},
    { comparable: false, surfaces: ["nodes"], nodeDifference: cosmetic(["size"]) },
    { comparable: "true", surfaces: ["nodes"], nodeDifference: cosmetic(["size"]) },
    { comparable: true, surfaces: ["nodes"], nodeDifference: null },
    { comparable: true, surfaces: ["nodes"], nodeDifference: { comparable: false, sameNodeSet: true, cosmeticOnly: true, fields: ["size"] } },
  ]) {
    assert.equal(openContentDifferenceIsPresentationOnly(observed), false);
  }
});

// ── the open's own verdict, off a real serialized graph ──────────────────────

test("#1623 THE REPORT: a re-measured DOM node box no longer fails the open", () => {
  // The reporter's own shape. `size` changed in BOTH dimensions, which is what a DOM
  // widget's box does and what `sizeDifferenceIsHeightOnly` (rightly) refuses to call
  // a measured rewrite — so the STRICT proof still says no...
  const state = stateOf([node(1, "ComfySketch", { size: [400, 300] })]);
  const live = stateOf([node(1, "ComfySketch", { size: [512, 384] })]);
  const proof = graphRootReproducesStateContent({ rootGraph: rootOf(live), state });
  assert.equal(proof.proven, false, "a width change is still not a characterised rewrite");
  // ...and the weaker ground carries it, with the differing field NAMED.
  assert.equal(proof.presentationOnly, true);
  assert.deepEqual(proof.fields, ["size"]);
});

test("#1623 a changed `order` or `pos` no longer fails the open", () => {
  for (const [field, before, after] of [
    ["order", 0, 3],
    ["pos", [0, 0], [120, 40]],
    ["color", "#111", "#222"],
  ]) {
    const state = stateOf([node(1, "KSampler", { [field]: before })]);
    const live = stateOf([node(1, "KSampler", { [field]: after })]);
    const proof = graphRootReproducesStateContent({ rootGraph: rootOf(live), state });
    assert.equal(proof.proven, false, `${field} is deliberately NOT a measured rewrite`);
    assert.equal(proof.presentationOnly, true, `${field} cannot mean authored content was lost`);
    assert.deepEqual(proof.fields, [field], "the reply must be able to name what moved");
  }
});

test("#1623 a WIDGET VALUE difference still fails the open, on both grounds", () => {
  const state = stateOf([node(1, "KSampler", { widgets_values: ["a", 42] })]);
  const live = stateOf([node(1, "KSampler", { widgets_values: ["a", 7] })]);
  const proof = graphRootReproducesStateContent({ rootGraph: rootOf(live), state });
  assert.equal(proof.proven, false);
  assert.equal(proof.presentationOnly, false, "this is the exact difference a partial load leaves");
  assert.deepEqual(proof.fields, [], "an unaccounted difference must not be named as presentation");
});

test("#1623 a cosmetic difference ALONGSIDE a lost widget value still fails", () => {
  // The mixed case is where a name-only allowlist would leak: the size moved AND a
  // value went. Nothing may vouch for the second on the strength of the first.
  const state = stateOf([node(1, "KSampler", { size: [200, 100], widgets_values: ["a", 42] })]);
  const live = stateOf([node(1, "KSampler", { size: [200, 60], widgets_values: ["a"] })]);
  const proof = graphRootReproducesStateContent({ rootGraph: rootOf(live), state });
  assert.equal(proof.proven, false);
  assert.equal(proof.presentationOnly, false);
});

test("#1623 a MISSING node still fails the open", () => {
  const state = stateOf([node(1, "KSampler"), node(2, "VAEDecode")]);
  const live = stateOf([node(1, "KSampler")]);
  const proof = graphRootReproducesStateContent({ rootGraph: rootOf(live), state });
  assert.equal(proof.proven, false);
  assert.equal(proof.presentationOnly, false);
});

test("#1623 a cosmetic node difference PLUS a lost group still fails", () => {
  const state = { ...stateOf([node(1, "KSampler", { size: [200, 100] })]), groups: [{ title: "g" }] };
  const live = { ...stateOf([node(1, "KSampler", { size: [200, 60] })]), groups: [] };
  const proof = graphRootReproducesStateContent({ rootGraph: rootOf(live), state });
  assert.equal(proof.proven, false);
  assert.equal(proof.presentationOnly, false, "geometry cannot vouch for a surface it does not describe");
});

test("#1623 the strict #1001 proof still wins where it applies, and does not claim the weaker ground", () => {
  // A height-only size change is a CHARACTERISED rewrite: it stays `proven`, so the
  // reply keeps `geometry_rewritten` and its stronger note. Both flags being true
  // would let the two disclosures ship together and contradict each other.
  const state = stateOf([node(1, "SaveVideo", { size: [300, 358] })]);
  const live = stateOf([node(1, "SaveVideo", { size: [300, 126] })]);
  const proof = graphRootReproducesStateContent({ rootGraph: rootOf(live), state });
  assert.equal(proof.proven, true);
  assert.equal(proof.exact, false);
  assert.deepEqual(proof.fields, ["size"]);
  assert.equal(proof.presentationOnly, false);
});

// ── the message and the verdict must ask the SAME question ───────────────────

test("#1623 the disclosure's reassurance is the SAME predicate the verdict uses", () => {
  // The defect was two spellings of one question drifting apart. `describeOpenRebindOutcome`
  // is pure and still reachable if a live canvas moves between the verdict and the
  // message, so the sentence stays — but it may not be computed independently.
  const src = readFileSync(GRAPH_BINDING_JS, "utf8");
  const at = src.indexOf("export function describeOpenRebindOutcome");
  assert.notEqual(at, -1);
  const body = src.slice(at, src.indexOf("\nexport ", at + 1));
  assert.match(
    body,
    /const valuesMatched = openContentDifferenceIsPresentationOnly\(\{/,
    "the sentence must not re-derive `cosmeticOnly` on its own",
  );
  // No independent READ of the field — the prose may still name it. A second reading
  // of the same field is how the two answers drifted apart in the first place.
  assert.doesNotMatch(body, /\.cosmeticOnly/, "the sentence must not read the classification itself");
  assert.doesNotMatch(body, /COSMETIC_NODE_FIELDS/, "nor re-apply the set behind it");
  // ...and the verdict path reads it too, off the SAME frozen snapshot the strict
  // proof reads. A second serialization would reopen the hole the snapshot closes.
  const proofAt = src.indexOf("export function graphRootReproducesStateContent");
  const proofBody = src.slice(proofAt, src.indexOf("\n/**", proofAt + 1));
  assert.match(proofBody, /const frozen = \{ serialize: \(\) => actualState \};/);
  assert.match(proofBody, /openContentDifferenceIsPresentationOnly\(\{/);
  assert.doesNotMatch(
    proofBody.slice(proofBody.indexOf("const frozen")),
    /rootGraph\?\.serialize/,
    "one snapshot, and both questions read it",
  );
});

test("#1623 the reassurance sentence itself is unchanged for what still fails", () => {
  const CONTENT_ONLY = resolveOpenRebindVerdict({
    instanceStillTarget: true,
    markerMatches: true,
    identityMatches: true,
    contentMatches: false,
  });
  assert.equal(CONTENT_ONLY.status, OPEN_REBIND_STATUS.CONTENT_UNVERIFIED);
  const msg = describeOpenRebindOutcome(CONTENT_ONLY, {
    targetLabel: "origami.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
    contentNodeDifference: { comparable: true, sameNodeSet: true, cosmeticOnly: false, fields: ["widgets_values"] },
  });
  assert.match(msg, /no node was lost/i);
  assert.doesNotMatch(msg, /no missing work to redo/i, "a widget value that moved gets no all-clear");
});

// ── wiring: the panel must actually take its answer from this ────────────────

test("#1623 wiring: the open's pass/fail reads BOTH grounds, and the disclosures stay separate", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // panel#1283 family added a THIRD ground to the same expression, so the pin is on the
  // two disjuncts #1623 is about rather than on the whole line — deleting
  // `|| contentProof.presentationOnly` still restores the reported false error, and this
  // assertion is still what notices. Deleting the whole line breaks the handler.
  assert.match(src, /const contentMatches =\s*contentProof\.proven \|\| contentProof\.presentationOnly/);
  // Two keys, two notes. The weaker ground must not borrow `geometry_rewritten`'s
  // note, which asserts every difference is a height with the width unchanged —
  // false of the very case this fix admits.
  const presentationAt = src.indexOf("presentation_rewritten:");
  const geometryAt = src.indexOf("geometry_rewritten:");
  assert.notEqual(presentationAt, -1, "the caller must be told which fields moved");
  assert.notEqual(geometryAt, -1);
  assert.notEqual(presentationAt, geometryAt);
  assert.match(src, /presentation_rewritten_note:/);
  // The note may not repeat the height-only claim.
  const noteAt = src.indexOf("presentation_rewritten_note:");
  const note = src.slice(noteAt, src.indexOf("}", src.indexOf("`,", noteAt)));
  assert.doesNotMatch(note, /width unchanged/i, "no height-only claim was established here");
  assert.match(note, /#1623/);
  // And the variable is only ever assigned from the presentation-only ground.
  // Every assignment, not just the one we wrote — pinning a single known statement
  // leaves the file free to grow a second one that sets it from somewhere else. The
  // `let` initializer is excluded by the lookbehind, not by position.
  const assignments = [...src.matchAll(/(?<!let )openPresentationRewritten = ([^;\n]+);/g)].map((m) => m[1]);
  assert.deepEqual(assignments, ["contentProof.fields"]);
  const guardAt = src.indexOf("if (contentProof.presentationOnly) {");
  assert.notEqual(guardAt, -1);
  assert.ok(
    guardAt < src.indexOf("openPresentationRewritten = contentProof.fields;"),
    "it must be gated on the ground that earned it",
  );
});
