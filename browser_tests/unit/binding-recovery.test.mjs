/**
 * Unit tests for the binding-wedged-no-recovery cluster (panel #606 / #607, on the
 * tree that absorbed #621):
 *
 *   #606 — a panel-created blank tab could wedge behind the binding guard after a
 *     reconnect: ComfyUI reuses app.graph across tabs and clear/configure does NOT
 *     reset graph.extra, so the new tab inherited the PREVIOUS workflow's root tag;
 *     with its ChangeTracker not yet PROVEN empty the both-empty heal could not fire,
 *     and nothing re-stamped the root. workflow_new now stamps the root at creation,
 *     and only when the root is PROVEN content-free.
 *
 *     The branch's second half — re-stamping the tag after a repaint whose tag "did
 *     not ride" — is deliberately NOT shipped; see the section comment below. main's
 *     single-use open-proof marker made it unnecessary, and the evidence it would
 *     have been licensed by could not tell "did not match" from "could not be read".
 *
 *   #607 — a fence refusal ("workflow instance mismatch") meant the orchestrator's
 *     cached stamp was stale relative to the panel's LIVE identity, yet the advertised
 *     recovery never reached that cache: the panel re-hellos (the frame the
 *     orchestrator re-stamps from) when the refusal fires — BOUNDED per identity, and
 *     spending its budget only on hellos that reached the wire.
 *
 * The harnesses extract the SHIPPING code from the panel monolith and drive it with
 * injected doubles, so the tests are about the code that actually runs (delete the
 * stamp / the bound / the hook call and the matching test fails).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  graphRootProvenEmpty,
  activeWorkflowProvenEmpty,
  graphRootWorkflowUuidMatches,
  graphRootMatchesState,
} from "../../web/js/lib/graph-binding.js";
import { commandTargetsActiveWorkflow } from "../../web/js/lib/workflow-chat-identity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

/** Balanced extraction starting at a marker's first "{", ignoring nothing fancy
 *  (the extracted regions contain no template braces outside code). `openAt` skips
 *  ahead when the marker itself contains braces (e.g. a `({ rid } = {})` param). */
