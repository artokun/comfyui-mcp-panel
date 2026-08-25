/**
 * #1575 — reopening a saved workflow whose tab was closed with panel_close_workflow.
 *
 * THE REPORT. `panel_open_workflow` refused with "workflow_open could not rebind the
 * active canvas because this frontend did not expose a complete workflow state for a
 * safe repaint", and `panel_list_workflows` showed an inconsistent active/open state.
 *
 * THE CAUSE, read out of the ComfyUI frontend's own source and then MEASURED in a
 * browser against a live ComfyUI. `app.extensionManager.workflow` is the workflow
 * STORE (`workspaceStore` binds it as `computed(() => useWorkflowStore())`), so the
 * panel's close and open are the store's primitives — and they do not pair up:
 *
 *   closeWorkflow(wf)  drops the path from `openWorkflowPaths`, calls `wf.unload()`
 *                      (nulling `changeTracker`), and LEAVES `activeWorkflow` on wf.
 *   openWorkflow(wf)   begins `if (isActive(workflow)) return workflow`, and
 *                      `isActive` is `activeWorkflow.path === workflow.path`.
 *
 * So the open early-returns on the stale pointer, loads nothing, never pushes the
 * path back, and resolves as though it worked. The panel then reads
 * `changeTracker?.activeState ?? activeState` and gets null — the refusal.
 *
 * `FakeWorkflowStore` below is a transcription of those two methods (and `unload`,
 * and the derived `activeState` getter) from the frontend source, so the state these
 * tests drive the helper against is the state the frontend really produces. The
 * measured browser run agreed with it exactly:
 *
 *   after store.closeWorkflow   activeIsSameObject:true  hasTracker:false  inOpenList:false
 *   after store.openWorkflow    activeIsSameObject:true  hasTracker:false  inOpenList:false
 *   panel repaint-state read    null
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  settleOpenedWorkflowTarget,
  hasCompleteRepaintState,
  workflowRepaintState,
} from "../../web/js/lib/settle-open-target.js";

const PANEL_JS = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const SRC = readFileSync(PANEL_JS, "utf8").replace(/\r\n/g, "\n");

const clone = (v) => JSON.parse(JSON.stringify(v));
const DISK_STATE = { nodes: [{ id: 1, type: "CheckpointLoaderSimple" }, { id: 2, type: "KSampler" }], links: [] };

/** ComfyWorkflow, as far as this bug is concerned. `activeState` is a DERIVED
 *  getter over `changeTracker` — verified against the frontend source, and it is
 *  why unloading takes the flat fallback away too. */
