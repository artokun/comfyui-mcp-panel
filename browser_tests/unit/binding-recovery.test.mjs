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
function buildRehelloHook({ sendHello, stableUuid }) {
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
  const factory = new Function(
    "sendHello",
    "workflowStableUuid",
    `let workflowInstanceMismatchRehello = null;\n${slice};\n` +
      `return {\n` +
      `  hook: workflowInstanceMismatchRehello,\n` +
      `  advertise: (uuid) => { lastAdvertisedWorkflowUuid = uuid; },\n` +
      `};`,
  );
  return factory(sendHello, stableUuid);
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

test("#607 sendHello reports whether the hello reached the wire, and publishes only then", () => {
  // The hook's budget is only meaningful if `sendHello()` answers truthfully: a
  // closed socket must resolve false rather than an ignored undefined, and the
  // advertised identity must be published on the success path, never at payload
  // time — publishing early would credit a hello that did not happen.
  const src = balancedFrom(SRC, "function sendHello()");
  assert.match(src, /readyState !== WebSocket\.OPEN\) return Promise\.resolve\(false\)/);
  assert.match(src, /return sendBridgeHello\(/);
  assert.match(src, /return sent === true;/);
  const publishAt = src.indexOf("lastAdvertisedWorkflowUuid = advertisedWorkflowUuid;");
  assert.notEqual(publishAt, -1, "sendHello must publish what it advertised");
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
