// comfyui-mcp#1478 (defect 1) — `graph_load`'s reply now names the workflow identity the
// load landed on, on BOTH of its return paths.
//
// The reporter's very next graph call after a successful `panel_load_workflow` failed with
// `workflow instance mismatch`, deterministically, twice. Their reply was
// `{loaded:true, format:"api", node_count:59}` — the API-format branch.
//
// The orchestrator could only answer with a CONDITIONAL note ("an API-format load CAN
// re-mint the instance…") because this reply carried nothing that separated re-minted from
// reused. Its own docblock names the fix: give the reply a `workflow_uuid`, as #762/#800
// did for workflow_new / workflow_save, and the load can state what happened — or claim
// the fence from it, which `refreshFenceFromOwnReply` already knows how to do.
//
// WHY THE REPLY AND NOT A RE-DERIVATION: an earlier attempt ran the generic
// `rebindWorkflowFence`, and review caught the P1 — that adopts whatever is active NOW,
// with no tie to the load, so a user switching canvases in the window would stamp the
// session to a different workflow and the next edit would land on the wrong graph. A uuid
// carried in the command's own reply has no such window.
//
// The executor lives in the monolith and needs a live `app`, so what is pinned here is the
// WIRING; the one claim that does NOT depend on a live app — that an API-format load forks
// the per-instance uuid — is pinned behaviourally against the real predicate at the bottom.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { shouldForkInPlaceReload } from "../../web/js/lib/workflow-chat-identity.js";

const PANEL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
  "utf8",
).replace(/\r\n/g, "\n");

/** The graph_load executor body, bounded by the next executor that follows it. */
function graphLoadBody() {
  const start = PANEL.indexOf("async graph_load({ graph: incoming } = {}) {");
  assert.notEqual(start, -1, "graph_load executor must still be recognisable");
  const end = PANEL.indexOf("\n  graph_connect(", start);
  assert.ok(end > start, "the executor that follows graph_load must still be recognisable");
  return PANEL.slice(start, end);
}

/** The shared identity reader both return paths call. */
function helperBody() {
  const start = PANEL.indexOf("function loadLandedWorkflowUuid(appRef, targetedWorkflow) {");
  assert.notEqual(start, -1, "the shared identity reader must still be recognisable");
  const end = PANEL.indexOf("\n}", start);
  assert.ok(end > start, "the reader must still be a bounded function");
  return PANEL.slice(start, end);
}

test("#1478 BOTH of graph_load's return paths carry workflow_uuid", () => {
  // The API-format branch returns EARLY, before the UI path's capture ever runs. It is the
  // branch the reporter was on, so a field added only to the tail of the executor would
  // publish nothing for the exact call that failed.
  const body = graphLoadBody();
  assert.match(
    body,
    /\.\.\.\(apiLoadedWorkflowUuid \? \{ workflow_uuid: apiLoadedWorkflowUuid \} : \{\}\),/,
    "the API-format reply — the reporter's path — must carry the identity",
  );
  assert.match(
    body,
    /\.\.\.\(loadedWorkflowUuid \? \{ workflow_uuid: loadedWorkflowUuid \} : \{\}\),/,
    "and so must the UI-format reply",
  );
});

test("#1478 the API path captures its target BEFORE the load, not after", () => {
  // The capture has to bracket loadApiJson: read afterwards and the "target" is just
  // whatever is active now, which is the wrong-graph hazard this design exists to avoid.
  const body = graphLoadBody();
  const captureAt = body.indexOf("const apiTargetWorkflow");
  const loadAt = body.indexOf("await app.loadApiJson(");
  const readAt = body.indexOf("const apiLoadedWorkflowUuid");
  assert.ok(captureAt !== -1, "the API path must capture the pre-load target");
  assert.ok(loadAt !== -1, "the API load call must still be recognisable");
  assert.ok(captureAt < loadAt, "the target is captured BEFORE loadApiJson");
  assert.ok(readAt > loadAt, "and the identity is read AFTER it has landed");
  assert.match(
    body.slice(readAt, readAt + 200),
    /loadLandedWorkflowUuid\(app, apiTargetWorkflow\)/,
    "the API path reads through the shared gate, against its own captured target",
  );
});

