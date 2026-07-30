// Programmatic workflow saving — shared by the panel and unit tests.
//
// The one hard rule here exists because of a silent data-loss bug (issue #226):
// "save this workflow as X" MUST write a NEW file and leave the original file on
// disk untouched (copy / Save-As semantics). Renaming the source — which moves
// and consumes it — is only ever acceptable for a workflow that was never
// persisted (a temporary tab has no source file to destroy).

// ComfyUI persists a workflow with a mode-dependent extension: app-mode
// (initialMode === "app") workflows are written as "<name>.app.json"; everything
// else as "<name>.json". These mirror the frontend's formatUtil so our in-place-
// vs-Save-As decision compares against the SAME path ComfyUI would actually
// write — the ".json"/".app.json" mismatch was a third data-loss edge (#226).
const JSON_EXT = ".json";
const APP_JSON_EXT = ".app.json";

/** Strip a trailing workflow extension (.app.json or .json) and surrounding
 *  whitespace. Mirrors how ComfyUI derives a bare filename from a path. */
function baseName(name) {
  const s = String(name || "").trim();
  const lower = s.toLowerCase();
  if (lower.endsWith(APP_JSON_EXT)) return s.slice(0, -APP_JSON_EXT.length).trim();
  if (lower.endsWith(JSON_EXT)) return s.slice(0, -JSON_EXT.length).trim();
  return s;
}

/** The extension ComfyUI would write this workflow with, from its mode. */
function workflowExt(wf) {
  return wf?.initialMode === "app" ? APP_JSON_EXT : JSON_EXT;
}

/** The path ComfyUI would actually persist `base` to for this workflow — its own
 *  directory + the mode-correct extension (mirrors appendWorkflowJsonExt +
 *  workflow.directory). Used to classify a save as in-place vs Save-As by the
 *  REAL target path, not a name, so an extension/mode difference never gets
 *  misread as "same file" and turned into a destructive rename. */
function targetPath(wf, base) {
  return normalizePath(`${directoryOf(wf)}${base}${workflowExt(wf)}`);
}

/** True when `name` is a placeholder rather than a name the user/agent chose.
 *  ComfyUI's brand-new temporary tabs are pathed "Unsaved Workflow.json" (and
 *  "Unsaved Workflow (2).json", …); the panel's own grounding auto-name is
 *  "Untitled <timestamp>". Anything else is a real, deliberate name. */
export function isDefaultWorkflowName(name) {
  const n = baseName(name);
  return !n || /^Unsaved Workflow\b/i.test(n) || /^Untitled\b/.test(n);
}

/** Save the active workflow through ComfyUI's workflow service — NO dialog.
 *
 *  Behaviour:
 *   - name given AND it differs from an ALREADY-PERSISTED workflow's name →
 *     SAVE-AS: `svc.saveWorkflowAs(wf, { filename })`, which mirrors ComfyUI's
 *     own "Save As" (writes a copy via workflowStore.saveAs, preserves the
 *     source's containing folder, and leaves the original file on disk). NEVER
 *     renameWorkflow() here — that would move/destroy the source (issue #226).
 *   - a never-saved (temporary) workflow that needs a name → also Save-As, which
 *     for a temporary safely renames the in-memory tab to a real file (there is
 *     no source file to consume).
 *   - otherwise → save in place under the current name (`svc.saveWorkflow`).
 *
 *  `autoWorkflowName` mints a grounding name for a placeholder temporary
 *  workflow when no explicit name is supplied. Returns the resolved name, or
 *  null when nothing could be resolved (caller may fall back to a title).
 */
