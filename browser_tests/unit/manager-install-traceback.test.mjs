// panel#2012 — panel_install_node hid the Manager install cause behind
//
//   rgthree-comfy install FAILED: ... Installation failed. The install did
//   NOT complete — check the ComfyUI server log for the full traceback.
//
// Manager's do_install (glob/manager_server.py) RETURNS that one-liner as the
// task result and prints the real evidence only to the server log:
//
//   * ManagedResult failure logs
//     [ComfyUI-Manager] Installation failed:\n{res.msg}
//   * Exception path calls traceback.print_exc() and returns
//     "Installation failed:\n{node_spec_str}" — the spec is the pack, not the cause.
//
// These tests pin the extractor against those two wire shapes, then drive the
// SHIPPED verifyInstalled so a missing bind (the helper existing but never
// called) fails here instead of in the browser.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  classifyInstallOutcome,
  taskFailureReason,
  parseTaskHistoryItem,
  queueDrained,
  createManagerTaskResultLog,
} from "../../web/js/lib/manager-install.js";
import {
  extractInstallTraceback,
  isGenericManagerInstallError,
  readInstallTraceback,
  INSTALL_TRACEBACK_MAX_LINES,
  INSTALL_TRACEBACK_LINE_CAP,
} from "../../web/js/lib/manager-install-traceback.js";

const PACK = "rgthree-comfy";
const GENERIC = "Installation failed";
const GENERIC_SPEC = "Installation failed:\nrgthree-comfy@nightly";

const ESC = String.fromCharCode(27);

// Verbatim shapes from ComfyUI-Manager's do_install. The KeyError is what the
// exception arm prints when cnr_map does not have the pack; the Installation
// failed + res.msg block is what the ManagedResult arm logs.
const EXCEPTION_TB = [
  "Traceback (most recent call last):",
  `  File "C:\\Users\\Artokun\\ComfyUI\\custom_nodes\\ComfyUI-Manager\\glob\\manager_server.py", line 545, in do_install`,
  "    res = await core.unified_manager.install_by_id(node_name, version_spec, channel, mode, return_postinstall=skip_post_install)",
  "          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^",
  `KeyError: '${PACK}'`,
].join("\n");

const DETAILED_ERROR = [
  `[ComfyUI-Manager] Installation failed:`,
  `Failed to clone repo: https://github.com/rgthree/${PACK}`,
].join("\n");

const GIT_TB = [
  "Traceback (most recent call last):",
  `  File "C:\\Users\\Artokun\\ComfyUI\\custom_nodes\\ComfyUI-Manager\\glob\\manager_core.py", line 1800, in install_by_id`,
  "    git.Repo.clone_from(url, path)",
  "git.exc.GitCommandError: Cmd('git') failed due to: exit code(128)",
  "  cmdline: git clone",
  `  stderr: 'fatal: destination path 'custom_nodes/${PACK}' already exists'`,
].join("\n");

const GENERIC_ITEM = {
  ui_id: "u-2012",
  client_id: "comfyui-mcp-panel",
  kind: "install",
  result: GENERIC,
  status: { status_str: "error", completed: true, messages: [GENERIC] },
  params: { id: PACK, selected_version: "nightly" },
};

const DRAINED = { total_count: 1, done_count: 1, is_processing: false };
const INSTALLED_LIST = { "some-other-pack": { ver: "1.0", cnr_id: "some-other-pack" } };

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
// Pure classifier of the generic sentence
// ---------------------------------------------------------------------------

test("#2012 the generic Manager sentence is recognised, and only that sentence", () => {
  assert.equal(isGenericManagerInstallError(GENERIC), true);
  assert.equal(isGenericManagerInstallError(GENERIC_SPEC), true);
  assert.equal(isGenericManagerInstallError("Installation failed: rgthree-comfy"), true);
  assert.equal(isGenericManagerInstallError("Installation failed: rgthree-comfy@nightly"), true);
  assert.equal(
    isGenericManagerInstallError("the Manager reported the task as failed (no detail provided)"),
    true,
  );
  // A cause already in the task result must not pay for a log read.
  assert.equal(
    isGenericManagerInstallError("Installation failed: Failed to clone repo: https://github.com/rgthree/rgthree-comfy"),
    false,
  );
  assert.equal(
    isGenericManagerInstallError("Node 'rgthree-comfy@nightly' not found in [ManagerChannel.dev, ManagerDatabaseSource.cache]"),
    false,
  );
  assert.equal(
    isGenericManagerInstallError("Cannot resolve install target: 'rgthree-comfy@nightly'"),
    false,
  );
  assert.equal(isGenericManagerInstallError(null), false);
  assert.equal(isGenericManagerInstallError(""), false);
});

