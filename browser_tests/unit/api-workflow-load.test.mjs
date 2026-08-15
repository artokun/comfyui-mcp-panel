// panel#775 — API/prompt-format workflows ARE loadable, and the panel refused
// them on a false premise.
//
// The refusal said: "workflow is in API/prompt format; provide the UI workflow
// JSON (the pack workflow.json is UI format)". Both halves were wrong. ComfyUI
// ships `app.loadApiJson` and uses it on its own file-drop path, and the pack
// that prompted the report ships API format — as does its upstream source — so
// the file it told the reader to provide does not exist.
//
// The numbers below are MEASURED, not invented: against the live rig
// (ComfyUI 0.30.2 / frontend 1.47.12) the report's exact workflow
// (jcd315/comfyui-mcp-muse workflows/ltx23_distill_3stage.json, 59 API entries)
// loaded as 56 nodes and 70 links with no throw, and the three that did not
// arrive were all LTXVImgToVideoConditionOnly — a node type the installed
// ComfyUI-LTXVideo does not provide.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  looksLikeApiWorkflow,
  apiClassCounts,
  apiLoadShortfall,
  apiLoadNote,
} from "../../web/js/lib/api-workflow-load.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/** The report's shape, reduced: numeric keys -> {class_type, inputs}. */
const API = {
  1: { class_type: "UNETLoader", inputs: { unet_name: "ltx.safetensors" } },
  10: { class_type: "LTXVImgToVideoConditionOnly", inputs: { positive: ["1", 0] } },
  11: { class_type: "LTXVImgToVideoConditionOnly", inputs: { positive: ["1", 0] } },
  12: { class_type: "LTXVImgToVideoConditionOnly", inputs: { positive: ["1", 0] } },
  20: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
};

describe_shape();
function describe_shape() {
  test("#775 the API shape is recognised, and a UI workflow is not", () => {
    assert.equal(looksLikeApiWorkflow(API), true);
    // A UI workflow has a top-level nodes array — the two cannot be confused.
    assert.equal(looksLikeApiWorkflow({ nodes: [], links: [] }), false);
    // Neither can anything else that happens to be an object.
    assert.equal(looksLikeApiWorkflow({}), false);
    assert.equal(looksLikeApiWorkflow(null), false);
    assert.equal(looksLikeApiWorkflow([]), false);
    assert.equal(looksLikeApiWorkflow("{}"), false);
    // Numeric keys alone are not enough — something must carry class_type.
    assert.equal(looksLikeApiWorkflow({ 1: { foo: 1 }, 2: { bar: 2 } }), false);
    // A single non-numeric key disqualifies it (that is a UI-ish object).
    assert.equal(looksLikeApiWorkflow({ 1: { class_type: "X" }, extra: {} }), false);
  });
}

test("#775 a fully-loaded graph reports NO shortfall", () => {
  const landed = [
    { type: "UNETLoader" },
    { type: "LTXVImgToVideoConditionOnly" },
    { type: "LTXVImgToVideoConditionOnly" },
    { type: "LTXVImgToVideoConditionOnly" },
    { type: "KSamplerSelect" },
  ];
  assert.deepEqual(apiLoadShortfall(API, landed), []);
});

test("#775 the MEASURED case: three nodes of one missing type", () => {
  // Exactly what the rig produced — the type is absent from the canvas entirely,
  // so all three instances are gone while everything else arrives.
  const landed = [{ type: "UNETLoader" }, { type: "KSamplerSelect" }];
  assert.deepEqual(apiLoadShortfall(API, landed), [
    { type: "LTXVImgToVideoConditionOnly", wanted: 3, got: 0 },
  ]);
});

test("#775 a PARTIAL shortfall is still a shortfall", () => {
  // One of three arriving is not success. Counting types rather than presence is
  // what catches this.
  const landed = [
    { type: "UNETLoader" },
    { type: "LTXVImgToVideoConditionOnly" },
    { type: "KSamplerSelect" },
  ];
  assert.deepEqual(apiLoadShortfall(API, landed), [
    { type: "LTXVImgToVideoConditionOnly", wanted: 3, got: 1 },
  ]);
});

test("#775 EXTRA nodes on the canvas never mask a shortfall", () => {
  // The canvas may hold nodes the API workflow never asked for. Comparing totals
  // would let 3 unrelated nodes hide 3 missing ones; comparing per TYPE cannot.
  const landed = [
    { type: "UNETLoader" },
    { type: "KSamplerSelect" },
    { type: "PreviewImage" },
    { type: "PreviewImage" },
    { type: "PreviewImage" },
  ];
  assert.deepEqual(apiLoadShortfall(API, landed), [
    { type: "LTXVImgToVideoConditionOnly", wanted: 3, got: 0 },
  ]);
});

test("#775 counts are per class_type", () => {
  const c = apiClassCounts(API);
  assert.equal(c.get("LTXVImgToVideoConditionOnly"), 3);
  assert.equal(c.get("UNETLoader"), 1);
  assert.equal(c.size, 3);
});

