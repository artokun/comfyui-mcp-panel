/**
 * #995 — after a tab switch (or a reconnect in the same interval) the live canvas keeps
 * the PREVIOUS workflow's identity tag, and `panel_graph_outline` refuses the active
 * canvas with `[root-workflow-uuid-mismatch]` while `panel_list_workflows` independently
 * confirms the intended workflow active.
 *
 * The reporter concluded it was already fixed upstream by #817/#843, which added
 * `contentProvesActiveWorkflow` to `resolveGraphRootUuidRebind`. Re-running those
 * predicates under BOTH halves of their own stated conditions on 0.11.96:
 *
 *   dirty=false   contentProof=true    verdict=rebind      <- the escape they credit
 *   dirty=true    contentProof=false   verdict=conflict    <- the state they reported
 *
 * Their report says "The active workflow was modified", and
 * `rootContentProvesActiveWorkflow` bails on `isModified === true`.
 *
 * REPRODUCED LIVE through UI clicks on ComfyUI 0.31.1 / frontend 1.48.7 — a modified
 * workflow, a canvas the panel's own comparison proves is that workflow's, and the
 * previous workflow's tag still on the root:
 *
 *   active workflow                             probe995.json, isModified true
 *   root tag                                    e66e531b…  (another workflow's)
 *   graphRootWorkflowUuidMismatches             true
 *   rootContentProvesActiveWorkflow             false      <- only the dirty bail
 *   graphRootMatchesState(root, tracker state)  TRUE
 *   resolveGraphRootUuidRebind                  "conflict" -> every graph tool refused
 *
 * The clean-tab requirement exists because a dirty tracker can LAG the canvas (#545) —
 * but a lagging snapshot makes an equality test FAIL, not falsely succeed. What a dirty
 * tab genuinely costs is the TWIN comparison, so the relaxed proof takes a stricter
 * exclusivity where a dirty twin disqualifies instead of being skipped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  contentProofExclusiveAmongOpen,
  rootContentProvesActiveWorkflowDespiteEdits,
  rootContentProvesActiveWorkflow,
  resolveGraphRootUuidRebind,
  graphCommandBindingBar,
} from "../../web/js/lib/graph-binding.js";

const STALE = "aaaaaaaa-1111-4111-8111-111111111111";
const ACTIVE = "6548a06c-8244-4523-b44c-d03d505d04e7";

const state = (n, tweak = {}) => ({
  nodes: Array.from({ length: n }, (_, i) => ({ id: i + 1, type: "KSampler", pos: [0, 0], size: [200, 100] })),
  links: [],
  groups: [],
  config: {},
  extra: {},
  ...tweak,
});
/** A root that serialises to `s`, carrying the PREVIOUS workflow's tag. */
const rootOf = (s, tag = STALE) => ({
  _nodes: s.nodes,
  extra: { comfyui_mcp: { workflow_uuid: tag } },
  serialize: () => ({ ...s, extra: { ...(s.extra ?? {}), comfyui_mcp: { workflow_uuid: tag } } }),
});
const workflow = (s, { modified = true } = {}) => ({
  isModified: modified,
  changeTracker: { activeState: s },
});

test("#995 the reported state: a MODIFIED tab whose canvas is provably its own", () => {
  const s = state(3);
  const root = rootOf(s);
  const active = workflow(s, { modified: true });
  // What ships today, and why the report was not fixed by #817/#843.
  assert.equal(
    rootContentProvesActiveWorkflow({ rootGraph: root, activeWorkflow: active, proofExclusive: true }),
    false,
    "the clean-only proof refuses a dirty tab",
  );
  // The relaxed proof, with the stricter exclusivity satisfied (no other tabs open).
  const proof = rootContentProvesActiveWorkflowDespiteEdits({
    rootGraph: root,
    activeWorkflow: active,
    proofExclusive: contentProofExclusiveAmongOpen({ rootGraph: root, others: [] }),
  });
  assert.equal(proof, true, "…and the relaxed one proves the content matches");
  // What that licenses is a READ, not a rebind: the panel clears the mismatch for the
  // call and leaves the tag alone. Feeding this proof to the REBIND resolver — which
  // re-stamps — is exactly the P1 the review caught, so the panel does not do it.
  assert.equal(
    resolveGraphRootUuidRebind({ rootGraph: root, activeWorkflowUuid: ACTIVE, contentProvesActiveWorkflow: false }),
    "conflict",
    "the re-stamp path is not reached on dirty-tab evidence",
  );
});

