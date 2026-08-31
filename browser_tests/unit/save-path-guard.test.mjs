/**
 * #1667 — P0 DATA LOSS: a stale-canvas tab persisted the WRONG graph over a live file.
 *
 * The incident: a tab whose canvas held workflow A's graph was persisted by the
 * FRONTEND's own save path (autosave / reconnect-restore — no panel command, so the
 * #708 wrong-canvas fence never saw it) over "CUMSLUT2 - Office Slap.json", destroying
 * its 31-node graph. The recovered file's own `extra.comfyui_mcp` stamp named a THIRD
 * workflow's path — the stamp and the destination disagreed, and nothing checked.
 *
 * These tests pin the two halves of the fix:
 *
 *   1. `decideWorkflowSaveVerdict` refuses EXACTLY the evidenced shape — the state
 *      about to be written is stamped with a different, still-existing workflow's
 *      path and the destination is an on-disk file — and allows everything that is
 *      not provable foreign (no stamp, matching stamp, rename residue, unsaved
 *      destination). A guard that refuses on a guess is a wrong-graph refusal of its
 *      own, so the allow-cases are pinned as hard as the refusal.
 *
 *   2. The REAL `installSavePathGuard`, extracted from the panel source and driven
 *      over a fake workflow store, proving the wrapper throws BEFORE the original
 *      save is called — nothing is written — and that a healthy save passes through.
 *
 * panel#1563/#1564 added a SECOND refusal to the same funnel: the state about to be
 * written is not foreign, it is simply BEHIND the canvas, because upstream's pre-save
 * `captureCanvasState()` was silently skipped. Same outcome as #1667 — a save that
 * reports success and loses the user's work — reached without any identity crossing.
 * Its cases live at the bottom of this file, pinned on both sides: the refusal, and
 * every shape that must still save.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  decideWorkflowSaveVerdict,
  workflowSaveRefusalError,
  SAVE_PATH_GUARD_REASON,
} from "../../web/js/lib/save-path-guard.js";
import { sameWorkflowObject } from "../../web/js/lib/workflow-chat-identity.js";
import {
  trackerCaptureSuppressed,
  trackerExposesCaptureComparator,
  trackerSnapshotBehindCanvas,
} from "../../web/js/lib/change-tracker-snapshot.js";
import {
  describeGraphStateDifference,
  graphRootReproducesStateContent,
} from "../../web/js/lib/graph-binding.js";

// ---------------------------------------------------------------------------
// 1. The pure verdict.
// ---------------------------------------------------------------------------

test("#1667 THE REPORTED CASE: a canvas stamped with a THIRD workflow's path is refused over the live file", () => {
  // The destroyed file's stamp named "CUMSLUT - pussy lips (Copy).json" while the
  // write targeted "CUMSLUT2 - Office Slap.json" — and the stamped path was a real,
  // still-existing workflow. This exact crossing is what must never write again.
  const verdict = decideWorkflowSaveVerdict({
    destinationPath: "workflows/CUMSLUT2 - Office Slap.json",
    destinationPersisted: true,
    stampedPath: "workflows/CUMSLUT - pussy lips (Copy).json",
    stampedPathOwnedByOther: true,
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, SAVE_PATH_GUARD_REASON.STAMPED_PATH_FOREIGN);
});

test("#1667 a healthy save — stamp matches the destination — is allowed", () => {
  const verdict = decideWorkflowSaveVerdict({
    destinationPath: "workflows/a.json",
    destinationPersisted: true,
    stampedPath: "workflows/a.json",
    stampedPathOwnedByOther: false,
  });
  assert.deepEqual(verdict, { allow: true });
});

test("#1667 no stamp at all is ALLOWED — absence proves nothing in either direction", () => {
  // Blocking every unstamped save would break ordinary ComfyUI use for exactly the
  // users the stamping fork failed to install for. The guard refuses only on
  // POSITIVE contradiction.
  for (const stampedPath of [null, undefined, ""]) {
    assert.deepEqual(
      decideWorkflowSaveVerdict({
        destinationPath: "workflows/a.json",
        destinationPersisted: true,
        stampedPath,
        stampedPathOwnedByOther: false,
      }),
      { allow: true },
    );
  }
});

test("#1667 RENAME RESIDUE is allowed — the stamped path no longer names a live record", () => {
  // After a rename the file moved: the in-memory stamp still names the old path, and
  // the canvas genuinely belongs to the destination. Refusing here would wedge every
  // renamed tab — a wrong-graph refusal of the guard's own.
  const verdict = decideWorkflowSaveVerdict({
    destinationPath: "workflows/renamed.json",
    destinationPersisted: true,
    stampedPath: "workflows/old-name.json",
    stampedPathOwnedByOther: false, // old path is gone from the store
  });
  assert.deepEqual(verdict, { allow: true });
});

test("#1667 an UNSAVED destination is allowed — no existing file is overwritten (Save-As copy stays saveable)", () => {
  // A Save-As copy inherits the source's stamp; its target is a temporary record, so
  // the first write creates a file rather than destroying one.
  const verdict = decideWorkflowSaveVerdict({
    destinationPath: "workflows/copy.json",
    destinationPersisted: false,
    stampedPath: "workflows/source.json",
    stampedPathOwnedByOther: true,
  });
  assert.deepEqual(verdict, { allow: true });
});

test("#1667 path comparison is normalized — case and separator drift must not false-refuse", () => {
  const verdict = decideWorkflowSaveVerdict({
    destinationPath: "workflows/Sub\\Foo.JSON",
    destinationPersisted: true,
    stampedPath: "workflows/sub/foo.json",
    stampedPathOwnedByOther: false,
  });
  assert.deepEqual(verdict, { allow: true });
});

test("#1667 the refusal names both paths, states NOTHING was written, and names the recovery", () => {
  const err = workflowSaveRefusalError({
    allow: false,
    reason: SAVE_PATH_GUARD_REASON.STAMPED_PATH_FOREIGN,
    destinationPath: "workflows/CUMSLUT2 - Office Slap.json",
    stampedPath: "workflows/CUMSLUT - pussy lips (Copy).json",
  });
  assert.match(err.message, /CUMSLUT2 - Office Slap\.json/);
  assert.match(err.message, /CUMSLUT - pussy lips \(Copy\)\.json/);
  assert.match(err.message, /NOTHING was written/);
  assert.match(err.message, /panel_open_workflow/);
  // Honesty pin: the message must present the two readings, not assert one cause.
  assert.match(err.message, /stale/);
  assert.match(err.message, /deliberately/);
});

test("#1667 a verdict with missing paths still produces a coherent refusal", () => {
  const err = workflowSaveRefusalError({ allow: false });
  assert.match(err.message, /REFUSED to save/);
  assert.match(err.message, /NOTHING was written/);
});

// ---------------------------------------------------------------------------
// 2. The real installer, driven over a fake workflow store.
//
// SCOPE, stated honestly: this exercises the wrapper's LOGIC against a plain-object
// store. It models neither pinia reactivity nor the real ChangeTracker — a wiring
// mistake that keeps the wrapper off the real store (e.g. the store not existing at
// setup() time) is not caught here, only in a live browser.
// ---------------------------------------------------------------------------

const PANEL_SRC = () =>
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");

/** The REAL installSavePathGuard, sliced from the panel bundle with its module-scope
 *  state, collaborators injected. */
