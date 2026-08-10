// #945 — `embeddedWorkflowUuid(wf, {allowGraph:false})` is unconditionally null,
// and two fork guards arbitrate a value that never arrives.
//
// The issue ended on the question that decides what the fix is: were
// `wf.extra` / `wf.workflow.extra` / `wf.data.extra` EVER populated by a ComfyUI
// this pack supports, or has the chain been aspirational from the start?
//
// ANSWER: no supported path reaches it. Three pieces of evidence, and one limit
// on how far they generalise (codex: they cannot establish a historical
// universal across every release this pack claims to support — nobody has an
// old frontend in hand to check).
//
//  1. THE CLASS DOES NOT HAVE THOSE FIELDS. ComfyUI 0.31.1 / frontend 1.44.19,
//     read off the shipped bundle:
//
//       class ComfyWorkflow extends <UserFile> {
//         tintCanvasBg; changeTracker = null; _isModified = false;
//         pendingWarnings = null; initialMode; activeMode; shareId;
//         get key(); get activeState(); get initialState();
//         get isLoaded(); get isModified();
//       }
//
//     No `extra`, no `workflow`, no `data`. `activeState` is a GETTER delegating
//     to `changeTracker.activeState` — which is exactly where #945 found the
//     uuid actually living.
//
//  2. THE CHAIN WAS WRITTEN AS A GUESS, not from an observation. It arrived in
//     525116a ("Add workflow-scoped chat identity", #101, 2026-07-22) under the
//     comment "Fall through to workflow-owned metadata variants used by OLDER
//     BUILDS" — a defensive fallback for builds nobody had in front of them.
//
//  3. NOTHING HAS EVER EXERCISED THE NON-NULL BRANCH. No fixture or test double
//     in this repo gives a workflow OBJECT an `extra` — the ones that do are
//     serialized graphs, which is a different thing.
//
// WHAT IS NOT BROKEN, and why this has no user-visible symptom: identity
// persistence does not depend on this chain at all. The loadGraphData wrapper
// stamps the uuid into `graphData.extra` and `rootGraph.extra` carries it on the
// live canvas, which is what a save serializes. An earlier draft of this file
// said the persistence guarantee was unmet; that was wrong (codex).
//
// So this pins the CONTRACT rather than the bug: the helper behaves when a
// carrier is present, the real class shape yields nothing, and the source still
// reads the fields this file models. The "yields nothing" half is deliberately a
// documented observation, not a requirement, so the day someone supplies a real
// carrier the suite does not fight them.
//
// The helpers under test are module-private, so the shapes below are MODELLED
// (codex): the source assertion at the bottom is what ties this file to the
// production chain, and it fails if the chain changes.

import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldForkEmbeddedUuidForLiveOwner,
  shouldForkEmbeddedWorkflowUuid,
} from "../../web/js/lib/workflow-chat-identity.js";

/** The candidate chain, exactly as `workflowOwnedExtra` implements it. */
const workflowOwnedExtra = (wf) => {
  const candidate = wf?.extra || wf?.workflow?.extra || wf?.data?.extra;
  return candidate && typeof candidate === "object" ? candidate : null;
};
const embeddedUuid = (wf) => {
  const ns = workflowOwnedExtra(wf)?.comfyui_mcp;
  const id = ns?.workflow_uuid;
  return typeof id === "string" && id ? id : null;
};

/** The real shape, from ComfyUI 0.31.1 / frontend 1.44.19. `activeState` is a
 *  getter onto the change tracker, which is where the uuid actually lives. */
function realComfyWorkflow(uuid = "ff7890d8-1111-4111-8111-111111111111") {
  const changeTracker = {
    activeState: { extra: { comfyui_mcp: { workflow_uuid: uuid } } },
    initialState: null,
  };
  return {
    path: "workflows/a.json",
    isModified: false,
    changeTracker,
    pendingWarnings: null,
    initialMode: undefined,
    activeMode: null,
    shareId: undefined,
    get activeState() {
      return this.changeTracker?.activeState ?? null;
    },
    get initialState() {
      return this.changeTracker?.initialState ?? null;
    },
  };
}

test("the helper DOES work when a workflow-owned carrier is present", () => {
  // The contract, so a future fix that supplies a carrier has something to
  // satisfy. Each rung of the chain, in order.
  assert.equal(embeddedUuid({ extra: { comfyui_mcp: { workflow_uuid: "a" } } }), "a");
  assert.equal(embeddedUuid({ workflow: { extra: { comfyui_mcp: { workflow_uuid: "b" } } } }), "b");
  assert.equal(embeddedUuid({ data: { extra: { comfyui_mcp: { workflow_uuid: "c" } } } }), "c");
  // …and rejects the shapes that are not a uuid.
  assert.equal(embeddedUuid({ extra: { comfyui_mcp: { workflow_uuid: "" } } }), null);
  assert.equal(embeddedUuid({ extra: { comfyui_mcp: {} } }), null);
  assert.equal(embeddedUuid({ extra: "not-an-object" }), null);
});

test("OBSERVATION (#945): the real ComfyWorkflow shape yields nothing", () => {
  // Recorded, not required. The uuid is genuinely present on this object — it is
  // just not on any rung the chain looks at, so `allowGraph:false` cannot see it.
  const wf = realComfyWorkflow();
  assert.equal(workflowOwnedExtra(wf), null, "no rung of the chain matches the real class");
  assert.equal(embeddedUuid(wf), null);
  // The uuid IS there, one field over. This is the whole of #945 in two lines.
  assert.equal(
    wf.activeState.extra.comfyui_mcp.workflow_uuid,
    "ff7890d8-1111-4111-8111-111111111111",
  );
});

