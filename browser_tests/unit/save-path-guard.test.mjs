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
  const build = new Function(
    "WORKFLOW_META_NAMESPACE",
    "WORKFLOW_PATH_FIELD",
    "sameWorkflowObject",
    "decideWorkflowSaveVerdict",
    "workflowSaveRefusalError",
    "console",
    `${source}\nreturn { installSavePathGuard };`,
  );
  return {
    warnings,
    buildInstaller: () =>
      build(
        "comfyui_mcp",
        "workflow_path",
        sameWorkflowObject,
        decideWorkflowSaveVerdict,
        workflowSaveRefusalError,
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