test("#775 the note ALWAYS states the layout caveat", () => {
  // It is always true and it is the one consequence a caller cannot infer from a
  // node count — and saving the result makes it permanent.
  const clean = apiLoadNote([]);
  assert.match(clean, /layout is generated rather than the author's/);
  assert.match(clean, /execution is unaffected/);
  assert.match(clean, /replaces the original layout permanently/);
  // With no shortfall it must NOT invent a missing-node warning.
  assert.doesNotMatch(clean, /NODES ARE MISSING/);
});

test("#775 the note NAMES the missing types and when they will bite", () => {
  const note = apiLoadNote([{ type: "LTXVImgToVideoConditionOnly", wanted: 3, got: 0 }]);
  assert.match(note, /NODES ARE MISSING/);
  assert.match(note, /LTXVImgToVideoConditionOnly \(3 of 3\)/);
  // The timing is the point: the graph looks fine and fails later, somewhere else.
  assert.match(note, /fail at queue time, not at load time/);
  assert.match(note, /Install the custom-node pack/);
});

test("#775 the note reads correctly for a single missing node", () => {
  const note = apiLoadNote([{ type: "Foo", wanted: 1, got: 0 }]);
  assert.match(note, /this node type/);
  assert.match(note, /that node did not load/);
  assert.match(note, /wired to it is now disconnected/);
  assert.doesNotMatch(note, /these node types/);
});

test("#775 ONE missing type can mean SEVERAL missing nodes", () => {
  // The measured case, and a grammar bug the real output exposed: three
  // instances of one type rendered as "that node ... wired to THEM". Types and
  // nodes are separate counts and the sentence has to track both.
  const note = apiLoadNote([{ type: "LTXVImgToVideoConditionOnly", wanted: 3, got: 0 }]);
  assert.match(note, /this node type/, "one TYPE is missing");
  assert.match(note, /those nodes did not load/, "but three NODES are");
  assert.match(note, /wired to them is now disconnected/);
  assert.match(note, /provides it and load again/, "and the pack to install is singular");
});

test("#775 WIRING: graph_load delegates to loadApiJson instead of refusing", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(
    src,
    /import \{ looksLikeApiWorkflow, apiLoadShortfall, apiLoadNote \} from "\.\/lib\/api-workflow-load\.js"/,
  );
  const i = src.indexOf("if (looksLikeApiWorkflow(data))");
  assert.ok(i > 0, "graph_load must branch on the API shape");
  // Bounded by the branch's own end, not by a character count. This read a fixed 2200-char
  // window, so adding a comment inside the branch silently pushed the LAST assertion out of
  // scope and failed a wiring test that was still perfectly satisfied — the window measured
  // prose, not code. The refusal below is the first thing after the branch closes.
  const end = src.indexOf('"graph is not a UI workflow', i);
  assert.ok(end > i, "the non-API refusal that follows the branch must still be recognisable");
  const branch = src.slice(i, end);
  assert.match(branch, /app\.loadApiJson\(apiClone, "graph_load\.json"\)/, "it imports rather than refusing");
  // The label avoids naming the internal bridge command on purpose: the
  // vocabulary gate reads any such name in a string as advice a model could try
  // to call, and it caught the first version of this line.
  assert.match(
    branch,
    /captureGraphSnapshot\(null, "before loading an API-format workflow"\)/,
    "and stays undoable like every other graph edit",
  );
  assert.match(branch, /apiLoadShortfall\(apiClone, landed\)/, "and compares what arrived");
  // #775 — the note now also receives the packs that failed to import, so this
  // asserts the note is WIRED rather than pinning its exact argument list.
  assert.match(branch, /note: apiLoadNote\(shortfall/, "and discloses it");
});

test("#775 the DISCREDITED refusal text is gone from the shipped panel", () => {
  // It told the reader to provide a UI workflow JSON that, for the pack in the
  // report, does not exist anywhere — not in the pack and not upstream.
  //
  // Comment lines are excluded deliberately: the docblock QUOTES the removed
  // text to record what was wrong and why, and the first run of this test caught
  // that quotation. The record is worth keeping; only shipped prose is the bug.
  const shipped = readFileSync(PANEL_JS, "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  assert.doesNotMatch(shipped, /the pack workflow\.json is UI format/);
  assert.doesNotMatch(shipped, /is in API\/prompt format; provide the UI workflow JSON/);
});

test("#775 a frontend WITHOUT loadApiJson still refuses, and says why", () => {
  // The capability is not universal. Falling through to loadGraphData with API
  // data would produce the 0-node "successful" load this issue also reported.
  const src = readFileSync(PANEL_JS, "utf8");
  const i = src.indexOf('typeof app.loadApiJson !== "function"');
  assert.ok(i > 0, "the absent-capability guard must exist");
  // Join the adjacent string chunks: a sentence the caller reads as one line is
  // not one literal in the source, and asserting on the raw text tests the line
  // breaks rather than the message.
  const guard = src
    .slice(i, i + 700)
    .replace(/"\s*\+\s*\n\s*"/g, "")
    .replace(/\s+/g, " ");
  assert.match(guard, /has no app\.loadApiJson to import it/);
  assert.match(guard, /top-level `nodes` array/, "and points at what WOULD work");
});
