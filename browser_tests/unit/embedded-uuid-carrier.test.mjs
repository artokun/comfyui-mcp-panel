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
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  sameWorkflowObject,
  shouldForkEmbeddedUuidForLiveOwner,
  shouldForkEmbeddedWorkflowUuid,
} from "../../web/js/lib/workflow-chat-identity.js";

/** The candidate chain, exactly as `workflowOwnedExtra` implements it. This is now
 *  the WRITE-side helper only: the embed write still goes through it, unchanged. */
const workflowOwnedExtra = (wf) => {
  const candidate = wf?.extra || wf?.workflow?.extra || wf?.data?.extra;
  return candidate && typeof candidate === "object" ? candidate : null;
};
/** The READ carrier, exactly as `workflowOwnedExtraForRead` implements it: the same
 *  chain, with `activeState.extra` behind it — and ONLY for a workflow that is not the
 *  mounted one. Ordered so an older build that really does carry one of the three
 *  original fields keeps answering from it. `active` stands in for the module's
 *  `activeWorkflowRef()`. */
const workflowOwnedExtraForRead = (wf, active = null) => {
  const owned = workflowOwnedExtra(wf);
  if (owned) return owned;
  if (!wf || sameWorkflowObject(wf, active)) return null;
  const state = wf?.activeState?.extra;
  return state && typeof state === "object" ? state : null;
};
const uuidFrom = (extra) => {
  const id = extra?.comfyui_mcp?.workflow_uuid;
  return typeof id === "string" && id ? id : null;
};
const embeddedUuid = (wf) => uuidFrom(workflowOwnedExtra(wf));
/** What `embeddedWorkflowUuid(wf, {allowGraph:false})` now resolves. */
const embeddedUuidRead = (wf, active = null) => uuidFrom(workflowOwnedExtraForRead(wf, active));

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

test("OBSERVATION (#945): the original three-rung chain yields nothing", () => {
  // Recorded, not required. The uuid is genuinely present on this object — it is just
  // not on any rung THAT chain looks at. Still true, and still what the WRITE side goes
  // through, which is why the embed write does not land on the workflow object.
  const wf = realComfyWorkflow();
  assert.equal(workflowOwnedExtra(wf), null, "no rung of the original chain matches the real class");
  assert.equal(embeddedUuid(wf), null);
  // The uuid IS there, one field over. This is the whole of #945 in two lines.
  assert.equal(
    wf.activeState.extra.comfyui_mcp.workflow_uuid,
    "ff7890d8-1111-4111-8111-111111111111",
  );
});

test("#945 FIXED: a NON-mounted workflow is reached, where `allowGraph:false` used to be null", () => {
  const wf = realComfyWorkflow();
  // Not the mounted one — see the codex P0 test below for why that distinction is the
  // whole design.
  const mounted = realComfyWorkflow("e66e531b-a4ca-4bee-8a11-12df34b830e2");
  assert.equal(embeddedUuidRead(wf, mounted), "ff7890d8-1111-4111-8111-111111111111");
  // Through the real getter, not a planted own-property: `activeState` delegates to
  // `changeTracker.activeState`, so a build that stops populating the tracker goes back
  // to null rather than to a stale value.
  wf.changeTracker.activeState = null;
  assert.equal(embeddedUuidRead(wf, mounted), null, "no tracker state → no identity, not a guess");

  // Same SHAPE check as the original chain, so the two rungs cannot disagree about what
  // counts as a carrier. A non-object here reads as no carrier rather than being handed
  // on: today a string would fall out as null one line later anyway, but that is the
  // reader's accident, not this function's contract.
  for (const bad of ["not-an-object", 42, true]) {
    assert.equal(workflowOwnedExtraForRead({ activeState: { extra: bad } }, mounted), null, String(bad));
  }
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(src, /const state = wf\?\.activeState\?\.extra;\r?\n\s*return state && typeof state === "object" \? state : null;/, "production applies the same check");
});