export async function saveActiveWorkflow(svc, name, { autoWorkflowName } = {}) {
  const wf = svc?.activeWorkflow;
  if (!wf) throw new Error("no active workflow to save");

  // An EXPLICIT name (any string, even "  ") must resolve to a real name. If it
  // normalizes to empty, refuse — never silently reinterpret an explicit-but-
  // blank name as "save the current workflow in place", which would overwrite
  // (and, upstream, could rename/move) the persisted source (issue #226).
  const explicit = typeof name === "string";
  if (explicit && !baseName(name)) {
    throw new Error("name must not be blank — pass a non-whitespace workflow name");
  }

  const wasUnsaved = wf.isTemporary === true || wf.isPersisted === false;
  const currentName = baseName(wf.filename);
  // Only mint a fresh auto-name for a genuinely placeholder ("Unsaved Workflow"
  // / "Untitled …") workflow. A named-but-unsaved workflow saves under its name.
  const needsAutoName = wasUnsaved && isDefaultWorkflowName(currentName);
  const desired = baseName(explicit ? name : needsAutoName && autoWorkflowName ? autoWorkflowName() : "");

  // A Save-As is any save that would land at a DIFFERENT path than the one the
  // workflow currently occupies on disk. Compare full, normalized target PATHS —
  // NOT names. Comparing a twice-stripped filename is unsafe: ComfyUI strips the
  // final ".json" from the on-disk name, so a file at "…/Foo.json.json" reports
  // filename "Foo.json"; baseName() would strip it again to "Foo" and misjudge a
  // Save-As to "Foo" as an in-place save. That routes to svc.saveWorkflow, which
  // upstream detects as a path change and calls renameWorkflow — MOVING and
  // destroying the persisted source. Path-vs-path comparison always sends a real
  // relocation down the copy (saveWorkflowAs) branch instead.
  const desiredPath = desired ? targetPath(wf, desired) : "";
  const currentPath = normalizePath(wf.path);
  const isSaveAs = !!desired && desiredPath !== currentPath;

  if (isSaveAs) {
    // The invariant (issue #226): a Save-As must NEVER remove a file that exists
    // on disk. We classify the source by its ACTUAL persisted state — whether a
    // file currently backs it — NOT the in-memory `wasUnsaved`/`isTemporary`
    // flag, which drifts. On ComfyUI 1.45.21 `isTemporary` is derived from
    // `size` (`get isTemporary(){return this.size===-1}`), so after a
    // panel_open_workflow ack-timeout race (#215) a workflow that IS on disk can
    // be left flagged temporary. That matters because the frontend's own
    // `saveWorkflowAs` branches on `isTemporary`: a temporary doc is MOVED
    // (renameWorkflow) instead of copied — which is exactly how the original
    // file gets destroyed. The prior fix (#231) trusted saveWorkflowAs to copy
    // and never verified the source survived.
    const sourcePath = wf.path;
    const sourcePersisted = isPersistedOnDisk(svc, wf, sourcePath);

    if (typeof svc.saveWorkflowAs === "function") {
      // PREVENT the destructive move. If the source is a real on-disk file yet
      // the active doc claims to be temporary, delegating to saveWorkflowAs would
      // take its renameWorkflow (move) branch and destroy the original. Refuse
      // rather than move — the sanctioned safe outcome (#226). This fires ONLY in
      // the inconsistent drift state; a correctly-opened persisted workflow has
      // isTemporary === false and copies normally below.
      if (sourcePersisted && wf.isTemporary === true) {
        throw new Error(
          `refusing to save-as: the active workflow is flagged unsaved but "${sourcePath}" ` +
            `exists on disk — saving now would MOVE (destroy) the original (issue #226). ` +
            `Re-open the workflow and try again.`,
        );
      }
      // Copy path. For a persisted workflow saveWorkflowAs copies
      // (workflowStore.saveAs → new file, original untouched); for a genuine
      // temporary it renames the never-saved tab to a real file. `filename`
      // skips the Save dialog.
      await svc.saveWorkflowAs(wf, { filename: desired });
      // BACKSTOP: if saveWorkflowAs relocated a persisted source anyway, fail
      // LOUDLY instead of reporting a phantom success (the prior fix's exact
      // miss). Only assert when we have a reliable existence oracle — otherwise
      // we can't tell a copy from a move and must not false-alarm.
      if (sourcePersisted && hasExistenceOracle(svc) && !pathExists(svc, sourcePath)) {
        throw new Error(
          `save-as moved the original workflow "${sourcePath}" instead of copying it — ` +
            `the source no longer exists on disk (issue #226)`,
        );
      }
      // saveWorkflowAs makes the new copy the active workflow.
      return baseName(svc.activeWorkflow?.filename) || desired;
    }
    // Fallback only for a workflow that was NEVER persisted: renaming an
    // in-memory temporary tab is safe (no source file to destroy). Guard on the
    // ACTUAL persisted state — a persisted source must never be renamed even if
    // the in-memory `wasUnsaved` flag (wrongly) says it was never saved (#226).
    if (!sourcePersisted && wasUnsaved && typeof svc.renameWorkflow === "function") {
      await svc.renameWorkflow(wf, targetPath(wf, desired));
      await saveInPlace(svc, wf);
      return desired;
    }
    // A persisted workflow with no copy API: refuse rather than move/destroy the
    // original. This is far safer than the old silent rename (issue #226).
    throw new Error(
      "save-as (copy) is unavailable on this frontend; refusing to rename and destroy the original workflow",
    );
  }

  // Save in place — overwrite the same file under the current name.
  await saveInPlace(svc, wf);
  return desired || currentName || null;
}

