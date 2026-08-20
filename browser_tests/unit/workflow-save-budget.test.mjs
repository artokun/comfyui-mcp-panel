/**
 * panel#1434 — `panel_save_workflow` timed out with no acknowledgement for 15 s
 * against a tab that kept answering `panel_graph_outline` and `panel_list_workflows`,
 * and still reported persisted:true / modified:true.
 *
 * The reply was not lost in transit. It was never COMPOSED inside the window:
 * `workflow_save` is relayed at 15,000 ms and awaited `programmaticSave` with no
 * bound, so a /userdata HEAD, GET or PUT that accepts and never answers parks the
 * rid until the orchestrator gives up and guesses the tab is backgrounded or frozen.
 *
 * THE HARNESS RUNS THE SHIPPED `workflow_save` BODY, extracted from the panel source
 * and given injected collaborators, over the REAL `runBoundedWorkflowSave` with a
 * REAL hanging save — the same technique as refresh-nodes-command-budget.test.mjs.
 * A helper-level test cannot reach this defect: `runBoundedWorkflowSave` already
 * implements the bound, and the whole bug was that the call site never used it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { withTimeout } from "../../web/js/lib/bounded-step.js";
import {
  WORKFLOW_SAVE_COMMAND_BUDGET_MS,
  WORKFLOW_SAVE_TIMEOUT,
  describeWorkflowSaveTimeout,
  runBoundedWorkflowSave,
  workflowSaveTimeoutObservation,
} from "../../web/js/lib/workflow-save-budget.js";
import { PANEL_SRC } from "./_panel-constants.mjs";

const workflowSaveMatch = PANEL_SRC.match(/\n {2}async workflow_save\(\{ name \} = \{\}\) \{[\s\S]*?\n {2}\},/);
assert.ok(workflowSaveMatch, "could not locate workflow_save in panel source");

const workflowSaveAsMatch = PANEL_SRC.match(/\n {2}async workflow_save_as\(\{ name \}\) \{[\s\S]*?\n {2}\},/);
assert.ok(workflowSaveAsMatch, "could not locate workflow_save_as in panel source");

// The orchestrator side of this invariant: ctx.call(..., 15000) in
// comfyui-mcp's panel-tools.ts panel_save_workflow. Duplicated as a literal
// on purpose — if EITHER side moves, this test forces the relationship to be
// re-examined.
const ORCHESTRATOR_SAVE_TIMEOUT_MS = 15000;

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function withWatchdog(run, ms, what) {
  let timer;
  const startedAt = Date.now();
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} — waited ${ms}ms`)), ms);
  });
  try {
    const value = await Promise.race([Promise.resolve().then(run), watchdog]);
    return { value, elapsed: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function shippedWorkflowSave({ programmaticSave, budgetMs = 40, observeWorkflow } = {}) {
  const deps = {
    runBoundedWorkflowSave,
    programmaticSave,
    WORKFLOW_SAVE_COMMAND_BUDGET_MS: budgetMs,
    withTimeout,
    monotonicNow: () => Date.now(),
    observeActiveWorkflowSaveState: observeWorkflow,
    saveProducedIdentity: () => ({ uuid: "u", routingKey: "wf:x" }),
    saveReplyIdentity: () => ({ workflow_uuid: "u" }),
    liveWorkflowListActive: () => ({ activeIdentity: { uuid: "u" } }),
  };
  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `const executors = {${workflowSaveMatch[0]}};
     return executors.workflow_save;`,
  );
  return factory(...names.map((n) => deps[n]));
}

function shippedWorkflowSaveAs({ programmaticSave, budgetMs = 40, observeWorkflow } = {}) {
  const deps = {
    runBoundedWorkflowSave,
    programmaticSave,
    WORKFLOW_SAVE_COMMAND_BUDGET_MS: budgetMs,
    withTimeout,
    monotonicNow: () => Date.now(),
    observeActiveWorkflowSaveState: observeWorkflow,
    saveProducedIdentity: () => ({ uuid: "u", routingKey: "wf:x" }),
    saveReplyIdentity: () => ({ workflow_uuid: "u" }),
  };
  const names = Object.keys(deps);
  const factory = new Function(
    ...names,
    `const executors = {${workflowSaveAsMatch[0]}};
     return executors.workflow_save_as;`,
  );
  return factory(...names.map((n) => deps[n]));
}

// ---------------------------------------------------------------------------
// 1. The reported shape: in-place save of a persisted, still-dirty workflow,
//    whose userdata write never settles.
// ---------------------------------------------------------------------------

test("#1434: workflow_save REPLIES at its budget instead of hanging on userdata", async () => {
  const gate = deferred();
  const observed = {
    modified: true,
    persisted: true,
    filename: "video_minimax_h3_r2v_ai_test.json",
  };
  const workflow_save = shippedWorkflowSave({
    programmaticSave: () => gate.promise,
    budgetMs: 40,
    observeWorkflow: () => observed,
  });

  const { elapsed } = await withWatchdog(
    async () => {
      await assert.rejects(
        () => workflow_save({}),
        (err) => {
          assert.equal(
            err.message,
            describeWorkflowSaveTimeout({ budgetMs: 40, ...observed }),
            "the timeout text is the helper's, not a restated sentence",
          );
          return true;
        },
      );
    },
    1500,
    "workflow_save never replied: the command budget is not wrapping programmaticSave, so " +
      "a hung userdata write silences the tab for the whole 15 s relay window",
  );

  assert.ok(elapsed < 1000, `replied in ${elapsed}ms — the reply must be composed at the bound`);
  gate.resolve({ name: "should-not-land" });
});

test("#1434: the refusal NAMES a live tab and the dirty observation, never 'frozen'", async () => {
  const observed = {
    modified: true,
    persisted: true,
    filename: "video_minimax_h3_r2v_ai_test.json",
  };
  const text = describeWorkflowSaveTimeout({ budgetMs: WORKFLOW_SAVE_COMMAND_BUDGET_MS, ...observed });
  assert.match(text, /workflow_save did not finish/);
  assert.match(text, /video_minimax_h3_r2v_ai_test\.json/);
  assert.match(text, /still live/);
  assert.match(text, /modified:true/);
  assert.match(text, /persisted:true/);
  assert.match(text, /not a backgrounded or frozen tab/);
  // #1455 — the reply must never resolve landed-ness from the dirty flag.
  assert.doesNotMatch(text, /if modified is false the write landed/);
  // Same observation the reporter could read after the timeout.
  assert.deepEqual(
    workflowSaveTimeoutObservation({
      isModified: true,
      isPersisted: true,
      filename: "video_minimax_h3_r2v_ai_test.json",
    }),
    observed,
  );
});

test("#1434: a real save exception is the reply, never rewritten as a hang", async () => {
  const boom = new Error("Error storing user data file 'workflows/Foo.json': 400");
  await assert.rejects(
    () =>
      runBoundedWorkflowSave(() => Promise.reject(boom), {
        budgetMs: 500,
        withTimeout,
        observeWorkflow: () => ({ modified: true }),
      }),
    (err) => {
      assert.equal(err, boom, "the thrown Error object is the one the save raised");
      return true;
    },
  );
});

test("#1434: a save that settles in time is returned unchanged", async () => {
  const result = { name: "Foo.json", producedRecord: null };
  const got = await runBoundedWorkflowSave(() => Promise.resolve(result), {
    budgetMs: 500,
    withTimeout,
    observeWorkflow: () => ({ modified: false }),
  });
  assert.equal(got, result);
});

test("#1434: a completing in-place save still reports saved:true through the shipped handler", async () => {
  const workflow_save = shippedWorkflowSave({
    programmaticSave: async () => ({ name: "Foo.json", producedRecord: { path: "workflows/Foo.json" } }),
    budgetMs: 500,
    observeWorkflow: () => ({ modified: false }),
  });
  const reply = await workflow_save({});
  assert.equal(reply.saved, true);
  assert.equal(reply.workflow, "Foo.json");
});

test("#1434: workflow_save_as takes the same bound", async () => {
  const gate = deferred();
  const workflow_save_as = shippedWorkflowSaveAs({
    programmaticSave: () => gate.promise,
    budgetMs: 40,
    observeWorkflow: () => ({ modified: true, persisted: true, filename: "copy.json" }),
  });

  await withWatchdog(
    async () => {
      await assert.rejects(
        () => workflow_save_as({ name: "copy" }),
        (err) => {
          assert.match(err.message, /workflow_save did not finish/);
          assert.match(err.message, /copy\.json/);
          return true;
        },
      );
    },
    1500,
    "workflow_save_as never replied",
  );
  gate.resolve({ name: "should-not-land" });
});

test("#1434: refusing without withTimeout is fail-closed, never unbounded", async () => {
  await assert.rejects(
    () => runBoundedWorkflowSave(() => new Promise(() => {}), { budgetMs: 500 }),
    /requires withTimeout/,
  );
});

test("#1434: the sentinel is a frozen object, so identity survives a map lookup", () => {
  assert.equal(Object.isFrozen(WORKFLOW_SAVE_TIMEOUT), true);
  assert.equal(WORKFLOW_SAVE_TIMEOUT.timeout, true);
});

// ---------------------------------------------------------------------------
// 2. The shipped number, against the window it exists for.
// ---------------------------------------------------------------------------

test("#1434: the shipped budget leaves the 15 s relay window room to carry the reply", () => {
  assert.ok(
    WORKFLOW_SAVE_COMMAND_BUDGET_MS < ORCHESTRATOR_SAVE_TIMEOUT_MS,
    `budget ${WORKFLOW_SAVE_COMMAND_BUDGET_MS} must leave reply margin under the bridge's ${ORCHESTRATOR_SAVE_TIMEOUT_MS} ms`,
  );
  assert.ok(WORKFLOW_SAVE_COMMAND_BUDGET_MS > 0);
});

test("#1434: BOTH save handlers wrap programmaticSave in the bound — the helper alone cannot prove this", () => {
  assert.match(
    workflowSaveMatch[0],
    /runBoundedWorkflowSave\(\s*\(\) => programmaticSave\(name\),/,
    "workflow_save must bound programmaticSave",
  );
  assert.match(
    workflowSaveMatch[0],
    /budgetMs: WORKFLOW_SAVE_COMMAND_BUDGET_MS/,
    "workflow_save must pass the shipped budget, not a restated number",
  );
  assert.match(
    workflowSaveAsMatch[0],
    /runBoundedWorkflowSave\(\s*\(\) => programmaticSave\(name\),/,
    "workflow_save_as must bound programmaticSave",
  );
  assert.match(
    workflowSaveAsMatch[0],
    /budgetMs: WORKFLOW_SAVE_COMMAND_BUDGET_MS/,
    "workflow_save_as must pass the shipped budget, not a restated number",
  );
  assert.match(
    PANEL_SRC,
    /function observeActiveWorkflowSaveState\(\)/,
    "the timeout path must observe the live dirty flags, not invent them",
  );
});

// ---------------------------------------------------------------------------
// #1455 — the reply reports OBSERVATIONS, and is explicit about WHICH workflow
// they belong to. The save's destination is the requested name, never a guess
// made from whichever workflow happens to be active.
// ---------------------------------------------------------------------------

test("#1455: modified:false is reported, never resolved into 'the write landed'", () => {
  const text = describeWorkflowSaveTimeout({
    budgetMs: WORKFLOW_SAVE_COMMAND_BUDGET_MS,
    modified: false,
    persisted: true,
    filename: "Clean.json",
  });
  assert.match(text, /modified:false/);
  assert.match(text, /persisted:true/);
  // isModified === false is equally the state of a workflow that was never dirty, and
  // save() forces past the isPersisted && !isModified early return, so a clean workflow
  // reaches a hanging PUT with the flag already false.
  assert.doesNotMatch(text, /the write landed/);
  assert.match(text, /UNDETERMINED/);
  assert.doesNotMatch(text, /Check panel_list_workflows before retrying/);
});

test("#1455: modified:true keeps its one-directional meaning", () => {
  const text = describeWorkflowSaveTimeout({
    budgetMs: WORKFLOW_SAVE_COMMAND_BUDGET_MS,
    modified: true,
    persisted: true,
    filename: "Dirty.json",
  });
  assert.match(text, /has not been acknowledged as landed/);
  assert.doesNotMatch(text, /UNDETERMINED/);
});

test("#1455: a Save-As names the DESTINATION, not the source it was copied from", () => {
  // workflow-save.js:1353 calls openWorkflow(copy) BEFORE saveWorkflow(copy), so by the
  // time the budget fires the canvas already shows the copy. The source is the one file
  // this route provably never writes — naming it would send the caller to read the wrong
  // file and conclude the save was fine.
  const text = describeWorkflowSaveTimeout({
    budgetMs: WORKFLOW_SAVE_COMMAND_BUDGET_MS,
    modified: true,
    persisted: false,
    filename: "Copy",
    requested: "Copy.json",
    previousActive: "Original",
  });
  assert.match(text, /for "Copy(\.json)?"/);
  assert.doesNotMatch(text, /Original/);
  assert.match(text, /modified:true/);
});

test("#1455: a known destination with the canvas elsewhere withholds the foreign flags", () => {
  const text = describeWorkflowSaveTimeout({
    budgetMs: WORKFLOW_SAVE_COMMAND_BUDGET_MS,
    modified: false,
    persisted: true,
    filename: "Something else",
    requested: "Copy.json",
    previousActive: "Original",
  });
  assert.match(text, /for "Copy(\.json)?"/);
  // Those flags belong to another workflow; reporting them here would be a wrong-target
  // claim of exactly the kind this issue is about.
  assert.doesNotMatch(text, /modified:false/);
  assert.match(text, /do not describe "Copy\.json"/);
});

test("#1455: an un-named save whose canvas moved says the target is undeterminable", () => {
  // First-save auto-naming. "I cannot tell which file" must not collapse into the
  // in-place case, which is the same failure the modified:false half of this issue is.
  const text = describeWorkflowSaveTimeout({
    budgetMs: WORKFLOW_SAVE_COMMAND_BUDGET_MS,
    modified: false,
    persisted: true,
    filename: "Real name",
    previousActive: "Unsaved Workflow (2)",
  });
  assert.match(text, /cannot be determined from here/);
  assert.match(text, /changed from "Unsaved Workflow \(2\)" to "Real name"/);
  // No file is named as the target, because none is known to be.
  assert.doesNotMatch(text, /for "Unsaved Workflow \(2\)"/);
  assert.doesNotMatch(text, /for "Real name"/);
});

test("#1455 WIRING: the requested name reaches the reply as the destination", async () => {
  // Deleting `targetName` at either call site drops the only authoritative signal and
  // sends the reply back to guessing from the active workflow.
  let call = 0;
  const observeWorkflow = () => {
    call += 1;
    return call === 1
      ? { modified: true, persisted: true, filename: "Original" }
      : { modified: true, persisted: false, filename: "Copy" };
  };
  await assert.rejects(
    () =>
      runBoundedWorkflowSave(() => new Promise(() => {}), {
        budgetMs: 40,
        targetName: "Copy.json",
        withTimeout: async (p, ms, onTimeout) => {
          const t = new Promise((r) => setTimeout(() => r(onTimeout()), ms));
          return Promise.race([p, t]);
        },
        observeWorkflow,
      }),
    (err) => {
      assert.match(err.message, /for "Copy(\.json)?"/, "names the destination, not the source");
      assert.doesNotMatch(err.message, /for "Original"/, "never the source");
      return true;
    },
  );
  assert.ok(call >= 2, "observed before the save and at the budget");
});

test("#1455 WIRING: BOTH save handlers pass the requested name to the bound save", () => {
  // A one-line option at a call site is invisible to a helper-level test: deleting
  // `targetName: name` leaves every assertion above green while the shipped reply
  // goes back to guessing the destination from whatever is active. Assert on the SOURCE.
  const panel = PANEL_SRC;
  const passes = panel.match(/targetName: name,/g) ?? [];
  const bound = panel.match(/runBoundedWorkflowSave\(/g) ?? [];
  assert.equal(bound.length, 2, "exactly two bounded save call sites (workflow_save, workflow_save_as)");
  assert.equal(passes.length, 2, "both of them pass the destination name");
});

test("#1455: a requested name and the canvas name are the SAME workflow once normalized", () => {
  // panel_list_workflows hands back "workflows/Foo.json"; the canvas reports "Foo".
  // Comparing those raw is a wrong-pair test — it claims the canvas moved off its own
  // destination and suppresses modified:true, the only one-directional evidence here.
  for (const requested of ["Foo.json", "workflows/Foo.json", " Foo ", "Foo.app.json"]) {
    const text = describeWorkflowSaveTimeout({
      budgetMs: WORKFLOW_SAVE_COMMAND_BUDGET_MS,
      modified: true,
      persisted: false,
      filename: "Foo",
      requested,
      previousActive: "Original",
    });
    assert.doesNotMatch(text, /not the save's destination/, requested + " is the canvas");
    assert.match(text, /modified:true/, requested + " keeps the dirty observation");
    assert.match(text, /has not been acknowledged as landed/);
  }
});

test("#1455: with no flags readable the reply does not reason about a flag it never saw", () => {
  const text = describeWorkflowSaveTimeout({
    budgetMs: WORKFLOW_SAVE_COMMAND_BUDGET_MS,
    filename: "Foo",
    requested: "Foo.json",
  });
  assert.match(text, /could not be read/);
  assert.match(text, /UNDETERMINED/);
  // The modified:false rationale belongs to a reading that did not happen.
  assert.doesNotMatch(text, /never dirty/);
});