test("#1478 the UI path reads through the same gate, against its own pre-load target", () => {
  const body = graphLoadBody();
  const loadAt = body.indexOf("await app.loadGraphData(");
  const readAt = body.indexOf("const loadedWorkflowUuid");
  assert.ok(loadAt !== -1, "the load call must still be recognisable");
  assert.ok(readAt > loadAt, "the identity is read after loadGraphData has landed");
  assert.match(
    body.slice(readAt, readAt + 200),
    /loadLandedWorkflowUuid\(app, activeWorkflow\)/,
    "and against the object captured before the load, never 'what is active now'",
  );
});

test("#1478 the identity is published only when it is PROVABLY this load's", () => {
  // THE PROPERTY THAT MATTERS, and the one review had to force. Reading "whatever is
  // active now" after the await is the SAME wrong-graph hazard the orchestrator-side
  // attempt was rejected for: load starts for A, the user switches to B while it awaits,
  // the continuation reads B, and an orchestrator that CLAIMS the fence from this reply
  // points the session at B — the next agent edit lands on the wrong graph.
  //
  // So the reply names a workflow only when the live one IS the object this load
  // targeted. Object identity, not a name: immune to a switch, and unforgeable.
  const helper = helperBody();
  assert.match(
    helper,
    /rawWorkflowObject\(liveNow\) === rawWorkflowObject\(targetedWorkflow\)/,
    "the identity is gated on the live workflow being the very object this load targeted",
  );
  assert.match(helper, /provablyOurs\s*\?/, "and the uuid is only read on that branch");
});