test("#945 the original rungs still WIN — the new one only fills the gap", () => {
  // Order matters: a build that really does carry `wf.extra` must keep answering from
  // it. Putting `activeState` first would silently change which field decides on any
  // frontend where both exist, and they can disagree.
  const wf = realComfyWorkflow("from-active-state-1111-4111-8111-111111111111");
  wf.extra = { comfyui_mcp: { workflow_uuid: "from-wf-extra" } };
  // Mounted OR not: the original rungs are consulted first either way, so this holds
  // even for the workflow on screen.
  assert.equal(embeddedUuidRead(wf, wf), "from-wf-extra");
  assert.equal(embeddedUuidRead(wf, null), "from-wf-extra");
  delete wf.extra;
  assert.equal(embeddedUuidRead(wf, null), "from-active-state-1111-4111-8111-111111111111");
});

test("#945 (codex P0) the MOUNTED workflow is refused — its activeState IS the canvas", () => {
  // The finding that reshaped this fix. `activeState` is a getter onto
  // `changeTracker.activeState`, and for the workflow currently mounted the tracker
  // fills it from `captureCanvasState()`, which clones `app.rootGraph.serialize()`.
  // Reading it there would answer `allowGraph:false` with the mounted root's identity —
  // the exact authority that flag exists to refuse — and nothing would look wrong.
  //
  // My measurement missed it: with three workflows open, the two NON-ACTIVE rows carried
  // their own uuids (30dfba50…, 2d7fa288…) and the ACTIVE row matched `app.graph.extra`
  // (e66e531b…). That reads as 'distinct from the canvas' only if you skip the active row.
  const active = realComfyWorkflow("e66e531b-a4ca-4bee-8a11-12df34b830e2");
  assert.equal(
    embeddedUuidRead(active, active),
    null,
    "the mounted workflow gets no answer from this carrier, exactly as before the fix",
  );
  // An UNSPECIFIED workflow defaults to the active one in production, so it lands here too.
  assert.equal(embeddedUuidRead(null, active), null);
  assert.equal(embeddedUuidRead(undefined, active), null);
});

test("#945 (codex r2) a Vue PROXY of the mounted workflow is still refused", () => {
  // The exclusion cannot use `===`. The workflow service hands out reactive PROXIES in
  // its computed lists while raw objects flow through the uuid stores, and the active
  // binding path unwraps deliberately: the graph fence calls
  // `workflowOwnsRootUuidTag(activeWorkflowRef())`, which re-enters this reader with
  // `rawWorkflowObject(w)`. A strict comparison against the proxy is FALSE for the
  // mounted workflow's own raw target — so the canvas state walks back in through the
  // door the exclusion was supposed to close, on the one path that matters most.
  const raw = realComfyWorkflow("e66e531b-a4ca-4bee-8a11-12df34b830e2");
  const proxy = new Proxy(raw, {
    get: (t, k) => (k === "__v_raw" ? t : Reflect.get(t, k, t)),
  });
  assert.notEqual(proxy, raw, "the shapes really are different objects");
  assert.equal(
    embeddedUuidRead(raw, proxy),
    null,
    "raw target vs proxy active — the exact shape the fence produces",
  );
  assert.equal(embeddedUuidRead(proxy, raw), null, "and the reverse");
  // A DIFFERENT workflow that merely looks similar is still answered — the refusal is
  // identity, not a blanket refusal of anything proxy-shaped.
  const other = realComfyWorkflow("30dfba50-4c01-4c40-a4c2-72a47e12269c");
  assert.equal(embeddedUuidRead(other, proxy), "30dfba50-4c01-4c40-a4c2-72a47e12269c");
});

