// panel#1320 — panel_update_node hid the Manager update traceback behind
//
//   Update of "seedvr2_videoupscaler" FAILED: ... An error occurred while
//   updating 'seedvr2_videoupscaler'.. The pack was NOT updated — check the
//   ComfyUI server log for the full traceback.
//
// Manager's do_update (glob/manager_server.py) RETURNS that one-liner as the
// task result and prints the real evidence only to the server log:
//
//   * ManagedResult failure logs
//     ERROR: An error occurred while updating 'X'. (res.result=..., res.action=...)
//   * Exception path calls traceback.print_exc() and does not even log the
//     generic sentence.
//
// These tests pin the extractor against those two wire shapes, then drive the
// SHIPPED graph_update_node so a missing bind (the helper existing but never
// called) fails here instead of in the browser.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  classifyUpdateOutcome,
  taskFailureReason,
  isMethodNotAllowed,
  isManagerUnreachable,
  isManagerRouteMissing,
  dialectRetryTarget,
  assertBatchOk,
  legacyUpdateBody,
} from "../../web/js/lib/manager-install.js";
import {
  extractUpdateTraceback,
  isGenericManagerUpdateError,
  readUpdateTraceback,
  UPDATE_TRACEBACK_MAX_LINES,
  UPDATE_TRACEBACK_LINE_CAP,
} from "../../web/js/lib/manager-update-traceback.js";

const PACK = "seedvr2_videoupscaler";
const GENERIC = `An error occurred while updating '${PACK}'.`;

const ESC = String.fromCharCode(27);

// Verbatim shapes from ComfyUI-Manager's do_update. The KeyError is what the
// exception arm prints when cnr_map does not have the pack (the line after
// unified_update that reads cnr_map[node_name]); the res.action line is what
// the ManagedResult arm logs.
const EXCEPTION_TB = [
  "Traceback (most recent call last):",
  `  File "C:\\Users\\Artokun\\ComfyUI\\custom_nodes\\ComfyUI-Manager\\glob\\manager_server.py", line 1234, in do_update`,
  "    url = core.unified_manager.cnr_map[node_name].get('repository')",
  "          ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^",
  `KeyError: '${PACK}'`,
].join("\n");

const DETAILED_ERROR =
  `ERROR: An error occurred while updating '${PACK}'. (res.result=False, res.action=update-git)`;

const GIT_TB = [
  "Traceback (most recent call last):",
  `  File "C:\\Users\\Artokun\\ComfyUI\\custom_nodes\\ComfyUI-Manager\\glob\\manager_core.py", line 2100, in repo_update`,
  "    remote.fetch()",
  "git.exc.GitCommandError: Cmd('git') failed due to: exit code(128)",
  "  cmdline: git fetch",
  "  stderr: 'error: Your local changes to the following files would be overwritten by merge'",
].join("\n");

const GENERIC_ITEM = {
  ui_id: "u-1320",
  client_id: "comfyui-mcp-panel",
  kind: "update",
  result: GENERIC,
  status: { status_str: "error", completed: true, messages: [GENERIC] },
  params: { node_name: PACK },
};

function readPanelSource() {
  return readFileSync(
    fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
    "utf8",
  );
}

function pick(src, re, name) {
  const m = src.match(re);
  assert.ok(m, `could not locate ${name} in panel source`);
  return m[0];
}

// ---------------------------------------------------------------------------
// Pure extractor
// ---------------------------------------------------------------------------

test("#1320 the generic Manager sentence is recognised, and only that sentence", () => {
  assert.equal(isGenericManagerUpdateError(GENERIC), true);
  assert.equal(
    isGenericManagerUpdateError("the Manager reported the task as failed (no detail provided)"),
    true,
  );
  assert.equal(
    isGenericManagerUpdateError("Exception: 'InstallPackParams' object has no attribute 'node_name'"),
    false,
  );
  assert.equal(isGenericManagerUpdateError(null), false);
  assert.equal(isGenericManagerUpdateError(""), false);
});

