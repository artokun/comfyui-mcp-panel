/**
 * Unit tests for web/js/lib/exec-error-bounds.js — run with `node --test`.
 *
 * #664: graph_get_errors emitted the raw execution_error detail VERBATIM as
 * `last_execution_error`. ComfyUI puts the LIVE values in current_inputs /
 * current_outputs (latents, images — tensor-sized) and traceback lines can be
 * huge tensor reprs, so one sampling failure shipped a 41k+ token tool result
 * that overflowed the agent's context. These tests pin the bounded shape:
 * same keys an existing consumer reads, capped text surfaces, and every cut
 * DISCLOSED in-band — never silently dropped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  EXEC_ERR_MESSAGE_CAP,
  EXEC_ERR_TRACEBACK_MAX_LINES,
  EXEC_ERR_TRACEBACK_LINE_CAP,
  EXEC_ERR_EXECUTED_CAP,
  EXEC_ERR_OUTPUTS_JSON_CAP,
  boundExecFailurePayload,
  executionErrorMatchesCurrentGraph,
  applyRuntimeExecFailure,
} from "../../web/js/lib/exec-error-bounds.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_SOURCE = readFileSync(
  join(__dirname, "..", "..", "web", "js", "comfyui-mcp-panel.js"),
  "utf8",
);

// A hard upper bound on the serialized payload, derived from the caps rather
// than a round number: message + traceback + outputs + generous headroom for
// scalars and disclosure notes. The pre-fix payload had NO bound at all.
const WORST_CASE_CHARS =
  EXEC_ERR_MESSAGE_CAP +
  EXEC_ERR_TRACEBACK_MAX_LINES * EXEC_ERR_TRACEBACK_LINE_CAP +
  EXEC_ERR_OUTPUTS_JSON_CAP +
  4000;

test("null / undefined in → null out (no failure stays 'no failure')", () => {
  assert.equal(boundExecFailurePayload(null), null);
  assert.equal(boundExecFailurePayload(undefined), null);
});

test("a small well-formed failure passes through with every compat key intact", () => {
  const detail = {
    prompt_id: "p-1",
    node_id: 7,
    node_type: "KSampler",
    exception_type: "RuntimeError",
    exception_message: "mat1 and mat2 shapes cannot be multiplied",
    traceback: ["Traceback (most recent call last):", '  File "execution.py", line 1, in execute'],
    executed: [3, 5, 7],
    current_outputs: { 7: { images: [{ filename: "x.png" }] } },
    ts: "2026-08-05T00:00:00.000Z",
  };
  const out = boundExecFailurePayload(detail);
  assert.equal(out.prompt_id, "p-1");
  assert.equal(out.node_id, 7);
  assert.equal(out.node_type, "KSampler");
  assert.equal(out.exception_type, "RuntimeError");
  assert.equal(out.exception_message, detail.exception_message);
  assert.deepEqual(out.traceback, detail.traceback);
  assert.deepEqual(out.executed, [3, 5, 7]);
  assert.deepEqual(out.current_outputs, detail.current_outputs);
  assert.equal(out.ts, detail.ts);
  // Nothing was cut → NO truncation flags. Flags are a signal; emitting them
  // when nothing was cut would train consumers to ignore them.
  assert.equal(out.exception_message_truncated, undefined);
  assert.equal(out.traceback_truncated, undefined);
  assert.equal(out.current_outputs_omitted, undefined);
});

test("tensor-sized current_inputs never ships — disclosed, not silently dropped (#664)", () => {
  const tensorDump = "tensor([[" + "0.1234, ".repeat(200000) + "]])";
  const out = boundExecFailurePayload({
    node_id: 3,
    node_type: "KSampler",
    exception_message: "OOM",
    current_inputs: { latent: [tensorDump] },
  });
  assert.equal("current_inputs" in out, false, "the tensor-sized field must not be present");
  assert.equal(out.current_inputs_omitted, true, "the omission must be disclosed");
  assert.match(out.current_inputs_note, /#664/, "the note must say WHY (the overflow it prevents)");
  // The identity of the fault survives the omission.
  assert.equal(out.node_id, 3);
  assert.equal(out.node_type, "KSampler");
});

test("a huge exception_message is capped and the cut disclosed with the reason", () => {
  const out = boundExecFailurePayload({
    exception_message: "E".repeat(EXEC_ERR_MESSAGE_CAP * 10),
  });
  assert.equal(out.exception_message.length, EXEC_ERR_MESSAGE_CAP);
  assert.equal(out.exception_message_truncated, true);
  assert.match(out.exception_message_note, /fixed cap/, "the note must not promise a lever that does not exist");
});

test("traceback is capped by line count AND per-line length; both cuts raise one disclosed flag", () => {
  const tb = Array.from({ length: EXEC_ERR_TRACEBACK_MAX_LINES + 25 }, (_, i) => `line ${i}`);
  const out1 = boundExecFailurePayload({ traceback: tb });
  assert.equal(out1.traceback.length, EXEC_ERR_TRACEBACK_MAX_LINES);
  assert.equal(out1.traceback_truncated, true);
  assert.match(out1.traceback_note, /server console/, "the remedy must name where the full text lives");

  // A single tensor-repr line under the line-count cap must STILL be cut.
  const out2 = boundExecFailurePayload({ traceback: ["tensor(" + "1, ".repeat(50000) + ")"] });
  assert.equal(out2.traceback.length, 1);
  assert.equal(out2.traceback[0].length, EXEC_ERR_TRACEBACK_LINE_CAP);
  assert.equal(out2.traceback_truncated, true);
});

test("current_outputs ships raw only when small; a tensor-sized map is omitted with disclosure", () => {
  const small = boundExecFailurePayload({ current_outputs: { 1: { images: [] } } });
  assert.deepEqual(small.current_outputs, { 1: { images: [] } });
  assert.equal(small.current_outputs_omitted, undefined);

  const big = boundExecFailurePayload({
    current_outputs: { 1: { latents: ["t".repeat(EXEC_ERR_OUTPUTS_JSON_CAP * 5)] } },
  });
  assert.equal("current_outputs" in big, false);
  assert.equal(big.current_outputs_omitted, true);
  assert.match(big.current_outputs_note, /Omitted/);
});

test("an unserializable current_outputs (BigInt) is omitted, not shipped and never throws", () => {
  const out = boundExecFailurePayload({ current_outputs: { v: 10n } });
  assert.equal("current_outputs" in out, false);
  assert.equal(out.current_outputs_omitted, true);
});

test("the executed list is count-capped with a disclosed note, not a bare boolean", () => {
  const ids = Array.from({ length: EXEC_ERR_EXECUTED_CAP + 50 }, (_, i) => i);
  const out = boundExecFailurePayload({ executed: ids });
  assert.equal(out.executed.length, EXEC_ERR_EXECUTED_CAP);
  assert.equal(out.executed_truncated, true);
  assert.match(out.executed_note, /fixed cap/, "the note must state the cap and that no lever raises it");
  assert.match(out.executed_note, /node_id/, "the note must point at where the failure is actually identified");
});

test("a non-object detail is coerced into the message — a failure is never reported as absent", () => {
  const out = boundExecFailurePayload("boom");
  assert.ok(out && typeof out === "object");
  assert.equal(out.exception_message, "boom");
});

test("escape-heavy text is capped on its SERIALIZED length — JSON expansion can't bypass the bound", () => {
  // Each control character serializes to a six-character escape: a 4000-char
  // raw message would cross the bridge as ~24k chars under a raw-length cap.
  const heavy = "\u0000".repeat(EXEC_ERR_MESSAGE_CAP);
  const out = boundExecFailurePayload({
    exception_message: heavy,
    traceback: ["\u0000".repeat(EXEC_ERR_TRACEBACK_LINE_CAP)],
  });
  assert.ok(JSON.stringify(out.exception_message).length - 2 <= EXEC_ERR_MESSAGE_CAP);
  assert.equal(out.exception_message_truncated, true);
  assert.ok(JSON.stringify(out.traceback[0]).length - 2 <= EXEC_ERR_TRACEBACK_LINE_CAP);
  assert.equal(out.traceback_truncated, true);
  // Printable text at exactly the cap is untouched (escLen == raw length).
  const plain = boundExecFailurePayload({ exception_message: "E".repeat(EXEC_ERR_MESSAGE_CAP) });
  assert.equal(plain.exception_message.length, EXEC_ERR_MESSAGE_CAP);
  assert.equal(plain.exception_message_truncated, undefined);
});

test("worst case stays under the derived hard bound (#664 shipped 41k+ TOKENS)", () => {
  const out = boundExecFailurePayload({
    prompt_id: "p",
    node_id: 1,
    node_type: "N",
    exception_type: "E",
    exception_message: "M".repeat(EXEC_ERR_MESSAGE_CAP * 4),
    traceback: Array.from({ length: 500 }, () => "T".repeat(EXEC_ERR_TRACEBACK_LINE_CAP * 3)),
    executed: Array.from({ length: 5000 }, (_, i) => i),
    current_inputs: { latent: ["L".repeat(1000000)] },
    current_outputs: { 1: ["O".repeat(1000000)] },
    ts: "2026-08-05T00:00:00.000Z",
  });
  const size = JSON.stringify(out).length;
  assert.ok(
    size <= WORST_CASE_CHARS,
    `serialized payload ${size} chars exceeds the derived worst case ${WORST_CASE_CHARS}`,
  );
  // Same worst case with maximally escape-heavy text — the pre-round-2 raw-length
  // cap would serialize to ~6× the bound here.
  const heavy = boundExecFailurePayload({
    exception_message: "\u0000".repeat(EXEC_ERR_MESSAGE_CAP * 4),
    traceback: Array.from({ length: 500 }, () => "\u0001".repeat(EXEC_ERR_TRACEBACK_LINE_CAP * 3)),
  });
  const heavySize = JSON.stringify(heavy).length;
  assert.ok(
    heavySize <= WORST_CASE_CHARS,
    `escape-heavy serialized payload ${heavySize} chars exceeds the derived worst case ${WORST_CASE_CHARS}`,
  );
});

test("capSerializedText never splits a surrogate pair and keeps the maximal fitting prefix", () => {
  // 3998 a's + one emoji (2 code units) + filler: the maximal prefix under the
  // 4000 serialized-char cap ends WITH the emoji. A code-unit binary search can
  // land mid-pair (a lone surrogate escapes to 6 chars, breaking monotonicity)
  // and return less (codex gate round 3).
  const emoji = "\u{1F600}";
  const text = "a".repeat(EXEC_ERR_MESSAGE_CAP - 2) + emoji + "b".repeat(500);
  const out = boundExecFailurePayload({ exception_message: text });
  assert.equal(out.exception_message, "a".repeat(EXEC_ERR_MESSAGE_CAP - 2) + emoji);
  assert.equal(out.exception_message_truncated, true);
  assert.ok(JSON.stringify(out.exception_message).length - 2 <= EXEC_ERR_MESSAGE_CAP);
});

test("current_outputs omission note states the cap is fixed and names no phantom lever", () => {
  const big = boundExecFailurePayload({
    current_outputs: { 1: { latents: ["t".repeat(EXEC_ERR_OUTPUTS_JSON_CAP * 5)] } },
  });
  assert.equal(big.current_outputs_omitted, true);
  assert.match(big.current_outputs_note, /fixed cap, no parameter raises it/);
});

// Source guard: the lib bounds only matter while graph_get_errors actually
// EMITS through them. A revert to the verbatim emission — the exact #664
// defect — must fail the build, not slip through (a fix on one branch was
// once silently reverted by a later bulk rewrite; token presence ≠ wiring).
// #1448: the argument is the correlated detail, not the raw lastExecFailure
// capture — emitting lastExecFailure here re-joins a stale error by id alone.
test("graph_get_errors emits the bounded payload and the verbatim emission is gone (#664)", () => {
  assert.match(
    PANEL_SOURCE,
    /last_execution_error:\s*boundExecFailurePayload\(execFailureDetail\)/,
    "graph_get_errors must emit the correlated execFailureDetail through boundExecFailurePayload",
  );
  assert.ok(
    !/last_execution_error:\s*lastExecFailure\b/.test(PANEL_SOURCE),
    "the verbatim `last_execution_error: lastExecFailure` emission must not reappear",
  );
  assert.ok(
    !/last_execution_error:\s*boundExecFailurePayload\(lastExecFailure\)/.test(PANEL_SOURCE),
    "emitting the raw lastExecFailure capture re-opens #1448 (id-only join across workflows)",
  );
});

function nodesById(...nodes) {
  return new Map(nodes.map((n) => [String(n.id), n]));
}

test("#1448 reporter: RCAITKLoadPipeline failure is not joined onto LoadImage id 2", () => {
  // Measured: workflow A failed at node id 2 (RCAITKLoadPipeline,
  // ModuleNotFoundError: No module named 'src.pipelines'). After switching to
  // workflow B, node id 2 was LoadImage, and panel_get_errors still attached
  // that exception to it because correlation was id-only.
  const e = {
    node_id: 2,
    node_type: "RCAITKLoadPipeline",
    exception_type: "ModuleNotFoundError",
    exception_message: "No module named 'src.pipelines'",
  };
  const byId = nodesById({ id: 2, type: "LoadImage" });
  const applied = applyRuntimeExecFailure(e, byId);
  assert.equal(applied.detail, null, "last_execution_error must omit the foreign failure");
  assert.equal(applied.failure, null, "clean must not be dirtied by the foreign failure");
  assert.equal(applied.reason, null, "LoadImage must not receive an execution reason");
  assert.equal(boundExecFailurePayload(applied.detail), null);
  assert.equal(executionErrorMatchesCurrentGraph(e, byId), false);
});

test("#1448 a matching id AND type still reports the runtime failure", () => {
  const e = {
    node_id: 2,
    node_type: "RCAITKLoadPipeline",
    exception_type: "ModuleNotFoundError",
    exception_message: "No module named 'src.pipelines'",
  };
  const byId = nodesById({ id: 2, type: "RCAITKLoadPipeline" });
  const applied = applyRuntimeExecFailure(e, byId);
  assert.equal(applied.detail, e);
  assert.equal(applied.failure.node_id, 2);
  assert.equal(applied.failure.node_type, "RCAITKLoadPipeline");
  assert.equal(applied.failure.exception_type, "ModuleNotFoundError");
  assert.equal(applied.failure.message, "No module named 'src.pipelines'");
  assert.deepEqual(applied.reason, {
    kind: "execution",
    exception_type: "ModuleNotFoundError",
    message: "No module named 'src.pipelines'",
  });
  const payload = boundExecFailurePayload(applied.detail);
  assert.equal(payload.node_id, 2);
  assert.equal(payload.node_type, "RCAITKLoadPipeline");
});

test("#1448 a reused id whose current node is absent from the viewed graph is omitted", () => {
  const e = { node_id: 2, node_type: "RCAITKLoadPipeline", exception_message: "gone" };
  const applied = applyRuntimeExecFailure(e, nodesById({ id: 9, type: "LoadImage" }));
  assert.equal(applied.detail, null);
  assert.equal(applied.reason, null);
});

test("#1448 missing type information fails OPEN so a genuine failure is not swallowed", () => {
  const noErrorType = applyRuntimeExecFailure(
    { node_id: 2, exception_message: "boom" },
    nodesById({ id: 2, type: "LoadImage" }),
  );
  assert.equal(noErrorType.failure.node_id, 2);
  assert.equal(noErrorType.reason.kind, "execution");

  const noNodeType = applyRuntimeExecFailure(
    { node_id: 2, node_type: "LoadImage", exception_message: "boom" },
    nodesById({ id: 2 }),
  );
  assert.equal(noNodeType.failure.node_id, 2);
});

test("#1448 comfyClass is the type that execution_error.node_type names", () => {
  const e = { node_id: 2, node_type: "LoadImage", exception_message: "bad image" };
  const applied = applyRuntimeExecFailure(e, nodesById({ id: 2, type: "Load Image", comfyClass: "LoadImage" }));
  assert.equal(applied.detail, e);
  const mismatch = applyRuntimeExecFailure(e, nodesById({ id: 2, type: "LoadImage", comfyClass: "RCAITKLoadPipeline" }));
  assert.equal(mismatch.detail, null);
});

test("#1448 a node-id-less failure stays graph-level — there is no node to mis-blame", () => {
  const e = { exception_type: "RuntimeError", exception_message: "prompt failed" };
  const applied = applyRuntimeExecFailure(e, nodesById({ id: 2, type: "LoadImage" }));
  assert.equal(applied.detail, e);
  assert.equal(applied.reason, null);
  assert.equal(applied.failure.node_id, null);
});

test("graph_get_errors correlates runtime failures through applyRuntimeExecFailure (#1448)", () => {
  assert.match(
    PANEL_SOURCE,
    /applyRuntimeExecFailure\(e,\s*byId\)/,
    "graph_get_errors must correlate the captured error against the current graph's node map",
  );
  assert.match(
    PANEL_SOURCE,
    /const clean =\s*!nodeErrors &&\s*!execFailure &&/,
    "clean must follow the correlated execFailure, not the raw lastExecFailure capture",
  );
  assert.ok(
    !/const clean =\s*!nodeErrors &&\s*!lastExecFailure &&/.test(PANEL_SOURCE),
    "clean must not be dirtied by a stale lastExecFailure from another workflow",
  );
});
