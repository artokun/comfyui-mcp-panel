// workflow_open's post-repaint rebind proof — #604 (item 3), #603 (item 4),
// #616 (recovery path), #374 (reopen), #641 (the mirror report).
//
// The field symptom: `panel_open_workflow` answered "could not prove that the
// active canvas was rebound to the requested workflow" on EVERY call, surfacing
// as `applied:"unknown"`, which also disabled the recovery every one of those
// issues points at ("re-open the tab to rebind the graph").
//
// The standing hypothesis was that the proof compared two serializer DIALECTS —
// `rootGraph.serialize()` against a `changeTracker.activeState`. That is REFUTED:
// `graphRootMatchesState` normalizes BOTH sides through the same `graphShape`
// (that is what #560 built), and `activeState` is itself a clone of
// `rootGraph.serialize()`, so the two sides are the same dialect by construction.
//
// The defect is one level up and is the same SHAPE: the content check answers
// "did the load land faithfully?" and was read as the answer to "is this the
// canvas I asked for?". `loadGraphData` TRANSFORMS the payload it is handed
// before the root serializes again — it grows every node to at least
// `computeSize()`, rewrites null combo values and `control_after_generate`,
// may substitute a schema-validated copy of the payload, and runs every
// installed extension's `loadedGraphNode` hook on every node. A canvas that was
// rebound perfectly therefore differs from the bytes handed in, and denying the
// rebind for it is a false negative on a question the marker already answers.
//
// The fix does NOT loosen the #349 wrong-canvas fence. It replaces the weaker
// binding evidence with STRONGER evidence: a single-use marker minted per
// attempt and written into that attempt's payload. `configure()` replaces
// `graph.extra` wholesale from the data it is given, so nothing but this load
// can put that value on the live root — where a WORKFLOW uuid could already be
// there from a previous load of the same tab or from the guard's own rebind
// heal (#545/#557/#565).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  describeGraphStateDifference,
  describeOpenRebindOutcome,
  describeRepaintSourceBinding,
  graphRootCarriesOpenProof,
  graphRootMatchesState,
  graphRootWorkflowUuidMatches,
  resolveOpenRebindVerdict,
  OPEN_PROOF_FIELD,
  OPEN_REBIND_STATUS,
  PANEL_GRAPH_META_KEY,
} from "../../web/js/lib/graph-binding.js";
import { shouldForkEmbeddedUuidForLiveOwner } from "../../web/js/lib/workflow-chat-identity.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));

/** A live root as the panel sees it: `_nodes` plus a `serialize()`, and the
 *  `extra` the panel reads its markers off (LiteGraph's `configure()` installs
 *  `extra` on the graph object itself, which is why the marker is readable
 *  there and not only through `serialize()`). */
const liveRoot = (serialized) => ({
  _nodes: (serialized.nodes ?? []).map(({ id, type }) => ({ id, type })),
  extra: serialized.extra ?? {},
  serialize: () => serialized,
});

const UUID_A = "workflow-A";
const MARKER = "marker-for-this-attempt";

/** The payload workflow_open builds: the tab's own state plus the panel's tags. */
const payload = (nodes, extra = {}) => ({
  nodes,
  links: [[1, 1, 0, 2, 0, "MODEL"]],
  extra: {
    ...extra,
    [PANEL_GRAPH_META_KEY]: {
      workflow_uuid: UUID_A,
      workflow_path: "workflows/a.json",
      [OPEN_PROOF_FIELD]: MARKER,
    },
  },
});

const NODES = [
  { id: 1, type: "CheckpointLoaderSimple", pos: [10, 10], size: [270, 98], widgets_values: ["m.safetensors"] },
  { id: 2, type: "KSampler", pos: [400, 10], size: [315, 262], widgets_values: [1, "fixed", 20] },
];

// ── the reported failure: a FAITHFUL open that the loader transformed ────────

test("#604/#603/#616: the reported failure — a faithful repaint the frontend NORMALIZED", () => {
  const loaded = payload(NODES);
  // What loadGraphData actually leaves behind: every node grown to at least
  // computeSize() and snapped, and the extra surfaces LiteGraph re-emits. The
  // graph is the one we asked for; the bytes are not the ones we handed in.
  const afterLoad = {
    ...structuredClone(loaded),
    nodes: [
      { ...structuredClone(NODES[0]), size: [280, 106] },
      { ...structuredClone(NODES[1]), size: [320, 270] },
    ],
    groups: [],
    reroutes: [],
    config: {},
    extra: { ...structuredClone(loaded.extra), ds: { scale: 0.85, offset: [3, 4] } },
  };
  const rootGraph = liveRoot(afterLoad);

  // The content check FAILS — correctly. It is a FIDELITY question and the bytes differ.
  assert.equal(graphRootMatchesState({ rootGraph, state: loaded }), false, "content genuinely differs");
  // ...and every BINDING part passes.
  assert.equal(graphRootCarriesOpenProof({ rootGraph, proofMarker: MARKER }), true);
  assert.equal(graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid: UUID_A }), true);

  const verdict = resolveOpenRebindVerdict({
    instanceStillTarget: true,
    markerMatches: true,
    identityMatches: true,
    contentMatches: false,
  });
  // Assert the REASON, not just the state. The OUTCOME is unchanged — workflow_open
  // still answers `unknown` here, deliberately (see the next test). What changed is
  // that the panel now KNOWS which half is settled and can say so.
  assert.equal(verdict.status, OPEN_REBIND_STATUS.CONTENT_UNVERIFIED);
  assert.equal(verdict.bindingProven, true, "the canvas IS the requested workflow, and that is now proven");
  assert.deepEqual(verdict.unproven, ["content"]);

  const text = describeOpenRebindOutcome(verdict, {
    targetLabel: "a.json",
    contentComparable: true,
    contentSurfaces: describeGraphStateDifference({ rootGraph, state: loaded }).surfaces,
  });
  assert.match(text, /canvas IS bound to a\.json/, "the settled half must be stated as settled");
  // The retraction survives — the identity IS settled and must be stated as such —
  // but it is now scoped to the identity (#1111/#1089). The old sentence read as
  // "everything is fine except presentation", and two reporters proceeded on that
  // while the PREVIOUS workflow's graph sat on the canvas.
  assert.match(text, /The identity is settled/, "the old message's worst implication is retracted");
  assert.match(text, /IS the active one/, "…and the settled half is still stated plainly");
  assert.match(
    text,
    /not about the nodes/,
    "…but it no longer implies the graph is this workflow's",
  );
  assert.match(
    text,
    /PREVIOUS workflow's graph still on the canvas/,
    "the reported outcome is named, so a re-read is not taken at face value",
  );
  assert.match(
    text,
    /panel_load_workflow with this workflow's path reloads it/,
    "and the recovery that actually worked for both reporters is named",
  );
  // codex review, P1: that recovery loads from DISK. If the stale canvas holds
  // unsaved work — and if it is the previous workflow's, it may — reloading
  // destroys it. Naming a destructive step as "the recovery" without saying so is
  // how a message meant to prevent data loss causes it.
  assert.match(text, /It loads from DISK/, "the cost of the recovery is stated");
  assert.match(text, /preserve it FIRST/, "…and what to do before taking it");
  // codex round 2, P1: a PLAIN save is itself destructive here. The active identity
  // already names the requested workflow, so saving the stale graph writes it over
  // exactly the file the user was trying to open — the safety advice creating a
  // worse data-loss path than the one it was preventing.
  assert.match(text, /To a NEW path, with Save As or an export/, "preservation must not overwrite");
  assert.match(text, /a plain save would write it to a\.json/, "…and the trap is named explicitly");
  assert.match(text, /UNKNOWN/, "...while the unsettled half stays unknown");
  assert.match(text, /nodes/, "the disclosure must name WHICH surface disagreed");
});

