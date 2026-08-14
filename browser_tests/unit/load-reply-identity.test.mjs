// comfyui-mcp#1478 (defect 1) — `graph_load`'s reply now names the workflow identity the
// load landed on.
//
// The reporter's very next graph call after a successful `panel_load_workflow` failed with
// `workflow instance mismatch`, deterministically, twice. A blank-canvas load takes the
// fresh-mint path, so the session's fence still names the pre-load instance.
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
// WIRING; the field's behaviour on a real load is verified against the running ComfyUI
// after merge.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

test("#1478 graph_load's reply carries workflow_uuid", () => {
  const body = graphLoadBody();
  assert.match(
    body,
    /\.\.\.\(loadedWorkflowUuid \? \{ workflow_uuid: loadedWorkflowUuid \} : \{\}\),/,
    "the identity must ride the reply the orchestrator already parses",
  );
});

test("#1478 the identity is read AFTER the load, not before it", () => {
  // Read before, it would name the instance the load replaced — the exact stale value the
  // fence already holds, which would make the field worse than useless: the orchestrator
  // would compare two stale values, find them equal, and conclude nothing moved.
  const body = graphLoadBody();
  const loadAt = body.indexOf("await app.loadGraphData(");
  const readAt = body.indexOf("const liveAfterLoad");
  assert.ok(loadAt !== -1, "the load call must still be recognisable");
  assert.ok(readAt > loadAt, "the identity is read after loadGraphData has landed");

  // POSITION IS NOT ENOUGH, and mutation testing is what showed it: assigning the
  // PRE-load `activeWorkflow` const to `liveAfterLoad` sits in the same place and killed
  // no test. That is the worst version of this field — the orchestrator would compare the
  // stale fence against an equally stale reply, find them equal, and conclude the instance
  // did not move on exactly the load where it did.
  assert.match(
    body.slice(readAt, readAt + 200),
    /const liveAfterLoad = app\?\.extensionManager\?\.workflow\?\.activeWorkflow \|\| null;/,
    "the identity comes from a FRESH lookup, not the pre-load capture",
  );
});

test("#1478 the field is SHAPE-GATED — only a canonical instance uuid is published", () => {
  // #716's rule. A routing handle or a half-established value would be adopted by the
  // orchestrator as an instance identity and fence future commands against something that
  // is not one. An absent field costs a round trip through the existing fallback.
  const body = graphLoadBody();
  assert.match(body, /isCanonicalWorkflowInstanceUuid\(uuid\)/, "gated on the canonical check");
  assert.match(
    body,
    /let loadedWorkflowUuid;/,
    "undefined by default, so every path that cannot prove an identity omits the field",
  );
});

test("#1478 an unreadable identity omits the field instead of throwing", () => {
  // Reading the identity is itself an operation that can fail, and this runs AFTER the
  // graph has already landed — a throw here would turn a successful load into a failed
  // one, which is strictly worse than the mismatch this is fixing.
  const body = graphLoadBody();
  const readAt = body.indexOf("const liveAfterLoad");
  const after = body.slice(readAt);
  assert.match(after.slice(0, 700), /\} catch \{/, "the read is guarded");
  assert.doesNotMatch(after.slice(0, 700), /throw /, "and never rethrows");
});

test("#1478 the in-place path still PRESERVES the instance — the field only reports", () => {
  // The field must not be mistaken for a behaviour change. An in-place load keeps the
  // instance on purpose (#570 P0b): re-minting there would reject the agent's own
  // follow-up commands mid-conversation. The reply reports whatever is live, so that path
  // simply matches the fence and the orchestrator has nothing to say.
  const body = graphLoadBody();
  assert.match(body, /__cmcpKeepInstance: true/, "the in-place keep-instance option is intact");
});
