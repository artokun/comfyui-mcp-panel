// artokun/comfyui-mcp#1539 — `panel_install_node` returned `queued: true,
// pending: true` for an install the Manager had already REJECTED.
//
// The reporter passed a git URL for an unlisted pack. Manager v4 resolves the
// install by `id` against its registry even when `repository` is supplied and
// `selected_version` is `nightly`, so it failed the task with:
//
//   Node 'comfyui-anima-ipadapter@nightly' not found in
//   [ManagerChannel.dev, ManagerDatabaseSource.cache]
//
// That is UPSTREAM and the request we send is correct — both settled by a live
// probe against ComfyUI-Manager V4.2.2 (see the issue thread). What was OURS is
// that the failure was invisible to the caller: verifyInstalled resolved the
// outcome from queue-drain + the installed-nodes list ONLY, and never read the
// per-task history record where the Manager had written the error.
//
// Worse, for this exact input the list-based path can never conclude "failed":
// a git URL is `renameProne`, which suppresses the queueFailureSignal branch
// (a git pack may install under a directory name the match cannot see, so
// absence is not proof). So the honest-but-useless "unverified" was the ONLY
// reachable verdict for a git URL, however loudly the Manager had failed it.
//
// The per-task poll #364 added lives on the UPDATE path and was never wired into
// install. These tests pin the read, its correlation by ui_id, its dialect
// scoping, and — most importantly — that install actually REACHES it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as ManagerInstall from "../../web/js/lib/manager-install.js";
const { classifyInstallOutcome, taskFailureReason, parseTaskHistoryItem, queueDrained } =
  ManagerInstall;

// The reporter's error, verbatim from the live V4.2.2 probe.
const REGISTRY_MISS =
  "Node 'comfyui-anima-ipadapter@nightly' not found in " +
  "[ManagerChannel.dev, ManagerDatabaseSource.cache]";

const GIT_URL = "https://github.com/Wenaka2004/comfyui-anima-ipadapter";
const TARGET = "comfyui-anima-ipadapter"; // gitRepoName(GIT_URL) — what we send as `id`
const UI_ID = "u-1539";

/** The record the v4 worker writes for a registry-lookup rejection: status_str
 *  "error" with the message, under the ui_id we submitted. Shape mirrors the
 *  live records already pinned by manager-update-verify.test.mjs. */
const FAILED_ITEM = {
  ui_id: UI_ID,
  client_id: "comfyui-mcp-panel",
  kind: "install",
  result: "Exception: ('install', QueueTaskItem(...))",
  status: { status_str: "error", completed: true, messages: [REGISTRY_MISS] },
  params: { id: TARGET, selected_version: "nightly", repository: GIT_URL },
};

const SUCCESS_ITEM = {
  ui_id: UI_ID,
  kind: "install",
  result: "success",
  status: { status_str: "success", completed: true, messages: [] },
  params: { id: TARGET },
};

const DRAINED = { total_count: 1, done_count: 1, is_processing: false };
const BUSY = { total_count: 2, done_count: 1, is_processing: true };
// The pack is NOT in the installed list — the install never happened.
const INSTALLED_LIST = { "some-other-pack": { ver: "1.0", cnr_id: "some-other-pack" } };

// ---------------------------------------------------------------------------
// Real-source harness: the ACTUAL waitForQueueDrain + verifyInstalled, extracted
// from comfyui-mcp-panel.js and run against a stubbed Manager. Driving the real
// source is the point: a helper-only test would pass just as happily with the
// call site never passing ui_id at all.
// ---------------------------------------------------------------------------

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

/**
 * `routes` maps a route PREFIX to a handler (or throws). Every GET the verifier
 * makes is recorded in `calls` so the dialect-scoping tests can assert that a
 * route was never touched.
 */
function buildVerifyInstalled({ routes, calls = [], budgetMs }) {
  const src = readPanelSource();
  const get = async (route) => {
    calls.push(route);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (route.startsWith(prefix)) {
        const out = typeof handler === "function" ? handler(route) : handler;
        if (out instanceof Error) throw out;
        return out;
      }
    }
    throw new Error(`unstubbed route: ${route}`);
  };
  const deps = {
    managerGet: get,
    managerV2: get,
    managerCall: get,
    queueDrained,
    taskFailureReason,
    parseTaskHistoryItem,
    classifyInstallOutcome,
    MANAGER_FETCH_TIMEOUT_MS: 15000,
    INSTALL_VERIFY_BUDGET_MS: budgetMs ?? 4000,
    AbortSignal,
    setTimeout,
    // comfyui-mcp#1606 — the capture the verifier now also consults. EMPTY here
    // on purpose: these tests pin the HTTP history path, and an empty log proves
    // the capture cannot short-circuit or alter it.
    managerTaskResults: ManagerInstall.createManagerTaskResultLog(),
  };
  const factory = new Function(
    ...Object.keys(deps),
    `${pick(src, /function boundedDelay\(ms, deadline\) \{[\s\S]*?\n\}/, "boundedDelay")}
${pick(src, /async function waitForQueueDrain\(\{[\s\S]*?\n\}/, "waitForQueueDrain")}
${pick(src, /async function verifyInstalled\(target, dialect, \{[\s\S]*?\n\}/, "verifyInstalled")}
return { verifyInstalled, waitForQueueDrain };`,
  );
  return factory(...Object.values(deps));
}