test("a CONTENT mismatch is still NOT a success — the relaxation was tried and reverted", () => {
  // Softening this into an applied open was implemented here and then withdrawn.
  // LiteGraph creates every node (id and type) and THEN configures each one, and
  // loadGraphData catches a configure() failure and returns. A throw in that second
  // pass leaves the complete node id/type set, the links, and this attempt's marker —
  // written by _configureBase before any node is built — over nodes that silently LOST
  // their widget values. That observation is byte-identical to "the loader normalized
  // the widget values", and no evidence available to the panel separates them.
  // Reporting it as applied would fabricate a success over data loss.
  const loaded = payload(NODES);
  const widgetsLost = structuredClone(loaded);
  delete widgetsLost.nodes[1].widgets_values;
  const rootGraph = liveRoot(widgetsLost);

  assert.equal(graphRootCarriesOpenProof({ rootGraph, proofMarker: MARKER }), true, "the marker DID land");
  const verdict = resolveOpenRebindVerdict({
    instanceStillTarget: true,
    markerMatches: true,
    identityMatches: true,
    contentMatches: graphRootMatchesState({ rootGraph, state: loaded }),
  });
  assert.notEqual(verdict.status, OPEN_REBIND_STATUS.PROVEN, "a lost widget value is never a proven open");
  assert.equal(verdict.status, OPEN_REBIND_STATUS.CONTENT_UNVERIFIED);
});

test("a PARTLY APPLIED load carries this attempt's marker and must still not be PROVEN", () => {
  // The same route at its most extreme: the marker rides in `extra`, which
  // _configureBase installs BEFORE any node is built, so a configure() that throws
  // early leaves the root carrying this attempt's marker AND uuid over an empty graph.
  const loaded = payload(NODES);
  const rootGraph = liveRoot({ ...structuredClone(loaded), nodes: [] });

  assert.equal(graphRootCarriesOpenProof({ rootGraph, proofMarker: MARKER }), true, "the marker DID land");
  assert.equal(graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid: UUID_A }), true, "the uuid DID land");

  const verdict = resolveOpenRebindVerdict({
    instanceStillTarget: true,
    markerMatches: true,
    identityMatches: true,
    contentMatches: graphRootMatchesState({ rootGraph, state: loaded }),
  });
  assert.notEqual(verdict.status, OPEN_REBIND_STATUS.PROVEN, "a truncated canvas is never a completed open");
  assert.deepEqual(verdict.unproven, ["content"]);
});

// ── the #349 direction: this must still catch a canvas that was NOT rebound ──

test("#349: a load that leaves the PREVIOUS canvas mounted is still UNPROVEN", () => {
  // loadGraphData resolved, but the canvas is still tab B's graph. B's root
  // carries B's own tags — it cannot carry a marker minted seconds ago for A.
  const otherTab = {
    nodes: [{ id: 9, type: "SaveImage" }],
    extra: { [PANEL_GRAPH_META_KEY]: { workflow_uuid: "workflow-B", [OPEN_PROOF_FIELD]: "some-older-marker" } },
  };
  const rootGraph = liveRoot(otherTab);
  assert.equal(graphRootCarriesOpenProof({ rootGraph, proofMarker: MARKER }), false);

  const verdict = resolveOpenRebindVerdict({
    instanceStillTarget: true,
    markerMatches: graphRootCarriesOpenProof({ rootGraph, proofMarker: MARKER }),
    identityMatches: graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid: UUID_A }),
    contentMatches: graphRootMatchesState({ rootGraph, state: payload(NODES) }),
  });
  assert.equal(verdict.status, OPEN_REBIND_STATUS.UNPROVEN);
  assert.equal(verdict.bindingProven, false, "a wrong canvas must never be reported as bound");
  assert.deepEqual(verdict.unproven, ["marker", "identity"]);
});

test("#349: the marker is what a stale ROOT TAG cannot fake — the hole the uuid alone left", () => {
  // The exact case the workflow uuid cannot decide: the root already carries A's
  // uuid (a previous load of A, or the guard's rebind heal stamped it) while the
  // canvas holds a DIFFERENT graph and our load never landed. The old proof's
  // identity part passes here; only content stood between this and a fabricated
  // success. The attempt-scoped marker refuses it on the BINDING question itself.
  const staleRootWithOurTag = {
    nodes: [{ id: 9, type: "SaveImage" }],
    extra: { [PANEL_GRAPH_META_KEY]: { workflow_uuid: UUID_A } },
  };
  const rootGraph = liveRoot(staleRootWithOurTag);
  assert.equal(
    graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid: UUID_A }),
    true,
    "the workflow uuid is satisfied by a stale tag — that is why it is not sufficient",
  );
  assert.equal(graphRootCarriesOpenProof({ rootGraph, proofMarker: MARKER }), false);
  const verdict = resolveOpenRebindVerdict({
    instanceStillTarget: true,
    markerMatches: false,
    identityMatches: true,
    contentMatches: false,
  });
  assert.equal(verdict.bindingProven, false);
  assert.deepEqual(verdict.unproven, ["marker"]);
});

test("a tab switch during the load makes every other observation describe another canvas", () => {
  // Even with a perfect marker and content match: if the active workflow is no
  // longer the target, what was proven was proven about someone else's tab.
  const verdict = resolveOpenRebindVerdict({
    instanceStillTarget: false,
    markerMatches: true,
    identityMatches: true,
    contentMatches: true,
  });
  assert.equal(verdict.status, OPEN_REBIND_STATUS.UNPROVEN);
  assert.deepEqual(verdict.unproven, ["instance"]);
});

test("an UNREADABLE observation is not a passing one — every part is compared against true", () => {
  for (const absent of [undefined, null, "yes", 1, {}]) {
    assert.equal(
      resolveOpenRebindVerdict({
        instanceStillTarget: absent,
        markerMatches: true,
        identityMatches: true,
        contentMatches: true,
      }).bindingProven,
      false,
      `a non-true instance observation (${JSON.stringify(absent)}) must not prove the rebind`,
    );
    assert.equal(
      resolveOpenRebindVerdict({
        instanceStillTarget: true,
        markerMatches: absent,
        identityMatches: true,
        contentMatches: true,
      }).bindingProven,
      false,
      `a non-true marker observation (${JSON.stringify(absent)}) must not prove the rebind`,
    );
  }
  assert.equal(resolveOpenRebindVerdict().status, OPEN_REBIND_STATUS.UNPROVEN, "no observations at all proves nothing");
});

test("a fully faithful load is PROVEN, so the ordinary open is untouched", () => {
  const loaded = payload(NODES);
  const rootGraph = liveRoot(structuredClone(loaded));
  const verdict = resolveOpenRebindVerdict({
    instanceStillTarget: true,
    markerMatches: graphRootCarriesOpenProof({ rootGraph, proofMarker: MARKER }),
    identityMatches: graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid: UUID_A }),
    contentMatches: graphRootMatchesState({ rootGraph, state: loaded }),
  });
  assert.equal(verdict.status, OPEN_REBIND_STATUS.PROVEN);
  assert.deepEqual(verdict.unproven, []);
  assert.equal(describeOpenRebindOutcome(verdict, {}), "", "a proven open says nothing extra");
});

// ── the marker itself ────────────────────────────────────────────────────────