test("#945 (codex r2) two references sharing a changeTracker are the same workflow", () => {
  // `activeState` reads THROUGH `changeTracker`, so two references to the same tracker
  // cannot meaningfully disagree about whether it is mounted. sameWorkflowObject already
  // treats that as identity; relying on it is what makes this exclusion total.
  const raw = realComfyWorkflow("e66e531b-a4ca-4bee-8a11-12df34b830e2");
  const twin = { path: raw.path, changeTracker: raw.changeTracker, get activeState() { return this.changeTracker?.activeState ?? null; } };
  assert.equal(sameWorkflowObject(twin, raw), true, "shared tracker is shared identity");
  assert.equal(embeddedUuidRead(twin, raw), null, "so the mounted canvas is refused here too");
});

test("#945 a NON-mounted workflow is answered from its own capture", () => {
  // Its tracker state is the capture from when it was last live, which no mounted root
  // is consulted for. That is a workflow-owned answer, and it is what revives the guards.
  const active = realComfyWorkflow("e66e531b-a4ca-4bee-8a11-12df34b830e2");
  const background = realComfyWorkflow("30dfba50-4c01-4c40-a4c2-72a47e12269c");
  assert.equal(embeddedUuidRead(background, active), "30dfba50-4c01-4c40-a4c2-72a47e12269c");
  assert.notEqual(embeddedUuidRead(background, active), embeddedUuidRead(active, active));
  // And with no active workflow at all, a workflow still answers for itself.
  assert.equal(embeddedUuidRead(background, null), "30dfba50-4c01-4c40-a4c2-72a47e12269c");
});

test("#945 the WRITE was deliberately not repointed", () => {
  // Embedding into `activeState.extra` moves where identity PERSISTS — it stops reaching
  // `app.graph.extra`, which is what a save serializes — and was reverted once for
  // exactly that. Reading a field is not writing it, so the revert's reason survives this
  // change. Pinned on the source, since that is the only place the asymmetry is visible.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const uuidFn = src.slice(
    src.indexOf("function embeddedWorkflowUuid("),
    src.indexOf("function persistWorkflowAliases("),
  );
  assert.match(uuidFn, /workflowOwnedExtraForRead\(wf\)/, "both readers use the extended carrier");
  assert.equal(
    (uuidFn.match(/workflowOwnedExtraForRead\(wf\)/g) ?? []).length,
    2,
    "uuid AND path — reading them from different carriers could answer about two workflows",
  );
  // Every place that MUTATES what it got back still uses the original chain.
  assert.ok(src.includes("const extra = workflowOwnedExtra(wf);"), "write site unchanged");
  assert.ok(
    !/const extra = workflowOwnedExtraForRead\(wf\);[\s\S]{0,400}?extra\[WORKFLOW_META_NAMESPACE\] =/.test(src),
    "nothing writes into the read carrier",
  );
});

test("BEFORE #945: handed null, both fork guards decide nothing", () => {
  // Kept as the null CONTRACT, not as a description of the frontend any more. Both
  // call sites pass `embeddedUuid: embedded`, and before this fix `embedded` was
  // permanently null on the observed frontend, so both short-circuited on their first
  // line whatever they were written to prevent. With the read carrier extended they
  // now receive the workflow's own uuid — see the FIXED test above — but null must
  // still be answered this way on a build that genuinely carries no identity.
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
  // The call site that feeds the fork guards. No longer permanently null (#945): the
  // read carrier behind it now reaches `activeState.extra`, which is where the uuid is.
  assert.match(
    src,
    /const embedded = embeddedWorkflowUuid\(wf, \{ allowGraph: false \}\);/,
    "the guards are no longer fed from the workflow-owned carrier",
  );
  // …and the read carrier itself, which this file reimplements as
  // `workflowOwnedExtraForRead`. Its ORDER is the assertion that matters: the original
  // three rungs first, `activeState.extra` only behind them — a build carrying both
  // would otherwise start deciding on a different field without anything failing.
  assert.match(
    src,
    /const owned = workflowOwnedExtra\(wf\);\r?\n\s*if \(owned\) return owned;[\s\S]{0,400}?if \(!wf \|\| sameWorkflowObject\(wf, active\)\) return null;\r?\n\s*const state = wf\?\.activeState\?\.extra;/,
    "the read carrier's order changed — re-check which field decides identity",
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