test("#995 a canvas that is NOT the active workflow's stays refused", () => {
  // The fence's whole job. A root holding different content must never be proven,
  // however dirty or clean anything is.
  const root = rootOf(state(5));
  const active = workflow(state(3));
  assert.equal(
    rootContentProvesActiveWorkflowDespiteEdits({ rootGraph: root, activeWorkflow: active, proofExclusive: true }),
    false,
  );
  assert.equal(
    resolveGraphRootUuidRebind({ rootGraph: root, activeWorkflowUuid: ACTIVE, contentProvesActiveWorkflow: false }),
    "conflict",
  );
});

test("#995 a DIRTY TWIN disqualifies the proof — it cannot be skipped as it is for a clean tab", () => {
  // The ordinary exclusivity check skips a dirty twin ("unprovable, not evidence of
  // ambiguity"), which is safe only while the ACTIVE side must be clean. With both sides
  // possibly dirty, a twin holding the same content would be invisible and the panel
  // could re-stamp the active identity onto the TWIN's canvas — wedging that tab.
  const s = state(3);
  const root = rootOf(s);
  const dirtyTwin = workflow(s, { modified: true });
  assert.equal(
    contentProofExclusiveAmongOpen({ rootGraph: root, others: [dirtyTwin] }),
    false,
    "a modified other tab makes exclusivity unprovable",
  );
  // A CLEAN twin with different content is fine; a clean twin with the SAME content is not.
  assert.equal(contentProofExclusiveAmongOpen({ rootGraph: root, others: [workflow(state(9), { modified: false })] }), true);
  assert.equal(contentProofExclusiveAmongOpen({ rootGraph: root, others: [workflow(s, { modified: false })] }), false);
});

test("#995 an unreadable or absent tab list is NOT exclusivity", () => {
  const root = rootOf(state(3));
  for (const others of [null, undefined, "nope", 42, {}]) {
    assert.equal(contentProofExclusiveAmongOpen({ rootGraph: root, others }), false, JSON.stringify(others) ?? "undefined");
  }
  // A tab whose own state cannot be read proves nothing either.
  assert.equal(contentProofExclusiveAmongOpen({ rootGraph: root, others: [{ isModified: false }] }), false);
  assert.equal(contentProofExclusiveAmongOpen({ rootGraph: root, others: [null] }), false);
});

test("#995 (the #565 gate) an EMPTY canvas can never prove itself, however it is compared", () => {
  // Every blank graph serialises alike, so equality says nothing about WHOSE canvas this
  // is — a dirty blank twin is exactly as plausible an owner, and re-stamping would wedge
  // that tab. Caught by the existing gate, not by reasoning about it.
  const empty = state(0);
  const root = rootOf(empty);
  assert.equal(
    rootContentProvesActiveWorkflowDespiteEdits({
      rootGraph: root,
      activeWorkflow: workflow(empty),
      proofExclusive: contentProofExclusiveAmongOpen({ rootGraph: root, others: [] }),
    }),
    false,
    "an empty root is not identified by being empty",
  );
});

test("#995 a SUBGRAPH scope is never proven — the root canvas is a different question", () => {
  const s = state(3);
  assert.equal(
    rootContentProvesActiveWorkflowDespiteEdits({
      rootGraph: rootOf(s),
      activeWorkflow: workflow(s),
      inSubgraph: true,
      proofExclusive: true,
    }),
    false,
  );
});

test("#995 the relaxed proof is total — hostile inputs answer false, never throw", () => {
  const s = state(2);
  const hostile = {
    get serialize() {
      throw new Error("boom");
    },
  };
  assert.doesNotThrow(() => rootContentProvesActiveWorkflowDespiteEdits({ rootGraph: hostile, activeWorkflow: workflow(s), proofExclusive: true }));
  assert.equal(rootContentProvesActiveWorkflowDespiteEdits({ rootGraph: hostile, activeWorkflow: workflow(s), proofExclusive: true }), false);
  assert.equal(rootContentProvesActiveWorkflowDespiteEdits(), false);
  assert.equal(rootContentProvesActiveWorkflowDespiteEdits({ rootGraph: rootOf(s), activeWorkflow: null, proofExclusive: true }), false);
  assert.equal(
    rootContentProvesActiveWorkflowDespiteEdits({ rootGraph: rootOf(s), activeWorkflow: { isModified: true }, proofExclusive: true }),
    false,
    "a workflow with no readable tracker state proves nothing",
  );
  assert.doesNotThrow(() => contentProofExclusiveAmongOpen({ rootGraph: rootOf(s), others: [hostile] }));
  assert.equal(contentProofExclusiveAmongOpen(), false);
});