test("#1320 extract: exception-arm traceback (no generic ERROR line in the log)", () => {
  // The exception arm print_exc()s and returns the generic sentence without
  // logging it. The traceback naming the pack / do_update is the whole record.
  const got = extractUpdateTraceback(EXCEPTION_TB, PACK);
  assert.match(got, /KeyError: 'seedvr2_videoupscaler'/);
  assert.match(got, /do_update/);
  assert.doesNotMatch(got, /check the ComfyUI server log/);
});

test("#1320 extract: ManagedResult arm keeps the res.action line", () => {
  // No traceback — the one extra fact Manager DID write is res.action.
  const got = extractUpdateTraceback(DETAILED_ERROR, PACK);
  assert.match(got, /res\.action=update-git/);
  assert.match(got, /seedvr2_videoupscaler/);
});

test("#1320 extract: traceback immediately above the generic ERROR is kept WITH the ERROR", () => {
  const log = `${GIT_TB}\n${DETAILED_ERROR}`;
  const got = extractUpdateTraceback(log, PACK);
  assert.match(got, /GitCommandError/);
  assert.match(got, /overwritten by merge/);
  assert.match(got, /res\.action=update-git/);
});

test("#1320 extract: colour codes do not defeat the match, or leak into the result", () => {
  const coloured =
    `${ESC}[31m[ERROR]${ESC}[0m ${DETAILED_ERROR}`;
  const got = extractUpdateTraceback(coloured, PACK);
  assert.match(got, /res\.action=update-git/);
  assert.ok(!got.includes(ESC), "an escape byte must never reach the reader");
});

test("#1320 extract: another pack's failure is NEVER attributed to this update", () => {
  const other = [
    "Traceback (most recent call last):",
    "  File \"manager_server.py\", line 1, in do_update",
    "KeyError: 'somebody-else'",
    "ERROR: An error occurred while updating 'somebody-else'. (res.result=False, res.action=update-git)",
  ].join("\n");
  assert.equal(extractUpdateTraceback(other, PACK), null);
  // A prefix of this pack's name is not this pack.
  assert.equal(extractUpdateTraceback(EXCEPTION_TB, "seed"), null);
});

test("#1320 extract: the LAST matching failure wins", () => {
  const log = [
    "Traceback (most recent call last):",
    "  File \"manager_server.py\", line 1, in do_update",
    "PermissionError: first attempt",
    `ERROR: An error occurred while updating '${PACK}'. (res.result=False, res.action=update-git)`,
    "Traceback (most recent call last):",
    "  File \"manager_server.py\", line 1, in do_update",
    "OSError: retry",
    `ERROR: An error occurred while updating '${PACK}'. (res.result=False, res.action=update-cnr)`,
  ].join("\n");
  const got = extractUpdateTraceback(log, PACK);
  assert.match(got, /OSError: retry/);
  assert.match(got, /res\.action=update-cnr/);
  assert.doesNotMatch(got, /PermissionError/);
});

test("#1320 extract: junk / empty / missing pack is not a verdict", () => {
  assert.equal(extractUpdateTraceback("", PACK), null);
  assert.equal(extractUpdateTraceback("unrelated info log\n", PACK), null);
  assert.equal(extractUpdateTraceback(EXCEPTION_TB, ""), null);
  assert.equal(extractUpdateTraceback(null, PACK), null);
  assert.equal(extractUpdateTraceback(EXCEPTION_TB, null), null);
});

test("#1320 extract: a long traceback is capped, and the cap is disclosed", () => {
  const lines = ["Traceback (most recent call last):"];
  for (let i = 0; i < UPDATE_TRACEBACK_MAX_LINES + 10; i++) {
    lines.push(`  File "x.py", line ${i}, in do_update`);
  }
  lines.push(`KeyError: '${PACK}'`);
  const got = extractUpdateTraceback(lines.join("\n"), PACK);
  assert.match(got, /truncated to last/);
  assert.match(got, new RegExp(`KeyError: '${PACK}'`));
  assert.ok(got.split(/\n/).length <= UPDATE_TRACEBACK_MAX_LINES + 2);
});