function buildInstaller() {
  const src = PANEL_SRC();
  const start = src.indexOf("let _savePathGuardInstalled = false;");
  assert.notEqual(start, -1, "save-path guard state must exist in the panel source");
  const end = src.indexOf("\nfunction workflowUuidOwner(id) {", start);
  assert.ok(end > start, "could not bound installSavePathGuard");
  const source = src.slice(start, end);

  const warnings = [];
  // panel#1563 — `saveWouldPersistStaleSnapshot` lives inside this same slice, so the
  // wrapper's SECOND verdict is exercised as WIRED, not as a helper called by hand.
  // Its collaborators are the REAL ones (the suppression predicate and the tolerant
  // content comparison); only `window`/`app` are shadowed, because the slice reads the
  // live root off the app object and node has no `window`.
  const build = new Function(
    "WORKFLOW_META_NAMESPACE",
    "WORKFLOW_PATH_FIELD",
    "sameWorkflowObject",
    "decideWorkflowSaveVerdict",
    "workflowSaveRefusalError",
    "activeWorkflowRef",
    "trackerCaptureSuppressed",
    "trackerExposesCaptureComparator",
    "trackerSnapshotBehindCanvas",
    "describeGraphStateDifference",
    "graphRootReproducesStateContent",
    "window",
    "app",
    "console",
    `${source}\nreturn { installSavePathGuard };`,
  );
  return {
    warnings,
    buildInstaller: ({ activeWorkflow = null, rootGraph = null } = {}) =>
      build(
        "comfyui_mcp",
        "workflow_path",
        sameWorkflowObject,
        decideWorkflowSaveVerdict,
        workflowSaveRefusalError,
        () => activeWorkflow,
        trackerCaptureSuppressed,
        trackerExposesCaptureComparator,
        trackerSnapshotBehindCanvas,
        describeGraphStateDifference,
        graphRootReproducesStateContent,
        {},
        { rootGraph },
        { warn: (...args) => warnings.push(args.join(" ")) },
      ).installSavePathGuard,
  };
}