class FakeWorkflow {
  constructor(path, diskState) {
    this.path = path;
    this.filename = path.split("/").pop();
    this.isPersisted = true;
    this.isTemporary = false;
    this.isModified = false;
    this.changeTracker = null;
    this._disk = diskState;
    this.loadCalls = 0;
  }
  get key() {
    return this.path.replace(/^workflows\//, "");
  }
  get activeState() {
    return this.changeTracker?.activeState ?? null;
  }
  get isLoaded() {
    return this.changeTracker !== null;
  }
  async load() {
    this.loadCalls += 1;
    if (this.isLoaded) return this;
    this.originalContent = JSON.stringify(this._disk);
    this.changeTracker = { activeState: clone(this._disk) };
    return this;
  }
  unload() {
    this.changeTracker = null;
  }
}

/** The two store methods, transcribed. */
class FakeWorkflowStore {
  /** Starts with the workflow LISTED but not open and not active — the state a
   *  freshly-synced store is in before anyone opens anything. */
  constructor(workflow) {
    this.lookup = { [workflow.path]: workflow };
    this.openWorkflowPaths = [];
    this.activeWorkflow = null;
    this.backgroundCalls = [];
  }
  get workflows() {
    return Object.values(this.lookup);
  }
  get openWorkflows() {
    return this.openWorkflowPaths.map((p) => this.lookup[p]);
  }
  /** BY PATH — this is the comparison that makes `openWorkflow` early-return. */
  isActive(wf) {
    return this.activeWorkflow?.path === wf.path;
  }
  async closeWorkflow(wf) {
    this.openWorkflowPaths = this.openWorkflowPaths.filter((p) => p !== wf.path);
    if (wf.isTemporary) delete this.lookup[wf.path];
    else wf.unload();
    // NOTE: `activeWorkflow` is deliberately NOT moved. The frontend's SERVICE does
    // that, and the panel cannot reach the service.
  }
  async openWorkflow(wf) {
    if (this.isActive(wf)) return wf; // <- the early return
    if (!this.openWorkflowPaths.includes(wf.path)) this.openWorkflowPaths.push(wf.path);
    const loaded = await wf.load();
    this.activeWorkflow = loaded;
    return loaded;
  }
  openWorkflowsInBackground({ right = [] } = {}) {
    this.backgroundCalls.push(right);
    for (const p of right) {
      if (p in this.lookup && !this.openWorkflowPaths.includes(p)) this.openWorkflowPaths.push(p);
    }
  }
}

/** Reproduce the reported sequence and hand back the state workflow_open sees. */
async function strandedByCloseThenOpen() {
  const wf = new FakeWorkflow("workflows/report-1575.json", DISK_STATE);
  const store = new FakeWorkflowStore(wf);
  await store.openWorkflow(wf); // step 1: it is open, saved and active
  assert.equal(wf.isLoaded, true, "precondition: the tab starts loaded");

  await store.closeWorkflow(wf); // step 2: panel_close_workflow
  wf.loadCalls = 0; // count only what the REOPEN does

  // step 3: panel_open_workflow — the panel's own find(), then the store's open.
  const target = store.lookup["workflows/report-1575.json"];
  const wasOpen = !!target.changeTracker;
  await store.openWorkflow(target);
  return { store, target, wasOpen };
}

const sameWorkflowObject = (a, b) => a === b;
const matchesSelector = (w, sel) => w?.path === sel || w?.key === sel || w?.filename === sel;

function settleArgs(store, target, wasOpen, overrides = {}) {
  return {
    wasOpen,
    target,
    selector: target.path,
    activeAfterOpen: store.activeWorkflow,
    openWorkflows: store.openWorkflows,
    sameWorkflowObject,
    matchesSelector,
    // The collaborators are built EXACTLY as workflow_open builds them — capability
    // ternaries and all. An earlier version of these tests injected `undefined` or a
    // throwing stub for `reopenTabInBackground`, two shapes the call site can never
    // produce, and that blindness let a false `reopened:true` ship (review P1).
    readOpenWorkflows: () => store.openWorkflows,
    loadWorkflowContent: (wf) => (typeof wf.load === "function" ? wf.load() : undefined),
    reopenTabInBackground: (p) =>
      typeof store.openWorkflowsInBackground === "function"
        ? store.openWorkflowsInBackground({ right: [p] })
        : undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The bug, and the fix
// ---------------------------------------------------------------------------

test("#1575: the reported state — close then open leaves the store naming an UNLOADED tab active", async () => {
  const { store, target, wasOpen } = await strandedByCloseThenOpen();
  assert.equal(wasOpen, false, "the closed tab has no change tracker");
  assert.equal(store.activeWorkflow, target, "the store still names the closed tab as active");
  assert.equal(target.changeTracker, null, "and the store's open loaded nothing");
  assert.equal(
    store.openWorkflows.some((w) => w?.path === target.path),
    false,
    "and never pushed the path back into the open list",
  );
  assert.equal(target.loadCalls, 0, "the early return means load() was never reached");
});

test("#1575: WITHOUT the fix, the panel's repaint read is null — that is the refusal", async () => {
  const { target } = await strandedByCloseThenOpen();
  // The exact expression workflow_open uses, and the exact condition it refuses on.
  const st = target.changeTracker?.activeState ?? target.activeState;
  assert.equal(st, null);
  assert.equal(!st || !Array.isArray(st.nodes), true, "this is what emits 'did not expose a complete workflow state'");
});

test("#1575: the fix loads the content the store's early return skipped", async () => {
  const { store, target, wasOpen } = await strandedByCloseThenOpen();
  const result = await settleOpenedWorkflowTarget(settleArgs(store, target, wasOpen));

  assert.equal(result.reason, "loaded-after-noop-open");
  assert.equal(result.loaded, true);
  assert.equal(result.target, target, "the object is repaired in place, not swapped");
  assert.equal(target.loadCalls, 1, "exactly one load");

  const st = workflowRepaintState(result.target);
  assert.ok(Array.isArray(st?.nodes), "the repaint now has a state to read");
  assert.equal(st.nodes.length, 2);
  assert.equal(hasCompleteRepaintState(result.target), true, "workflow_open no longer refuses");
});

test("#1575: the fix also returns the tab to the open list (the inconsistent active/open state)", async () => {
  const { store, target, wasOpen } = await strandedByCloseThenOpen();
  const result = await settleOpenedWorkflowTarget(settleArgs(store, target, wasOpen));

  assert.equal(result.reopened, true);
  assert.deepEqual(store.backgroundCalls, [[target.path]], "through openWorkflowsInBackground, once");
  assert.equal(
    store.openWorkflows.some((w) => w?.path === target.path),
    true,
    "panel_list_workflows now agrees with the active pointer",
  );
});

test("#1575: the loaded state is the SAVED file, and the tab is not marked dirty by the repair", async () => {
  const { store, target, wasOpen } = await strandedByCloseThenOpen();
  await settleOpenedWorkflowTarget(settleArgs(store, target, wasOpen));
  assert.deepEqual(workflowRepaintState(target), DISK_STATE);
  assert.equal(target.isModified, false, "a repair is not an edit");
});

// ---------------------------------------------------------------------------
// The patch proposed in the issue does NOT fix this state
// ---------------------------------------------------------------------------

test("#1575: reacquiring activeWorkflowRef() alone is INERT here — the active object IS the target", async () => {
  const { store, target } = await strandedByCloseThenOpen();
  // The issue's proposal, transcribed: adopt the post-open active workflow when it
  // matches the requested selector.
  const activeAfterOpen = store.activeWorkflow;
  const adopted =
    activeAfterOpen && matchesSelector(activeAfterOpen, target.path) ? activeAfterOpen : target;
  assert.equal(adopted, target, "it is the same object — ComfyWorkflow.load() returns `this`");
  const st = adopted.changeTracker?.activeState ?? adopted.activeState;
  assert.equal(st, null, "so the open still refuses; adoption alone cannot repair this");
});

// ---------------------------------------------------------------------------
// Non-regression: the healthy paths must not be touched
// ---------------------------------------------------------------------------

test("#1575: a normal first-time open (state present) returns untouched — nothing is loaded or re-listed", async () => {
  const wf = new FakeWorkflow("workflows/normal.json", DISK_STATE);
  const store = new FakeWorkflowStore(wf);
  await store.openWorkflow(wf); // a real open: not active, so it loads
  const loadsAfterOpen = wf.loadCalls;

  const result = await settleOpenedWorkflowTarget(settleArgs(store, wf, false));
  assert.equal(result.reason, "loaded");
  assert.equal(result.loaded, false);
  assert.equal(result.adopted, false);
  assert.equal(result.target, wf);
  assert.equal(wf.loadCalls, loadsAfterOpen, "no extra load");
  assert.deepEqual(store.backgroundCalls, [], "the open list is not touched");
});

test("#1575: an ALREADY-OPEN tab is never touched — that path owns the #442 disk comparison", async () => {
  const wf = new FakeWorkflow("workflows/already.json", DISK_STATE);
  const store = new FakeWorkflowStore(wf);
  await store.openWorkflow(wf);
  const result = await settleOpenedWorkflowTarget(settleArgs(store, wf, true));
  assert.equal(result.reason, "already-open");
  assert.equal(result.loaded, false);
  assert.deepEqual(store.backgroundCalls, []);
});

test("#1575: a target the frontend does NOT name as active is left to the existing refusal", async () => {
  const wf = new FakeWorkflow("workflows/other.json", DISK_STATE);
  const store = new FakeWorkflowStore(wf);
  const someoneElse = new FakeWorkflow("workflows/elsewhere.json", DISK_STATE);
  await someoneElse.load();
  wf.unload();
  const result = await settleOpenedWorkflowTarget(
    settleArgs(store, wf, false, { activeAfterOpen: someoneElse }),
  );
  // someoneElse HAS a state but does not answer to wf's selector, so it is not adopted
  // either — adopting it would repaint and stamp under another tab's identity.
  assert.equal(result.reason, "not-active-after-open");
  assert.equal(result.target, wf);
  assert.equal(wf.loadCalls, 0);
});

// ---------------------------------------------------------------------------
// The adopt arm (a frontend that DOES hand back a different instance)
// ---------------------------------------------------------------------------

test("#1575: a DIFFERENT live object answering the selector with a state IS adopted", async () => {
  const stale = new FakeWorkflow("workflows/swapped.json", DISK_STATE);
  const live = new FakeWorkflow("workflows/swapped.json", DISK_STATE);
  await live.load();
  const store = new FakeWorkflowStore(stale);
  const result = await settleOpenedWorkflowTarget(
    settleArgs(store, stale, false, { activeAfterOpen: live, selector: "workflows/swapped.json" }),
  );
  assert.equal(result.reason, "adopted-live-object");
  assert.equal(result.adopted, true);
  assert.equal(result.target, live);
  assert.equal(stale.loadCalls, 0, "adoption does not also load the stale object");
});

test("#1575: a live object that does NOT answer the selector is never adopted", async () => {
  const stale = new FakeWorkflow("workflows/mine.json", DISK_STATE);
  const foreign = new FakeWorkflow("workflows/theirs.json", DISK_STATE);
  await foreign.load();
  const store = new FakeWorkflowStore(stale);
  const result = await settleOpenedWorkflowTarget(
    settleArgs(store, stale, false, { activeAfterOpen: foreign, selector: "workflows/mine.json" }),
  );
  assert.notEqual(result.target, foreign, "repainting and stamping a foreign tab is the #1089 hazard");
  assert.equal(result.adopted, false);
});

test("#1575: a live object at a DIFFERENT path is not adopted even when the selector matches it", async () => {
  // A bare filename is a valid selector and two directories can hold the same one.
  // Adopting on the name alone would repaint and stamp another workflow's tab (#1089).
  const stale = new FakeWorkflow("workflows/a/shared.json", DISK_STATE);
  const otherDir = new FakeWorkflow("workflows/b/shared.json", DISK_STATE);
  await otherDir.load();
  const store = new FakeWorkflowStore(stale);
  const result = await settleOpenedWorkflowTarget(
    settleArgs(store, stale, false, {
      activeAfterOpen: otherDir,
      selector: "shared.json",
      matchesSelector: (w, sel) => w?.filename === sel, // both answer to it
    }),
  );
  assert.equal(result.adopted, false, "same NAME is not same WORKFLOW");
  assert.notEqual(result.target, otherDir);
});

test("#1575: a throwing selector oracle refuses the adoption rather than guessing", async () => {
  const stale = new FakeWorkflow("workflows/x.json", DISK_STATE);
  const live = new FakeWorkflow("workflows/x.json", DISK_STATE);
  await live.load();
  const store = new FakeWorkflowStore(stale);
  const result = await settleOpenedWorkflowTarget(
    settleArgs(store, stale, false, {
      activeAfterOpen: live,
      matchesSelector: () => {
        throw new Error("selector oracle exploded");
      },
    }),
  );
  assert.equal(result.adopted, false);
});

// ---------------------------------------------------------------------------
// Best-effort: nothing here may turn a refusal into a throw
// ---------------------------------------------------------------------------

test("#1575: a throwing load() falls back to the existing refusal, it does not escape", async () => {
  const { store, target, wasOpen } = await strandedByCloseThenOpen();
  const result = await settleOpenedWorkflowTarget(
    settleArgs(store, target, wasOpen, {
      loadWorkflowContent: () => {
        throw new Error("userdata unreachable");
      },
    }),
  );
  assert.match(result.reason, /^load-failed: /);
  assert.equal(result.loaded, false);
  assert.equal(result.target, target);
  assert.deepEqual(store.backgroundCalls, [], "a failed load must not re-list the tab");
});

test("#1575: a REJECTING load() is awaited and contained", async () => {
  const { store, target, wasOpen } = await strandedByCloseThenOpen();
  const result = await settleOpenedWorkflowTarget(
    settleArgs(store, target, wasOpen, {
      loadWorkflowContent: async () => {
        throw new Error("fetch failed");
      },
    }),
  );
  assert.match(result.reason, /^load-failed: /);
  assert.equal(store.backgroundCalls.length, 0);
});

test("#1575: a load that produces no state is reported, not claimed as repaired", async () => {
  const { store, target, wasOpen } = await strandedByCloseThenOpen();
  const result = await settleOpenedWorkflowTarget(
    settleArgs(store, target, wasOpen, { loadWorkflowContent: () => undefined }),
  );
  assert.equal(result.reason, "load-produced-no-state");
  assert.equal(result.loaded, false);
});

test("#1575: a store with NO openWorkflowsInBackground reports reopened:false — through the REAL lambda", async () => {
  // review P1. The call site always passes a FUNCTION; on a frontend lacking the store
  // method that function returns `undefined` without throwing. Inferring success from
  // "it did not throw" made this claim the tab was restored while the open list was
  // untouched — and suppressed the disclosure that says otherwise.
  const { store, target, wasOpen } = await strandedByCloseThenOpen();
  store.openWorkflowsInBackground = undefined; // the frontend simply does not have it
  const result = await settleOpenedWorkflowTarget(settleArgs(store, target, wasOpen));

  assert.equal(result.loaded, true, "the load is what unblocks the repaint");
  assert.equal(result.reopened, false, "an un-restored tab must NOT be reported as restored");
  assert.equal(
    store.openWorkflows.some((w) => w?.path === target.path),
    false,
    "ground truth: the tab really is still absent from the open list",
  );
});

test("#1575: a store whose openWorkflowsInBackground SILENTLY does nothing reports reopened:false", async () => {
  // The other shape of the same class: the method exists, accepts the call, and the tab
  // still does not appear. Only an observation of the list can tell these apart.
  const { store, target, wasOpen } = await strandedByCloseThenOpen();
  store.openWorkflowsInBackground = () => {}; // accepts, does nothing
  const result = await settleOpenedWorkflowTarget(settleArgs(store, target, wasOpen));
  assert.equal(result.loaded, true);
  assert.equal(result.reopened, false, "reopened must be READ from the open list, not assumed");
});

test("#1575: a throwing openWorkflowsInBackground still yields a loaded target, reopened:false", async () => {
  const { store, target, wasOpen } = await strandedByCloseThenOpen();
  store.openWorkflowsInBackground = () => {
    throw new Error("store refused");
  };
  const result = await settleOpenedWorkflowTarget(settleArgs(store, target, wasOpen));
  assert.equal(result.loaded, true);
  assert.equal(result.reopened, false);
});

test("#1575: reopened:true is only ever claimed when the tab is OBSERVED in the open list", async () => {
  const { store, target, wasOpen } = await strandedByCloseThenOpen();
  const result = await settleOpenedWorkflowTarget(settleArgs(store, target, wasOpen));
  assert.equal(result.reopened, true);
  assert.equal(
    store.openWorkflows.some((w) => w?.path === target.path),
    true,
    "the claim and the store must agree",
  );
});

test("#1575: a frontend without load() degrades to today's refusal", async () => {
  const { store, target, wasOpen } = await strandedByCloseThenOpen();
  const result = await settleOpenedWorkflowTarget(
    settleArgs(store, target, wasOpen, { loadWorkflowContent: undefined }),
  );
  assert.equal(result.reason, "load-unavailable");
  assert.equal(hasCompleteRepaintState(result.target), false);
});

test("#1575: null / garbage input is a no-op, never a throw", async () => {
  assert.equal((await settleOpenedWorkflowTarget()).reason, "no-target");
  assert.equal((await settleOpenedWorkflowTarget({ target: null })).reason, "no-target");
  assert.equal((await settleOpenedWorkflowTarget({ target: 42 })).reason, "no-target");
});

// ---------------------------------------------------------------------------
// The state predicate must mean the same thing the call site means
// ---------------------------------------------------------------------------

test("#1575: hasCompleteRepaintState mirrors workflow_open's own refusal condition", () => {
  assert.equal(hasCompleteRepaintState({ changeTracker: { activeState: { nodes: [] } } }), true, "zero nodes is complete");
  assert.equal(hasCompleteRepaintState({ activeState: { nodes: [{ id: 1 }] } }), true, "the flat shape counts (#721)");
  assert.equal(hasCompleteRepaintState({ changeTracker: { activeState: { nodes: "bad" } } }), false);
  assert.equal(hasCompleteRepaintState({ changeTracker: { activeState: null } }), false);
  assert.equal(hasCompleteRepaintState({}), false);
  assert.equal(hasCompleteRepaintState(null), false);
});

// ---------------------------------------------------------------------------
// Wiring — deleting the call in workflow_open must fail these
// ---------------------------------------------------------------------------

test("#1575: workflow_open settles the target AFTER openWorkflow and BEFORE it reads the state", () => {
  assert.match(
    SRC,
    /import \{\s*settleOpenedWorkflowTarget\s*\} from "\.\/lib\/settle-open-target\.js"/,
    "the shipped helper must be imported, not inlined",
  );

  const openAt = SRC.indexOf("await s.openWorkflow(target);");
  const settleAt = SRC.indexOf("openSettled = await settleOpenedWorkflowTarget({");
  const stAt = SRC.indexOf("const st = target.changeTracker?.activeState ?? target.activeState;");
  assert.notEqual(openAt, -1, "the store-level open must still be what moves the pointer");
  assert.notEqual(settleAt, -1, "the settle call must exist");
  assert.notEqual(stAt, -1, "the repaint-state read must still be there (#721)");
  assert.ok(openAt < settleAt, "settling before the open would have nothing to settle");
  assert.ok(settleAt < stAt, "settling after the state read would be too late to prevent the refusal");

  const call = SRC.slice(settleAt, SRC.indexOf("});", settleAt) + 3);
  assert.match(call, /selector:\s*path/, "the adopt arm must be pinned to the REQUESTED selector");
  assert.match(call, /activeAfterOpen:\s*activeWorkflowRef\(\)/, "read the pointer AFTER the open");
  assert.match(call, /matchesSelector:\s*workflowRecordMatchesSelector/, "the panel's own selector rule");
  assert.match(call, /sameWorkflowObject/, "identity is proxy-safe, not `===` (#558 r2)");
  assert.match(call, /loadWorkflowContent:/, "the load the store's early return skipped");
  assert.match(call, /openWorkflowsInBackground/, "and the tab-list half of it");
  assert.match(call, /wasOpen,/, "an already-open tab must be excluded");
  // review P1 — a READER, so `reopened` can be re-read after the call. A snapshot array
  // cannot show whether the store did anything.
  assert.match(
    call,
    /readOpenWorkflows:\s*\(\)\s*=>\s*s\.openWorkflows/,
    "the open list must be re-readable, not captured once",
  );
  assert.doesNotMatch(call, /openWorkflows:\s*s\.openWorkflows/, "a snapshot cannot observe an effect");
});

test("#1575: the settle's await is held INSIDE a reload step, or the fence ages out mid-load", () => {
  // review P1 — `target.load()` is an unbounded /userdata fetch. Between steps the guard
  // sits at pending === 0, where activeWorkflowReloadGuard() expires it after
  // WORKFLOW_RELOAD_GUARD_MAX_MS; a stalled read would drop the fence, let a concurrent
  // graph_* command through, and the repaint would then overwrite it from disk.
  const settleAt = SRC.indexOf("openSettled = await settleOpenedWorkflowTarget({");
  assert.notEqual(settleAt, -1);
  const before = SRC.slice(Math.max(0, settleAt - 900), settleAt);
  const after = SRC.slice(settleAt, settleAt + 2200);
  assert.match(
    before,
    /if \(!beginWorkflowReloadStep\(reloadGuardToken\)\) \{[\s\S]*?break workflowOpenSteps;\s*\}\s*try \{/,
    "the settle must open a reload step immediately before it",
  );
  assert.match(
    after,
    /\} finally \{\s*\r?\n\s*endWorkflowReloadStep\(reloadGuardToken\);/,
    "and release it in a finally, so a throwing settle cannot hold the fence forever",
  );
});

test("#1575: the repaired target REPLACES the local one, or every later step reads the stale object", () => {
  const settleAt = SRC.indexOf("openSettled = await settleOpenedWorkflowTarget({");
  const after = SRC.slice(settleAt, settleAt + 2000);
  assert.match(
    after,
    /if \(openSettled\.target && openSettled\.target !== target\) target = openSettled\.target;/,
    "the adopt arm is worthless if the result is discarded",
  );
});

test("#1575: a state just read off DISK is not overwritten by the still-mounted canvas (#1215/#874)", () => {
  const gateAt = SRC.indexOf("const captureBinding = describeLiveCanvasBinding(target);");
  assert.notEqual(gateAt, -1);
  const gate = SRC.slice(gateAt, SRC.indexOf("await target.changeTracker?.checkState?.()", gateAt));
  assert.match(
    gate,
    /openSettled\?\.loaded !== true/,
    "capturing the closed tab's canvas over the freshly-loaded file is the #1215 poison",
  );
  // #1295's own pins must survive this change.
  assert.match(gate, /captureBinding === "bound"/);
  assert.match(gate, /captureBinding !== "foreign" && !pointerMovedThisOpen/);
});

test("#1575: a repaired open DISCLOSES that the canvas is the on-disk copy", () => {
  assert.match(SRC, /openSettled\?\.loaded === true\s*\?\s*\{\s*reopened_from_disk:/, "the reply must say what happened");
  const at = SRC.indexOf("reopened_from_disk:");
  const note = SRC.slice(at, at + 1600);
  assert.match(note, /ON-DISK copy/, "the caller must be told which graph they are looking at");
  assert.match(note, /#874/, "and that node-written values are not in it");
});
