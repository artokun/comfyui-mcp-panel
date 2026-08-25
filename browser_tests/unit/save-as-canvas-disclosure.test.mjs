/**
 * #978 — after a successful Save-As the reporter's next graph command was refused as a
 * `workflow instance mismatch`, and a follow-up adds that `panel_graph_outline` and
 * `panel_get_errors` were rejected too, with neither `panel_open_workflow` nor
 * `panel_set_workflow_target({mode:"current"})` recovering.
 *
 * TWO fences used to exist here, and re-fencing only cleared ONE of them.
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
 * The production Save-As path now repaints and verifies the destination copy before the
 * first persist. That closes the second fence at its source instead of teaching callers
 * to re-open a copy whose metadata still names the source.
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

test("#939 a Save-As reply reports the verified destination repaint", () => {
  const reply = saveReplyIdentity(IDENTITY, { savedAs: true, canvasRepainted: true });
  assert.equal(reply.workflow_uuid, IDENTITY.uuid, "the identity to re-fence to is still reported");
  assert.equal(reply.workflow_instance_changed, true);
  assert.equal(reply.canvas_repainted, true);
  assert.doesNotMatch(reply.workflow_instance_note, /source workflow's graph/);
  assert.match(reply.workflow_instance_note, /rebound and verified the saved copy on the canvas/);
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

test("#939 the production adapter repaints before it captures and persists the copy", () => {
  const adapter = readFileSync(new URL("../../web/js/lib/workflow-save.js", import.meta.url), "utf8");
  assert.match(adapter, /await svc\.openWorkflow\(copy\);/);
  assert.match(adapter, /await repaintCanvas\(copy, finalTargetPath\)/);
  assert.match(adapter, /copy\?\.changeTracker\?\.prepareForSave\?\.\(\)/);
  assert.ok(
    adapter.indexOf("await repaintCanvas(copy, finalTargetPath)") < adapter.indexOf("await svc.saveWorkflow(copy)"),
    "the repaint must be complete before the copy is persisted",
  );
  const panel = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(panel, /repaintSaveAsCanvas/);
  assert.match(panel, /const canvasFence = \(\{ workflow \} = \{\}\)/);
  assert.match(panel, /saveAsCanvasGeneration/);
  assert.match(panel, /restoreCanvas: async \(\{ workflow \}\)/);
  assert.match(panel, /\[WORKFLOW_PATH_FIELD\]: destinationPath/);
  assert.match(panel, /loadGraphDataWithCompletionProof\(\{/);
  assert.ok(
    panel.indexOf("loadGraphDataWithCompletionProof({") < panel.indexOf("const rootGraph = app?.graph;"),
    "Save-As must prove the restore completed before trusting root identity",
  );
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
  assert.match(body, /saveReplyIdentity\([\s\S]*replyIdentity/);
  assert.match(
    body,
    /savedAs:\s*!!outcome\.saved_as,\s*canvasRepainted:\s*outcome\.canvas_repainted === true/,
    "the disclosure follows what the save DID, not the handler's name",
  );
  assert.ok(!/saveReplyIdentity\(replyIdentity, \{ savedAs: true \}\)/.test(body), "an unconditional true must not come back");
  // …and the shape that produces: a first save reads exactly like an in-place one.
  const firstSave = saveReplyIdentity(IDENTITY, { savedAs: false });
  assert.equal("canvas_repaint_not_requested" in firstSave, false);
  assert.equal("workflow_instance_changed" in firstSave, false);
});

test("#939 the old no-repaint disclosure is gone", () => {
  const reply = saveReplyIdentity(IDENTITY, { savedAs: true, canvasRepainted: true });
  assert.equal("canvas_not_repainted" in reply, false);
  assert.equal("canvas_repaint_not_requested" in reply, false);
  assert.equal(reply.canvas_repainted, true);
});