// ---------------------------------------------------------------------------
// Pure extractor
// ---------------------------------------------------------------------------

test("#2012 extract: exception-arm traceback (no Installation-failed line in the log)", () => {
  // The exception arm print_exc()s and returns the generic sentence without
  // logging it. The traceback naming the pack / do_install is the whole record.
  const got = extractInstallTraceback(EXCEPTION_TB, PACK);
  assert.match(got, /KeyError: 'rgthree-comfy'/);
  assert.match(got, /do_install/);
  assert.doesNotMatch(got, /check the ComfyUI server log/);
});

test("#2012 extract: ManagedResult arm keeps the res.msg lines", () => {
  const got = extractInstallTraceback(DETAILED_ERROR, PACK);
  assert.match(got, /Failed to clone repo/);
  assert.match(got, /rgthree-comfy/);
  assert.match(got, /Installation failed/);
});

test("#2012 extract: traceback immediately above the generic ERROR is kept WITH the ERROR", () => {
  const log = `${GIT_TB}\n${DETAILED_ERROR}`;
  const got = extractInstallTraceback(log, PACK);
  assert.match(got, /GitCommandError/);
  assert.match(got, /already exists/);
  assert.match(got, /Failed to clone repo/);
});

test("#2012 extract: colour codes do not defeat the match, or leak into the result", () => {
  const coloured =
    `${ESC}[31m[ERROR]${ESC}[0m ${DETAILED_ERROR}`;
  const got = extractInstallTraceback(coloured, PACK);
  assert.match(got, /Failed to clone repo/);
  assert.ok(!got.includes(ESC), "an escape byte must never reach the reader");
});

test("#2012 extract: another pack's failure is NEVER attributed to this install", () => {
  const other = [
    "Traceback (most recent call last):",
    "  File \"manager_server.py\", line 1, in do_install",
    "KeyError: 'somebody-else'",
    "[ComfyUI-Manager] Installation failed:",
    "Failed to clone repo: https://github.com/other/somebody-else",
  ].join("\n");
  assert.equal(extractInstallTraceback(other, PACK), null);
  // A prefix of this pack's name is not this pack.
  assert.equal(extractInstallTraceback(EXCEPTION_TB, "rgthree"), null);
});

test("#2012 extract: the LAST matching failure wins", () => {
  const log = [
    "Traceback (most recent call last):",
    "  File \"manager_server.py\", line 1, in do_install",
    "PermissionError: first attempt",
    `[ComfyUI-Manager] Installation failed:`,
    `Failed to clone repo: https://github.com/rgthree/${PACK}`,
    "Traceback (most recent call last):",
    "  File \"manager_server.py\", line 1, in do_install",
    "OSError: retry",
    `[ComfyUI-Manager] Installation failed:`,
    `pip install failed for https://github.com/rgthree/${PACK}`,
  ].join("\n");
  const got = extractInstallTraceback(log, PACK);
  assert.match(got, /OSError: retry/);
  assert.match(got, /pip install failed/);
  assert.doesNotMatch(got, /PermissionError/);
});

test("#2012 extract: junk / empty / missing pack is not a verdict", () => {
  assert.equal(extractInstallTraceback("", PACK), null);
  assert.equal(extractInstallTraceback("unrelated info log\n", PACK), null);
  assert.equal(extractInstallTraceback(EXCEPTION_TB, ""), null);
  assert.equal(extractInstallTraceback(null, PACK), null);
  assert.equal(extractInstallTraceback(EXCEPTION_TB, null), null);
});

