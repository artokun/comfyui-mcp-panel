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

  // ANY save that would land at a DIFFERENT path than the one the workflow
  // currently occupies on disk is a RELOCATION — and under ComfyUI 1.45.21 both
  // `saveWorkflow` (in-place) and `saveWorkflowAs` relocate by RENAMING (moving)
  // the source, which destroys the original file (#226). So relocation — not the
  // narrower "user gave a new name" — is what must be routed down the safe path.
  //
  // Compare full, normalized target PATHS, not names. Comparing a twice-stripped
  // filename is unsafe: ComfyUI strips the final ".json" from the on-disk name,
  // so a file at "…/Foo.json.json" reports filename "Foo.json"; baseName() would
  // strip it again to "Foo" and misjudge a Save-As to "Foo" as an in-place save.
  //
  // The effective target name is the explicit/auto name for a Save-As, else the
  // workflow's CURRENT name — because even a no-name save relocates when the
  // mode-derived extension differs from the on-disk path (P0-b): an on-disk
  // "Foo.json" opened with initialMode "app" has a mode-derived target of
  // "Foo.app.json", so a plain `saveWorkflow` would MOVE "Foo.json" → "Foo.app.json"
  // and consume the source. targetPath() applies the mode-correct extension.
  const currentPath = normalizePath(wf.path);
  const effectiveName = desired || currentName;
  const finalTargetPath = effectiveName ? targetPath(wf, effectiveName) : "";
  const relocates = !!finalTargetPath && finalTargetPath !== currentPath;

  if (relocates) {
    // The invariant (issue #226): a relocating save must NEVER remove a file that
    // exists on disk. Classify the source by its ACTUAL persisted state as a
    // TRI-STATE — "persisted" / "never-persisted" / "unknown" — NOT the in-memory
    // `wasUnsaved`/`isTemporary` flag, which drifts. On 1.45.21 `isTemporary` is
    // derived from `size` (`get isTemporary(){return this.size===-1}`), so after
    // a panel_open_workflow ack-timeout race (#215) a workflow that IS on disk
    // can be left flagged temporary. The frontend's `saveWorkflowAs` branches on
    // `isTemporary`: a temporary doc is MOVED (renameWorkflow) instead of copied.
    // UNKNOWN must FAIL SAFE (refuse) — we only ever take a move path when the
    // source is PROVABLY never-persisted (no backing file to destroy).
    const sourcePath = wf.path;
    const cls = classifySource(svc, wf, sourcePath);

    if (typeof svc.saveWorkflowAs === "function") {
      // PREVENT the destructive move. saveWorkflowAs relocates-by-rename whenever
      // it treats the doc as temporary. That is only SAFE when the source is
      // provably never-persisted; for a persisted OR UNKNOWN source it would (or
      // might) destroy a real file — refuse instead (the sanctioned safe outcome).
      // A correctly-opened persisted workflow has isTemporary === false and hits
      // saveWorkflowAs's COPY branch, so it is unaffected by this guard.
      if (wf.isTemporary === true && cls !== "never-persisted") {
        throw new Error(
          `refusing to save: the active workflow is flagged unsaved but its source "${sourcePath}" ` +
            `${cls === "persisted" ? "exists on disk" : "cannot be proven absent from disk"} — ` +
            `saving now could MOVE (destroy) the original (issue #226). Re-open the workflow and try again.`,
        );
      }
      // Copy path. For a persisted workflow saveWorkflowAs copies
      // (workflowStore.saveAs → new file, original untouched); for a genuine
      // temporary it renames the never-saved tab to a real file. `filename`
      // skips the Save dialog.
      await svc.saveWorkflowAs(wf, { filename: effectiveName });
      // BACKSTOP: if saveWorkflowAs relocated a persisted source anyway, fail
      // LOUDLY instead of reporting a phantom success (the prior fix's exact
      // miss). Only assert when we have a reliable existence oracle — otherwise
      // we can't tell a copy from a move and must not false-alarm.
      if (cls === "persisted" && hasExistenceOracle(svc) && !pathExists(svc, sourcePath)) {
        throw new Error(
          `save moved the original workflow "${sourcePath}" instead of copying it — ` +
            `the source no longer exists on disk (issue #226)`,
        );
      }
      // saveWorkflowAs makes the new copy the active workflow.
      return baseName(svc.activeWorkflow?.filename) || effectiveName;
    }
    // Fallback (older frontend with no copy API): renaming is a MOVE, so it is
    // only permitted when the source is PROVABLY never-persisted (an in-memory
    // temporary tab with no backing file). Persisted OR UNKNOWN → refuse (#226).
    if (cls === "never-persisted" && typeof svc.renameWorkflow === "function") {
      await svc.renameWorkflow(wf, finalTargetPath);
      await saveInPlace(svc, wf);
      return effectiveName;
    }
    // No safe way to relocate: refuse rather than move/destroy the original.
    throw new Error(
      "save-as (copy) is unavailable on this frontend; refusing to rename and destroy the original workflow",
    );
  }

  // No relocation — the target path equals the current on-disk path. Overwriting
  // the same file in place is safe (no move can occur).
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

/** TRI-STATE classification of whether the source is backed by a real file on
 *  disk — independent of the volatile in-memory flags, which drift after an
 *  open-ack race (#215). Returns:
 *    "persisted"       — a real file provably backs it (must NEVER be moved);
 *    "never-persisted" — an oracle AFFIRMATIVELY confirms no backing file exists
 *                        (safe to rename/ground);
 *    "unknown"         — cannot establish either way → callers FAIL SAFE (refuse).
 *
 *  Proof of "persisted": `wf.isPersisted === true`, or an existence oracle shows
 *  a persisted workflow at this path.
 *
 *  Proof of "never-persisted" requires the existence oracle to affirmatively
 *  show NO file backs the path. A placeholder NAME ("Unsaved Workflow …" /
 *  "Untitled …") is NEVER sufficient on its own — a user really can have
 *  `workflows/Untitled 2026-07-12.json` on disk, and treating the name as proof
 *  would classify a drifted-temporary REAL file as never-persisted and then move
 *  (destroy) it (#226). With NO oracle we can prove nothing → "unknown" → refuse,
 *  so the only path that ever renames is one the oracle proves has no file. */
function classifySource(svc, wf, rawPath) {
  if (wf?.isPersisted === true) return "persisted";
  // Without an oracle we can prove NOTHING about the disk — fail safe.
  if (!hasExistenceOracle(svc)) return "unknown";

  const norm = normalizePath(rawPath);
  const found =
    typeof svc?.getWorkflowByPath === "function" ? safeGetByPath(svc, rawPath) : undefined;
  const listed = [...(svc?.workflows ?? []), ...(svc?.openWorkflows ?? [])].find(
    (w) => w && normalizePath(w.path) === norm,
  );
  if ((found && found.isPersisted === true) || (listed && listed.isPersisted === true)) {
    return "persisted";
  }
  // Oracle available and affirmatively shows NO persisted workflow at this path.
  // Only grant move rights to a doc that is actually acting as a temporary tab;
  // anything else stays "unknown" (never move an ambiguous doc).
  if (wf?.isTemporary === true && wf?.isPersisted !== true) return "never-persisted";
  return "unknown";
}

function safeGetByPath(svc, rawPath) {
  try {
    return svc.getWorkflowByPath(rawPath);
  } catch {
    return undefined;
  }
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