function fakeStore({ stampedPath } = {}) {
  const wfB = { path: "workflows/B.json", isTemporary: false };
  const wfA = {
    path: "workflows/A.json",
    isTemporary: false,
    changeTracker: {
      activeState: {
        nodes: [{ id: 1 }],
        extra: stampedPath ? { comfyui_mcp: { workflow_path: stampedPath } } : {},
      },
    },
  };
  const store = {
    saved: [],
    getWorkflowByPath(p) {
      if (p === "workflows/A.json") return wfA;
      if (p === "workflows/B.json") return wfB;
      return null;
    },
    async saveWorkflow(wf) {
      this.saved.push(wf.path);
    },
  };
  return { store, wfA, appRef: { extensionManager: { workflow: store } } };
}

test("#1667 WRAPPER: a crossed save is refused and the original save is NEVER called", async () => {
  const { buildInstaller: build } = buildInstaller();
  const install = build();
  const { store, wfA, appRef } = fakeStore({ stampedPath: "workflows/B.json" });
  install(appRef);
  await assert.rejects(() => store.saveWorkflow(wfA), /REFUSED to save/);
  assert.deepEqual(store.saved, [], "nothing may be written when the guard refuses");
});

test("#1667 WRAPPER: a healthy save passes through to the original unchanged", async () => {
  const { buildInstaller: build } = buildInstaller();
  const install = build();
  const { store, wfA, appRef } = fakeStore({ stampedPath: "workflows/A.json" });
  install(appRef);
  await store.saveWorkflow(wfA);
  assert.deepEqual(store.saved, ["workflows/A.json"]);
});

test("#1667 WRAPPER: an unstamped canvas saves — the guard does not block what it cannot prove", async () => {
  const { buildInstaller: build } = buildInstaller();
  const install = build();
  const { store, wfA, appRef } = fakeStore({ stampedPath: null });
  install(appRef);
  await store.saveWorkflow(wfA);
  assert.deepEqual(store.saved, ["workflows/A.json"]);
});

test("#1667 WRAPPER: rename residue (stamped path gone from the store) saves", async () => {
  const { buildInstaller: build } = buildInstaller();
  const install = build();
  const { store, wfA, appRef } = fakeStore({ stampedPath: "workflows/old-name.json" });
  install(appRef);
  await store.saveWorkflow(wfA);
  assert.deepEqual(store.saved, ["workflows/A.json"]);
});

test("#1667 WRAPPER: a missing store is DISCLOSED, not silent — saves proceed unguarded with a warning", async () => {
  const { buildInstaller: build, warnings } = buildInstaller();
  const install = build();
  install({ extensionManager: {} });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /save-path guard NOT installed/);
});

// ---------------------------------------------------------------------------
// 3. panel#1563 — a snapshot that has fallen BEHIND the canvas.
// ---------------------------------------------------------------------------

