// #945 — `embeddedWorkflowUuid(wf, {allowGraph:false})` is unconditionally null,
// and two fork guards arbitrate a value that never arrives.
//
// The issue ended on the question that decides what the fix is: were
// `wf.extra` / `wf.workflow.extra` / `wf.data.extra` EVER populated by a ComfyUI
// this pack supports, or has the chain been aspirational from the start?
//
// ANSWER: aspirational, on all the evidence available here.
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
// So this file pins the CONTRACT rather than the bug. It asserts the helper
// behaves correctly when a carrier is present, and separately records that the
// real frontend shape yields nothing — the second half deliberately as a
// documented observation, not as a requirement, so that the day someone gives
// these functions a real carrier the suite does not fight them.

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

test("…and they DO decide, the moment a carrier exists — they are unreachable, not broken", () => {
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

test("the WRITE is a no-op too — a documented guarantee that never happens", () => {
  // The embed at the same site goes through the same null carrier:
  //
  //   const extra = workflowOwnedExtra(wf);   // null on this frontend
  //   if (extra) { extra[NS] = { workflow_uuid: id } }   // never runs
  //
  // The comment above it promises the identity persists "so a reload of the SAME
  // content keeps it, AND a later SAVE carries it into the saved file across the
  // tmp:->wf: transition". On the real class that write cannot land, so neither
  // guarantee holds. This is the half of #945 with a user-visible consequence.
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