function balancedFrom(src, marker, openAt = null) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `missing marker: ${marker}`);
  const open = openAt ?? src.indexOf("{", start + marker.length);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i += 1; i < src.length; i += 1) {
        if (src[i] === "\\") {
          i += 1;
          continue;
        }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated block: ${marker}`);
}

// ---------------------------------------------------------------------------
// #606 fix 1 — workflow_new stamps the root tag at creation (proven-empty gate)
// ---------------------------------------------------------------------------

function buildWorkflowNew({
  rootGraph,
  activeWorkflow,
  stableUuid = "uuid-new-tab",
  onStamp = () => {},
} = {}) {
  // The extracted method source, converted from object-method to standalone form.
  // The body brace is located via ") {" because the signature itself carries
  // braces ("{ rid } = {}").
  const sigStart = SRC.indexOf("async workflow_new({");
  assert.notEqual(sigStart, -1, "workflow_new not found");
  const bodyBrace = SRC.indexOf(") {", sigStart) + 1;
  const methodSource = balancedFrom(SRC, "async workflow_new({", bodyBrace).replace(
    /^async workflow_new\(/,
    "async function workflow_new(",
  );
  const factory = new Function(
    "app",
    "activeWorkflowRef",
    "workflowTabId",
    "workflowStableUuid",
    "noteOpenAttempt",
    "coerceMessageText",
    "getWorkflowTitle",
    "graphRootProvenEmpty",
    "activeWorkflowProvenEmpty",
    "stampGraphRootWorkflowUuid",
    "backendReconnectEpoch",
    "activeWorkflowResyncEpoch",
    "isCanonicalWorkflowInstanceUuid",
    `${methodSource}\nreturn workflow_new;`,
  );
  return factory(
    { graph: rootGraph, extensionManager: { command: { execute: async () => {} } } },
    () => activeWorkflow,
    () => "tmp:new-tab",
    () => stableUuid,
    () => ({ seq: 1 }),
    (e) => String(e),
    () => "Unsaved Workflow",
    graphRootProvenEmpty,
    activeWorkflowProvenEmpty,
    onStamp,
    1,
    0,
    realIsCanonicalWorkflowInstanceUuid,
  );
}

/** The REAL canonical-uuid gate from the shipped source — never a second spelling
 *  of the regex here (#640). */
const realIsCanonicalWorkflowInstanceUuid = new Function(
  `${balancedFrom(SRC, "function isCanonicalWorkflowInstanceUuid(value)")}
return isCanonicalWorkflowInstanceUuid;`,
)();

const EMPTY_SERIALIZE = () => ({ nodes: [], links: [], extra: { ds: { offset: [0, 0], scale: 1 } } });

test("#606 workflow_new stamps the fresh tab's identity onto a proven-empty root", async () => {
  const rootGraph = { _nodes: [], extra: {}, serialize: EMPTY_SERIALIZE };
  const wf = { isPersisted: false, isModified: false, changeTracker: { activeState: { nodes: [] } } };
  const stamps = [];
  const workflow_new = buildWorkflowNew({
    rootGraph,
    activeWorkflow: wf,
    onStamp: (root, uuid, owner) => stamps.push([root, uuid, owner]),
  });
  const out = await workflow_new({ rid: "r1" });
  assert.equal(out.created, true);
  assert.equal(out.empty, true, "#708 — the proof that licensed the stamp also licenses the claim");
  assert.equal(out.routing_key, "tmp:new-tab");
  assert.equal(stamps.length, 1, "the creation stamp must fire exactly once");
  assert.equal(stamps[0][0], rootGraph, "stamps the LIVE root");
  assert.equal(stamps[0][1], "uuid-new-tab", "stamps the NEW tab's identity");
  assert.equal(stamps[0][2], wf, "records the new workflow as the tag owner");
});

test("#606 workflow_new does NOT stamp a root that still holds content (fail closed)", async () => {
  const rootGraph = {
    _nodes: [{ id: 1, type: "KSampler" }],
    extra: { comfyui_mcp: { workflow_uuid: "uuid-OLD-tab" } },
    serialize: () => ({ nodes: [{ id: 1, type: "KSampler" }] }),
  };
  const wf = { isPersisted: false, isModified: false, changeTracker: { activeState: { nodes: [] } } };
  const stamps = [];
  const workflow_new = buildWorkflowNew({
    rootGraph,
    activeWorkflow: wf,
    onStamp: (...args) => stamps.push(args),
  });
  const out = await workflow_new({ rid: "r1" });
  // #708 — the tab and its routing identity are real, but "blank" was never proven,
  // so the acknowledgement must not claim it (see the ack tests in
  // new-workflow-persistence.test.mjs for the full contract).
  assert.equal(out.created, "unknown", "an unproven canvas is not a confirmed blank tab");
  assert.equal(out.routing_key, "tmp:new-tab", "the routing identity is still returned");
  assert.equal(stamps.length, 0, "no re-tagging a root with foreign content");
});

test("#606 workflow_new does NOT stamp when the NEW workflow is not itself proven empty (codex P0)", async () => {
  // An empty ROOT is not proof the root BELONGS to the new tab: ComfyUI shares
  // app.graph, so a frontend that surfaced the new workflow as active while the
  // canvas still held a DIFFERENT (also blank) tab looks identical here. The bar
  // is therefore #565's, both sides proven content-free — dropping the workflow
  // half would stamp the new uuid over the other tab's correct binding and point
  // the next mutation at the wrong workflow.
  const rootGraph = { _nodes: [], extra: { comfyui_mcp: { workflow_uuid: "uuid-OTHER-tab" } }, serialize: EMPTY_SERIALIZE };
  // A tracker that cannot yet PROVE the new tab is empty (the #606 window itself).
  for (const wf of [
    { isPersisted: false, isModified: false },                                   // no tracker at all
    { isPersisted: false, isModified: false, changeTracker: {} },                // no state
    { isPersisted: false, isModified: true, changeTracker: { activeState: { nodes: [] } } }, // dirty ⇒ tracker may lag
    { isPersisted: false, isModified: false, changeTracker: { activeState: { nodes: [{ id: 1, type: "KSampler" }] } } },
  ]) {
    const stamps = [];
    const workflow_new = buildWorkflowNew({ rootGraph, activeWorkflow: wf, onStamp: (...a) => stamps.push(a) });
    const out = await workflow_new({ rid: "r1" });
    assert.equal(out.created, "unknown", "#708 — an unprovable tab is reported as outcome-unknown");
    assert.equal(out.routing_key, "tmp:new-tab", "the tab was still created and is addressable");
    assert.equal(stamps.length, 0, "an unprovable workflow side must not license the stamp");
  }
  assert.equal(
    rootGraph.extra.comfyui_mcp.workflow_uuid,
    "uuid-OTHER-tab",
    "the other tab's binding survives untouched",
  );
});

test("#606 workflow_new does NOT stamp an unserializable root, and a throwing stamp never breaks creation", async () => {
  const wf = { isPersisted: false, isModified: false, changeTracker: { activeState: { nodes: [] } } };
  // Unserializable root: proven-empty fails closed → no stamp.
  const noSerializer = { _nodes: [], extra: {} };
  const stamps = [];
  const workflow_new = buildWorkflowNew({
    rootGraph: noSerializer,
    activeWorkflow: wf,
    onStamp: (...args) => stamps.push(args),
  });
  assert.equal((await workflow_new({ rid: "r1" })).created, "unknown", "#708 — unserializable root ⇒ unproven");
  assert.equal(stamps.length, 0);
  // A stamp that throws: creation still reports success (the guard simply keeps its say).
  const rootGraph = { _nodes: [], extra: {}, serialize: EMPTY_SERIALIZE };
  const workflow_new_throwing = buildWorkflowNew({
    rootGraph,
    activeWorkflow: wf,
    onStamp: () => {
      throw new Error("root refuses the tag");
    },
  });
  // #708 — the emptiness proof is evaluated BEFORE the stamp and in its own guard, so a
  // stamp that throws is identity bookkeeping failing, never evidence the tab has content.
  const thrown = await workflow_new_throwing({ rid: "r2" });
  assert.equal(thrown.created, true);
  assert.equal(thrown.empty, true);
});

// ---------------------------------------------------------------------------
// #606/#560 fix 2 — the workflow_open repaint re-stamp, DELIBERATELY NOT SHIPPED.
//
// This branch originally repaired the root's identity tag after a repaint whose
// tag "did not ride" loadGraphData, licensing that write off `!rootMatchedBeforeLoad`
// — a value that is ALSO false when the pre-load comparison could not be READ at
// all. An unreadable comparison would have become a positive licence to stamp the
// target's uuid onto a canvas the load never touched: #349's wrong-canvas hole,
// reopened by the very family of fixes that exists to keep it shut.
//
// main meanwhile landed the POSITIVE form of the same proof. workflow_open mints a
// single-use marker per attempt and writes it into the payload's own `extra`,
// beside the workflow uuid; ComfyUI's `configure()` replaces `graph.extra`
// wholesale from the data it is handed, so nothing but THAT payload can put the
// marker on the live root. The repair is then unnecessary by construction: both
// fields ride in the same object literal, so a root carrying this attempt's marker
// necessarily carries its uuid too, and a root carrying neither is not "a tag that
// failed to ride" — it is an unproven load, which stays an honest refusal.
//
// The two tests below lock exactly what keeps the repair unnecessary, so a later
// refactor can neither split the fields apart nor reintroduce a post-load stamp.
// ---------------------------------------------------------------------------

/** The `repaintState.extra = { … }` assignment workflow_open hands to loadGraphData. */
function repaintPayloadExtraSource() {
  return balancedFrom(SRC, "repaintState.extra = {");
}

/** Everything from the load call to the end of the repaint try/catch: the region
 *  that observes the result and decides the verdict. */
function postLoadProofSource() {
  const start = SRC.indexOf("await app.loadGraphData(repaintState");
  assert.notEqual(start, -1, "workflow_open repaint load not found");
  const end = SRC.indexOf("\n        } catch (err) {", start);
  assert.notEqual(end, -1, "repaint try/catch end not found");
  return SRC.slice(start, end);
}

test("#606 workflow_open: the identity tag and the single-use marker ride the SAME payload object", () => {
  // Why this is the whole argument against a post-load re-stamp: if the marker
  // reached the root, the uuid did too. Splitting them into different objects (or
  // dropping the uuid from the payload) would recreate the "tag did not ride"
  // case the unsafe repair was written for.
  const src = repaintPayloadExtraSource();
  const uuidAt = src.indexOf("[WORKFLOW_UUID_FIELD]: targetUuid");
  const markerAt = src.indexOf("[OPEN_PROOF_FIELD]: openProofMarker");
  assert.notEqual(uuidAt, -1, "the repaint payload must carry the workflow identity tag");
  assert.notEqual(markerAt, -1, "the repaint payload must carry this attempt's single-use marker");
  // Both inside the SAME `[WORKFLOW_META_NAMESPACE]: { … }` object, not merely both
  // somewhere in the assignment.
  const meta = balancedFrom(src, "[WORKFLOW_META_NAMESPACE]: {");
  assert.match(meta, /\[WORKFLOW_UUID_FIELD\]: targetUuid/);
  assert.match(meta, /\[OPEN_PROOF_FIELD\]: openProofMarker/);
});

test("#606 workflow_open: the post-load proof never STAMPS the root — an unproven load stays refused", () => {
  // The rejected repair, in one assertion. A stamp on this path can only ever be
  // licensed by observations that cannot distinguish "the load applied" from "a
  // stale root already held identical content", and an unreadable observation
  // must never become a licence.
  const src = postLoadProofSource();
  assert.equal(
    src.includes("stampGraphRootWorkflowUuid"),
    false,
    "workflow_open must not re-tag the live root after the load",
  );
  // …and the marker is still REQUIRED, so removing the stamp did not soften the
  // proof into a content-only comparison.
  assert.match(src, /markerMatches/);
  assert.match(src, /graphRootCarriesOpenProof\(/);
});

test("#606 the shared stamp writer is still used where evidence DOES exist", () => {
  // workflow_new's creation stamp (proven-empty root) and the binding guard's own
  // rebind heal are the two justified callers; this test fails if the writer is
  // left orphaned by a refactor that also removes them.
  const calls = SRC.split("stampGraphRootWorkflowUuid(").length - 1;
  assert.ok(calls >= 3, `expected the definition plus at least two callers, saw ${calls}`);
});

// ---------------------------------------------------------------------------
// #607 fix 3 — a fence refusal re-advertises the panel's live identity (re-hello)
// ---------------------------------------------------------------------------

function buildMismatchFence() {
  // The module-level hook + note + the assert function, verbatim from the monolith.
  const sliceStart = SRC.indexOf("let workflowInstanceMismatchRehello = null;");
  assert.notEqual(sliceStart, -1, "hook declaration not found");
  const fnSource = balancedFrom(SRC, "function assertActiveWorkflowCommandTarget(");
  const fnStart = SRC.indexOf("function assertActiveWorkflowCommandTarget(");
  const slice = SRC.slice(sliceStart, fnStart + fnSource.length);
  const factory = new Function(
    "commandTargetsActiveWorkflow",
    "workflowStableUuid",
    "WORKFLOW_UUID_FIELD",
    `${slice}\nreturn {\n` +
      `  assert: assertActiveWorkflowCommandTarget,\n` +
      `  setHook: (fn) => { workflowInstanceMismatchRehello = fn; },\n` +
      `};`,
  );
  return factory(commandTargetsActiveWorkflow, () => "uuid-ACTIVE", "workflow_uuid");
}

test("#607 a refused stamp fires the re-hello hook exactly once, then throws", () => {
  const fence = buildMismatchFence();
  let hellos = 0;
  fence.setHook(() => {
    hellos += 1;
  });
  assert.throws(
    () =>
      fence.assert({
        cmd: "graph_add_node",
        workflow_uuid: "uuid-STALE",
      }),
    /workflow instance mismatch/,
  );
  assert.equal(hellos, 1, "the refusal re-advertises the panel's current identity");
});

test("#607 a matching stamp does NOT fire the hook and does not throw", () => {
  const fence = buildMismatchFence();
  let hellos = 0;
  fence.setHook(() => {
    hellos += 1;
  });
  fence.assert({ cmd: "graph_add_node", workflow_uuid: "uuid-ACTIVE" });
  assert.equal(hellos, 0);
});

test("#607 a throwing hook never masks or replaces the refusal", () => {
  const fence = buildMismatchFence();
  fence.setHook(() => {
    throw new Error("socket exploded");
  });
  assert.throws(
    () => fence.assert({ cmd: "graph_add_node", workflow_uuid: "uuid-STALE" }),
    /workflow instance mismatch/,
    "the refusal itself must stand",
  );
});

test("#607 the dispatch-time fence also re-advertises before refusing", () => {
  // Structural: the command-handler fence (separate from the assert helper used at
  // mutation boundaries) must fire the same hook before its throw.
  const marker = "const executor = GRAPH_TOOL_EXECUTORS[msg.cmd];";
  const start = SRC.indexOf(marker);
  assert.notEqual(start, -1);
  // #750 moved the refusal TEXT into one shared builder (both dispatch sites used
  // to carry their own copy), so the literal no longer appears after this point.
  // Anchor on the call to that builder instead — same place in the flow, and it
  // now also fails if a site goes back to hand-rolling its own message.
  const end = SRC.indexOf("workflowInstanceMismatchMessage(", start);
  assert.notEqual(end, -1, "the dispatch fence must refuse via the shared builder");
  const fenceRegion = SRC.slice(start, end);
  const noteAt = fenceRegion.indexOf("noteWorkflowInstanceMismatch();");
  assert.notEqual(noteAt, -1, "the dispatch fence must re-advertise on refusal");
  const throwAt = fenceRegion.indexOf("throw new Error(", noteAt);
  assert.ok(throwAt > noteAt, "the re-advertise fires BEFORE the refusal throw");
});

// ---------------------------------------------------------------------------
// #607 — the registered re-hello itself: BOUNDED per identity, and its budget and
// backoff are spent only on attempts that actually concluded.
//
// The shipping arrow function is extracted verbatim with its own `let`s, so
// deleting the bound, or moving either bookkeeping write back to before the send,
// fails a test here.
// ---------------------------------------------------------------------------

/**
 * Extract the shipping hook verbatim with its own `let`s. The double for
 * `sendHello` must honour the real one's contract — it publishes the identity it
 * ADVERTISED (`lastAdvertisedWorkflowUuid`) on its success path only — so the
 * harness hands the test a setter for exactly that, and nothing else.
 */
function buildRehelloHook({ sendHello, stableUuid, routeId = () => "route-A" }) {
  const declStart = SRC.indexOf("const MISMATCH_REHELLO_MAX_PER_IDENTITY");
  assert.notEqual(declStart, -1, "the re-hello budget constants are missing");
  const marker = "workflowInstanceMismatchRehello = () => {";
  const bodyStart = SRC.indexOf(marker);
  assert.notEqual(bodyStart, -1, "the bridge client must register the re-hello hook");
  // The marker itself ENDS with the body's own "{", so balance from that brace —
  // the default (first "{" after the marker) would balance the inner try block.
  const bodyOpen = bodyStart + marker.length - 1;
  const body = balancedFrom(SRC, marker, bodyOpen);
  // End the slice at the index the body was balanced FROM plus its length. Using
  // `bodyStart` here instead silently drops the last (marker.length - 1) chars,
  // which lopped the tail off the extracted hook: the truncated text still
  // happened to parse, so the tests ran against a hook whose landed/failed
  // bookkeeping had been cut away and every budget assertion was meaningless.
  const slice = SRC.slice(declStart, bodyOpen + body.length);
  // Extraction is itself an operation that can fail — verify it captured the
  // whole hook rather than trusting the arithmetic.
  assert.ok(
    slice.includes("lastFailedMismatchRehelloAt = Date.now();"),
    "the extracted hook is truncated — its failure bookkeeping is missing",
  );
  assert.ok(
    slice.includes("mismatchRehelloLandedCount += 1;"),
    "the extracted hook is truncated — its landed bookkeeping is missing",
  );
  // #1389 — the hook now also reads the live ROUTE (its budget is keyed on the identity a
  // hello ADVERTISES, and a route is half of that). A `new Function` scope missing a
  // binding the shipping code reads throws ReferenceError, which reads as a broken
  // harness rather than as the missing dependency it is — so inject it here.
  const factory = new Function(
    "sendHello",
    "workflowStableUuid",
    "bridgeRouteId",
    `let workflowInstanceMismatchRehello = null;\n${slice};\n` +
      `return {\n` +
      `  hook: workflowInstanceMismatchRehello,\n` +
      `  advertise: (uuid) => { lastAdvertisedWorkflowUuid = uuid; },\n` +
      `};`,
  );
  return factory(sendHello, stableUuid, routeId);
}

/** Let every queued microtask (the hook's own promise chain) drain. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A `sendHello` double: lands (or not), and on landing publishes the identity
 *  that was live AT PAYLOAD TIME — which is what the real one does, and what makes
 *  the crossed-switch case below observable. */
function helloDouble(getLiveUuid, { lands = () => true, defer = null, afterBuild = null } = {}) {
  const calls = [];
  const impl = {
    /** what each hello ADVERTISED, in payload-build order */
    calls,
    /** how many sends were STARTED (a deferred send is started but not yet built) */
    started: 0,
    harness: null,
    send() {
      impl.started += 1;
      // The identity is read where the PAYLOAD is built, which in the real
      // sendHello is after an awaited tab-identity resolve — so with `defer` it
      // is read after the gate opens, not when the send was decided.
      const build = () => {
        const advertised = getLiveUuid();
        calls.push(advertised);
        const ok = lands();
        if (ok) impl.harness.advertise(advertised);
        return ok;
      };
      const built = defer ? defer.then(build) : Promise.resolve(build());
      // `afterBuild` holds the RESOLUTION open after the payload was built, so a
      // tab switch can land between "this hello advertised X" and "the hook learns
      // it landed" — the window where the advertised identity and the identity
      // being budgeted genuinely differ.
      return afterBuild ? built.then((ok) => afterBuild.then(() => ok)) : built;
    },
  };
  return impl;
}

test("#607 the re-hello is BOUNDED per identity — a persistent mismatch stops churning", async () => {
  const dbl = helloDouble(() => "uuid-STUCK");
  const h = buildRehelloHook({ sendHello: () => dbl.send(), stableUuid: () => "uuid-STUCK" });
  dbl.harness = h;
  for (let i = 0; i < 25; i += 1) {
    h.hook();
    await settle();
  }
  assert.equal(dbl.calls.length, 3, "a persistent refusal must not re-hello forever");
});

test("#607 a NEW live identity resets the budget — a real switch is re-advertised", async () => {
  let uuid = "uuid-A";
  const dbl = helloDouble(() => uuid);
  const h = buildRehelloHook({ sendHello: () => dbl.send(), stableUuid: () => uuid });
  dbl.harness = h;
  for (let i = 0; i < 6; i += 1) {
    h.hook();
    await settle();
  }
  assert.equal(dbl.calls.length, 3, "budget spent on identity A");
  uuid = "uuid-B";
  h.hook();
  await settle();
  assert.equal(dbl.calls.length, 4, "a genuinely different identity gets a fresh advertisement");
});

test("#607 a hello that never reached the wire does NOT spend the budget", async () => {
  // The defect this locks: spending the budget (or claiming the throttle) before
  // the send resolves means a recovery that never left the tab suppresses the
  // attempts that could have worked.
  let lands = false;
  const dbl = helloDouble(() => "uuid-A", { lands: () => lands });
  const h = buildRehelloHook({ sendHello: () => dbl.send(), stableUuid: () => "uuid-A" });
  dbl.harness = h;
  h.hook();
  await settle();
  assert.equal(dbl.calls.length, 1);
  // Backoff after a failed attempt: an immediate retry is suppressed…
  h.hook();
  await settle();
  assert.equal(dbl.calls.length, 1, "a failed attempt backs off before retrying");
  // …but once the backoff elapses the budget is still whole (3 landings left).
  lands = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    for (let i = 0; i < 6; i += 1) {
      h.hook();
      await settle();
    }
  } finally {
    Date.now = realNow;
  }
  assert.equal(dbl.calls.length, 4, "the failed attempt cost no budget: 3 landings still allowed");
});

test("#607 a hello that CROSSED a tab switch is charged to the identity it advertised", async () => {
  // The send is decided for A but its payload is built after an awaited identity
  // resolve, by which time the live workflow is B — so the hello advertises B.
  // Charging it to A (or discarding it) would let B collect this hello ON TOP of
  // its own three, i.e. four sends under a bound that says three.
  let uuid = "uuid-A";
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const dbl = helloDouble(() => uuid, { defer: gate });
  const h = buildRehelloHook({ sendHello: () => dbl.send(), stableUuid: () => uuid });
  dbl.harness = h;
  h.hook(); // decided for A; its payload is read below, after the switch
  await settle();
  uuid = "uuid-B";
  h.hook(); // suppressed: the first is still in flight
  await settle();
  release();
  await settle();
  assert.deepEqual(dbl.calls, ["uuid-B"], "the crossed hello advertised B, not A");
  // B has now had ONE landed hello. Its remaining budget must be two, not three.
  for (let i = 0; i < 6; i += 1) {
    h.hook();
    await settle();
  }
  assert.equal(dbl.calls.length, 3, "the crossed hello counted against the identity it carried");
});

test("#607 a hello that landed for the PREVIOUS identity is not charged to the new one", async () => {
  // The mirror of the case above, and the one that actually separates "charge the
  // identity the hello CARRIED" from "charge whichever identity is current when it
  // resolves". The hello advertises A; the user switches to B (which resets B's
  // budget) before the hook learns the hello landed. B was never advertised to the
  // orchestrator, so B's budget must be untouched — charging it would silently
  // spend one of the three attempts B is entitled to.
  let uuid = "uuid-A";
  let releaseAfterBuild;
  const afterBuild = new Promise((r) => {
    releaseAfterBuild = r;
  });
  const dbl = helloDouble(() => uuid, { afterBuild });
  const h = buildRehelloHook({ sendHello: () => dbl.send(), stableUuid: () => uuid });
  dbl.harness = h;
  h.hook(); // decided for A, payload built for A
  await settle();
  assert.deepEqual(dbl.calls, ["uuid-A"], "the hello advertised A");
  uuid = "uuid-B"; // the switch lands before the hook learns the hello landed
  h.hook(); // resets the budget to B, then defers to the in-flight send
  await settle();
  releaseAfterBuild();
  await settle();
  // B has had NO landed hello. Its full budget of three must remain.
  for (let i = 0; i < 8; i += 1) {
    h.hook();
    await settle();
  }
  assert.deepEqual(
    dbl.calls,
    ["uuid-A", "uuid-B", "uuid-B", "uuid-B"],
    "A's landing must not be charged to B — B keeps all three of its own attempts",
  );
});

test("#607 concurrent refusals fire ONE in-flight re-hello, not a burst", async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const dbl = helloDouble(() => "uuid-A", { defer: gate });
  const h = buildRehelloHook({ sendHello: () => dbl.send(), stableUuid: () => "uuid-A" });
  dbl.harness = h;
  h.hook();
  h.hook();
  h.hook();
  await settle();
  assert.equal(dbl.started, 1, "only one hello is outstanding at a time");
  release();
  await settle();
});

test("#607 an unreadable live identity re-hellos nothing (unknown is not new evidence)", async () => {
  let hellos = 0;
  const h = buildRehelloHook({
    sendHello: () => {
      hellos += 1;
      return Promise.resolve(true);
    },
    stableUuid: () => {
      throw new Error("no active workflow");
    },
  });
  h.hook();
  await settle();
  assert.equal(hellos, 0, "an unknown identity must not be treated as a changed one");
});

test("#607 the hello reports whether it reached the wire, and publishes only then", () => {
  // The hook's budget is only meaningful if the hello answers truthfully: a
  // closed socket must resolve false rather than an ignored undefined, and the
  // advertised identity must be published on the success path, never at payload
  // time — publishing early would credit a hello that did not happen.
  //
  // #1095 — this reads `advertiseHello`, the payload builder, which is what these
  // assertions have always been about. `sendHello` is now the GATED entry point in front
  // of it (it holds a re-advertise until in-flight commands have replied), so pointing
  // this at `sendHello` would silently slice a five-line wrapper and pass on the absence
  // of everything it checks — the same "a passing assertion stops meaning what it checks"
  // trap this suite has corrected three times for character-window slices.
  const src = balancedFrom(SRC, "function advertiseHello()");
  assert.match(src, /readyState !== WebSocket\.OPEN\) return Promise\.resolve\(false\)/);
  assert.match(src, /return sendBridgeHello\(/);
  assert.match(src, /return sent === true;/);
  const publishAt = src.indexOf("lastAdvertisedWorkflowUuid = advertisedWorkflowUuid;");
  assert.notEqual(publishAt, -1, "the hello must publish what it advertised");
  const successAt = src.indexOf("if (sent) {");
  assert.ok(successAt !== -1 && publishAt > successAt, "…only inside the success branch");
  const payloadAt = src.indexOf("(advertisedWorkflowUuid = workflowStableUuid())");
  assert.notEqual(payloadAt, -1, "the advertised identity is read where the PAYLOAD is built");
  assert.ok(payloadAt < publishAt, "read at payload time, published only after the send lands");
});

// ---------------------------------------------------------------------------
// #606 — the refusal's REMEDY names what it does, not an outcome it cannot see
// ---------------------------------------------------------------------------

test("#606 the binding refusal marks the reload remedy as REQUESTED, not confirmed", async () => {
  // Two gate rounds died on this one sentence: it first said a reload "always
  // re-establishes the binding", then "rebuilds the binding from scratch" — both
  // unconditional claims about an outcome nothing observes. panel_reload asks the
  // browser to navigate and returns; there is no post-reload binding receipt.
  //
  // A phrase blacklist cannot hold this: it passes for every wording nobody
  // thought to ban. The requirement is POSITIVE — the message must carry an
  // explicit statement that the reload is unconfirmed, so any rewrite that
  // reinstates a promise has to delete that statement and fail here.
  const { graphBindingRefusalMessage } = await import("../../web/js/lib/graph-binding.js");
  for (const reason of [
    "root-workflow-uuid-mismatch",
    "root-shape-mismatch",
    "root-node-count-desync",
  ]) {
    const msg = graphBindingRefusalMessage({ reason, expected: 0 });
    assert.match(msg, /panel_reload/, `${reason} still names the reload remedy`);
    assert.match(
      msg,
      /REQUESTED, NOT CONFIRMED/,
      `${reason} must mark the reload as unobserved, not promise it worked`,
    );
    assert.match(
      msg,
      /cannot observe/,
      `${reason} must say WHY it is unconfirmed, not merely hedge`,
    );
    // …and no unconditional outcome claim smuggled in ALONGSIDE the disclaimer:
    // a message that both promises the repair and disclaims it is worse than
    // either, because a reader takes whichever half suits the retry.
    assert.doesNotMatch(
      msg,
      /which (restores|rebinds|re-?establishes|rebuilds)|reload always|will (restore|rebind|re-?establish|rebuild)/i,
      `${reason} must not also assert the reload succeeds`,
    );
  }
});

// ---------------------------------------------------------------------------
// #1209 — the fence is refreshed BEFORE the refusal, not only after it
//
// #607 made the recovery reachable. It is edge-triggered on an actual refusal, so
// the first graph call after the panel's live identity moved still fails and the
// reporter still spends a panel_set_workflow_target({mode:"current"}) round-trip on
// a stale fence the panel could already see.
//
// It moves without a tab switch. The switch-path re-hello is gated on
// workflowTabId() changing, and that id is the saved HANDLE (`wf:<path>`): a workflow
// replaced IN PLACE under the same tab keeps it while workflowStableUuid() — the
// per-instance fence identity — is re-minted. Two reporters hit exactly that, one
// after a tab switch and one on the FIRST call of a brand-new session.
// ---------------------------------------------------------------------------

/**
 * Extract the budget block, the #607 hook AND the #1209 drift hook together, so the
 * delegation between them is the shipping one. Deleting the drift hook, or making it
 * fire unconditionally, fails a test below.
 */
function buildDriftHook({
  sendHello,
  stableUuid,
  routeStale = () => false,
  routeId = () => "route-A",
}) {
  const declStart = SRC.indexOf("const MISMATCH_REHELLO_MAX_PER_IDENTITY");
  assert.notEqual(declStart, -1, "the re-hello budget constants are missing");
  const marker = "workflowIdentityDriftRehello = () => {";
  const bodyStart = SRC.indexOf(marker);
  assert.notEqual(bodyStart, -1, "the bridge client must register the drift re-hello hook");
  // Same brace arithmetic as buildRehelloHook: the marker ENDS with the body's own
  // "{", and the slice must end at that index plus the body length (using bodyStart
  // silently lops the tail off and every assertion below becomes meaningless).
  const bodyOpen = bodyStart + marker.length - 1;
  const body = balancedFrom(SRC, marker, bodyOpen);
  const slice = SRC.slice(declStart, bodyOpen + body.length);
  assert.ok(
    slice.includes("workflowInstanceMismatchRehello() === true"),
    "the drift hook must reuse the bounded #607 send, and charge only a DISPATCHED one",
  );
  assert.ok(
    slice.includes("driftRehelloUnconverged = 0;"),
    "the extracted region is truncated — the drift bound's replenishment is missing",
  );
  assert.ok(
    slice.includes("mismatchRehelloLandedCount += 1;"),
    "the extracted region is truncated — the #607 landed bookkeeping is missing",
  );
  // #1389 — the ROUTE half of the same drift check. Asserted on the SLICE (not only
  // through behaviour) because a `new Function` scope that is missing a binding the
  // shipping code reads throws ReferenceError, which would read as a broken harness
  // rather than as the missing dependency it is.
  assert.ok(
    slice.includes("advertisedRouteIsStale()"),
    "the drift hook must also watch the ROUTE the orchestrator keys its tab registry on",
  );
  const factory = new Function(
    "sendHello",
    "workflowStableUuid",
    "advertisedRouteIsStale",
    "bridgeRouteId",
    `let workflowInstanceMismatchRehello = null;\n` +
      `let workflowIdentityDriftRehello = null;\n${slice};\n` +
      `return {\n` +
      `  drift: workflowIdentityDriftRehello,\n` +
      `  mismatch: workflowInstanceMismatchRehello,\n` +
      `  advertise: (uuid) => { lastAdvertisedWorkflowUuid = uuid; },\n` +
      `};`,
  );
  return factory(sendHello, stableUuid, routeStale, routeId);
}

test("#1209 a fence that drifted under an unchanged route is re-advertised, unprompted", async () => {
  // The reported shape: the orchestrator was told A at connect, the canvas is now B,
  // and NOTHING has been refused yet. Before this fix the panel sat on that until a
  // command failed; the reporter's next read-only panel_graph_outline was that command.
  let live = "uuid-A";
  const dbl = helloDouble(() => live);
  const h = buildDriftHook({ sendHello: () => dbl.send(), stableUuid: () => live });
  dbl.harness = h;
  h.advertise("uuid-A");

  h.drift();
  await settle();
  assert.equal(dbl.calls.length, 0, "a fence that still names the live canvas sends nothing");

  live = "uuid-B"; // in-place replace: same wf:<path> route, fresh instance uuid
  h.drift();
  await settle();
  assert.deepEqual(dbl.calls, ["uuid-B"], "the drifted fence is re-advertised without a refusal");

  // …and it QUIESCES: once the advertisement lands, the panel and the orchestrator
  // agree again, so the 600ms poll must stop sending. A re-hello per tick would be a
  // greeting storm — the exact failure the tmp:-id churn produced.
  for (let i = 0; i < 10; i += 1) {
    h.drift();
    await settle();
  }
  assert.equal(dbl.calls.length, 1, "an advertisement that landed ends the drift");
});

test("#1209 an idle panel spends none of the bound a later real drift needs", async () => {
  // Equality is the common case — it runs on every poll tick. A hook that spent the
  // bound on the no-drift path would leave a genuine later drift with nothing to
  // spend, which is the wedge, not the fix.
  let live = "uuid-A";
  const dbl = helloDouble(() => live);
  const h = buildDriftHook({ sendHello: () => dbl.send(), stableUuid: () => live });
  dbl.harness = h;
  h.advertise("uuid-A");
  for (let i = 0; i < 50; i += 1) {
    h.drift();
    await settle();
  }
  assert.equal(dbl.started, 0, "an idle panel sends nothing");

  // …and the drift it had been idling through is still advertised when it arrives.
  live = "uuid-B";
  h.drift();
  await settle();
  assert.deepEqual(dbl.calls, ["uuid-B"], "the budget was not spent while nothing had drifted");
});

test("#1209 nothing advertised yet is not a drift — the open hello carries the truth", async () => {
  // A fresh or reconnecting socket has told the orchestrator nothing, so there is no
  // stale cache to correct and firing here would only race the hello that is coming.
  const dbl = helloDouble(() => "uuid-LIVE");
  const h = buildDriftHook({ sendHello: () => dbl.send(), stableUuid: () => "uuid-LIVE" });
  dbl.harness = h;
  h.drift();
  await settle();
  assert.equal(dbl.started, 0, "an unadvertised socket must not re-hello");
});

test("#1209 an identity that cannot be READ is not an identity known to differ", async () => {
  const dbl = helloDouble(() => "uuid-A");
  const h = buildDriftHook({
    sendHello: () => dbl.send(),
    stableUuid: () => {
      throw new Error("no workflow service");
    },
  });
  dbl.harness = h;
  h.advertise("uuid-A");
  h.drift();
  await settle();
  assert.equal(dbl.started, 0, "an unreadable identity re-hellos nothing");
});

test("#1209 a drift that cannot be advertised is BOUNDED, like the refusal path", async () => {
  // An orchestrator that takes the hello and keeps its old stamp (the harness never
  // republishes) must not turn a 600ms poll into an unbounded re-hello loop — a churn
  // is a new wedge, not a fix.
  const dbl = helloDouble(() => "uuid-B");
  const h = buildDriftHook({ sendHello: () => dbl.send(), stableUuid: () => "uuid-B" });
  dbl.harness = { advertise: () => {} };
  h.advertise("uuid-A");
  for (let i = 0; i < 25; i += 1) {
    h.drift();
    await settle();
  }
  assert.equal(dbl.calls.length, 3, "a drift that never clears stops churning");
});

test("#1209 convergence is what replenishes the bound — a switch after a stuck one still lands", async () => {
  // The bound above must not be a one-way ratchet for the LIFE of the socket. Once an
  // advertisement demonstrably reached the orchestrator (what it was told names the
  // live canvas), re-advertising is proven to work here and the next genuine drift —
  // hours and many workflow switches later — gets the full bound again.
  let live = "uuid-B";
  const dbl = helloDouble(() => live);
  const h = buildDriftHook({ sendHello: () => dbl.send(), stableUuid: () => live });
  // Phase 1: an orchestrator that takes the hellos and keeps its old stamp. Three
  // tries, then quiet.
  dbl.harness = { advertise: () => {} };
  h.advertise("uuid-A");
  for (let i = 0; i < 12; i += 1) {
    h.drift();
    await settle();
  }
  assert.equal(dbl.calls.length, 3, "the stuck identity exhausted the bound");

  // Phase 2: the panel and the orchestrator agree again (a reconnect's open hello, or
  // the switch-path re-hello, landed). One converged observation, and the mechanism is
  // live again.
  dbl.harness = h;
  h.advertise("uuid-B");
  h.drift();
  await settle();
  assert.equal(dbl.calls.length, 3, "convergence itself sends nothing");
  live = "uuid-C";
  h.drift();
  await settle();
  assert.deepEqual(dbl.calls.slice(3), ["uuid-C"], "the next real drift is advertised again");
});

test("#1209 an attempt the #607 guards refused does not spend the drift bound", async () => {
  // The bound counts re-hellos that were DISPATCHED. #607 refuses one while another is
  // in flight, and charging the bound for those would burn it on sends that never
  // happened — the same "recorded before it happened" defect the #607 budget itself
  // exists to avoid, seen from the caller's side.
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const dbl = helloDouble(() => "uuid-B", { defer: gate });
  const h = buildDriftHook({ sendHello: () => dbl.send(), stableUuid: () => "uuid-B" });
  dbl.harness = { advertise: () => {} };
  h.advertise("uuid-A");

  for (let i = 0; i < 8; i += 1) {
    h.drift();
    await settle();
  }
  assert.equal(dbl.started, 1, "the in-flight guard held the burst to one send");

  release();
  await settle();
  await settle();
  // Two dispatches remain, not zero: the seven refused ticks cost nothing.
  for (let i = 0; i < 8; i += 1) {
    h.drift();
    await settle();
  }
  assert.equal(dbl.started, 3, "the refused ticks left the rest of the bound intact");
});

// ---------------------------------------------------------------------------
// #1389 — the ROUTE half of the same drift check.
//
// A hello advertises two identities and they do not move together: the fence uuid is
// durable per workflow INSTANCE, while the route (`tab_id`) is composed from the tab's
// lease and the workflow's PATH. A first save or a rename/Save-As re-keys the route and
// leaves the instance exactly where it was — so the uuid half reports convergence, and
// replenishes the bound, while the address ui-bridge keys its tab registry on is wrong.
//
// The panel can already SEE it (`advertisedRouteIsStale()` drives the outbound refusals),
// but nothing re-advertised on it: the poll re-hellos on the EDGE of a route change and
// then reports `wfid === currentWorkflowId` forever after, and a held frame may never
// cause an advertisement by `holdForRoute`'s own rule. A re-advertise that did not land
// therefore wedged the tab until a browser refresh — the reported recovery.
// ---------------------------------------------------------------------------

test("#1389 a ROUTE that drifted under an UNCHANGED fence identity is re-advertised", async () => {
  // The reported shape: same workflow instance (a first save / a rename), so the uuid
  // the orchestrator holds is still correct — and the route it holds is not. Before this
  // fix the drift hook saw "uuid converged" and sent nothing, forever.
  let routeStale = false;
  const dbl = helloDouble(() => "uuid-SAME", { lands: () => true });
  const h = buildDriftHook({
    sendHello: () => dbl.send(),
    stableUuid: () => "uuid-SAME",
    routeStale: () => routeStale,
  });
  // A landed hello re-advertises the LIVE route, so the staleness clears with it.
  dbl.harness = {
    advertise: (uuid) => {
      h.advertise(uuid);
      routeStale = false;
    },
  };
  h.advertise("uuid-SAME");

  h.drift();
  await settle();
  assert.equal(dbl.started, 0, "an agreeing panel sends nothing");

  routeStale = true; // the save re-keyed the route; the instance is the same object
  h.drift();
  await settle();
  assert.deepEqual(dbl.calls, ["uuid-SAME"], "the drifted ROUTE is re-advertised unprompted");

  // …and it QUIESCES once the advertisement lands, exactly like the fence half.
  for (let i = 0; i < 10; i += 1) {
    h.drift();
    await settle();
  }
  assert.equal(dbl.calls.length, 1, "an advertisement that landed ends the route drift");
});

test("#1389 a converged fence identity does not replenish the bound while the ROUTE is stale", async () => {
  // The bound is what stops a 600ms poll becoming a greeting storm, and the uuid half
  // owns its replenishment. Resetting on "the uuid agrees" while the route does not
  // would make the bound infinite for exactly the case this fix adds — an unbounded
  // re-hello loop is a NEW wedge, not a fix.
  const dbl = helloDouble(() => "uuid-SAME");
  const h = buildDriftHook({
    sendHello: () => dbl.send(),
    stableUuid: () => "uuid-SAME",
    routeStale: () => true, // an orchestrator that takes the hello and keeps the old route
  });
  dbl.harness = { advertise: () => {} };
  h.advertise("uuid-SAME");
  for (let i = 0; i < 25; i += 1) {
    h.drift();
    await settle();
  }
  assert.equal(dbl.calls.length, 3, "a route that never clears stops churning");
});

test("#1389 a route that converges again replenishes the bound for the next real drift", async () => {
  // BOTH bounds have to hand themselves back, and only one of them did. The drift
  // caller's own counter replenishes on convergence, but the #607 per-identity budget
  // underneath it is keyed on the ADVERTISED identity — and while that key was the fence
  // uuid alone, a pure route drift never presented a new one. Three route
  // re-advertisements were then all a workflow instance ever got for the life of the
  // socket: a first save spends one, a rename another, and the third leaves the panel
  // permanently unable to re-address itself on a canvas the user never left.
  let routeStale = true;
  let liveRoute = "route-B";
  const dbl = helloDouble(() => "uuid-SAME");
  const h = buildDriftHook({
    sendHello: () => dbl.send(),
    stableUuid: () => "uuid-SAME",
    routeStale: () => routeStale,
    routeId: () => liveRoute,
  });
  // Phase 1: the hellos land but the route stays stale — three tries, then quiet.
  dbl.harness = { advertise: () => {} };
  h.advertise("uuid-SAME");
  for (let i = 0; i < 12; i += 1) {
    h.drift();
    await settle();
  }
  assert.equal(dbl.calls.length, 3, "the stuck route exhausted the bound");

  // Phase 2: something else re-registered the tab (a reconnect's open hello). One
  // observed convergence — both halves agreeing — and the mechanism is live again.
  routeStale = false;
  h.drift();
  await settle();
  assert.equal(dbl.calls.length, 3, "convergence itself sends nothing");

  // Phase 3: a LATER genuine route move — a rename of the same instance, so the fence
  // uuid is the one it always was and only the route is new evidence.
  liveRoute = "route-C";
  routeStale = true;
  h.drift();
  await settle();
  assert.equal(dbl.calls.length, 4, "the next real route drift is advertised again");
});

test("#1389 an unreadable fence identity does not credit a convergence the panel never observed", async () => {
  // `uuidObserved` is why the reset is not simply `!drifted`. An identity that cannot be
  // read is not evidence that re-advertising works here, and crediting it would hand a
  // later genuine drift a bound this tick never earned — the same rule #1209 states for
  // its own early exit, kept now that the exit has become a branch.
  let readable = true;
  let routeStale = true;
  const dbl = helloDouble(() => "uuid-B");
  const h = buildDriftHook({
    sendHello: () => dbl.send(),
    stableUuid: () => {
      if (!readable) throw new Error("no workflow service");
      return "uuid-B";
    },
    routeStale: () => routeStale,
    routeId: () => "route-B",
  });
  // An orchestrator that takes the hellos and republishes nothing, so the drift never
  // clears on its own and the bound is the only thing that stops the poll.
  dbl.harness = { advertise: () => {} };
  h.advertise("uuid-A");

  // Spend the bound on a drift that never converges…
  for (let i = 0; i < 12; i += 1) {
    h.drift();
    await settle();
  }
  assert.equal(dbl.calls.length, 3, "the stuck drift exhausted the bound");

  // …then reach the no-drift branch with the fence identity UNREADABLE. Nothing
  // disagrees, but nothing was observed to agree either: an exception is not a
  // convergence, and crediting it would hand the bound straight back.
  readable = false;
  routeStale = false;
  for (let i = 0; i < 12; i += 1) {
    h.drift();
    await settle();
  }
  assert.equal(dbl.calls.length, 3, "an unreadable identity is not convergence");

  // The bound really is still spent — a genuine drift returning finds nothing left,
  // exactly as it would have without the unreadable ticks in between.
  readable = true;
  routeStale = true;
  for (let i = 0; i < 12; i += 1) {
    h.drift();
    await settle();
  }
  assert.equal(dbl.calls.length, 3, "an unreadable tick replenished nothing");
});

test("#1389 nothing advertised yet is still not a drift, even with the route half added", async () => {
  // A fresh or reconnecting socket has no landed mapping, so `advertisedRouteIsStale()`
  // answers false by construction (`mapped`). Pinned here anyway: the route half must not
  // reopen the race the uuid half's early exit closed — the open hello carries the truth.
  const dbl = helloDouble(() => "uuid-LIVE");
  const h = buildDriftHook({
    sendHello: () => dbl.send(),
    stableUuid: () => "uuid-LIVE",
    routeStale: () => false,
  });
  dbl.harness = h;
  h.drift();
  await settle();
  assert.equal(dbl.started, 0, "an unadvertised socket must not re-hello");
});

test("#1209 the workflow poll calls the drift check when the ROUTE did not change", () => {
  // The whole fix is one call on the poll's early-return path, and a hook nobody
  // invokes is invisible to every test above. This asserts the wiring itself: restore
  // the bare `return` and this fails.
  const marker = "if (wfid === currentWorkflowId) {";
  assert.ok(SRC.includes(marker), "the no-route-change branch must still exist");
  const branch = balancedFrom(SRC, marker, SRC.indexOf(marker) + marker.length - 1);
  assert.match(
    branch,
    /noteWorkflowIdentityDrift\(\);/,
    "an unchanged route must still re-check the workflow INSTANCE identity",
  );
});

test("#1209 a throwing drift hook never breaks the workflow poll", () => {
  const src = balancedFrom(SRC, "function noteWorkflowIdentityDrift()");
  const fn = new Function(
    "workflowIdentityDriftRehello",
    `${src}\nreturn noteWorkflowIdentityDrift;`,
  )(() => {
    throw new Error("hook exploded");
  });
  assert.doesNotThrow(() => fn(), "the poll must survive a hook that throws");
});