// ---------------------------------------------------------------------------
// The reported case, through the real verifier
// ---------------------------------------------------------------------------

test("#1539: a v4 task that terminally errored is FAILED, not queued-and-pending", async () => {
  const calls = [];
  const { verifyInstalled } = buildVerifyInstalled({
    calls,
    routes: {
      "manager/queue/history": { history: FAILED_ITEM },
      "manager/queue/status": DRAINED,
      "customnode/installed": INSTALLED_LIST,
    },
  });

  const outcome = await verifyInstalled(TARGET, "v2", {
    renameProne: true, // a git URL — the case the list-based path can never fail
    budgetMs: 4000,
    ui_id: UI_ID,
  });

  // BEFORE the fix this was state "unverified" with "was queued but could NOT be
  // confirmed installed", which the panel returns as queued:true / pending:true —
  // exactly what the reporter saw and reasonably read as success.
  assert.equal(outcome.state, "failed", "the Manager's own terminal record says failed");
  assert.match(outcome.message, /install FAILED/);
  assert.ok(
    outcome.message.includes(REGISTRY_MISS),
    "the caller gets the Manager's REAL reason, not a bare status",
  );
  assert.doesNotMatch(
    outcome.message,
    /could NOT be confirmed/,
    "must not also hedge — this is a positive failure verdict",
  );
});

test("#1539: the registry-miss reply names the workaround that actually works (#920)", async () => {
  const { verifyInstalled } = buildVerifyInstalled({
    routes: {
      "manager/queue/history": { history: FAILED_ITEM },
      "manager/queue/status": DRAINED,
      "customnode/installed": INSTALLED_LIST,
    },
  });
  const outcome = await verifyInstalled(TARGET, "v2", {
    renameProne: true,
    budgetMs: 4000,
    ui_id: UI_ID,
  });
  // The reporter verified this workaround themselves. Attaching it to the install
  // reply means the caller does not have to know to poll for the advice.
  assert.match(outcome.message, /install_custom_node/);
  assert.match(outcome.message, /NODE REGISTRY lookup/);
});

test("#1539: a terminal failure ends the wait even if the queue never drains", async () => {
  // A neighbouring task can keep the queue busy indefinitely. Gating the failure
  // read on drain would make the verdict hostage to unrelated work — and on a
  // short budget would report pending for an install that already failed.
  const calls = [];
  const { verifyInstalled } = buildVerifyInstalled({
    calls,
    routes: {
      "manager/queue/history": { history: FAILED_ITEM },
      "manager/queue/status": BUSY, // never drains
      "customnode/installed": INSTALLED_LIST,
    },
  });
  const started = Date.now();
  const outcome = await verifyInstalled(TARGET, "v2", {
    renameProne: true,
    budgetMs: 8000,
    ui_id: UI_ID,
  });
  assert.equal(outcome.state, "failed");
  assert.ok(
    Date.now() - started < 6000,
    "must return on the terminal record, not burn the whole budget",
  );
  assert.ok(
    !calls.some((r) => r.startsWith("customnode/installed")),
    "a settled verdict should not spend budget on evidence that cannot change it",
  );
});

// ---------------------------------------------------------------------------
// The read must not INVENT failures
// ---------------------------------------------------------------------------

test("#1539: another task's failure is NEVER attributed to this install", async () => {
  // The map-shaped history carries every recent task. Correlating by the ui_id we
  // submitted is what keeps a neighbouring pack's crash from failing our install.
  const { verifyInstalled } = buildVerifyInstalled({
    routes: {
      "manager/queue/history": {
        history: { "someone-elses-task": { ...FAILED_ITEM, ui_id: "someone-elses-task" } },
      },
      "manager/queue/status": DRAINED,
      "customnode/installed": INSTALLED_LIST,
    },
  });
  const outcome = await verifyInstalled(TARGET, "v2", {
    renameProne: true,
    budgetMs: 4000,
    ui_id: UI_ID,
  });
  assert.equal(outcome.state, "unverified", "not our task — no verdict borrowed from it");
});

test("#1539: a task that SUCCEEDED still reports installed (no downgrade)", async () => {
  const { verifyInstalled } = buildVerifyInstalled({
    routes: {
      "manager/queue/history": { history: SUCCESS_ITEM },
      "manager/queue/status": DRAINED,
      "customnode/installed": { [TARGET]: { ver: "1.0", cnr_id: TARGET } },
    },
  });
  const outcome = await verifyInstalled(TARGET, "v2", {
    renameProne: true,
    budgetMs: 4000,
    ui_id: UI_ID,
  });
  assert.equal(outcome.state, "installed");
});