test("#1563 THE REPORTED CASE: a stale snapshot is refused before it can be written", () => {
  const verdict = decideWorkflowSaveVerdict({
    destinationPath: "workflows/big.json",
    destinationPersisted: true,
    snapshotIsStale: true,
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, SAVE_PATH_GUARD_REASON.STALE_SNAPSHOT);
  assert.match(workflowSaveRefusalError(verdict).message, /BEHIND the live canvas/);
  assert.match(workflowSaveRefusalError(verdict).message, /NOTHING was written/);
});

test("#1563 a FIRST save is refused too — lost work reported as success is the same defect", () => {
  // Not gated on `destinationPersisted`: no existing file is destroyed, but the user is
  // still told a canvas reached disk when part of it did not.
  const verdict = decideWorkflowSaveVerdict({
    destinationPath: "workflows/new.json",
    destinationPersisted: false,
    snapshotIsStale: true,
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, SAVE_PATH_GUARD_REASON.STALE_SNAPSHOT);
});

test("#1563 a healthy save is untouched — the new conjunct defaults to allow", () => {
  assert.deepEqual(
    decideWorkflowSaveVerdict({ destinationPath: "workflows/A.json", destinationPersisted: true }),
    { allow: true },
  );
  assert.deepEqual(
    decideWorkflowSaveVerdict({
      destinationPath: "workflows/A.json",
      destinationPersisted: true,
      snapshotIsStale: false,
    }),
    { allow: true },
  );
});

/** The reported shape: the canvas gained a group the tracker never captured. */
function staleFixture({
  suppressed = true,
  live = "extra-group",
  active = true,
  // panel#2133 — attach ComfyUI's OWN comparator to the tracker's constructor, the way
  // the shipped `ChangeTracker` carries `static graphEqual`. Absent by default so every
  // test written before #2133 keeps exercising the frontend shape it was written for.
  graphEqual = null,
} = {}) {
  const snapshot = {
    nodes: [{ id: 1, type: "VAEDecode", pos: [0, 0] }],
    groups: [{ id: 1, title: "Pre", bounding: [0, 0, 10, 10] }],
    extra: {},
  };
  let liveState;
  if (live === "extra-group") {
    liveState = {
      nodes: [{ id: 1, type: "VAEDecode", pos: [0, 0] }],
      groups: [
        { id: 1, title: "Pre", bounding: [0, 0, 10, 10] },
        { id: 2, title: "New17", bounding: [20, 0, 10, 10] },
      ],
      extra: {},
    };
  } else if (live === "pos-only") {
    liveState = JSON.parse(JSON.stringify(snapshot));
    liveState.nodes[0].pos = [100, 50];
  } else if (live === "widget-value") {
    snapshot.nodes[0] = { ...snapshot.nodes[0], widgets_values: ["a"] };
    liveState = JSON.parse(JSON.stringify(snapshot));
    liveState.nodes[0].widgets_values = ["b"];
  } else {
    liveState = JSON.parse(JSON.stringify(snapshot));
  }
  const tracker = {
    activeState: snapshot,
    // `changeCount > 0` is one of upstream's own suppression conditions.
    changeCount: suppressed ? 1 : 0,
    _restoringState: false,
  };
  // `trackerCaptureSuppressed` already reads `tracker.constructor.isLoadingGraph`, and
  // `trackerSnapshotBehindCanvas` reads `tracker.constructor.graphEqual` the same way,
  // so the fixture models the constructor rather than stubbing either predicate.
  if (graphEqual) tracker.constructor = { isLoadingGraph: false, graphEqual };
  const wfA = {
    path: "workflows/A.json",
    isTemporary: false,
    changeTracker: tracker,
  };
  const wfB = { path: "workflows/B.json", isTemporary: false };
  const store = {
    saved: [],
    getWorkflowByPath(p) {
      if (p === "workflows/A.json") return wfA;
      if (p === "workflows/B.json") return wfB;
      return null;
    },
    async saveWorkflow(wf) {
      this.saved.push(wf.path);
    },
  };
  // panel#1563 r4 — the COPY point. `workflowStore.saveAs` seeds the new record from
  // `existingWorkflow.activeState`, so a stale source snapshot becomes a stale file.
  store.copies = [];
  store.saveAs = function (sourceWf, path) {
    this.copies.push({ from: sourceWf?.path, to: path });
    return { path, isTemporary: false };
  };
  return {
    store,
    wfA,
    appRef: { extensionManager: { workflow: store } },
    activeWorkflow: active ? wfA : wfB,
    rootGraph: { serialize: () => liveState },
  };
}

test("#1563 WRAPPER: the save that loses the group is refused and never reaches the store", async () => {
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture();
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  await assert.rejects(() => fx.store.saveWorkflow(fx.wfA), /BEHIND the live canvas/);
  assert.deepEqual(fx.store.saved, [], "nothing may be written when the snapshot is stale");
});

test("#1563 WRAPPER: a suppressed capture on an ALREADY-EQUAL canvas still saves", async () => {
  // The ordinary state of a clean tab. Refusing here would trade data loss for a
  // cannot-save bug.
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ live: "equal" });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"]);
});

test("#1563 WRAPPER: a content difference with NO suppression still saves", async () => {
  // Ordinary tracker lag, which `prepareForSave()` resolves a microsecond later. Only
  // upstream's own positive "I skipped it" turns a difference into a refusal.
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ suppressed: false });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"]);
});

test("#1563 WRAPPER: an INACTIVE workflow is never judged against the active canvas", async () => {
  // `app.rootGraph` is the ACTIVE tab's canvas. Comparing it with another tab's
  // snapshot would refuse a save that loses nothing.
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ active: false });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"]);
});

test("#1563 WRAPPER: with no live root readable the guard invents nothing", async () => {
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture();
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: null });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"]);
});

// ---------------------------------------------------------------------------
// panel#1563 r2 — AN ABSENT COMPARISON IS NOT EVIDENCE.
//
// `graphRootReproducesStateContent` answers the same `proven: false` for "the canvas
// provably differs" and for "no comparison was possible", and its own contract says
// `comparable:false` is not evidence either way. Reading `proven !== true` alone turned
// every unreadable root into a REFUSAL of ComfyUI's whole save funnel — autosave and
// Ctrl+S included — and told the user their file was missing changes on no evidence.
// A serialization hook is exactly where a broken or hostile custom node sits.
// ---------------------------------------------------------------------------

