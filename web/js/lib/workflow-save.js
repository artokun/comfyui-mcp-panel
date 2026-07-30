// Programmatic workflow saving — shared by the panel and unit tests.
//
// The one hard rule here exists because of a silent data-loss bug (issue #226):
// "save this workflow as X" MUST write a NEW file and leave the original file on
// disk untouched (copy / Save-As semantics). Renaming the source — which moves
// and consumes it — is only ever acceptable for a workflow that was never
// persisted (a temporary tab has no source file to destroy).

/** Strip a trailing .json (case-insensitive) and surrounding whitespace. */
function baseName(name) {
  return String(name || "")
    .replace(/\.json$/i, "")
    .trim();
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

  const wasUnsaved = wf.isTemporary === true || wf.isPersisted === false;
  const currentName = baseName(wf.filename);
  // Only mint a fresh auto-name for a genuinely placeholder ("Unsaved Workflow"
  // / "Untitled …") workflow. A named-but-unsaved workflow saves under its name.
  const needsAutoName = wasUnsaved && isDefaultWorkflowName(currentName);
  const desired = baseName(name ? name : needsAutoName && autoWorkflowName ? autoWorkflowName() : "");

  // A Save-As is any save that lands under a name other than the current one.
  const isSaveAs = desired && desired !== currentName;

  if (isSaveAs) {
    // Copy path. saveWorkflowAs handles BOTH cases correctly: for a persisted
    // workflow it copies (workflowStore.saveAs → new file, original untouched);
    // for a temporary it renames the never-saved tab to a real file. We pass
    // `filename` so it skips the Save dialog.
    if (typeof svc.saveWorkflowAs === "function") {
      await svc.saveWorkflowAs(wf, { filename: desired });
      // saveWorkflowAs makes the new copy the active workflow.
      return baseName(svc.activeWorkflow?.filename) || desired;
    }
    // Fallback only for a workflow that was NEVER persisted: renaming an
    // in-memory temporary tab is safe (no source file to destroy).
    if (wasUnsaved && typeof svc.renameWorkflow === "function") {
      const dir = directoryOf(wf);
      await svc.renameWorkflow(wf, `${dir}${desired}.json`);
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

/** Directory prefix (with trailing slash) that a new sibling file should live in,
 *  preserving the workflow's containing folder. Defaults to the workflows root. */
function directoryOf(wf) {
  const dir = String(wf?.directory || "").replace(/\/+$/, "");
  return dir ? `${dir}/` : "workflows/";
}

async function saveInPlace(svc, wf) {
  if (typeof svc.saveWorkflow === "function") await svc.saveWorkflow(wf);
  else if (typeof wf.save === "function") await wf.save();
  else throw new Error("workflow save API unavailable on this frontend");
}
