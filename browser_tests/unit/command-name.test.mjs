// #1297 — a truncated or concatenated command name (and a nested compact-router
// envelope) must be a structured malformed-name validation error, not
// "Unknown command" / "Unknown panel tool", and must not dispatch.
//
// Unfixed: GRAPH_TOOL_EXECUTORS lookup misses, throw `Unknown command "${cmd}"`.
// That is the wrong diagnosis — the name is damaged, not missing — and it
// invited retries that could not succeed until the name was repaired.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  MALFORMED_TOOL_NAME_CODE,
  classifyCommandName,
  malformedCommandNameError,
  malformedToolNameException,
  readMalformedToolName,
} from "../../web/js/lib/command-name.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8");

/** The pre-fix dispatcher: lookup miss → "Unknown command". */
function unfixedDispatch(cmd) {
  const GRAPH_TOOL_EXECUTORS = { graph_set_widget() { return { ok: true, mutated: true }; } };
  const executor = GRAPH_TOOL_EXECUTORS[cmd];
  if (!executor) return { ok: false, error: `Unknown command "${cmd}"`, mutated: true };
  return executor();
}

test("#1297 truncated panel_set_widget name is malformed, not unknown", () => {
  const name = "panel_set_widget...";
  const unfixed = unfixedDispatch(name);
  assert.match(unfixed.error, /Unknown command/);
  assert.equal(unfixed.mutated, true, "unfixed path does not even claim a no-op");

  const verdict = classifyCommandName(name);
  assert.equal(verdict.kind, "malformed");
  assert.equal(verdict.code, MALFORMED_TOOL_NAME_CODE);
  assert.equal(verdict.reason, "truncated_or_concatenated");

  const message = malformedCommandNameError(name);
  assert.match(message, /malformed tool name/);
  assert.doesNotMatch(message, /Unknown command/);
  assert.doesNotMatch(message, /Unknown panel tool/);
  assert.match(message, /Nothing was applied/);
});

test("#1297 glued JSON on a panel_set_widget name is malformed, not unknown", () => {
  const name = 'panel_set_widget{"node_id":1}';
  assert.equal(classifyCommandName(name).kind, "malformed");
  const message = malformedCommandNameError(name);
  assert.match(message, /malformed tool name/);
  assert.doesNotMatch(message, /Unknown command|Unknown panel tool/);
});

test("#1297 unicode-ellipsis truncation is malformed", () => {
  const name = "panel_set_widget\u2026";
  assert.equal(classifyCommandName(name).kind, "malformed");
  assert.equal(classifyCommandName(name).reason, "truncated_or_concatenated");
});

test("#1297 nested compact-router envelope is malformed, not unknown", () => {
  for (const name of ["call_tool", "list_tools", "describe_tool"]) {
    const unfixed = unfixedDispatch(name);
    assert.match(unfixed.error, /Unknown command/, name);

    const verdict = classifyCommandName(name);
    assert.equal(verdict.kind, "malformed", name);
    assert.equal(verdict.reason, "nested_router", name);

    const message = malformedCommandNameError(name);
    assert.match(message, /malformed tool name/, name);
    assert.match(message, /nested router envelope/, name);
    assert.doesNotMatch(message, /Unknown command/, name);
    assert.doesNotMatch(message, /Unknown panel tool/, name);
    assert.match(message, /Nothing was applied/, name);
    assert.match(message, /panel_set_widget/, name);
  }
});

test("#1297 panel-prefixed compact-router envelope is malformed", () => {
  // Prefix is the panel namespace; verb is a compact-router name. The
  // router itself is not a canvas tool, so it is not written as one token.
  const prefix = "panel_";
  for (const verb of ["call_tool", "list_tools", "describe_tool"]) {
    const name = prefix.concat(verb);
    const verdict = classifyCommandName(name);
    assert.equal(verdict.kind, "malformed", name);
    assert.equal(verdict.reason, "nested_router", name);
  }
});

test("#1297 well-formed unknown names stay unknown, not malformed", () => {
  assert.equal(classifyCommandName("graph_not_a_real_cmd").kind, "well_formed");
  assert.equal(malformedCommandNameError("graph_not_a_real_cmd"), null);
  assert.equal(malformedToolNameException("graph_set_widget"), null);
  assert.equal(classifyCommandName("graph_set_widget").kind, "well_formed");
  assert.equal(classifyCommandName("panel_set_widget").kind, "well_formed");
});

test("#1297 empty name is malformed", () => {
  assert.equal(classifyCommandName("").kind, "malformed");
  assert.equal(classifyCommandName(null).kind, "malformed");
  assert.match(malformedCommandNameError(""), /empty/);
});

test("#1297 exception is structured and claims applied:false", () => {
  const err = malformedToolNameException("panel_set_widget...");
  assert.ok(err);
  const payload = readMalformedToolName(err);
  assert.deepEqual(payload, { code: MALFORMED_TOOL_NAME_CODE, applied: false });
});

test("#1297 inherited or forged payload is not a validation miss", () => {
  const forged = new Error("nope");
  Object.setPrototypeOf(forged, Object.assign(Object.create(Error.prototype), {
    cmcpMalformedToolName: { code: MALFORMED_TOOL_NAME_CODE, applied: false },
  }));
  assert.equal(readMalformedToolName(forged), null);

  const mutated = malformedToolNameException("panel_set_widget...");
  mutated.cmcpMalformedToolName.applied = true;
  assert.equal(readMalformedToolName(mutated), null);
});

test("#1297 dispatch validates the name before GRAPH_TOOL_EXECUTORS lookup", () => {
  const execAt = PANEL.indexOf("const executor = GRAPH_TOOL_EXECUTORS[msg.cmd];");
  assert.notEqual(execAt, -1, "executor lookup must still exist");
  const classifyAt = PANEL.indexOf("malformedToolNameException(msg.cmd)");
  assert.notEqual(classifyAt, -1, "the name must be classified before dispatch");
  assert.ok(classifyAt < execAt, "classification must precede executor lookup");
  const throwAt = PANEL.indexOf("if (malformedName) throw malformedName");
  assert.notEqual(throwAt, -1, "malformed names must throw, not fall through");
  assert.ok(classifyAt < throwAt && throwAt < execAt, "throw sits between classify and lookup");
  const askAt = PANEL.indexOf('if (msg.cmd === "ask_user")', classifyAt);
  assert.ok(throwAt < askAt, "validation runs before any special-case executor");
});

test("#1297 the error reply publishes code malformed_tool_name and applied:false", () => {
  const catchAt = PANEL.indexOf("const malformedToolName = readMalformedToolName(err);");
  assert.notEqual(catchAt, -1);
  const region = PANEL.slice(catchAt, catchAt + 2200);
  assert.match(region, /\.\.\.\(malformedToolName \? \{ code: malformedToolName\.code, applied: false \} : \{\}\)/);
});