test("#1563 r2 WRAPPER: a root whose serialize() THROWS never manufactures a refusal", async () => {
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture();
  const install = build({
    activeWorkflow: fx.activeWorkflow,
    rootGraph: {
      serialize() {
        throw new Error("custom node exploded in a serialization hook");
      },
    },
  });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"], "an unreadable canvas must not block the save");
});

test("#1563 r2 WRAPPER: a root that answers null never manufactures a refusal", async () => {
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture();
  const install = build({
    activeWorkflow: fx.activeWorkflow,
    rootGraph: { serialize: () => null },
  });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"]);
});

test("#1563 r2 WRAPPER: a root the comparison cannot read is not a stale snapshot", async () => {
  // No `nodes` array ⇒ `describeGraphStateDifference` reports `comparable:false`. The
  // state may be perfectly current; nothing has been established either way.
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture();
  const install = build({
    activeWorkflow: fx.activeWorkflow,
    rootGraph: { serialize: () => ({ groups: [{ id: 1 }] }) },
  });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"]);
});

test("#1563 r2 WRAPPER: the reported case still refuses — comparability is a floor, not a bypass", async () => {
  // The guard must not have been softened into inertness by the two tests above: a
  // readable canvas that genuinely holds the new group is still refused.
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture();
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  await assert.rejects(() => fx.store.saveWorkflow(fx.wfA), /BEHIND the live canvas/);
  assert.deepEqual(fx.store.saved, []);
});

test("#1563 WIRING: the wrapper passes its own observation, not a constant", () => {
  const source = PANEL_SRC();
  const decide = source.indexOf("verdict = decideWorkflowSaveVerdict({");
  assert.ok(decide > 0, "the save funnel decides with decideWorkflowSaveVerdict");
  const call = source.slice(decide, decide + 1400);
  assert.match(
    call,
    /snapshotIsStale: saveWouldPersistStaleSnapshot\(wf, state\)/,
    "the stale-snapshot evidence must be computed from the SAME state the write serializes",
  );
});

// ---------------------------------------------------------------------------
// 4. panel#1563 r4 — the Save-As COPY point, where the evidence still exists.
// ---------------------------------------------------------------------------

test("#1563 r4 WRAPPER: a Save-As is refused BEFORE the stale snapshot is copied", () => {
  // The gate's P1: the `saveWorkflow` wrapper cannot catch this. `saveAs` seeds the copy
  // from the SOURCE's snapshot, `openWorkflow` then loads that stale state onto the
  // canvas, and the fresh target tracker captures it — so by the time the save reaches
  // the other wrapper the tracker is unsuppressed AND the canvas agrees with the
  // snapshot. Every piece of evidence is gone. It has to be caught here.
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture();
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  assert.throws(() => fx.store.saveAs(fx.wfA, "workflows/Copy.json"), /BEHIND the live canvas/);
  assert.deepEqual(fx.store.copies, [], "no copy may be created from a stale snapshot");
  assert.deepEqual(fx.store.saved, [], "and nothing may be written");
});

test("#1563 r4 WRAPPER: a healthy Save-As still copies", () => {
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ suppressed: false });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  const made = fx.store.saveAs(fx.wfA, "workflows/Copy.json");
  assert.equal(made.path, "workflows/Copy.json");
  assert.deepEqual(fx.store.copies, [{ from: "workflows/A.json", to: "workflows/Copy.json" }]);
});

test("#1563 r4 WRAPPER: a Save-As of an INACTIVE source is not judged against this canvas", () => {
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ active: false });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  fx.store.saveAs(fx.wfA, "workflows/Copy.json");
  assert.equal(fx.store.copies.length, 1);
});

test("#1563 r4 WRAPPER: a frontend with no saveAs is DISCLOSED, not silently unguarded", () => {
  const { buildInstaller: build, warnings } = buildInstaller();
  const fx = staleFixture();
  delete fx.store.saveAs;
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /saveAs is unavailable/);
});

test("#1563 r4 WIRING: the guard is installed on the COPY point, from the source's own state", () => {
  const source = PANEL_SRC();
  const at = source.indexOf("svc.saveAs = function (sourceWf, destPath, ...rest) {");
  assert.ok(at > 0, "the save funnel must wrap workflowStore.saveAs");
  const body = source.slice(at, at + 1400);
  assert.match(
    body,
    /sourceWf\?\.changeTracker\?\.activeState \?\? sourceWf\?\.activeState/,
    "the evidence must come from the SOURCE snapshot the copy is built from",
  );
  assert.match(
    body,
    /snapshotIsStale: saveWouldPersistStaleSnapshot\(sourceWf, sourceState\)/,
    "and it must be the same predicate, not a re-derived one",
  );
  const throwAt = body.indexOf("throw workflowSaveRefusalError(verdict);");
  const callAt = body.indexOf("return origSaveAs(");
  assert.ok(throwAt > 0 && callAt > throwAt, "the refusal must precede the copy");
});