test("graphRootCarriesOpenProof: only an EXACT match of a real marker proves anything", () => {
  const withMarker = liveRoot({ nodes: [], extra: { [PANEL_GRAPH_META_KEY]: { [OPEN_PROOF_FIELD]: MARKER } } });
  assert.equal(graphRootCarriesOpenProof({ rootGraph: withMarker, proofMarker: MARKER }), true);
  assert.equal(graphRootCarriesOpenProof({ rootGraph: withMarker, proofMarker: "other" }), false);
  // An EMPTY expectation must never be satisfiable — otherwise a failure to mint
  // a marker would silently prove every canvas.
  assert.equal(graphRootCarriesOpenProof({ rootGraph: withMarker, proofMarker: "" }), false);
  assert.equal(graphRootCarriesOpenProof({ rootGraph: withMarker }), false);
  assert.equal(graphRootCarriesOpenProof({ rootGraph: liveRoot({ nodes: [] }), proofMarker: MARKER }), false);
  assert.equal(graphRootCarriesOpenProof({ proofMarker: MARKER }), false, "no root proves nothing");
  // A non-string marker on the root (a doctored or half-written extra) is not a match.
  const numeric = liveRoot({ nodes: [], extra: { [PANEL_GRAPH_META_KEY]: { [OPEN_PROOF_FIELD]: 7 } } });
  assert.equal(graphRootCarriesOpenProof({ rootGraph: numeric, proofMarker: "7" }), false);
});

test("the marker rides in the panel's own namespace, so it can never affect a CONTENT comparison", () => {
  // Both sides are written with LITERAL key names, not the exported constants. Using
  // the constants makes this test self-consistent and therefore blind: move the field
  // out of the panel namespace and a constants-based fixture moves with it and still
  // passes, while the live root — whose `extra` comes from ComfyUI, not from us —
  // would put the marker where the content comparison can see it, and every repaint
  // would mismatch. That is the false negative this whole change removes,
  // reintroduced by the fix.
  assert.equal(PANEL_GRAPH_META_KEY, "comfyui_mcp", "the namespace buildGraphShape strips");
  assert.equal(OPEN_PROOF_FIELD, "open_proof");
  const state = { nodes: NODES, extra: { comfyui_mcp: { workflow_uuid: UUID_A } } };
  const withMarker = {
    nodes: structuredClone(NODES),
    extra: { comfyui_mcp: { workflow_uuid: UUID_A, open_proof: MARKER } },
  };
  assert.equal(graphRootMatchesState({ rootGraph: liveRoot(withMarker), state }), true);
  // ...and the reader looks in that same literal place.
  assert.equal(graphRootCarriesOpenProof({ rootGraph: liveRoot(withMarker), proofMarker: MARKER }), true);
  // A marker parked anywhere else is NOT a proof, and IS content.
  const topLevel = { nodes: structuredClone(NODES), extra: { comfyui_mcp: { workflow_uuid: UUID_A }, open_proof: MARKER } };
  assert.equal(graphRootCarriesOpenProof({ rootGraph: liveRoot(topLevel), proofMarker: MARKER }), false);
  assert.equal(graphRootMatchesState({ rootGraph: liveRoot(topLevel), state }), false);
});

// ── "could not compare" is never "compared and they differ" ──────────────────

test("describeGraphStateDifference: an unshapeable side reports NOT COMPARABLE, never a difference", () => {
  const state = payload(NODES);
  assert.deepEqual(describeGraphStateDifference({ rootGraph: { serialize: () => null }, state }), {
    comparable: false,
    surfaces: [],
    accountedSurfaces: [],
    nodeDifference: null,
  });
  assert.deepEqual(
    describeGraphStateDifference({
      rootGraph: {
        serialize: () => {
          throw new Error("serializer unavailable");
        },
      },
      state,
    }),
    { comparable: false, surfaces: [], accountedSurfaces: [], nodeDifference: null },
    "a THROWING serializer is an absent observation, not evidence of a mismatch",
  );
  assert.deepEqual(describeGraphStateDifference({ rootGraph: liveRoot(structuredClone(state)) }), {
    comparable: false,
    surfaces: [],
    accountedSurfaces: [],
    nodeDifference: null,
  });
  assert.deepEqual(describeGraphStateDifference(), {
    comparable: false,
    surfaces: [],
    accountedSurfaces: [],
    nodeDifference: null,
  });
});

test("describeGraphStateDifference: names the surfaces that disagreed, and only those", () => {
  const state = payload(NODES);
  const equal = describeGraphStateDifference({ rootGraph: liveRoot(structuredClone(state)), state });
  assert.deepEqual(equal, { comparable: true, surfaces: [], accountedSurfaces: [], nodeDifference: null });

  const nodesDiffer = structuredClone(state);
  nodesDiffer.nodes = [nodesDiffer.nodes[0]];
  assert.deepEqual(describeGraphStateDifference({ rootGraph: liveRoot(nodesDiffer), state }), {
    comparable: true,
    surfaces: ["nodes"],
    accountedSurfaces: [],
    // #825 — a DROPPED node: same-set must be false, and never "cosmetic".
    nodeDifference: { comparable: true, sameNodeSet: false, cosmeticOnly: false, fields: [], propertyFields: [] },
  });

  const groupsDiffer = structuredClone(state);
  groupsDiffer.groups = [{ title: "G", bounding: [0, 0, 10, 10] }];
  assert.deepEqual(describeGraphStateDifference({ rootGraph: liveRoot(groupsDiffer), state }), {
    comparable: true,
    surfaces: ["groups"],
    accountedSurfaces: [],
    // nodes agreed, so there is no node difference to explain.
    nodeDifference: null,
  });

  // Serializer DIALECT must not be named as a difference — it is not one (#560).
  const dialect = structuredClone(state);
  dialect.reroutes = [];
  dialect.config = {};
  dialect.extra.ds = { scale: 1.1, offset: [0, 0] };
  assert.deepEqual(describeGraphStateDifference({ rootGraph: liveRoot(dialect), state }), {
    comparable: true,
    surfaces: [],
    accountedSurfaces: [],
    nodeDifference: null,
    // A present-but-empty surface and a viewport are dialect, and this must agree
    // with graphRootMatchesState exactly — one normalization, two readings of it.
  });
  assert.equal(graphRootMatchesState({ rootGraph: liveRoot(dialect), state }), true);
});

// ── the disclosure ───────────────────────────────────────────────────────────

test("the UNPROVEN disclosure never invites a clean retry and never asserts a cause it did not observe", () => {
  const verdict = resolveOpenRebindVerdict({ instanceStillTarget: false, markerMatches: false, identityMatches: false });
  const text = describeOpenRebindOutcome(verdict, {
    targetLabel: "a.json",
    activeLabel: "b.json",
    expectedMarker: "M1",
    observedMarker: null,
    expectedUuid: UUID_A,
    observedUuid: "workflow-B",
    contentComparable: true,
    contentSurfaces: [],
  });
  // workflow_open is destructive and its load has ALREADY run — a disclosure, never
  // a refusal that reads as "nothing happened".
  assert.match(text, /RAN/, "it must say the open ran");
  assert.doesNotMatch(text, /nothing (was )?(changed|happened)/i);
  assert.doesNotMatch(text, /retrying is safe/i);
  // It must name WHICH values disagreed — "the fence rejected" is not actionable.
  assert.match(text, /a\.json/);
  assert.match(text, /b\.json/);
  assert.match(text, /M1/);
  assert.match(text, /workflow-B/);
});

