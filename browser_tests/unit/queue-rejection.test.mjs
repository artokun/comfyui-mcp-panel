/**
 * Unit tests for web/js/lib/queue-rejection.js — run with `node --test`.
 *
 * Guards #358: graph_run must NEVER report `queued:true` when ComfyUI refused the
 * prompt synchronously. ComfyUI rejects on two channels — per-node `node_errors`
 * (which the frontend stashes on `app.lastNodeErrors`) AND a TOP-LEVEL `error`
 * (e.g. `missing_node_type`) which the frontend shows in a dialog and then
 * DISCARDS. The pre-fix code inspected only `lastNodeErrors`, so a pure top-level
 * rejection left `lastNodeErrors` empty and produced a false `queued:true`. These
 * tests pin that the top-level error is now surfaced as a real failure.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  summarizePromptRejection,
  formatTopError,
  buildQueueAcceptResult,
} from "../../web/js/lib/queue-rejection.js";

// The exact top-level rejection body from issue #358.
const MISSING_NODE_TYPE = {
  type: "missing_node_type",
  message: "Node 'ID #159' has no class_type. The workflow may be corrupted or a custom node is missing.",
  details: "Node ID '#159'",
  extra_info: { node_id: "159", class_type: null, node_title: null },
};

test("#358: top-level missing_node_type with EMPTY lastNodeErrors is a FAILURE, not queued", () => {
  // This is the exact regression: pre-fix, lastNodeErrors={} ⇒ verdict null ⇒
  // caller returned queued:true. Now the captured top-level error yields a failure.
  const verdict = summarizePromptRejection({
    rejection: { error: MISSING_NODE_TYPE, node_errors: {} },
    lastNodeErrors: {},
  });
  assert.ok(verdict, "must produce a verdict (not null / not accepted)");
  assert.equal(verdict.queued, false);
  assert.equal(verdict.error_type, "missing_node_type");
  assert.match(verdict.error, /has no class_type/);
  assert.match(verdict.error, /Node ID '#159'/); // details folded in
});

test("a genuinely ACCEPTED prompt (no rejection, no node errors) is null ⇒ queued:true", () => {
  assert.equal(
    summarizePromptRejection({ rejection: null, lastNodeErrors: {} }),
    null,
  );
  assert.equal(
    summarizePromptRejection({ rejection: null, lastNodeErrors: null }),
    null,
  );
  // An accepted 200 response carrying an empty node_errors map must NOT be a failure.
  assert.equal(
    summarizePromptRejection({ rejection: { error: null, node_errors: {} }, lastNodeErrors: {} }),
    null,
  );
});

test("per-node validation errors (from the rejection body) surface as node_errors", () => {
  const nodeErrors = { 12: { errors: [{ message: "Value not in list", details: "bad.ckpt" }] } };
  const verdict = summarizePromptRejection({
    rejection: { error: null, node_errors: nodeErrors },
    lastNodeErrors: {},
  });
  assert.ok(verdict);
  assert.equal(verdict.queued, false);
  assert.deepEqual(verdict.node_errors, nodeErrors);
  assert.equal(verdict.error, undefined); // no top-level error string when only per-node
});

test("per-node validation errors from lastNodeErrors (top-level empty) still fail", () => {
  const nodeErrors = { 7: { errors: [{ message: "required input missing" }] } };
  const verdict = summarizePromptRejection({
    rejection: null,
    lastNodeErrors: nodeErrors,
  });
  assert.ok(verdict);
  assert.equal(verdict.queued, false);
  assert.deepEqual(verdict.node_errors, nodeErrors);
});

test("BOTH channels present: top-level error AND per-node errors are both reported", () => {
  const nodeErrors = { 3: { errors: [{ message: "x" }] } };
  const verdict = summarizePromptRejection({
    rejection: { error: MISSING_NODE_TYPE, node_errors: nodeErrors },
    lastNodeErrors: {},
  });
  assert.ok(verdict);
  assert.equal(verdict.queued, false);
  assert.equal(verdict.error_type, "missing_node_type");
  assert.deepEqual(verdict.node_errors, nodeErrors);
});

test('a string top-level error ("prompt outputs failed validation") is surfaced', () => {
  const verdict = summarizePromptRejection({
    rejection: { error: "prompt outputs failed validation", node_errors: {} },
    lastNodeErrors: {},
  });
  assert.ok(verdict);
  assert.equal(verdict.queued, false);
  assert.equal(verdict.error, "prompt outputs failed validation");
  assert.equal(verdict.error_type, undefined); // no structured type for a bare string
});

test("formatTopError folds message + details and tolerates odd shapes", () => {
  assert.equal(
    formatTopError({ type: "t", message: "boom", details: "here" }),
    "boom (here)",
  );
  assert.equal(formatTopError({ type: "only_type" }), "only_type");
  assert.equal(formatTopError("plain"), "plain");
  assert.equal(formatTopError(null), "prompt rejected");
  assert.equal(formatTopError({}), "prompt rejected");
});

test("empty/whitespace top-level error is NOT treated as a rejection", () => {
  assert.equal(
    summarizePromptRejection({ rejection: { error: "   ", node_errors: {} }, lastNodeErrors: {} }),
    null,
  );
});

// ── #358/mcp#531: the ACCEPT result must carry the queued prompt_id(s) ──────────

test("mcp#531: a single accepted run returns the prompt_id", () => {
  const r = buildQueueAcceptResult({ batchCount: 1, promptIds: ["p1"] });
  assert.equal(r.queued, true);
  assert.equal(r.batch_count, 1);
  assert.equal(r.prompt_id, "p1");
  assert.equal(r.prompt_ids, undefined, "no prompt_ids array for a single run");
});

test("a batch>1 accept returns prompt_id (first) AND prompt_ids (all)", () => {
  const r = buildQueueAcceptResult({ batchCount: 3, promptIds: ["p1", "p2", "p3"] });
  assert.equal(r.batch_count, 3);
  assert.equal(r.prompt_id, "p1");
  assert.deepEqual(r.prompt_ids, ["p1", "p2", "p3"]);
});

test("run-to-node carries ran_to_node alongside the prompt_id", () => {
  const r = buildQueueAcceptResult({ batchCount: 1, promptIds: ["p9"], ranToNode: 42 });
  assert.equal(r.prompt_id, "p9");
  assert.equal(r.ran_to_node, 42);
});

test("no captured prompt_id is outcome-unknown, never a queued success", () => {
  const r = buildQueueAcceptResult({ batchCount: 1, promptIds: [] });
  assert.equal(r.queued_unknown, true);
  assert.equal(r.queued, undefined);
  assert.equal(r.prompt_id, undefined);
  assert.equal(r.indeterminate_count, 1);
  assert.match(r.error, /prompt_id/);

  const blank = buildQueueAcceptResult({ batchCount: 1, promptIds: ["", "   "] });
  assert.equal(blank.queued_unknown, true, "blank receipts are not usable queue evidence");
  assert.equal(blank.prompt_id, undefined);
});

test("#1690: a mixed batch keeps known ids but makes the whole acknowledgement uncertain", () => {
  const r = buildQueueAcceptResult({ batchCount: 2, promptIds: ["   ", "p2"], uncertainCount: 1 });
  assert.equal(r.queued_unknown, true);
  assert.equal(r.queued, undefined);
  assert.equal(r.prompt_id, "p2", "the known receipt remains available for correlation");
  assert.equal(r.queued_count, 1);
  assert.equal(r.indeterminate_count, 1);
  assert.match(r.error, /incomplete|usable prompt_id/i);
});

test("a NUMERIC prompt_id is normalized to a string at ingestion (#370)", () => {
  const r = buildQueueAcceptResult({ batchCount: 1, promptIds: [7] });
  assert.strictEqual(r.prompt_id, "7"); // string, not number
  const b = buildQueueAcceptResult({ batchCount: 2, promptIds: [7, 8] });
  assert.strictEqual(b.prompt_id, "7");
  assert.deepEqual(b.prompt_ids, ["7", "8"]); // all strings
  // null/undefined ids are dropped before coercion (no "null"/"undefined" strings).
  const c = buildQueueAcceptResult({ batchCount: 1, promptIds: [null, "p1", undefined] });
  assert.strictEqual(c.prompt_id, "p1");
  assert.equal(c.prompt_ids, undefined);
});

test("a FALSY-but-valid prompt_id 0 is accepted and normalized to '0' (#370 falsy-0 gotcha)", () => {
  const r = buildQueueAcceptResult({ batchCount: 1, promptIds: [0] });
  assert.strictEqual(r.prompt_id, "0"); // NOT dropped, NOT the number 0
  const b = buildQueueAcceptResult({ batchCount: 2, promptIds: [0, 1] });
  assert.strictEqual(b.prompt_id, "0");
  assert.deepEqual(b.prompt_ids, ["0", "1"]);
});

test("mixed-representation ids (0 and '0') dedupe to one after normalization (#370)", () => {
  const r = buildQueueAcceptResult({ batchCount: 2, promptIds: [0, "0"] });
  assert.strictEqual(r.prompt_id, "0");
  assert.equal(r.prompt_ids, undefined, "0 and '0' are the SAME run — deduped to a single id");
  const b = buildQueueAcceptResult({ batchCount: 3, promptIds: [7, "7", 8] });
  assert.deepEqual(b.prompt_ids, ["7", "8"]);
});

// ── #699: "Prompt has no outputs" on a run-to-node ────────────────────────
//
// panel_run({to_node_id:30}) was refused with a bare "Prompt has no outputs"
// for a node panel_query_graph reported as is_output:true. Passing that string
// through reads as "your output node is not an output node" and gives an agent
// nothing to act on — the reporter's only way forward was to guess.
//
// The disagreement is real and lives in ComfyUI: /object_info sets output_node
// with `OUTPUT_NODE == True` (equality) while execution.py selects outputs with
// `OUTPUT_NODE is True` (identity). `1 == True` but `1 is not True`, so a pack
// setting OUTPUT_NODE = 1 is advertised as an output and refused at execution.
// The panel cannot see that in advance — the JSON is already a boolean — so the
// only honest place to say it is after the backend has disagreed.

const NO_OUTPUTS = { error: { type: "prompt_no_outputs", message: "Prompt has no outputs" } };

test("#699 a run-to-node no-outputs refusal explains the disagreement", () => {
  const r = summarizePromptRejection({
    rejection: NO_OUTPUTS,
    runToNode: { nodeId: 30, nodeType: "PixaromaSaveImage" },
  });
  assert.equal(r.queued, false);
  assert.equal(r.error_type, "prompt_no_outputs");
  // The backend's own words are preserved, not replaced.
  assert.match(r.error, /Prompt has no outputs/);
  // …and the target is named, so it is clearly not a bad node id.
  assert.match(r.error, /node 30 \(PixaromaSaveImage\)/);
  assert.match(r.error, /DISAGREEMENT/);
  // Both known causes, neither asserted as the verdict.
  assert.match(r.error, /muted or bypassed/);
  assert.match(r.error, /EQUALS True without BEING True/);
  // The remedy the reporter actually found working.
  assert.match(r.error, /omit to_node_id/);
});

test("#699 a FULL run's no-outputs message is left alone", () => {
  // Without a target, "no outputs" is simply true — the workflow has none — and
  // appending a run-to-node explanation would be noise on a correct message.
  const r = summarizePromptRejection({ rejection: NO_OUTPUTS });
  assert.equal(r.error, "Prompt has no outputs");
});

test("#699 other rejection types are never annotated, even under run-to-node", () => {
  // The hint is specific to an outputs disagreement. Attaching it to an unrelated
  // failure would mislead in a new direction.
  const r = summarizePromptRejection({
    rejection: { error: { type: "missing_node_type", message: "Node 'X' not found." } },
    runToNode: { nodeId: 30, nodeType: "PixaromaSaveImage" },
  });
  assert.equal(r.error, "Node 'X' not found.");
  assert.ok(!/DISAGREEMENT/.test(r.error));
});

test("#699 an accepted prompt stays accepted with a run-to-node target", () => {
  assert.equal(summarizePromptRejection({ rejection: null, runToNode: { nodeId: 30 } }), null);
});

test("#699 a missing node TYPE still produces a usable hint", () => {
  const r = summarizePromptRejection({ rejection: NO_OUTPUTS, runToNode: { nodeId: "7:2" } });
  assert.match(r.error, /node 7:2, which ComfyUI/);
});

test("WIRING: graph_run passes the run-to-node target into the summary", async () => {
  // The tests above prove the hint is right; none prove it is REACHED. graph_run
  // is a method on a module-private handler map in the monolith and the queue path
  // needs a live app, so the callable seam does not exist — pin the wiring.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  // Captured out of the resolve block…
  assert.ok(src.includes("runToNodeInfo = { nodeId: to_node_id, nodeType: res.node?.type };"),
    "the resolved target must be captured for the rejection summary");
  // …and actually handed to the summary. Without this line #699 reports the bare
  // backend string again with every test above still green.
  assert.ok(src.includes("runToNode: runToNodeInfo,"),
    "summarizePromptRejection must receive the run-to-node target");
});

// ── #1504: a MINTED prompt_id outranks node_errors ─────────────────────────
//
// panel_run answered
//
//   ComfyUI refused to queue the workflow
//   - VAEDecode (node 36): Required input is missing (samples)   … ×6
//
// and the ComfyUI queue showed `running: 1`, prompt b01ba287-…, `pending: 0` at the
// same instant. Every following graph read/edit was then rejected with QUEUE BUSY —
// by the very render the caller had just been told did not exist.
//
// Both statements came from ONE reply. ComfyUI validates each output independently
// (execution.validate_prompt); when some fail but at least one survives it logs
// "Output will be ignored", returns valid[0]=True, and server.py takes the
// `if valid[0]:` branch — prompt_queue.put(...), then
//
//     web.json_response({"prompt_id": …, "number": …, "node_errors": valid[3]})
//
// at status **200**. The reported workflow had several output branches with some
// disabled through node modes, so its bypassed VAEDecode branches are exactly the
// ones ComfyUI dropped.
//
// The panel could not tell the two apart because the frontend funnels both channels
// into one place: app.queuePrompt calls recordNodeErrors(res.node_errors) on the
// RESOLVED (200) response too, so app.lastNodeErrors is populated for a prompt that
// is on the GPU. The verdict now takes the minted prompt_id — a receipt ComfyUI
// issues only after queueing — over that ambiguous channel.

// The six bypassed VAEDecode branches from the report, in ComfyUI node_errors shape.
const DROPPED_VAE_DECODES = Object.fromEntries(
  [36, 41, 57, 60, 63, 66].map((id) => [
    String(id),
    {
      class_type: "VAEDecode",
      dependent_outputs: [],
      errors: [
        { type: "required_input_missing", message: "Required input is missing", details: "samples" },
      ],
    },
  ]),
);
const RUNNING_PROMPT_ID = "b01ba287-500f-418d-b2e1-353c891065f1";

test("#1504: node_errors beside a MINTED prompt_id is an accepted partial run, NOT a refusal", () => {
  const verdict = summarizePromptRejection({
    rejection: null, // 200 — nothing was captured on the non-200 rejection channel
    lastNodeErrors: DROPPED_VAE_DECODES, // …but the frontend stored the 200 node_errors here
    acceptedPromptIds: [RUNNING_PROMPT_ID],
  });
  assert.equal(
    verdict,
    null,
    "ComfyUI minted a prompt id, so this prompt IS queued — the node_errors name dropped outputs",
  );
});

test("#1504: the accept result reports the dropped outputs alongside the prompt_id", () => {
  // This is the mcp#944 shape — `queued:true` + prompt_id + node_errors, with NO
  // top-level error — which the orchestrator renders as its "[PARTIAL] ComfyUI
  // ACCEPTED this prompt and is running it, but it dropped N output(s)" disclosure.
  // That disclosure has existed since mcp v0.50.2 and was unreachable from here,
  // because the panel sent node_errors with no prompt_id beside them.
  const r = buildQueueAcceptResult({
    batchCount: 1,
    promptIds: [RUNNING_PROMPT_ID],
    droppedOutputs: DROPPED_VAE_DECODES,
  });
  assert.equal(r.queued, true);
  assert.equal(r.prompt_id, RUNNING_PROMPT_ID);
  assert.deepEqual(r.node_errors, DROPPED_VAE_DECODES);
  assert.equal(r.error, undefined, "no top-level error: the prompt was accepted");
});

test("#1504: a clean accept says nothing about dropped outputs", () => {
  // The disclosure is loud, so it must never fire on a run that dropped nothing.
  for (const dropped of [null, undefined, {}, [], "nope", 0]) {
    const r = buildQueueAcceptResult({ batchCount: 1, promptIds: ["p1"], droppedOutputs: dropped });
    assert.equal(
      r.node_errors,
      undefined,
      `no node_errors for droppedOutputs=${JSON.stringify(dropped)}`,
    );
  }
});

test("#1504 does NOT regress #358: a top-level rejection is still a refusal", () => {
  // The #358 shape is a 400, which mints nothing — acceptedPromptIds is empty and
  // the verdict is untouched.
  const verdict = summarizePromptRejection({
    rejection: { error: MISSING_NODE_TYPE, node_errors: {} },
    lastNodeErrors: {},
    acceptedPromptIds: [],
  });
  assert.ok(verdict);
  assert.equal(verdict.queued, false);
  assert.equal(verdict.error_type, "missing_node_type");
  assert.equal(verdict.prompt_id, undefined);
});

test("#1504: node_errors with NO minted prompt_id is still a refusal (unchanged)", () => {
  // A genuine 400 validation refusal: every output failed, nothing was queued.
  const verdict = summarizePromptRejection({
    rejection: { error: null, node_errors: DROPPED_VAE_DECODES },
    lastNodeErrors: {},
  });
  assert.ok(verdict, "with no receipt of acceptance the per-node errors still mean refused");
  assert.equal(verdict.queued, false);
  assert.deepEqual(verdict.node_errors, DROPPED_VAE_DECODES);
});

test("#1504: a top-level error PLUS a minted id stays a refusal, but carries the id", () => {
  // A batch whose first prompt was accepted and whose second was refused. The two
  // claims contradict each other, so the verdict does not silently pick the happy
  // one — it reports the refusal AND the id, which the orchestrator turns into its
  // "[UNCERTAIN] … a render may already be in flight, do NOT re-run" answer. Losing
  // the id here is what sends a caller to re-queue work that is already rendering.
  const verdict = summarizePromptRejection({
    rejection: { error: MISSING_NODE_TYPE, node_errors: {} },
    lastNodeErrors: {},
    acceptedPromptIds: ["p1", "p2"],
  });
  assert.ok(verdict);
  assert.equal(verdict.queued, false);
  assert.equal(verdict.prompt_id, "p1");
  assert.deepEqual(verdict.prompt_ids, ["p1", "p2"]);
});

test("#1504: accepted ids are normalized like every other id boundary (#370)", () => {
  // 0 is a real prompt id, and 0 / "0" are the same run.
  assert.equal(
    summarizePromptRejection({ lastNodeErrors: DROPPED_VAE_DECODES, acceptedPromptIds: [0] }),
    null,
    "the falsy-but-valid id 0 is still a receipt of acceptance",
  );
  const v = summarizePromptRejection({
    rejection: { error: MISSING_NODE_TYPE },
    acceptedPromptIds: [0, "0", null, "  ", undefined, 7],
  });
  assert.deepEqual(v.prompt_ids, ["0", "7"], "deduped after string normalization; blanks dropped");
});

test("#1504: an absent acceptedPromptIds argument leaves every caller verdict unchanged", () => {
  // Callers that never pass the new argument (and any odd value) must behave
  // exactly as before — the receipt only ever ADDS acceptance evidence.
  for (const ids of [undefined, null, [], "p1", 5, {}]) {
    const v = summarizePromptRejection({
      rejection: null,
      lastNodeErrors: { 7: { errors: [{ message: "required input missing" }] } },
      acceptedPromptIds: ids,
    });
    assert.ok(v, `acceptedPromptIds=${JSON.stringify(ids)} must not be read as an acceptance`);
    assert.equal(v.queued, false);
  }
});

test("WIRING #1504: graph_run captures the 200 node_errors and hands the ids to the verdict", async () => {
  // The tests above prove the verdict is right; none prove graph_run REACHES it.
  // graph_run lives on a module-private handler map in the monolith and needs a
  // live app, so pin the three lines the fix depends on. Without any one of them
  // every test above stays green while panel_run still reports the refusal.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  // …captured from the 200 body on BOTH dispatch paths (unscoped + run-to-node),
  assert.equal(
    src.split("onAcceptedNodeErrors: captureAcceptedNodeErrors,").length - 1,
    2,
    "both the unscoped interceptor and the scoped dispatch must capture accepted node_errors",
  );
  // …the minted ids reach the verdict (without this the refusal returns),
  assert.ok(
    src.includes("acceptedPromptIds: queuedPromptIds,"),
    "summarizePromptRejection must receive the prompt_ids ComfyUI minted",
  );
  // …and the dropped outputs reach the accept result (without this the caller is
  // never told which outputs will produce no file).
  assert.ok(
    src.includes("droppedOutputs: acceptedNodeErrors,"),
    "buildQueueAcceptResult must receive the dropped outputs",
  );
});