test("#1320 extract: a huge traceback LINE is capped", () => {
  const huge = "x".repeat(UPDATE_TRACEBACK_LINE_CAP + 80);
  const log = [
    "Traceback (most recent call last):",
    `  File "manager_server.py", line 1, in do_update`,
    `KeyError: '${PACK}' ${huge}`,
  ].join("\n");
  const got = extractUpdateTraceback(log, PACK);
  assert.ok(got.includes("…"));
  assert.ok(!got.includes(huge));
});

test("#1320 readUpdateTraceback uses fileURL, not /api, and never throws", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  const api = { fileURL: (r) => `/base${r}` };
  try {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ entries: [{ m: EXCEPTION_TB }] }) };
    };
    const got = await readUpdateTraceback(PACK, api);
    assert.match(got, /KeyError: 'seedvr2_videoupscaler'/);
    assert.deepEqual(calls, ["/base/internal/logs/raw"], "fileURL is honoured, /api is not");
    assert.ok(!calls[0].includes("/api/"), "the /api prefix is what 404s");

    globalThis.fetch = async () => ({ ok: false, status: 404 });
    assert.equal(await readUpdateTraceback(PACK, api), null);
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    assert.equal(await readUpdateTraceback(PACK, api), null);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(await readUpdateTraceback(PACK, undefined), null);
});

// ---------------------------------------------------------------------------
// classifyUpdateOutcome — the message the tool actually throws
// ---------------------------------------------------------------------------

test("#1320 classifyUpdateOutcome attaches the traceback and drops the 'check the log' pointer", () => {
  const outcome = classifyUpdateOutcome({
    item: GENERIC_ITEM,
    target: PACK,
    dialect: "v2",
    traceback: EXCEPTION_TB,
  });
  assert.equal(outcome.state, "failed");
  assert.match(outcome.message, /FAILED/);
  assert.match(outcome.message, /KeyError: 'seedvr2_videoupscaler'/);
  assert.match(outcome.message, /Manager traceback/);
  assert.doesNotMatch(outcome.message, /check the ComfyUI server log for the full traceback/);
});

test("#1320 classifyUpdateOutcome without a traceback still points at the log", () => {
  // Honest miss: we looked, the log did not yield one. The existing #364
  // wording stays so a specific Manager exception (already in `reason`) is
  // unchanged when no extra traceback is supplied.
  const outcome = classifyUpdateOutcome({
    item: GENERIC_ITEM,
    target: PACK,
    dialect: "v2",
  });
  assert.equal(outcome.state, "failed");
  assert.match(outcome.message, /check the ComfyUI server log for the full traceback/);
  assert.doesNotMatch(outcome.message, /Manager traceback/);
});

// ---------------------------------------------------------------------------
// SHIPPED PATH — the real graph_update_node, extracted
// ---------------------------------------------------------------------------

function buildGraphUpdateNode(deps) {
  const src = readPanelSource();
  const methodSrc = pick(
    src,
    /async graph_update_node\(\{ id, version, channel, mode \}\) \{[\s\S]*?\n  \},\r?\n/,
    "graph_update_node",
  );
  const boundDeps = {
    resolveManagerUpdateTarget: async (id) => id,
    ...deps,
  };
  const factory = new Function(
    ...Object.keys(boundDeps),
    `const handlers = { ${methodSrc} };\nreturn handlers.graph_update_node;`,
  );
  return factory(...Object.values(boundDeps));
}