test("#1478 the check and the reply are in ONE synchronous turn — no await between them", () => {
  // The object-identity gate only proves anything if nothing can run between the check and
  // the reply that carries its verdict. Insert a single `await` in that window and the
  // guarantee silently inverts: the comparison passes for A, the event loop lets the user
  // switch to B, and the reply — already blessed — ships A's uuid for what is now B's
  // canvas. That is the identity embed/swap race this codebase keeps re-learning, and it
  // leaves no trace in behaviour a source-shape test would otherwise catch.
  //
  // The other tests here pin WHAT is compared. This one pins that the comparison is still
  // true when the value leaves.
  //
  // The gate now lives in ONE shared reader called from both return paths, so this is two
  // properties: the reader itself must be synchronous (it holds the comparison), and
  // neither call site may await between asking it and returning its verdict.
  //
  // The API path is the reason this is not theoretical. Its reply needs an import-failure
  // fetch, so a read placed at the natural spot — right after the load — put a live
  // `await readPackImportFailures(api)` between the check and the reply. This test is what
  // caught it; the read now happens last.
  const helper = helperBody();
  assert.doesNotMatch(helper, /\bawait\b/, "the shared identity reader must be synchronous");
  assert.doesNotMatch(helper, /\.then\s*\(/, "and must not defer");

  const body = graphLoadBody();
  for (const [label, read] of [
    ["API-format path", "const apiLoadedWorkflowUuid"],
    ["UI-format path", "const loadedWorkflowUuid"],
  ]) {
    const checkAt = body.indexOf(read);
    assert.notEqual(checkAt, -1, `${label}: the identity read must still be recognisable`);
    const replyAt = body.indexOf("return {", checkAt);
    assert.ok(replyAt > checkAt, `${label}: the reply must still follow the identity read`);
    const window = body.slice(checkAt, replyAt);
    assert.doesNotMatch(
      window,
      /\bawait\b/,
      `${label}: no await may separate the check from the reply`,
    );
    assert.doesNotMatch(window, /\.then\s*\(/, `${label}: and no deferred continuation either`);
  }
});

test("#1478 an unprovable load publishes NOTHING rather than a guess", () => {
  // A blank-canvas load mints a workflow this code holds no reference to, so nothing here
  // can prove which one is ours. Publishing the active one anyway is worse than publishing
  // none, precisely because the field is trusted enough to claim a fence from. The
  // orchestrator keeps its existing conditional note on that path.
  const helper = helperBody();
  assert.match(helper, /!!targetedWorkflow &&/, "no pre-load target ⇒ nothing is provable");
  assert.match(helper, /!!liveNow &&/, "no live workflow ⇒ nothing is provable");
});

test("#1478 the field is SHAPE-GATED — only a canonical instance uuid is published", () => {
  // #716's rule. A routing handle or a half-established value would be adopted by the
  // orchestrator as an instance identity and fence future commands against something that
  // is not one. An absent field costs a round trip through the existing fallback.
  const helper = helperBody();
  assert.match(
    helper,
    /isCanonicalWorkflowInstanceUuid\(uuid\) \? uuid : undefined/,
    "a non-canonical value is dropped, not published",
  );
});

test("#1478 an unreadable identity omits the field instead of throwing", () => {
  // Reading the identity is itself an operation that can fail, and this runs AFTER the
  // graph has already landed — a throw here would turn a successful load into a failed
  // one, which is strictly worse than the mismatch this is reporting.
  const helper = helperBody();
  assert.match(helper, /\} catch \{/, "the read is guarded");
  // A `throw` STATEMENT, anchored to the start of a line — prose in the comments explaining
  // why it must not rethrow is not a rethrow, and an assertion that cannot tell the
  // difference fails on its own documentation.
  assert.doesNotMatch(helper, /^[ \t]*throw\b/m, "and never rethrows");
  assert.match(helper, /return undefined;/, "the failure answer is an absent field");
});

test("#1478 the in-place UI path still PRESERVES the instance — the field only reports", () => {
  // The field must not be mistaken for a behaviour change. An in-place UI load keeps the
  // instance on purpose (#570 P0b): re-minting there would reject the agent's own
  // follow-up commands mid-conversation. That path therefore simply matches the fence.
  const body = graphLoadBody();
  assert.match(body, /__cmcpKeepInstance: true/, "the in-place keep-instance option is intact");
});

test("#1478 ROOT CAUSE: an API-format load forks the per-instance uuid", () => {
  // This is the claim the whole PR rests on, and the one an earlier investigation got
  // wrong by measuring the workflow OBJECT instead of its identity.
  //
  // `loadApiJson` reaches the creation-boundary wrapper WITHOUT `__cmcpKeepInstance`, so
  // the KEEP branch is unreachable and this predicate decides. API/prompt JSON has no
  // `extra`, so the incoming uuid is undefined — which differs from the fenced cached
  // uuid, so the wrapper drops the object's cached uuid and mints a fresh one ONTO THE
  // SAME OBJECT.
  //
  // Hence: the object is unchanged (`afterIsSameObject: true`) while the identity moves.
  // "The object did not change" is NOT evidence that the fence survived, and the fence
  // keys on the uuid.
  assert.equal(
    shouldForkInPlaceReload({ cachedUuid: "e592452b-c172-416d-a8bc-0ec6b96b56e1", incomingUuid: undefined }),
    true,
    "a fenced workflow + API JSON carrying no embedded uuid ⇒ the identity is re-minted",
  );
  // The contrast that proves the above is about the MISSING carrier, not about forking
  // always: the same content reloaded (matching embedded uuid) keeps the instance.
  assert.equal(
    shouldForkInPlaceReload({
      cachedUuid: "e592452b-c172-416d-a8bc-0ec6b96b56e1",
      incomingUuid: "e592452b-c172-416d-a8bc-0ec6b96b56e1",
    }),
    false,
    "the same uuid arriving back is a reload of the same content — no fork",
  );
});