test("#1539: an absent/erroring history endpoint degrades to today's behaviour", async () => {
  // Best-effort in both directions. A Manager that 404s the history route must
  // land on exactly the pre-fix verdict, never a failure invented from a fetch
  // error.
  for (const history of [new Error("HTTP 404"), {}, { history: null }, "junk"]) {
    const { verifyInstalled } = buildVerifyInstalled({
      routes: {
        "manager/queue/history": history,
        "manager/queue/status": DRAINED,
        "customnode/installed": INSTALLED_LIST,
      },
    });
    const outcome = await verifyInstalled(TARGET, "v2", {
      renameProne: true,
      budgetMs: 4000,
      ui_id: UI_ID,
    });
    assert.equal(outcome.state, "unverified", `history=${JSON.stringify(history)}`);
  }
});

// ---------------------------------------------------------------------------
// Dialect scoping — the record only exists on the real pip v4 ("v2")
// ---------------------------------------------------------------------------

test("#1539: legacy and v2-batch never poll a per-task history that cannot serve them", async () => {
  // Released 3.x has no per-task history route; the bundled 3.x server serves
  // BATCH history keyed by id and rejects a ui_id query. Polling either would
  // burn the command budget and learn nothing. (Legacy's blind spot is #1606 —
  // a different problem: there is no record to read at all.)
  for (const dialect of ["legacy", "v2-batch"]) {
    const calls = [];
    const { verifyInstalled } = buildVerifyInstalled({
      calls,
      routes: {
        "manager/queue/status": DRAINED,
        "customnode/installed": INSTALLED_LIST,
      },
    });
    const outcome = await verifyInstalled(TARGET, dialect, {
      renameProne: true,
      budgetMs: 4000,
      ui_id: UI_ID,
    });
    assert.ok(
      !calls.some((r) => r.startsWith("manager/queue/history")),
      `${dialect} must not poll per-task history`,
    );
    assert.equal(outcome.state, "unverified", `${dialect} keeps its existing verdict`);
  }
});

// ---------------------------------------------------------------------------
// REACHABILITY — the call site, not just the mechanism
// ---------------------------------------------------------------------------

test("#1539: nodes_install THREADS its ui_id into verifyInstalled", () => {
  // Without this the whole read above is dead code: verifyInstalled defaults
  // ui_id to undefined and silently falls back to drain + name-presence. A
  // helper-level test cannot see that, which is exactly how a one-line wiring
  // change ships broken.
  const src = readPanelSource();
  const method = pick(src, /async nodes_install\(args\) \{[\s\S]*?\n  \},\r?\n/, "nodes_install");
  const call = pick(method, /verifyInstalled\([\s\S]*?\);/, "the verifyInstalled call");
  assert.match(call, /\bui_id\b/, "nodes_install must pass ui_id to verifyInstalled");
});

test("#1539: the ui_id passed to the Manager is the one the history is polled under", async () => {
  // Correlation is only worth anything if BOTH sides use the same id. Assert the
  // history route actually carries it rather than trusting the plumbing.
  const calls = [];
  const { verifyInstalled } = buildVerifyInstalled({
    calls,
    routes: {
      "manager/queue/history": { history: FAILED_ITEM },
      "manager/queue/status": DRAINED,
      "customnode/installed": INSTALLED_LIST,
    },
  });
  await verifyInstalled(TARGET, "v2", { renameProne: true, budgetMs: 4000, ui_id: UI_ID });
  assert.ok(
    calls.some((r) => r === `manager/queue/history?ui_id=${UI_ID}`),
    `history must be queried for our ui_id; saw ${JSON.stringify(calls)}`,
  );
});

// ---------------------------------------------------------------------------
// The pure classifier
// ---------------------------------------------------------------------------

test("#1539: classifyInstallOutcome ranks a terminal record above every proxy", () => {
  // Not drained: a terminal record is conclusive regardless of queue state.
  assert.equal(
    classifyInstallOutcome({
      target: TARGET, dialect: "v2", status: BUSY, installed: INSTALLED_LIST,
      renameProne: true, taskFailure: REGISTRY_MISS,
    }).state,
    "failed",
  );
  // Even a name-match "present" does not outrank OUR task's own error — the dir
  // may predate this install, the record cannot.
  assert.equal(
    classifyInstallOutcome({
      target: TARGET, dialect: "v2", status: DRAINED,
      installed: { [TARGET]: { ver: "1.0", cnr_id: TARGET } },
      renameProne: true, taskFailure: REGISTRY_MISS,
    }).state,
    "failed",
  );
  // Absent → every pre-existing verdict is untouched.
  assert.equal(
    classifyInstallOutcome({
      target: TARGET, dialect: "v2", status: DRAINED, installed: INSTALLED_LIST,
      renameProne: true,
    }).state,
    "unverified",
  );
  assert.equal(
    classifyInstallOutcome({
      target: TARGET, dialect: "v2", status: DRAINED,
      installed: { [TARGET]: { ver: "1.0", cnr_id: TARGET } },
    }).state,
    "installed",
  );
});