test("#1320 graph_update_node CALLS readUpdateTraceback on a generic Manager failure", () => {
  // Without this the helper is dead code: a source-only test of the extractor
  // would pass just as happily with finalizeUpdate never reading the log.
  const method = pick(
    readPanelSource(),
    /async graph_update_node\(\{ id, version, channel, mode \}\) \{[\s\S]*?\n  \},\r?\n/,
    "graph_update_node",
  );
  assert.match(method, /readUpdateTraceback/);
  assert.match(method, /isGenericManagerUpdateError/);
  assert.match(method, /traceback/);
});

test("#1320 shipped graph_update_node surfaces the traceback, not a pointer to the log", async () => {
  let readFor = null;
  const update = buildGraphUpdateNode({
    detectManagerDialect: async () => "v2",
    crypto: { randomUUID: () => "u-1320" },
    api: { clientId: "c-1" },
    legacyUpdateBody,
    managerCall: async () => {
      throw new Error("legacy should not run");
    },
    managerV2: async () => ({}),
    isMethodNotAllowed,
    assertBatchOk,
    isManagerUnreachable,
    isManagerRouteMissing,
    dialectRetryTarget,
    noteManagerDialectDowngrade: () => {},
    reProbeManagerDialect: async () => "v2",
    waitForUpdateResult: async () => ({
      item: GENERIC_ITEM,
      status: { total_count: 0, done_count: 1, in_progress_count: 0, is_processing: false },
    }),
    classifyUpdateOutcome,
    taskFailureReason,
    isGenericManagerUpdateError,
    readUpdateTraceback: async (packId) => {
      readFor = packId;
      return extractUpdateTraceback(`${EXCEPTION_TB}\n${DETAILED_ERROR}`, packId);
    },
  });

  await assert.rejects(
    () => update({ id: PACK, version: "nightly" }),
    (err) => {
      assert.match(err.message, /FAILED/);
      assert.match(err.message, /KeyError: 'seedvr2_videoupscaler'/);
      assert.match(err.message, /do_update/);
      assert.match(err.message, /res\.action=update-git/);
      assert.doesNotMatch(
        err.message,
        /check the ComfyUI server log for the full traceback/,
        "the tool result is the traceback, not a pointer to it",
      );
      return true;
    },
  );
  assert.equal(readFor, PACK, "the log read is for the pack we asked to update");
});

test("#1320 shipped graph_update_node does NOT read the log for a specific Manager exception", async () => {
  // The #364 AttributeError is already in status.messages. Fetching the log
  // would only add latency; the reason is already the traceback.
  let reads = 0;
  const specific = {
    ...GENERIC_ITEM,
    status: {
      status_str: "error",
      completed: true,
      messages: ["Exception: 'InstallPackParams' object has no attribute 'node_name'"],
    },
  };
  const update = buildGraphUpdateNode({
    detectManagerDialect: async () => "v2",
    crypto: { randomUUID: () => "u-364" },
    api: { clientId: "c-1" },
    legacyUpdateBody,
    managerCall: async () => {
      throw new Error("legacy should not run");
    },
    managerV2: async () => ({}),
    isMethodNotAllowed,
    assertBatchOk,
    isManagerUnreachable,
    isManagerRouteMissing,
    dialectRetryTarget,
    noteManagerDialectDowngrade: () => {},
    reProbeManagerDialect: async () => "v2",
    waitForUpdateResult: async () => ({ item: specific, status: { is_processing: false } }),
    classifyUpdateOutcome,
    taskFailureReason,
    isGenericManagerUpdateError,
    readUpdateTraceback: async () => {
      reads += 1;
      return "SHOULD NOT BE ATTACHED";
    },
  });

  await assert.rejects(
    () => update({ id: "ComfyUI-GGUF" }),
    (err) => {
      assert.match(err.message, /no attribute 'node_name'/);
      assert.doesNotMatch(err.message, /SHOULD NOT BE ATTACHED/);
      return true;
    },
  );
  assert.equal(reads, 0, "a specific Manager exception does not pay for a log read");
});