test("#2012 extract: a long traceback is capped, and the cap is disclosed", () => {
  const lines = ["Traceback (most recent call last):"];
  for (let i = 0; i < INSTALL_TRACEBACK_MAX_LINES + 10; i++) {
    lines.push(`  File "x.py", line ${i}, in do_install`);
  }
  lines.push(`KeyError: '${PACK}'`);
  const got = extractInstallTraceback(lines.join("\n"), PACK);
  assert.match(got, /truncated to last/);
  assert.match(got, new RegExp(`KeyError: '${PACK}'`));
  assert.ok(got.split(/\n/).length <= INSTALL_TRACEBACK_MAX_LINES + 2);
});

test("#2012 extract: a huge traceback LINE is capped", () => {
  const huge = "x".repeat(INSTALL_TRACEBACK_LINE_CAP + 80);
  const log = [
    "Traceback (most recent call last):",
    `  File "manager_server.py", line 1, in do_install`,
    `KeyError: '${PACK}' ${huge}`,
  ].join("\n");
  const got = extractInstallTraceback(log, PACK);
  assert.ok(got.includes("…"));
  assert.ok(!got.includes(huge));
});

test("#2012 readInstallTraceback uses fileURL, not /api, and never throws", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  const api = { fileURL: (r) => `/base${r}` };
  try {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ entries: [{ m: EXCEPTION_TB }] }) };
    };
    const got = await readInstallTraceback(PACK, api);
    assert.match(got, /KeyError: 'rgthree-comfy'/);
    assert.deepEqual(calls, ["/base/internal/logs/raw"], "fileURL is honoured, /api is not");
    assert.ok(!calls[0].includes("/api/"), "the /api prefix is what 404s");

    globalThis.fetch = async () => ({ ok: false, status: 404 });
    assert.equal(await readInstallTraceback(PACK, api), null);
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    assert.equal(await readInstallTraceback(PACK, api), null);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(await readInstallTraceback(PACK, undefined), null);
});

// ---------------------------------------------------------------------------
// classifyInstallOutcome — the message the tool actually throws
// ---------------------------------------------------------------------------

test("#2012 classifyInstallOutcome attaches the traceback and drops the 'check the log' pointer", () => {
  const outcome = classifyInstallOutcome({
    target: PACK,
    dialect: "v2",
    status: DRAINED,
    installed: INSTALLED_LIST,
    taskFailure: GENERIC,
    traceback: EXCEPTION_TB,
  });
  assert.equal(outcome.state, "failed");
  assert.match(outcome.message, /FAILED/);
  assert.match(outcome.message, /KeyError: 'rgthree-comfy'/);
  assert.match(outcome.message, /Manager traceback/);
  assert.doesNotMatch(outcome.message, /check the ComfyUI server log for the full traceback/);
});

test("#2012 classifyInstallOutcome without a traceback still points at the log", () => {
  // Honest miss: we looked, the log did not yield one. The existing #1539
  // wording stays so a specific Manager exception (already in `reason`) is
  // unchanged when no extra traceback is supplied.
  const outcome = classifyInstallOutcome({
    target: PACK,
    dialect: "v2",
    status: DRAINED,
    installed: INSTALLED_LIST,
    taskFailure: GENERIC,
  });
  assert.equal(outcome.state, "failed");
  assert.match(outcome.message, /check the ComfyUI server log for the full traceback/);
  assert.doesNotMatch(outcome.message, /Manager traceback/);
});

// ---------------------------------------------------------------------------
// SHIPPED PATH — the real verifyInstalled, extracted
// ---------------------------------------------------------------------------