// ---------------------------------------------------------------------------
// 5. panel#1580 — presentation-only drift is not a stale snapshot.
//
// `graphRootReproducesStateContent` answers `proven: false` AND `presentationOnly: true`
// for a canvas that differs from the snapshot only by node geometry (`pos`). Conjunct
// 2 used to read `proven !== true` alone, so a suppressed capture whose only drift
// was a dragged node refused autosave and Ctrl+S. The classifier already vouches that
// nothing AUTHORED is behind the canvas — the same reading #1477 and #1623 applied
// on the open path. Widget values and groups stay refused: those are the defect
// #1567 exists to stop.
// ---------------------------------------------------------------------------

test("#1580 WRAPPER: a suppressed capture whose only drift is node geometry still saves", async () => {
  // The reported false positive: undo's `_restoringState` window is still open, the
  // canvas and snapshot agree on every authored field, and a node was dragged. The
  // save must go through — refusing it tells the user to reload the tab over a `pos`.
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ live: "pos-only" });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"]);
});

test("#1580 WRAPPER: a widget-value difference is still refused — authored drift is not cosmetic", async () => {
  // Row 3 of the measured table: same suppression window, same `nodes` surface, but
  // the field that moved is `widgets_values`. Softening conjunct 2 onto presentation-
  // only must not also wave this through.
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ live: "widget-value" });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  await assert.rejects(() => fx.store.saveWorkflow(fx.wfA), /BEHIND the live canvas/);
  assert.deepEqual(fx.store.saved, []);
});

test("#1580 WRAPPER: a Save-As whose only drift is node geometry still copies", () => {
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ live: "pos-only" });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  const made = fx.store.saveAs(fx.wfA, "workflows/Copy.json");
  assert.equal(made.path, "workflows/Copy.json");
  assert.deepEqual(fx.store.copies, [{ from: "workflows/A.json", to: "workflows/Copy.json" }]);
});

// ---------------------------------------------------------------------------
// 6. panel#2133 — the loss that survives the suppression window closing.
//
// THE REPORT: a saved workflow was extended with three nodes and a group through panel
// tools, `panel_graph_outline` read the LIVE canvas back as 10 nodes / 3 groups,
// `panel_save_workflow` answered `saved:true`, and after a ComfyUI restart the same
// workflow came back as the original 7 nodes / 2 groups. Same outcome as #1563 —
// success reported over a file the canvas is not in — but no suppression flag was set
// when the write happened, so conjunct 1 could not fire and the guard allowed it.
//
// It cannot fire, because those flags only describe a window that is open RIGHT NOW.
// MEASURED against the shipped bundle (comfyui-frontend 1.49.6), `captureCanvasState`
// has FIVE early returns, not the three the flag model reads:
//
//     captureCanvasState(){
//       let e=this._restoringState,t=this.changeCount>0;
//       if(!$.graph||t||e||ChangeTracker.isLoadingGraph)return;
//       if(!isActiveTracker(this)){reportInactiveTrackerCall(...);return}
//
// and `prepareForSave(){isActiveTracker(this)&&this.captureCanvasState()}` — so the
// refresh the panel asks for before every overwrite can be a total no-op with nothing
// to observe, and a capture swallowed a moment earlier leaves every flag back to false
// by write time either way.
//
// So conjunct 1 gains a second reading, asked in upstream's own vocabulary:
// `ChangeTracker.graphEqual` — the comparator `captureCanvasState` uses to decide
// whether to replace `activeState` — still says the snapshot differs AFTER a refresh
// was requested. A capture that actually ran would have replaced it.
//
// Conjunct 2 is untouched, and these tests pin that the widening did not become "any
// content difference refuses": upstream's comparator is deliberately more tolerant
// than the panel's shape (it ignores `config` entirely and compares arrays inside
// nodes as SETS), and where the two disagree, the tolerant one wins.
// ---------------------------------------------------------------------------