test("#995 exclusivity is REQUIRED — the proof never fires on its own", () => {
  const s = state(3);
  assert.equal(
    rootContentProvesActiveWorkflowDespiteEdits({ rootGraph: rootOf(s), activeWorkflow: workflow(s), proofExclusive: false }),
    false,
  );
});

test("#995 (codex P1) source guard: READS only, and NOTHING is written", () => {
  // Equality against a dirty tab's snapshot cannot establish whose canvas this is — two
  // tabs can hold the same content, the snapshot can lag, and the owner may not be in
  // `openWorkflows` at that instant. Re-stamping on that evidence would move the error
  // onto the OTHER workflow and the wedge would follow the user back to it. So the flag
  // is cleared for one call and the tag is left alone.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const escape = src.slice(src.indexOf("if (rootUuidMismatch && staleTagReadBypass === true)"));
  assert.ok(escape, "the escape must be gated on the command being read-only");
  const body = escape.slice(0, escape.indexOf("\n  }"));
  assert.match(body, /rootContentProvesActiveWorkflowDespiteEdits\(\{/, "it uses the relaxed proof");
  assert.match(body, /proofExclusive: contentProofExclusiveAmongOpen\(\{ rootGraph, others \}\)/, "with STRICT exclusivity");
  assert.match(body, /rootUuidMismatch = false; \/\/ this call only/, "and clears the flag for this call");
  assert.ok(!/stampGraphRootWorkflowUuid/.test(body), "it must NOT write the tag — that is the P1 hole");
  // `others` must stay null when the tab list cannot be read: an empty array would read
  // as "no other tabs" and make exclusivity vacuously true.
  assert.match(body, /let others = null;/, "unreadable enumeration must not become an empty list");
  assert.match(body, /if \(Array\.isArray\(open\)\) others = open\.filter/, "only a readable list is used");
  // The REBIND path keeps the clean-only proof: it re-stamps, which this evidence
  // cannot license.
  const rebind = src.slice(src.indexOf("resolveGraphRootUuidRebind({"), src.indexOf("if (rootUuidMismatch && staleTagReadBypass"));
  assert.ok(!/DespiteEdits/.test(rebind), "the re-stamp must not run on dirty-tab evidence");
});

test("#995 (codex r2) the bypass is OPT-IN, never inferred from the absence of a flag", () => {
  // `requireDirtyMutationBinding !== true` was default-permit: a caller that omits the
  // flag, or any fence call added later without the classification, would have inherited
  // a bypass nobody decided to give it. The gate is now positive, set in exactly one
  // place, so the read-only command list is the whole surface that can reach it.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.ok(
    src.includes("if (rootUuidMismatch && staleTagReadBypass === true) {"),
    "the bypass is opt-IN",
  );
  assert.ok(
    !src.includes("rootUuidMismatch && requireDirtyMutationBinding !== true"),
    "a default-permit gate must not come back",
  );
  assert.match(src, /staleTagReadBypass = false,/, "and it defaults to OFF at the fence");
  assert.equal(graphCommandBindingBar("graph_outline").staleTagReadBypass, true, "a read opts in");
  assert.equal(graphCommandBindingBar("graph_add_node").staleTagReadBypass, undefined, "a mutation never does");
  // The bar is the ONLY place that sets it, so a new fence call cannot acquire it by
  // accident — it has to be classified read-only first.
  const lib = readFileSync(new URL("../../web/js/lib/graph-binding.js", import.meta.url), "utf8");
  assert.equal((lib.match(/staleTagReadBypass: true/g) ?? []).length, 1, "set in exactly one place");
});

test("#995 the SEAL path is untouched — writing a tag is a different decision from re-stamping one", () => {
  const src = readFileSync(new URL("../../web/js/lib/graph-binding.js", import.meta.url), "utf8");
  const seal = src.slice(src.indexOf("export function sealProvenRootBinding"));
  assert.match(seal, /rootContentProvesActiveWorkflow\(\{ rootGraph, activeWorkflow, inSubgraph, proofExclusive \}\)/);
  assert.ok(
    !/rootContentProvesActiveWorkflowDespiteEdits/.test(seal),
    "the seal must keep the clean-only bar: it writes onto an UNTAGGED root",
  );
});
