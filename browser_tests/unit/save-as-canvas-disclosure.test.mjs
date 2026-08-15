/**
 * #978 — after a successful Save-As the reporter's next graph command was refused as a
 * `workflow instance mismatch`, and a follow-up adds that `panel_graph_outline` and
 * `panel_get_errors` were rejected too, with neither `panel_open_workflow` nor
 * `panel_set_workflow_target({mode:"current"})` recovering.
 *
 * TWO fences, and re-fencing only clears ONE of them.
 *
 *   COMMAND fence — a command's issued stamp vs the active workflow's uuid. A Save-As
 *   makes a different workflow active, so refusing is correct, and #747/#941 publish the
 *   produced identity so the caller can re-stamp.
 *
 *   GRAPH fence — the LIVE ROOT's identity tag vs the active workflow's uuid. Here is
 *   what the earlier note missed: ComfyUI's store moves the active pointer WITHOUT
 *   repainting. `workflowStore.openWorkflow` does not call `loadGraphData` — only
 *   `workflowService.openWorkflow` does — and the panel's own Save-As adapter documents
 *   this at `workflow-save.js`, where it is the reason the copy's state is persisted from
 *   the SOURCE tab rather than re-read from the shared canvas (#708).
 *
 * So a Save-As does not ASK for a repaint — which is all that is established. Whether the
 * canvas still holds the source graph when the caller reads the reply is NOT observed: a
 * user switching tabs, or a reconnect restoring one, can repaint during the save's awaits.
 * When it was not repainted, the graph fence refuses CORRECTLY, because the canvas really
 * is the other workflow's — and a caller that re-fenced perfectly is still refused, which
 * is exactly what the reporter did and saw.
 *
 * An earlier version of this fix stamped the produced identity onto the root to clear the
 * refusal. It was removed in review: with the canvas still holding the source graph, that
 * stamp puts the copy's identity on the source's canvas — the wrong-canvas claim the
 * fence exists to prevent. The remedy is to bring the copy onto the canvas, and the reply
 * now says so.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { saveReplyIdentity } from "../../web/js/lib/save-reply-identity.js";

const IDENTITY = { uuid: "99999999-8888-4777-8666-555555555555", routingKey: "wf:workflows/copy.json" };

test("#978 a Save-As reply says no repaint was REQUESTED, conditions the rest, and names the remedy", () => {
  const reply = saveReplyIdentity(IDENTITY, { savedAs: true });
  assert.equal(reply.workflow_uuid, IDENTITY.uuid, "the identity to re-fence to is still reported");
  assert.equal(reply.workflow_instance_changed, true);
  assert.equal(reply.canvas_repaint_not_requested, true, "the fact a caller cannot otherwise observe");
  assert.match(reply.workflow_instance_note, /canvas still holds the source workflow's graph/);
  // CONDITIONAL, because nothing here observes the root at reply time (codex): a user or
  // a reconnect could repaint the copy during the save's awaits. What is established is
  // that the save did not ASK for a repaint.
  assert.match(reply.workflow_instance_note, /unless something else repainted it/, "stated conditionally");
  assert.match(reply.workflow_instance_note, /If a graph command is then refused/, "conditional consequence");
  assert.doesNotMatch(reply.workflow_instance_note, /and a graph command is refused for/, "never asserts it will happen");
  // The whole instruction, not just the tool name: an earlier assertion matched
  // `/panel_open_workflow/` alone and survived a mutation that replaced "Open the saved"
  // with "Do nothing", because the parenthesised tool name was still there.
  assert.match(
    reply.workflow_instance_note,
    /Open the saved workflow \(panel_open_workflow\) to put it on the canvas/,
    "the one call that fixes it, as an instruction",
  );
  assert.match(reply.workflow_instance_note, /That may not be enough for GRAPH tools/, "re-fencing may not suffice");
});

test("#978 an IN-PLACE save says none of it — nothing changed about which canvas is live", () => {
  const reply = saveReplyIdentity(IDENTITY, { savedAs: false });
  assert.equal(reply.workflow_uuid, IDENTITY.uuid);
  assert.equal("workflow_instance_changed" in reply, false);
  assert.equal("canvas_repaint_not_requested" in reply, false);
  assert.equal("workflow_instance_note" in reply, false);
});

test("#978 an unavailable identity still reports ABSENCE rather than implying continuity", () => {
  const reply = saveReplyIdentity(null, { savedAs: true });
  assert.equal(reply.workflow_identity_unavailable, true);
  assert.match(reply.workflow_identity_note, /fenced to the workflow that was active BEFORE this save/);
  assert.equal("workflow_uuid" in reply, false);
});

test("#978 the claim about repainting is sourced from the adapter that documents it", () => {
  // The disclosure asserts something about ComfyUI's own store. That claim is not mine to
  // invent: the Save-As adapter records the same behaviour, and it is why the copy's
  // state is taken from the source tab rather than re-read from the shared canvas.
  const adapter = readFileSync(new URL("../../web/js/lib/workflow-save.js", import.meta.url), "utf8");
  assert.match(
    adapter,
    /`workflowStore\.openWorkflow` moves the `activeWorkflow` pointer and does NOT/,
    "the adapter documents the pointer move",
  );
  assert.match(adapter, /repaint the canvas \(only `workflowService\.openWorkflow` calls loadGraphData\)/);
});

test("#978 the unsound root stamp is NOT in the panel", () => {
  // Stamping the produced identity onto a root that still holds the SOURCE graph would
  // make both fences accept the copy while every graph tool operated on the source's
  // canvas. Removed in review; this keeps it removed.
  const panel = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.ok(!/stampRootForProducedSave/.test(panel), "a save must not claim a canvas it did not repaint");
});

test("#978 (codex r2) a FIRST SAVE gets none of the Save-As warnings", () => {
  // Asked to save an unsaved tab, the adapter classifies it `first_save`: the successor is
  // identity-CONTINUOUS with the temporary predecessor, so the root's pre-save uuid already
  // IS the active workflow's and no fence is about to refuse. Telling that caller to
  // re-fence and re-open would send them fixing something that is not broken.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const handler = src.slice(src.indexOf("async workflow_save_as({"));
  const body = handler.slice(0, handler.indexOf("\n  workflow_list()"));
  assert.match(
    body,
    /saveReplyIdentity\(replyIdentity, \{ savedAs: !!outcome\.saved_as \}\)/,
    "the disclosure follows what the save DID, not the handler's name",
  );
  assert.ok(!/saveReplyIdentity\(replyIdentity, \{ savedAs: true \}\)/.test(body), "an unconditional true must not come back");
  // …and the shape that produces: a first save reads exactly like an in-place one.
  const firstSave = saveReplyIdentity(IDENTITY, { savedAs: false });
  assert.equal("canvas_repaint_not_requested" in firstSave, false);
  assert.equal("workflow_instance_changed" in firstSave, false);
});

test("#978 (codex r2) the flag names what the SAVE did, not what the canvas is", () => {
  // `canvas_not_repainted` asserted a state nothing observed at reply time. The flag now
  // names the save's own behaviour, which is what this code can actually establish.
  const reply = saveReplyIdentity(IDENTITY, { savedAs: true });
  assert.equal("canvas_not_repainted" in reply, false, "the unobservable claim is gone");
  assert.equal(reply.canvas_repaint_not_requested, true);
});