/** Does `svc` expose any way to check whether a file exists on disk? Without one
 *  we cannot distinguish a Save-As copy from a destructive move, so the caller
 *  must not raise a data-loss alarm (avoids false positives on minimal doubles /
 *  older frontends). */
function hasExistenceOracle(svc) {
  return (
    typeof svc?.getWorkflowByPath === "function" ||
    Array.isArray(svc?.workflows) ||
    Array.isArray(svc?.openWorkflows)
  );
}

/** True when a workflow currently exists at `rawPath` according to whatever the
 *  frontend can tell us — the store's path index first, then the known-workflow
 *  lists. Paths are compared normalized so a "\\" vs "/" difference never reads
 *  as a vanished file. */
function pathExists(svc, rawPath) {
  if (!rawPath) return false;
  if (typeof svc?.getWorkflowByPath === "function") {
    try {
      if (svc.getWorkflowByPath(rawPath)) return true;
    } catch {
      /* fall through to the list scan */
    }
  }
  const norm = normalizePath(rawPath);
  const all = [...(svc?.workflows ?? []), ...(svc?.openWorkflows ?? [])];
  return all.some((w) => w && normalizePath(w.path) === norm);
}

/** ACTUAL persisted state of the source: is it a real file on disk, independent
 *  of the volatile in-memory `isTemporary`/`isPersisted` flags (which drift after
 *  an open-ack race, #215)? `wf.isPersisted === true` is a positive signal; we
 *  also treat a path the store still knows about as persisted. Used to decide
 *  whether a Save-As is allowed to fall back to a move (issue #226). */
function isPersistedOnDisk(svc, wf, rawPath) {
  if (wf?.isPersisted === true) return true;
  return pathExists(svc, rawPath);
}

/** Directory prefix (with trailing slash) that a new sibling file should live in,
 *  preserving the workflow's containing folder. Defaults to the workflows root. */
function directoryOf(wf) {
  const dir = String(wf?.directory || "").replace(/[\\/]+$/, "");
  return dir ? `${dir}/` : "workflows/";
}

/** Normalize a workflow path for a stable same-file comparison: forward slashes,
 *  no doubled/trailing separators. Case is preserved (a case-only difference is
 *  treated as a Save-As, which is the safe direction — it copies). */
function normalizePath(path) {
  return String(path || "")
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

async function saveInPlace(svc, wf) {
  if (typeof svc.saveWorkflow === "function") await svc.saveWorkflow(wf);
  else if (typeof wf.save === "function") await wf.save();
  else throw new Error("workflow save API unavailable on this frontend");
}