test("an UNCOMPARABLE content check is disclosed as unknown, not as a difference", () => {
  const verdict = resolveOpenRebindVerdict({
    instanceStillTarget: true,
    markerMatches: true,
    identityMatches: true,
    contentMatches: false,
  });
  const text = describeOpenRebindOutcome(verdict, {
    targetLabel: "a.json",
    contentComparable: false,
    contentSurfaces: [],
  });
  assert.match(text, /UNKNOWN/, "an absent comparison must be stated as unknown");
  assert.doesNotMatch(text, /differs from what was loaded on/, "the CLAUSE must not claim a difference it never observed");
  // ...and neither may the SENTENCE IN FRONT of it. `graphRootMatchesState` returns
  // false for both "compared and differed" and "could not read the root", so the
  // headline used to report a definite mismatch for a canvas nobody could look at —
  // the could-not-determine/determined-not fold, inside the fix meant to remove it.
  assert.doesNotMatch(text, /does not match the state that was loaded/, "the headline must not assert it either");
  assert.match(text, /could not READ the graph on it/, "it must say what actually happened");
  assert.match(text, /NOT established as wrong/);
  // The binding half is still stated as settled — that part WAS observed.
  assert.match(text, /canvas IS bound to a\.json/);
});

test("a COMPARED content mismatch still says so plainly — the fix must not blunt the real case", () => {
  const verdict = resolveOpenRebindVerdict({
    instanceStillTarget: true,
    markerMatches: true,
    identityMatches: true,
    contentMatches: false,
  });
  const text = describeOpenRebindOutcome(verdict, {
    targetLabel: "a.json",
    contentComparable: true,
    contentSurfaces: ["nodes"],
  });
  assert.match(text, /does not match the state that was loaded/);
  assert.doesNotMatch(text, /could not READ the graph on it/);
});

test("an ABSENT contentComparable takes the non-asserting wording, never the mismatch claim", () => {
  // A caller that reports nothing about comparability has not established one, and
  // the safe direction for an unstated observation is the one that claims less.
  const verdict = resolveOpenRebindVerdict({
    instanceStillTarget: true,
    markerMatches: true,
    identityMatches: true,
    contentMatches: false,
  });
  for (const unstated of [undefined, null, "true", 1]) {
    const text = describeOpenRebindOutcome(verdict, { targetLabel: "a.json", contentComparable: unstated });
    const why = `an unstated comparability (${JSON.stringify(unstated)})`;
    assert.doesNotMatch(text, /does not match the state that was loaded/, `${why} must not license a HEADLINE mismatch claim`);
    // ...and the per-part CLAUSE must not smuggle the same claim back in. The first cut
    // fixed only the headline: the clause tested `=== false`, so an absent value fell
    // down the opposite branch and the one disclosure contradicted itself — it said
    // "could not READ … NOT established as wrong" and then "the graph … differs".
    assert.doesNotMatch(text, /differs from what was loaded/, `${why} must not license a CLAUSE mismatch claim either`);
    assert.match(text, /could not compare the loaded graph/, `${why} must say a comparison did not happen`);
  }
});

test("the headline and the content clause always agree about whether a comparison happened", () => {
  // They are two sentences in ONE disclosure and were derived from opposite tests
  // (`=== true` vs `=== false`). Whatever the input, they must never state both
  // "could not read it" and "it differs".
  const verdict = resolveOpenRebindVerdict({
    instanceStillTarget: true,
    markerMatches: true,
    identityMatches: true,
    contentMatches: false,
  });
  for (const value of [true, false, undefined, null, "true", 1, 0, {}]) {
    const text = describeOpenRebindOutcome(verdict, {
      targetLabel: "a.json",
      contentComparable: value,
      contentSurfaces: ["nodes"],
    });
    const claimsDifference = /differs from what was loaded/.test(text) || /does not match the state that was loaded/.test(text);
    const claimsUnreadable = /could not compare the loaded graph/.test(text) || /could not READ the graph on it/.test(text);
    assert.notEqual(
      claimsDifference && claimsUnreadable,
      true,
      `contentComparable=${JSON.stringify(value)} produced a self-contradicting disclosure`,
    );
    assert.equal(claimsDifference || claimsUnreadable, true, "it must say one or the other");
    assert.equal(claimsDifference, value === true, "only an explicit `true` may license the difference claim");
  }
});

test("the marker is NOT a superset of the uuid check — both are required", () => {
  // The overclaim an independent gate caught: a root carrying THIS attempt's marker
  // alongside a DIFFERENT workflow's uuid passes the marker and fails the identity
  // check. They answer different questions ("did this attempt configure it" vs "whose
  // workflow is it"), so treating the marker as the stronger check would licence
  // dropping the identity one in a later refactor — a real hole from a comment.
  const foreign = liveRoot({
    nodes: [],
    extra: { [PANEL_GRAPH_META_KEY]: { workflow_uuid: "workflow-B", [OPEN_PROOF_FIELD]: MARKER } },
  });
  assert.equal(graphRootCarriesOpenProof({ rootGraph: foreign, proofMarker: MARKER }), true, "marker passes");
  assert.equal(graphRootWorkflowUuidMatches({ rootGraph: foreign, activeWorkflowUuid: UUID_A }), false, "identity fails");
  // ...and the verdict ANDs them, so the combination is still refused.
  assert.equal(
    resolveOpenRebindVerdict({
      instanceStillTarget: true,
      markerMatches: true,
      identityMatches: false,
      contentMatches: true,
    }).bindingProven,
    false,
    "the AND is what makes the pair safe — neither predicate covers the other",
  );
});

test("only the parts that actually failed are narrated", () => {
  const verdict = resolveOpenRebindVerdict({
    instanceStillTarget: true,
    markerMatches: false,
    identityMatches: true,
    contentMatches: true,
  });
  const text = describeOpenRebindOutcome(verdict, {
    targetLabel: "a.json",
    activeLabel: "a.json",
    expectedMarker: "M1",
    observedMarker: "M0",
    expectedUuid: UUID_A,
    observedUuid: UUID_A,
  });
  assert.match(text, /one-time marker/);
  assert.doesNotMatch(text, /the active workflow changed during the load/, "an instance check that PASSED must not be blamed");
  assert.doesNotMatch(text, /graph-command fence/, "an identity check that PASSED must not be blamed");
  // ...and the PREFIX must not smuggle the same unobserved cause back in. This was a
  // gate finding: the named clauses were careful, and then the sentence in front of
  // them said "the open may have switched the active workflow" regardless. And no branch
  // may narrate a tab SWITCH: the check reads "is the active workflow this target now",
  // which does not witness a switch and is equally true if the target was already active.
  assert.doesNotMatch(text, /could not confirm which workflow is active/, "a confirmed active workflow is not unconfirmed");
  assert.match(text, /a\.json IS the active workflow/, "a check that passed is information — state it");
  // ...and no branch may narrate a tab SWITCH at all. The check reads "is the active
  // workflow this target NOW"; it does not witness a switch, and it is equally true
  // when the target was already active before the call.
  assert.doesNotMatch(text, /switch/i, "no branch may narrate an event the panel did not witness");
});

test("...but an unproven instance DOES say which workflow is active is unconfirmed", () => {
  const verdict = resolveOpenRebindVerdict({ instanceStillTarget: false, markerMatches: true, identityMatches: true });
  const text = describeOpenRebindOutcome(verdict, { targetLabel: "a.json", activeLabel: "b.json" });
  assert.match(text, /could not confirm which workflow is active/);
  assert.doesNotMatch(text, /a\.json IS the active workflow/);
  assert.doesNotMatch(text, /switch/i, "even here, no witnessed switch may be claimed");
});