/**
 * ComfyUI's own `ChangeTracker.graphEqual`, transcribed from the shipped bundle
 * (comfyui-frontend 1.49.6, `settingStore-CwkLtSKP.js`):
 *
 *   static graphEqual(e,t){
 *     if(e===t)return!0;
 *     if(typeof e=="object"&&e&&typeof t=="object"&&t){
 *       if(!nr.isEqualWith(e.nodes,t.nodes,(e,t)=>{
 *            if(Array.isArray(e)&&Array.isArray(t))return nr.isEqual(new Set(e),new Set(t))})
 *          ||!nr.isEqual(nr.omit(e.extra??{},["ds"]),nr.omit(t.extra??{},["ds"])))return!1;
 *       for(let n of["links","floatingLinks","reroutes","groups","definitions","subgraphs"])
 *         if(!nr.isEqual(e[n],t[n]))return!1;
 *       return!0}
 *     return!1}
 *
 * The lodash customizer fires at EVERY level, so every array nested inside `nodes` is
 * compared as an unordered set; the other surfaces use plain, order-sensitive equality.
 */
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
};
const stableJson = (value) => JSON.stringify(canonical(value) ?? null);
const deepEqual = (a, b) => stableJson(a) === stableJson(b);
// The customizer descends, so an array anywhere under a node is order-insensitive too.
const setwiseNormalize = (value) => {
  if (Array.isArray(value)) return value.map(setwiseNormalize).map(stableJson).sort();
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, setwiseNormalize(value[k])]));
  }
  return value;
};
const setwiseEqual = (a, b) => stableJson(setwiseNormalize(a)) === stableJson(setwiseNormalize(b));

function upstreamGraphEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || !a || typeof b !== "object" || !b) return false;
  if (!setwiseEqual(a.nodes, b.nodes)) return false;
  const omitDs = (extra) => {
    const { ds: _ds, ...rest } = extra ?? {};
    return rest;
  };
  if (!deepEqual(omitDs(a.extra), omitDs(b.extra))) return false;
  for (const key of ["links", "floatingLinks", "reroutes", "groups", "definitions", "subgraphs"]) {
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

test("#2133 upstreamGraphEqual: the transcription behaves like the bundle it quotes", () => {
  // Guards the fixture itself. If this drifts, every #2133 case below is testing a
  // comparator ComfyUI does not have.
  assert.equal(upstreamGraphEqual({ nodes: [] }, { nodes: [] }), true);
  assert.equal(upstreamGraphEqual({ nodes: [{ id: 1 }] }, { nodes: [{ id: 2 }] }), false);
  assert.equal(
    upstreamGraphEqual({ nodes: [], groups: [{ id: 1 }] }, { nodes: [], groups: [] }),
    false,
    "groups are compared",
  );
  assert.equal(
    upstreamGraphEqual(
      { nodes: [{ id: 1, widgets_values: ["a", "b"] }] },
      { nodes: [{ id: 1, widgets_values: ["b", "a"] }] },
    ),
    true,
    "arrays inside nodes compare as SETS — a reorder is equal upstream",
  );
  assert.equal(
    upstreamGraphEqual({ nodes: [], config: { a: 1 } }, { nodes: [], config: { b: 2 } }),
    true,
    "`config` is not one of the compared surfaces",
  );
  assert.equal(
    upstreamGraphEqual(
      { nodes: [], extra: { ds: { scale: 1 } } },
      { nodes: [], extra: { ds: { scale: 9 } } },
    ),
    true,
    "the viewport transform is omitted",
  );
});

test("#2133 THE REPORTED CASE: no suppression window, and the write is still refused", async () => {
  // The canvas gained a group; the snapshot did not; every flag reads false because the
  // window that swallowed the capture has already closed. Before this fix the guard
  // allowed the write and the file came back without the group.
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ suppressed: false, graphEqual: upstreamGraphEqual });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  await assert.rejects(() => fx.store.saveWorkflow(fx.wfA), /BEHIND the live canvas/);
  assert.deepEqual(fx.store.saved, [], "nothing may be written when the capture was swallowed");
});

test("#2133 the Save-As COPY point is refused on the same evidence", () => {
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ suppressed: false, graphEqual: upstreamGraphEqual });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  assert.throws(() => fx.store.saveAs(fx.wfA, "workflows/Copy.json"), /BEHIND the live canvas/);
  assert.deepEqual(fx.store.copies, []);
});

test("#2133 a snapshot upstream's comparator calls EQUAL saves, window open or not", async () => {
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ suppressed: false, live: "equal", graphEqual: upstreamGraphEqual });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"]);
});

test("#2133 a frontend with no graphEqual keeps EXACTLY today's behaviour", async () => {
  // Positive evidence only. An unrecognised tracker cannot answer the question, so the
  // save proceeds — the same rule `trackerCaptureSuppressed` follows, which is why
  // "#1563 WRAPPER: a content difference with NO suppression still saves" above is
  // unchanged rather than deleted.
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ suppressed: false, graphEqual: null });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"]);
});

