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
 *
 *  `existsOnDisk(rawPath)` is an OPTIONAL authoritative filesystem oracle —
 *  async `(path) => true | false | null` (null = unknown). It exists because the
 *  frontend's in-memory `getWorkflowByPath` cannot tell a genuinely never-saved
 *  temporary tab (whose path IS in the in-memory store, e.g.
 *  "workflows/Unsaved Workflow (2).json") from a drifted real file at the same
 *  path — both return a non-persisted object. Only the disk can (ComfyUI's
 *  /userdata HEAD). A 404 PROVES no backing file (safe to ground); a 200 PROVES
 *  a real file (must never be moved). This STRENGTHENS the #226 invariant — it
 *  is only ever consulted after the in-memory oracles are inconclusive, and its
 *  absence / failure leaves the classification "unknown" → refuse (fail safe).
 */
export async function saveActiveWorkflow(svc, name, { autoWorkflowName, existsOnDisk } = {}) {
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

  // A safe save requires a RESOLVED, non-empty target path. Without one — e.g. a
  // persisted workflow whose filename is empty/unresolved and no name was given —
  // the in-place branch must NOT run: the frontend's `saveWorkflow` would
  // recompute the target from the empty name (→ a bare "…/.json") and RENAME
  // (move) the source to it, a persisted MOVE with no absent-oracle proof (#226).
  // Refuse instead — never let an unresolved name relocate a real file.
  if (!finalTargetPath) {
    if (!currentPath) {
      throw new Error("name must not be blank — pass a non-whitespace workflow name");
    }
    throw new Error(
      `refusing to save: cannot resolve a target filename for "${currentPath}" — saving now ` +
        `could MOVE (destroy) the original (issue #226). Pass an explicit name.`,
    );
  }

  const relocates = finalTargetPath !== currentPath;

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
    const cls = await classifySource(svc, wf, sourcePath, existsOnDisk);

    // Resolve the copy (Save-As) API across frontend versions. On 1.45.x the
    // workflow store exposes the high-level `saveWorkflowAs(wf,{filename})`. On
    // 1.47.x that method was removed from `extensionManager.workflow`; the store
    // instead exposes the low-level pair `saveAs(wf, path)` (creates a NEW copy
    // object at `path`, leaving the source object AND its on-disk file untouched)
    // + `saveWorkflow(copy)` (persists the copy). Both are true copies — neither
    // moves/destroys the source — so both satisfy the #226 invariant.
    const saveAsCopy = resolveSaveAsCopy(svc);

    if (saveAsCopy) {
      // PREVENT the destructive move. saveWorkflowAs relocates-by-rename whenever
      // it treats the doc as temporary. That is only SAFE when the source is
      // provably never-persisted; for a persisted OR UNKNOWN source it would (or
      // might) destroy a real file — refuse instead (the sanctioned safe outcome).
      // A correctly-opened persisted workflow has isTemporary === false and hits
      // the COPY branch, so it is unaffected by this guard.
      if (wf.isTemporary === true && cls !== "never-persisted") {
        throw new Error(
          `refusing to save: the active workflow is flagged unsaved but its source "${sourcePath}" ` +
            `${cls === "persisted" ? "exists on disk" : "cannot be proven absent from disk"} — ` +
            `saving now could MOVE (destroy) the original (issue #226). Re-open the workflow and try again.`,
        );
      }
      // Copy path. For a persisted workflow this copies (new file, original
      // untouched); for a genuine (provably never-persisted) temporary it grounds
      // the never-saved tab to a real file. No Save dialog.
      const activeName = await saveAsCopy(wf, effectiveName, finalTargetPath);
      // BACKSTOP: if the copy relocated a persisted source anyway, fail LOUDLY
      // instead of reporting a phantom success (the prior fix's exact miss). Uses
      // the SAME tri-state rule as classifySource: only a SUCCESSFUL, affirmative
      // absence (getWorkflowByPath returns null/undefined at the path) proves the
      // move. A getter THROW or a list-miss is UNKNOWN — a valid save-as copy must
      // NOT be reported as "moved" (false alarm).
      if (cls === "persisted" && confirmedAbsentAt(svc, sourcePath)) {
        throw new Error(
          `save moved the original workflow "${sourcePath}" instead of copying it — ` +
            `the source no longer exists on disk (issue #226)`,
        );
      }
      return activeName;
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

/** Tri-state existence probe for the post-save backstop, mirroring classifySource:
 *  returns true ONLY when the oracle SUCCESSFULLY confirms nothing is at `rawPath`
 *  (getWorkflowByPath returns null/undefined). A getter THROW or the absence of a
 *  usable oracle is UNKNOWN → false (do not alarm) — so a valid save-as copy is
 *  never misreported as a destructive move (#226). A list-miss is likewise not
 *  proof of absence, so lists never trigger the alarm. */
function confirmedAbsentAt(svc, rawPath) {
  if (!rawPath) return false;
  if (typeof svc?.getWorkflowByPath !== "function") return false;
  try {
    return svc.getWorkflowByPath(rawPath) == null;
  } catch {
    return false; // oracle threw ⇒ unknown ⇒ never alarm
  }
}

/** Resolve the frontend's Save-As (COPY) capability into a single async adapter
 *  `(wf, effectiveName, finalTargetPath) => resolvedActiveName`, or null when no
 *  copy API exists. Every branch is a genuine COPY that leaves the source file
 *  on disk untouched (the #226 invariant) — the temporary-vs-persisted move
 *  decision is made by the caller via classifySource, never here.
 *
 *   - 1.45.x: `svc.saveWorkflowAs(wf, { filename })` (high-level; makes the new
 *     copy the active workflow, so read the resolved name back off it).
 *   - 1.47.x: the store dropped `saveWorkflowAs` and exposes the low-level pair
 *     `svc.saveAs(wf, path)` — which builds a NEW workflow object at `path`
 *     (fresh id, source object and its file untouched) and returns it — plus
 *     `svc.saveWorkflow(copy)` to persist that copy. We drive them together. */
function resolveSaveAsCopy(svc) {
  if (typeof svc?.saveWorkflowAs === "function") {
    return async (wf, effectiveName) => {
      await svc.saveWorkflowAs(wf, { filename: effectiveName });
      // saveWorkflowAs makes the new copy the active workflow.
      return baseName(svc.activeWorkflow?.filename) || effectiveName;
    };
  }
  // `openWorkflow` is MANDATORY for this path, not optional. The object saveAs
  // returns is UNLOADED (no changeTracker → activeState === null), and
  // ComfyWorkflow.save() serializes `activeState ?? null` — so persisting a copy
  // that was never opened writes the string "null" (a saved-but-empty workflow)
  // while reporting success. Opening it first populates changeTracker/activeState
  // from the graph AND makes it the active tab. If a frontend exposes saveAs +
  // saveWorkflow but NOT openWorkflow, we CANNOT persist real content, so we must
  // NOT select this adapter — return null and let the caller refuse rather than
  // ever call saveWorkflow on an unopened copy.
  if (
    typeof svc?.saveAs === "function" &&
    typeof svc?.saveWorkflow === "function" &&
    typeof svc?.openWorkflow === "function"
  ) {
    return async (wf, effectiveName, finalTargetPath) => {
      // saveAs builds the copy in memory at the resolved target path (source
      // object untouched); the source's on-disk file is never referenced, so it
      // cannot be moved/destroyed (#226).
      const copy = svc.saveAs(wf, finalTargetPath);
      if (!copy) {
        throw new Error("save-as (copy) failed to create a copy on this frontend");
      }
      // Mirror the frontend's own Save-As sequence: OPEN/activate the copy
      // (loads the graph into changeTracker/activeState, makes it active), THEN
      // persist — so save() writes the real graph, not null. A throw here aborts
      // BEFORE any saveWorkflow, so a failed open never persists null.
      await svc.openWorkflow(copy);
      copy.changeTracker?.prepareForSave?.();
      await svc.saveWorkflow(copy);
      return baseName(svc.activeWorkflow?.filename) || baseName(copy.filename) || effectiveName;
    };
  }
  return null;
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
async function classifySource(svc, wf, rawPath, existsOnDisk) {
  if (wf?.isPersisted === true) return "persisted";

  const norm = normalizePath(rawPath);
  // A doc with NO backing path has nothing on disk to lose — it is provably
  // never-persisted. This is the everyday "save my brand-new workflow" path and
  // must always ground/save (do NOT require an oracle for it).
  if (!norm) return "never-persisted";

  // The doc HAS a path, so a real file MIGHT back it. We only trust an oracle
  // call that SUCCEEDS: `persisted` if it shows a persisted workflow here,
  // `confirmedAbsent` only if a successful lookup shows none. An oracle that
  // THROWS proves nothing (a thrown lookup is not proof of absence, #226) — we
  // leave both false so the result stays "unknown" → refuse.
  let persisted = false;
  let confirmedAbsent = false;

  if (typeof svc?.getWorkflowByPath === "function") {
    try {
      const found = svc.getWorkflowByPath(rawPath);
      if (found && found.isPersisted === true) {
        persisted = true;
      } else if (found == null) {
        // Successful call returned NOTHING — truly no workflow at this path.
        confirmedAbsent = true;
      }
      // A RETURNED object that is not affirmatively persisted (e.g. the drifted
      // temporary `wf` itself, isPersisted=false) is NOT proof of absence —
      // something is at that path and we cannot prove there is no file. Leave
      // both flags unset so the result stays "unknown" → refuse (#226).
    } catch {
      /* oracle threw → cannot confirm → neither flag set → unknown */
    }
  }
  // The known-workflow lists are a non-throwing oracle, but only a POSITIVE hit
  // (a persisted entry at this path) is trustworthy — a list MISS cannot prove a
  // file is absent from disk (an unlisted file may exist), so it never sets
  // `confirmedAbsent`.
  const listed = [...(svc?.workflows ?? []), ...(svc?.openWorkflows ?? [])].find(
    (w) => w && normalizePath(w.path) === norm,
  );
  if (listed && listed.isPersisted === true) persisted = true;

  if (persisted) return "persisted";
  // Only a SUCCESSFUL oracle confirmation of absence, on a doc acting temporary,
  // grants move rights. No oracle / oracle threw ⇒ unknown ⇒ refuse.
  if (confirmedAbsent && wf?.isTemporary === true && wf?.isPersisted !== true) {
    return "never-persisted";
  }

  // The in-memory oracles were inconclusive. On 1.47.x `getWorkflowByPath` is
  // backed by the in-memory store, which HOLDS open temporary tabs at their
  // "workflows/Unsaved Workflow (N).json" path — so it returns the non-persisted
  // temp object for BOTH a genuinely never-saved tab (issue #268) and a drifted
  // real file (#226/#215). They are indistinguishable in memory; only the disk
  // can tell them apart. Consult the authoritative filesystem oracle: a proven
  // ABSENCE (404) means there is no backing file to destroy → never-persisted
  // (safe to ground); a proven PRESENCE means a real file → persisted (refuse).
  // Unknown/failure changes nothing (stays "unknown" → refuse), so this only
  // ever ADDS safe grounds to save and never weakens the #226 refusal.
  if (typeof existsOnDisk === "function" && wf?.isPersisted !== true) {
    let exists = null;
    try {
      exists = await existsOnDisk(norm);
    } catch {
      exists = null; // probe failed ⇒ unknown ⇒ fall through to refuse
    }
    if (exists === false) return "never-persisted";
    if (exists === true) return "persisted";
  }
  return "unknown";
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