test("an UNREADABLE active workflow is 'could not confirm', never 'it changed'", () => {
  // The instance observation is `!== true`, which an unreadable pointer produces just
  // as a real tab switch does. Wording it as a switch states a cause for a reading
  // that was never taken — the same could-not-determine-becomes-a-verdict defect this
  // whole cluster is about, in the message instead of the logic.
  for (const unreadable of [undefined, null]) {
    const verdict = resolveOpenRebindVerdict({ instanceStillTarget: unreadable, markerMatches: true, identityMatches: true });
    const text = describeOpenRebindOutcome(verdict, { targetLabel: "a.json", activeLabel: "no active tab" });
    assert.match(text, /could not confirm the active workflow is still a\.json/);
    assert.doesNotMatch(text, /changed during the load/, "an unread pointer is not an observed change");
  }
});

// ── wiring: the panel must actually use all of this ──────────────────────────

test("wiring: every non-proven verdict keeps the honest `unknown`, with the named cause", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // One outcome for every non-proven verdict — the split buys a better MESSAGE, not a
  // softer answer. A branch that turned a binding-proven verdict into a success is
  // exactly what was reverted, so its absence is asserted.
  assert.match(src, /if \(verdict\.status !== OPEN_REBIND_STATUS\.PROVEN\) \{/);
  assert.match(src, /rebindFailed = new Error\(\r?\n\s*describeOpenRebindOutcome\(verdict, \{/);
  assert.doesNotMatch(src, /contentUnverified/, "the applied-with-caveat path must be gone");
  assert.doesNotMatch(src, /content_verified/, "...and so must its reply field");
  // The surface diff feeds the MESSAGE only, and is computed only once something failed.
  const failAt = src.indexOf("if (verdict.status !== OPEN_REBIND_STATUS.PROVEN) {");
  assert.ok(src.indexOf("describeGraphStateDifference({ rootGraph, state: repaintState })", failAt) > failAt);
  // The marker is stripped only AFTER the verdict is decided — evidence first. Asserted
  // over EVERY deletion of the field, not just the one we wrote: pinning a single known
  // statement leaves the file free to grow an earlier one, and a marker deleted before
  // it is read makes the proof fail for a canvas that was rebound perfectly.
  const verdictAt = src.indexOf("const verdict = resolveOpenRebindVerdict({");
  assert.notEqual(verdictAt, -1);
  const deletions = [...src.matchAll(/delete\s+[^;\n]*\[OPEN_PROOF_FIELD\]/g)].map((m) => m.index);
  assert.ok(deletions.length >= 1, "the marker must be stripped so it does not ride the user's next save");
  for (const at of deletions) {
    assert.ok(at > verdictAt, "no deletion of the marker may precede the verdict that reads it");
  }
  // ...and the strip must run on the FAILURE paths too. `getGraphCtx()` refuses a
  // canvas/root divergence by throwing, so a cleanup placed after the observations
  // is skipped on exactly the calls that fail — and the marker then rides the user's
  // next save. It therefore lives in a `finally`, resolved from the live app rather
  // than a local that may never have been assigned.
  // Compared over CODE only: this block is heavily commented, and a length-sensitive
  // match would break on the next comment edit rather than on a real regression.
  const code = src.replace(/^\s*\/\/[^\n]*$/gm, "");
  assert.match(code, /\} finally \{[\s\S]{0,400}?delete meta\[OPEN_PROOF_FIELD\];/);
  // ...and the LOAD is inside that try, not before it. The payload carrying the marker
  // is handed over the instant loadGraphData starts, so a REJECTION leaves the marker on
  // a partially-mutated live graph — and a cleanup that begins after the await never runs
  // for exactly that case.
  const tryAt = code.indexOf("try {", code.indexOf("const openProofMarker"));
  const loadAt = code.indexOf("await app.loadGraphData(repaintState, true, true, target);");
  assert.ok(tryAt !== -1 && loadAt > tryAt, "the repaint load must sit inside the marker-cleanup try");
  // It deletes only THIS attempt's value: an unconditional delete would remove a
  // concurrent open's live evidence before that open could read it.
  assert.match(src, /meta\[OPEN_PROOF_FIELD\] === openProofMarker/);
});

test("#641: a save/reconnect INSTANCE REFRESH of the same file keeps its uuid (fixed by #545/#557)", () => {
  // #641 traced the fence's false rejection to `workflowStableUuid` minting a fresh
  // uuid whenever the embedded uuid's remembered owner was a different object — which
  // a save cycle or a reconnect workflow-list refresh always makes true, because the
  // store hands out a NEW ComfyWorkflow for the SAME saved file. The reporter's build
  // (0.11.35 / 675ace8) predates 5b4c8a9, which replaced that line: the fork now
  // requires the owner to still be an OPEN tab. A replaced predecessor is not, so the
  // successor INHERITS the identity and the root tag stays aligned.
  const predecessor = { path: "workflows/a.json", isPersisted: true };
  const successor = { path: "workflows/a.json", isPersisted: true };
  assert.equal(
    shouldForkEmbeddedUuidForLiveOwner({
      embeddedUuid: UUID_A,
      embeddedOwner: predecessor,
      identityObject: successor,
      ownerIsOpenWorkflow: false, // the save/reconnect replaced it — it is gone from the tab list
      successionProven: true,
    }),
    false,
    "an instance refresh of the same file must NOT mint a fresh uuid (that is #641)",
  );
  // ...and the co-open COPY case still forks, so the fix is not a blanket relaxation.
  assert.equal(
    shouldForkEmbeddedUuidForLiveOwner({
      embeddedUuid: UUID_A,
      embeddedOwner: predecessor,
      identityObject: successor,
      ownerIsOpenWorkflow: true, // the owner is still open — this really is a second copy
      successionProven: true,
    }),
    true,
    "a genuine co-open copy must still get its own identity (#557/#570)",
  );
});

// ── #702: a proven-binding open must not strand the caller's fence ──────────
//
// CONTENT_UNVERIFIED throws, so it never reaches the line that publishes
// `workflow_uuid`, and the caller's command fence keeps whatever it had. The
// disclosure closed by recommending `panel_graph_outline` — precisely the call about
// to be refused as a `workflow instance mismatch`. Two reporters followed that advice
// into the refusal and concluded only a full panel_reload could recover.
//
// Measured end-to-end (browser_tests/open-unverified-names-recovery.spec.ts): after
// this outcome, `workflow_list` still republishes the active identity and a graph read
// stamped with it succeeds. The recovery existed; the reply never named it.

test("#702: a content-unverified open discloses that no fence refresh rode with it", () => {
  // EVERY content-unverified wording strands the caller the same way, so every one
  // of them must carry the note. The generic branch was missed on the first pass and
  // this loop is what caught it.
  for (const observed of [
    // Both CONTENT_UNVERIFIED wordings: values matched (presentation-only drift), and
    // per-node fields differing. They are separate sentences and both stranded callers.
    // node set intact + values matched — the presentation-only wording
    { contentComparable: true, contentSurfaces: ["nodes"], contentNodeDifference: { comparable: true, sameNodeSet: true, cosmeticOnly: true } },
    // node set intact, values differ — the per-node-fields wording
    { contentComparable: true, contentSurfaces: ["nodes"], contentNodeDifference: { comparable: true, sameNodeSet: true, cosmeticOnly: false } },
    // node set NOT intact, and a second surface — the generic "treat as UNKNOWN" wording
    { contentComparable: true, contentSurfaces: ["nodes", "links"], contentNodeDifference: { comparable: true, sameNodeSet: false } },
    // the content could not be READ at all — the non-asserting wording
    { contentComparable: false, contentSurfaces: [], contentNodeDifference: null },
  ]) {
    const text = describeOpenRebindOutcome(
      { status: OPEN_REBIND_STATUS.CONTENT_UNVERIFIED, bindingProven: true, unproven: ["content"] },
      { targetLabel: "My Workflow", ...observed },
    );
    assert.match(text, /carries NO fence refresh/, "it must say the fence was not refreshed");
    assert.match(text, /panel_list_workflows/, "it must name the fence-exempt recovery probe");
    assert.match(
      text,
      /Reloading the panel is NOT required to refresh the fence/,
      "it must retract the panel_reload advice both reporters followed",
    );
    // It must promise a fence refresh and NOTHING more. On the wording where the panel
    // could not read the graph at all, a refreshed fence cannot make that read succeed —
    // it only stops the mismatch from being the reason it fails (codex).
    assert.doesNotMatch(
      text,
      /the graph read then works/,
      "the note must not promise a graph read will succeed",
    );
  }
});

test("#702: the fence note is ONLY on the content-unverified outcome", () => {
  // An UNPROVEN open has not established identity, so `workflow_list` republishing the
  // active identity is not a remedy for it — promising one there would send a caller
  // to re-stamp against a canvas whose binding was never proven.
  const unproven = describeOpenRebindOutcome(
    { status: OPEN_REBIND_STATUS.UNPROVEN, bindingProven: false, unproven: ["identity"] },
    { targetLabel: "My Workflow", expectedUuid: "a", observedUuid: "b" },
  );
  assert.doesNotMatch(unproven, /carries NO fence refresh/);
  // It may still say to CHECK panel_list_workflows — it does, and that is right: with
  // the binding unproven you look at what is actually active. What it must NOT do is
  // retract the reload, because there the reload is the remedy. Re-stamping from the
  // probe would otherwise be invited against a binding that was never proven.
  assert.doesNotMatch(unproven, /Reloading the panel is NOT required/);
  assert.match(unproven, /reload the panel before graph edits/);
});

// ---------------------------------------------------------------------------
// #1089 — the SOURCE of the repaint, which no post-load proof looks at.
//
// The reporter got a clean success: right path, right filename, right
// workflow_uuid, modified:false — and the PREVIOUS workflow's graph on the
// canvas. Their next calls were panel_remove_node, and Save-As preserves ids,
// so those deletions would largely have LANDED on the wrong workflow.
//
// Nothing was fooled. All four parts of resolveOpenRebindVerdict are taken
// against the root the loader produced, so each was a true statement about a
// poisoned SOURCE state. #968 closed the writer this repo owns, and #1215 then
// closed the untagged-root residual it had recorded — the capture now runs on
// an untagged root only when the pointer never moved. A state poisoned BEFORE
// that gate still reaches the load, and the load is what makes it durable — it
// stamps the target's identity onto the foreign graph, so a later save writes
// it to the target's file — which is why the open reply carries the
// `unproven_source_state` disclosure for exactly that combination.
// ---------------------------------------------------------------------------

/** A serialized tab state carrying the panel's durable workflow tag. */
const taggedState = (uuid) => ({
  nodes: [{ id: 1, type: "KSampler" }],
  extra: uuid ? { [PANEL_GRAPH_META_KEY]: { workflow_uuid: uuid } } : {},
});

const OTHER_OPEN = () => true;
const NO_OWNER = () => false;
const CLAIMS_NOTHING = () => false;

test("#1089: a state owned by another OPEN workflow is foreign — the open must not repaint from it", () => {
  assert.equal(
    describeRepaintSourceBinding({
      state: taggedState("workflow-B"),
      targetUuid: UUID_A,
      targetClaimsTag: CLAIMS_NOTHING,
      tagOwnedByOtherOpenWorkflow: OTHER_OPEN,
    }),
    "foreign",
  );
});

test("#1089: the tab's own state is bound and repaints exactly as before", () => {
  assert.equal(
    describeRepaintSourceBinding({
      state: taggedState(UUID_A),
      targetUuid: UUID_A,
      // Neither predicate is consulted on the matching path. Throwing proves it:
      // a match is decided by the tags alone.
      targetClaimsTag: () => {
        throw new Error("must not be consulted");
      },
      tagOwnedByOtherOpenWorkflow: () => {
        throw new Error("must not be consulted");
      },
    }),
    "bound",
  );
});

test("#1089: a mismatch alone is NOT foreign — a predecessor's uuid residue must not refuse a good open", () => {
  // workflowOwnsRootUuidTag's own header: a lagging activeState can carry a
  // REPLACED PREDECESSOR's uuid, "indistinguishable from the genuine lineage
  // stamp". Refusing on the bare mismatch would send that caller to a disk load,
  // which discards the unsaved work on the canvas — so the false refusal is
  // destructive too, and there is no safe default. Both escapes are asserted.
  assert.equal(
    describeRepaintSourceBinding({
      state: taggedState("workflow-B"),
      targetUuid: UUID_A,
      // the target's own lineage claims the conflicting tag (#545/#557 drift)
      targetClaimsTag: (tag) => tag === "workflow-B",
      tagOwnedByOtherOpenWorkflow: OTHER_OPEN,
    }),
    "unknown",
  );
  assert.equal(
    describeRepaintSourceBinding({
      state: taggedState("workflow-B"),
      targetUuid: UUID_A,
      targetClaimsTag: CLAIMS_NOTHING,
      // registered to nobody currently open — residue, not another tab's graph
      tagOwnedByOtherOpenWorkflow: NO_OWNER,
    }),
    "unknown",
  );
});

test("#1089: the tab's dirty flag is NOT an input — it is wrong in both directions", () => {
  // A `targetTabIsClean` gate existed here across two attempts and is gone. Both
  // stronger remedies it was gating are gone with it, and the reason is that
  // `isModified` cannot answer the question either of them needed:
  //
  //   spuriously FALSE — #874: ChangeTracker captures on USER INPUT events only, so a
  //   value a NODE wrote (a populated wildcard, a rolled seed) is on the canvas, never
  //   marks the tab modified, and was never saved. An auto-correct from disk gated on
  //   "clean" would silently replace exactly what an agent just generated.
  //
  //   spuriously TRUE — a first-time open still reads modified when the freeze
  //   is unavailable (no allow_interaction), so gating on it would have disarmed
  //   this guard for that population — the #1089 report, unprevented.
  //
  // So the classification is evidence-only and the flag is not consulted. Passing one
  // must change nothing, in either direction.
  const foreignTagArgs = {
    state: taggedState("workflow-B"),
    targetUuid: UUID_A,
    targetClaimsTag: CLAIMS_NOTHING,
    tagOwnedByOtherOpenWorkflow: OTHER_OPEN,
  };
  assert.equal(describeRepaintSourceBinding(foreignTagArgs), "foreign");
  for (const stray of [true, false, undefined, null, 0, "", 1, {}]) {
    assert.equal(
      describeRepaintSourceBinding({ ...foreignTagArgs, targetTabIsClean: stray }),
      "foreign",
      `a stray cleanliness reading must not change the answer: ${JSON.stringify(stray)}`,
    );
  }
});

test("#1089: the panel source does not gate this on the dirty flag anywhere", () => {
  // Belt-and-braces for the above: the helper ignoring the input is only half of it if
  // the call site re-introduces the gate with an `if`.
  const src = readFileSync(PANEL_JS, "utf8");
  assert.doesNotMatch(src, /targetTabIsClean/, "the removed gate must not come back");
  const guardAt = src.indexOf("describeRepaintSourceBinding({");
  const callEnd = src.indexOf('}) === "foreign"', guardAt);
  assert.ok(callEnd > guardAt);
  assert.doesNotMatch(
    src.slice(guardAt, callEnd),
    /wasDirty|isModified/,
    "the classification must not consult the dirty flag",
  );
});

test("#1089: absent evidence changes nothing — the #968 residual stays a residual, not a refusal", () => {
  // An UNTAGGED state is the case #968 left open, and this must not manufacture a
  // verdict for it: older frontends and never-stamped canvases behave as before.
  for (const args of [
    { state: taggedState(null), targetUuid: UUID_A },
    { state: { nodes: [] }, targetUuid: UUID_A },
    { state: null, targetUuid: UUID_A },
    { state: undefined, targetUuid: UUID_A },
    // no resolvable identity for the TARGET is equally inconclusive
    { state: taggedState("workflow-B"), targetUuid: null },
    { state: taggedState("workflow-B"), targetUuid: "" },
    // a non-string tag is not a tag
    { state: { extra: { [PANEL_GRAPH_META_KEY]: { workflow_uuid: 7 } } }, targetUuid: UUID_A },
  ]) {
    assert.equal(
      describeRepaintSourceBinding({
        ...args,
        targetClaimsTag: CLAIMS_NOTHING,
        tagOwnedByOtherOpenWorkflow: OTHER_OPEN,
        // clean, so `unknown` here is the ABSENT EVIDENCE talking and not the
        // cleanliness gate standing in for it
      }),
      "unknown",
      `inconclusive input must answer unknown: ${JSON.stringify(args.state)}`,
    );
  }
  assert.equal(describeRepaintSourceBinding(), "unknown", "no arguments at all is inconclusive");
});

test("#1089: a predicate that throws is inconclusive, never a refusal", () => {
  assert.equal(
    describeRepaintSourceBinding({
      state: taggedState("workflow-B"),
      targetUuid: UUID_A,
      targetClaimsTag: () => {
        throw new Error("owner map unreadable");
      },
      tagOwnedByOtherOpenWorkflow: OTHER_OPEN,
    }),
    "unknown",
  );
  assert.equal(
    describeRepaintSourceBinding({
      state: taggedState("workflow-B"),
      targetUuid: UUID_A,
      targetClaimsTag: CLAIMS_NOTHING,
      tagOwnedByOtherOpenWorkflow: () => {
        throw new Error("openWorkflows unreadable");
      },
    }),
    "unknown",
  );
  // Missing predicates are the same story — an unasked question is not an answer.
  assert.equal(
    describeRepaintSourceBinding({
      state: taggedState("workflow-B"),
      targetUuid: UUID_A,
    }),
    "unknown",
  );
});

test("#1089: the open CORRECTS the source instead of refusing — refusing wedges the session", () => {
  // codex NO-SHIP, round 1 (second finding, and the one that killed the approach).
  // Refusing before loadGraphData removes the repaint's root re-stamp, which is the
  // ONE documented heal for a conflicting root tag. The pointer is already on the
  // target while app.graph carries the OTHER workflow's uuid, and there
  // assertGraphBoundToActiveWorkflow refuses every graph_* command — including the
  // panel_load_workflow the refusal recommended (graph_load is a MUTATION, and
  // rootContentProvesActiveWorkflow is false because sealProofExclusive is killed by
  // the real owner being open and clean with a state matching the root). It throws
  // [root-workflow-uuid-mismatch], whose own remedy is "re-open the active workflow
  // tab", which re-enters the refusal. A hard loop, on true positives too.
  const src = readFileSync(PANEL_JS, "utf8");
  const guardAt = src.indexOf("describeRepaintSourceBinding({");
  assert.notEqual(guardAt, -1, "the open path must classify the state it repaints from");
  const loadAt = src.indexOf("await app.loadGraphData(repaintState, true, true, target)");
  assert.notEqual(loadAt, -1);
  assert.ok(guardAt < loadAt, "the source is classified before the load...");

  // ...but the classification must NOT gate the load. The whole defect above is that
  // a refusal here strands the root tag, so this branch may never set rebindFailed.
  // Anchored on the block's own comment, not on the call: the assignment precedes the
  // call, so a slice starting at the call would miss it and pass vacuously.
  const classifyAt = src.indexOf("#1089 — is the state we are about to repaint FROM");
  assert.notEqual(classifyAt, -1);
  assert.ok(classifyAt < loadAt);
  const classifyBlock = src.slice(classifyAt, loadAt);
  assert.doesNotMatch(
    classifyBlock,
    /rebindFailed = new Error\(/,
    "a foreign source must never refuse the open — that removes the root re-stamp and wedges every graph command",
  );
  assert.match(classifyBlock, /sourceForeign =/, "it records the fact instead");

  // The CALL's arguments only. The classification now shares a block with the repaint,
  // which legitimately does use the embedding resolver, so the wider slice cannot carry
  // these assertions.
  const callEnd = src.indexOf('}) === "foreign"', guardAt);
  assert.ok(callEnd > guardAt, "the classification must be a single expression");
  const callBlock = src.slice(guardAt, callEnd);
  // NOT the embedding resolver: `{ embed: true }` writes the identity stamp, which
  // belongs to the repaint, not to a question about the payload it is handed.
  assert.doesNotMatch(callBlock, /workflowStableUuid\(target, \{ embed: true \}\)/);
  assert.match(callBlock, /workflowObjectUuid\(target\) \|\| workflowStableUuid\(target\)/);
  // OPEN, not merely registered — the predecessor-residue escape (see the helper).
  assert.match(callBlock, /openWorkflows/);
  assert.match(callBlock, /sameWorkflowObject\(w, owner\)/);
  // Cleanliness is the PRE-AWAIT snapshot, not a live re-read: clearSpuriousOpenModified
  // force-clears isModified, so `target.isModified` would read clean for a tab that
  // arrived dirty and would authorize the destructive disk re-read over real work.
});

test("#1089: a foreign source must NOT trigger an automatic disk re-read", () => {
  // The second removed remedy. It reused #442's re-read — freeze, section ownership,
  // __cmcpKeepInstance, all of it — and was still wrong, because #442's trigger is
  // "the FILE provably changed since this tab loaded it", which is independent evidence
  // that the disk copy is the newer one. A foreign source tag is no evidence about the
  // file at all, and #874's user-input-only capture means a tab reporting no unsaved
  // edits can still hold node-written values that only exist on the canvas.
  const src = readFileSync(PANEL_JS, "utf8");
  assert.doesNotMatch(src, /reloadWanted/, "the combined reload trigger must be gone");
  assert.doesNotMatch(src, /reloadForForeignSource/);
  // #442's own three branches must be back on their own trigger, untouched.
  assert.match(src, /if \(staleInfo\.reload && !dirtyNow && !wasDirty && priorInteraction === null\)/);
  assert.match(src, /staleInfo\.reload &&\r?\n\s*!dirtyNow &&\r?\n\s*!wasDirty &&\r?\n\s*!ownsWorkflowReloadGuard/);
  assert.match(src, /\} else if \(staleInfo\.reload && !dirtyNow && !wasDirty\) \{/);
  // And `sourceForeign` must reach the reply only — never a load, never a refusal.
  const decl = src.indexOf("sourceForeign =");
  assert.notEqual(decl, -1);
  for (const forbidden of [/sourceForeign[^;\n]*loadGraphData/, /sourceForeign[^;\n]*rebindFailed/]) {
    assert.doesNotMatch(src, forbidden, "a foreign source may neither load nor refuse");
  }
});

test("#1089: the outcome is disclosed on its own key, both when corrected and when not", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const keyAt = src.indexOf("foreign_source_state:");
  assert.notEqual(keyAt, -1, "the caller must be told the state was another workflow's");
  // Its OWN key, OUTSIDE the stale branch. `reloaded` is only surfaced inside
  // `stale === true`, so a re-read triggered by this condition while the file never
  // changed would set it and surface nothing at all — folding this into stale_hint
  // would report a bare success for exactly the case being fixed.
  const staleBranchAt = src.indexOf("...(staleInfo.stale === true");
  assert.notEqual(staleBranchAt, -1);
  assert.ok(keyAt < staleBranchAt, "it must not live inside the stale === true branch");
  // `stale_hint` occurs earlier in the file for unrelated commands, so bound the slice
  // by the next one AFTER this key rather than the first in the file.
  const block = src.slice(keyAt, src.indexOf("stale_hint:", keyAt));
  assert.ok(block.length > 0);
  // It must say what to DO, and the action is a comparison the caller can make — the
  // panel cannot make it (see below), so telling them to verify is the whole remedy.
  assert.match(block, /VERIFY THE GRAPH BEFORE EDITING/);
  assert.match(block, /panel_graph_outline/, "it must name the read that lets them check");
  // It must explain why nothing else on the reply warned. Those fields are TRUE of the
  // tab; that is exactly why the reporter proceeded on them.
  assert.match(block, /is TRUE\b/, "the other fields are true, not broken");
  // MAY, not IS — #817 residue is indistinguishable from a foreign graph, so a definite
  // claim would be an overclaim, and an overclaim here sends people to a destructive load.
  assert.match(block, /MAY be, not IS/);
  assert.match(block, /#817/);
  // The recovery is named WITH its cost, including the #874 trap that a clean-looking
  // tab can still lose node-written values to it.
  assert.match(block, /panel_load_workflow/);
  assert.match(block, /REPLACES the canvas/);
  assert.match(block, /#874/, "the node-written-values trap must be named");
  assert.match(block, /a plain save/, "…and the save-over-the-target trap");
  // It must NOT claim the panel corrected anything: it did not.
  assert.doesNotMatch(block, /RE-READ FROM DISK/);
  assert.doesNotMatch(block, /was therefore/);
});

test("#1089 follow-up: the foreign-source finding rides a FAILING open too", () => {
  // It was only on the success reply. That dropped it on the combination that matters
  // most — an open that ALSO fails content verification — which is exactly what #1111
  // reported: a mismatch WAS announced and the canvas was still the previous
  // workflow's. The content warning says "re-read the graph"; without this it never
  // says the state was another workflow's, which is what makes the re-read look
  // plausible rather than alarming.
  const src = readFileSync(PANEL_JS, "utf8");
  const at = src.indexOf("if (rebindFailed) {");
  assert.notEqual(at, -1, "the failure path must be a block, so the finding can be appended");
  const block = src.slice(at, src.indexOf("throw failOpenRebindUnknown(rebindFailed);", at));
  assert.match(block, /if \(sourceForeign\)/, "the failure path must consult the finding");
  assert.match(block, /ALSO, AND SEPARATELY/, "it must read as a second, independent fact");
  assert.match(block, /LIKELY answer/, "it must reframe the re-read the content warning already advises");
  assert.match(block, /panel_load_workflow/, "the disk recovery is named");
  assert.match(block, /#874/, "…with the node-written-values cost");
  // The pure outcome helper must NOT learn about this: it knows only the four proof
  // parts, and this is a fact about the payload the load was handed.
  const gb = readFileSync(
    fileURLToPath(new URL("../../web/js/lib/graph-binding.js", import.meta.url)),
    "utf8",
  );
  const describeAt = gb.indexOf("export function describeOpenRebindOutcome");
  assert.notEqual(describeAt, -1);
  assert.doesNotMatch(
    gb.slice(describeAt),
    /sourceForeign/,
    "describeOpenRebindOutcome must stay ignorant of the source-state question",
  );
});

// ---------------------------------------------------------------------------
// #1215 — the untagged-root capture residual #968 recorded is CLOSED.
//
// The reporter's sequence: panel_open_workflow on another tab reported
// opened/main, active_matches_target:true and the target's uuid — and
// panel_graph_outline then read an unrelated default canvas with zero shared
// node ids. The open's own checkState() capture had serialized the
// still-mounted PREVIOUS tab's untagged canvas into the target's tracker, and
// the repaint faithfully reproduced it; every proof part passed against the
// poisoned source. "unknown" from describeLiveCanvasBinding no longer admits
// the capture when the pointer just moved, and an untagged repaint source on a
// switched tab is disclosed rather than silently served.
// ---------------------------------------------------------------------------

test("#1215: the pre-switch active workflow is snapshotted BEFORE the pointer moves", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const snapAt = src.indexOf("const activeBefore = activeWorkflowRef();");
  const switchAt = src.indexOf("await s.openWorkflow(target);");
  assert.notEqual(snapAt, -1, "the pre-switch pointer must be snapshotted");
  assert.notEqual(switchAt, -1);
  assert.ok(snapAt < switchAt, "…before openWorkflow, which is what changes the answer");
});

test("#1215: an untagged root admits the capture only in the already-current case", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const gateAt = src.indexOf("const captureBinding = describeLiveCanvasBinding(target);");
  assert.notEqual(gateAt, -1, "the capture must stay gated on the live-canvas binding");
  const captureAt = src.indexOf("checkState?.()", gateAt);
  assert.notEqual(captureAt, -1);
  const gate = src.slice(gateAt, captureAt);
  assert.match(gate, /pointerMovedThisOpen = !sameWorkflowObject\(activeBefore, target\)/);
  // A capture is allowed only when the active pointer did not move. A stale root
  // carrying the target UUID is not independent canvas proof after a tab switch.
  assert.match(gate, /!pointerMovedThisOpen/);
  assert.match(gate, /captureBinding !== "foreign"/);
  assert.doesNotMatch(
    gate,
    /if \(captureBinding !== "foreign"\)/,
    '"not foreign" alone was the #1215 hole — it must not come back',
  );
  assert.match(
    gate,
    /!liveCanvasStillSource\(app\?\.graph\)/,
    "a still-mounted SOURCE canvas must not be captured into TARGET even when bound",
  );
});

test("#1215: an untagged repaint source on a tab switch is DISCLOSED, not silently served", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // The finding needs all three: the pointer moved, the tag-based
  // classification did not fire, and the source state carries no workflow_uuid.
  const classifyAt = src.indexOf('}) === "foreign"');
  assert.notEqual(classifyAt, -1, "the tag-based classification must still be there");
  const at = src.indexOf("sourceUnproven =", classifyAt);
  assert.notEqual(at, -1, "the untagged-source finding must be computed alongside it");
  const stmt = src.slice(at, src.indexOf(";", at));
  assert.match(stmt, /!sourceForeign/, "the foreign finding keeps its own, stronger disclosure");
  assert.match(stmt, /pointerMovedThisOpen/);
  assert.match(stmt, /WORKFLOW_UUID_FIELD/, "the untagged question is about the source state's own stamp");
  // …and it must reach the reply on its own key, like foreign_source_state.
  const keyAt = src.indexOf("unproven_source_state:");
  assert.notEqual(keyAt, -1, "the caller must be told the source carried no resolvable identity");
  assert.match(src.slice(Math.max(0, keyAt - 200), keyAt), /\.\.\.\(sourceUnproven/);
  const block = src.slice(keyAt, src.indexOf("\n    };", keyAt));
  assert.match(block, /VERIFY THE GRAPH BEFORE EDITING/);
  assert.match(block, /panel_graph_outline/, "it must name the read that lets the caller check");
  // MAY, not IS — an untagged state is the normal case for a workflow the panel
  // never stamped, so a definite claim would warn on every such open.
  assert.match(block, /MAY be, not IS/);
  assert.match(block, /is TRUE\b/, "the other fields are true, not broken");
  assert.match(block, /panel_load_workflow/);
  assert.match(block, /REPLACES the canvas/);
  assert.match(block, /#874/, "the node-written-values trap must be named");
  assert.match(block, /a plain save/, "…and the save-over-the-target trap");
});