test("#2133 conjunct 2 still governs: a dragged node is not a stale snapshot", async () => {
  // #1580 under the widened conjunct 1. `pos` differs, so upstream's comparator says
  // "not equal" and conjunct 1 now fires without any window — and the save must STILL
  // go through, because the panel's classifier vouches that nothing authored is behind
  // the canvas. Refusing here would tell the user to recover a file over a drag.
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ suppressed: false, live: "pos-only", graphEqual: upstreamGraphEqual });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"]);
});

test("#2133 the TOLERANT comparator wins where the two disagree", async () => {
  // A `widgets_values` REORDER. The panel's own shape comparison calls this an authored
  // `nodes` difference, and conjunct 2 refuses it — but upstream compares those arrays
  // as sets, so its capture would have left `activeState` alone and there is nothing
  // stale about this snapshot. Conjunct 1 is what keeps the guard off it, which is the
  // point of asking the question in upstream's vocabulary rather than the panel's.
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ suppressed: false, live: "equal", graphEqual: upstreamGraphEqual });
  fx.wfA.changeTracker.activeState.nodes[0].widgets_values = ["a", "b"];
  const live = JSON.parse(JSON.stringify(fx.wfA.changeTracker.activeState));
  live.nodes[0].widgets_values = ["b", "a"];
  const install = build({
    activeWorkflow: fx.activeWorkflow,
    rootGraph: { serialize: () => live },
  });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"]);
});

test("#2133 a comparator that THROWS never manufactures a refusal", async () => {
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({
    suppressed: false,
    graphEqual: () => {
      throw new Error("a custom node replaced ChangeTracker");
    },
  });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"]);
});

test("#2133 a comparator that cannot decide (undefined) is not evidence", async () => {
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ suppressed: false, graphEqual: () => undefined });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"]);
});

test("#2133 an INACTIVE workflow is still never judged against the active canvas", async () => {
  const { buildInstaller: build } = buildInstaller();
  const fx = staleFixture({ suppressed: false, active: false, graphEqual: upstreamGraphEqual });
  const install = build({ activeWorkflow: fx.activeWorkflow, rootGraph: fx.rootGraph });
  install(fx.appRef);
  await fx.store.saveWorkflow(fx.wfA);
  assert.deepEqual(fx.store.saved, ["workflows/A.json"]);
});

test("#2133 WIRING: conjunct 1 is a DISJUNCTION at the call site, not a rewritten flag read", () => {
  // A helper-level test cannot see whether the funnel actually asks the second question:
  // `trackerSnapshotBehindCanvas` could be exported, tested and never called. So pin the
  // call site, and pin that it is asked off the SAME frozen snapshot and the SAME state
  // the write serializes — two serializations could disagree, and a re-read of
  // `tracker.activeState` could differ from `state` on a record with no changeTracker.
  const source = PANEL_SRC();
  const at = source.indexOf("function saveWouldPersistStaleSnapshot(wf, state) {");
  assert.ok(at > 0, "the stale-snapshot predicate must exist in the panel source");
  const end = source.indexOf("\nfunction installSavePathGuard(", at);
  assert.ok(end > at, "could not bound saveWouldPersistStaleSnapshot");
  const body = source.slice(at, end);
  assert.match(
    body,
    /!suppressed && !trackerSnapshotBehindCanvas\(tracker, frozen, state\)/,
    "either reading of 'no capture happened' must satisfy conjunct 1",
  );
  assert.match(
    body,
    /const suppressed = trackerCaptureSuppressed\(tracker\);/,
    "the flag reading is still one of the two",
  );
  // The cheap pre-check must not become the whole gate: a tracker that EXPOSES the
  // comparator has to go on and ASK it, and a suppressed tracker must reach conjunct 2
  // even when no comparator exists at all (the #1563 path, unchanged).
  assert.match(
    body,
    /if \(!suppressed && !trackerExposesCaptureComparator\(tracker\)\) return false;/,
    "the serialize-free early-out is gated on BOTH readings being unavailable",
  );
  const frozenAt = body.indexOf("const frozen = { serialize: () => liveState };");
  const conjunct1At = body.indexOf("!suppressed && !trackerSnapshotBehindCanvas(tracker, frozen, state)");
  const conjunct2At = body.indexOf("describeGraphStateDifference({ rootGraph: frozen, state })");
  assert.ok(frozenAt > 0, "the frozen snapshot must still exist");
  assert.ok(conjunct1At > frozenAt, "conjunct 1 must read the frozen snapshot");
  assert.ok(conjunct2At > conjunct1At, "and conjunct 2 must still gate the refusal after it");
});