function buildVerifyInstalled(deps) {
  const src = readPanelSource();
  const boundDeps = {
    managerGet: async () => {
      throw new Error("unstubbed managerGet");
    },
    managerV2: async () => {
      throw new Error("unstubbed managerV2");
    },
    managerCall: async () => {
      throw new Error("unstubbed managerCall");
    },
    queueDrained,
    taskFailureReason,
    parseTaskHistoryItem,
    classifyInstallOutcome,
    MANAGER_FETCH_TIMEOUT_MS: 15000,
    INSTALL_VERIFY_BUDGET_MS: 4000,
    AbortSignal,
    setTimeout,
    managerTaskResults: createManagerTaskResultLog(),
    isGenericManagerInstallError,
    readInstallTraceback: async () => null,
    api: { fileURL: (r) => r },
    ...deps,
  };
  const factory = new Function(
    ...Object.keys(boundDeps),
    `${pick(src, /function boundedDelay\(ms, deadline\) \{[\s\S]*?\n\}/, "boundedDelay")}
${pick(src, /async function waitForQueueDrain\(\{[\s\S]*?\n\}/, "waitForQueueDrain")}
${pick(src, /async function verifyInstalled\(target, dialect, \{[\s\S]*?\n\}/, "verifyInstalled")}
return { verifyInstalled };`,
  );
  return factory(...Object.values(boundDeps));
}

test("#2012 verifyInstalled CALLS readInstallTraceback on a generic Manager failure", () => {
  // Without this the helper is dead code: a source-only test of the extractor
  // would pass just as happily with verifyInstalled never reading the log.
  const method = pick(
    readPanelSource(),
    /async function verifyInstalled\(target, dialect, \{[\s\S]*?\n\}/,
    "verifyInstalled",
  );
  assert.match(method, /readInstallTraceback/);
  assert.match(method, /isGenericManagerInstallError/);
  assert.match(method, /traceback/);
});

test("#2012 shipped verifyInstalled surfaces the traceback, not a pointer to the log", async () => {
  let readFor = null;
  const { verifyInstalled } = buildVerifyInstalled({
    managerV2: async (route) => {
      if (route.startsWith("manager/queue/history")) return { history: GENERIC_ITEM };
      if (route.startsWith("manager/queue/status")) return DRAINED;
      if (route.startsWith("customnode/installed")) return INSTALLED_LIST;
      throw new Error(`unstubbed route: ${route}`);
    },
    readInstallTraceback: async (packId) => {
      readFor = packId;
      return extractInstallTraceback(`${EXCEPTION_TB}\n${DETAILED_ERROR}`, packId);
    },
  });

  const outcome = await verifyInstalled(PACK, "v2", {
    budgetMs: 4000,
    ui_id: "u-2012",
  });
  assert.equal(outcome.state, "failed");
  assert.match(outcome.message, /FAILED/);
  assert.match(outcome.message, /KeyError: 'rgthree-comfy'/);
  assert.match(outcome.message, /do_install/);
  assert.match(outcome.message, /Failed to clone repo/);
  assert.doesNotMatch(
    outcome.message,
    /check the ComfyUI server log for the full traceback/,
    "the tool result is the traceback, not a pointer to it",
  );
  assert.equal(readFor, PACK, "the log read is for the pack we asked to install");
});

test("#2012 shipped verifyInstalled does NOT read the log for a specific Manager exception", async () => {
  // The #1539 registry-miss is already in status.messages. Fetching the log
  // would only add latency; the reason is already the traceback.
  let reads = 0;
  const specific = {
    ...GENERIC_ITEM,
    status: {
      status_str: "error",
      completed: true,
      messages: [
        "Node 'rgthree-comfy@nightly' not found in [ManagerChannel.dev, ManagerDatabaseSource.cache]",
      ],
    },
  };
  const { verifyInstalled } = buildVerifyInstalled({
    managerV2: async (route) => {
      if (route.startsWith("manager/queue/history")) return { history: specific };
      if (route.startsWith("manager/queue/status")) return DRAINED;
      if (route.startsWith("customnode/installed")) return INSTALLED_LIST;
      throw new Error(`unstubbed route: ${route}`);
    },
    readInstallTraceback: async () => {
      reads += 1;
      return "SHOULD NOT BE ATTACHED";
    },
  });

  const outcome = await verifyInstalled(PACK, "v2", { budgetMs: 4000, ui_id: "u-2012" });
  assert.equal(outcome.state, "failed");
  assert.match(outcome.message, /not found in/);
  assert.doesNotMatch(outcome.message, /SHOULD NOT BE ATTACHED/);
  assert.equal(reads, 0, "a specific Manager exception does not pay for a log read");
});