test("so both fork guards are handed null, and decide nothing", () => {
  // They read as live guards. Both call sites pass `embeddedUuid: embedded`,
  // where `embedded` is `embeddedWorkflowUuid(wf, { allowGraph: false })` —
  // permanently null — so both short-circuit on their first line, whatever they
  // were written to prevent. Pinning it makes the dead branch visible in the
  // suite rather than only in a comment.
  //
  // NOTE ON PARAMETER NAMES: an earlier draft of this file passed `embedded:`,
  // which these functions do not read, so the assertions passed for the wrong
  // reason — they were exercising "an argument object with no uuid at all"
  // rather than "the real call site's null". The names below are the real ones.
  assert.equal(
    shouldForkEmbeddedWorkflowUuid({
      objectUuid: null,
      embeddedUuid: null,
      embeddedPath: "workflows/ORIGINAL.json",
      currentPath: "workflows/COPY.json",
      aliases: {},
    }),
    false,
    "a copy that should fork cannot, because the uuid never arrives",
  );
  assert.equal(
    shouldForkEmbeddedUuidForLiveOwner({
      embeddedUuid: null,
      embeddedOwner: { path: "workflows/other.json" },
      identityObject: { path: "workflows/a.json" },
      ownerIsOpenWorkflow: true,
    }),
    false,
    "a live co-open owner cannot force a fork either",
  );
});

test("…and they DO decide the moment a carrier exists: unreached here, not broken", () => {
  // The distinction that matters to whoever restores the carrier: give these the
  // value the call site cannot, and they behave. So fixing the carrier restores
  // real behaviour rather than uncovering a second defect.
  assert.equal(
    shouldForkEmbeddedWorkflowUuid({
      objectUuid: null,
      embeddedUuid: "11111111-1111-4111-8111-111111111111",
      embeddedPath: "workflows/ORIGINAL.json",
      currentPath: "workflows/COPY.json",
      aliases: {},
    }),
    true,
    "an embedded uuid stamped for another path must fork",
  );
  assert.equal(
    shouldForkEmbeddedUuidForLiveOwner({
      embeddedUuid: "11111111-1111-4111-8111-111111111111",
      embeddedOwner: { path: "workflows/other.json" },
      identityObject: { path: "workflows/a.json" },
      ownerIsOpenWorkflow: true,
    }),
    true,
    "a LIVE co-open owner means this is a genuine copy",
  );
});

test("the object-local WRITE is a no-op — but the graph stamp still persists identity", () => {
  // The embed at the same site goes through the same null carrier:
  //
  //   const extra = workflowOwnedExtra(wf);   // null on this frontend
  //   if (extra) { extra[NS] = { workflow_uuid: id } }   // never runs
  //
  // The comment above it promises the identity persists "so a reload of the SAME
  // content keeps it, AND a later SAVE carries it into the saved file". On the
  // real class THIS write cannot land — but the guarantee is still met, by the
  // loadGraphData wrapper stamping `graphData.extra` and by `rootGraph.extra` on
  // the live canvas, which is what a save serializes. An earlier draft claimed
  // neither guarantee held; that was wrong (codex), and the difference is exactly
  // why #945 has no user-visible symptom.
  const wf = realComfyWorkflow();
  const extra = workflowOwnedExtra(wf);
  assert.equal(extra, null, "there is nothing to write into");

  // For contrast: given a carrier, the same write does land.
  const withCarrier = { extra: {} };
  const target = workflowOwnedExtra(withCarrier);
  assert.ok(target, "a real carrier is writable");
  target.comfyui_mcp = { workflow_uuid: "abc" };
  assert.equal(withCarrier.extra.comfyui_mcp.workflow_uuid, "abc");
});

// ── SOURCE ────────────────────────────────────────────────────────────────
// `workflowOwnedExtra` and `embeddedWorkflowUuid` are module-private inside the
// panel bundle, so the checks above necessarily model them. That model is only
// worth anything while it MATCHES, and a copy silently drifting from its
// original is its own defect — so the chain is asserted against the real source.
test("SOURCE: the modelled chain is the one production actually reads", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

  // The exact candidate chain this file reimplements.
  assert.match(
    src,
    /const candidate = wf\?\.extra \|\| wf\?\.workflow\?\.extra \|\| wf\?\.data\?\.extra;/,
    "the carrier chain changed — update the model above, and re-check #945's conclusion",
  );
  // The call site that feeds the fork guards a permanently-null value.
  assert.match(
    src,
    /const embedded = embeddedWorkflowUuid\(wf, \{ allowGraph: false \}\);/,
    "the guards are no longer fed from the workflow-owned carrier",
  );
  // Both guards still read the value under the name the tests use, so a rename
  // cannot make these assertions pass by not applying.
  assert.match(src, /shouldForkEmbeddedWorkflowUuid\(\{[\s\S]{0,200}embeddedUuid: embedded,/);
  assert.match(src, /shouldForkEmbeddedUuidForLiveOwner\(\{[\s\S]{0,200}embeddedUuid: embedded,/);

  // And the OTHER carrier — the one that actually works — is still there, so the
  // "no user-visible symptom" reasoning above stays true.
  assert.match(
    src,
    /graphData\.extra && typeof graphData\.extra === "object"/,
    "the graph-extra stamp is gone — identity persistence may now genuinely be broken",
  );
});
