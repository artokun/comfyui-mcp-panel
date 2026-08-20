/**
 * Unit tests for web/js/lib/partial-run-prune.js — run with `node --test`.
 *
 * Guards comfyui-mcp#1871: `panel_run(to_node_id: 43)` was refused because nodes 56/57
 * on an UNRELATED output branch named a class the server does not have. ComfyUI's
 * `validate_prompt` checks every posted node's class BEFORE it narrows execution to
 * `partial_execution_targets`, so a branch the caller excluded could veto a branch they
 * asked for.
 *
 * The two properties these tests pin:
 *   1. the backward closure is COMPLETE — a run must never lose a node its branch needs
 *      (the direction that turns a working run into "Required input is missing");
 *   2. the second post is licensed only by STRUCTURED evidence that the first one queued
 *      nothing, and only when the node ComfyUI named is one the caller's scope excluded.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  upstreamClosure,
  rejectionNodeId,
  rejectionQueuedNothing,
  prunedScopedPromptBody,
  prunedRetryForRejection,
  prunedRetryNote,
} from "../../web/js/lib/partial-run-prune.js";

// The reporter's shape: one checkpoint feeding TWO independent output branches. 43 is
// the ByteDance output they asked for; 56/57 are the Topaz nodes that refused it.
const TWO_BRANCH = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd.safetensors" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["1", 1] } },
  "3": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], seed: 42 } },
  "40": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["1", 2] } },
  "43": { class_type: "SaveImage", inputs: { images: ["40", 0] } },
  "56": { class_type: "TopazUpscale", inputs: { image: ["40", 0] } },
  "57": { class_type: "SaveImage", inputs: { images: ["56", 0] } },
};

const bodyFor = (prompt, targets, extra = {}) =>
  JSON.stringify({
    prompt,
    client_id: "abc",
    number: 1073741822,
    partial_execution_targets: targets,
    extra_data: { extra_pnginfo: { workflow: { nodes: ["the whole graph"] } } },
    ...extra,
  });

const rejection = (nodeId, classType = "TopazUpscale") => ({
  error: {
    type: "missing_node_type",
    message: `Node '${classType}' not found. The custom node may not be installed.`,
    details: `Node ID '#${nodeId}'`,
    extra_info: { node_id: String(nodeId), class_type: classType, node_title: classType },
  },
  node_errors: {},
});

// A Response double with the surface the guard uses (mirrors run-scope-guard.test.mjs).
function jsonResponse(status, obj) {
  return {
    status,
    clone() {
      return { json: async () => JSON.parse(JSON.stringify(obj)) };
    },
    text: async () => JSON.stringify(obj),
  };
}

// ---------------------------------------------------------------------------
// The closure — completeness first
// ---------------------------------------------------------------------------

test("#1871 upstreamClosure keeps the target and everything upstream, and nothing else", () => {
  const keep = upstreamClosure(TWO_BRANCH, ["43"]);
  assert.deepEqual([...keep].sort(), ["1", "2", "3", "40", "43"]);
  // The other branch is out — that is the whole fix.
  assert.equal(keep.has("56"), false);
  assert.equal(keep.has("57"), false);
});

test("#1871 upstreamClosure keeps a node SHARED by both branches", () => {
  // 40 feeds 43 AND 56. Targeting 57 must still bring 40, 3, 2, 1 along.
  const keep = upstreamClosure(TWO_BRANCH, ["57"]);
  assert.deepEqual([...keep].sort(), ["1", "2", "3", "40", "56", "57"]);
});

test("#1871 upstreamClosure handles several roots at once", () => {
  const keep = upstreamClosure(TWO_BRANCH, ["43", "57"]);
  assert.equal(keep.size, Object.keys(TWO_BRANCH).length);
});

test("#1871 upstreamClosure accepts subgraph colon-path ids as ordinary keys", () => {
  const nested = {
    "10:15:358": { class_type: "VAEDecode", inputs: { samples: ["7", 0] } },
    "10:15:359": { class_type: "PreviewImage", inputs: { images: ["10:15:358", 0] } },
    "7": { class_type: "KSampler", inputs: {} },
    "99": { class_type: "SaveImage", inputs: { images: ["7", 0] } },
  };
  const keep = upstreamClosure(nested, ["10:15:359"]);
  assert.deepEqual([...keep].sort(), ["10:15:358", "10:15:359", "7"]);
});

test("#1871 upstreamClosure is null when a requested root is not in the prompt — a closure it cannot resolve is never guessed", () => {
  assert.equal(upstreamClosure(TWO_BRANCH, ["404"]), null);
  assert.equal(upstreamClosure(TWO_BRANCH, ["43", "404"]), null);
  assert.equal(upstreamClosure(TWO_BRANCH, []), null);
  assert.equal(upstreamClosure(null, ["43"]), null);
  assert.equal(upstreamClosure([], ["43"]), null);
});

test("#1871 upstreamClosure terminates on a link cycle", () => {
  const cyclic = {
    a: { class_type: "A", inputs: { x: ["b", 0] } },
    b: { class_type: "B", inputs: { x: ["a", 0] } },
    z: { class_type: "Z", inputs: {} },
  };
  const keep = upstreamClosure(cyclic, ["a"]);
  assert.deepEqual([...keep].sort(), ["a", "b"]);
});

test("#1871 upstreamClosure reads a dependency the way ComfyUI does — the input value ITSELF, never something nested inside it", () => {
  // codex gate r1, P1. A widget value can be an arbitrary object, and scanning into it
  // pulled unrelated nodes into the closure. That is not a harmless over-keep: the retry
  // is declined when the node ComfyUI named is inside the closure, so a coordinate pair
  // in some node's settings would silently reinstate the refusal this module removes.
  //
  // Neither ComfyUI consumer looks inside a value: comfy_execution/graph_utils.is_link
  // tests the value, and execution.validate_inputs reads `val[0]` of the value.
  const odd = {
    "1": { class_type: "Loader", inputs: {} },
    "2": {
      class_type: "Weird",
      inputs: {
        image: ["1", 0], // a real link — kept
        config: { coordinates: ["56", 0] }, // widget data — NOT a link
        many: [["3", 0], ["4", 0]], // a list of pairs is not a link either
      },
    },
    "3": { class_type: "Other", inputs: {} },
    "4": { class_type: "Another", inputs: {} },
    "56": { class_type: "TopazUpscale", inputs: {} },
  };
  assert.deepEqual([...upstreamClosure(odd, ["2"])].sort(), ["1", "2"]);
});

test("#1871 upstreamClosure does not treat a longer list as a dependency — validate_inputs never looks one up", () => {
  // `len(val) != 2` is an error there, not a lookup, so the node is not needed. Keeping
  // it would be an over-keep, and an over-keep of the refused node suppresses the retry.
  const g = {
    "7": { class_type: "Loader", inputs: {} },
    "8": { class_type: "Consumer", inputs: { x: ["7", 0, 99], y: ["7"] } },
  };
  assert.deepEqual([...upstreamClosure(g, ["8"])], ["8"]);
});

test("#1871 upstreamClosure keeps a node referenced by a top-level pair even when the id is not a STRING — validate_inputs looks it up unguarded", () => {
  // execution.py validate_inputs does `o_id = val[0]; prompt[o_id]['class_type']` for
  // ANY length-2 list input. Keeping a superset of what the executor's stricter is_link
  // walks is the safe side: pruning such a node away would turn the retry into an
  // exception_during_validation.
  const g = {
    "7": { class_type: "Loader", inputs: {} },
    "8": { class_type: "Consumer", inputs: { x: [7, 0] } },
  };
  assert.deepEqual([...upstreamClosure(g, ["8"])].sort(), ["7", "8"]);
});

test("#1871 upstreamClosure ignores a link-shaped value naming a node that is not in the prompt", () => {
  const g = { "1": { class_type: "A", inputs: { size: [512, 0] } } };
  assert.deepEqual([...upstreamClosure(g, ["1"])], ["1"]);
});

// ---------------------------------------------------------------------------
// Reading the rejection — structured fields only
// ---------------------------------------------------------------------------

test("#1871 rejectionNodeId reads extra_info.node_id, as a string or a number", () => {
  assert.equal(rejectionNodeId(rejection(56)), "56");
  assert.equal(rejectionNodeId({ error: { extra_info: { node_id: 56 } } }), "56");
});

test("#1871 rejectionNodeId never parses PROSE — a rejection that only says it in the message is not a licence", () => {
  assert.equal(
    rejectionNodeId({
      error: {
        type: "missing_node_type",
        message: "Node 'TopazUpscale' not found. The custom node may not be installed.",
        details: "Node ID '#56'",
        extra_info: {},
      },
    }),
    null,
  );
  // The shapes with no node at all: outputs failed validation, no outputs.
  assert.equal(rejectionNodeId({ error: { type: "prompt_outputs_failed_validation", extra_info: {} } }), null);
  assert.equal(rejectionNodeId({ error: { type: "prompt_no_outputs" } }), null);
  assert.equal(rejectionNodeId({}), null);
  assert.equal(rejectionNodeId(null), null);
});

test("#1871 rejectionQueuedNothing: a body carrying a prompt_id is an ACCEPTED prompt and is never re-postable", () => {
  // The #944 partial-validation reply: node_errors AND an id, for a prompt already running.
  assert.equal(
    rejectionQueuedNothing({ prompt_id: "abc", error: { extra_info: { node_id: "56" } }, node_errors: {} }),
    false,
  );
  assert.equal(rejectionQueuedNothing(rejection(56)), true);
  assert.equal(rejectionQueuedNothing({ node_errors: { 3: {} } }), false); // no top-level error
  assert.equal(rejectionQueuedNothing({ error: {} }), false); // empty error object
});

// ---------------------------------------------------------------------------
// The rewritten body
// ---------------------------------------------------------------------------

test("#1871 prunedScopedPromptBody removes the other branch and carries every other field through untouched", () => {
  const out = prunedScopedPromptBody(bodyFor(TWO_BRANCH, ["43"]), ["43"]);
  assert.ok(out);
  assert.deepEqual(out.removed.sort(), ["56", "57"]);
  const parsed = JSON.parse(out.text);
  assert.deepEqual(Object.keys(parsed.prompt).sort(), ["1", "2", "3", "40", "43"]);
  // The scope still travels, so the guard's own verification still passes on the retry.
  assert.deepEqual(parsed.partial_execution_targets, ["43"]);
  // The queue-position mark identifies this run; losing it would make our own post foreign.
  assert.equal(parsed.number, 1073741822);
  assert.equal(parsed.client_id, "abc");
  // extra_data carries the FULL workflow for extra_pnginfo — a saved image still embeds
  // the graph the user was looking at, not the pruned prompt.
  assert.deepEqual(parsed.extra_data.extra_pnginfo.workflow.nodes, ["the whole graph"]);
  // The kept nodes are byte-identical, links and all.
  assert.deepEqual(parsed.prompt["3"], TWO_BRANCH["3"]);
});

test("#1871 prunedScopedPromptBody returns null when there is nothing to prune — no identical second post", () => {
  assert.equal(prunedScopedPromptBody(bodyFor(TWO_BRANCH, ["43", "57"]), ["43", "57"]), null);
});

test("#1871 prunedScopedPromptBody returns null for a body it cannot read or a target it cannot resolve", () => {
  assert.equal(prunedScopedPromptBody("not json", ["43"]), null);
  assert.equal(prunedScopedPromptBody(JSON.stringify([1, 2]), ["43"]), null);
  assert.equal(prunedScopedPromptBody(bodyFor(TWO_BRANCH, ["43"]), ["404"]), null);
  assert.equal(prunedScopedPromptBody(bodyFor(TWO_BRANCH, ["43"]), []), null);
  assert.equal(prunedScopedPromptBody(JSON.stringify({ prompt: null, partial_execution_targets: ["43"] }), ["43"]), null);
});

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

test("#1871 prunedRetryForRejection: the reported case — a 400 naming an out-of-scope node buys one pruned post", async () => {
  const body = bodyFor(TWO_BRANCH, ["43"]);
  const out = await prunedRetryForRejection(jsonResponse(400, rejection(56)), body, ["43"]);
  assert.ok(out);
  assert.equal(out.namedNode, "56");
  assert.deepEqual(out.removed.sort(), ["56", "57"]);
  assert.deepEqual(Object.keys(JSON.parse(out.text).prompt).sort(), ["1", "2", "3", "40", "43"]);
});

test("#1871 prunedRetryForRejection: a widget value that merely CONTAINS the refused node's id does not suppress the retry", () => {
  // codex gate r1, P1 — the regression this pins. Node 43's settings hold a coordinate
  // pair `["56", 0]` nested in an object. Scanning into widget values put 56 in the
  // closure, so the retry was declined and the reporter's refusal came straight back.
  const withWidgetData = {
    ...TWO_BRANCH,
    "43": { class_type: "SaveImage", inputs: { images: ["40", 0], meta: { crop: ["56", 0] } } },
  };
  const keep = upstreamClosure(withWidgetData, ["43"]);
  assert.equal(keep.has("56"), false, "a nested pair is widget data, not a dependency");
  return prunedRetryForRejection(
    jsonResponse(400, rejection(56)),
    bodyFor(withWidgetData, ["43"]),
    ["43"],
  ).then((out) => {
    assert.ok(out, "the run is still retried");
    assert.deepEqual(out.removed.sort(), ["56", "57"]);
  });
});

test("#1871 prunedRetryForRejection: a missing node INSIDE the requested branch is NOT retried — pruning cannot fix it and the clear answer is the useful one", async () => {
  const body = bodyFor(TWO_BRANCH, ["43"]);
  assert.equal(await prunedRetryForRejection(jsonResponse(400, rejection(40, "VAEDecode")), body, ["43"]), null);
  // The target itself.
  assert.equal(await prunedRetryForRejection(jsonResponse(400, rejection(43, "SaveImage")), body, ["43"]), null);
});

test("#1871 prunedRetryForRejection: nothing is re-posted without structured proof that the first post queued nothing", async () => {
  const body = bodyFor(TWO_BRANCH, ["43"]);
  // Accepted (2xx) — the run is already queued.
  assert.equal(await prunedRetryForRejection(jsonResponse(200, { prompt_id: "p1" }), body, ["43"]), null);
  // A prompt id ALONGSIDE the error (#944 partial validation): already running.
  assert.equal(
    await prunedRetryForRejection(jsonResponse(400, { ...rejection(56), prompt_id: "p1" }), body, ["43"]),
    null,
  );
  // A rejection that names no node in a structured field.
  assert.equal(
    await prunedRetryForRejection(
      jsonResponse(400, { error: { type: "prompt_outputs_failed_validation", details: "Node ID '#56'", extra_info: {} } }),
      body,
      ["43"],
    ),
    null,
  );
  // A node we never sent.
  assert.equal(await prunedRetryForRejection(jsonResponse(400, rejection(999)), body, ["43"]), null);
  // Unreadable response / unreadable request.
  assert.equal(await prunedRetryForRejection(null, body, ["43"]), null);
  assert.equal(await prunedRetryForRejection({ status: 400 }, body, ["43"]), null);
  assert.equal(await prunedRetryForRejection(jsonResponse(400, rejection(56)), "not json", ["43"]), null);
  // An UNSCOPED run (no targets) is never pruned — the caller asked for the whole graph.
  assert.equal(await prunedRetryForRejection(jsonResponse(400, rejection(56)), body, []), null);
});

test("#1871 prunedRetryForRejection never throws on a response whose json() rejects", async () => {
  const hostile = {
    status: 400,
    clone: () => ({
      json: async () => {
        throw new Error("body already read");
      },
    }),
  };
  assert.equal(await prunedRetryForRejection(hostile, bodyFor(TWO_BRANCH, ["43"]), ["43"]), null);
});

test("#1871 the disclosure names the node ComfyUI refused, what was omitted, and what is still broken", () => {
  const note = prunedRetryNote({ toNodeId: 43, namedNode: "56", removed: ["56", "57"] });
  assert.match(note, /node 56/);
  assert.match(note, /56, 57/);
  assert.match(note, /Nothing was queued by that refusal/);
  // It must not leave the caller thinking the missing pack is now fine.
  assert.match(note, /FULL run will still fail/);
});
