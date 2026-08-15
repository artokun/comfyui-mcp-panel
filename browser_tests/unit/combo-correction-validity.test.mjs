import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyCurrentDefWidgetValues } from "../../web/js/lib/node-widget-materialization.js";

// #1369 — a stale-schema "correction" wrote a value the widget's own COMBO does not
// accept, and then said the node was valid to queue.
//
// The reporter added a KJNodes `PathchSageAttentionKJ`. Its `sage_attention` widget held
// "disabled" — a real member of the list — and was rewritten to boolean `false`. ComfyUI
// then refused the run:
//
//   Value not in list (sage_attention: False not in ['disabled','auto', …])
//
// ROOT CAUSE IS UPSTREAM, and worth stating because it decides the fix. Read from the
// live node, not inferred: KJNodes declares a COMBO whose default is not in its own
// option list —
//
//   "sage_attention": [ ["disabled","auto", …], { "default": false, … } ]
//
// a leftover from when that input was a BOOLEAN. So applyCurrentDefWidgetValues did
// exactly what it exists to do (#626): take the value from the CURRENT backend
// definition. What is ours is trusting a definition that contradicts itself, and then
// CERTIFYING the result.
//
// The certification is the expensive half. A correction that produces an invalid value is
// recoverable — the queue refuses it and you look. One that produces an invalid value and
// says "the node is valid to queue" suppresses that check, which is how it cost a render.

/** The reporter's node, reduced to the input that matters. */
const SAGE_OPTIONS = [
  "disabled",
  "auto",
  "sageattn_qk_int8_pv_fp16_cuda",
  "sageattn3",
];
const kjSpec = () => ({
  input: {
    required: {
      // The self-contradiction, verbatim in shape: a COMBO defaulting to `false`.
      sage_attention: [SAGE_OPTIONS, { default: false, tooltip: "…" }],
    },
  },
});
const nodeWith = (value) => ({ widgets: [{ name: "sage_attention", value, options: {} }] });

test("#1369: a COMBO default outside its own options is REFUSED, not applied", () => {
  const node = nodeWith("disabled");
  const out = {};
  const corrections = applyCurrentDefWidgetValues(node, kjSpec(), out);

  // The value the user can actually queue survives.
  assert.equal(node.widgets[0].value, "disabled");
  // …and nothing is reported as a correction, because nothing was corrected.
  assert.equal(corrections.length, 0);
});

test("#1369: the refusal is REPORTED — a self-contradicting pack is worth saying", () => {
  const node = nodeWith("disabled");
  const out = {};
  applyCurrentDefWidgetValues(node, kjSpec(), out);

  assert.equal(out.rejected.length, 1);
  assert.deepEqual(out.rejected[0], {
    name: "sage_attention",
    proposed: false,
    kept: "disabled",
  });
});

test("a VALID combo default is still applied — the #626 fix is not disabled", () => {
  // The direction that would silently un-ship the original fix: refusing every combo
  // correction would leave stale values in place, which is what #626 exists to prevent.
  const node = nodeWith("disabled");
  const def = {
    input: { required: { sage_attention: [SAGE_OPTIONS, { default: "auto" }] } },
  };
  const out = {};
  const corrections = applyCurrentDefWidgetValues(node, def, out);

  assert.equal(node.widgets[0].value, "auto");
  assert.deepEqual(corrections, [{ name: "sage_attention", from: "disabled", to: "auto" }]);
  assert.equal(out.rejected.length, 0);
});

test("a NUMERIC correction is untouched by the combo check", () => {
  // The guard must key on "this input is a COMBO", not on "the value looks odd".
  const node = { widgets: [{ name: "steps", value: 1, options: {} }] };
  const def = { input: { required: { steps: ["INT", { default: 20, min: 20, max: 100 }] } } };
  const corrections = applyCurrentDefWidgetValues(node, def);

  assert.equal(node.widgets[0].value, 20);
  assert.equal(corrections.length, 1);
});

test("#1369: the warning no longer certifies the node as valid to queue", () => {
  const PANEL = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const at = PANEL.indexOf("registered node schema for");
  assert.ok(at > 0, "the stale-schema warning must exist");
  // COMMENT LINES ARE EXCLUDED, and that is not a convenience: the fix's own comment
  // QUOTES the sentence being removed in order to explain why. A check that cannot tell
  // an explanation from an instruction would force that explanation to be deleted — and
  // the first run of this test failed on exactly that, matching the comment rather than
  // any live string.
  const warning = PANEL.slice(at, at + 2000)
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

  // The sentence that made a bad value expensive.
  assert.ok(
    !warning.includes("The node is valid to queue"),
    "correcting values is not validating the node — it must not claim queue-safety",
  );
  // …and the filter is not so aggressive that it would miss a real one: prove it still
  // sees ordinary string content in that same window.
  assert.ok(warning.includes("registered node schema for"));
  // It still says what WAS done, so the caller is not left guessing.
  assert.ok(warning.includes("checked against the current definition"));
  assert.ok(warning.includes("not a full"));
});
